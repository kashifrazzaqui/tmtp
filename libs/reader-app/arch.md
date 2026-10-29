# Reader Application Architecture

## Architectural role

`reader-app` is the tier-4 application facade between `services/personal-reader` and all reader compositions. It owns application commands/queries, complete queue-page composition, explicit HN intent/outcome transactions, article-job durability, and central job dispatch. It does not own transport, rendering, scheduling, SQL, ranking, activity reduction, HN parsing, article extraction, LLM calls, or worker leases.

```text
HTTP/UI commands                 service scheduler / durable worker
       |                                   |
       +------------> reader-app <---------+
                         |
       +-----------------+------------------+
       |                 |                  |
  read models       action/article      central job dispatch
  queue/detail      coordinators             |
       |                 |                  +--> personalization.runJob (4 kinds)
       |                 |                  +--> personalization.recordActivity
       |                 |                  +--> article read/upsert pipeline
       |                 |
  reader-store <----- short synchronous transactions ----> job-queue
       |
  hn-ingestion / personalization / hn-account / article-reader
       |
  external HN, article origin, and LLM calls (never inside SQL)
```

The only workspace dependencies are the nine already declared in the manifest. `now` and `createId` are structural capabilities so `clock` does not become a new package edge. Node crypto and platform URL/UTF-8/base64url APIs are implementation primitives.

## Private module decomposition

These modules are package-private organizational units, not public subpaths:

| Module | Owns | Must not contain |
|---|---|---|
| `options` | Strict construction/direct-call validation and scalar snapshots | Configuration loading or construction I/O |
| `errors` | Fixed safe facade errors, dependency mapping, worker failure mapping | Raw causes/messages, payload interpolation |
| `cancellation` | Validation-first pre-abort and composition checkpoints | A replacement controller/timer or persisted abort reason |
| `time` | Valid Date-to-domain-ISO and not-before timestamps | Global clock reads or monotonic persistence |
| `identity` | New intent IDs and namespaced SHA-256 activity identities | Fresh IDs on retry or secret hashing |
| `queue-manifest` | Complete row scan, version groups, and filter-aware fingerprint | Current-profile/version guessing |
| `queue-cursor` | Strict `rqa1` outer codec and nested queue `q1` use | Offset pagination or a second position codec |
| `queue-query` | Cross-group bounded page assembly, evaluation counts, and aligned batch story details | Dropping bootstrap/old groups, per-group score merging, or N+1 story reads |
| `story-query` | Consistent cached detail, exact recommendation, safe fallback | Network fetch, rendering, latest-history substitution |
| `history` | Bounded recommendation/activity/HN history queries and keyset continuation | Unbounded reads or cross-story cursor reuse |
| `reading-state` | Pure transition plus monotonic state persistence | Implicit dismiss/skip observations |
| `delegates` | Activity/preferences/personalization/ingestion/capability calls | Duplicate lower-library algorithms or transactions |
| `hn-actions` | Key single-flight, intent/outcome state machine, verified activity outbox | Autonomous mutation or post-dispatch blind retry |
| `article-jobs` | Current-version eligibility, external read, conditional upsert, retry classification | Forced stale writes or synthetic cancellation articles |
| `job-codecs` | Article/activity codecs plus six owner-supplied codecs (two ingestion, four personalization) | Lease operations or copied owner rules |
| `job-dispatch` | Eight-kind validation and handler routing | Claim/renew/complete/fail/recovery |
| `index` | Exact public exports and factory wiring | Convenience APIs or internal helpers |

Each durable algorithm stays in its owner. Reader-app composes public library boundaries rather than duplicating queue ranking, activity reduction, profile construction, recommendation identity, article versioning, account parsing, or SQL.

## Construction and service wiring

The service constructs dependencies bottom-up:

1. Apply reader-store/job migrations to one SQLite connection and construct the shared store.
2. Create job-queue with the static `readerAppJobCodecs` registry before constructing writers that require it and before any claim. The registry includes the two application-owned codecs, both ingestion-owner codecs, and all four personalization codecs; none of these codecs needs a writer instance.
3. Construct article, personalization, ingestion, account, and other lower dependencies with their validated owning policies and the shared job queue.
4. Pass `readerAppBootstrapRankVersion` as `hn-ingestion.bootstrapRankVersion`; ingestion invokes it once and snapshots `QUEUE_BOOTSTRAP_RANK_VERSION`.
5. Construct one `ReaderApp` with the same store/job instances, one personalization writer, one ingestion instance, the article reader, optional account, resolved queue page limits, `systemClock.now`, and a cryptographically random ID generator.
6. Construct HTTP/UI, scheduler, and worker loops above the facade. Cron callbacks call `scheduleIngestion`/`scheduleHnReconciliation`; they do not execute HN work directly.

No factory call performs I/O. Service composition and real-SQLite tests must prove store/job connection identity and the dedicated no-retry account HTTP client; reader-app cannot inspect those private properties.

## Complete queue architecture

### One manifest before every page

The store intentionally pages only one `rankVersion`. Correct application pagination therefore starts with a manifest of every queue row, not a query for only the active rank. `queue-manifest` reads `store.queue.projection()` and exhausts story-ID keyset pages in one synchronous transaction. Current ingestion joins a nonempty active rank for new pending rows, while bootstrap is used before the first nonempty projection; the manifest still covers legacy/coexisting versions. It emits:

```text
activeRankVersion: optional pointer value, used only for group ordering
versions: all distinct discovered rankVersion values
fingerprint: SHA-256({ activeRankVersion, rows: canonical rows in story-ID order })
```

The per-row projection has fixed property order:

```ts
{
  storyId: number;
  rankVersion: string;
  evaluationState: EvaluationState;
  rankPosition: number | null;
  visibilityState: VisibilityState;
  state: QueueState | null; // actual state only for a state-filtered query
}
```

The fingerprint envelope stores `activeRankVersion` or null beside the row array, so moving the active pointer invalidates the cursor when group order changes even if every row is unchanged. For an unfiltered reading-state query, `state=null` for every row so ordinary reading does not invalidate the cursor. For a state-filtered query, actual state is hashed because entering/leaving the filter changes the logical stream. Visibility is always hashed because every query has an explicit effective visibility filter. Evaluation/rank fields and story IDs bind section/order and insertion/removal. Timestamps, errors, scores, and explanation content are deliberately excluded because they do not change page membership or position.

This is a fixed-size optimistic snapshot token, not a stored queue snapshot. The scan validates that the logical stream has not changed; it does not retain all rows between requests or hold a transaction across requests. A changed stream fails with `stale-queue-cursor`, and the caller restarts. That behavior is preferable to silently losing a new bootstrap version or mixing incompatible rank positions.

### Group and page order

The manifest group comparator is:

```text
active projection rank first when present in the manifest
then other non-bootstrap versions lexicographically
then bootstrap last
```

Within one group, reader-store supplies:

```text
scored  (rankPosition, storyId)
pending (storyId)
failed  (storyId)
```

There is no cross-version score comparator. Such a comparator would invent semantics for positions created from different profiles/content sets. The transitional order simply guarantees deterministic complete reachability. Complete personalization projection remains responsible for converging all rows to one content-addressed version.

`rankVersions` in the result reports all groups, including empty-under-filter groups. `evaluationCounts` uses a separate all-version aggregate at the requested visibility; it is not calculated from the returned page or restricted to one group.

### Bounded merge algorithm

The page assembler holds only the decoded start position, the group list, and at most `limit + 1` candidate entries. It does not retain the complete row scan as entries.

```text
start = first group, or group/position decoded from cursor
for each remaining group:
  repeatedly read bounded keyset chunks from store.queue.page
  append candidates until limit + 1 are known
  if a short read proves group exhaustion, move to the next group
  otherwise resume after the last chunk row in the same group
stop when limit + 1 exists or every group is exhausted
return first limit; encode continuation from entry[limit - 1] if an extra exists
```

