# Hacker News Ingestion Library Spec

## Purpose and responsibility

Coordinate bounded, checkpointed public-story collection, changed-item refresh, and optional account-state reconciliation. Own ingestion planning, observation timestamps, initial queue projection, durable run records, and atomic handoffs to article and personalization work. Keep all external HN calls outside database transactions.

This package does not own schedules, HTTP transport or retry policy, story normalization algorithms, recommendation scoring, complete queue ranking, reading-state transitions, activity reduction, secret files, or process lifecycle. It preserves the existing dependency graph: in particular, it has no runtime or type-only dependency on `queue` or `activity`.

## Public interface / API surface

The package root is `@tmtp/hn-ingestion`. It has no default export or subpath exports.

```ts
export interface IngestionSummary {
  runId: string;
  highestSeenItemId: number;
  storiesUpserted: number;
  nonStoriesSkipped: number;
  jobsEnqueued: number;
}

export interface AccountReconciliationSummary {
  runId: string;
  observations: number;
  skippedUnknownStories: number;
  activityJobsEnqueued: number;
  capabilities: import("@tmtp/hn-account").AccountCapability[];
}

export interface HnIngestionOptions {
  api: import("@tmtp/hn-public-api").HnPublicApi;
  account?: import("@tmtp/hn-account").HnAccount;
  store: import("@tmtp/reader-store").ReaderStore;
  jobs: import("@tmtp/job-queue").JobQueue;
  clock: import("@tmtp/clock").Clock;
  bootstrapRankVersion: () => string;
  feeds: readonly import("@tmtp/domain").HnFeed[];
  initialLookbackItems: number;
  maxItemsPerRun: number;
  refreshBatchSize: number;
  refreshAfterHours: number;
}

export interface HnIngestion {
  collectPublic(signal?: AbortSignal): Promise<IngestionSummary>;
  reconcileAccount(signal?: AbortSignal): Promise<AccountReconciliationSummary>;
}

export const HN_INGESTION_JOB_PAYLOAD_SCHEMA_VERSION: 1;

export type HnIngestionJobKind =
  | "ingestion.collect"
  | "ingestion.reconcile-account";

export interface HnIngestionJobPayload {}

export interface HnIngestionJobDescription {
  kind: HnIngestionJobKind;
  payload: HnIngestionJobPayload;
  runAfter: import("@tmtp/domain").IsoDateTime;
}

export const hnIngestionJobCodecs:
  readonly import("@tmtp/job-queue").JobPayloadCodec[];

export function createHnIngestionJobEnqueue(
  description: HnIngestionJobDescription,
): import("@tmtp/job-queue").JobEnqueue;

export function hnIngestionJobFailure(
  error: unknown,
): import("@tmtp/job-queue").JobFailure;

export type HnIngestionOperation = "collect-public" | "reconcile-account";

export type HnIngestionDependency =
  | "hn-public-api"
  | "hn-account"
  | "interests"
  | "reader-store"
  | "job-queue";

export type HnIngestionErrorCode =
  | "invalid-configuration"
  | "invalid-input"
  | "invalid-checkpoint"
  | "account-not-configured"
  | "upstream-failure"
  | "persistence-failure"
  | "job-handoff-failure"
  | "internal-failure";

export class HnIngestionError extends Error {
  readonly name: "HnIngestionError";
  readonly code: HnIngestionErrorCode;
  readonly operation: HnIngestionOperation;
  readonly retryable: boolean;
  readonly runId?: string;
  readonly dependency?: HnIngestionDependency;
  readonly dependencyCode?: string;
  constructor(
    code: HnIngestionErrorCode,
    options: {
      operation: HnIngestionOperation;
      retryable: boolean;
      runId?: string;
      dependency?: HnIngestionDependency;
      dependencyCode?: string;
    },
  );
}

export function createHnIngestion(options: HnIngestionOptions): HnIngestion;
```

Runtime exports are exactly `HN_INGESTION_JOB_PAYLOAD_SCHEMA_VERSION`, `hnIngestionJobCodecs`, `createHnIngestionJobEnqueue`, `hnIngestionJobFailure`, `createHnIngestion`, and `HnIngestionError`. Type exports are exactly the other names shown above. Internal checkpoint and fetch-pool types are not public package exports.

The two ingestion job codecs accept only an empty object at payload schema version 1 and return a fresh empty object. `createHnIngestionJobEnqueue` strictly validates the three-field description, supported kind, empty payload, and domain run time; malformed descriptions throw a fixed value-free `TypeError`. It preserves kind/run time, emits payload schema version 1, and uses the kind itself as `dedupeKey`; therefore only one active job of each operation exists and a completed/failed run does not block a later schedule. `reader-app` owns enqueue/dispatch composition: `ingestion.collect` calls `collectPublic`, and `ingestion.reconcile-account` calls `reconcileAccount`. Direct methods remain available for explicit manual runs. Neither job handler performs lease operations.

