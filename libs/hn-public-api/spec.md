# Hacker News Public API Library Spec

## Purpose and responsibility

Provide a typed, bounded client for the official public Hacker News Firebase API and a pure normalizer from official items to domain stories. The package owns endpoint construction, JSON boundary validation, versioned raw-item preservation, story field normalization, and deterministic source-content versioning.

It knows nothing about SQLite, cursors, schedules, jobs, feed seeding, private account state, cookies, votes, favorites, flags, or mutations. `hn-ingestion` supplies observation timestamps and, when needed, the previous stored story; it owns collection and upsert policy. `http-client` owns transfer deadlines, cancellation, GET retries, redirect transport, and response byte collection.

## Public interface / API surface

The package root is `@tmtp/hn-public-api`. It has no default export or subpath exports.

```ts
export interface HnPublicApi {
  maxItemId(signal?: AbortSignal): Promise<number>;
  item(
    id: number,
    signal?: AbortSignal,
  ): Promise<import("@tmtp/domain").HnItem | undefined>;
  feed(
    name: import("@tmtp/domain").HnFeed,
    signal?: AbortSignal,
  ): Promise<number[]>;
}

export interface HnPublicApiOptions {
  baseUrl: string;
  http: import("@tmtp/http-client").HttpClient;
}

export interface NormalizeStoryInput {
  item: import("@tmtp/domain").HnItem;
  observedAt: import("@tmtp/domain").IsoDateTime;
  previous?: import("@tmtp/domain").Story;
}

export type HnPublicApiOperation =
  | "max-item"
  | "item"
  | "feed"
  | "normalize-story";

export type HnPublicApiErrorCode =
  | "invalid-input"
  | "invalid-response"
  | "http-status"
  | "timeout"
  | "response-too-large"
  | "redirect-policy"
  | "redirect-limit"
  | "invalid-redirect"
  | "transport"
  | "client-closed";

export class HnPublicApiError extends Error {
  readonly name: "HnPublicApiError";
  readonly code: HnPublicApiErrorCode;
  readonly operation: HnPublicApiOperation;
  readonly retryable: boolean;
  readonly status?: number;
  constructor(
    code: HnPublicApiErrorCode,
    options: {
      operation: HnPublicApiOperation;
      retryable: boolean;
      status?: number;
    },
  );
}

export function createHnPublicApi(options: HnPublicApiOptions): HnPublicApi;

export function normalizeStory(
  input: NormalizeStoryInput,
): import("@tmtp/domain").Story | undefined;
```

Runtime exports are exactly `createHnPublicApi`, `normalizeStory`, and `HnPublicApiError`. Type exports are exactly `HnPublicApi`, `HnPublicApiOptions`, `NormalizeStoryInput`, `HnPublicApiOperation`, and `HnPublicApiErrorCode`.

The item method returns the domain `HnItem`, which is itself the version-1 raw envelope: normalized fields sit beside `raw`, the original official JSON object, and `rawSchemaVersion: 1`. A domain `Story` retains that same item in `Story.raw` and repeats `rawSchemaVersion: 1` for its persisted record contract. No Firebase SDK, Undici object, Zod error, raw header, or transport stream escapes the public boundary.

`normalizeStory` is synchronous and has no network, clock, storage, or global-time dependency. This separation lets ingestion fetch an item once and normalize it with either a first-observation timestamp or a previous stored story.

## Construction and base URL

`createHnPublicApi` validates and snapshots options synchronously. Wrong types, a missing `http.request`, or an invalid base URL throw `TypeError` with a fixed field-identifying message that does not echo the supplied value. Construction starts no request and owns no transport.

`baseUrl` must be an absolute WHATWG HTTP(S) URL with a non-empty hostname, no username/password, no query, and no fragment. Both HTTPS and HTTP are accepted so the service harness can use a local official-API fake. This is a trusted service-configuration boundary, not the arbitrary-URL SSRF boundary owned by `article-fetcher`.

A trailing slash is optional and normalized to exactly one for endpoint joining. The remaining base path is preserved. For example, `https://hacker-news.firebaseio.com/v0` and the same value with a trailing slash both address the v0 API. Later mutation of the options object cannot change the base or borrowed client reference.

The default client owns no close method and never closes `http`. Separate wrappers over one HTTP client have independent immutable base URLs and per-call state.

