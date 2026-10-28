# Access Control Library Architecture

## Design goal and boundary

Implement `spec.md` as a tier-1 ESM package over Node Web Crypto. Keep cryptographic operations, throttling, and session state transitions separate behind one public factory. The only workspace import is the `Clock` type from `@tmtp/clock`; the store is structural and has no `domain` or `reader-store` import.

The package performs no file, network, HTTP, cookie, logging, migration, or timer work. The service reads the token and owns deployment policy. The store owns SQL and durability.

## Internal decomposition

A small implementation can use private modules with no package subpath exports:

- **Public entry:** exports the error, factory, and public types; validates and freezes the effective configuration view.
- **Secret codec:** UTF-8 encoding, 32-byte random generation, base64url secrets, SHA-256 digests, and lowercase hex storage hashes.
- **Digest comparison:** fixed-length comparison for token and CSRF verification.
- **Login throttle:** one monotonic fixed window per `AccessControl` instance.
- **Session service:** issuance, authentication, revocation, and CSRF verification around the synchronous store port.
- **Validation:** private runtime guards for options and canonical external encodings.

These are organizational boundaries, not more public API. A single source module is acceptable if the same state transitions remain isolated and testable.

## Cryptographic design

### Token verification

Keep the configured token only in the factory closure. For each well-formed login attempt, encode the configured and presented strings as UTF-8 and hash both with `subtle.digest("SHA-256", bytes)`. Compare the two 32-byte arrays with one loop that accumulates bitwise differences and does not exit early.

Hashing normalizes different secret lengths to one comparison length and avoids a direct early-exit string comparison. The loop provides constant work with respect to digest contents at the algorithm level. JavaScript execution engines do not provide a formal hardware-level constant-time guarantee; this is a best-effort timing side-channel reduction, not a claim suitable for a high-assurance multi-tenant service. The single-user, high-entropy-token threat model makes that trade-off acceptable.

Malformed or overlong presented values can be rejected before hashing because that control flow reveals only attacker-provided type/length, not configured-token content. Login throttling applies before all such branches.

### Secret generation and storage

On successful token verification, call `getRandomValues` twice with separate 32-byte arrays. Encode each array with base64url and independently hash the raw bytes for storage. Use Node's base64url/hex encoding or an equivalent exact local codec; do not convert through UTF-8 text before hashing.

The persisted primary key is the session digest, not an identifier derived from wall time or a counter. A duplicate primary key is treated as a store failure rather than silently replacing an existing session. Given 256 random bits, retrying collisions is unnecessary and could conceal a broken random source or store.

No raw secret is placed in an error context, log metadata, or a long-lived public result beyond `IssuedSession`. The configured token remains in process memory because verification needs it; there is no pretense of zeroization in ordinary JavaScript strings.

## Throttle algorithm

Each factory instance closes over:

```text
windowStartedMs: number | undefined
attempts: number
```

At the very start of `login`, read monotonic time. Reset when no window exists or the elapsed interval is at least the configured window. Otherwise, if the count is exhausted, compute retry-after and reject. Increment/reserve before any digest or other Promise operation.

Use wall time only after successful verification to timestamp the session. Mixing monotonic and wall time is intentional: throttle intervals must survive wall-clock corrections, while persisted session expiry needs an absolute timestamp that remains meaningful after restart.

The throttle is deliberately global to the instance rather than keyed by token or IP. Keying by presented token would let an attacker distribute guesses and would retain attacker-controlled strings. IP attribution belongs to a proxy-aware service and is not trustworthy input to this package.

## Session state transitions

### Issuance

The issuance path is:

```text
reserve attempt → verify token → read wall time → generate secrets
→ hash secrets → insert hashes → return raw secrets
```

Only the store insertion is a state transition. There is no open database transaction across Web Crypto awaits. An exception before insertion leaves no stored session; an insertion exception propagates and no raw session is returned.

### Authentication

After the asynchronous session digest completes, run `find`, expiry/revocation checks, and `touch` in one synchronous JavaScript turn. This is the authentication linearization point on the target single-process/synchronous-store topology. No `SELECT ... FOR UPDATE` or asynchronous lock is needed.

