# HTTP Client Architecture

## Design goal and boundary

Implement `spec.md` as a tier-1 ESM adapter over `undici@8.12.3`, `@tmtp/clock`, `@tmtp/logging`, and `@tmtp/retry`. Keep transport mechanics below a small buffered-response façade. Keep DNS/SSRF policy and manual redirect walking above it in `article-fetcher`.

The public package root exports only the documented factory, error class, and types. Undici dispatchers, connectors, body streams, options, and error classes remain private. The `HttpTransport` seam is project-owned and exists so contract tests can run without sockets or global timers.

## Internal decomposition

Keep these responsibilities private behind the package root:

- **Options and request snapshot:** validate construction/request input, clone policy/headers/bytes, normalize URLs, and project safe origins.
- **Request lifecycle:** track open/closing state, active requests, total deadline, caller cancellation, and final cleanup.
- **Attempt coordinator:** call `executeWithRetry`, classify failures/statuses, and preserve POST's single-attempt rule.
- **Redirect walker:** execute sequential hops within one attempt and apply the manual/same-origin state machines.
- **Response collector:** normalize headers, enforce byte limits, buffer candidate returns, and close discarded bodies.
- **Undici transport:** implement `HttpTransport` with a direct Agent for ordinary calls and fresh pinned Clients for pinned calls.
- **Error/log projection:** map transport failures to fixed safe errors and emit only the allowlisted metadata.

These modules are organizational, not public subpaths. The pure URL/header/redirect and byte-accounting helpers can be unit-tested internally, but all contract suites also exercise `createHttpClient` through the package root.

## Construction and client state

Validate all factory options before constructing the default transport. Copy scalar options, the four retry-policy fields, and dependency references. A custom transport is adopted; the default transport is constructed once and owned by the client.

A client closes over:

```text
state = open | closing | closed
activeRequests: Set<Promise<void>>
transportClosePromise?: Promise<void>
closePromise?: Promise<void>
```

`request` validates before observing state. It then rejects a closing/closed client, observes pre-cancellation, registers one active-request lifetime Promise, and performs its work. Its `finally` settles/removes that lifetime entry.

The first `close` changes state to `closing` synchronously and creates the shared close Promise. When the active set becomes empty, it calls `transport.close()` once and then marks `closed`. Further close calls return the same Promise. This ordering lets an already-admitted request finish a redirect or retry without racing a half-closed Agent, while preventing any new request from entering.

No global dispatcher is changed. No request or policy state is shared between client instances.

## URL, header, and body snapshots

Parse the input with `new URL(input)`, require HTTP(S), reject credentials, and save a normalized URL with an empty hash. Compute the effective port for pin validation and the safe `origin` projection from that parsed URL. Do not include path/query in any operational metadata.

Normalize header names to lowercase only after detecting case-insensitive duplicates and forbidden names. Copy the values into a fresh record, then set the configured User-Agent. Leave Host and framing headers to Undici. Clone a byte body with a new `Uint8Array`; retain string bodies directly. The resulting per-call snapshot is the only source for all attempts and 307/308 replays.

For a pin, validate IP syntax, effective-port equality, and normalized server-name equality. Do not resolve `address`, classify its network range, or treat a syntactically valid pin as SSRF approval.

## Total-deadline coordinator

Use two request-local controllers and one caller listener:

- `operationController` supplies the signal to retry, retry sleeps, and every transport hop.
- `deadlineController` cancels the injected deadline sleep during final cleanup.
- The caller listener aborts `operationController` with the exact caller `signal.reason`.

After validation, start `sleep(timeoutMs, deadlineController.signal)` and attach fulfillment/rejection handlers without awaiting the deadline. Fulfillment aborts the operation with a private `TimeoutReason`. An unexpected sleeper rejection aborts it with that dependency failure unless the deadline controller was deliberately cancelled during cleanup. The retry operation starts immediately after this setup.

The operation's outcome handling checks `operationController.signal.reason` at settlement:

1. If the caller signal is aborted, reject with its exact reason.
2. If the reason is `TimeoutReason`, map to the fixed timeout `HttpError`.
3. If the reason is another dependency failure, propagate that failure unchanged.
4. Otherwise return or map the operation outcome.

In `finally`, remove the caller listener, close any outstanding body iterator, abort `deadlineController` with a private cleanup reason, and consume the expected deadline-sleep rejection. This prevents an unhandled rejection and leaves no deadline timer. Do not poll monotonic time to enforce the deadline; monotonic readings are for retry context and elapsed log fields only.

The same injected `Sleep` therefore has two roles, sometimes concurrently: the single total-deadline wait and zero or more retry waits. Each invocation owns independent cancellation, exactly as the clock contract specifies. Production passes `systemSleep`; tests use a multi-pending fake rather than a single sequential delay queue.

## Attempt and status coordination

Create an effective retry policy per request:

- GET: the configured policy unchanged.
- POST: a copy with `maxAttempts: 1`.