## Official endpoints and HTTP requests

Only these official v0 resources are available:

| Operation | Feed/input | Path appended to normalized base |
|---|---|---|
| Maximum item ID | none | `maxitem.json` |
| Item | numeric ID | `item/<id>.json` |
| Top feed | `top` | `topstories.json` |
| New feed | `new` | `newstories.json` |
| Best feed | `best` | `beststories.json` |
| Ask feed | `ask` | `askstories.json` |
| Show feed | `show` | `showstories.json` |

The top endpoint can contain job IDs as documented upstream; feed IDs are not pre-classified as stories. This package does not expose unofficial HTML, `jobstories`, user profiles, updates, account state, or arbitrary endpoint paths. There is no `print=pretty`, API key, session cookie, or Firebase query option.

Each operation makes this request shape:

```ts
{
  method: "GET",
  url: fixedEndpointUrl,
  headers: { accept: "application/json" },
  redirect: "same-origin",
  maxResponseBytes: 5_000_000,
  signal: callerSignal,
}
```

`timeoutMs` is omitted so the shared client's `http.timeout_ms` total request deadline applies, including its retries and automatic same-origin redirects. `connection` and body are absent. The wrapper does not add `authorization`, `cookie`, `accept-encoding`, or caller headers.

Same-origin redirects may be followed only under `http-client`'s fixed origin and five-hop policy. Cross-origin/protocol-changing, malformed, and over-limit redirects become the corresponding typed errors below. A redirect response without a usable follow remains a non-200 response and becomes `http-status`. The final URL is never used to construct a different endpoint.

The fixed 5,000,000-byte response cap is a library bound, not a new configuration key. It bounds each buffered HTTP response before JSON parsing. The wrapper adds no independent retry, backoff, rate limiter, bulkhead, cache, or concurrency queue; independent calls may run concurrently and the shared HTTP GET policy remains the only automatic retry mechanism.

## Input validation and signal propagation

Every API method returns a Promise. Invalid operation input rejects with `HnPublicApiError("invalid-input")`; it does not throw synchronously.

- `item(id)` requires a positive safe integer. Zero, negatives, fractions, NaN, infinity, and unsafe integers are invalid.
- `feed(name)` requires exactly one of `top`, `new`, `best`, `ask`, or `show` at runtime.
- A supplied `signal` must be an `AbortSignal` for every operation.

Validation occurs before the pre-abort check and before any HTTP call. After validation, an already-aborted signal rejects with the exact `signal.reason` and performs no request. Thereafter the identical signal object is passed to `HttpClient.request`. Caller cancellation propagates unchanged through transport and retry sleeps; it is never converted to `HnPublicApiError`, `AbortError`, or `DOMException`.

JSON parsing and normalization are synchronous after the bounded response arrives, so an abort cannot interrupt those instructions in the middle of a call. The wrapper checks the signal at the post-await and post-normalization checkpoints; observed cancellation wins over a parsed result or another operation outcome. No further normalization or request begins after observed cancellation. An abort after fulfillment has no effect.

`normalizeStory` validates its complete input synchronously before deriving any fields. A non-object input, unknown input property, invalid domain item/timestamp/previous story, or a previous story whose ID differs from `item.id` throws `HnPublicApiError` with `code="invalid-input"`, `operation="normalize-story"`, and `retryable=false`. It uses `HnItemSchema`, `IsoDateTimeSchema`, and `StorySchema` at this public trust boundary rather than trusting TypeScript alone.

## HTTP and JSON response boundary

Only status `200` enters JSON processing. Every other status rejects as `http-status` with the numeric `status` and the retryability in the error table. The body is not parsed for a non-200 response.

A status-200 response must satisfy all of the following before endpoint-specific validation:

1. Exactly one `Content-Type` field has media type `application/json`, matched ASCII case-insensitively. Parameters are allowed; a `charset` parameter, if present, must be `utf-8` or `utf8` ASCII case-insensitively. Repeated charset parameters are invalid.
2. `Content-Encoding` is absent or exactly `identity`. The client does not request compressed JSON and does not decompress it. Any other or stacked coding rejects instead of passing compressed bytes to the JSON parser.
3. The complete transfer body decodes as fatal UTF-8. Empty input, malformed UTF-8, JSON syntax errors, and trailing non-whitespace content are invalid.
4. `JSON.parse` produces the exact top-level shape required by the endpoint below. There is no coercion from strings, booleans, floats, null, or empty objects.

