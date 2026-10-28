# HTTP Client Library Spec

## Purpose and responsibility

Provide a narrow asynchronous HTTP/1.1 and HTTPS boundary with buffered responses, total request deadlines, cancellation, bounded retry, explicit redirects, optional address-pinned connections, response byte limits, structured errors, and allowlisted operational logging.

The package owns transport policy only. Callers own URL allowlists, DNS resolution and global-address classification, redirect limits for manual redirect walkers, content decoding, JSON/HTML parsing, cookie persistence, authentication decisions, and domain error mapping. No Undici object or type escapes the public boundary.

## Public interface / API surface

The package root is `@tmtp/http-client`. It has no default export or subpath exports.

```ts
export type HttpMethod = "GET" | "POST";
export type HttpRedirectPolicy = "manual" | "same-origin";

export interface HttpConnection {
  address: string;
  port: number;
  servername: string;
}

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxResponseBytes?: number;
  redirect: HttpRedirectPolicy;
  connection?: HttpConnection;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string, readonly string[]>>;
  body: Uint8Array;
  finalUrl: string;
}

export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
  close(): Promise<void>;
}

export interface HttpTransportRequest {
  method: HttpMethod;
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
  connection?: HttpConnection;
  signal: AbortSignal;
}

export interface HttpTransportResponse {
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
}

export interface HttpTransport {
  request(request: HttpTransportRequest): Promise<HttpTransportResponse>;
  close(): Promise<void>;
}

export interface HttpClientOptions {
  clock: import("@tmtp/clock").Clock;
  sleep: import("@tmtp/clock").Sleep;
  timeoutMs: number;
  maxResponseBytes?: number;
  userAgent: string;
  retryPolicy: import("@tmtp/retry").RetryPolicy;
  logger: import("@tmtp/logging").Logger;
  random?: import("@tmtp/retry").RandomSource;
  transport?: HttpTransport;
}

export type HttpErrorCode =
  | "invalid-request"
  | "timeout"
  | "response-too-large"
  | "redirect-policy"
  | "redirect-limit"
  | "invalid-redirect"
  | "transport"
  | "client-closed";

export class HttpError extends Error {
  readonly name: "HttpError";
  readonly code: HttpErrorCode;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly status?: number;
  readonly cause?: unknown;
  constructor(
    code: HttpErrorCode,
    options: {
      retryable: boolean;
      attempts: number;
      status?: number;
      cause?: unknown;
    },
  );
}

export function createHttpClient(options: HttpClientOptions): HttpClient;
```

Runtime exports are exactly `createHttpClient` and `HttpError`. Type exports are exactly `HttpMethod`, `HttpRedirectPolicy`, `HttpConnection`, `HttpRequest`, `HttpResponse`, `HttpClient`, `HttpTransportRequest`, `HttpTransportResponse`, `HttpTransport`, `HttpClientOptions`, and `HttpErrorCode`.

`HttpTransport` is a deterministic adapter seam, not a second high-level HTTP API. Production normally omits it and receives the private Undici transport. A supplied transport must honor the validated URL, connection pin, body, and signal, and must clean up its response body when the consumer closes the async iterator. Ownership of a supplied transport transfers to the client; `HttpClient.close()` closes it.

## Construction and immutable options

`createHttpClient` validates and snapshots its options synchronously. Invalid options throw `TypeError` for wrong types or `RangeError` for invalid numeric ranges before a default Agent is allocated. Later mutation of the options, retry policy, or a custom transport configuration object does not alter the client policy.

- `clock.monotonicNowMs`, `sleep`, and every `Logger` method, including `trace`, are required functions. `logger.child` is also required.
- `timeoutMs` is a safe integer in `1..2_147_483_647` ms. There is no zero or infinite deadline.
- `maxResponseBytes`, when supplied, is a safe integer in `0..2_147_483_647`. Its documented default is `5_000_000` bytes; this is a library default, not a new configuration key.
- `userAgent` is trimmed, must be non-empty, and must not contain CR, LF, or NUL. The trimmed value is sent on every request.
- `retryPolicy` follows the complete `@tmtp/retry` validation contract. In particular, delays are bounded by `2_147_483_647` ms and `maxAttempts >= 1`.
- `random`, when supplied, is forwarded to `executeWithRetry`. Omitting it uses that package's default `Math.random` source. No random draw occurs unless a GET retry with jitter is approved.
- `transport`, when supplied, must have function-valued `request` and `close` properties.

