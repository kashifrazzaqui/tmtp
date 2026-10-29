# Reader Application Library Spec

## Purpose and responsibility

Provide the transport-free command, query, and job-handler facade for the complete reader product. Compose ingestion, cached article reading, personalization, explicit HN account actions, preferences, activity, queue state, and durable jobs without knowing HTTP, cookies, React, schedules, or process lifecycle.

The package root is `@tmtp/reader-app`. It has no default export or subpath exports. It is a tier-4 ESM composition over exactly the dependencies already declared in `package.json`. It adds no framework, database-driver, concrete HTTP, LLM-SDK, configuration-loader, or scheduler import.

The target runtime is one Node process, one `ReaderApp` instance, one shared synchronous SQLite connection for `reader-store` and `job-queue`, and one writer for each lower composition. Every external HN, article, and LLM call remains outside store transactions. All application writes are idempotent, current-version guarded, immutable/reused, or complete projections as required by their owning libraries.

## Public interface / API surface

```ts
export const READER_APP_JOB_PAYLOAD_SCHEMA_VERSION: 1;

export type ReaderAppJobKind =
  | "article.fetch-extract"
  | "personalization.record-activity"
  | import("@tmtp/hn-ingestion").HnIngestionJobKind
  | import("@tmtp/personalization").PersonalizationJobKind;

export interface ArticleFetchExtractJobPayload {
  storyId: import("@tmtp/domain").StoryId;
  storyContentVersion: string;
}

export interface RecordActivityJobPayload {
  batch: readonly import("@tmtp/activity").RawActivity[];
}

export interface ReaderQueueQuery {
  state?: import("@tmtp/domain").QueueState;
  evaluationState?: import("@tmtp/domain").EvaluationState;
  visibilityState?: import("@tmtp/domain").VisibilityState; // default visible
  cursor?: string; // reader-app cursor, not a bare queue q1 cursor
  limit?: number;
}

export interface ReaderQueueResult {
  entries: import("@tmtp/domain").QueueEntry[];
  storyDetails: ReaderQueueStory[]; // same length/order as entries
  nextCursor?: string;
  evaluationCounts: Record<import("@tmtp/domain").EvaluationState, number>;
  rankVersions: string[]; // complete manifest, in page-group order
}

export interface StoryFallback {
  kind: "original-page" | "hn-discussion";
  observationQuality: "partial";
}

export interface ReaderQueueStory {
  story: import("@tmtp/domain").Story;
  originalUrl: string;
  fallback: StoryFallback;
}

export interface StoryDetail {
  story: import("@tmtp/domain").Story;
  article?: import("@tmtp/domain").Article;
  recommendation?: import("@tmtp/domain").Recommendation;
  queueEntry: import("@tmtp/domain").QueueEntry;
  originalUrl: string;
  fallback: StoryFallback;
}

export interface RecommendationHistoryQuery {
  storyId: import("@tmtp/domain").StoryId;
  afterId?: string;
  limit?: number;
}

export interface HnActionHistoryQuery {
  storyId: import("@tmtp/domain").StoryId;
  afterId?: string;
  limit?: number;
}

export interface ActivityHistoryQuery {
  storyId?: import("@tmtp/domain").StoryId;
  clientEventId?: string;
  afterEventId?: string;
  afterSessionId?: string;
  limit?: number;
}

export interface ActivityHistory {
  events: import("@tmtp/domain").StoredActivityEvent[];
  sessions: import("@tmtp/domain").ReadingSession[];
}

export interface HnActionCommand {
  storyId: import("@tmtp/domain").StoryId;
  action: import("@tmtp/domain").HnActionKind;
  idempotencyKey: string;
}

export type ReaderAppOperation =
  | "get-queue"
  | "get-story"
  | "get-recommendation-history"
  | "get-hn-action-history"
  | "get-activity"
  | "set-queue-state"
  | "refresh-article"
  | "record-activity"
  | "get-preferences"
  | "replace-preferences"
  | "rebuild-personalization"
  | "run-personalization"
  | "get-hn-capabilities"
  | "perform-hn-action"
  | "run-ingestion"
  | "schedule-ingestion"
  | "reconcile-hn-account"
  | "schedule-hn-reconciliation"
  | "run-job";

export type ReaderAppDependency =
  | "activity"
  | "article-reader"
  | "hn-account"
  | "hn-ingestion"
  | "job-queue"
  | "personalization"
  | "queue"
  | "reader-store";

export type ReaderAppErrorCode =
  | "invalid-options"
  | "invalid-input"
  | "not-found"
  | "conflict"
  | "invalid-cursor"
  | "stale-queue-cursor"
  | "invalid-transition"
  | "account-not-configured"
  | "article-attempt-failed"
  | "invalid-job"
  | "dependency-failure"
  | "cancelled"
  | "internal-failure";

export class ReaderAppError extends Error {
  readonly name: "ReaderAppError";
  readonly code: ReaderAppErrorCode;
  readonly operation: ReaderAppOperation;
  readonly retryable: boolean;
  readonly field?: string;
  readonly storyId?: import("@tmtp/domain").StoryId;
  readonly jobId?: string;
  readonly dependency?: ReaderAppDependency;
  readonly dependencyCode?: string;
  constructor(
    code: ReaderAppErrorCode,
    options: {
      operation: ReaderAppOperation;
      retryable: boolean;
      field?: string;
      storyId?: import("@tmtp/domain").StoryId;
      jobId?: string;
      dependency?: ReaderAppDependency;
      dependencyCode?: string;
    },
  );
}

export interface ReaderApp {
  getQueue(
    query?: ReaderQueueQuery,
    signal?: AbortSignal,
  ): Promise<ReaderQueueResult>;
  getStory(
    storyId: import("@tmtp/domain").StoryId,
    signal?: AbortSignal,
  ): Promise<StoryDetail>;
  getRecommendationHistory(
    query: RecommendationHistoryQuery,
    signal?: AbortSignal,
  ): Promise<import("@tmtp/domain").Recommendation[]>;
  getHnActionHistory(
    query: HnActionHistoryQuery,
    signal?: AbortSignal,
  ): Promise<import("@tmtp/domain").HnActionIntent[]>;
  getActivity(
    query?: ActivityHistoryQuery,
    signal?: AbortSignal,
  ): Promise<ActivityHistory>;
  setQueueState(
    storyId: import("@tmtp/domain").StoryId,
    state: import("@tmtp/domain").QueueState,
    signal?: AbortSignal,
  ): Promise<import("@tmtp/domain").QueueEntry>;
  refreshArticle(
    storyId: import("@tmtp/domain").StoryId,
    signal?: AbortSignal,
  ): Promise<import("@tmtp/domain").Job>;

  recordActivity(
    batch: readonly import("@tmtp/activity").RawActivity[],
    signal?: AbortSignal,
  ): Promise<import("@tmtp/personalization").RecordActivityResult>;
  getPreferences(
    signal?: AbortSignal,
  ): Promise<import("@tmtp/domain").PreferenceRule[]>;
  replacePreferences(
    rules: readonly import("@tmtp/domain").PreferenceRule[],
    signal?: AbortSignal,
  ): Promise<import("@tmtp/domain").InterestProfile>;
  rebuildPersonalization(
    reason: string,
    signal?: AbortSignal,
  ): Promise<import("@tmtp/domain").InterestProfile>;
  runPersonalization(
    signal?: AbortSignal,
  ): Promise<import("@tmtp/personalization").RecoverySummary>;

  getHnCapabilities(
    signal?: AbortSignal,
  ): Promise<import("@tmtp/hn-account").AccountCapability[]>;
  performHnAction(
    command: HnActionCommand,
    signal?: AbortSignal,
  ): Promise<import("@tmtp/hn-account").HnActionResult>;

  runIngestion(
    signal?: AbortSignal,
  ): Promise<import("@tmtp/hn-ingestion").IngestionSummary>;
  scheduleIngestion(
    signal?: AbortSignal,
  ): Promise<import("@tmtp/domain").Job>;
  reconcileHnAccount(
    signal?: AbortSignal,
  ): Promise<import("@tmtp/hn-ingestion").AccountReconciliationSummary>;
  scheduleHnReconciliation(
    signal?: AbortSignal,
  ): Promise<import("@tmtp/domain").Job>;

  runJob(
    job: import("@tmtp/domain").Job,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ReaderAppOptions {
  store: import("@tmtp/reader-store").ReaderStore;
  jobs: import("@tmtp/job-queue").JobQueue;
  articles: import("@tmtp/article-reader").ArticleReader;
  ingestion: import("@tmtp/hn-ingestion").HnIngestion;
  personalization: import("@tmtp/personalization").Personalization;
  account?: import("@tmtp/hn-account").HnAccount;
  queuePageSize: number;
  queueMaxPageSize: number;
  now: () => Date;
  createId: () => string;
}

export const readerAppJobCodecs:
  readonly import("@tmtp/job-queue").JobPayloadCodec[];

export function readerAppJobFailure(
  kind: import("@tmtp/domain").Job["kind"],
  error: unknown,
): import("@tmtp/job-queue").JobFailure;

export function readerAppBootstrapRankVersion(): "qb1.initial";

export function createReaderApp(options: ReaderAppOptions): ReaderApp;
```

