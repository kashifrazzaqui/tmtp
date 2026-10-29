# Article Reader Library Spec

## Purpose and responsibility

Compose safe article fetching and pure extraction into one transport-free reading operation. Return complete, cacheable domain `Article` outcomes and explicit, safe failure metadata. Keep caching, work selection, transactions, persistence, job retries, activity, and personalization above this package.

A URL story is fetched through `article-fetcher` and then extracted. A story without a URL but with HN self-text is extracted locally through the same `article-extractor` boundary, using an HTTP(S) HN permalink as its source URL. No source HTML, including HN self-text, bypasses Readability and sanitization.

The package has no storage interface and never imports `reader-store`, `database`, `reader-app`, or `personalization`. `reader-app` persists the returned article after external work finishes; `personalization` later consumes its derived content version for scoring and queue projection.

## Public interface / API surface

The package root is `@tmtp/article-reader`. It has no default export or subpath exports.

```ts
export { ARTICLE_EXTRACTOR_VERSION } from "@tmtp/article-extractor";
export const ARTICLE_READER_VERSION: string; // `article-reader-v1:${ARTICLE_EXTRACTOR_VERSION}`

export type ArticleReaderErrorCode = "invalid-input" | "dependency-contract";

export class ArticleReaderError extends Error {
  readonly name: "ArticleReaderError";
  readonly code: ArticleReaderErrorCode;
  constructor(code: ArticleReaderErrorCode);
}

export type ArticleReadFailureCategory =
  | "fetch"
  | "unsupported-content"
  | "extraction"
  | "empty-content";

export type ArticleReadFailureCode =
  | import("@tmtp/article-fetcher").ArticleFetchErrorCode
  | import("@tmtp/article-extractor").ArticleExtractionErrorCode
  | "source-too-large";

export interface ArticleReadFailure {
  category: ArticleReadFailureCategory;
  code: ArticleReadFailureCode;
  message: string;
  retryable: boolean;
  status?: number;
}

export interface ReadyArticle extends import("@tmtp/domain").Article {
  status: "ready";
  contentHash: string;
  extractorVersion: string;
}

export interface FailedArticle extends import("@tmtp/domain").Article {
  status: "failed";
  extractorVersion: string;
  errorCode: ArticleReadFailureCode;
  errorMessage: string;
}

export interface ArticleReadyResult {
  outcome: "ready";
  article: ReadyArticle;
  originalUrl: string;
}

export interface ArticleFailedResult {
  outcome: "failed";
  article: FailedArticle;
  failure: ArticleReadFailure;
  originalUrl: string;
}

export type ArticleReadResult = ArticleReadyResult | ArticleFailedResult;

export interface ArticleReaderOptions {
  fetcher: import("@tmtp/article-fetcher").ArticleFetcher;
  maxContentChars: number;
  maxInputBytes: number;
  now: () => Date;
  extract?: typeof import("@tmtp/article-extractor").extractArticle;
}

export interface ArticleReader {
  read(
    story: import("@tmtp/domain").Story,
    signal?: AbortSignal,
  ): Promise<ArticleReadResult>;
}

export interface ArticleOriginalTarget {
  kind: "original-page" | "hn-discussion";
  url: string;
}

export function resolveArticleOriginalTarget(
  story: Pick<import("@tmtp/domain").Story, "id" | "url">,
): ArticleOriginalTarget;

export function createArticleReader(options: ArticleReaderOptions): ArticleReader;
```

Runtime exports are exactly `createArticleReader`, `resolveArticleOriginalTarget`, `ArticleReaderError`, `ARTICLE_READER_VERSION`, and the re-exported `ARTICLE_EXTRACTOR_VERSION`. Type exports are exactly the other names shown above. `ARTICLE_READER_VERSION` is the complete reader-pipeline identity `article-reader-v1:${ARTICLE_EXTRACTOR_VERSION}`. It versions both extraction and reader-owned source dispatch, self-text wrapping, and metadata mapping. Changing those reader policies requires a new `article-reader-v*` marker. `reader-app` passes this composite value to `reader-store.articles.needingContent`; the raw upstream constant remains available for provenance/contract checks without adding a direct reader-app dependency on `article-extractor`.

