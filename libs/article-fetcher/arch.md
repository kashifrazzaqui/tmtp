# Article Fetcher Architecture

## Architectural role and dependency direction

`article-fetcher` is a tier-2 ESM policy adapter over `@tmtp/http-client`, `@tmtp/clock`, and `ip-address@10.7.5`. It turns an untrusted article URL into one bounded, detached HTML string. It does not contain a second HTTP transport, a general retry loop, an HTML parser, or a persistence model.

The dependency direction is deliberately narrow:

```text
article-reader
  -> article-fetcher
       -> http-client -> Undici transfer/pinned sockets/GET retries
       -> clock       -> wall timestamp/monotonic time/Sleep
       -> ip-address  -> global-address classification
       -> Node dns/zlib/stream/TextDecoder
  -> article-extractor -> inert parsing and sanitization
```

The public package root exports only the documented factory, error class, and types. Private helpers are not package subpaths. No type or runtime import from `domain`, `article-extractor`, `article-reader`, `config`, `logging`, or service code is needed.

## Internal module decomposition

| Module | Responsibility | Important collaborators |
|---|---|---|
| `index` | Public exports and fetch pipeline | All internal stages |
| `options` | Construction/per-call validation and immutable policy snapshots | Platform `URL`, structural dependencies |
| `errors` | Fixed safe errors, HTTP-error mapping, cancellation priority | `HttpError` only at the private boundary |
| `deadline` | Overall and per-DNS budgets, remaining-time arithmetic, linked signals, cleanup | `Clock`, `Sleep` |
| `url-policy` | URL normalization, credentials/protocol/port checks, redirect resolution | Platform `URL` |
| `dns` | Node lookup adapter, per-hop resolution, complete-answer classification | `ArticleDnsResolver`, `ip-address`, Node `net` |
| `redirects` | Sequential manual redirect state machine and fresh pin creation | URL policy, DNS, deadline |
| `encoding` | Content-Encoding parsing, reverse streaming decode, decoded-byte limit | Node zlib/stream |
| `content` | Status/media/charset checks, fatal UTF-8 conversion, success projection | `HttpResponse`, `Clock` |

Each security rule has one owner. In particular, `dns` is the only address classifier, `deadline` is the only overall budget calculator, and `encoding` is the only decoded-byte accountant. The redirect walker composes these modules rather than duplicating their checks.

## Construction and per-fetch state

The factory copies all scalar values, protocol/port arrays, and dependency references. It creates no default resolver until needed and stores no per-request state. A fetch creates a context conceptually like:

```text
sourceUrl
currentUrl
redirectCount = 0
startedMonotonicMs
operationController
overallDeadlineController
callerAbortListener?
selectedConnection?
activeDnsWait?
activeDecoder?
settled = false
```

The overall controller carries either a private overall-timeout reason or the exact caller reason. DNS waits use a separate private DNS-timeout reason and are linked to the same operation controller. Every continuation first checks whether the operation has been cancelled; after every await, cancellation wins before processing that await's value or failure.

A single `try/finally` owns cleanup. The `finally` cancels outstanding DNS/deadline waits, consumes expected cleanup rejections, removes the caller listener, destroys an active decoder, and marks the context settled. A settled context cannot start another DNS lookup or HTTP request.

## Deadline composition

### Overall wait

After input validation and the pre-abort check, read `clock.monotonicNowMs()` once and start `sleep(timeoutMs, overallDeadlineController.signal)` without awaiting it as the operation result. Its fulfillment aborts `operationController` with the private overall-timeout reason. Its unexpected rejection is an infrastructure failure: abort the operation with that value and later propagate it unchanged unless caller cancellation won first.

The fetch operation starts immediately after this wait is installed. Final cleanup aborts only the deadline controller, not the caller's controller, and consumes the expected sleep rejection.

### Per-request mapping

Immediately before each HTTP call:

1. Read the same monotonic clock and clamp the difference to non-negative elapsed time.
2. Compute `remainingMs = timeoutMs - elapsedMs`.
3. Reject with overall `timeout` if it is not positive.
4. Set `HttpRequest.timeoutMs = max(1, ceil(remainingMs))`.
5. Pass the overall operation signal and the current hop's `maxResponseBytes` and pin.

`http-client` then runs its own total deadline across its retries for that request. It has no knowledge of redirect hops owned here. The outer overall wait remains authoritative if the rounded per-request deadline is slightly longer or an inner operation is non-cooperative.

There is no second retry implementation in `article-fetcher`. A transport failure returned by `HttpClient.request` is already the terminal result of that hop's configured GET attempts. Mapping it to `ArticleFetchError` does not trigger another request.

### DNS wait