Runtime exports are exactly `READER_APP_JOB_PAYLOAD_SCHEMA_VERSION`, `readerAppJobCodecs`, `readerAppJobFailure`, `readerAppBootstrapRankVersion`, `ReaderAppError`, and `createReaderApp`. Type exports are exactly the other names shown above. Internal cursor, manifest, action-activity, and transaction helpers are not public.

`readerAppBootstrapRankVersion` is a pure callback that returns `QUEUE_BOOTSTRAP_RANK_VERSION` exactly. The service passes the function itself as `hn-ingestion`'s `bootstrapRankVersion`; ingestion snapshots its value once. This preserves the `reader-app → queue` and `reader-app → hn-ingestion` edges without adding an `hn-ingestion → queue` edge.

## Construction and common boundaries

`createReaderApp` validates and snapshots options synchronously. Construction performs no storage, network, model, clock, ID-generation, timer, or listener work.

- Options reject unknown keys and malformed dependency shapes.
- `queuePageSize` and `queueMaxPageSize` are positive safe integers with `queuePageSize <= queueMaxPageSize`.
- `now` and `createId` are functions. `now` is called only when a command needs a timestamp and must return a valid `Date`; it is serialized as domain ISO UTC. `createId` is called only for a new HN intent and must return a non-empty string of at most 128 UTF-16 code units.
- Scalar options are copied. Dependencies and callbacks are borrowed; later mutation of the options object does not change behavior.
- Factory type/range failures throw `TypeError` or `RangeError` with a fixed field-identifying message. They never echo supplied values.

Every public method returns a Promise and validates runtime input before cancellation or side effects. A supplied signal must be an `AbortSignal`. Optional history limits default to `queuePageSize` and may not exceed `queueMaxPageSize`; this deliberately reuses the existing page policy rather than adding parallel reader-app history keys. IDs, reasons, idempotency keys, rules, batches, jobs, and cursor strings are validated at the application boundary even for statically typed callers.

Reader-app-owned pre-cancellation rejects with the exact `signal.reason`. Delegated operations retain their owners' cancellation outcomes: ingestion and article reads preserve exact reasons, while personalization may return a cancelled summary or throw its safe retryable cancellation error. The job boundary normalizes cancellation to `ReaderAppError("cancelled")`. No cancellation becomes a failed article, verified HN action, or synthetic activity event.

Once a synchronous store transaction begins it runs to commit or rollback without an `await`; commit is that write's linearization point. Abort cannot partially cancel SQL. After settlement the invocation starts no new external stage and owns no timer or listener.

## Complete queue queries across mixed rank versions

### Why one store page is insufficient

Before the first nonempty complete projection, initial ingestion rows use `QUEUE_BOOTSTRAP_RANK_VERSION`. Afterward, ingestion joins the active projection's rank version for new pending rows. Existing or legacy rows can still coexist across bootstrap and ranked versions, and story/article invalidation can change evaluation state while retaining a rank version until complete reprojection. Selecting only the active/newest ranked version hides bootstrap or other coexisting rows; selecting only bootstrap hides the ranked queue. A `reader-store.queue.page` query is intentionally scoped to one rank version, so reader-app must compose a complete page across all versions.

