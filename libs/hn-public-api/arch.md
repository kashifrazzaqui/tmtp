# Hacker News Public API Architecture

## Architectural role

`hn-public-api` is a tier-2 ESM adapter over `@tmtp/http-client` and `@tmtp/domain`. It has two deliberately separate paths:

1. an asynchronous official-API transport/JSON path returning scalars, feed IDs, or versioned raw `HnItem` envelopes;
2. a synchronous pure normalization path producing a domain `Story` from a valid item, an observation timestamp, and optional previous story.

Keeping these paths separate avoids a clock dependency, prevents hidden storage access, and lets `hn-ingestion` merge sparse tombstones with a previous record after one item fetch. The package never owns cursors, transactions, schedules, or private HN state.

```text
hn-ingestion
  -> hn-public-api
       -> fixed endpoint + HTTP/JSON adapter -> http-client
       -> raw item validator/envelope        -> domain schemas
       -> pure Story normalizer              -> domain schemas + node:crypto
```

The package root exports only the documented factory, pure normalizer, error class, and types. There are no public parser helpers, endpoint builders, Firebase types, or package subpaths.

## Internal module decomposition

| Module | Responsibility | Important collaborators |
|---|---|---|
| `index` | Public exports, operation dispatch, cancellation checkpoints | All internal stages |
| `options` | Immutable construction validation and normalized base URL | Platform `URL` |
| `endpoints` | Fixed operation-to-path mapping and positive-ID encoding | No network dependency |
| `http` | Common GET request, status/header boundary, HTTP error mapping | `HttpClient`, safe errors |
| `json` | Fatal UTF-8 decode, JSON parse, top-level shape dispatch | Bounded `Uint8Array` |
| `feeds` | Max-item/feed scalar and ordered-array validation | Fixed count bounds |
| `items` | Known-field validation, unknown-field raw preservation, version-1 envelope | `HnItemSchema` |
| `stories` | Pure current/previous merge, URL canonicalization, observation fields | `StorySchema`, `IsoDateTimeSchema` |
| `version` | Canonical story-content array and SHA-256 projection | `node:crypto` |
| `errors` | Fixed safe error construction and operation context | No raw dependency errors |

The common HTTP/JSON path is shared by all three methods. The raw-item parser is the only official field mapping. The Story normalizer consumes its output but does not perform I/O. This avoids duplicate `by`/`text`/timestamp mappings and prevents feed/max-item logic from acquiring story policy.

## Construction and endpoint snapshots

Validate `baseUrl` once with WHATWG `URL`. Reject credentials, query, fragment, and non-HTTP(S) schemes. Clone the normalized value and ensure its pathname has one trailing slash. Save the serialized base prefix and the borrowed `HttpClient` reference in the closure.

The endpoint module is a fixed table, not a URL passthrough:

```text
max-item       -> maxitem.json
item(id)       -> item/<decimal-id>.json
feed(top)      -> topstories.json
feed(new)      -> newstories.json
feed(best)     -> beststories.json
feed(ask)      -> askstories.json
feed(show)     -> showstories.json
```

Validate an item ID before converting it to decimal text. Join the fixed suffix to the saved base; no caller string becomes a path segment, query parameter, or arbitrary resource. Base path prefixes such as `/v0` therefore remain intact for both real and fake services.

## Common HTTP/JSON pipeline

Each public operation follows the same pipeline:

```text
validate operation input
  -> reject pre-abort with identical reason
  -> fixed HttpClient GET
  -> cancellation checkpoint
  -> require status 200
  -> require JSON Content-Type / UTF-8 charset / identity Content-Encoding
  -> fatal UTF-8 decode
  -> JSON.parse
  -> endpoint-specific validation and detached result
  -> cancellation checkpoint
  -> return
```

The request has `redirect: "same-origin"`, `maxResponseBytes: 5_000_000`, no body or pin, the caller signal, and only `accept: application/json`. It omits `timeoutMs` so the shared HTTP policy applies once across transport attempts and redirects. No new sleep or retry call exists here.

`http-client` returns a fully buffered response and normalized lower-case header arrays. Inspect status before media/coding or JSON work. Require exactly one JSON Content-Type value, permit parameters, and validate any charset without locale-dependent conversion. Reject every non-identity Content-Encoding; this adapter does not send Accept-Encoding or invoke zlib.

Decode with `TextDecoder("utf-8", { fatal: true })`, then call `JSON.parse` without a reviver. All expected header, text, syntax, and shape failures enter the private invalid-response boundary. Never copy raw decoder/JSON/Zod messages to the public error.

Synchronous parsing cannot be preempted. The signal checkpoints before and after it establish deterministic observable behavior without claiming mid-instruction cancellation. The 5 MB cap and endpoint count checks bound this work.