Each individual store request is at most `queueMaxPageSize`. When `limit` equals that maximum, the assembler uses additional bounded keyset reads rather than asking for `max + 1`. The same synchronous transaction includes manifest discovery, counts, all page reads, and one `stories.byStoryIds` call for the returned IDs, giving one consistent database snapshot for the response. Story records are mapped back into entry order and projected through the shared original-target function into `storyDetails`; an empty page skips that query and a missing story is a dependency-contract failure.

A continuation contains the last **returned** row, not the look-ahead row. On the next call, rows in earlier groups and the returned row itself are excluded by strict keyset comparison. If a page ends exactly at a group boundary, the next call first observes that group's exhaustion and then enters the following group; no special empty-page cursor is needed.

### Cursor layers and failure behavior

Queue's `q1` codec remains the sole rank-version/evaluation/rank-position/story-ID position codec. `rqa1` wraps a canonical `q1` string with filter triple and manifest hash:

```text
rqa1 = version prefix + canonical JSON + SHA-256 checksum
payload = { filters, manifestHash, after: q1Cursor }
```

The outer codec follows strict decode/re-encode equality. It never interprets a checksum as a signature; access control is above this package and cursor tampering grants no data/write privilege.

Decode order is important:

1. validate outer syntax/canonical form/checksum;
2. validate exact effective filters;
3. decode/validate inner `q1` and its evaluation-section compatibility;
4. rediscover and compare the complete manifest hash;
5. locate the inner rank version in the group list;
6. issue store page reads with the same filters and decoded position.

Malformed/filter/section-inconsistent input never reaches SQL and is `invalid-cursor`. Only an otherwise valid cursor reaches manifest comparison; a changed manifest is `stale-queue-cursor`, and a missing inner version after a matching manifest is impossible by construction. There is no catch-and-fallback path to a cursorless or one-version page.

### Complexity and upgrade path

For `S` queue rows and returned limit `L`, manifest discovery is `O(S)` database/CPU work, the fingerprint is `O(S)`, version sorting is `O(V log V)`, and page assembly plus batch story details retains `O(L + V)` besides store pages. This is deliberately correctness-first for mixed versions. The current store has no manifest query; a future owning-package projection can supply version groups/fingerprint without scanning rows, but must retain identical change-detection semantics.

## Cached detail and fallback architecture

A story detail uses one synchronous read snapshot:

```text
story = stories.byId
article = articles.byStoryId
queueEntry = queue.byStoryId
recommendation = queueEntry.recommendationId
                   ? recommendations.byId(exact ID)
                   : undefined
```

This avoids explanation drift. Historical `latestForStory` is used only by history/debug workflows, never to populate the current explanation. Missing required projection rows are safe dependency failures rather than fabricated pending state.

The detail query never calls `ArticleReader.read`. Cached ready content remains available even if its source/pipeline is stale; replacement happens in a durable article job. Missing/pending/failed content is returned explicitly and never converted to a recommendation rejection.

`originalUrl` and fallback kind come from `article-reader.resolveArticleOriginalTarget(currentStory)`, not a stale article's source/final URL or a second reader-app URL algorithm. The shared pure function returns a normalized credential-free fragment-free original-page URL or the fixed HTTPS HN discussion permalink. The permalink uses the validated decimal story ID and is not fetched by this query. A redirect target never becomes original-page navigation. Fallback activity uses partial observation quality; rendering/CSP belongs to the service.

## Command delegation architecture

Simple delegates do not wrap lower transactions in another application transaction:

- `recordActivity` forwards the whole batch and signal to personalization and returns both result fields.
- `replacePreferences`, `rebuildPersonalization`, and `runPersonalization` forward to the exact profile/preference/recovery operation. Reader-app neither ranks nor calls an LLM itself.
- `runIngestion` and `reconcileHnAccount` forward to ingestion and return complete summaries.
- `scheduleIngestion` and `scheduleHnReconciliation` use ingestion's enqueue factory with an empty version-1 payload and current run-after time, then return the inserted/active-deduped job without calling HN.
- `getHnCapabilities` forwards to the optional account or returns a deterministic unavailable four-name list.
- preference/history reads use short synchronous store snapshots.

This keeps one owner for each lock and transaction. Activity can commit while personalization waits on an LLM; profile operations retain the personalization pipeline lock; public/account ingestion retains its FIFO lane. Reader-app adds no competing lock or retry loop.

Queue-state update is the exception because reader-app owns this command. It reads the entry, calls pure `transitionQueueState`, and persists in one transaction. `at=max(clock wall time, entry.updatedAt)` by timestamp comparison, with equal allowed. The no-op transition retains its old timestamp and the repository receives that unchanged value.

## Explicit HN action coordinator

### Single-flight and idempotency

Reader-app's in-memory map is keyed by the caller's idempotency key and stores the story/action plus one Promise for the entire intent → account → outcome sequence. It has three purposes:

1. prevent two first-time commands from racing the unique key insert;
2. share one account execution and one outcome/activity handoff for identical concurrent commands;
3. reject conflicting reuse before any external work.

It is not the durable idempotency mechanism. The database unique key and stored result survive restart; the map is deleted in `finally`. Different keys may run concurrently at reader-app level, but the account adapter's own lane serializes/throttles their requests.

Single-flight does not imply shared per-caller cancellation. The first caller's signal is the operation signal sent to the account adapter. Each caller also gets an independent abortable wait over the shared Promise. A follower's abort rejects only its wait with its exact reason and leaves the shared operation running. A leader's abort reaches the account operation; the leader still receives its exact reason, while followers receive safe retryable `ReaderAppError("cancelled")` if the operation rejects before producing an outcome. No follower receives the leader's arbitrary abort object. After dispatch, the adapter's indeterminate outcome is persisted even if the leader's wait has already rejected. All wait listeners are removed on settlement.

### Two transactions with an external gap

```text
validate command / story / key
  -> BEGIN intent transaction
       lookup story + key
       insert pending intent if absent
     COMMIT
  -> no transaction: account.performAction(pending or indeterminate intent, signal)
       fresh state read -> optional fresh form -> at most one POST -> fresh readback
  -> BEGIN outcome transaction
       re-read intent
       apply outcome state rules
       if verified, ensure stable app-action record-activity job
     COMMIT
  -> return safe HnActionResult
```

The account call receives the stored intent, including its durable ID/status. Existing verified/failed results replay before that call; verified replay performs the activity ensure below, while failed replay has no further effects. Pending and indeterminate retries both begin with the adapter's fresh state read; reader-app never issues a direct POST or supplies a form itself.

Stored version-1 result evidence is a union. Reader-app writes the exact adapter `HnActionResult`; reconciliation writes `{ source: "hn-reconciliation", observedAt }`. A replay validator accepts only the appropriate shape/status and normalizes reconciliation evidence to `{ intentId, status: "verified", observedAt }` using the durable intent. It never requires reconciliation evidence to contain fields its producer does not own.

A pending row after a crash is deliberately ambiguous about whether an earlier process crossed dispatch. It remains safe to retry only because the adapter always reconciles first. Reconciliation may enrich indeterminate intents from positive current-state evidence but does not close pending rows; an explicit retry or later positive action flow is required for those.

### Outcome state and uncertain retries

The outcome coordinator does not treat every adapter result as a fresh independent intent. In particular, an indeterminate row records earlier possible dispatch. If a later invocation returns pre-dispatch `failed`, reader-app keeps the status indeterminate while updating safe latest error/observation metadata. Only positive verified evidence closes it. This prevents a failed retry from erasing uncertainty about the original POST.

