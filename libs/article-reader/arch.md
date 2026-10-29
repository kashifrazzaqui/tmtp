# Article Reader Architecture

## Architectural role and dependency direction

`article-reader` is a tier-3 ESM composition over `article-fetcher`, `article-extractor`, and `domain`. It converts one validated story snapshot into one terminal domain article or rejects for cancellation/invalid infrastructure. It contains no transport, HTML parser, sanitizer, storage, transaction, job queue, recommendation, or application HTTP code.

```text
services/personal-reader
  -> reader-app
       -> article-reader
       |    -> article-fetcher -> http-client / clock / DNS / pinned HTTP
       |    -> article-extractor -> inert jsdom / Readability / DOMPurify
       |    -> domain -> StorySchema / ArticleSchema / articleContentVersion
       -> reader-store -> short result transaction
       -> personalization -> recommendations / queue transactions
```

The reader returns outcomes upward. It does not accept a repository, open a transaction, invoke personalization, or hide a storage write behind `read`. The manifest and public API retain exactly the three declared workspace dependencies.

## Internal module decomposition

These modules are private organizational units, not public subpaths or additional workspace libraries.

| Module | Owns | Important collaborators / exclusions |
|---|---|---|
| `index` | Exact public exports and `createArticleReader`/`read` pipeline | Exports the raw extractor and composite reader constants plus public types |
| `options` | Strict construction checks, scalar snapshots, borrowed dependency references | No I/O, default clock, or environment access |
| `input` | `StorySchema`/`AbortSignal` checks and detached per-read story snapshot | Domain; no fetch before validation |
| `source` | Deterministic URL/self-text dispatch and source plan | No content-based fallback between sources |
| `urls` | Fixed HN permalink, safe original URL projection, known source provenance | Platform WHATWG `URL`; no DNS or navigation |
| `self-text` | Minimal article-document wrapper and complete-input UTF-8 byte bound | Untrusted `textHtml`; no rendering or sanitization logic |
| `fetch-extract` | One fetch followed by one extraction for URL stories; direct local extraction for self-text | Borrowed fetcher/extractor; no extra retry or timeout |
| `outcomes` | Ready/failed projection, optional-field omission, fixed safe failure records | Fresh result/article containers only |
| `article` | Terminal article assembly, one timestamp, domain version derivation, final schema check | `articleContentVersion` is the only article-version algorithm |
| `cancellation` | Ordered caller-signal checkpoints and exact-reason rejection | No new controller, timer, listener, or abort translation |
| `errors` | Typed input/dependency-contract errors and upstream failure mapping | Fixed messages; no raw causes or source strings |

One module owns each cross-cutting rule. In particular, `article` is the only domain-record assembler, `urls` is the only original-fallback projector, and `self-text` is the only local wrapper/byte accountant. The extraction allowlist and text normalization remain exclusively in `article-extractor`; fetch deadlines and SSRF checks remain exclusively in `article-fetcher`.

## Construction and per-read state

The factory validates and copies `maxContentChars`/`maxInputBytes` and retains borrowed `fetcher`, `now`, and optional `extract` references. Omitting `extract` closes over the imported `extractArticle`. The factory creates no default network dependency and no per-call state.

A read creates a context conceptually like:

```text
storySnapshot
sourceContentVersion = storySnapshot.contentVersion
sourcePlan = url | self-text | empty
callerSignal?
fetched?: FetchedArticle
extracted?: ExtractedArticle
originalUrl
settled = false
```

The parsed domain story is the only story used after validation. In particular, source selection, HTML construction, metadata fallback, story ID, and `sourceContentVersion` all come from that one snapshot. This prevents a caller mutating an object during an awaited fetch from producing content from one story version labeled with another.

The context is not stored on the reader instance. Separate invocations can therefore interleave awaits without sharing a source URL, fetched body, DOM, timestamp, or result.

## Source planning

The source planner runs once after validation and the pre-abort checkpoint:

```text
story.url present?
  yes -> URL plan(story.url)
  no  -> story.textHtml present?
           yes -> self-text plan(story.textHtml, hnPermalink(story.id))
           no  -> local empty-content plan(hnPermalink(story.id))
```

URL presence deliberately wins over self-text. There is no secondary source after a URL error because the returned `sourceContentVersion` describes the story as a whole, while the two representations could contain materially different text. The failure still carries a safe original-page fallback.

For URL plans, `urls` attempts a local normalization solely for safe output/fallback metadata. The exact original string still goes to the fetcher so its validation and error codes remain authoritative. A valid normalization supplies `originalUrl` and pre-fetch `sourceUrl`; an invalid one suppresses `sourceUrl` and selects the fixed HN permalink as `originalUrl`.

For self-text plans, the fixed permalink serves three distinct purposes:

1. the base URL passed to extraction for relative-link resolution;
2. `Article.sourceUrl` provenance;
3. the original HN discussion fallback.

The reader never fetches that permalink. Its fixed HTTPS generation avoids accepting a story-controlled base URL or adding a dependency on HN account configuration.

## URL execution flow

```text
validated URL plan
  -> cancellation checkpoint
  -> fetcher.fetch(originalStoryUrl, callerSignal)
       -> all URL/DNS/pin/redirect/deadline/retry/body/media policy stays below
  -> cancellation checkpoint
  -> extract({ html: fetched.html, sourceUrl: fetched.finalUrl, maxContentChars })
       -> inert parse -> Readability -> bounded/sanitized content
  -> cancellation checkpoint
  -> ready article assembly
```

`finalUrl`, not the original or canonical URL, is the extraction base because it identifies the document actually returned after redirects. Both source and final provenance remain on the article. `originalUrl` stays outside the redirect chain.

The composition makes exactly one high-level fetch call. Any GET attempts inside that call belong to `http-client`; any manual redirect hops belong to `article-fetcher`. A returned `ArticleFetchError` is terminal for this read and maps to one failed outcome. There is no reader-level retry loop.

## Self-text execution flow

```text
validated self-text plan
  -> fixed minimal document wrapper
       <!doctype html><html><head><meta charset="utf-8"></head>
       <body><article> + story.textHtml + </article></body></html>
  -> UTF-8 byte length of complete wrapped document
       > maxInputBytes  -> source-too-large failed outcome
       <= maxInputBytes -> cancellation checkpoint
  -> extract({ html: wrappedDocument, sourceUrl: hnPermalink, maxContentChars })
  -> cancellation checkpoint
  -> ready article assembly
```

The exact wrapper tags are an implementation detail, but its constraints are contractual: one `article` container, no source-derived attributes/metadata, and no executable or resource-loading additions. The raw HN fragment is not escaped into plain text because its allowed formatting must survive extraction. Security comes from passing the complete result through the same inert Readability/DOMPurify pipeline as fetched HTML, not from trusting HN.

`Buffer.byteLength(wrappedDocument, "utf8")` or an equivalent non-allocating UTF-8 measurement avoids creating another full source buffer merely to enforce the limit. The check includes wrapper overhead, so the actual extractor input always satisfies the configured byte bound. `maxContentChars` remains a separate readable-text budget and cannot substitute for an input HTML bound.

Self-text success has no `finalUrl` or `fetchedAt`; inventing either would imply a network observation that did not occur. Self-text failure retains the permalink but likewise has no fetch provenance.

## Outcome assembly

### Shared terminal path

Both ready and failed outcomes pass through one terminal assembler:

1. Select the final status and all status-specific optional fields.
2. Attach the snapshotted story ID and exact `sourceContentVersion`.
3. Attach only provenance known on this execution path.
4. Check caller cancellation before reading the clock.
5. Call `now()` once, validate the returned `Date`, and serialize with `toISOString()` as `updatedAt`.
6. Call `domain.articleContentVersion` on the otherwise terminal article and assign its exact result as `contentVersion`.
7. Validate the completed object with `ArticleSchema` and compare the derived version once more as a defensive invariant.
8. Return a fresh discriminated result with required `originalUrl`; add `failure` only for failed outcomes.

