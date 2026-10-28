# Access Control Library Spec

## Purpose and responsibility

Protect one personal instance with a pre-provisioned high-entropy access token, revocable opaque sessions, login throttling, and CSRF verification. The package owns token verification, session issuance and validation, CSRF-secret verification, and the session-store port. It deliberately does not implement passwords, signup, OAuth, multiple users, HTTP cookies, origin checks, CORS, or HTTPS deployment policy.

The package root is `@tmtp/access-control`. It has no default export or subpath exports.

## Public interface / API surface

```ts
export interface AccessSession {
  sessionHash: string;
  csrfSecretHash: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  revokedAt?: string;
}

export interface AccessSessionStore {
  insert(session: AccessSession): void;
  find(sessionHash: string): AccessSession | undefined;
  touch(sessionHash: string, at: string): void;
  revoke(sessionHash: string, at: string): void;
}

export interface IssuedSession {
  opaqueSession: string;
  csrfSecret: string;
  expiresAt: string;
}

export type AccessControlErrorCode =
  | "invalid-configuration"
  | "invalid-token"
  | "login-rate-limited";

export class AccessControlError extends Error {
  readonly name: "AccessControlError";
  readonly code: AccessControlErrorCode;
  readonly retryAfterSeconds?: number;
  constructor(code: AccessControlErrorCode, retryAfterSeconds?: number);
}

export interface AccessControl {
  login(presentedToken: string): Promise<IssuedSession>;
  authenticate(opaqueSession: string): Promise<AccessSession | undefined>;
  logout(opaqueSession: string): Promise<void>;
  verifyCsrf(session: AccessSession, presentedSecret: string): Promise<boolean>;
}

export interface AccessControlOptions {
  accessToken: string;
  store: AccessSessionStore;
  clock: import("@tmtp/clock").Clock;
  sessionTtlSeconds: number;
  loginMaxAttempts: number;
  loginWindowSeconds: number;
}

export function createAccessControl(options: AccessControlOptions): AccessControl;
```

Runtime exports are exactly `AccessControlError` and `createAccessControl`. Type exports are exactly `AccessControl`, `AccessControlErrorCode`, `AccessControlOptions`, `AccessSession`, `AccessSessionStore`, and `IssuedSession`. `AccessSession` is structurally identical to the domain access-session record without importing `domain`.

All session operations are asynchronous because Node Web Crypto digests are asynchronous. Store methods remain synchronous and are never called while the library holds a database transaction. Callers must await `authenticate`, `logout`, and `verifyCsrf`; the former synchronous signatures are not valid under this contract.

## Secret and hash formats

- The configured access token is an opaque string compared as exact UTF-8 bytes. Its encoded length must be `32..1024` bytes. Length is only a necessary safety check; the library cannot measure entropy. The operator must provision it from a cryptographically secure random source.
- An opaque session and its CSRF secret are generated independently for each successful login. Each is 32 bytes from Node Web Crypto `getRandomValues`, encoded as canonical 43-character base64url without padding.
- A session hash and CSRF-secret hash are lowercase hexadecimal SHA-256 digests of the exact decoded secret bytes. Each stored hash is 64 characters.
- Only hashes enter `AccessSessionStore`. The configured access token and raw issued secrets are never passed to the store.
- Secret comparison hashes both operands and compares the two 32-byte digests with a fixed-length, non-early-exit comparison. Hex decoding never participates in access-token comparison.

## Validation and errors

### Construction

`createAccessControl` validates the complete options object before returning. A missing/wrong-typed store method or clock, a token outside the UTF-8 byte-length bounds, or an invalid numeric policy throws `AccessControlError(code="invalid-configuration")`.

Numeric policies must be safe integers within these ranges:

- `sessionTtlSeconds`: `1..31_536_000` (one year).
- `loginMaxAttempts`: `1..1_000_000`.
- `loginWindowSeconds`: `1..86_400` (one day).

Construction has no I/O, does not read the clock, and creates no timer or listener. Separate instances have independent throttles and retain no mutable state other than their own throttle window.

### Error shape

`AccessControlError` uses these fixed messages:

| Code | Message | Additional field |
|---|---|---|
| `invalid-configuration` | `Access-control configuration is invalid.` | none |
| `invalid-token` | `Access token is invalid.` | none |
| `login-rate-limited` | `Too many login attempts.` | `retryAfterSeconds` |

For direct construction, `retryAfterSeconds` is required as a positive safe integer for `login-rate-limited` and forbidden for every other code. Violating that constructor rule throws `TypeError`. The error has no `cause`, token, session, CSRF secret, presented input, or store record. Library-created errors never include supplied values in their messages.

Malformed external session/CSRF inputs are ordinary authentication failures, not configuration errors. Unexpected Web Crypto failures and store exceptions propagate unchanged; they are not converted into `invalid-token` or an authentication miss.

## Operation contracts