Reader-app's own result JSON is the small version-1 `HnActionResult`; reconciliation's separate version-1 source/observation evidence remains valid. Neither contains raw HTML/transport evidence. The outer intent timestamp is monotonic, while nested `observedAt` remains unchanged from the adapter/reconciliation outcome. Store/domain validation runs before returning any replayed result.

### Verified activity outbox

A verified outcome and its learning handoff must not diverge. The outcome transaction therefore writes `updateOutcome` and ensures the activity job on the shared connection. The same ensure helper runs for a verified replay after reconciliation: query the derived `clientEventId` through `store.activity.query`, enqueue if no event exists, and treat an active-job dedupe hit as an existing handoff. This covers reconciliation verifying an intent without producing an app-action job itself:

```text
verified intent outcome
  + personalization.record-activity({ batch: [one app-action observation] })
  -> one SQLite commit
```

SHA-256 over the versioned namespace and durable intent ID produces 32 bytes; unpadded base64url yields the activity package's 43-character client identity. The same value is the job dedupe key. It is generated deterministically on every retry, never randomly regenerated.

The observation's `occurredAt` is the verified outcome's local observation time. It describes when this application established the explicit verified action, not when HN necessarily applied it. Failed/indeterminate outcomes produce no positive app-action observation. Ingestion reconciliation independently produces partial `hn-reconciliation` observations through the same job kind.

If initial outcome/activity ensure fails, the whole outcome transaction rolls back. A retry starts with fresh HN readback and can reconstruct the same verified outcome/activity identity. If the process dies after commit, a worker retry replays the same raw observation and activity's reducer discards the exact duplicate. If reconciliation already verified the intent, a later explicit replay needs no account call; its ensure transaction either finds the event, finds/dedupes an active handoff, or creates a replacement durable handoff after an exhausted job.

## Article-job pipeline

### Eligibility and replay suppression

Article jobs carry exact story source identity. The handler first compares the payload version with the current story; stale payloads finish successfully. For a current payload it evaluates two inputs:

```text
existing article = articles.byStoryId(storyId)
next needing story = articles.needingContent({
  extractorVersion: ARTICLE_READER_VERSION,
  afterStoryId: storyId - 1,
  limit: 1,
})[0]
```

Because the query is story-ID keyset ordered, `afterStoryId=storyId-1` and limit one tests target membership without scanning earlier stories. The composite reader constant covers extraction plus reader source/mapping policy. A current ready replay normally needs no work and avoids another external call.

A same-source, current-pipeline failed record is the explicit exception. The store query does not select such a row again merely because it failed; its active durable job owns retry/backoff. The handler must still execute that job on its next attempt. It therefore proceeds when the current article is failed for the payload source with attempted `extractorVersion=ARTICLE_READER_VERSION`, even if `needingContent` returns another/no story. A stale-pipeline failed record is already query-eligible. Explicit refresh can retry a failed current source; a fresh ready current article remains a no-op rather than a second force-refresh protocol.

### External read and conditional commit

```text
current story + article/eligibility reads (no transaction held)
  -> articleReader.read(storySnapshot, signal)
       fetch/extract or local self-text extraction
  -> short conditional article result transaction
       re-read current article
       same-source/current-pipeline ready already committed: discard duplicate attempt
       otherwise compare result.sourceContentVersion with current story through upsert
       applied: write article + store-owned queue invalidation
       stale-source: no write
  -> ready: success
     failed + applied: throw retryable/terminal article error after commit
     stale-source: success/no-op
```

No DNS, HTTP, decompression, DOM, extraction, or model work occurs in SQL. The store's compare-and-upsert is the durable source-freshness check against ingestion changing the story during the read. The additional same-transaction ready guard closes the distinct same-source lease race: a newer ready attempt commits before an older failed attempt, whose lease failure would otherwise leave the completed job's ready content overwritten. Reader-app still adds no unconditional write.

Expected article failures are domain outcomes first and job failures second. Persisting before throwing leaves readable failure/fallback state across restart. `failure.retryable` controls only job-queue backoff; it never enters the article version or prompt input. Cancellation is different: it creates no synthetic article failure and becomes safe retryable job cancellation.