For each hostname hop, start a separate injected sleep for:

```text
min(dnsTimeoutMs, max(1, ceil(remainingMs)))
```

Race the resolver settlement against DNS timeout, overall timeout, and caller cancellation through linked signals rather than polling. Stop with `dns-timeout` only when the DNS-specific reason wins. Cancel and clean this wait as soon as resolution settles.

The default adapter calls `dns.promises.lookup` with `{ all: true, verbatim: true }`. This obtains all A/AAAA results through Node's hostname resolution path and preserves returned order. Node's lookup is not promised to be promptly cancellable; the coordinator therefore must not claim that the native query is destroyed. It abandons the lookup result and prevents all later article work. A custom resolver receives the operation signal and should cancel its own work promptly.

## URL, DNS, and pin pipeline

Apply this pipeline independently to the initial URL and each redirect target:

```text
untrusted URL/reference
  -> WHATWG parse and fragment removal
  -> credential / protocol / effective-port policy
  -> literal address OR fresh all-record hostname lookup
  -> parse every address
  -> isGlobal() on every address
  -> select first only after the complete answer passes
  -> new HttpConnection pin
  -> HttpClient GET with manual redirects
```

Use Node's IP parsing to recognize a literal host. For an IPv6 URL, remove its URL brackets before address classification; retain the normalized URL hostname expected by `http-client` for `servername`. Do not perform DNS for a literal.

For resolver results, construct `Address4` or `Address6` from each complete string. Reject a suffix, zone, non-literal, or empty result. Call `correctForm()` for the socket address, then `isGlobal()` for the security decision.

The installed `10.7.5` implementation is significant here: `Address6.isGlobal()` calls `embeddedIPv4()` for IPv4-mapped and well-known NAT64 addresses and delegates to `Address4.isGlobal()`. Its table marks NAT64 local-use non-global. Pin the canonical form of the **original selected address**, not the embedded IPv4 address; converting a NAT64 destination to IPv4 would change the route. Classification normalizes the security meaning without changing the dial family.

Classify the entire answer before selecting the first address. This fail-closed rule prevents an attacker-controlled answer from hiding a private address behind a public first result. No connection fallback is implemented, so a later address is never dialed without the same complete-hop validation having succeeded.

The request URL never changes to the IP. `http-client` receives the original normalized URL and a fresh `{ address, port, servername }` connection. Its private Undici connector dials the selected address while retaining Host/TLS naming and keeps pinned sockets outside the ordinary pool.

## Manual redirect walker

For each hop, send only the fixed GET request headers and `redirect: "manual"`. Process the buffered response as follows:

1. If status is not one of the five redirect statuses, leave redirect processing and apply the final status/content rules.
2. If `Location` is absent, leave redirect processing; the status becomes `http-status`.
3. Validate exactly one field value and resolve it against `currentUrl`.
4. Check the followed-count bound before target DNS.
5. Run the full target URL/DNS/pin pipeline.
6. Release the current buffered body reference, increment the count, replace `currentUrl` and the pin, and continue.

GET has no body to rewrite for `303`; all redirect statuses retain the same fixed headers. There are no sensitive headers to strip and no same-origin exception to global-address revalidation. Redirect bodies are already transfer-bounded by `http-client` and are never content-decoded or concatenated.

## Bounded content decoding

### Header parsing

Inspect status first. For status 200, require one Content-Type value and parse its media type/parameters without preserving raw header text in errors. Normalize the two accepted media types to lowercase. Validate charset before spending decoder work.

Collect Content-Encoding values in header order and split comma-separated tokens with ASCII whitespace trimming. Reject empty lists/tokens. If there is no coding, or the sole coding is `identity`, use the transfer bytes directly. Otherwise map each token to one private Node decoder:

- `gzip` -> `createGunzip`
- `deflate` -> `createInflate` (zlib wrapper, not raw deflate)
- `br` -> `createBrotliDecompress`

Apply decoders in reverse token order. Do not use Undici body helpers or assume that it decompressed any bytes.

### Streaming decoded-byte accounting

Although the transfer input is already buffered, pass it through the decoder chain as a stream and collect output chunks incrementally. Before retaining each chunk:

```text
if decodedBytes + chunk.byteLength > maxResponseBytes:
  destroy the whole decoder chain
  throw response-too-large
```

Exactly-at-limit output is valid. On every decoder error, abort, or overflow, destroy all stages and discard partial chunks. Map an ordinary malformed/truncated coding failure to `invalid-content-encoding`; never expose zlib's message. Decoder settlement is linked to the overall operation signal so compressed expansion cannot outlive the fetch.