A violation of any of these rules rejects as `invalid-response` with no partial value. Media type, charset, content coding, UTF-8, JSON syntax, and endpoint shape deliberately share this code so callers do not need to depend on parser-specific errors.

## Endpoint shapes and bounds

### Maximum item ID

`maxItemId` accepts one JSON number that is a positive safe integer and returns it unchanged. All other JSON values are `invalid-response`.

### Feeds

`feed` accepts only a JSON array of positive safe-integer IDs. It returns a fresh mutable array in official response order. It rejects duplicate IDs, non-integer/unsafe/non-positive values, nested values, and any other top-level shape.

The official list bounds are enforced after parsing:

| Feed | Maximum entries |
|---|---:|
| `top`, `new`, `best` | 500 |
| `ask`, `show` | 200 |

An empty array is valid. An over-length array is `invalid-response`; it is never silently truncated. These fixed count bounds supplement the HTTP byte bound and keep subsequent ingestion work explicit.

### Items and the version-1 raw envelope

`item` treats JSON `null` as a missing item and returns `undefined`. A non-null item must be a JSON object, not an array. Its raw object is preserved with `rawSchemaVersion: 1` and the following known fields are validated/normalized:

| Official field | Normalized field | Rule |
|---|---|---|
| `id` | `id` | Required positive safe integer; must equal the requested ID |
| `type` | `type` | Optional exact `story`, `comment`, `job`, `poll`, or `pollopt`; absence is valid only for a deleted/dead tombstone |
| `by` | `author` | Optional string; source case/content preserved |
| `time` | `time` | Optional non-negative safe integer of Unix seconds; must be representable as a JavaScript Date when multiplied by 1000 |
| `title` | `title` | Optional string; HN source HTML/text is not sanitized here |
| `url` | `url` | Optional string; empty string becomes an absent optional property, raw remains unchanged |
| `text` | `textHtml` | Optional string; remains untrusted HTML |
| `score` | `score` | Optional non-negative safe integer |
| `descendants` | `descendants` | Optional non-negative safe integer |
| `deleted` | `deleted` | Optional boolean; absent becomes `false` |
| `dead` | `dead` | Optional boolean; absent becomes `false` |

No `null`-to-absent coercion is allowed for known fields. Wrong types, invalid numbers, an ID mismatch, an unknown `type`, or a missing `type` without `deleted=true` or `dead=true` are `invalid-response`. The official documentation marks only `id` as universally required, so a type-less tombstone remains an explicit `HnItem` with `type` absent; the adapter does not invent a type for it.

Other official fields, including `parent`, `kids`, `parts`, and fields unknown to this version, do not affect normalized output. They remain in `raw` exactly as parsed so additional v0 fields are handled gracefully without widening the domain model. `raw` is a detached JSON-compatible `Record<string, unknown>`, not a reference to a caller-owned object or a serialized JSON string. `rawSchemaVersion` identifies this package's persistence/envelope contract; additive official fields do not by themselves change it.

Optional normalized properties are absent, not present with `null` or `undefined`. `deleted` and `dead` are always explicit booleans. The completed object must pass `HnItemSchema`; any boundary failure becomes `invalid-response` rather than leaking a Zod error. Returned raw/normalized structures are fresh for each call, and later mutation of one result cannot change another call's result.

A deleted or dead item with a valid known type or no type remains an explicit `HnItem`, not `undefined`. `undefined` is reserved for JSON `null`. Callers that need to inspect tombstones or non-story items use `item`; they do not infer them from a failed story normalization.

## Pure Story normalization

`normalizeStory({ item, observedAt, previous? })` converts a valid story item into a fresh domain `Story`, or returns `undefined` when no complete story can be produced without inventing data.

### Eligibility and observation fields

- A known non-story item returns `undefined`. A type-less deleted/dead item is eligible only when `previous` is supplied; its previous story supplies historical story metadata while current raw tombstone flags remain authoritative. Without previous story data it returns `undefined` rather than guessing a type or title.
- `observedAt` supplies `lastSeenAt` for a returned story.
- `firstSeenAt` is `previous.firstSeenAt` when previous is supplied, otherwise `observedAt`. The repository's upsert still owns preserving first-seen state at persistence time.
- `itemType` is `story`; `raw` is the exact current `item` value detached into the result; `rawSchemaVersion` is `1`; `deleted` and `dead` come from the current item.
- A story with usable current fields normalizes whether live, deleted, or dead. Dead/deleted state does not erase history.