After an applied article change, personalization sees store-owned pending invalidation and the exact domain-derived article content version through its normal scoring/projection jobs. Reader-app does not invoke an LLM in the article handler.

## Codec and worker architecture

### Registry ownership

The registry is static and side-effect-free:

```ts
[
  articleFetchExtractCodec,
  recordActivityCodec,
  ...hnIngestionJobCodecs,
  ...personalizationJobCodecs,
]
```

The two local codecs validate version-1 shapes and return fresh payloads. The activity codec delegates to `parseActivityBatch`, allowing exactly one raw row so durable outbox work is bounded and one-story by construction. Ingestion's no-occurrence reconciliation shape and reader-app's verified app-action shape both use their owning activity rules. The two scheduling codecs and their empty-payload/dedupe contracts remain in hn-ingestion.

Personalization payload validation, migrations, and dedupe keys remain exclusively in its four codecs and enqueue factory. Reader-app does not copy those algorithms. Ingestion can emit structural article/activity/scoring handoffs without importing this higher-tier package; claim-time codecs provide the common validation boundary.

### Handler versus worker

`runJob` is a logical-effect dispatcher. The service worker is the lease state machine:

```text
claim = jobs.claim(eight kinds)              // worker, transaction commits
if claim.status == "leased":
  job = claim.job
  while active: jobs.renew(id, token)        // worker heartbeat
  await readerApp.runJob(job, signal)        // logical effects only
  jobs.complete(id, token)                   // worker
  on error: jobs.fail(id, token,
                      readerAppJobFailure(job.kind, error))
if claim.status == "rejected":
  no runJob, heartbeat, completion, failure, or failure mapping
if claim.status == "idle":
  no eligible job and no rejection; run no handler
```

The handler validates the leased job shape and decodes the payload again at its public trust boundary, but it cannot prove the lease is still current and does not try. A lease can expire between an external result and commit; idempotent application effects are mandatory. Job-queue rejects stale completion/failure separately.

Only a `leased` result enters the handler path. A `rejected` result carries the fresh terminally failed job after job-queue's invalid-payload transaction commits. It is an expected contained queue outcome: the worker does not call `runJob`, renew or finalize a nonexistent lease, invoke `readerAppJobFailure`, or treat the rejection as a reader-app handler or readiness failure. An `idle` result has no selected job to process.

`readerAppJobFailure` handles article-attempt-failed first so its safe dependency code cannot be swallowed by the facade catch-all. It then applies the common facade table to every kind: invalid-job/not-found/cancelled/dependency-failure/internal-failure and every other remaining `ReaderAppError` retain stable codes and declared retryability. Only non-facade errors delegate to the activity/personalization or ingestion owner mapper. The remaining unknown article error uses fixed retryable `reader-app-failed`. Raw exceptions/messages/abort reasons never enter the jobs table.

The mapper's kind parameter is the domain job's plain string, not an unchecked `ReaderAppJobKind` assertion. It first checks membership in the static eight-kind registry; an unknown kind produces terminal `invalid-job` regardless of the supplied error. The ordinary worker therefore passes `job.kind` directly with no cast.

The eight-kind registry includes public/account ingestion scheduling jobs and dispatches them to the same public methods as direct commands. Cron only enqueues; it never executes an unregistered kind or routes ingestion through an unrelated personalization handler.

## Error and cancellation flow

The outer facade boundary classifies outcomes in this order:

1. Invalid application input/options/job/cursor produces fixed non-retryable `ReaderAppError` before side effects.
2. Reader-app-owned caller cancellation rethrows the exact signal reason at direct boundaries.
3. Expected dependency errors map to safe `dependency-failure`, preserving only allowlisted code/retryability/metadata.
4. Expected HN action and article remote failures follow their durable result protocols rather than being flattened into generic exceptions.
5. Unexpected direct errors map to `internal-failure`; unexpected worker errors map to fixed retryable `reader-app-failed`.
6. Job cancellation maps to retryable `cancelled` only after any already-returned durable result has been handled.