## Scalar and feed validators

`max-item` requires one positive safe integer. Return the number directly; no cursor is created or persisted.

The feed validator requires an array, validates every element as a positive safe integer, rejects duplicates with a `Set`, preserves input order, and checks the exact operation-specific maximum length. It returns a fresh array. The top feed remains only a list of item IDs even though upstream documents that it can contain jobs; classification happens only when each item is fetched.

Over-limit arrays fail rather than being sliced. This makes an upstream contract change visible and prevents silent loss of collection work.

## Raw HnItem boundary

### Preserve first, normalize second

After JSON parse, distinguish `null` from an object. `null` returns `undefined`; an array/scalar is invalid. For a non-null object:

1. Retain the complete JSON object as the raw value for version 1.
2. Validate only the known normalized fields against the strict table in `spec.md`.
3. Require the item ID to equal the requested ID; require a known `type` when present and permit its absence only for deleted/dead tombstones.
4. Map `by -> author`, `text -> textHtml`, and defaults for absent `deleted`/`dead`.
5. Omit absent optional normalized properties and convert only empty `url` to absence.
6. Assemble the exact domain `HnItem` shape with `raw` and `rawSchemaVersion: 1`.
7. Validate the assembled object with `HnItemSchema` and return a detached result.

Unknown fields are not copied into top-level normalized properties and are not rejected merely for being unknown. They remain inside `raw`, satisfying the official API's additive-field compatibility rule without making domain strictness impossible.

The implementation must not depend on a Zod version's object-cloning behavior for detachment. Use an explicit JSON-value clone for raw input at the package boundary and fresh normalized/result objects. JSON parse already excludes functions, `undefined`, Dates, and class instances; preserve those JSON values rather than coercing them.

### Sparse official items

The official documentation marks only `id` as universally required, and domain `HnItem.type` is therefore optional. A type-less deleted/dead item stays an explicit raw tombstone without inventing `type`. Story normalization uses it only when a previous story can supply the historical story metadata; otherwise it returns `undefined`. Typed and type-less sparse cases have separate tests.

## Pure Story normalization

### Input and current/previous selection

`normalizeStory` is one synchronous public trust boundary. Validate the exact input envelope, the item, the ISO observation timestamp, and any previous story with domain schemas. Require matching item/previous IDs. Work on detached snapshots so subsequent caller mutation cannot alter output or version computation.

A non-story returns `undefined` after validation. For a story, select fields in this order:

| Field | Live story | Deleted/dead story |
|---|---|---|
| `title` | current, required | current, else previous, else no result |
| `publishedAt` | current `time`, required | current `time`, else previous, else no result |
| `url`, `author`, `textHtml`, `score`, `descendants` | current only | current, else previous |
| `firstSeenAt` | previous value when supplied, else `observedAt` | same |
| `lastSeenAt` | `observedAt` | `observedAt` |
| `deleted`, `dead`, `raw` | current item | current item |

The previous record is never a general overlay for live data. It exists to preserve historical display/publication fields across sparse tombstones and to retain first-seen provenance. Missing required values after this selection return `undefined`; no placeholder title or observation-derived publication timestamp is generated.

Convert current Unix seconds with `new Date(time * 1000).toISOString()`. The item boundary has already constrained the number to safe Date representation. `raw` is the current complete `HnItem`, not the previous raw item or only the raw JSON object. Both Story and item raw schema versions remain literal `1`.

### URL projection

Preserve the selected source string as `Story.url`. Independently attempt to construct `canonicalUrl` from an absolute credential-free HTTP(S) URL. Remove the fragment and use the platform's normalized serialization. A non-HTTP(S), malformed, or credential-bearing source produces no canonical URL but does not erase the source value.

This projection performs no fetch, DNS resolution, redirect, tracking-rule processing, or extraction. Article fetching later applies its own much stronger policy.

### Content version

Build one JavaScript array in the exact order documented in `spec.md`, using `null` for absent optional values. Serialize it once with `JSON.stringify` and hash the UTF-8 bytes using `node:crypto` SHA-256. Prefix the lowercase hex digest with `sha256:`.

The array begins with `hn-story-content-v1`, so a future algorithm change must use a new marker and migration policy rather than silently reinterpreting old versions. Score, descendants, observation timestamps, and raw-only fields are absent from the array. Current/previous merge happens before hashing, so the hash covers exactly the normalized reader-facing values and tombstone flags that are returned.

Validate the completed story with `StorySchema`. Return fresh objects and arrays; no input reference is retained. This is a pure operation with no `Date.now`, random ID, network, storage, or logger call.

## Error and cancellation boundary

