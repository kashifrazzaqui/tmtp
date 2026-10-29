# Article Fetcher Library Spec

## Purpose and responsibility

Fetch one arbitrary public article HTML document under a fail-closed URL, DNS, connection-pinning, redirect, deadline, and size policy. Return detached source text and provenance; do not extract, sanitize, store, or render article content.

`http-client` owns HTTP transfer mechanics, GET retries, buffered transfer bytes, and pinned sockets. This package owns everything that transport cannot safely decide for an arbitrary article: URL allowlists, global-address classification, fresh DNS and pins for manual redirect hops, the overall multi-hop budget, content decoding, HTML media-type checks, and character decoding. `article-extractor` receives the returned HTML but performs no fetching.

## Public interface / API surface

The package root is `@tmtp/article-fetcher`. It has no default export or subpath exports.

```ts
export type ArticleProtocol = "http" | "https";
export type ArticleContentType = "text/html" | "application/xhtml+xml";

export interface FetchedArticle {
  sourceUrl: string;
  finalUrl: string;
  contentType: ArticleContentType;
  html: string;
  fetchedAt: string; // ISO-8601 UTC with Z suffix and millisecond precision
}

export interface ArticleDnsResolver {
  resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
}

export interface ArticleFetcherOptions {
  http: import("@tmtp/http-client").HttpClient;
  clock: import("@tmtp/clock").Clock;
  sleep: import("@tmtp/clock").Sleep;
  timeoutMs: number;
  dnsTimeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  allowedProtocols: readonly ArticleProtocol[];
  allowedPorts: readonly number[];
  resolver?: ArticleDnsResolver;
}

export interface ArticleFetcher {
  fetch(url: string, signal?: AbortSignal): Promise<FetchedArticle>;
}

export type ArticleFetchErrorCode =
  | "invalid-url"
  | "invalid-request"
  | "url-policy"
  | "dns-timeout"
  | "dns-failed"
  | "address-policy"
  | "timeout"
  | "response-too-large"
  | "redirect-limit"
  | "invalid-redirect"
  | "http-status"
  | "unsupported-content-type"
  | "unsupported-charset"
  | "unsupported-content-encoding"
  | "invalid-content-encoding"
  | "invalid-text"
  | "transport"
  | "client-closed";

export class ArticleFetchError extends Error {
  readonly name: "ArticleFetchError";
  readonly code: ArticleFetchErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  constructor(
    code: ArticleFetchErrorCode,
    options: { retryable: boolean; status?: number },
  );
}

export function createArticleFetcher(options: ArticleFetcherOptions): ArticleFetcher;
```

Runtime exports are exactly `createArticleFetcher` and `ArticleFetchError`. Type exports are exactly `ArticleProtocol`, `ArticleContentType`, `FetchedArticle`, `ArticleDnsResolver`, `ArticleFetcherOptions`, `ArticleFetcher`, and `ArticleFetchErrorCode`.

`FetchedArticle.fetchedAt` is an ISO-8601 UTC string and introduces no domain-package dependency. Package dependencies remain `clock`, `http-client`, and `ip-address`. No Undici, Node stream, zlib, DNS error, or response-header type escapes the public boundary.

`ArticleDnsResolver` is a deterministic seam, not a general DNS API. It returns every A/AAAA address as an IP literal, without CIDR suffixes or IPv6 zone identifiers. A custom resolver must honor the supplied signal to provide prompt cancellation. The production default uses Node's `dns.promises.lookup(hostname, { all: true, verbatim: true })`; the timeout and abort coordinator still stops the fetch chain if that native lookup cannot be cancelled promptly.

## Construction and immutable options

`createArticleFetcher` validates and snapshots its options synchronously. Wrong runtime types throw `TypeError`; invalid numeric ranges or empty/duplicate policy arrays throw `RangeError`. Validation finishes before the first fetch, and no construction work starts a request, DNS lookup, timer, or decoder.

- `http.request`, `clock.now`, `clock.monotonicNowMs`, and `sleep` are required functions. The HTTP client and resolver are borrowed, not owned.
- `timeoutMs` and `dnsTimeoutMs` are safe integers in `1..2_147_483_647` ms. Neither zero nor infinity is supported.
- `maxResponseBytes` is a safe integer in `1..2_147_483_647`. The same value independently bounds each transfer body and the final decoded body.
- `maxRedirects` is a safe integer in `0..100`. Zero permits the initial response but follows no redirect.
- `allowedProtocols` is a non-empty duplicate-free array containing only `http` and/or `https`.
- `allowedPorts` is a non-empty duplicate-free array of integers in `1..65535`.
- `resolver`, when present, has a function-valued `resolve` property. Omitting it selects the Node lookup adapter.