`getQueue` never infers a current rank version from the current profile, creation time, or a recommendation query. It discovers the actual queue rows.

### Manifest and deterministic group order

In one synchronous read transaction, read `store.queue.projection()` and exhaust `store.queue.forReprojection(afterStoryId, limit)` in story-ID keyset pages bounded by `queueMaxPageSize`. Build a manifest from **every** queue row, including rows excluded by the requested state/evaluation/visibility filters. The active pointer can order groups but can never exclude a discovered version. For each row retain only:

```text
storyId, rankVersion, evaluationState, rankPosition ?? null,
visibilityState, and state (actual state when query.state is supplied, null otherwise)
```

The manifest fingerprint is SHA-256 over canonical JSON `{ activeRankVersion: activeProjection?.rankVersion ?? null, rows: [...] }`, with rows in story-ID order and fixed property order. Including the pointer detects group-order changes even when no row changes. The fingerprint covers every ordering/version/filter-membership field but excludes timestamps, errors, scores, rationale, article content, and recommendation evidence. Reading-state changes do not invalidate an unfiltered continuation; they do invalidate a state-filtered continuation. Ranking, evaluation, visibility, row insertion/removal, and rank-version changes invalidate every continuation rather than silently skipping a version.

`rankVersions` contains every distinct manifest version in this deterministic page-group order:

1. the active projection's rank version first, when that pointer exists and names a discovered row;
2. every other non-bootstrap version, lexicographically ascending;
3. `QUEUE_BOOTSTRAP_RANK_VERSION`, when present, last.

This is a transitional completeness order, not a claim that scores are comparable across rank versions. Within each group the store supplies the canonical `scored → pending → failed` keyset order. A complete projection eventually returns the queue to one active group and its normal global ranking. Current ingestion then adds pending rows to that same group; the paginator still retains older/coexisting groups rather than assuming they cannot exist.

### Cross-version page assembly

For a cursorless query, start at the first group. For a continuation, decode the reader-app cursor, verify its filters and manifest fingerprint, and start at its embedded rank version/position. Fill the requested page by querying each group with the same state/evaluation/visibility filters:

- resume only the first group with the decoded position; later groups start at their beginning;
- use bounded store reads and, when needed, another keyset read in the same group to obtain `limit + 1` candidates without exceeding `queueMaxPageSize` per repository call;
- carry at most `limit + 1` entries in the page assembler, but continue discovery/group transitions until the existence of a following row is known;
- return the first `limit` entries and set `nextCursor` from the last returned entry only when another entry exists.

A page may cross a group boundary. Its continuation resumes after the last returned row in that row's group, then exhausts later groups. Concatenating all pages over an unchanged queue therefore yields exactly the canonical concatenation of all group pages, with no duplicates, omissions, offset drift, terminal cursor, or hidden rank version.

`evaluationCounts` comes from `store.queue.countsByEvaluationState({ visibilityState })` with no rank-version restriction and always includes explicit zero values for `pending`, `scored`, and `failed`. It describes the complete queue at the selected visibility, independent of state/evaluation page filters. `rankVersions` includes groups with no rows matching the filters, making the complete manifest visible to tests and diagnostics.

After assembling returned entries, the same synchronous read transaction calls `store.stories.byStoryIds` once with their IDs. `storyDetails` maps those records back into exact entry order and projects each through `resolveArticleOriginalTarget`, returning `{ story, originalUrl: target.url, fallback: { kind: target.kind, observationQuality: "partial" } }`. A missing required story is a safe store dependency-contract failure. Empty pages return an empty detail array and issue no story query. This additive batch read eliminates N+1 queue-card detail requests without adding article bodies or changing cursor/manifest/rank semantics.

### Reader-app cursor codec

The public cursor is opaque and versioned as `rqa1.payload.checksum`, using UTF-8 canonical JSON, unpadded base64url, and SHA-256 in the same spirit as queue `q1`. Its payload contains only:

```ts
{
  filters: {
    state: import("@tmtp/domain").QueueState | null;
    evaluationState: import("@tmtp/domain").EvaluationState | null;
    visibilityState: import("@tmtp/domain").VisibilityState;
  };
  manifestHash: string; // 64 lowercase hex characters
  after: string; // canonical queue q1 cursor for the last returned entry
}
```

The nested `after` is produced and consumed only through `queue.encodeQueueCursor`/`decodeQueueCursor`; reader-app does not duplicate that position codec. The outer codec rejects unknown/missing/reordered keys, alternate encodings, invalid UTF-8/JSON/base64url, bad checksums, invalid filter shapes, oversized input, and noncanonical payloads. Maximum outer cursor length is 4096 UTF-16 code units. The checksum is unkeyed integrity, not authentication or authorization.

Changing filters requires a cursorless query. Decode and validate the nested q1 cursor and its evaluation-section compatibility before manifest discovery or page SQL. A malformed/filter/section-mismatched cursor is `invalid-cursor`; an otherwise valid cursor whose complete manifest fingerprint no longer matches is `stale-queue-cursor`. Both require an explicit fresh first page. No fallback silently selects one version.

## Story detail, fallback, history, and reading state

`getStory` is a read-only cached-detail query. It performs no article fetch and enqueues no work. In one synchronous read transaction it loads the story, optional article, required queue entry, and the recommendation identified by `queueEntry.recommendationId`. It never substitutes `recommendations.latestForStory` for that exact explanation. A missing story is `not-found`; a missing queue row or linked recommendation is a safe store dependency-contract failure, not a reason to invent detail state.

A stale ready article remains available for embedded reading while a replacement job is pending. Pending/failed articles and absent articles remain explicit. Reader-app calls `article-reader.resolveArticleOriginalTarget(story)` and assigns `originalUrl=target.url` and `fallback.kind=target.kind`. That one owner validates/normalizes credential-free absolute HTTP(S), strips fragments, and otherwise supplies the exact HTTPS HN discussion permalink. Reader-app never substitutes redirect `finalUrl`, canonical URL, or an unsafe source.