`resolveArticleOriginalTarget` is the single pure story-to-safe-original projection used by both article reads and cached reader-app detail. It validates a safe positive story ID and an absent-or-string URL; invalid record shape throws `ArticleReaderError("invalid-input")`. A valid credential-free absolute HTTP(S) URL returns `kind="original-page"` with its normalized fragment-free URL. A missing, malformed, credential-bearing, or non-HTTP(S) URL returns `kind="hn-discussion"` with exactly `https://news.ycombinator.com/item?id=<decimal id>`. It performs no fetch, DNS, redirect, storage, or clock work and returns a fresh object.

`originalUrl` is required on every settled outcome and equals `resolveArticleOriginalTarget(story).url`. It is never taken from a redirect target. Reader-app uses the same target's `kind` and `url` for cached/failed/pending fallback, eliminating a second URL-safety algorithm.

## Construction and immutable options

`createArticleReader` validates and snapshots its options synchronously. Construction performs no fetch, extraction, clock read, storage work, timer creation, or listener registration.

- `options` must be a non-null object with no unknown keys.
- `fetcher.fetch` and `now` must be functions. `extract`, when supplied, must be a function; omitting it uses `article-extractor.extractArticle` directly.
- `maxContentChars` is a positive safe integer and is passed unchanged to every extraction.
- `maxInputBytes` is a safe integer in `1..2_147_483_647`. It bounds the complete locally constructed HTML document for HN self-text before extraction. URL responses remain bounded by `article-fetcher`; this package does not implement a second transfer or decompression limit.
- The fetcher, clock function, and optional extraction function are borrowed. Scalar options are copied, so later mutation of the options object cannot change behavior.

Wrong runtime types throw `TypeError`; invalid numeric ranges throw `RangeError`. Construction errors are programming/configuration errors, not article outcomes.

## Read validation, snapshots, and source dispatch

`read` always returns a Promise. Invalid invocation rejects with `ArticleReaderError("invalid-input")`; it does not throw synchronously or return a failed article.

Before cancellation or I/O, the reader:

1. Requires `story` to pass `domain.StorySchema` and retains the parsed value as this call's story snapshot. Unknown keys, malformed timestamps, invalid IDs, and broken domain invariants are rejected without echoing source values.
2. Requires `signal`, when present, to be an `AbortSignal`.
3. Snapshots the exact validated `story.contentVersion`, story ID, source fields, title, and text used by this attempt. Later caller mutation cannot change provenance or mix two story versions into one result.
4. Observes pre-cancellation. An already-aborted signal rejects with the exact `signal.reason` before fetching, extraction, HTML construction, or a clock read.

Dispatch is deterministic:

| Story shape | Operation |
|---|---|
| `url` is present | Fetch that exact string through `article-fetcher`; a present `textHtml` does not create a second or fallback source. |
| `url` is absent and `textHtml` is present | Extract a locally wrapped self-text document; perform no article network request. |
| Both are absent | Return an `empty-content` failure without fetching or invoking the extractor. |

URL presence, not truthiness, selects the URL path. Thus an empty or malformed URL produces the fetcher's typed URL failure rather than silently treating the story as self-text. A URL fetch or extraction failure never falls back to `textHtml`; substituting different source content would misrepresent the attempt. Deleted/dead flags do not erase a readable story or change dispatch.

## URL story composition

For a URL story, call exactly once:

```ts
fetcher.fetch(story.url, signal); // signal property is the identical caller object when supplied
```

The fetcher owns URL normalization, protocol/port policy, DNS and address checks, connection pinning, manual redirects, deadlines, GET retries, media/charset checks, transfer and decoded byte limits, and safe fetch errors. The reader adds no proxy, credentials, headers, retry loop, timeout, redirect handling, or direct `http-client` call.

After a successful fetch and a cancellation checkpoint, call the configured extraction function exactly once:

```ts
extract({
  html: fetched.html,
  sourceUrl: fetched.finalUrl,
  maxContentChars,
});
```