The factory starts no request and owns no module-global dispatcher, client, timer, or logger. Separate clients have independent close state and default connection pools.

## Request validation and snapshots

`request` always returns a Promise. Request validation failures reject with `HttpError`; they do not throw synchronously.

Before cancellation or network work, the client validates and snapshots the request:

- `method` is exactly `GET` or `POST`. GET has no body. POST may omit its body. Request bodies are fully buffered inputs, not streams.
- `url` is a valid absolute WHATWG `http:` or `https:` URL with a non-empty hostname and no username or password. URL fragments are removed before transport and from `finalUrl`. Protocol allowlists such as `article.allowed_protocols` remain a caller responsibility.
- Header names are valid HTTP tokens and values are strings without CR, LF, or NUL. Names differing only by case are rejected as duplicates.
- Callers cannot supply `host`, `content-length`, `connection`, `transfer-encoding`, `upgrade`, `expect`, `te`, `trailer`, or `user-agent` in any case. Undici derives transport framing and Host from the URL; the configured `userAgent` supplies User-Agent. `authorization`, `proxy-authorization`, `cookie`, and ordinary content headers remain available to trusted callers but are never logged.
- `timeoutMs`, when supplied, uses the construction range and overrides the client default for this call.
- `maxResponseBytes`, when supplied, uses the construction range and overrides the client default. Zero permits only an empty body.
- `redirect` is required and exactly `manual` or `same-origin`.
- `signal`, when supplied, is an `AbortSignal`.
- A `Uint8Array` body and the header record are copied. Strings are immutable. The request snapshot is reused for every replay, so caller mutation cannot change later attempts.

A connection pin has the following additional checks:

- `address` is an IPv4 or IPv6 literal according to Node's IP parser. Hostnames are not accepted and no DNS lookup is performed to validate this field.
- `port` is an integer in `1..65535` and equals the URL's effective port.
- `servername` is non-empty and matches the URL hostname after URL/ASCII normalization and case folding. It preserves the expected TLS certificate name and SNI while `address` selects the socket destination.
- Syntax validation is not an SSRF decision. `article-fetcher` must resolve and classify every address as global before supplying the pin.

Validation failure has `code="invalid-request"`, `retryable=false`, and `attempts=0`. After validation, a closing client rejects with `client-closed`; then an already-aborted caller signal rejects with the exact `signal.reason`. Thus validation wins over close state and cancellation, and close state wins over pre-cancellation. No timer, transport call, or log record begins in any of these cases.

## Total deadline and cancellation

The effective `timeoutMs` is one total deadline for the whole `request` call. It starts after validation and includes the initial log, connection setup, request upload, response headers, response body buffering, redirects, retry classification, and retry sleeps. It is not a per-attempt or idle-socket timeout.

The client implements the deadline through the injected `Sleep`, not a global timer. It links the caller signal, its timeout reason, and the transport/retry signal through one request-local `AbortController`:

- Caller cancellation aborts in-flight transport and retry sleep with the exact caller reason and rejects with that same value. Reasons are not wrapped or converted to `AbortError`.
- Deadline expiry aborts transport and retry sleep, prevents another attempt, and rejects with `HttpError("timeout")`. The timeout error has `retryable=false` because this call's total budget is exhausted.
- When timeout and caller cancellation race, the first observed abort wins. An abort observed at a settlement checkpoint wins over the operation outcome.
- Normal success or failure cancels the deadline sleep and removes the caller abort listener. Every settled request leaves no request-owned sleep, listener, or response iterator behind.
- The default Undici transport cooperates promptly with the signal. A custom transport or custom `Sleep` must also cooperate; the wrapper cannot forcibly stop arbitrary non-cooperative work and observes cancellation only when that work settles.

The injected clock supplies monotonic readings for retry context and log durations. Wall-clock time is never used to calculate this deadline.

## Attempt and retry semantics

One call to `executeWithRetry` orchestrates each request. Attempt 1 starts immediately; there is no initial retry sleep. Attempts are sequential and one-based.