Scalar options and both arrays are copied. Later mutation of the options or arrays cannot change policy. The factory has no module-global resolver, client, timer, buffer, or mutable fetch state.

## Per-call validation and normalized URLs

`fetch` always returns a Promise. Expected validation, policy, network, and content failures reject with `ArticleFetchError`; they do not throw synchronously.

The initial input must be a string and `signal`, when supplied, must be an `AbortSignal`. A non-string input rejects as `invalid-url`; an invalid signal rejects as `invalid-request`. Both fail before cancellation or I/O. A string that cannot be parsed as an absolute HTTP(S) WHATWG URL also rejects as `invalid-url`.

For the initial URL and every redirect target:

1. Parse with the platform WHATWG `URL` parser. Require a non-empty hostname and no username or password.
2. Require `url.protocol.slice(0, -1)` to be in the snapshotted protocol allowlist. Other schemes, including `file`, `ftp`, `data`, `blob`, and `javascript`, never reach DNS or HTTP.
3. Compute the effective port: the explicit URL port, otherwise `443` for HTTPS or `80` for HTTP. Require it in the port allowlist.
4. Remove the fragment. Do not remove or rewrite the path, query, username/password rejection result, or trailing root dot in a DNS hostname.
5. Save the normalized, credential-free, fragment-free serialization for the request and possible `finalUrl`.

Credentials, a disallowed protocol, or a disallowed port reject as `url-policy`. The protocol and port lists cannot broaden `http-client`'s own HTTP(S)-only contract. There is no automatic protocol downgrade, proxy use, credential propagation, cookie jar, authorization header, or caller-supplied header path.

After input validation, an already-aborted caller signal rejects with the exact `signal.reason` before a deadline, DNS lookup, log, or HTTP request starts. Validation wins over pre-cancellation. At every later await/settlement checkpoint, observed caller cancellation also wins over the operation outcome and preserves the exact reason without wrapping it in `ArticleFetchError` or `DOMException`.

## One overall fetch budget

`timeoutMs` is the total budget for one `fetch` call. It begins after initial validation and includes all DNS resolutions, HTTP connection work, response headers and bodies, `http-client` GET retry sleeps, redirect processing, content decompression, character decoding, and final timestamp creation. It is not a per-hop or idle-socket budget.

The package creates one request-local operation controller and starts one injected `sleep(timeoutMs, deadlineSignal)` wait. Caller cancellation aborts the operation with the caller's exact reason. Deadline fulfillment aborts it with a private overall-timeout reason. DNS waits, every HTTP request, and decoding observe the operation signal. Normal settlement cancels the deadline wait and removes listeners.

Before each `HttpClient.request`, calculate remaining time from the same `Clock` instance:

```text
remainingMs = timeoutMs - max(0, clock.monotonicNowMs() - fetchStartedMs)
```

If `remainingMs <= 0`, reject as `timeout` without another request. Otherwise pass:

```text
request.timeoutMs = max(1, ceil(remainingMs))
request.signal = operationSignal
```

The outer overall deadline enforces the exact budget if rounding or a non-cooperative dependency lets work cross the calculated boundary. The per-request value lets `http-client` apply its own total deadline across all retries of that hop; it is never the original `article.timeout_ms` restarted for each redirect. DNS and redirect work reduce the budget available to later requests. Hops and retry attempts never overlap.

`dnsTimeoutMs` is a separate maximum for each individual DNS resolution, including a resolution triggered by a redirect. Its effective wait is the smaller of that value and the overall remaining time. A DNS-limit expiry rejects as `dns-timeout`; overall expiry rejects as `timeout`; the first observed expiry or caller cancellation wins. A literal IP URL needs classification but no DNS wait.

A custom resolver or `Sleep` that ignores cancellation cannot be forcibly stopped. The wrapper stops advancing the fetch chain when cancellation is observed, but a non-cooperative native lookup or custom wait may settle later in the background. It can never cause another article HTTP request. Production HTTP transport and decoding must cooperate with the operation signal. Synchronous URL/policy work and final string concatenation are bounded by the redirect and byte limits but are not independently preemptible.