`finalUrl` is the extraction base so relative links in the final document resolve against the page that supplied the markup. `fetched.sourceUrl` remains the original request provenance. The reader performs no HTML parsing or sanitization of its own.

A ready URL result maps as follows:

- `storyId=story.id`, `status="ready"`, and `sourceContentVersion` equal to the exact snapshotted `story.contentVersion`;
- `sourceUrl=fetched.sourceUrl`, `finalUrl=fetched.finalUrl`, and `fetchedAt=fetched.fetchedAt` unchanged;
- `title=extracted.title ?? story.title`; the HN title is only a title fallback;
- `byline=extracted.byline` and `excerpt=extracted.excerpt` when present; never treat the HN submitter as the external article's byline;
- `textContent=extracted.text`, `sanitizedHtml=extracted.sanitizedHtml`, and `contentHash=extracted.contentHash` unchanged; `extractorVersion=ARTICLE_READER_VERSION`, while the extracted raw version must equal the currently imported `ARTICLE_EXTRACTOR_VERSION` before the composite is assigned;
- `updatedAt` from the injected clock function and derived `contentVersion` as specified below;
- no `errorCode` or `errorMessage` properties.

`originalUrl` is the independently normalized, credential-free, fragment-free original `story.url`, not `finalUrl`.

## HN self-text composition

The HN permalink is exactly:

```text
https://news.ycombinator.com/item?id=<decimal story.id>
```

The ID is the validated safe positive integer serialized in base 10. The permalink is a fixed HTTPS URL generated by the reader; it is not fetched and is not configurable through an untrusted story field.

Wrap `story.textHtml` in one minimal inert-input document whose body contains one `article` element. The wrapper supplies document structure for Readability and contains no source-provided title, author, script, stylesheet, base element, or resource attribute. The raw self-text is inserted only as the article element's HTML content because it must remain subject to the extractor's complete inert parsing, dangerous-subtree removal, sanitization, URL checks, and text derivation. Do not concatenate the story title or author into this markup.

Before calling the extractor, measure the UTF-8 byte length of the **complete wrapped document**. If it exceeds `maxInputBytes`, return a `source-too-large` extraction failure without invoking the extractor. Exactly-at-limit input is eligible. The check needs no second full HTML buffer and does not truncate source markup to fit.

Otherwise call:

```ts
extract({
  html: wrappedSelfTextDocument,
  sourceUrl: hnPermalink,
  maxContentChars,
});
```

A ready self-text result uses the same content/metadata mapping as a URL result, except:

- `sourceUrl=hnPermalink`;
- `finalUrl` and `fetchedAt` are absent because no article fetch occurred;
- `originalUrl=hnPermalink`.

An absent `textHtml` with no URL produces `empty-content`; whitespace-only or markup-only self-text goes through the extractor and normally produces the same code. The self-text failure `sourceUrl` and `originalUrl` remain the HN permalink so the reader can open the discussion even when embedded extraction fails.

## Terminal article construction and versioning

Every returned `Article`, whether ready or failed, satisfies all of these invariants:

1. `storyId` is the snapshotted story ID.
2. `sourceContentVersion` is exactly the `Story.contentVersion` supplied to this attempt, with no recomputation or use of a newer mutable story object.
3. `contentVersion` is computed by calling `domain.articleContentVersion` on that terminal article's other fields, then assigning the helper's exact return value to the same article. No local hash, projection, prefix, or status-specific version rule is duplicated.
4. The completed record passes `domain.ArticleSchema`, including `contentVersion === domain.articleContentVersion(article)`.
5. `updatedAt` is obtained once for the terminal outcome from `now().toISOString()`, yielding ISO-8601 UTC with `Z` and millisecond precision.
6. `extractorVersion=ARTICLE_READER_VERSION` on both ready and failed records. On failure it is attempted-pipeline provenance only; it does not claim successful extraction or enter the failed status's derived content version.