Call `executeWithRetry` with:

- an operation that runs one redirect-aware attempt from the original snapshot;
- the effective policy;
- the injected sleep and optional random source;
- `() => clock.monotonicNowMs()` as the monotonic source;
- `operationController.signal`;
- a classifier described below.

The retry package supplies sequential attempts, context, backoff, jitter, and cancellation checkpoints. This package adds no second retry timer and no total retry-time option.

### Transport failure classification

Map an Undici/transport thrown value to `HttpError("transport")` inside the operation unless it is already one of this package's control outcomes. Set `retryable` to `method === "GET"`. Preserve the original value only in `cause`; never copy its message into the public error or logs.

The classifier returns true only for GET and an `HttpError` with `code="transport"` and `retryable=true`. POST's one-attempt policy prevents classification anyway. Timeout/caller cancellation is checked before this classification and wins.

### Retryable-status envelope

A response with status `408`, `425`, `429`, `500`, `502`, `503`, or `504` is fully buffered and then thrown as a private `StatusFailure` containing the complete `HttpResponse`. This envelope is not an `HttpError` and never escapes.

The classifier returns true for GET and `StatusFailure`. On exhaustion or POST's single attempt, `executeWithRetry` rejects with the final envelope; the outer request boundary unwraps it and returns the contained response. This is how final HTTP statuses remain ordinary responses while earlier statuses can consume retry budget. Do not put response bodies in public errors or log fields.

Any classifier, sleeper, random, monotonic, or logger exception remains outside these operation envelopes so the retry package treats it as an infrastructure/callback failure rather than another operation attempt.

## Redirect state machine

Each attempt starts with the original method, URL, headers, body, pin, and `redirectCount=0`.

1. Call `transport.request` with the current normalized URL and operation signal.
2. Normalize response headers before inspecting status or `Location`.
3. If status is not one of `301`, `302`, `303`, `307`, or `308`, proceed to response collection.
4. If policy is `manual`, proceed to response collection without reading `Location`.
5. If `Location` is absent, proceed to response collection.
6. Resolve `Location` against the current URL. Map parser/credential failures to `invalid-redirect` and origin mismatches to `redirect-policy`.
7. If five redirects have already been followed, reject with `redirect-limit`.
8. Close/discard the redirect body before opening the next hop.
9. Apply the method/body transformation, remove entity headers when POST becomes GET, retain the pin, increment `redirectCount`, and continue sequentially.

Compare the target to the original URL's normalized origin, not merely the immediately preceding host. Use URL's normalized protocol/hostname/effective-port components. Set the target hash to empty before transport and before saving a potential `finalUrl`.

A same-origin redirect never needs fresh DNS or SSRF approval from this package because the pinned address is retained or the ordinary origin connection policy is unchanged. Arbitrary article redirects use `manual`, so `article-fetcher` must perform fresh validation and supply a fresh pin for every new request.

## Bounded response collection

Use the response body's async iterator directly; do not call `text()`, `arrayBuffer()`, or `bytes()` on Undici's body.

The production transport wraps its raw Undici body so closing the async iterator calls the corresponding stream cleanup/destroy operation. The collector closes the iterator on every early exit. For redirect bodies it closes the iterator immediately instead of draining an untrusted amount of data.

For a response that may be returned or status-retried:

1. Read a valid `Content-Length`, if present, and reject immediately when it exceeds the effective limit.
2. Iterate chunks, validating byte-like values from a custom transport and tracking their exact byte lengths.
3. Before appending a chunk, check `received + chunk.length <= maxResponseBytes`.
4. On overflow, close/destroy the iterator and throw the fixed size error without retaining a partial public body.
5. Concatenate the bounded chunks into one fresh `Uint8Array` on successful completion.

This limit applies to transfer-decoded bytes supplied by Undici. There is no decompression stage. A future decompression feature would need a separate streaming decoded-byte budget rather than relying on this limit.

Normalize header names to lowercase and values to fresh string arrays. The transport can use Undici's incoming header representation; no raw response header object is retained after normalization.

## Undici transport design

### Ordinary requests

Use one private `Agent` with direct origin connections. Do not install an environment proxy Agent or expose the Agent as a dispatcher option. HTTP/2, pipelining, and keep-alive pooling are private implementation choices; pin `allowH2: false` and `pipelining: 1` for the initial narrow adapter.

The total operation signal is the public timeout mechanism. Disable separate Undici connect/header/body timeout policies where their APIs accept zero so they cannot create a second user-visible timeout classification. Socket setup and response streaming still honor the operation signal.

Pass the URL's origin separately from its path/query. Undici derives Host from the original origin. Preserve the body snapshot and normalized headers.

### Pinned requests

For every transport call containing `connection`, construct a fresh `Client` using the original URL origin. Its custom connector wraps Undici's `buildConnector` and changes only dial-related inputs:

- connector `hostname` becomes `connection.address`;
- connector `port` becomes the validated port;
- TLS `servername` remains the validated URL server name;
- the Client origin and request Host remain derived from the original URL.

This uses the pinned Undici connector behavior for both TCP and TLS. It performs no hostname lookup of the original article host. Use a new connector/Client per pinned call so TLS sessions and sockets cannot be reused for a different validated address or origin. Disable HTTP/2 and pipelining for the pinned Client as well.

The wrapped response iterator closes the Client gracefully after a complete body and destroys it on an error, size overflow, redirect discard, or cancellation. The transport tracks any not-yet-closed pinned Clients so its own `close()` can finish cleanup after active wrapper requests have settled.

### Close

Once the high-level client has drained active requests, ordinary Agent closure releases idle keep-alive sockets. The pinned set should normally be empty because each body has already ended; close any remaining handles defensively. Propagate the first close failure after attempting all owned cleanup, and share the resulting close Promise with all callers.

## Logging flow

Create log fields from the validated request snapshot and numeric state only. The safe origin is computed once and reused. The logger is called directly, not with an interpolated format string and not with an `err` object containing an Undici cause.

- Emit `started` before attempt 1.
- Emit `retry` from the classifier with the one-based failed attempt and fixed reason/status.
- Emit `completed` before returning a response, using the final response status, bytes, attempt count, redirect count, and monotonic duration.
- Emit `failed` before a mapped request failure leaves the client, using only fixed codes and optional numeric status.

Do not emit failure metadata before a safe origin exists. Logger exceptions are not swallowed, converted to transport errors, or fed back into retry. Request/body/deadline cleanup still runs in `finally`; a successful HTTP exchange whose completion log throws therefore rejects with the logger failure rather than pretending logging succeeded.

## Dependency use

- `@tmtp/clock`: `Clock.monotonicNowMs()` and structural `Sleep`; production composition supplies `systemClock`/`systemSleep`.
- `@tmtp/retry`: `executeWithRetry`, `RetryPolicy`, and optional `RandomSource`.
- `@tmtp/logging`: the complete `Logger` interface, including `trace`, with no Pino access.
- `undici@8.12.3`: private Agent, Client, connector, request, and stream adapters.

There are no imports from `article-fetcher`, HN packages, `config`, service code, or other new dependencies. Existing package tiers and configuration ownership remain unchanged.

## Trade-offs

- **Buffered responses:** simple deterministic results and replayable status handling cost memory up to the explicit per-response limit. Streaming belongs in a future separate API if needed.
- **One total deadline:** callers get a clear upper bound rather than multiplying timeout by attempts and redirects. A caller wanting per-attempt budgets needs a different explicit policy, not hidden Undici defaults.
- **Retry statuses through a private envelope:** the retry package remains generic while final HTTP statuses stay normal responses. The envelope requires careful outer unwrapping and tests.
- **No automatic POST retry:** network ambiguity is surfaced to `hn-account` instead of risking a duplicate mutation. Idempotent POST support would require a future explicit request policy and caller reconciliation design.
- **Fresh pinned Clients:** this sacrifices reuse for strong address/origin isolation and straightforward cleanup. Ordinary HN traffic retains pooling.
- **Five automatic redirects:** fixed-origin clients get bounded convenience without inheriting `article.max_redirects` or weakening manual SSRF checks.
- **Injected transport and multi-pending Sleep:** tests become deterministic, while conforming adapters must honor signal and iterator cleanup contracts.
- **Direct synchronous logging:** an output failure can fail an HTTP operation after network success. This is preferable to silently losing operational records and is not retryable.

## Testing seams and verification design

Test the public API with a scripted `HttpTransport` and never export private redirect, collector, deadline, or error-envelope helpers for tests.

### Deterministic harness

- The transport fake records request snapshots, URL hops, pins, signals, and close calls. It scripts thrown values, headers, chunk sequences, stalled streams, and iterator-close observations.
- The sleep fake tracks each call independently by delay and invocation order. Tests resolve the total-deadline wait or a retry wait explicitly and verify abort cleanup for both.
- The random and monotonic fakes supply exact sequences and call counts. Use a fixed clock for non-retry elapsed readings.
- The logger fake records all five levels and child context; it must include `trace` even though current HTTP events use debug/info/warn. A real logger capture test verifies the allowlisted fields survive actual serialization/redaction.

### Contract and integration suites

Use table-driven tests for URL/header/pin validation, status retry classification, redirect methods/origins/limits, and response-size boundaries. Assert exact attempts, retry sleep sequences, random calls, cleanup, error codes, safe messages, and caller-reason identity. Run concurrent requests to prove independent controllers and close accounting.

Use local HTTP/HTTPS integration servers only for behavior that must establish the real Undici adapter: connection pinning with original Host/SNI, no original-host DNS lookup, socket cleanup after full/oversized/discarded/cancelled bodies, direct keep-alive closure, and signal propagation. Do not use external networks or real sleeps for the correctness suite.