Internally, assembly may use a candidate whose `contentVersion` has not yet been assigned. No incomplete candidate escapes the private assembler. The domain helper does not consume the old `contentVersion`; it hashes the documented status/content projection. This avoids a second placeholder-version algorithm while ensuring every public article has the derived value.

`ArticleSchema` validates the public record, not the input HTML or dependency output semantics. A nonconforming fetch/extract result, invalid clock result, or failed final invariant becomes `ArticleReaderError("dependency-contract")`; it must not be saved as a plausible article failure.

### Ready projection

The ready branch copies the extractor's `text`, sanitized HTML, and hash without modification. Title uses `extracted.title ?? story.title`. Byline and excerpt come only from extraction; an HN submitter is not relabeled as an external article author. After verifying the raw extracted version, the branch stores `ARTICLE_READER_VERSION`, which also covers reader-owned mapping/wrapping. Fetched stories retain fetch provenance. Error properties are absent.

The raw extractor version must agree with the current extractor contract before it is wrapped by the composite reader version. Upper-layer work selection uses `ARTICLE_READER_VERSION`. A custom test extraction seam must still return a conforming `ExtractedArticle`; the seam is not permission to persist arbitrary version/hash values.

### Failed projection

The source/target helper is also the public `resolveArticleOriginalTarget` pure function. Both `read` and reader-app cached detail call it, so original-page versus HN-discussion behavior cannot drift. It returns a fresh `{ kind, url }`; only `kind="original-page"` supplies a fetchable original source, while the fixed discussion permalink remains navigation evidence rather than a fetched source unless the self-text path explicitly wraps it.

The failed branch creates a new record with required `errorCode`/`errorMessage`, attempted `ARTICLE_READER_VERSION`, and no readable-content fields or content hash. It never spreads a prior article into the result. This structural choice prevents stale text from surviving a failed refresh and entering recommendations, which intentionally project failed articles by status only. Attempted pipeline provenance lets an upgrade retry without changing the failed status's derived content version.

Known source/final/fetch timestamps are retained. `failure.retryable` and optional numeric HTTP status remain beside the article because the domain schema does not persist them. Reader-app uses the side metadata for the active job; attempted `extractorVersion` is pipeline provenance, not a hidden retryability field.

## Version and staleness flow

There are four related but distinct versions:

| Value | Producer | Consumer / meaning |
|---|---|---|
| `Story.contentVersion` | HN story normalization | Exact source snapshot for this extraction; copied to `Article.sourceContentVersion` |
| `ExtractedArticle.extractorVersion` | `article-extractor` | Raw extraction/sanitization algorithm provenance; checked before composite assignment |
| `Article.extractorVersion` | `article-reader` | `article-reader-v1:${ARTICLE_EXTRACTOR_VERSION}`; covers reader mapping/wrapping plus extraction and drives ready/failed re-extraction eligibility |
| `Article.contentVersion` | `domain.articleContentVersion` | Scoring-input identity for the exact terminal article |

The reader never recomputes the story version and never hashes its own article projection. Recommendations later combine story content version and article content version, while reader-store uses both source and extractor versions to select content work.

Re-extraction selection is upstream:

```ts
import { ARTICLE_READER_VERSION } from "@tmtp/article-reader";

readerStore.articles.needingContent({
  extractorVersion: ARTICLE_READER_VERSION,
  afterStoryId,
  limit,
});
// Includes absent/pending articles, changed sourceContentVersion,
// and stored ready extractorVersion different from the current constant.
```

A stale ready article remains available for reading until a new terminal outcome is persisted. The reader itself does not delete it, suppress it, or decide that an HN score change requires work.

## Error and cancellation boundary

The outer read boundary handles outcomes in this order:

1. Reject invalid story/signal input with safe `ArticleReaderError("invalid-input")` before cancellation/I/O.
2. At every later checkpoint, if caller cancellation is visible, reject with the exact `signal.reason`.
3. Convert an expected `ArticleFetchError` or `ArticleExtractionError` into a fixed safe failed outcome.
4. Convert a local absent/oversized source into the documented failed outcome.
5. Propagate an unexpected borrowed-infrastructure exception unchanged.
6. Reject a malformed dependency success or reader-owned final invariant failure with safe `ArticleReaderError("dependency-contract")`.
7. Otherwise return the terminal result.

Checking cancellation before typed-error mapping is essential: an abort caused by the caller must not become a persisted `timeout`, `transport`, or `extraction-failed` article. Conversely, a real fetch timeout without caller cancellation remains a failed outcome with the fetcher's retry advice.

No public expected failure contains raw HTML, readable text, story titles, source/final URLs, hostnames, DNS addresses, response headers, parser issues, dependency messages, abort reasons, or public `cause` chains. The optional HTTP status and stable code/category/retryability are enough for control flow.

The reader owns no abort controller. It forwards the identical signal and adds synchronous checkpoints around dependency calls. During `extractArticle`, the JavaScript thread is blocked by upstream synchronous work; cancellation becomes visible only when that call returns or throws. This limitation is explicit and bounded by fetched/self-text input limits.

## Transaction and application composition

The intended reader-app sequence is:

```text
no transaction: load story / select stale work
no transaction: articleReader.read(story, jobSignal)
               ├─ URL: external fetch + synchronous extraction
               └─ self-text: local synchronous extraction only
short transaction: conditional article upsert compares sourceContentVersion to current Story
                 applied -> persist Article and apply store-owned queue invalidation
                 stale-source -> no article or queue write; discard outdated attempt
later jobs/transactions: personalization scoring and complete queue projection
```

No SQLite transaction is open across DNS, HTTP, decompression, DOM work, or a clock/dependency call. Failed outcomes are durable article states; cancellation is not. The application passes `failure.retryable` to its current job decision without letting the reader start another attempt.

A returned article already satisfies store version invariants. The conditional store upsert closes the durable race between the story snapshot used for reading and the story current at commit time; reader-app handles the explicit `stale-source` result rather than relying on an unconditional last-writer-wins write.

## Security and resource boundaries

- Arbitrary URL fetching occurs only through the borrowed `ArticleFetcher`; no direct Undici, global `fetch`, socket, DNS, proxy, cookie, credential, or redirect path exists here.
- Extraction occurs only through `extractArticle` or a contract-conforming injected test seam. Production does not swap in a weaker sanitizer.
- URL and HN markup share the same inert parser, Readability, dangerous-subtree removal, sanitization, safe-URL, text-budget, and hashing path.
- Self-text input is bounded before DOM construction. Fetched input has independent transfer and decoded limits below this package; readable output has the separate character budget.
- The reader returns sanitized body markup only and adds no raw wrapper or source string to it. Service CSP remains defense in depth.
- Fallback URLs are normalized HTTP(S) or a fixed HTTPS HN permalink. Unsafe original strings never become navigation metadata.
- Memory per call is bounded by the upstream fetched representation, the bounded local self-text document, extractor DOM/output, and terminal domain result. No cross-call cache retains these values.
- The reader emits no logs, metrics, network callbacks, storage events, or model prompts. Upper layers must preserve the same safe-field restrictions.

## Concurrency and lifecycle

An `ArticleReader` instance is safe for independent concurrent reads when its borrowed dependencies honor their own concurrency contracts. The only shared reader state is immutable configuration and dependency references. Calls to the same story are also allowed; deterministic version labels make their provenance explicit but do not choose a durable winner.

No in-flight map or per-story mutex is used. Such a map would add cleanup/cancellation complexity and still would not solve durable races across other writers. Deduplication belongs to the job/work selection layer, and commit freshness belongs to reader-app/store.

The package has no close operation and owns no sockets, timers, listeners, workers, DOM windows, or file handles. Extractor DOM cleanup is upstream; fetch/HTTP cleanup is upstream. Service shutdown cancels jobs, waits within its grace policy, and closes the shared HTTP client in the service composition.