The helper is called after status, metadata, content hash, and extractor version are final. For ready articles this versions the exact recommendation-input projection. For failed articles it versions the failed status only, as defined by domain. `sourceContentVersion` and `updatedAt` do not enter the derived article version; the story version already participates independently in recommendation identity.

A failed article is a fresh terminal record, not a mutation of an earlier ready article. It always includes `errorCode`, the fixed safe `errorMessage`, and attempted `extractorVersion=ARTICLE_READER_VERSION`, and omits `title`, `byline`, `excerpt`, `textContent`, `sanitizedHtml`, and `contentHash`. This prevents stale content from entering later prompts while allowing a later reader-pipeline version to make the attempt eligible again. Provenance is retained only when known:

- a fetch rejection may include the normalized original `sourceUrl`, but has no `finalUrl` or `fetchedAt`;
- an extraction/size failure after a successful fetch retains `sourceUrl`, `finalUrl`, and `fetchedAt` from that fetch;
- every self-text outcome retains the HN permalink as `sourceUrl`, with no fetch timestamp or final URL.

An invalid `Date` or non-`Date` clock result, a nonconforming dependency result, or failure of the reader's own final domain validation rejects with `ArticleReaderError("dependency-contract")` instead of returning a malformed article. A successful extraction whose `extractorVersion` differs from the currently imported constant is nonconforming; it must not produce an immediately stale ready article. Exceptions thrown by an injected clock function itself are infrastructure failures and propagate unchanged.

## Original-page fallback and URL safety

For a URL story, normalize `story.url` with the platform WHATWG parser, require absolute HTTP(S), a non-empty hostname, and no username/password, and remove the fragment. This local projection is used for `originalUrl` and, on a pre-fetch failure, `sourceUrl`; it does not replace fetcher policy or perform DNS.

If that projection fails, omit `sourceUrl` on the failed article and use the fixed HN permalink for `originalUrl`. Never return `javascript:`, `data:`, `file:`, credential-bearing, malformed, or other unsafe source strings as a fallback. A final redirect URL may be persisted as provenance after a successful fetch but is not substituted for `originalUrl`.

The returned `sanitizedHtml` is body markup under `article-extractor`'s allowlist only. The reader adds no markup and no trust exception for HN. The service remains responsible for its reader CSP, and original-page navigation remains a user action rather than an automatic fetch or redirect.

## Expected failure mapping

Expected `ArticleFetchError` and `ArticleExtractionError` values become `ArticleFailedResult`; they do not reject the read Promise. `failure.code` preserves the upstream code. `failure.message` and `article.errorMessage` are the same reader-owned fixed message selected by code, not an upstream or parser message. `article.errorCode` equals `failure.code`.

`retryable` is advice for a later independent job. It does not start another fetch or extraction in this call. Fetch retries have already finished inside `article-fetcher`/`http-client`. Extraction and local input failures are never retryable merely because a later code version might behave differently.

| Code | Category | Fixed message | `retryable` |
|---|---|---|---|
| `invalid-url` | `fetch` | `Article URL is invalid.` | `false` |
| `invalid-request` | `fetch` | `Article HTTP request is invalid.` | `false` |
| `url-policy` | `fetch` | `Article URL is not allowed by policy.` | `false` |
| `dns-timeout` | `fetch` | `Article DNS resolution timed out.` | `true` |
| `dns-failed` | `fetch` | `Article DNS resolution failed.` | `true` |
| `address-policy` | `fetch` | `Article address is not globally routable.` | `false` |
| `timeout` | `fetch` | `Article fetch timed out.` | `true` |
| `response-too-large` | `fetch` | `Article response exceeded a byte limit.` | `false` |
| `redirect-limit` | `fetch` | `Article redirect limit was exceeded.` | `false` |
| `invalid-redirect` | `fetch` | `Article redirect location is invalid.` | `false` |
| `http-status` | `fetch` | `Article origin returned an unsuccessful HTTP status.` | `true` only for `408`, `425`, `429`, `500`, `502`, `503`, `504` |
| `unsupported-content-type` | `unsupported-content` | `Article response is not a supported HTML media type.` | `false` |
| `unsupported-charset` | `unsupported-content` | `Article response charset is not supported.` | `false` |
| `unsupported-content-encoding` | `unsupported-content` | `Article content encoding is not supported.` | `false` |
| `invalid-content-encoding` | `unsupported-content` | `Article content encoding is invalid.` | `false` |
| `invalid-text` | `unsupported-content` | `Article response is not valid UTF-8 text.` | `false` |
| `transport` | `fetch` | `Article HTTP transport failed.` | `true` |
| `client-closed` | `fetch` | `Article HTTP client is closed.` | `false` |
| `invalid-input` | `extraction` | `Article extraction input is invalid.` | `false` |
| `empty-content` | `empty-content` | `Article has no readable content.` | `false` |
| `extraction-failed` | `extraction` | `Article extraction failed.` | `false` |
| `source-too-large` | `extraction` | `Article source exceeded the local input limit.` | `false` |