`hnIngestionJobFailure` uses fixed safe messages and this exhaustive mapping:

| Error | Job failure code | Retryability |
|---|---|---|
| `invalid-configuration`, `invalid-input`, `invalid-checkpoint`, `account-not-configured` | `ingestion:<code>` | false |
| `upstream-failure` with safe `dependencyCode` | `ingestion:<dependencyCode>` | copied |
| `upstream-failure` without one | `ingestion:upstream-failure` | copied |
| `persistence-failure`, `job-handoff-failure` | `ingestion:<code>` | copied |
| `internal-failure` or unknown error | `ingestion-failed` | true |

Known rows use the corresponding fixed messages from the public error table below; the generic row uses exactly `HN ingestion job failed.` Reader-app normalizes arbitrary direct-call abort reasons to its safe retryable `cancelled` before invoking this mapper. No payload, cursor, URL, account value, dependency message, or abort reason enters a job failure.

`nonStoriesSkipped` is an ingestion-outcome counter, not a claim about an upstream item's `type`. It counts unique fetched candidates that produced no story upsert: JSON `null`, a known non-story, or an item for which `normalizeStory` cannot produce a complete story without inventing data. `storiesUpserted` counts unique normalized stories in the committed batch, including a refresh whose content version is unchanged. `jobsEnqueued` counts only calls for which `JobQueue.enqueue` returns `inserted=true`; an active dedupe hit is already a durable handoff and is not counted again.

`highestSeenItemId` is the high-watermark target associated with the public collection checkpoint after the call. It is the saved bootstrap target while bootstrap is incomplete, or the greater of the durable advance cursor and latest official `maxitem` after an advance run. It does not claim that every lower ID has already been processed during a capped bootstrap. Durable cursors, not this summary field, identify processed work.

For account reconciliation, `observations` counts current-state rows committed for stories already present in the reader store. `skippedUnknownStories` counts otherwise valid observations omitted because their story row is absent; reconciliation does not invent a story or expand into an unbounded public-API backfill. `activityJobsEnqueued` counts inserted durable current-state activity handoffs, not observations or job-handler attempts.

## Construction and injected composition

`createHnIngestion` validates and snapshots options synchronously. It performs no network or storage operation, starts no timer, and owns no borrowed dependency's lifecycle. Unknown option keys, wrong dependency shapes, invalid signals at method boundaries, and invalid policy values are rejected without echoing supplied values.

- `feeds` is a defensive copy of unique domain feed names. An empty array is valid: feed seeding is disabled while maxitem collection continues.
- `initialLookbackItems` is a non-negative safe integer. Zero is the default and performs no ID-range historical backfill.
- `maxItemsPerRun` and `refreshBatchSize` are positive safe integers. They bound selected work, not retained stories, queue entries, observations, or jobs.
- `refreshAfterHours` is finite and greater than zero. Its millisecond value must be a safe integer; a cutoff that cannot be represented as a valid `Date` is an `invalid-configuration` failure before external work.
- `bootstrapRankVersion` is called once at construction and its returned string is snapshotted. It must be a pure synchronous callback, return a non-empty string of at most 128 UTF-16 code units, and perform no I/O. `reader-app` supplies `() => QUEUE_BOOTSTRAP_RANK_VERSION`. Ingestion deliberately does not import that constant or duplicate its literal value.
- The bootstrap rank version is shared for initial pending rows only while no complete queue projection exists. Once a nonempty active projection pointer exists, new pending rows join its rank version so they cannot disappear into a separate bootstrap page. A later complete projection still owns replacement with a profile/content-addressed rank version.

The service supplies the optional account adapter with its dedicated account `HttpClient` configured to `maxAttempts=1`. Ingestion adds no retry loop around public or account calls. Public GET retries remain entirely in `hn-public-api`/`http-client`; account read retries require a later reconciliation invocation. This no-retry account composition is required so account throttling counts exact wire attempts.

Factory type/range failures throw `TypeError` or `RangeError` with a fixed field-identifying message. They never include URLs, usernames, cookies, raw callbacks, story content, or supplied values.

## Operation lane, cancellation, and lifecycle

One per-instance asynchronous lane serializes complete `collectPublic` and `reconcileAccount` operations in invocation order. There is no background work while idle. A queued operation whose signal aborts performs no run write, repository planning read, or external request and rejects with the exact `signal.reason`.

A supplied signal must be an `AbortSignal`; invalid input rejects with `HnIngestionError("invalid-input")` before the pre-abort check. After validation, an already-aborted signal rejects with the identical reason. The same signal object is passed to every public/account adapter call in that operation. Ingestion checks it before starting a run, before each new external page/item scheduling stage, after all fetch workers settle, and immediately before the commit transaction.