For a deleted or dead story, missing current metadata may be filled from `previous` so a sparse official tombstone can update an existing record. For a live story, missing fields are not filled from previous data; an absent current optional field represents the current official state.

### Required and optional fields

`title` and publication time are required for a domain `Story`:

- Current `item.title` supplies `title` when present. Current `item.time` supplies `publishedAt` as `new Date(time * 1000).toISOString()` when present.
- Only for `deleted=true` or `dead=true`, absent title/time may fall back to `previous.title` and `previous.publishedAt`.
- If either required value is still unavailable, return `undefined`. Do not substitute observation time for publication time and do not invent a placeholder title.

For `url`, `author`, `textHtml`, `score`, and `descendants`, use the current normalized item property when present. A deleted/dead item may use the corresponding previous property when the current property is absent. Live stories use only current optional values.

`Story.url` preserves the selected source URL string. `Story.canonicalUrl` is derived independently:

1. Parse the selected URL as an absolute HTTP(S) WHATWG URL with no credentials.
2. On success, remove the fragment and use the normalized serialization.
3. On failure, or for a non-HTTP(S) or credential-bearing value, omit `canonicalUrl` while retaining `Story.url`.

No network request, redirect, tracking-parameter removal, origin canonicalization beyond WHATWG normalization, or public-suffix inference occurs. `title`, `author`, and `textHtml` remain source strings; UI escaping and article sanitization belong to downstream consumers.

### Deterministic content version

`contentVersion` is `"sha256:"` followed by the lowercase SHA-256 digest of the UTF-8 bytes of this exact canonical JSON array:

```text
JSON.stringify([
  "hn-story-content-v1",
  id,
  url ?? null,
  canonicalUrl ?? null,
  title,
  author ?? null,
  textHtml ?? null,
  publishedAt,
  deleted,
  dead
])
```

The array order, version marker, JSON string escaping, and explicit nulls are contractual. There is no trailing newline. `score`, `descendants`, `firstSeenAt`, `lastSeenAt`, and unreferenced raw-only fields do not affect the content version. Thus vote/comment-count changes and repeated observation do not force article re-extraction or recommendation recomputation, while source/reader-facing content and tombstone-state changes do.

The completed result must pass `StorySchema`; a failure caused by invalid supplied input is `invalid-input`. Returned story/raw structures are detached from `NormalizeStoryInput`, so later caller mutation cannot retroactively change a result or its content version.

## Typed deterministic errors

`HnPublicApiError` has a fixed message selected by `code`. Its `operation` is safe context and its `status` is present for `http-status` and for an upstream size/redirect error that supplies one. The class has no public `cause`, raw Zod issues, URL, response header/body, raw item, story HTML, or dependency message. Callers use `code` and `operation`, never message matching.

| Code | Fixed message | `retryable` |
|---|---|---|
| `invalid-input` | `HN public API input is invalid.` | `false` |
| `invalid-response` | `HN public API returned an invalid response.` | `false` |
| `http-status` | `HN public API returned an unsuccessful HTTP status.` | `true` only for `408`, `425`, `429`, `500`, `502`, `503`, `504` |
| `timeout` | `HN public API request timed out.` | `false` |
| `response-too-large` | `HN public API response exceeded the byte limit.` | `false` |
| `redirect-policy` | `HN public API redirect is not allowed by origin policy.` | `false` |
| `redirect-limit` | `HN public API redirect limit was exceeded.` | `false` |
| `invalid-redirect` | `HN public API redirect location is invalid.` | `false` |
| `transport` | `HN public API transport failed.` | `true` |
| `client-closed` | `HN public API HTTP client is closed.` | `false` |

`retryable` describes transport/status retry eligibility; it does not make this package add retries or prove that the current call has budget remaining. In particular, `timeout` remains `false` because the shared request's total budget is exhausted, while `transport` retains GET transport eligibility and the listed statuses remain eligible for a later independent call. `http-client` has already exhausted or declined its configured attempts before an upstream failure reaches this boundary.