`fallback.observationQuality` is always `partial`. Fallback navigation is a client/user action, never an automatic fetch or redirect. Reader-app adds no markup or trust exception; article sanitization remains with `article-reader`, and service CSP remains mandatory.

`getRecommendationHistory` delegates the bounded `(createdAt,id)` keyset query for one existing story. `getActivity` performs independent bounded event and session reads. Optional `clientEventId` filters events by `clientEventId` and sessions by `lastClientEventId`; `afterEventId` resumes ascending activity sequence and `afterSessionId` resumes ascending `(updatedAt,id)`, so the two IDs/cursors cannot be interchanged. Unknown or filter-mismatched continuation IDs are invalid input. `getHnActionHistory` delegates `historyForStory(storyId, afterId, limit)` for one existing story and returns one bounded ascending `(createdAt,id)` intent page. An unknown/cross-story `afterId` is invalid input rather than a continuation from unrelated history. No history method returns unbounded arrays or raw repository cursor internals.

`setQueueState` validates the story ID/state, reads the current queue entry, and applies `queue.transitionQueueState` in one synchronous write transaction. The timestamp is the current clock value moved forward only as needed to equal the entry's `updatedAt`; reading time never moves backward. It persists through `queue.updateState` and returns the stored entry. Same-state requests preserve `updatedAt`. Disallowed transitions are `invalid-transition`; missing rows are `not-found`. The method does not fabricate a dismiss/skip activity event—clients submit explicit observations through `recordActivity` with stable client IDs.

## Activity, preferences, and personalization

- `recordActivity` passes the complete batch and identical signal to `personalization.recordActivity` and returns its full `{ accepted, profileWorkEnqueued }` result. Reader-app does not split mixed-story batches, open a second transaction, regenerate client IDs, or call the reducer directly. Event/session/job atomicity and replay behavior remain with personalization/activity.
- `getPreferences` returns a fresh canonical rule list from `store.preferences.list` in a synchronous read transaction.
- `replacePreferences` delegates the complete rule array and signal to `personalization.applyPreferenceChange`. Validation, canonical rule replacement, immutable profile selection, immediate blacklist projection, and score-job handoff commit in the owning transaction. Reader-app performs no LLM work and no separate preference write.
- `rebuildPersonalization` delegates `reason` and signal to `personalization.rebuildProfile` and returns the selected immutable profile.
- `runPersonalization` delegates to `personalization.recover` and returns the complete `RecoverySummary`, including `completion`, `rebuilt`, scoring/failure/retry/audit counts, and complete projected count. It does not reduce this to a lossy three-field result.

Natural/account activity never causes reader-app to call an LLM synchronously. Durable personalization jobs perform later work.

## Explicit HN actions and account reads

### Capabilities and reconciliation

Without an account adapter, `getHnCapabilities` returns all four names in canonical order (`upvoted`, `favorites`, `flagged`, `mutations`) with `state="unavailable"` and `reason="capability-disabled"`. This is local configuration evidence, not a live HN probe. With an adapter, delegate `capabilities(signal)` unchanged. `performHnAction` without an adapter rejects `account-not-configured` before creating or executing an intent; an already terminal stored result can still replay without account access.

`runIngestion` returns the complete public `IngestionSummary`. `reconcileHnAccount` returns the complete `AccountReconciliationSummary`, including capabilities, skipped unknown stories, and activity handoff counts. Both pass the identical signal to `hn-ingestion`. Neither method calls `performAction`; reconciliation is read-only current-state observation.

`scheduleIngestion` and `scheduleHnReconciliation` are the scheduler-facing durable entry points. In one synchronous transaction each calls `jobs.enqueue(createHnIngestionJobEnqueue({ kind, payload: {}, runAfter: now().toISOString() }))` and returns the inserted or active-deduped job. Their kinds are respectively `ingestion.collect` and `ingestion.reconcile-account`; payloads are empty version-1 objects and fixed-kind dedupe coalesces overlapping ticks. Scheduling reconciliation requires the configured account before enqueue. These methods never invoke HN directly. The in-memory scheduler calls them at cron instants, and the ordinary worker later executes the job through `runJob`.

### Intent transaction before any external call

`performHnAction` is the only reader-app operation that invokes `account.performAction`, and it requires an explicit `HnActionCommand`. Idempotency keys are exact non-whitespace strings of 1–128 UTF-16 code units with no control characters; they are not echoed in errors.

A per-instance single-flight map covers the complete command by idempotency key. An identical concurrent command joins one execution. The same key with a different story/action rejects `conflict` without joining or calling HN. The entry is removed in `finally` and is not a durable result cache.

The first caller is the leader and its identical signal drives the shared account operation. Every caller has an independent abortable wait. A later caller's post-join abort rejects only that wait with its exact reason; shared work and outcome persistence continue for the other callers. A leader abort also reaches the account adapter: before outcome settlement the leader receives its exact reason, while joined callers receive safe retryable `ReaderAppError("cancelled")` rather than another caller's reason. A retry then follows the durable pending/indeterminate reconciliation-first path. After dispatch, leader cancellation still produces and persists the adapter's indeterminate outcome even though the leader's own wait has rejected. Every per-caller listener is removed on abort or settlement.

The command then performs one synchronous intent transaction:

1. Require the story to exist.
2. Read `hnActions.byIdempotencyKey`; conflicting story/action reuse is `conflict`.
3. If no intent exists, require an account adapter before creating anything, then create `{ id: createId(), storyId, action, idempotencyKey, status: "pending", createdAt, updatedAt }` and commit it. If an existing intent is pending/indeterminate, require an adapter before the external stage; terminal results may replay without one.
4. Return the stored intent for the next stage.

No account call, capability probe, throttle wait, or Promise occurs in this transaction. A crash after commit leaves an auditable pending intent. Pending means no outcome was durably recorded; it is not proof that no POST occurred.