## DNS classification and connection pinning

Every non-literal hostname is resolved afresh for every manual redirect hop. The original URL host is never resolved by `http-client` on a pinned request.

For each resolved address and each IP-literal host:

1. Validate an IPv4 or IPv6 literal with `ip-address`; reject CIDR suffixes and zone identifiers.
2. Canonicalize with `Address4.correctForm()` or `Address6.correctForm()`. IPv6 URL brackets are URL syntax, not part of the address passed to the classifier.
3. Require `isGlobal()` to return true. Under the pinned `ip-address@10.7.5` contract, IPv4-mapped and well-known NAT64 addresses are classified through their embedded IPv4 address; NAT64 local-use and non-global/special-purpose addresses are not global.
4. Classify **every** address returned for the hop before selecting one. If any returned address is invalid or non-global, reject the whole hop as `address-policy`. Do not select a global address from a mixed public/private answer.
5. With no addresses, or a resolver failure other than observed cancellation/timeout, reject as `dns-failed`. With all addresses valid and global, select the first in resolver order. Address fallback and Happy Eyeballs are outside this contract.

The selected address produces a fresh `HttpConnection`:

```ts
{
  address: canonicalSelectedAddress,
  port: effectivePort,
  servername: normalizedUrlHostname,
}
```

The URL retains its original host so HTTP Host and TLS certificate expectations remain associated with that host. `servername` follows `http-client`'s normalized-hostname validation, including its IPv6 URL representation. The pin chooses the socket destination only; it is not itself an SSRF approval. A retry of the same `HttpClient.request` may reuse that hop's pin, but each followed redirect performs a new lookup, complete classification, and pin construction. No selected address or prior redirect pin is carried to another URL.

## Manual redirect state machine

Every request uses `method: "GET"`, `redirect: "manual"`, the fixed headers below, and the current hop's fresh pin:

```text
Accept: text/html,application/xhtml+xml
Accept-Encoding: gzip, deflate, br, identity
```

Only `301`, `302`, `303`, `307`, and `308` responses with a `Location` header are redirect candidates. GET remains GET for all five statuses. A redirect status without `Location`, and every other non-200 status, follows the HTTP-status error path instead of being returned as an article.

For a candidate:

1. Require exactly one `Location` field value. Resolve it against the current URL with WHATWG URL rules. Parse failure, an empty value, or multiple field values rejects as `invalid-redirect`.
2. If `maxRedirects` follows have already occurred, reject as `redirect-limit` before target DNS or HTTP work.
3. Apply the complete URL credential/protocol/port policy. A malformed target is `invalid-redirect`; a valid but disallowed target is `url-policy`.
4. Discard the already bounded redirect body without decoding or retaining it. Do not accumulate redirect bodies across the chain.
5. Resolve and classify the target again, create a new pin, and issue the next sequential request with the remaining overall budget.

At most `maxRedirects + 1` HTTP request calls occur in one fetch, excluding internal retries of those calls. Loop detection is not a substitute for this bound. Redirect `Location`, URLs, response headers, and bodies never appear in safe errors.

## Final response, content decoding, and text decoding

Only status `200` can produce `FetchedArticle`. Any other final status rejects as `http-status` with the numeric `status`. No response body is decoded or parsed for a non-200 status.

### Media type and character set

A final response must have exactly one valid `Content-Type` field value. Media-type matching is ASCII case-insensitive and optional parameters are allowed. Supported media types are exactly:

- `text/html`
- `application/xhtml+xml`

An absent, multiple, malformed, or different media type rejects as `unsupported-content-type`. `FetchedArticle.contentType` is the normalized lowercase media type without parameters.

A `charset` parameter, when present, must be ASCII case-insensitively `utf-8` or `utf8`; repeated charset parameters are invalid. An absent charset defaults to UTF-8 for this adapter. Any other charset rejects as `unsupported-charset`. Other media-type parameters do not affect decoding. Character decoding uses a fatal UTF-8 decoder; malformed UTF-8 rejects as `invalid-text` rather than inserting replacement characters. HTML `<meta charset>` declarations do not override the HTTP-level adapter contract.

### Transfer bytes versus decoded bytes

`http-client` returns bytes after HTTP transfer framing and before content decompression. It does not request or perform decompression for this package. Its per-request `maxResponseBytes` is set to this fetcher's `maxResponseBytes`, so every initial, redirect, and retryable-status body is bounded as transferred.