No lower error with a public `cause` escapes directly. No mapper interpolates dependency messages. Service logging/diagnostics receives only operation, dependency/code, story/job/run correlation, and numeric status where an owning DTO explicitly exposes it.

Cancellation uses checkpoint composition rather than a reader-app abort controller:

- before a command's first store/external stage;
- between HN intent commit and account invocation;
- between article eligibility and article read;
- inside delegated operations according to their contracts;
- never in the middle of a synchronous SQL transaction.

After HN account invocation, its outcome is durable information and is committed even if cancellation races settlement. After article reader returns, its conditional outcome is likewise handled before job cancellation is reported. This prevents an external effect or extracted terminal result from disappearing merely because shutdown began.

## Transaction and crash matrix

| Crash/lease point | Durable state | Recovery behavior |
|---|---|---|
| Before HN intent commit | No intent, no account call | Same command may create it |
| After intent commit, before outcome | Pending/indeterminate intent | Fresh state read before any POST |
| After verified/failed/indeterminate outcome commit | Exact outcome; verified activity handoff ensured | Replay/retry without duplicate logical activity |
| Before activity/profile/preference commit | Entire owning transaction absent | At-least-once command/job retry |
| During article read | Prior article unchanged, lease attempt active | Lease recovery repeats current-version read |
| After article upsert, before job completion | Article + queue invalidation committed | Ready replay no-ops; failed retry repeats by policy |
| After personalization result commit | Audits/judgments/failures/full projection committed | Owner reuse/current-version rules prevent duplicates |
| Stale worker after lease loss | Logical effect may be committed | Token-checked lease transition fails; later attempt reconciles |

No row in this matrix requires holding SQL open over a Promise. Exactly-once external effects are not claimed.

## Concurrency and resource boundaries

- One action single-flight entry exists per active idempotency key; it is removed on every settlement. Per-caller wait listeners are bounded by joined callers and removed on abort/settlement.
- Account operations additionally use the adapter's serial/throttled lane. Ingestion and personalization use their own lanes/locks.
- Queue/detail/history transactions are synchronous snapshots. They do not wait for network/model work.
- Activity does not wait for reader-app or profile locks. Article and ingestion writers can commit while scoring awaits; their version guards handle freshness.
- Queue manifest scans are linear in stored rows and page assembly is bounded by request size. History and job payloads are bounded. No result set has a silent retention cap.
- Reader-app stores no story HTML, article DOM, account cookie/form, prompt, or raw cursor in module/global state. Per-call data is released at settlement.
- The package owns no background worker, scheduler, heartbeat, idle listener, socket, database handle, or close method. Operation-local wait listeners are removed at settlement. Service shutdown stops new claims, cancels, drains, and closes owners.

## Design trade-offs

- **Complete manifest validation versus cheaper pages.** Scanning every queue row per page costs `O(S)`, but it is the only correct composition with the current one-version store API. It prevents silent bootstrap/ranked loss and detects all ordering/filter changes with a fixed-size cursor.
- **Optimistic restart versus queue snapshot storage.** A fingerprint does not preserve an old view; it asks the reader to restart after changes. That is simpler than MVCC queue snapshots and appropriate for a personal queue whose projection is already versioned.
- **Grouped transitional order versus synthetic global score order.** Groups are not score-comparable, so deterministic group concatenation is honest. Complete reprojection restores normal one-version ranking.
- **Batch story details versus N+1 detail calls.** Queue results carry one aligned story/original-target projection per returned entry, increasing page payload slightly while avoiding per-card requests. Article bodies and explanations remain on the detail route, and cursor semantics are unchanged.
- **Structural clock/ID capabilities versus new dependencies.** Two small callbacks preserve the manifest and deterministic tests. They require explicit service wiring but no clock/config package edge.
- **Two HN transactions versus one long transaction.** Separate intent/outcome commits preserve audit and uncertainty across crashes. The cost is explicit retry/reconciliation logic, which is required for external mutations anyway.
- **Verified activity outbox versus direct activity call.** Another durable job kind is already required for ingestion; reusing it makes HN outcome and learning atomic. Direct outcome-then-activity calls could lose learning on a crash.
- **Conditional article upsert versus process-local story locks.** Duplicate fetch work remains possible, but only the store can choose the durable source winner across asynchronous writers. A local lock would add complexity without closing that race.
- **Safe facade errors versus exposing owning error classes.** Callers get one operation-oriented contract and no accidental `cause` leakage. The cost is mapping code, which must remain exhaustive and preserve safe dependency codes/retryability.