An existing `verified` or `failed` intent replays without another external call. Version-1 stored evidence has two accepted shapes: the exact adapter-produced `HnActionResult`, or reconciliation evidence `{ source: "hn-reconciliation", observedAt }` on a verified intent. Validate shape, status, and intent ID, then normalize either shape to a fresh public `HnActionResult`; reconciliation uses the durable intent ID/status and stored observation time. A verified replay also performs the verified-activity ensure transaction below, because reconciliation can verify an intent without creating its app-action handoff. A failed replay performs no new work. A new attempt after a failed outcome requires a new user idempotency key. A `pending` or `indeterminate` intent is passed unchanged to `account.performAction`; the adapter always re-reads fresh state before any POST, so retry is reconciliation-first rather than blind.

### Outcome transaction after the external call

The account call runs with no open store transaction. Once it has been invoked, reader-app awaits its settled outcome and persists that outcome even if caller cancellation is also observable. `hn-account` owns the conservative dispatch boundary and returns `cancelled-after-dispatch`/`post-outcome-unknown` as indeterminate where required.

For reader-app's own account attempts, version-1 intent `result` is the exact safe `HnActionResult` object and `resultSchemaVersion=1`. Reconciliation's distinct version-1 evidence shape remains valid and is normalized only when read. `updatedAt` is monotonic against the prior intent timestamp; `observedAt` inside the result remains the adapter/reconciliation observation time.

Outcome state rules are:

- pending + verified/failed/indeterminate → persist that terminal attempt state;
- indeterminate + verified/indeterminate → persist the enriched/current indeterminate-or-verified outcome;
- indeterminate + failed → preserve `status="indeterminate"`, retain the latest safe error code/observation time, and never convert an earlier uncertain dispatch into a definite failure;
- verified/failed → replay only, as above.

For a verified outcome, the same outcome transaction ensures one `personalization.record-activity` handoff. A verified replay after reconciliation uses the same helper in its own synchronous transaction. The helper derives the client ID, queries `store.activity.query({ clientEventId, limit: 1 })`, and enqueues only when no event exists. An existing active handoff is a successful dedupe hit; an absent event with an exhausted old job can receive a new durable handoff. Its one-row batch is:

```ts
{
  clientEventId: base64url(SHA256("tmtp/hn-action-activity/1\0" + intent.id)),
  storyId: intent.storyId,
  kind: intent.action,
  source: "app-action",
  value: { present: true },
  occurredAt: outcome.observedAt,
}
```

The timestamp records when the explicit action's verified local outcome was established, not a claim about HN's application time. The derived 32-byte ID is stable across process/job retries. The job's `dedupeKey` is exactly `clientEventId`, `runAfter=outcome.observedAt`, and payload schema version is 1. Outcome update and initial activity handoff commit or roll back together; replay ensure is idempotent through the event query plus active-job dedupe. Failed and indeterminate outcomes enqueue no app-action activity. Reconciliation's own partial current-state activity remains useful before any later explicit replay ensures the app-action handoff.

If that transaction fails after external verification, the prior intent remains pending/indeterminate and a retry re-reads HN before doing anything else. If it commits but job completion later fails, the durable activity identity makes handler replay idempotent. Reader-app never converts list absence or an indeterminate result into positive activity.

## Article refresh and `article.fetch-extract`

`refreshArticle` reads the current story and enqueues the canonical version-1 article job in one synchronous transaction:

```ts
{
  kind: "article.fetch-extract",
  payloadSchemaVersion: 1,
  payload: {
    storyId: story.id,
    storyContentVersion: story.contentVersion,
  },
  dedupeKey: `${story.id}:${story.contentVersion}`,
  runAfter: now().toISOString(),
}
```

It returns the inserted or existing active job. It performs no fetch itself and creates no forced-refresh payload variant. Explicit refresh means ensure current source/pipeline content; an already-current ready article is a successful no-op in the handler.

The article handler performs this sequence:

1. Validate the claimed job and payload. Load the current story; a missing story is non-retryable `not-found`. If `story.contentVersion !== payload.storyContentVersion`, return successfully without reading or writing—the payload is stale.
2. Load the current article and query `store.articles.needingContent({ extractorVersion: ARTICLE_READER_VERSION, afterStoryId: story.id - 1, limit: 1 })`. The target needs work exactly when the first returned story has the target ID.
3. If no work is needed, return successfully, except when the existing article is a terminal `failed` record for the same source version and its attempted `extractorVersion=ARTICLE_READER_VERSION`. That exception allows the active durable job to retry a current-pipeline retryable extraction failure; `needingContent` deliberately does not select such a failed row again merely because it failed. A stale-pipeline failed record is already eligible through the query.
4. Call `articles.read(storySnapshot, signal)` outside every transaction. The reader owns URL/self-text dispatch, safe fetch/extract, terminal article versions, expected failure metadata, and `originalUrl` for that attempt.
5. In a short store transaction, first re-read the current article. If it is already ready for the same source and `ARTICLE_READER_VERSION`, discard this duplicate attempt and return success without upserting or reporting its failure. Otherwise persist only through `store.articles.upsert`. Its commit-time comparison of `article.sourceContentVersion` with the current story remains authoritative for source freshness. `stale-source` discards the complete attempt with no article/queue write and returns job success. `applied` commits the article and store-owned stale-evaluation invalidation. The ready guard makes a newer same-source ready result win over an older stale-lease failure.
6. An applied ready outcome returns success. An applied failed outcome throws `ReaderAppError("article-attempt-failed")` **after commit**, with `retryable=failure.retryable` and safe `dependencyCode=failure.code`. The failed article remains durable while job-queue applies bounded retry/backoff or terminal failure. Retryability is not persisted as an invented article field.

A current ready article with the same source and `ARTICLE_READER_VERSION` is not fetched again on an at-least-once replay. Concurrent readers may repeat work; the conditional upsert prevents an older source from overwriting a newer story attempt, and the commit-time ready guard prevents an older same-source attempt from replacing an already committed current-pipeline ready result. Cancellation rejects without saving a synthetic failed article; at the job boundary it becomes safe retryable `cancelled` after any already-returned durable outcome is handled.

## Central codecs, dispatch, and worker lease boundary