Only after successful decoder completion concatenate the bounded chunks and apply `TextDecoder("utf-8", { fatal: true })`. Convert a decoding failure to `invalid-text`. Capture `clock.now()` after text succeeds and serialize it with `toISOString()`, yielding the required millisecond UTC representation.

The transfer and decoded limits are separate checks over separate byte sequences. Reusing one configured value avoids another key but never means that passing the compressed-byte check implies passing the decoded-byte check.

## Error boundary and information flow

Keep private control envelopes for overall timeout, DNS timeout, and status context out of the public API. At the outer boundary:

1. If caller cancellation is observed, throw its exact reason.
2. If an injected clock/sleep infrastructure failure won, propagate that exact value.
3. Convert the private control outcome or expected HTTP/DNS/decoder/content failure to `ArticleFetchError`.
4. Otherwise return the detached success object.

`HttpError.cause`, native DNS errors, zlib errors, URLs, and body buffers are never attached to the public error. The optional numeric status is copied only where documented. This package emits no logs; upstream HTTP logs retain their own allowlist and downstream callers must not add raw input/redirect targets or content to error records.

## Concurrency and shutdown

No mutable state exists at module or fetcher scope beyond immutable policy and borrowed dependency references. Two fetches can resolve the same hostname concurrently without sharing answers or pins. Their deadline controllers and decoded-byte counters are independent.

The service closes the shared `HttpClient`; this package does not. During shutdown, the service should cancel active article jobs through their signals, wait within its grace period, and then close the HTTP client according to that package's drain contract. `client-closed` is a lifecycle error, not caller cancellation.

A non-cooperative native DNS lookup can finish after its fetch has rejected, but it retains no continuation capable of HTTP work. This is the only permitted late dependency activity; decoder and HTTP resources are expected to cooperate with abort and be cleaned at settlement.

## Trade-offs

- **All answers must be global:** mixed answers are rejected rather than trying a safe subset. This can reduce availability for unusual DNS configurations but removes ambiguous SSRF behavior.
- **First address only:** no Happy Eyeballs or per-address fallback keeps the pin and security proof simple. Availability depends on resolver ordering and HTTP retries to the selected address.
- **Node lookup instead of direct DNS queries:** the default honors the host's normal name-resolution path, but native lookup cancellation is limited. The fetch chain still stops at its deadline.
- **Fresh resolution and pinned Client per hop:** this costs DNS and connection setup but prevents redirect rebinding and cross-address pool reuse.
- **Buffered transfer, streaming decode:** `http-client` supplies a simple bounded input while the decoder still enforces an independent output bound. Peak memory is bounded by both representations rather than by compression ratio.
- **UTF-8 only:** excluding legacy charsets and meta-based sniffing makes behavior deterministic at the cost of rejecting some older pages. Extraction/fallback remains available to the composition.
- **One configured size for two representations:** this preserves the configuration surface but does not let operators tune compressed and decoded limits independently.
- **No local logging:** safe errors and upstream allowlisted HTTP events avoid duplicating sensitive URL/DNS metadata.

## Testing seams and verification design

Test through `createArticleFetcher`; do not export private classifiers, deadline functions, or decoder collectors solely for tests.

### Deterministic harness

- A fake `HttpClient` records URL, headers, pin, remaining `timeoutMs`, transfer limit, redirect mode, and signal. It scripts responses and every `HttpError` code.
- A fake resolver records hostname/signal calls and returns ordered addresses, malformed values, mixed answers, delays, abort cooperation, and late non-cooperative settlement.
- Fixed clocks supply exact monotonic sequences and one success timestamp. A multi-pending sleep fake independently controls overall, DNS, and any test-composed HTTP waits.
- Real `ip-address` checks representative global/non-global IPv4, IPv6, mapped, NAT64, and local-use values. Do not replace the security predicate with a stub.
- Real Node zlib produces forward/stacked encoded fixtures, malformed streams, and high-expansion payloads. Assert decoded limits with small configured values so tests stay fast.

Assert exact request sequences, timeout arithmetic, pin freshness, cleanup, safe error codes/messages/retryability, and cancellation reason identity. Concurrency tests interleave two redirect/DNS scripts and prove that neither context uses the other's URL, address, deadline, or decoder output.

### Integration evidence

The upstream HTTP suite already owns real Undici Host/SNI pinning and socket behavior. This package adds loopback **trap** servers for direct and redirect private-address cases and asserts zero connections. It does not allow private addresses merely to make success integration convenient.

Use real Node DNS/zlib smoke tests only where platform integration is needed and keep them separate from deterministic correctness tests. WF-04 acceptance composes the public fetcher with the extractor: fetched HTML is delivered unchanged to the inert/sanitizing boundary, while this package performs no DOM or subresource activity.