The following `Content-Encoding` tokens are accepted ASCII case-insensitively:

| Token | Processing |
|---|---|
| absent | Identity; no content decoding |
| `identity` | Identity; only valid as the sole token |
| `gzip` | Streaming gzip decoding |
| `deflate` | Streaming zlib-wrapped deflate decoding |
| `br` | Streaming Brotli decoding |

Multiple comma-separated encoding fields/values are combined in field order. Non-identity encodings are decoded in reverse listed order, as required for stacked content codings. Empty tokens, `identity` mixed with another coding, and every other coding, including `compress` and `zstd`, reject as `unsupported-content-encoding`. A malformed or truncated supported stream rejects as `invalid-content-encoding`.

The final decoded representation has an independent hard limit of `maxResponseBytes`, even though it uses the same configured value as the transfer limit. Count decoded bytes before appending each decoder chunk. Exactly-at-limit output succeeds; the first chunk that would exceed the limit destroys the decoder and rejects as `response-too-large`. No partial HTML is returned. Redirect bodies are not content-decoded. Thus a small compressed body cannot expand without bound, and neither `Content-Length` nor the transfer limit alone is treated as a decoded-size guarantee.

After successful content decoding, decode the bounded bytes as UTF-8 and return one detached `html` string. `sourceUrl` is the normalized initial URL; `finalUrl` is the normalized URL of the final hop. `fetchedAt` is obtained once after successful final decoding from `clock.now()` and formatted as ISO-8601 UTC with a `Z` suffix and millisecond precision. A later abort cannot change an already returned result.

## Typed safe errors

`ArticleFetchError` has a fixed message selected by `code`. Messages never contain an input/final/redirect URL, hostname, DNS address, header, body, HTML, dependency message, or abort reason. The class has no public `cause`; in particular, it does not leak `HttpError.cause`. `status` is present for `http-status` and for a size error when response headers supplied a status. Consumers use `code`, not message matching, for control flow.

`retryable` is advice for a later independent article job/fetch, not permission for this package to start another overall fetch. Within one call, only `http-client`'s configured GET retry policy retries an individual request.

| Code | Fixed message | `retryable` |
|---|---|---|
| `invalid-url` | `Article URL is invalid.` | `false` |
| `invalid-request` | `Article HTTP request is invalid.` | `false` |
| `url-policy` | `Article URL is not allowed by policy.` | `false` |
| `dns-timeout` | `Article DNS resolution timed out.` | `true` |
| `dns-failed` | `Article DNS resolution failed.` | `true` |
| `address-policy` | `Article address is not globally routable.` | `false` |
| `timeout` | `Article fetch timed out.` | `true` |
| `response-too-large` | `Article response exceeded a byte limit.` | `false` |
| `redirect-limit` | `Article redirect limit was exceeded.` | `false` |
| `invalid-redirect` | `Article redirect location is invalid.` | `false` |
| `http-status` | `Article origin returned an unsuccessful HTTP status.` | `true` only for `408`, `425`, `429`, `500`, `502`, `503`, `504` |
| `unsupported-content-type` | `Article response is not a supported HTML media type.` | `false` |
| `unsupported-charset` | `Article response charset is not supported.` | `false` |
| `unsupported-content-encoding` | `Article content encoding is not supported.` | `false` |
| `invalid-content-encoding` | `Article content encoding is invalid.` | `false` |
| `invalid-text` | `Article response is not valid UTF-8 text.` | `false` |
| `transport` | `Article HTTP transport failed.` | `true` |
| `client-closed` | `Article HTTP client is closed.` | `false` |

Upstream `HttpError` maps as follows: `invalid-request` to `invalid-request`; `timeout` to `timeout`; `response-too-large` to `response-too-large`; `redirect-policy` to `url-policy`; `redirect-limit` to `redirect-limit`; `invalid-redirect` to `invalid-redirect`; `transport` to `transport`; and `client-closed` to `client-closed`. The mapping is defensive even though manual redirect mode should make upstream redirect errors unreachable. Upstream status-bearing responses are not exceptions until this package applies its own status table.

Caller abort reasons propagate unchanged. Failures thrown by injected `Clock`/`Sleep` infrastructure and programming errors are not disguised as remote article failures; they propagate unchanged. Expected resolver rejections map to `dns-failed` after cancellation and timeout priority has been applied. No package logging is added because `logging` is not a dependency; callers log only the safe error fields and their own redacted metadata.