### `login`

1. Reserve a login-attempt slot synchronously as described under throttling. A throttled call rejects with `login-rate-limited` before token verification or random generation.
2. Verify the presented token. A non-string, an overlong token, or unequal bytes rejects with `invalid-token`. Type/length rejection may skip hashing because that branch depends only on attacker-supplied input; well-formed token comparison always uses digest comparison.
3. Read wall time once and compute `createdAt` and `expiresAt = createdAt + sessionTtlSeconds`. Both use the system-wide ISO-8601 UTC representation with a `Z` suffix and millisecond precision. If the expiry is not a valid `Date`, reject with `invalid-configuration` and issue nothing; the reserved attempt remains consumed.
4. Generate independent session and CSRF secrets, hash both, and insert `{ createdAt, lastUsedAt: createdAt, expiresAt }` with no `revokedAt`.
5. Return the raw secrets and `expiresAt` only after insertion succeeds.

Every successful login creates a new session. It does not reuse, extend, rotate, or revoke another session. An insert failure returns no raw secrets and propagates the store error; the library does not hide a constraint failure by retrying with different secrets.

### `authenticate`

1. Reject a non-string or non-canonical session encoding with `undefined` without consulting the store.
2. SHA-256 hash the decoded session bytes and call `find(sessionHash)`.
3. Return `undefined` when no record exists, `revokedAt` is present, or `now >= expiresAt`. Expiry is fixed; authentication never extends `expiresAt`.
4. For a usable record, set `usedAt` to the later of wall-clock now and the stored `lastUsedAt`, call `touch(sessionHash, usedAt)`, and return a fresh record snapshot whose `lastUsedAt` is `usedAt`.

The later-of rule prevents a backward wall-clock adjustment from moving `lastUsedAt` backward; it does not change absolute expiry. Expired sessions are not touched or implicitly revoked. Returned records are clones, so caller mutation does not mutate a store-owned object.

### `logout`

Hash a canonically encoded session and find its record. If it exists and is not already revoked, synchronously call `revoke(sessionHash, now)` and fulfill with `undefined`; this also marks an existing expired session revoked. Missing, malformed, and already-revoked sessions are successful no-ops. Logout revokes only the presented session, never all sessions. Store errors propagate. The service must still require CSRF and origin verification for its logout route.

### `verifyCsrf`

Return `true` only when:

- `presentedSecret` is a canonical 43-character base64url encoding of 32 bytes;
- the session's stored CSRF hash is a valid lowercase SHA-256 hex string;
- the presented secret's digest equals that hash using the fixed-length comparison;
- the supplied session snapshot has no `revokedAt` and has `expiresAt > now`.

Otherwise return `false`. This operation does not touch, rotate, revoke, or re-read the session. It is not standalone authorization: the service must first await `authenticate` on the request's opaque session and pass that fresh snapshot to `verifyCsrf`. A concurrent logout after authentication linearizes after that authentication; the service must not treat a CSRF check as a second revocation lookup.

## Login throttling and concurrency

### Fixed-window algorithm

Throttling uses `clock.monotonicNowMs()`, never wall time. Each instance holds one global single-user window; there is no per-IP or per-token partition that could be used to bypass the limit.

- The first attempt starts `windowStartedMs` and sets `attempts=1`.
- An attempt with `monotonicNowMs() - windowStartedMs >= loginWindowSeconds * 1000` first resets the window and then counts as attempt 1.
- While `attempts < loginMaxAttempts`, an attempt increments the count synchronously and proceeds.
- Once `attempts === loginMaxAttempts`, later attempts inside the window reject with `login-rate-limited`. They do not increment the count or verify the token.
- `retryAfterSeconds = max(1, ceil((windowStartedMs + loginWindowSeconds * 1000 - monotonicNowMs()) / 1000))` at rejection time.
- All attempts count: valid, invalid, malformed, and successful. Success does not reset or extend the window.

Reservation happens before the first `await`, so concurrent calls cannot all pass a check based on a stale count. Call order for throttling is the synchronous reservation order, not digest completion order.

### Linearization and lifecycle

- Login insertion linearizes at the synchronous `store.insert` call. Token verification and hashing happen before it without a database transaction.
- Authentication linearizes at its uninterrupted synchronous `find`/validity-check/`touch` sequence. There is no `await` between those operations.
- Logout linearizes at its uninterrupted synchronous `find`/`revoke` sequence. A valid authentication that linearizes before logout can complete; later authentications fail.
- CSRF verification has no stored-state linearization point beyond reading the supplied snapshot and the clock.
- No operation starts a timer, retries automatically, or runs background cleanup. Session retention and deletion are outside this package.

The throttle is process-local and resets on restart. This is deliberate for the single-process topology; durable distributed rate limiting is not provided.

## Security and session invariants