## Testing seams and verification design

Use real temporary SQLite for every persistence/composition claim. Scripted account/article/LLM adapters journal exact calls and can defer settlement for cancellation/concurrency tests. Fixed `now`/`createId` control timestamps/intent IDs; SHA-256 outputs and cursor strings use independent golden fixtures. A transaction journal asserts that no external adapter runs between begin/commit.

Test layers are:

1. **API/codec unit tests:** exact exports, options/input validation, all eight payload decoders, cursor canonicalization, safe error/job mapping, and dependency manifest checks.
2. **Queue integration tests:** independently compute manifests/group pages, mix bootstrap and multiple ranked versions, cross every section/group boundary, and compare full page concatenation with expected tuples. Mutate one field at a time to prove stale/valid continuation rules. Assert one bounded story batch read and exact story-detail alignment on every page shape.
3. **Detail/command integration tests:** exact recommendation links, safe fallback fixtures, stale cached content, all transitions, independent history streams, and delegate result shapes.
4. **HN action crash/concurrency tests:** deferred state/form/POST/readback phases, same-key single-flight with leader/follower aborts, every outcome transition, adapter/reconciliation result replay, verified replay ensure, absent-account terminal replay/new-intent rejection, outbox identity, and transaction rollback after external verification.
5. **Article/worker integration tests:** source/pipeline eligibility, same-source failed retries, conditional stale-source races, newer-ready/older-failure lease races, retryable/terminal post-commit failures, exact worker failure rows, lease recovery, and stale tokens. Exercise all three claim statuses and assert rejected/idle never dispatch a handler; rejected causes no reader-app failure mapping or readiness failure.
6. **End-to-end restart tests:** close/reopen SQLite between every transaction boundary and run the real eight-kind worker. Assert logical counts, original timestamps/IDs/explanations, complete queue reachability, durable scheduler recovery, and no duplicate activity/article effects. Include poison/valid sequences and prove each rejection survives restart as terminal queue state without a handler attempt.

Queue expected values must not be generated solely with the production cursor/fingerprint helpers. Use independent canonical fixtures, and compare store pages with pure queue pagination for one-version projections. For HN/article tests, assert exact request counts and transaction placement, not only returned statuses. Fixture success never establishes live HN capability; live account smoke checks remain separate and explicit.

## Dependency and change boundaries

Preserve the dependency direction and exact manifest. Browser rendering, HTTP DTOs/routes, cookies, scheduling, worker polling/heartbeat, SQL, configuration loading, concrete provider clients, and secret files belong to the service or lower owning libraries. Do not add them as reader-app conveniences.

Any queue algorithm/version change must review `rqa1` compatibility and mixed-version acceptance fixtures. Any article source/version change must review eligibility, conditional upsert, and recommendation invalidation. Any HN outcome/activity shape change requires a new payload/result schema version and replay-compatible migration. Any new job kind requires a central codec, safe failure mapping, idempotent handler, worker registration, and restart tests rather than an untyped dispatch branch.

The complete queue manifest scan remains an explicit correctness-versus-cost trade-off, not a hidden upstream dependency. Owner codecs/projectors and bounded history APIs keep the other composition paths within their existing package boundaries.