Caller cancellation is never converted to `HnIngestionError`, `AbortError`, or a domain/run error message. Once a run has started, cancellation before commit records a terminal failed run with stable code `cancelled` and a fixed safe message when storage remains usable, then rejects with the exact reason. The abort reason itself is never persisted. Failure-record writing cannot replace the cancellation result.

No external request or asynchronous callback occurs inside `store.transaction`. The commit body is synchronous, so an abort cannot interleave halfway through it. Commit is the operation's linearization point: after the transaction begins, the operation finishes that batch and returns its summary; an abort observed only after commit does not roll back or disguise committed work.

Settlement removes operation-local listeners and leaves no ingestion-owned timer, sleep, socket, subscription, or fetch worker. The service closes borrowed HTTP/database resources according to their own lifecycle contracts. Independent ingestion instances do not share a lane, but the supported deployment still has one process, one shared SQLite connection, and one writer.

## Public collection checkpoints

All checkpoint values are private, strict, versioned JSON envelopes stored through `store.sync`. They contain only numeric IDs, feed snapshots, schema versions, and continuation positions. They contain no story fields, URLs, cookies, or error text. A malformed, noncanonical, unsupported, or logically inconsistent checkpoint rejects as `invalid-checkpoint`; ingestion never guesses, truncates, or advances it.

### Collection cursor

The private cursor name is `hn.public.collection`. Its version-1 state is one of:

```text
bootstrap:
  targetMaxItemId
  feedIds                 sorted unique snapshot from configured first-run feeds
  nextFeedIndex
  nextLookbackId?         absent when no lookback range remains

advance:
  lastProcessedItemId
```

With no collection cursor, the first invocation fetches the official `maxitem` and each configured feed once. Let `M` be that maxitem. The bootstrap plan contains:

1. The sorted, deduplicated union of all feed IDs. The public API's feed bounds cap this snapshot at 1900 IDs when all five feeds are configured.
2. When `initialLookbackItems > 0`, the inclusive ID range from `max(1, M - initialLookbackItems + 1)` through `M`. Zero creates no range. A lookback larger than `M` explicitly requests history from ID 1, still in bounded runs rather than one unbounded transaction.

The planner merges the feed snapshot and lookback range in ascending ID order, suppressing duplicates without storing the expanded lookback range. Each invocation selects at most `maxItemsPerRun` public candidates. A later bootstrap invocation resumes the saved plan without refetching feeds or choosing a newer target. Once all planned work is committed, the cursor becomes `advance(lastProcessedItemId=M)`. Items created while bootstrap was in progress are therefore collected by the subsequent advance run rather than skipped.

In advance state, each invocation fetches `maxitem` and selects the oldest unprocessed IDs first, up to `maxItemsPerRun`, through the smaller of the returned maximum and the remaining run budget. A lower returned maximum never moves the cursor backward. No ID beyond the official safe-integer range is synthesized; an exhausted safe-integer range simply has no next candidate.

A successfully fetched and classified missing, non-story, or unnormalizable item is processed for cursor purposes and may be skipped without poisoning the cursor forever. Any transport, timeout, HTTP, or response-validation failure instead fails the whole batch and advances neither collection nor refresh checkpoints.

### Refresh cursor

The private cursor name is `hn.public.refresh`. Its version-1 state contains an optional `afterStoryId`. At the start of each public run, ingestion computes `olderThan = runStartedAt - refreshAfterHours` and calls:

```ts
store.stories.needingRefresh(
  olderThan,
  checkpoint.afterStoryId,
  refreshBatchSize,
)
```

The selected page is processed in story-ID keyset order with the public candidates. Duplicate IDs across the two plans are fetched and upserted only once. A short page commits a reset to the beginning of the refresh keyset; a full page saves its last selected story ID. An empty following page clears the cursor so the next run starts a fresh age-based scan.

Refresh includes existing deleted/dead stories. A JSON `null`, newly non-story item, or incomplete sparse tombstone does not erase or replace the previous story. The refresh cursor can advance past that observation, but historical content remains intact. Refresh checkpoints and the public collection checkpoint commit in the same batch transaction.

## Fetching and Story normalization

Feed/maxitem calls are deterministic and sequential. Item fetches use a private fixed bound of eight concurrent calls; this is a library resource bound, not a configuration key. Results are sorted by item ID before persistence. A failure stops scheduling new item work, all already-started workers are awaited, and no partial batch is committed. No hidden retry, bulk cache, or public rate limiter is added.

Immediately after each successful `api.item(id)` response, ingestion takes one `clock.now()` reading and formats it as the domain UTC ISO timestamp. That value is the item's `observedAt`; it is not a publication time or account-action occurrence time.