1. Raw access tokens, opaque sessions, and CSRF secrets never appear in stored records, error messages, or library diagnostics.
2. A raw session or CSRF secret is returned only from its successful issuing login. Hashes are not accepted as substitutes for either raw secret.
3. A session is unusable at or after its fixed expiry or immediately after revocation; `lastUsedAt` never extends expiry or moves backward.
4. Session and CSRF secrets are independent, cryptographically random, and never derived from the access token or one another.
5. Login attempts are reserved before asynchronous work, so event-loop interleaving cannot exceed the configured per-window limit.
6. Authentication misses and CSRF mismatches fail closed. Expected failures contain no secret-dependent details.
7. The library never authorizes a request from a CSRF secret alone and never initiates an HN or account mutation.
8. Cookie `HttpOnly`, `Secure`, `SameSite`, path, HTTPS awareness, trusted-proxy handling, and Origin/Fetch-Site checks remain mandatory service responsibilities. This library does not replace them.

## Consumer and composition rules

`reader-store` implements `AccessSessionStore` structurally; neither package imports the other. The service supplies the loaded token from `auth.access_token_path`, constructs one instance, and awaits every operation in its authentication hooks.

The login response/transport delivers the opaque session in an `HttpOnly` cookie and the CSRF secret through the service's chosen CSRF handoff. The raw CSRF secret is unrecoverable from its hash; a client that loses it must establish a new session unless the service adds a separately specified rotation operation. `GET /auth/session` may report expiry and whether CSRF state exists, but must not claim to recover the raw secret.

State-changing cookie-authenticated requests require a fresh authenticated session, CSRF verification, and service-level origin verification. Debug routes use the same checks. Logging should also redact hashes and session metadata even though hashes are not bearer credentials.

## Internal subcomponents

- Secret encoding, SHA-256 hashing, and fixed-length digest comparison.
- Access-token verifier and CSPRNG session issuer.
- Monotonic fixed-window login throttle.
- Session authentication, fixed expiry, last-use, revocation, and CSRF verifier.
- Structural synchronous session-store port.

These are implementation details; only the API above is public.

## Dependencies on other libs

- `clock` for wall timestamps and monotonic throttle timing. This is the only internal runtime or type-only dependency.

The session store is a structural port implemented by `reader-store`; no dependency inversion cycle exists.

## New build or OSS wrapper

New narrow build over Node Web Crypto and Node runtime encodings. No general authentication framework, password hash, JWT library, or third-party runtime dependency.

## Hosted by

`services/personal-reader` as asynchronous HTTP authentication/authorization hooks.

## Configuration

- `auth.access_token_path` — **required** for every deployment mode; path to the pre-provisioned high-entropy token. The service loads the value; this library performs no file I/O.
- `auth.session_ttl_seconds` — **optional**, default `604800`, integer `1..31_536_000`.
- `auth.login_max_attempts` — **optional**, default `10`, integer `1..1_000_000`.
- `auth.login_window_seconds` — **optional**, default `300`, integer `1..86_400`.

No additional keys control cookie policy, cleanup, throttling persistence, CSRF rotation, or token entropy.

## Acceptance-focused test expectations

Assert behavior through the public API with an in-memory structural store. Use `createFixedClock` for forward-time cases and a scripted `Clock` for backward wall time. A private crypto-adapter seam may script digest failures and completion order without becoming package API. At minimum, cover:

- `should reject invalid options without echoing the configured token`.
- `should use fixed error messages and validate the presence and range of retry-after seconds`.
- `should accept boundary token byte lengths and numeric policy values and reject values just outside them`.
- `should issue independent base64url secrets and persist only their lowercase SHA-256 hashes`.
- `should return no issued secrets when session insertion throws`.
- `should reject an incorrect token with the fixed invalid-token error and insert no session`.
- `should authenticate a session and return a clone with advanced last-use time`.
- `should preserve last-use time when wall time moves backward`.
- `should reject a session exactly at expiry and never extend expiry by touching it`.
- `should reject a revoked session after logout and make repeated logout a no-op`.
- `should mark an existing expired session revoked on logout while missing sessions remain no-ops`.
- `should leave other sessions usable when one session is revoked`.
- `should verify only the matching CSRF secret on an authenticated unexpired session`.
- `should reject malformed, hash-valued, expired-session, and revoked-session CSRF inputs`.
- `should reserve the configured number of attempts before concurrent token digests complete`.
- `should count successful and unsuccessful attempts and reject attempts beyond the fixed-window limit`.
- `should reset the throttle at the exact monotonic window boundary and report exact retry-after seconds`.
- `should keep throttles from separate instances independent`.
- `should propagate store and crypto failures without converting them to authentication failures`.
- `should never contain raw token, session, or CSRF sentinels in serialized expected errors or persisted records`.
- `should linearize concurrent logout and authentication at their synchronous store sequences`.

A later composition test must run the same cases against the real `reader-store` access-session repository and an awaited service authentication hook.