- GET uses the configured retry policy and forwards the injected `random`, `sleep`, caller-linked signal, and `clock.monotonicNowMs` source.
- POST uses the same policy with `maxAttempts` forced to `1`. It never receives an automatic retry, retry sleep, retry classifier call, or jitter draw. This prevents a timed-out HN mutation from being blindly repeated; `hn-account` must re-read state before any new mutation.
- A redirect chain belongs to its attempt. A retry restarts from the original request snapshot and original URL, not from a previously reached redirect. Redirects do not consume retry attempts, so transport hops can exceed `HttpError.attempts`.
- The total deadline spans all attempts. There is no separate retry-time budget.

For GET, retry is approved only for:

1. `HttpError("transport")`, where `retryable=true`; this covers connection, DNS, TLS, socket, premature-close, malformed-response, and response-stream failures not caused by cancellation, timeout, or the body limit.
2. A fully buffered response with status `408`, `425`, `429`, `500`, `502`, `503`, or `504`.

All other failures are non-retryable. In particular, invalid requests, redirects rejected by policy, redirect-limit errors, response-size errors, logging failures, callback/source failures, and cancellation are not retried. A response-size failure is never converted into a transport retry.

Retry uses the exact `RetryPolicy` algorithm and preserves original operation failures. `Retry-After` is not parsed and does not alter configured backoff. If a retryable HTTP status remains after the final attempt, that final response is returned normally rather than converted to an error. Every non-2xx response outside the retry-status set is also returned normally; consumers own status interpretation.

For POST, transport errors have `retryable=false` in the public error. For GET, a transport error has `retryable=true` even when the current call has exhausted its attempt budget; this field describes transport-level retry eligibility, not remaining budget. Timeout, size, redirect, validation, and close errors always have `retryable=false`.

## Redirect behavior

### `manual`

No redirect is followed. A `301`, `302`, `303`, `307`, or `308` response is buffered and returned like any other response, with `finalUrl` equal to the current request URL. The client does not resolve or validate its `Location` value.

This is the required mode for `article-fetcher`: it owns `article.max_redirects`, resolves `Location`, applies protocol/port/credential policy, resolves and classifies DNS again, and issues a new request with a new validated `connection` for every hop.

### `same-origin`

The client follows only `301`, `302`, `303`, `307`, and `308` responses with a `Location` header. It resolves the value against the current URL using WHATWG URL rules.

- Every target must be a valid absolute HTTP(S) URL after resolution, have no credentials, and have exactly the original request's origin. Origin comparison includes protocol, normalized hostname, and effective port. A cross-origin or protocol-changing target rejects with `redirect-policy`; an invalid target rejects with `invalid-redirect`.
- A redirect response without `Location` is returned normally. Redirect statuses outside the five listed above are returned normally.
- At most five redirects are followed per attempt. Requiring a sixth follow rejects with `redirect-limit`. This fixed transport bound is independent of `article.max_redirects`, which applies only to the caller's manual walker.
- `301`, `302`, and `303` change POST to GET and remove the body and entity headers. GET remains GET. `307` and `308` preserve the method, body snapshot, and headers.
- Sensitive caller headers are retained only because every followed hop is same-origin. No redirect may carry credentials to another origin.
- The validated connection pin, when present, is retained across same-origin hops. A redirect body is discarded and its iterator closed before the next hop; it is never returned or buffered for later use.

The redirect status, current attempt number, and safe error code are available for logging. Raw `Location`, URLs with paths/queries, and redirect response headers are not logged.

## Response headers and byte limits

The client buffers the final response and every candidate retryable-status response before returning or classifying it. It does not use Undici's unbounded body helpers.

- Response header names are lowercase. Values are fresh arrays; repeated fields preserve Undici's multi-value representation, including separate `set-cookie` values. Header order across different names is not contractual.
- `body` is a fresh `Uint8Array`. `finalUrl` is the normalized, credential-free, fragment-free URL of the returned response after any same-origin redirects.
- The effective `maxResponseBytes` counts body bytes delivered after HTTP transfer framing and before any caller-owned content decoding. The client does not request or perform decompression. A caller that opts into a content encoding must decode it and apply a separate decoded-size limit.
- A valid `Content-Length` greater than the limit fails before body buffering. Otherwise the client counts every chunk and fails on the first chunk that would exceed the limit. Exactly-at-limit bodies succeed.
- Size failure closes/destroys the response iterator so a pooled connection cannot be reused with unread bytes. No partial body is returned. The error has `code="response-too-large"`, `retryable=false`, the current `attempts`, and `status` when headers were received.
- Redirect bodies are discarded rather than accumulated. Response headers and bodies are never included in `HttpError` or logs.