## Concurrency, lifecycle, and resource ownership

- Every fetch has independent URL state, redirect count, controllers, deadline waits, DNS state, selected pin, decoder, and output buffers. Concurrent calls share only the explicitly injected stateless/policy dependencies and `HttpClient`'s own safe pooling.
- `ArticleFetcher` has no `close` method. It never closes the borrowed HTTP client or a custom resolver. The service owns `HttpClient.close()` and the outer shutdown grace period.
- Settlement closes/destroys any active decoder, cancels DNS and overall deadline waits, removes abort listeners, and prevents later redirects. Buffered response ownership has already ended at the `HttpClient` boundary.
- Closing the shared HTTP client does not masquerade as caller cancellation; affected requests reject as `client-closed` through the mapping above.
- One response body occupies at most the transfer bound, and one final decoder output occupies at most the decoded bound. Bodies from earlier hops are released before the next request.
- Fetching performs no HTML parsing, script execution, DOM creation, subresource loading, filesystem access, storage, or rendering. Returned HTML remains untrusted until `article-extractor` sanitizes it.

## Invariants

1. No network request occurs without an allowlisted HTTP(S) URL/effective port and a freshly validated global-address pin.
2. Every hostname answer is fail-closed across all returned addresses, including mapped/NAT64 forms; every redirect repeats resolution and classification.
3. One overall deadline spans DNS, every request/retry/redirect, and decoding; each HTTP deadline is derived from the remaining budget.
4. Redirects are manual, sequential, GET-only, and bounded by `maxRedirects`.
5. Every transfer body and the final decoded body independently satisfy `maxResponseBytes`; supported content codings are explicit and decoded streaming in reverse order.
6. Only status-200 UTF-8 HTML of an allowed media type returns successfully, with normalized source/final provenance and an observation timestamp.
7. Expected failures are safe typed errors, caller cancellation preserves reason identity, and no error/log path exposes untrusted content or transport causes.
8. Settlement leaves no fetch-owned decoder, deadline wait, or abort listener, and the package never closes borrowed dependencies.

## Acceptance-focused test expectations

Tests exercise the public package root with a scripted `HttpClient`, fixed monotonic/wall clock, multi-pending fake `Sleep`, and scripted resolver. They use no real timers or external network. A real `ip-address@10.7.5` classifier is used for policy tests; it is not mocked.

### Validation, DNS, and redirect security

- `should reject malformed credentials disallowed protocols and ports before DNS or HTTP work`.
- `should snapshot construction policy and reject invalid numeric ranges and duplicate or empty allowlists`.
- `should reject a pre-aborted fetch with the identical reason after input validation and before creating waits`.
- `should classify every resolved address and reject mixed global and private answers rather than selecting the global address`.
- `should reject loopback private link-local CGNAT multicast unspecified documentation benchmarking ULA and other non-global addresses` using representative IPv4/IPv6 cases.
- `should reject IPv4-mapped and well-known NAT64 forms of private or loopback addresses and NAT64 local-use addresses`.
- `should allow a mapped or well-known NAT64 form only when its embedded IPv4 address is global and pin the original address family`.
- `should require a nonempty all-literal resolver result and map empty malformed and failed lookups to the documented errors`.
- `should select the first address only after the complete answer passes classification and preserve Host and normalized servername in the pin`.
- `should re-resolve reclassify and create a fresh pin for every manual redirect hop`, including a second hop whose DNS answer changes to private.
- `should resolve relative protocol-relative and absolute redirect locations against the current hop and reject malformed multiple and credential-bearing locations`.
- `should enforce zero exact and exceeded redirect limits before target DNS work and never follow other 3xx statuses`.

### Budget, cancellation, and lifecycle

- `should derive each HttpClient timeout from monotonic remaining time rather than restarting the overall budget per hop`.
- `should include fake DNS delay redirect processing and HttpClient retry time in the remaining budget`.
- `should apply the smaller of per-lookup DNS timeout and remaining overall time and distinguish dns-timeout from timeout`.
- `should abort in-flight HTTP and prevent the next hop when cancelled with an exact object or primitive reason`.
- `should prefer observed caller cancellation over a simultaneous response or resolver outcome`.
- `should stop the chain after a non-cooperative lookup settles late and never issue its queued HTTP request`.
- `should cancel deadline waits remove listeners destroy decoders and keep concurrent fetch state isolated on every success and failure path`.
- `should leave borrowed HttpClient and custom resolver open when a fetch settles and map shared-client closure to client-closed`.