`readerAppJobCodecs` is the single service registry for exactly eight kinds, in this order:

1. `article.fetch-extract`;
2. `personalization.record-activity`;
3–4. the two codecs from `hnIngestionJobCodecs`, without copying their payload or dedupe rules;
5–8. the four codecs from `personalizationJobCodecs`, without copying their payload or dedupe rules.

The article codec accepts only `{ storyId, storyContentVersion }` at version 1, with a safe positive story ID and non-empty bounded source version. The activity codec accepts only `{ batch: [oneRawActivity] }` at version 1 and calls `activity.parseActivityBatch` so kind/source/value, one-story, identity, and timestamp rules are exact. It supports both structural producers: ingestion's `hn-reconciliation` row without `occurredAt`, and reader-app's verified `app-action` row with it. Codecs return fresh payloads and never include payload text in errors.

`runJob` receives an already claimed, already decoded leased job. It validates the domain job, supported kind, current payload version, leased shape, and codec output again. Dispatch is:

- `article.fetch-extract` → the article pipeline above;
- `personalization.record-activity` → `personalization.recordActivity(payload.batch, signal)`;
- `ingestion.collect` → `ingestion.collectPublic(signal)`;
- `ingestion.reconcile-account` → `ingestion.reconcileAccount(signal)`;
- each of the four personalization kinds → `personalization.runJob(job, signal)` with the decoded current payload.

A stale article/profile job returns success rather than executing historical input. No handler calls `jobs.claim`, `renew`, `complete`, `fail`, or `recoverExpired`; no handler owns a lease token or schedules a heartbeat.

The service worker claims `readerAppJobCodecs.map(codec => codec.kind)` and branches on `claim.status`. Only `leased` proceeds: the worker renews before lease expiry, invokes `runJob(claim.job, signal)` only after the claim transaction commits, then completes or fails with the same job ID/token. It uses `readerAppJobFailure(job.kind, error)` for safe handler failure text. The mapper accepts the domain's plain string kind; an unsupported kind returns non-retryable `invalid-job` without inspecting the error, while supported kinds use the tables below. No cast or unchecked narrowing is required.

`rejected` is an expected contained queue outcome, not a reader-app handler failure or readiness failure. Job-queue has already committed the selected job's terminal `invalid-payload` transition; the worker invokes no handler and calls no renew/complete/fail operation or failure mapper for it. It may continue polling under the service's normal policy. `idle` likewise invokes no handler and means no eligible job and no rejection.

For the article kind, `article-attempt-failed` is handled before the generic facade catch-all so its safe dependency code is preserved:

| Article error | Job failure code | Retryability |
|---|---|---|
| `article-attempt-failed` with valid `dependencyCode` | `article:<dependencyCode>` | copied from the error |
| `article-attempt-failed` without one | `article-attempt-failed` | copied from the error |

For every kind, all remaining facade errors are classified before any owner mapper:

| Facade error | Job failure code | Retryability |
|---|---|---|
| `invalid-job` | `invalid-job` | false |
| `not-found` | `not-found` | false |
| `cancelled` | `cancelled` | true |
| `dependency-failure` | `reader-app:dependency-failure` | copied |
| `internal-failure` | `reader-app-failed` | true |
| Any other `ReaderAppError` | `reader-app:<code>` | copied |

Only non-facade errors then delegate: `personalization.record-activity` and the four personalization kinds use `personalizationJobFailure`, and the two ingestion kinds use `hnIngestionJobFailure`. Thus a facade validation/cancellation error cannot become a retryable owner-generic failure.

For the article kind, any remaining unknown error maps to `{ code: "reader-app-failed", retryable: true }`.

Messages are the fixed application/generic texts, never dependency messages. Validation/not-found errors therefore keep stable non-generic terminal codes, while unexpected/internal worker failures use the documented retryable generic mapping.

Lease loss is an expected worker outcome, not permission to undo committed application effects. A stale worker's completion/failure is rejected by job-queue; immutable records, activity replay, conditional article upserts, and current-profile checks make a later attempt safe. External HN/LLM/article calls remain at-least-once, never exactly-once.

## Safe errors

`ReaderAppError.message` is fixed by `code`. Consumers branch on `code`, `operation`, `retryable`, and allowlisted metadata, never message text. `dependencyCode` is a bounded lowercase kebab-case identifier. `field`, story/job IDs, operation, and dependency names are safe context.

| Code | Fixed message | Retryability |
|---|---|---|
| `invalid-options` | `Reader application options are invalid.` | false |
| `invalid-input` | `Reader application input is invalid.` | false |
| `not-found` | `Reader application resource was not found.` | false |
| `conflict` | `Reader application command conflicts with stored state.` | false |
| `invalid-cursor` | `Reader application cursor is invalid.` | false |
| `stale-queue-cursor` | `Reader queue changed; restart pagination.` | false |
| `invalid-transition` | `Reader queue state transition is invalid.` | false |
| `account-not-configured` | `HN account integration is not configured.` | false |
| `article-attempt-failed` | `Article extraction attempt failed.` | copied from `ArticleReadFailure.retryable` |
| `invalid-job` | `Reader application job is invalid.` | false |
| `dependency-failure` | `Reader application dependency operation failed.` | copied from safe dependency metadata, otherwise false |
| `cancelled` | `Reader application operation was cancelled.` | true |
| `internal-failure` | `Reader application failed unexpectedly.` | false at direct boundaries; generic worker mapping is retryable |

Expected lower-library errors are mapped with their safe code/retryability and no public cause. Expected HN action failures/indeterminate outcomes are returned and persisted, not thrown as infrastructure errors. Unexpected direct exceptions become `internal-failure`; unexpected worker exceptions use the generic retryable job mapping above. Exact caller abort reasons are never serialized.

No public error or job failure contains a URL, cursor payload, idempotency key, cookie, username, CSRF/form field, story title/HTML, article text, preference value, prompt/profile payload, raw activity value, job payload/lease token, provider/parser/database message, stack projection, or abort reason. `ReaderAppError` has no public `cause`; lower errors with optional causes are never exposed directly by the facade.