The default transport uses direct origin connections, not environment proxy settings. Ordinary calls may reuse keep-alive connections through a private Undici Agent; reuse and pool layout are implementation details and no caller may supply a dispatcher. Each pinned transport call uses a fresh single-origin Client and a connector that dials `address`/`port` while preserving `servername`; pinned connections are never returned to the ordinary pool. Its Client closes when that response stream finishes, fails, or is discarded.

## Error contract

`HttpError` has a fixed safe message selected by `code`:

| Code | Message | Typical `status` presence |
|---|---|---|
| `invalid-request` | `Invalid HTTP request.` | absent |
| `timeout` | `HTTP request timed out.` | absent |
| `response-too-large` | `HTTP response exceeded the byte limit.` | present after response headers |
| `redirect-policy` | `HTTP redirect is not allowed by the origin policy.` | redirect status |
| `redirect-limit` | `HTTP redirect limit was exceeded.` | redirect status |
| `invalid-redirect` | `HTTP redirect location is invalid.` | redirect status |
| `transport` | `HTTP transport failed.` | absent |
| `client-closed` | `HTTP client is closed.` | absent |

`attempts` is zero for pre-attempt rejection and otherwise identifies the current retry attempt, not the number of redirect hops. `cause`, when present, preserves the original transport failure for programmatic inspection. Fixed messages never include URLs, headers, bodies, addresses, or dependency messages. Consumers must not log raw `cause`; it can contain sensitive URL text from a dependency.

Caller abort reasons, custom sleep/random failures, logger failures, and close failures are not normalized into `HttpError`. They propagate according to their own contracts and are not automatically retried.

## Close and lifecycle

`close` is idempotent and returns the same Promise for concurrent calls.

1. The first call marks the client closing immediately. Later `request` calls reject with `client-closed` after their own validation.
2. Existing requests are not aborted. They may finish their current retry/redirect flow under their existing signals and total deadlines.
3. After all active requests settle, the client calls the owned transport's `close()` exactly once. The default transport then drains/closes its Agent and any remaining pinned Clients.
4. The returned Promise fulfills only after transport closure. A transport close failure rejects the shared close Promise and is not retried; the client remains closed to new work.

The service owns the outer shutdown grace period. It must call `close()` during shutdown and must not assume that close cancels caller work.

## Allowlisted logging

The client uses the supplied `Logger` directly so inherited correlation fields survive. It creates no request IDs and logs no raw request, response, error cause, header, body, URL path, query, fragment, credential, redirect target, DNS address, or socket information.

After URL validation, `origin` means only the normalized, credential-free `scheme://host[:port]` value. Log events and fields are exactly:

| Event | Level | Fields |
|---|---|---|
| `http.request.started` | `debug` | `method`, `origin`, `timeoutMs`, `maxResponseBytes`, `redirectPolicy`, `connectionPinned` |
| `http.request.retry` | `debug` | `method`, `origin`, `attempt`, `elapsedMs`, `reason`, optional `status` |
| `http.request.completed` | `info` | `method`, `origin`, `status`, `attempts`, `elapsedMs`, `responseBytes`, `redirectCount`, `connectionPinned` |
| `http.request.failed` | `warn` | `method`, `origin`, `errorCode`, `attempts`, `elapsedMs`, `connectionPinned`, optional `status` |

`reason` is the fixed `HttpError.code` or `http-status`; `errorCode` is the fixed `HttpError.code` or `cancelled`. Validation and pre-start cancellation failures are not logged because no validated safe projection exists yet. No success/failure record includes the original thrown value. Logger redaction remains defense in depth, not permission to expand this field set.

## Invariants

1. Every network call has a finite total deadline, a bounded response body, and at most the configured GET attempt budget; POST has exactly one attempt.
2. Attempts never overlap. Every retry uses the injected sleep/random/clock seams and the same request-local signal.
3. Caller cancellation preserves reason identity, and settlement cleans up deadline waits, listeners, and bodies.
4. Manual redirects never leave the caller's policy boundary; automatic redirects never leave the original origin and never exceed five follows per attempt.
5. A pinned request dials only the supplied IP/port while preserving URL Host and TLS server name; pinned sockets never enter the general pool.
6. Response and error objects contain no hidden stream or Undici dependency, and log fields contain only the documented safe metadata.
7. Close admits no new requests, does not masquerade as cancellation, and releases owned transport resources after active calls settle.