Upstream `HttpError` maps by code: `invalid-request` -> `invalid-input`; `timeout` -> `timeout`; `response-too-large` -> `response-too-large`; `redirect-policy` -> `redirect-policy`; `redirect-limit` -> `redirect-limit`; `invalid-redirect` -> `invalid-redirect`; `transport` -> `transport`; and `client-closed` -> `client-closed`. Fixed messages and the public error contain no upstream cause. A final retryable HTTP status returned normally by `http-client` becomes `http-status` with `retryable=true` for the table's status set.

Caller abort reasons and unexpected failures from application-supplied domain schema refinements propagate unchanged rather than being mislabeled as official API failures. Expected JSON/schema validation failures are normalized to `invalid-response` for remote data and `invalid-input` for `normalizeStory` input.

## Concurrency, lifecycle, and security boundaries

- Every operation owns its endpoint string, signal checkpoint state, parsed JSON, and result containers. No response, raw object, feed array, story, controller, or parser state is cached or shared between calls.
- The wrapper creates no timer, abort controller, socket, subscription, worker, or background task. Its only asynchronous resource belongs to the borrowed `HttpClient`.
- The package has no `close` method. The service closes the shared HTTP client during shutdown; a subsequent call maps `client-closed` without being mistaken for caller cancellation.
- Synchronous JSON/story work is bounded by the 5,000,000-byte transfer cap, feed count checks, and current raw object size. It cannot be aborted mid-instruction, but signal checkpoints prevent returning a result after observed cancellation.
- Only fixed official API paths leave this package. There is no arbitrary URL fetch, private account mutation, cookie persistence, credential handling, Firebase realtime subscription, HTML scraping, or article-origin access.
- Raw HN title/text/unknown fields remain untrusted data. Errors never echo them, and downstream extraction/sanitization is mandatory before rendering HN self-text.

## Invariants

1. Every operation uses one fixed official endpoint, a GET request, a 5,000,000-byte cap, shared HTTP deadline/retry policy, and same-origin redirects only.
2. Input validation precedes cancellation and I/O; caller cancellation preserves exact reason identity and no abort reason is normalized into an API error.
3. Only status-200, identity-encoded, UTF-8 `application/json` responses are parsed, and every endpoint shape is validated without coercion or truncation.
4. Every non-null item carries a fresh raw JSON object and `rawSchemaVersion=1`; unknown official fields survive raw preservation while known fields remain strict.
5. Story normalization never fabricates title/publication data. Sparse deleted/dead items require previous data or yield no story, and non-story/missing values remain distinct.
6. Content versions use one canonical versioned hash input and exclude score, descendants, and observation timestamps.
7. Public errors are deterministic and safe, with no raw transport/parser cause or content, and borrowed HTTP lifecycle remains with the service.

## Acceptance-focused test expectations

Use a scripted `HttpClient` and fixed raw JSON fixtures. Tests exercise the package root, require no Firebase SDK, open no sockets, and use no real timers. Assert complete request objects and signal identity, not only returned values.

### Construction, endpoints, and transport

- `should validate and snapshot baseUrl and reject credentials query fragment non-HTTP schemes and missing HTTP methods without echoing input`.
- `should join every official endpoint exactly once for base URLs with and without trailing slashes`.
- `should map all five feed names to their official paths and reject other runtime feed values before HTTP work`.
- `should issue GET with Accept application/json same-origin redirects the fixed byte cap and no body credentials cookie or Accept-Encoding header`.
- `should inherit the shared HttpClient deadline and retry behavior without adding another sleeper retry or timer`.
- `should map every HttpError code and final retryable or non-retryable status to the documented operation error retryability and status`.
- `should reject invalid item IDs before observing a pre-aborted signal or calling HTTP`.
- `should preserve exact pre-abort in-flight and post-response cancellation reason identity and prevent a cancelled parsed result from being returned`.
- `should keep concurrent calls independent and never close the borrowed HttpClient`.

### JSON and endpoint boundaries