`failure.status` is present for `http-status` and for `response-too-large` when the fetcher supplies a numeric response status; otherwise it is absent. It is safe numeric metadata and is not copied into the domain article, whose current schema has no status field.

`ArticleReaderError` has fixed messages: `Article reader input is invalid.` for `invalid-input`, and `Article reader dependency violated its contract.` for `dependency-contract`. It has no public `cause`, URL, story content, dependency message, or parser issues.

Unexpected infrastructure/programming exceptions from borrowed dependencies propagate unchanged rather than being mislabeled as remote article failures. Only the expected typed dependency errors above become failed articles. No package logging is added; callers log only safe codes, category, retryability, optional numeric status, story ID, and their own redacted correlation metadata.

## Cancellation, concurrency, and lifecycle

- Validation wins over pre-cancellation. After validation, an observed caller abort rejects with the exact `signal.reason`, preserving object or primitive identity. Cancellation is not converted into an `ArticleFailedResult`, `ArticleReaderError`, `ArticleFetchError`, or `DOMException`.
- Check cancellation before fetch, after fetch settlement and before extraction, after synchronous extraction returns or throws, and before terminal clock/version/result construction. At a settlement checkpoint, observed cancellation wins over the fetched/extracted outcome or expected typed failure.
- The exact caller signal reaches `fetcher.fetch`. The reader creates no replacement signal, overall timeout, abort listener, timer, or retry wait. Fetcher-owned cancellation and cleanup remain authoritative during network work.
- `article-extractor` is synchronous. An abort cannot interrupt CPU work already running on that JavaScript thread, but the post-extraction checkpoint prevents a result or expected extraction failure from being returned after cancellation is observed. Input bounds limit this non-preemptible work.
- After cancellation or any other settlement, the reader starts no new stage and owns no outstanding resource. It never closes the borrowed fetcher, HTTP client, extractor, or clock.
- Each call owns its story snapshot, source document, dependency results, failure projection, and article. Concurrent calls share only immutable options and borrowed dependencies. There is no module-global cache, in-flight dedupe, queue, lock, or mutable DOM.
- The reader deliberately permits concurrent calls for the same story. Work dedupe and stale-write prevention are application/store responsibilities; a local in-package lock could not coordinate durable writers.
- `ArticleReader` has no `close` method. Service shutdown cancels active jobs, observes its grace period, and closes the shared HTTP client through the owning composition.

## Re-extraction and persistence composition

`read` always performs the requested attempt. It does not decide freshness because it receives no existing article and has no storage access.

Upstream work selection uses `reader-store.articles.needingContent` with `extractorVersion=ARTICLE_READER_VERSION`. That query includes URL and self-text stories whose article is absent/pending, whose `article.sourceContentVersion` differs from the current `story.contentVersion`, or whose ready/failed article's stored attempted `extractorVersion` differs from the current composite reader version. Thus extractor or reader-composition upgrades can invalidate otherwise unchanged content or retry an old terminal failure, while score-only HN changes need not cause extraction. A terminal failed article from the current pipeline is not selected again merely because it failed; its active durable job owns retry/backoff, and a later source/pipeline change makes it eligible again.

`reader-app` owns the durable boundary:

1. Read the current story and select work outside a transaction.
2. Call `articleReader.read` with no open store transaction. Fetching, DNS, decoding, and extraction must never run inside SQLite work.
3. Persist through the store's conditional article upsert in a short transaction. The store compares `sourceContentVersion` with the current story inside that transaction, validates both article versions, and performs article-version-driven queue invalidation only for an applied write.
4. Treat `stale-source` as a discarded outdated attempt with no failure article or queue write; normal work selection can schedule the current story version. Treat `applied` as the durable outcome.
5. Use `failure.retryable` only for the current job's retry decision. Cancellation rejects the job attempt without saving a synthetic failed article.
6. Let `personalization` perform later scoring/queue work from stored story/article versions. Do not call an LLM or persist recommendations inside `article-reader`.

The package makes no exactly-once claim. It returns precise attempt provenance so the store can make the atomic stale-write decision.

## Internal subcomponents

- Construction/read validation and immutable per-call story snapshots.
- URL/self-text dispatch, HN permalink construction, and safe original-URL projection.
- Fetch/extract composition and local self-text document/input-size boundary.
- Terminal ready/failed article assembly, timestamping, and domain-derived versioning.
- Safe failure classification, cancellation checkpoints, and dependency-contract checks.

The module design and dependency flow are specified in [arch.md](arch.md). These modules are private implementation details; only the API above is public.

## Dependencies on other libs

- `article-extractor` — inert Readability transformation, sanitization, content hash, and current extractor version.
- `article-fetcher` — the only arbitrary-article network path and all fetch/security policy.
- `domain` — `Story`/`Article` schemas, records, and the single `articleContentVersion` implementation.

No other workspace or third-party dependency is added. Platform `URL`, UTF-8 byte measurement, and the injected `() => Date` capability do not create package dependencies. In particular, this package must not import `http-client`, `clock`, `config`, `reader-store`, `database`, `job-queue`, `recommendations`, `reader-app`, `personalization`, logging, or service code.

## New build or OSS wrapper

New TypeScript composition over the three existing workspace packages. No additional third-party library is required.

## Hosted by

`reader-app` article jobs and story queries in `services/personal-reader`. The service supplies the constructed fetcher, `systemClock.now` as `now`, and validated article limits. Reader-app/store/personalization own all durable effects.

## Configuration

The reader reads no configuration source directly and adds no configuration key.

| Existing key | Reader option | Required / default and use |
|---|---|---|
| `article.max_content_chars` | `maxContentChars` | Optional at service layer, default `500000`; positive safe integer passed to the extractor |
| `article.max_response_bytes` | `maxInputBytes` | Optional at service layer, default `5000000`; safe integer `1..2_147_483_647`, also bounds the complete local self-text HTML document |

`article.timeout_ms`, DNS, redirect, protocol/port, transfer/decoded-size, HTTP retry, and User-Agent policy remain with `article-fetcher`/`http-client`. There is no reader-specific retry, concurrency, HN-base-URL, cache, storage, or timeout setting. Reusing `article.max_response_bytes` for local extraction input avoids a second operator-controlled source-size policy; it does not relax the fetcher's independent transfer and decoded-body checks.

## Acceptance-focused test expectations

Tests exercise the public package root with a scripted `ArticleFetcher`, fixed `now`, and deterministic optional `extract` seam. Security and workflow tests also use the real `article-extractor`; no test replaces its sanitizer when asserting safe markup.

### Construction, validation, and result shape

- `should reject unknown or malformed options and invalid numeric ranges before any dependency work`.
- `should snapshot scalar options and reject malformed stories or signals before cancellation fetch extraction and clock reads`.
- `should return only discriminated ready or failed outcomes with required originalUrl and no optional article failure ambiguity`.
- `should validate every returned article with ArticleSchema and independently recompute its contentVersion with domain.articleContentVersion`.
- `should preserve the exact input story contentVersion on every ready fetch failure extraction failure empty and oversized outcome`.
- `should omit stale content metadata and hash from every failed article while retaining attempted composite reader version and only known source provenance`.
- `should snapshot the story so caller mutation during a pending fetch cannot change the returned source fields or versions`.