## Deterministic seams and acceptance-focused tests

Unit tests inject `HttpTransport`, `Sleep`, `RandomSource`, a fixed/monotonic clock, and a recording logger. They do not open sockets or wait on real timers.

A useful transport fake records normalized requests and returns scripted header/chunk/error sequences. Its body fake supports early iterator closure and asserts cleanup. A useful sleep fake supports multiple concurrently pending calls: one request deadline plus possible retry sleeps. It records `(delayMs, signal)`, can resolve a selected sleep to trigger timeout, and honors abort with exact reason identity. A queued random source and monotonic readings make retry delays and log durations exact. The recording logger implements `trace`, `debug`, `info`, `warn`, `error`, and `child`; `child` retains safe inherited fields. At least one logging integration test uses the real logger with a capture destination rather than only this fake.

At minimum, cover:

- `should snapshot headers bodies and policy before retrying`.
- `should reject invalid URLs headers bodies pins and numeric limits before transport or sleep starts`.
- `should reject a pre-aborted request with the identical reason after validation`.
- `should apply one total deadline across response waiting redirects and retry backoff`.
- `should cancel the deadline sleep and abort listener on every success and failure path`.
- `should retry eligible GET transport failures and statuses sequentially with deterministic jitter`.
- `should return the final retryable-status response after attempt exhaustion`.
- `should never retry POST or invoke its retry classifier random source or retry sleep`.
- `should not retry size redirect validation cancellation or logging failures`.
- `should resolve same-origin redirects and apply 301 302 303 and 307 308 method/body rules`.
- `should reject cross-origin credential-bearing and malformed redirects without sending another hop`.
- `should enforce five same-origin redirects per attempt and leave all manual redirects to the caller`.
- `should preserve the original pin across same-origin hops and require a new caller pin for manual hops`.
- `should enforce Content-Length and streamed byte limits including zero and exact-limit bodies and close oversized iterators`.
- `should preserve original caller abort reasons through transport and retry sleeps`.
- `should normalize duplicate response headers without exposing them to logs`.
- `should stop new requests on close drain existing requests and close the owned transport once`.
- `should log exactly the allowlisted fields at every level used while recording trace-capable logger fakes and real redaction integration`.
- `should keep separate clients and concurrent requests isolated`.

Integration tests use local HTTP/HTTPS servers to prove real Undici behavior: original Host and SNI with a pinned address, no DNS lookup for the pinned hop, ordinary-pool versus pinned-client cleanup, cancellation of a stalled body, redirect handling, and close of keep-alive sockets. These tests use ephemeral loopback servers only; deterministic policy tests do not depend on real timing.

## Internal subcomponents

- Public option/request validation and immutable snapshots.
- Deadline/abort coordination and retry adapter.
- Redirect state machine and bounded response collector.
- Direct Agent and fresh pinned-Client Undici transport.
- Typed error mapping and allowlisted metadata logging.

These are implementation details; only the API above is public.

## Dependencies on other libs

- `clock` — monotonic readings and injected cancellation-aware sleep.
- `logging` — structural `Logger` only.
- `retry` — bounded attempts, backoff, jitter, and retry cancellation.

The dependency graph is unchanged. `article-fetcher`, `hn-account`, and `hn-public-api` depend on this package, never the reverse.

## New build or OSS wrapper

New narrow wrapper around Undici `8.12.3`; no global `fetch`, proxy-agent, redirect helper, or response-body convenience API is exposed.

## Hosted by

HN clients and `article-fetcher` in `services/personal-reader`. The service constructs one client, injects `systemSleep` in production, and closes it during lifecycle shutdown.

## Configuration

Existing keys, owners, and defaults are unchanged:

- `http.timeout_ms` — **optional**, default `20000`; total deadline per `HttpClient.request`, including retries and automatic redirects.
- `http.retry.max_attempts` — **optional**, default `3`; GET only, counting the initial attempt.
- `http.retry.base_delay_ms` — **optional**, default `500`.
- `http.retry.max_delay_ms` — **optional**, default `8000`.
- `http.retry.jitter_ratio` — **optional**, default `0.2`.
- `http.user_agent` — **optional**, default `tmtp-personal-reader/0.1`.

The library-level default response limit is `5_000_000` bytes and the same-origin redirect bound is five; neither introduces a configuration key. `article.max_response_bytes` and `article.max_redirects` remain separate article-fetcher overrides/policies.