## Transactions, concurrency, and lifecycle

| Boundary | Atomic contents | External work |
|---|---|---|
| Queue/detail/history read | One consistent synchronous snapshot | None |
| Queue state | Read entry + pure transition + state update | None |
| Article refresh | Current story read + deduped enqueue | None |
| Ingestion schedule | Canonical empty-payload enqueue with fixed-kind active dedupe | At worker execution only |
| HN intent | Story/key reads + pending intent insert | After commit only |
| HN outcome | Current intent recheck + outcome update + verified activity-job enqueue | Before transaction only |
| Article result | Conditional source compare + article upsert + queue invalidation | Before transaction only |
| Activity/preference/personalization | Owning personalization transaction | Never added by reader-app |
| Ingestion/reconciliation | Owning ingestion transaction | Never added by reader-app |

The store and job queue must share one SQLite connection so nested savepoints join these outer transactions. No transaction returns a Promise or invokes HN, article fetch/extraction, an LLM, a timer, or a job handler.

Reader-app has no global command lock. It relies on one action single-flight map, ingestion's operation lane, personalization's profile pipeline lock, account's serial/throttled lane, and synchronous store transactions. Article calls may be concurrent; durable source checks choose the winner. Independent instances/processes do not share in-memory coordination and are outside the supported writer topology.

`ReaderApp` has no `close` method and owns no socket, database, timer, worker, scheduler, or abort controller. The service stops claims/schedules, cancels active work, drains within its grace period, and closes borrowed resources in reverse composition order.

## Internal subcomponents

- Strict options/input/error/cancellation and timestamp/identity helpers.
- Complete queue-manifest discovery, cross-version page assembler, and `rqa1` cursor codec.
- Cached story/fallback/history read models and queue-state command.
- Activity/preference/personalization delegates.
- Explicit HN intent/outcome coordinator and verified-activity handoff.
- Article eligibility/read/conditional-upsert/retry coordinator.
- Eight-codec registry, central job dispatcher, and safe worker-failure mapper.

The private module and data-flow design is specified in [arch.md](arch.md). Only the API above is public.

## Dependencies on other libs

- `activity` — strict durable raw-activity payload validation.
- `article-reader` — `ArticleReader` outcomes and `ARTICLE_READER_VERSION` eligibility.
- `domain` — records, schemas, IDs, timestamps, states, and job envelopes.
- `hn-account` — optional capabilities and explicit action execution/outcomes.
- `hn-ingestion` — public collection/reconciliation compositions plus their scheduling codecs, enqueue factory, and worker-failure mapping.
- `job-queue` — codec registry, durable enqueue/dedupe, and safe worker failure DTOs.
- `personalization` — activity, profile/preference, recovery, four job handlers/codecs, and failure mapping.
- `queue` — transitions, inner cursor codec, and bootstrap rank-version constant.
- `reader-store` — synchronous snapshots, repositories, and transactions.

Node crypto supplies SHA-256 for cursor/manifest/activity identities. Platform `URL`, `AbortSignal`, and the injected `now`/`createId` functions add no workspace dependency. There is no direct `clock`, `database`, `config`, `http-client`, `recommendations`, `interests`, `llm-interface`, framework, UI, or service import. Lower-tier clients are reached only through the declared compositions.

## New build or OSS wrapper

New TypeScript composition over existing workspace libraries and Node built-ins. No third-party runtime dependency is added.

## Hosted by

`services/personal-reader`, which owns HTTP, authentication, static UI, scheduling, worker polling/heartbeats, startup, shutdown, and secret loading. The service registers all eight codecs before constructing job-queue, calls the two schedule methods from cron callbacks, supplies `readerAppBootstrapRankVersion` to ingestion, uses the same store/job database, and constructs the optional account with its dedicated no-retry HTTP client.

## Configuration

Reader-app reads no configuration source and adds no configuration key.

| Existing key | Reader-app option | Required / default and use |
|---|---|---|
| `queue.page_size` | `queuePageSize` | Optional at service layer, default `50`; default queue/history page size |
| `queue.max_page_size` | `queueMaxPageSize` | Optional at service layer, default `200`; maximum queue/history request and individual repository read size |

`systemClock.now` is supplied as `now`; a cryptographically random application ID generator is supplied as `createId`. These are composition capabilities, not operator keys. `ARTICLE_READER_VERSION`, `QUEUE_BOOTSTRAP_RANK_VERSION`, payload schema version 1, the 4096-unit outer-cursor bound, and SHA-256 namespaces are fixed contracts, not configuration.

Article fetch/extraction, HN/public/account, ingestion, personalization, activity, queue ranking, job lease/retry/backoff, and debug policy remain with their owners. In particular, reader-app adds no transaction timeout, action retry loop, queue retention cap, rank-version selector, or hidden page limit.

## Acceptance-focused test expectations

Use the public package root with real temporary SQLite for store/job composition, a fixed `now`, deterministic `createId`, scripted article/account/LLM adapters, and transaction/request journals. Reopen the database for restart tests. No live HN or provider is required.

### API, dependencies, validation, and errors

- `should export exactly the eight-kind codec registry application factories callback errors and documented types without framework imports`.
- `should preserve the manifest dependency set and prove bootstrap callback returns QUEUE_BOOTSTRAP_RANK_VERSION exactly`.
- `should validate and snapshot options limits signals IDs commands jobs and histories before side effects without value echo`.
- `should map every expected dependency error with fixed safe operation dependency retryability and correlation fields`.
- `should keep cursor idempotency URL cookie HTML activity job prompt database and abort sentinels out of public and persisted errors`.
- `should preserve exact reasons at reader-app-owned checkpoints and for dependencies that promise them, preserve personalization's cancelled summary/error behavior, and normalize job cancellation to safe retryable cancelled`.

### Complete mixed-version queue