Clone the returned record. Compute `usedAt = max(now, storedLastUsedAt)` by epoch milliseconds so last-use metadata cannot regress. Never recalculate `expiresAt` from `usedAt`; fixed expiry avoids an indefinitely sliding bearer token.

A logout can linearize immediately after a successful authentication, as with any revocation system. Request handlers that require stronger transactional authorization must supply that guarantee at a higher layer; this package does not hold locks for an entire HTTP request.

### Revocation and CSRF

Logout hashes the bearer value, then performs an uninterrupted `find` and conditional `revoke`. Preserving an existing `revokedAt` makes repeated logout a no-op and keeps the first revocation time auditable. An existing expired but unrevoked record is revoked too, making logout's audit result independent of expiry; missing records remain no-ops.

CSRF verification hashes only the presented CSRF secret and compares it with the authenticated session snapshot. It does not call the store. This avoids a second session lookup and makes its limitations explicit: it cannot observe a revocation newer than the snapshot. Origin checks and cookie attributes remain in the service because they require HTTP context.

## Store and transaction boundary

The structural port matches `reader-store.accessSessions` method-for-method. Implementations may wrap calls in SQL, but access-control does not open a transaction itself. Store methods must either complete their synchronous write or throw; a Promise return is outside the port even though TypeScript cannot prevent it at runtime.

No authentication operation retries a busy store or a failed digest. HTTP/database retry policy belongs to the composition root and must not turn a failed insertion into repeated secret issuance without considering the response already sent.

## Trade-offs

- **Asynchronous public operations:** Web Crypto avoids a native synchronous crypto dependency, but every service hook must await authentication, logout, and CSRF checks.
- **Best-effort fixed-work comparison:** a local digest loop avoids early-exit comparison, but JavaScript cannot promise machine-level constant time. Node's native `timingSafeEqual` would be an alternative if the runtime basis changed deliberately.
- **Global process-local throttle:** simple and resistant to per-token distribution, but resets on restart and can temporarily block the legitimate user after repeated logins. High token entropy and the single-process deployment bound the risk.
- **All attempts count:** successful logins consume capacity too. This makes concurrent reservation and retry behavior deterministic and prevents success/reset races.
- **Fixed absolute sessions:** last-use tracking does not prolong a stolen session. Users must log in again after expiry.
- **Wall-clock persisted expiry:** absolute timestamps survive restart, but a backward wall-clock correction can keep a session valid longer in real elapsed time. Monotonic time cannot solve persisted cross-restart expiry; the host clock is a trusted deployment input.
- **Synchronous store plus async crypto:** database writes stay short and composable, while correctness depends on keeping no `await` inside each find/check/write sequence.
- **No automatic cleanup:** expired/revoked rows remain available for audit and store inspection. Retention needs an explicit future policy rather than hidden request-path deletion.
- **Hash-only CSRF storage:** a database disclosure does not reveal the raw CSRF secret, but the service cannot recover it for a client that lost it.

## Testing seams and verification design

### Public deterministic tests

- Use `createFixedClock` for forward wall expiry and exact monotonic throttle windows. Use a small scripted `Clock` with independent wall/monotonic readings for backward wall time; `FixedClock` intentionally cannot move backward.
- Use a scripted in-memory `AccessSessionStore` that records calls and can throw at insert/find/touch/revoke. Assert call order to prove no store work occurs during throttling or invalid-token paths.
- Compute expected SHA-256/base64url values with an independent test helper; do not assert specific random secrets.
- Hold token digest completion at an internal crypto test seam when testing concurrent login reservation. The public factory uses Web Crypto; a private injectable crypto adapter can make this deterministic without adding public configuration or weakening production randomness.
- Use custom secret sentinels in invalid inputs and assert their absence from errors and store calls.
- Test malformed store records at the structural fake boundary to ensure CSRF verification fails closed.

### Composition tests

The package suite uses structural fakes and must not import `reader-store`. A service/store integration suite later verifies that the real repository satisfies the port, preserves hashes only, and executes the synchronous sequences without a Promise. Browser/API tests must additionally cover Secure/HttpOnly/SameSite cookies, origin rejection, awaited hooks, and CSRF loss/re-login behavior; those are not provable at this library boundary.