Keep a private operation tag (`max-item`, `item`, or `feed`) through the HTTP/JSON pipeline so all expected failures receive the correct safe context. `normalize-story` is used only by the pure function.

At the outer asynchronous boundary:

1. If the caller signal is aborted, throw its exact reason.
2. If the result is a non-200 response, throw `http-status` using the fixed retryable-status set.
3. Map an `HttpError` by its documented code and discard its cause/message from the public projection.
4. Map expected response parsing/schema failures to `invalid-response`.
5. Return the successful detached value.

Do not feed returned HTTP statuses back into another retry mechanism; `http-client` has already applied its policy. Unexpected exceptions from application-provided schema refinements propagate rather than being rewritten as remote data failures. Fixed public messages contain no endpoint URL, raw item, feed, JSON, HTML, header, or dependency error text.

## Concurrency and lifecycle

The constructed client contains only immutable base configuration and the borrowed HTTP reference. Every operation has local parsed values and result containers. Concurrent item/feed/max-item calls can therefore interleave safely, including concurrent calls to the pure normalizer.

No module-level cache exists for maxitem, feeds, items, raw objects, content versions, or previous stories. A caller requiring caching or throttling must implement it in a higher component with its own freshness and lifecycle contract.

The wrapper creates no controllers or timers of its own. `HttpClient` owns request cancellation/deadline resources and is closed by the service. During shutdown, ingestion cancels its operation signals and the service later closes HTTP according to the upstream drain contract. This package has no independent close operation.

## Trade-offs

- **Pure Story normalizer instead of a story-fetching method:** ingestion must pass observation/previous data explicitly, but the API avoids a clock/store dependency and duplicate item requests.
- **Strict known fields plus additive raw preservation:** malformed known data is visible while new official fields and type-less tombstones remain durable. Type-less live items are rejected because their kind cannot be established safely.
- **Previous data only for tombstones:** this preserves history without allowing stale metadata to overwrite a live refresh. Ingestion must retrieve previous records for that refresh path.
- **No compressed JSON:** accepting only identity keeps the transport/parser boundary small and avoids another decoded-size policy. The official default base URL and fixed byte cap make this adequate for the intended API; a future compression decision would need explicit transfer/decoded limits like article-fetcher's.
- **Fixed response/feed bounds:** these make memory and downstream work predictable but intentionally reject an upstream response that exceeds documented limits rather than truncating it.
- **Observation-independent content hash:** score/comment updates do not trigger article/recommendation work, while reader-facing source changes do. Raw-only changes remain available for diagnostics without forcing recomputation.
- **No local rate limiter or cache:** concurrent ingestion remains simple and deterministic. Any future quota policy requires an explicit owner rather than hidden mutable state here.

## Testing seams and verification design

Test through the public package root. No private validator or hashing helper needs a test-only export.

### Deterministic HTTP harness

A scripted `HttpClient` records the complete request and returns fresh `HttpResponse` objects or rejects with each `HttpError`. Build response bodies with explicit UTF-8 and compressed-byte fixtures. Use header arrays to exercise duplicate Content-Type/Content-Encoding and same-origin redirect outcomes.

Use custom objects and primitive values as abort reasons. The fake client can capture the exact signal, abort in flight, or complete while the signal is already aborted to verify checkpoints. No real timers, DNS, Firebase, or external network are needed.

Table-drive:

- base URL and all endpoint mappings;
- operation input validation and pre-abort priority;
- every status/error mapping and safe fixed message;
- content media/coding/UTF-8/JSON boundaries;
- max-item numeric limits;
- feed order, duplicates, invalid IDs, empty and exact/over count limits;
- every item known-field type/range/default and unknown-field raw preservation.

Assert that all errors contain only their fixed safe fields and that repeated/concurrent responses do not share mutable arrays or raw objects.

### Normalization and golden fixtures

Use checked-in official-shaped fixtures for URL stories, Ask HN self-text, each non-story type, deleted/dead typed tombstones, and sparse tombstones with/without previous data. Assert exact Story objects, observation timestamps, raw envelopes, canonical URLs, and schema success.

Independently compute at least one golden content-version digest from the documented JSON array. Then vary each included field individually and each excluded field (`score`, `descendants`, observations, raw-only metadata) to prove the version boundary. Mutate input objects after normalization and verify the returned story and version remain unchanged.

### WF-02 composition evidence

Compose the fake HTTP client, raw item parser, and pure normalizer in first-seed and refresh scenarios. Prove that no cursor/storage side effect occurs here, transient failures return no partial story, score-only changes preserve content version, and sparse tombstones either merge with supplied previous data or return no story without fabricating fields. The ingestion package remains responsible for durable cursor/upsert atomicity tests.