## Design trade-offs

- **Returned terminal outcomes versus repository convenience.** A discriminated ready/failed result makes every caller handle content and failure explicitly and keeps the package storage-free. The cost is that reader-app must own a real persistence pipeline rather than receiving a transparent cached repository.
- **Required `now` and optional `extract` seams versus direct globals.** Structural injection preserves the three-package dependency limit and deterministic tests. It requires service wiring but no new clock interface or package.
- **Fixed HN permalink versus configurable HN base.** A fixed official HTTPS permalink is unambiguous and safe for relative self-text links. A deployment-specific HN mirror would require a new explicit source policy, not silent reuse of account HTML configuration.
- **Local self-text wrapper versus an extractor fragment API.** Keeping one upstream HTML API avoids a second extraction/sanitization path. The minimal wrapper is reader policy and must remain stable within one `article-reader-v*` marker; substantial wrapper or mapping changes require a marker bump and coordinated re-extraction.
- **Complete-input byte bound versus output-only limit.** Counting self-text markup can reject a document whose eventual readable text would be small, but it bounds CPU/DOM work before extraction. Fetched and local input now have clear pre-DOM limits.
- **Failed outcomes versus thrown remote errors.** Expected article failures remain persistable domain state and retain fallback metadata. Invalid calls, cancellation, and infrastructure failures remain rejections because they are not content outcomes.
- **No internal dedupe versus duplicate work.** Concurrent jobs can repeat fetch/extraction, but durable coordination cannot be correctly implemented by a process-local reader lock. Upper layers must handle version-checked writes and retry policy.

## Testing seams and verification design

The public factory supplies all required seams. A scripted `ArticleFetcher` records URL/signal identity and holds or settles fetch Promises with exact `FetchedArticle`/`ArticleFetchError` values. An optional `extract` fake records exact HTML/base/budget inputs and returns fixed `ExtractedArticle` values or typed errors. Fixed `now` functions produce exact timestamps and invalid-date cases.

Use the pure seams for exhaustive mapping, provenance, version, cancellation, and concurrency tests. Use the real extractor for URL/self-text security and representative Ask HN fixtures. The fetcher and extractor package suites retain responsibility for real DNS/pinning/HTTP and real sanitizer internals; article-reader tests must not reimplement those suites.

Golden assertions should compare complete domain outcomes and independently call `domain.articleContentVersion`, not just check status/non-empty content. Include both ready and every local/upstream failure class, original/final URL differences, absent fields versus explicit `undefined`, and exact abort-reason identity. Interleave two pending fetches and local extraction calls to detect shared context.

Manifest/import checks prove the tier boundary. Reader-app/store integration suites—not a fake repository inside this package—must prove transaction placement, stale-write handling, persistence, re-extraction selection, and recommendation/queue version propagation.

## Cross-package integration

Reader-app now owns cached-story loading, `needingContent` eligibility with `ARTICLE_READER_VERSION`, conditional outcome persistence, the same-source ready replay guard, safe job failure mapping, cancellation, and the shared original-target projection into `StoryDetail`. These are completed consumer contracts, not reasons to add storage or job imports here.

Batch F service wiring must pass `systemClock.now` as `now` and validated `article.max_content_chars`/`article.max_response_bytes` into `createArticleReader`, while retaining ownership and shutdown of the shared fetcher HTTP client. That remains service composition rather than an article-reader configuration source.

## Dependency and change boundaries

New behavior must preserve the dependency direction and public outcome invariants. Browser rendering, site-specific selectors, direct HTTP, caching, SQL, scheduler/job logic, logging, and LLM calls require separate component decisions rather than new private modules here.

Any change to source dispatch, self-text wrapping, metadata mapping, error codes, or provenance must review both store re-extraction and recommendation identity. Any change to article content/version fields must continue to delegate the derived version to domain and must update acceptance fixtures across reader-app/store/personalization rather than introducing a reader-local version rule.