### URL stories and success mapping

- `should call fetcher once with the exact story URL and identical caller signal then extract fetched HTML against finalUrl and maxContentChars`.
- `should map fetched source final and timestamp provenance plus extracted metadata and content hash unchanged while assigning the composite ARTICLE_READER_VERSION`.
- `should use extracted title first and story title only as fallback without mapping the HN submitter to external byline`.
- `should retain the normalized original URL as originalUrl rather than a redirect final URL`.
- `should share one pure original-target projection for valid HTTP(S) and discussion fallback cases without network storage or unsafe URL passthrough`.
- `should not extract self-text or issue a second fetch when a URL story also has textHtml or when its URL attempt fails`.
- `should prove URL story failures preserve the original-page fallback for fetch and extraction errors`.

### HN self-text and local limits

- `should extract self-text without calling the fetcher and use the exact HTTPS HN permalink as sourceUrl and originalUrl`.
- `should wrap self-text in one article document without injecting story title author or active wrapper content`.
- `should pass raw HN markup through the real inert Readability and sanitizer path and return no unsanitized source HTML`.
- `should omit finalUrl and fetchedAt for self-text while applying the same content mapping and domain versioning as URL stories`.
- `should accept exactly-at-limit wrapped UTF-8 input and reject the first excess byte as source-too-large before extractor invocation`.
- `should map absent whitespace-only markup-only and sanitizer-emptied self-text to empty-content with an HN discussion fallback`.
- `should resolve self-text links against the HN permalink and remove unsafe schemes through the real extractor`.

### Failure safety and dependency boundaries

- `should map every ArticleFetchError code and ArticleExtractionError code to the documented category fixed message retryability and optional status`.
- `should preserve fetch provenance after successful fetch followed by extraction failure and omit unknown final provenance after fetch rejection`.
- `should use the HN permalink instead of returning malformed credential-bearing or non-HTTP original URLs`.
- `should keep failure messages ArticleReaderError values and serialized safe fields free of URL HTML text parser and dependency sentinels`.
- `should reject malformed dependency success values invalid clock results and final domain invariant failures as dependency-contract without returning partial articles`.
- `should propagate unexpected infrastructure exceptions unchanged and never turn them into retryable remote failures`.

### Cancellation, concurrency, and lifecycle

- `should reject a pre-aborted read with the exact reason after validation and before any source or clock work`.
- `should preserve object and primitive abort reasons across in-flight fetch and post-fetch post-extraction checkpoints`.
- `should prefer observed cancellation over a simultaneous fetched result or expected typed failure and create no failed article or updatedAt timestamp`.
- `should prevent extraction after cancelled fetch settlement and prevent terminal result construction after cancelled synchronous extraction`.
- `should isolate interleaved URL and self-text calls including independent story versions signals documents and output records`.
- `should create no reader-owned timer listener retry or close operation and never close borrowed dependencies`.

### Re-extraction, dependency, and workflow acceptance

- `should expose the exact upstream ARTICLE_EXTRACTOR_VERSION and composite ARTICLE_READER_VERSION and use the composite for reader-store needingContent selection`.
- `should require a reader-version bump when self-text wrapping source dispatch or metadata mapping changes so prior ready content becomes extraction-eligible`.
- `should keep package imports and the manifest limited to article-extractor article-fetcher and domain with no storage import`.
- An upstream integration test must prove `needingContent` selects absent/pending articles, changed `sourceContentVersion`, and stale ready `extractorVersion`, then persists each reader outcome with a valid derived version. That durability test belongs to reader-app/store, not this storage-free package.
- For WF-04, compose the real extractor with a scripted fetcher for a ready external article, a failed fetch, and safe HN self-text. Assert sanitized embedded content, original/HN fallback, exact story provenance, and no reader-owned persistence or transaction.
- For WF-02/WF-03/WF-07, prove at the composition boundary that external calls finish before a short upsert transaction and that personalization sees the stored article's exact domain-derived version after ready/failed transitions and extractor upgrades.