Normalization happens synchronously inside the final store transaction so the merge uses the latest stored state at commit:

```ts
normalizeStory({
  item,
  observedAt,
  previous: store.stories.byId(item.id),
})
```

The previous story is supplied whenever one exists, not only for tombstones. This is required for `firstSeenAt` preservation and lets the upstream normalizer merge both typed and type-less sparse deleted/dead tombstones. Current tombstone flags/raw data remain authoritative. Without a previous story, a type-less or otherwise incomplete sparse item that lacks required story fields returns no story; ingestion does not invent `type`, title, or `publishedAt`, and does not substitute observation time for publication time.

A known non-story or JSON `null` produces no story write. A complete normalized story, including a live/deleted/dead refresh, is passed to `store.stories.upsertBatch`. The repository remains responsible for persistence-time first-seen and reading/history preservation.

## Initial queue projection and blacklist visibility

Every normalized story in the batch receives an initial entry through `store.queue.insertPendingIfMissing`, including an existing story whose queue row was somehow absent. A new entry has exactly:

```ts
{
  storyId: story.id,
  state: "unread",
  evaluationState: "pending",
  visibilityState: "visible" | "blacklisted",
  kind: "match",
  rankVersion: activeProjection?.rankVersion ?? snapshottedBootstrapRankVersion,
  queuedAt: story.lastSeenAt,
  updatedAt: story.lastSeenAt,
  // no recommendationId, rankScore, rankPosition, or lastError
}
```

The transaction reads `store.profiles.current()` and `store.queue.projection()` once. `activeProjection` is that pointer's value; an empty projection's absent rank version falls back to bootstrap. When a profile exists, each new row's visibility is `interests.isBlacklisted(story, profile)` evaluated against the normalized story and that commit-time profile. Without a profile, the row is visible. Ingestion does not build a profile, import queue ranking, compute exploration, or choose a new content-addressed rank version; it only joins the existing active namespace or the shared pre-projection bootstrap.

Insertion is deliberately not a visibility or ranking update for an existing row. Reprocessing preserves reading state, `queuedAt`, existing visibility, rank state, and failures. Story-upsert invalidation on a changed content version follows the reader-store contract. Later personalization/reprojection recomputes visibility for the complete current profile; a blacklist change never deletes story or activity history.

## Article and recommendation job handoffs

Job payloads and dedupe keys below are version-1 structural handoff contracts. They do not import `article-reader`, `personalization`, `queue`, or `activity` types. The service registers their codecs and idempotent handlers.

For each committed story whose previous row was absent or whose `contentVersion` changed, enqueue:

```ts
{
  kind: "article.fetch-extract",
  payloadSchemaVersion: 1,
  payload: {
    storyId: story.id,
    storyContentVersion: story.contentVersion,
  },
  dedupeKey: `${story.id}:${story.contentVersion}`,
  runAfter: batchCompletedAt,
}
```

Score/descendant/observation/raw-only changes retain the same content version and do not enqueue another article job. The handler must ignore a payload whose source version is no longer current rather than overwriting newer article state.

When at least one story is new or content-changed and a commit-time current profile exists, also enqueue the canonical profile-scoped scoring handoff:

```ts
{
  kind: "personalization.score-pending",
  payloadSchemaVersion: 1,
  payload: { profileId: profile.id },
  dedupeKey: JSON.stringify(["personalization.score-pending", profile.id]),
  runAfter: batchCompletedAt,
}
```

This matches the payload and dedupe identity owned by `personalization`; ingestion duplicates only the structural wire contract because it cannot import that downstream package. The handler performs a current pending-scoring drain and ignores a stale profile job according to the personalization contract.

When changed stories exist but no current profile exists, instead enqueue:

```ts
{
  kind: "personalization.recover",
  payloadSchemaVersion: 1,
  payload: {},
  dedupeKey: JSON.stringify(["personalization.recover"]),
  runAfter: batchCompletedAt,
}
```

Recovery builds/selects the current profile before scoring. Ingestion therefore hands off the work without fabricating a profile or inventing a profile ID.

All article/scoring/recovery enqueues join the outer store transaction on the same SQLite connection. A duplicate active job is a successful existing handoff with `inserted=false`. Any other enqueue failure rolls back stories, initial queue entries, checkpoints, run completion, and every other job in that batch.

## Run and atomic batch contract

One public invocation commits at most one public candidate batch and one refresh page together. It does not loop through multiple commit batches. Later scheduled/manual invocations resume from the durable checkpoints. This makes the existing `SyncRepository` sufficient: terminal run counters and cursor end state can commit atomically with the run's only batch.

The sequence is:

1. Read and validate checkpoints and plan the bounded batch.
2. Generate a cryptographically random run ID and insert an `IngestionRun(kind="hn.public.collect",status="running")` with `startedAt` and the serialized starting checkpoint state.
3. Perform all HN calls and observation clock reads outside storage transactions.
4. Check cancellation, take `batchCompletedAt`, and open one synchronous `store.transaction`.
5. Re-read previous stories/current profile, normalize, upsert stories, insert initial queue entries, set both checkpoints, enqueue required jobs, and call `sync.finishRun` with a complete run and final counters/cursor state.
6. Commit once and return a fresh summary.

A failed batch commits none of the writes in step 5. A separate failure-path `finishRun` marks the named run `failed` with a stable safe error code/message, zero uncommitted batch counters, and the starting cursor as its end. If that failure record cannot be written, the original safe failure/cancellation wins and the stale running row is diagnostic only; it never acts as a collection lock. Cursor state is the recovery authority after process failure.

## Account reconciliation

`reconcileAccount` requires `options.account`; otherwise it rejects `account-not-configured` before creating a run. It never calls `performAction` and never initiates an HN mutation.

### Session, capabilities, and bounded pages

1. Call `validateSession` and use its positively validated username for every state/cursor binding.
2. Call `capabilities` and retain its complete ordered result for the summary.
3. For each of `upvoted`, `favorites`, and `flagged`, in that order, read at most one list page only when the corresponding capability is `available`. `unavailable` and `unverified` skip that source. `mutations` is returned but not used for reconciliation.
4. Use `readUpvoted`, `readFavorites`, or `readFlagged` respectively. Disabled or unverified flag readback is never probed speculatively by ingestion.

Private cursors `hn.account.upvote`, `hn.account.favorite`, and `hn.account.flag` contain a version-1 envelope with username and optional opaque continuation. A continuation is used only for the same kind and positively validated username. A different configured account starts at the canonical first page rather than reusing a non-portable cursor.

When a page has `nextCursor`, commit it for the next invocation. When it has none, clear the continuation so the next invocation starts a fresh current-state scan. One page per available kind per run bounds work and avoids claiming an atomic multi-page snapshot. HN may change between pages and runs; idempotent upserts, not snapshot claims, provide consistency. A page failure discards all uncommitted pages from that invocation and leaves every account cursor unchanged.

### Current-state rows and unknown stories

Map only explicit `AccountObservation` values. Never infer `present=false` from list absence, a missing element, or the end of a page. Observations for stories absent from `store.stories` are counted in `skippedUnknownStories` and do not produce state, intent, queue, or activity-job writes.

Inside the commit transaction, call `store.hnAccountStates.byStoryIds(username, kind, observationStoryIds)` once per available kind and index only those existing rows by `(username,storyId,kind)`. The ID list is the unique known-story IDs from that bounded observation page, so unrelated account history is not read. Merge each remaining observation by key:

- preserve an existing `firstObservedAt`; otherwise use the observation's `observedAt`;
- set `lastObservedAt` to the later of the existing last observation and the new `observedAt`, so wall-clock adjustment cannot move durable observation time backward;
- update `present` from the latest actual observation even when its wall timestamp ties or precedes an existing one;
- set `sourceCursor` to the exact cursor used to request this page, or absent for a canonical first page.

Repeated identical observations are idempotent current-state updates. No list absence creates a removal, no story publication time becomes account time, and no monotonic clock reading enters a persisted record.

### Conservative indeterminate-intent reconciliation

Read at most `refreshBatchSize` total records through `store.hnActions.pendingOrIndeterminate` in the same transaction. For each positive observation in deterministic page order, query `{ status: "indeterminate", storyId, action, limit: remainingBudget }`, advancing `afterId` only if another matching page is needed within that budget. Only that explicit `present=true` observation with matching story/action can enrich an existing `indeterminate` intent to `verified`. Verified rows leave later candidate pages, so subsequent runs make progress without a separate durable intent cursor; unrelated pending/intent history cannot consume the filtered budget.

A verified reconciliation preserves the intent ID/idempotency/creation fields and stores version-1 result evidence `{ source: "hn-reconciliation", observedAt }`, with `updatedAt=observedAt` and no error code. This says the desired current state was observed; it does not claim when HN applied that particular attempt. Pending intents are not closed by reconciliation, and `present=false`, list absence, or an unavailable capability never verifies or fails an intent. More candidate intents remain for later bounded runs.

### Durable raw-activity handoff without an activity dependency

For a known-story observation with no previous account-state row, or whose `present` value differs from the previous row, enqueue one current-state activity handoff in the same transaction. An unchanged repeated observation enqueues none. First observation is recorded as current evidence, not as a claimed historical transition.

The structural version-1 job handoff is:

```ts
{
  kind: "personalization.record-activity",
  payloadSchemaVersion: 1,
  payload: {
    batch: [{
      clientEventId,
      storyId: observation.storyId,
      kind: observation.kind,
      source: "hn-reconciliation",
      value: { present: observation.present },
      // occurredAt is deliberately absent
    }],
  },
  dedupeKey: clientEventId,
  runAfter: batchCompletedAt,
}
```

`clientEventId` is 32 cryptographically random bytes encoded as 43-character unpadded base64url. Generate it once while constructing the committed handoff, retain it in the durable job payload, and never regenerate it for a worker retry. A dedupe collision is a handoff failure, not silent permission to drop the new logical observation.

The `reader-app` job handler intercepts this kind before the generic four-kind `personalization.runJob` dispatch and passes the one-story batch to `personalization.recordActivity`. The activity package then owns validation, receipt timestamps, deterministic event IDs, replay handling, and partial observation quality. Job/state atomicity prevents a lost handoff; the stable payload identity makes an at-least-once handler retry an exact activity replay rather than a second logical event. No `occurredAt` is supplied by ingestion, and no timestamp from story publication, intent creation, page position, or observation time is relabeled as the user's action time.

The account run starts as `IngestionRun(kind="hn.account.reconcile",status="running")` with a fresh random run ID, `startedAt`, and the serialized starting account-cursor state. Its single result transaction commits current states, account cursors, indeterminate-intent updates, all activity handoff jobs, and `finishRun(complete)` together. It contains no account/public HTTP call and no direct activity reduction. Failure/cancellation recording, zero uncommitted counters, and stale-running-row behavior follow the public run contract.

## Safe error contract

`HnIngestionError.message` is fixed by `code`. Consumers branch on `code`, `operation`, and `retryable`, not message text. `dependency` and `dependencyCode` provide allowlisted safe context; dependency codes must be bounded lowercase kebab-case identifiers. `runId` is safe correlation metadata. There is no public `cause`, stack projection, response, URL, cursor value, username, cookie, story title/HTML, job payload, or arbitrary upstream message.

| Code | Fixed message | Typical `retryable` |
|---|---|---|
| `invalid-configuration` | `HN ingestion configuration is invalid.` | `false` |
| `invalid-input` | `HN ingestion input is invalid.` | `false` |
| `invalid-checkpoint` | `HN ingestion checkpoint is invalid.` | `false` |
| `account-not-configured` | `HN account reconciliation is not configured.` | `false` |
| `upstream-failure` | `HN ingestion upstream operation failed.` | copied from the mapped public/account read error |
| `persistence-failure` | `HN ingestion persistence failed.` | `true` only for a retryable database error |
| `job-handoff-failure` | `HN ingestion job handoff failed.` | `true` only for a retryable database error during enqueue |
| `internal-failure` | `HN ingestion failed unexpectedly.` | `false` |

Expected `HnPublicApiError` and `HnAccountError` read failures map to `upstream-failure` with the original safe code and retryability. No additional immediate retry follows. `ReaderStoreError` and `DatabaseError` map to `persistence-failure`; `JobQueueError`, or a database failure raised specifically by enqueue, maps to `job-handoff-failure`. `InterestError` from invalid stored profile/story data and unexpected application exceptions map to `internal-failure` without their causes. Cancellation always remains the exact abort reason rather than entering this table.

Failed runs store only the mapped stable code and fixed message. Serialization of an error must not reveal sentinel values placed in upstream causes, raw HN content, HTML, continuation URLs, cookies, payloads, or database parameter values.

## Invariants

1. No public or account HN call occurs inside a store transaction; every transaction is synchronous and short.
2. One run has one atomic result batch. Story upserts, initial pending rows, collection/refresh or account cursors, run completion, and affected job handoffs commit or roll back together.
3. A transient fetch/validation failure advances no checkpoint. A valid missing/non-story/incomplete item may be skipped without blocking later IDs and never fabricates story fields.
4. Every normalization uses `observedAt` and the commit-time previous story, including typed and type-less sparse tombstones.
5. Every initial pending row uses the active projection rank version when present, otherwise the reader-app-supplied shared bootstrap version, plus commit-time blacklist visibility; existing reading/ranking state is preserved and no second page namespace appears.
6. Article work is keyed by exact story content version. Score-only changes do not retrigger content work, and scoring/recovery handoffs use the personalization owner's canonical payload and dedupe contracts.
7. Account reconciliation is current-state only. It never infers absence, fabricates `occurredAt`, autonomously mutates HN, or marks pending/indeterminate work verified without positive presence evidence.
8. Raw account activity is handed off only through a durable one-story job with stable retry identity. Ingestion imports neither `activity` nor `queue`, including type-only imports.
9. Work selection and item concurrency are bounded. Limits never delete or hide unprocessed history.
10. Public errors are deterministic and safe, and caller cancellation preserves exact reason identity.