- Build bootstrap plus multiple ranked versions with scored/pending/failed rows and more entries than two pages. Concatenate pages and independently compare the complete ordered story/version tuples; assert no version or row is hidden.
- Cross a rank-version boundary at exact, short, full, and empty-filter pages. Verify nested q1 positions resume strictly after the last returned row and no terminal cursor is emitted.
- Verify deterministic non-bootstrap/bootstrap group order, canonical store section order within each group, complete zero-filled evaluation counts across versions, and groups with no filter matches.
- Prove state/evaluation/visibility filters remain bound to the cursor, changing them requires a fresh page, and malformed/noncanonical/checksummed cursor inputs fail safely.
- Change any row's version/evaluation/rank/visibility, change the active projection pointer, insert/remove a row, or change filtered reading state between pages and assert `stale-queue-cursor` rather than omission. Change unfiltered reading state/timestamps only and assert continuation remains valid.
- Re-rank to one complete version and compare reader-app pages with pure `queue.paginateQueue`/store order. Restart after every page and prove identical results.
- Verify `storyDetails` uses one bounded batch story read, exactly matches entry order on group-crossing/empty pages, projects safe original targets, and fails safely rather than substituting a missing story.

### Story, fallback, state, and history

- `should load one consistent story article queue and exact linked recommendation snapshot without latest-recommendation substitution or network work`.
- `should retain stale ready content and expose pending failed and missing article states without hiding the story`.
- `should normalize safe original HTTP(S) URLs strip fragments reject credentials and use the fixed HN permalink for self-text malformed or unsafe sources`.
- `should mark every original-page or discussion fallback partially observed and never navigate fetch or sanitize in reader-app`.
- `should apply every queue transition monotonically preserve no-op timestamps and avoid implicit activity`.
- `should page recommendation activity HN-intent and session histories independently within configured bounds apply clientEventId to event and lastClientEventId streams resume each correct keyset and reject missing stories interchanged IDs or cross-story cursors`.

### Activity, preferences, and personalization delegates

- `should return accepted and profileWorkEnqueued unchanged and preserve replay identity across direct and job-driven activity retries`.
- `should never split a mixed-story batch or invoke activity reduction outside the personalization transaction`.
- `should apply preference replacement profile selection immediate blacklist projection and scoring handoff atomically through the real composition`.
- `should preserve the complete recovery summary and cancellation outcome without synchronous LLM work in reader-app`.

### Explicit HN actions and reconciliation

- Journal transactions and the fake account. Prove every new intent commits before the first account call and every returned outcome commits after it; no account call occurs while a transaction is open.
- Exercise crash points before intent commit, after intent commit, after POST settlement, after outcome commit, and after activity-job commit. Retry/reconcile and verify no blind POST, lost outcome, duplicate intent, or duplicate logical activity.
- `should join identical concurrent commands reject conflicting key reuse and serialize different account operations through the real account lane`.
- `should replay adapter and reconciliation-verified results plus failed results without another account call, normalize reconciliation evidence safely, ensure verified replay activity, permit terminal replay without an account, reject new/pending execution without one, and require a new key for a new failed attempt`.
- `should isolate joined-caller cancellation, define leader cancellation before and after dispatch, avoid sharing abort reasons across callers, and remove every wait listener`.
- `should re-read pending and indeterminate intents before retry and preserve indeterminate when a later pre-dispatch attempt fails`.
- `should enqueue exact stable verified app-action activity in the outcome transaction and none for failed or indeterminate outcomes`.
- `should preserve cancelled-after-dispatch and post-outcome-unknown outcomes and never infer success from HTTP status or list absence`.
- `should return synthetic unavailable capabilities without an account and complete live capabilities/reconciliation summaries with one`.
- `should enqueue canonical durable public and account scheduling jobs coalesce active ticks reject account scheduling when unconfigured and make no direct HN call`.
- `should make public collection and account reconciliation read-only with respect to HN mutations and retain stable ingestion activity client IDs across worker retries`.

### Article jobs and conditional persistence

- `should pass ARTICLE_READER_VERSION to needingContent and no-op a current ready replay without another read`.
- `should execute missing pending stale-source-version stale-ready-and-failed-reader-version and current-pipeline failed retry work with the exact story snapshot and signal`.
- `should no-op a stale payload and discard a commit-time stale-source result without article failure queue write or retry`.
- `should persist ready and failed outcomes through conditional upsert before reporting job success or failure and apply store-owned queue invalidation once`.
- `should preserve retryable versus terminal article job decisions after the failed outcome commits and never persist retryability as article content`.
- `should make cancellation produce no synthetic failed article and unknown infrastructure failures produce no misleading remote failure`.
- Interleave two source versions and prove the older result cannot overwrite the newer one. Commit a newer same-source ready attempt before an older failed attempt and prove the ready guard discards the stale failure. Recover an expired lease after commit and prove a duplicate handler has no duplicate logical effect.

### Codecs, dispatch, leases, and workflow recovery

- Validate all eight codecs, exact payload shapes, version rejection, fresh outputs, and poison-job safety. Compare the two ingestion and four personalization codec objects/behavior with their owners rather than maintaining duplicate fixtures.
- Dispatch record-activity, both ingestion kinds, and each personalization kind exactly once with decoded payload/signal; dispatch article work only to the article coordinator. Assert no handler invokes any lease method.
- Run a real worker claim/renew/complete/fail/recoverExpired loop around the handlers, branching on `claim.status`, and verify only `leased` reaches `runJob`. Inject stale tokens and verify application commits survive while stale lease transitions fail safely. Assert `rejected` is an expected contained queue outcome with no handler, lease operation, reader-app failure mapping, or readiness failure, and `idle` runs no handler. Assert exact ingestion dispatch, terminal `invalid-job` for an unsupported mapper kind without inspecting its error, and the persisted failure code/message/retryability for every known application/owner-error row and unknown error.
- Assert no article/HN/LLM Promise runs inside a store transaction and all result/intent/activity handoffs roll back atomically on injected write failures.
- For WF-02/WF-03/WF-07, ingest before first projection to establish bootstrap rows, project, then ingest again and prove new pending rows join the active rank. Separately seed mixed bootstrap/ranked legacy rows, restart, process every job kind, and prove complete queue reachability and idempotent recovery. For WF-04/WF-05/WF-06, verify cached reading/fallback, natural and explicit activity, immediate preference visibility, and preserved explanations despite later job failure.