### Body, encoding, and content boundaries

- `should pass maxResponseBytes to every manual HttpClient request including redirect hops`.
- `should accept absent and identity content encodings and decode gzip deflate br and stacked encodings in reverse order` using real Node zlib fixtures.
- `should reject unsupported mixed-identity empty and malformed encoding tokens before text decoding`.
- `should reject malformed and truncated supported compressed streams as invalid-content-encoding`.
- `should enforce decoded byte limits independently of compressed transfer size for every supported non-identity coding`.
- `should accept exactly-at-limit transfer and decoded bodies reject the first excess decoded chunk and return no partial HTML`.
- `should accept only single text/html or application/xhtml+xml Content-Type values with case-insensitive media and UTF-8 charset handling`.
- `should reject absent multiple non-HTML unsupported-charset and malformed-UTF-8 responses without returning HTML`.
- `should map final statuses and every HttpError code to the documented safe error retryability and optional status`.
- `should return normalized initial and final URLs lowercase media type exact HTML and the fixed clock timestamp on success`.
- `should keep error messages and serialized safe fields free of URL hostname address header body and abort-reason sentinels`.

### Workflow acceptance

For WF-04, compose a fake `HttpClient` with real URL/DNS/classifier/decoder logic to prove that an arbitrary URL cannot reach a private or special-purpose destination directly or through a redirect, that compressed expansion is bounded, and that no fetched markup is executed or sanitized by this package. Use loopback servers only as network traps that must receive zero requests for rejected policy cases; success policy tests do not weaken global-address checks to make a local server pass.

## Internal subcomponents

- Option/request validation and immutable policy snapshots.
- Overall/DNS deadline and cancellation coordination.
- URL/redirect policy, DNS adapter, global-address classification, and pin construction.
- Manual redirect walker and safe `HttpClient` error mapping.
- Streaming content decoder, decoded-byte collector, media/charset validation, and UTF-8 conversion.

The module design and dependency flow are specified in [arch.md](arch.md). These modules are private implementation details; only the API above is public.

## Dependencies on other libs

- `clock` — wall-clock success timestamp, monotonic remaining-time readings, and injected cancellation-aware sleep.
- `http-client` — bounded buffered transfer responses, GET retry orchestration, manual redirects, cancellation, and fresh pinned connections.

`ip-address` is the only direct third-party package. Node `dns`, `net`, `stream`, `zlib`, and `TextDecoder` capabilities are implementation details. The package must not import `article-extractor`, `article-reader`, `domain`, `config`, `logging`, or service code.

## New build or OSS wrapper

New build using `ip-address` `10.7.5` and the Undici controls exposed by `http-client`. Node supplies DNS lookup and streaming gzip/deflate/Brotli decoding. No global `fetch`, proxy-agent, browser, HTML parser, or decompression helper from Undici is used.

## Hosted by

`article-reader` jobs in `services/personal-reader`. The service supplies the shared HTTP client, `systemClock`, `systemSleep`, and production resolver default, and closes the HTTP client during lifecycle shutdown.

## Configuration

Existing keys, owners, and defaults are unchanged. The service validates and supplies complete values; this package reads no configuration source directly.

| Key | Required / default | Runtime range and meaning |
|---|---|---|
| `article.timeout_ms` | optional, `20000` | Safe integer `1..2_147_483_647`; one overall multi-hop fetch budget |
| `article.dns_timeout_ms` | optional, `5000` | Safe integer `1..2_147_483_647`; per-resolution cap within the overall budget |
| `article.max_response_bytes` | optional, `5000000` | Safe integer `1..2_147_483_647`; independent transfer and decoded-body hard limit |
| `article.max_redirects` | optional, `5` | Safe integer `0..100`; followed manual redirects, not initial requests or retries |
| `article.allowed_protocols` | optional, `["https","http"]` | Non-empty unique subset of `https`, `http` |
| `article.allowed_ports` | optional, `[80,443]` | Non-empty unique integers `1..65535` |

There is no separate decoded-size configuration key and no new retry, user-agent, proxy, credential, cookie, or concurrency key. Decoded size deliberately reuses `article.max_response_bytes`; HTTP retry and User-Agent settings remain owned by `http-client` under `http.*`.