## Acceptance-focused test expectations

Test through the package root with a scripted public API/account adapter, fixed clock, real temporary SQLite for store/job composition, and an instrumented transaction boundary. No live HN service or real timer is required. Assert complete job payloads/dedupe keys, exact request counts, signal identity, and persisted state rather than only summary values.

### Construction, dependency, and error boundaries

- `should validate and snapshot all options feeds and bootstrap rank version without network or storage work`.
- `should reject invalid policy duplicate feeds invalid callbacks and malformed signals with fixed safe errors`.
- `should supply queue bootstrap version through reader-app callback without any ingestion runtime or type import of queue or activity`.
- `should map every expected upstream store and job failure with safe operation dependency retryability and run correlation`.
- `should keep URL HTML cookie cursor payload and dependency-cause sentinels out of public and persisted errors`.
- `should keep account HTTP on its dedicated maxAttempts one composition and add no ingestion retry loop`.
- `should export exactly two strict empty-payload scheduling codecs and construct fixed-kind dedupe enqueues without scheduler imports`.
- `should map known and unknown ingestion worker failures safely and keep scheduled payload cursor account and abort sentinels out of job errors`.

### Bootstrap, advance, and refresh checkpoints

- `should seed all configured feed IDs once deduplicate them and establish maxitem with zero lookback without historical ID walking`.
- `should clamp an explicit lookback to ID one and process it in bounded ascending batches across repeated calls and a real database reopen`.
- `should resume a partially committed bootstrap plan without refetching feeds and collect items created during bootstrap on the following advance run`.
- `should honor maxItemsPerRun as a work bound rather than a retention cap and never move an advance cursor backward`.
- `should advance past valid null non-story and unnormalizable items but advance nothing after any HTTP transport timeout or invalid-response failure`.
- `should page needingRefresh by age and story ID reset after a short page and resume the saved full-page key after restart`.
- `should fetch an ID selected by both collection and refresh once and commit both checkpoints with the same story batch`.

### Story normalization, initial queue, and jobs

- `should call normalizeStory with the fetched item per-item observedAt and latest previous story inside the commit transaction`.
- `should merge typed and type-less sparse tombstones with previous metadata while preserving current raw flags and never inventing required fields without previous data`.
- `should preserve an existing story when refresh returns null a non-story or an incomplete tombstone`.
- `should insert only missing pending rows preserve reading ranking queued time visibility and errors on replay and apply current profile blacklist visibility to new rows`.
- `should keep initial rows in one bootstrap page before the first projection then join the active rank page after later ingestion and make no-profile rows visible`.
- `should enqueue exact article jobs only for new or content-changed stories and not for score descendant observation or raw-only changes`.
- `should use the canonical profile-scoped scoring handoff when a profile exists and the canonical recovery handoff without fabricating a profile when none exists`.
- `should count only inserted jobs while treating an active dedupe hit as an existing successful handoff`.

### Atomicity, runs, cancellation, and concurrency

- Inject a failure at each story upsert, queue insertion, cursor write, article enqueue, scoring enqueue, and run completion. Prove every result-batch write rolls back together and the separate failed run contains no partial counters.
- Assert the transaction body never calls an HN adapter, returns a Promise, sleeps, or invokes the activity handler. A job handler runs only after its job becomes claimable.
- Restart after a running-row-only crash and prove collection resumes from the last committed cursor rather than treating the stale run as a lock.
- `should preserve exact pre-abort queued and in-flight abort reasons and prevent new requests checkpoints or result-batch writes after cancellation`.
- `should await already-started fetch workers before failure settlement and commit at most one linearized batch when cancellation races commit`.
- `should serialize public and account operations on one instance skip cancelled queued work and leave no listeners timers or fetch workers after settlement`.

### Account current-state and activity handoffs

- `should reject reconciliation without an account and otherwise validate session return all capabilities and read only available list kinds`.
- `should respect disabled or unverified flag readback and never call performAction`.
- `should read at most one page per available kind bind continuations to kind and validated username and restart after a terminal page`.
- `should preserve firstObservedAt advance lastObservedAt without timestamp regression update current presence and retain the requesting source cursor`.
- `should never infer false from list absence and should skip unknown-story observations without placeholder stories or foreign-key failure`.
- `should verify only matching indeterminate intents on positive presence and never close pending intents or act on false or absent evidence`.
- `should use observation-keyed account-state reads and filtered indeterminate-intent keysets within the total candidate budget without scanning unrelated history`.
- `should enqueue one structurally valid hn-reconciliation job only for first or changed current-state evidence with no occurredAt property`.
- `should retain the same clientEventId in a durable payload across job and process retries so the real activity reducer accepts only one logical event`.
- `should enqueue no activity job for an unchanged repeated observation and use a fresh durable identity for a later genuine state change`.
- Inject failures across account-state upsert, account cursor, intent update, activity enqueue, and run completion. Prove no partial account handoff survives and no raw activity callback executes inside the transaction.