- `should require status 200 application/json identity encoding and valid UTF-8 before JSON parsing`.
- `should reject missing multiple or non-JSON Content-Type unsupported charset compressed invalid UTF-8 empty and malformed JSON as invalid-response`.
- `should accept only positive safe integer maxitem values`.
- `should preserve feed order accept empty lists and reject duplicates invalid IDs non-array values and over-500 or over-200 lists without truncating`.
- `should return undefined only for a null item and retain valid typed or type-less deleted and dead items as explicit values`.
- `should validate every known item field type and range and reject an ID mismatch unknown type type-less live items null known fields and unsafe numbers`.
- `should preserve unknown fields parent kids parts and exact source text in raw while exposing only normalized known properties`.
- `should default deleted and dead to false omit empty URL and other absent optionals and pass HnItemSchema for every item type`.
- `should return detached raw and normalized containers across repeated and concurrent item calls`.

### Story normalization and versions

- `should normalize a complete URL story with observed first and last timestamps current raw envelope and exact ISO publication time`.
- `should normalize Ask HN self-text without a URL and preserve title author and textHtml as untrusted source strings`.
- `should preserve previous firstSeenAt use current lastSeenAt and avoid using observation time as publication time`.
- `should return undefined for non-story items and for sparse deleted or dead stories lacking required current and previous fields`.
- `should merge a sparse deleted or dead tombstone with previous metadata while retaining current raw flags and optional current values`.
- `should preserve a type-less tombstone and merge it only with a supplied previous story without inventing a type in the raw item`.
- `should not fill missing live-story optional fields from previous data`.
- `should canonicalize only credential-free absolute HTTP and HTTPS URLs remove fragments and retain the original Story url when canonicalUrl is absent`.
- `should reject invalid normalization input invalid timestamps previous schema and previous or current ID mismatches with operation normalize-story`.
- `should match an independently computed golden sha256 contentVersion including nulls Unicode escaping and the version marker`.
- `should keep contentVersion unchanged across score descendants observation and raw-only changes and change it for each versioned source-field change`.
- `should return StorySchema-valid detached results that do not change when the input item or previous story is later mutated`.

### Error safety and WF-02 acceptance

Put unique sentinels in URLs, headers, raw HN HTML, parser errors, and `HttpError.cause`; assert that serialized public errors contain none of them. Verify that missing JSON null, non-story items, valid deleted/dead items, sparse tombstones without a previous story, and invalid responses remain distinguishable outcomes.

For WF-02, compose the public client and pure normalizer in a deterministic first-seed/refresh sequence: repeated item/observation data produces the same story content version, score-only refresh does not schedule content work by version, a failed HTTP/JSON call returns no partial story, and no cursor or storage mutation occurs inside this package.

## Internal subcomponents

- Immutable options/base URL and fixed endpoint construction.
- Shared HTTP request adapter, signal checkpoints, response-header checks, and safe HTTP error mapping.
- Bounded UTF-8/JSON decoder and endpoint-specific validators.
- Version-1 raw HnItem envelope creation and domain-schema validation.
- Pure story/tombstone normalization, URL canonicalization, and source-content hashing.

The module design and dependency flow are specified in [arch.md](arch.md). Only the API above is public.

## Dependencies on other libs

- `domain` — `HnItem`, `Story`, `HnFeed`, timestamp types, and their boundary schemas.
- `http-client` — bounded buffered GET responses, total deadlines, retries, same-origin redirects, cancellation, and typed transport failures.

Node `URL`, `TextDecoder`, JSON, and `crypto` supply platform capabilities. No direct Zod, Firebase, Undici, clock, retry, config, logging, database, or account-package dependency is added.

## New build or OSS wrapper

New client over the official HN API; no Firebase SDK required. The endpoint and field contract follows the official v0 documentation, including additive-field tolerance and the documented feed limits.

## Hosted by

`hn-ingestion` in `services/personal-reader`. Ingestion injects the shared HTTP client and observation timestamps and supplies previous stories for sparse tombstone normalization when updating existing records.

## Configuration

- `hn.api_base_url` — **optional**, default `https://hacker-news.firebaseio.com/v0`; absolute HTTP(S) base with no credentials, query, or fragment. The optional trailing slash does not change endpoint construction.

This package owns no other key. `http.timeout_ms`, `http.retry.*`, `http.user_agent`, and HTTP lifecycle remain `http-client` configuration. The 5,000,000-byte JSON cap, same-origin redirect behavior, official feed count bounds, raw schema version `1`, and content-version algorithm are fixed library contracts rather than new settings.