### Workflow acceptance

For WF-02/WF-07, enqueue collection through its durable scheduling contract, collect mixed story/job/comment fixtures across caps and restart, then prove complete pending queue reachability, checkpoint durability, and no duplicate logical jobs/stories on replay. For WF-03/WF-06, ingest before the first projection to establish bootstrap and after a complete profile/blacklist projection to prove new rows join the active rank while current visibility is honored. For WF-05, enqueue and run reconciliation, reconcile current states and indeterminate intents without any mutation request or fabricated historical occurrence, then process the durable activity job through the real activity/personalization path and repeat it to prove idempotency.

## Internal subcomponents

- Immutable options, operation lane, cancellation checkpoints, and safe error mapping.
- Versioned public bootstrap/advance/refresh checkpoint parser and bounded planner.
- Bounded item fetch pool, observation timestamp assignment, and commit-time story normalizer.
- Initial queue/blacklist projection and versioned article/scoring job handoffs.
- Durable run coordinator and one-batch transaction composition.
- Account capability/page reader, current-state/intent reconciler, and durable raw-activity outbox.

The module and transaction design is specified in [arch.md](arch.md). Only the API above is public.

## Dependencies on other libs

- `clock` — wall-clock observation/run/refresh timestamps. Monotonic time is not persisted.
- `domain` — feed, story, queue, run, account-state, intent, and timestamp records.
- `hn-account` (optional at runtime) — validated session, capabilities, and explicit current-state observations.
- `hn-public-api` — official item/feed/maxitem reads and pure `normalizeStory`.
- `interests` — commit-time `isBlacklisted` decisions for initial queue rows.
- `job-queue` — transactional durable article/scoring/activity handoffs plus codec/enqueue/failure types for the two public scheduling job contracts; no scheduler package is imported.
- `reader-store` — previous stories, profiles, checkpoints, runs, current states, intents, queue insertion, and synchronous transactions.

Node `crypto` supplies cryptographically random run/client IDs. No direct HTTP, database, Zod, scheduler, logging, `queue`, `activity`, `article-reader`, `personalization`, or third-party dependency is added.

## New build or OSS wrapper

New composition over existing workspace libraries; no additional third-party dependency.

## Hosted by

`reader-app` ingestion jobs in `services/personal-reader`. `reader-app` supplies the queue bootstrap constant through the callback, registers the two owner codecs, enqueues scheduled work, and owns handlers for the structural job handoffs. The service owns schedules, account secret loading, the dedicated no-retry account HTTP client, and shutdown.

## Configuration

The service supplies resolved values; the factory does not hide a second configuration source.

- `ingestion.cron` — **optional**, default `*/15 * * * *`; scheduler/service key that enqueues public collection and optional account reconciliation. It is not read by this package.
- `ingestion.feeds` — **optional**, default `["top", "new", "best", "ask", "show"]`; unique feed names, possibly empty.
- `ingestion.initial_lookback_items` — **optional**, default `0`; non-negative safe integer. Zero avoids historical ID-range backfill; feed seeding still occurs.
- `ingestion.max_items_per_run` — **optional**, default `2000`; positive safe integer limiting public candidates selected in one run, not story retention.
- `ingestion.refresh_batch_size` — **optional**, default `100`; positive safe integer limiting story refresh candidates and account-intent reconciliation candidates per run.
- `ingestion.refresh_after_hours` — **optional**, default `24`; finite positive hours with a safely representable millisecond/cutoff value.

Eight concurrent item fetches, one account page per available kind per run, checkpoint/job schema version 1, cursor names, and job kind/dedupe formats are fixed library contracts rather than new operator keys. Public retries/timeouts belong to `http-client`; the account composition always overrides `maxAttempts=1`. Scheduled ingestion is durable through `ingestion.collect` and `ingestion.reconcile-account`; the in-memory scheduler only enqueues those jobs at the configured cron instants.

## Composition contract

`reader-app` registers `personalization.record-activity` plus the article, two ingestion, and four personalization codecs. It passes one-story activity payloads to `personalization.recordActivity`, retains `clientEventId` in durable payloads, supplies `bootstrapRankVersion: () => QUEUE_BOOTSTRAP_RANK_VERSION`, and returns the complete reconciliation summary including capability/handoff counts and cancellation. These are completed composition requirements, not reasons to add ingestion dependencies on higher-tier packages.
