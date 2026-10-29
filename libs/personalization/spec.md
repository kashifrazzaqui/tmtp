# Personalization Library Spec

## Purpose and responsibility

Compose activity reduction, immutable interest profiles, LLM recommendations, complete queue projections, and durable background work into one personalization pipeline. The package owns cross-library transaction boundaries, work selection, deterministic personalization job payloads, audit persistence, cancellation composition, and recovery. It does not reimplement activity reduction, interest weighting, prompt construction, ranking, provider retries, SQL, or job leasing.

The package root is `@tmtp/personalization`. It has no default export or subpath exports. The target runtime is one Node process, one `Personalization` writer instance, one shared synchronous SQLite connection, and one reader/writer service. External HN/LLM calls, Promise-returning work, and timers never run inside a store transaction.

The product invariant is continuity without silent loss: scoring and ranking may change order, but no scoring limit, failed judgment, stale article, blacklist, or resumable read batch may delete or hide an otherwise eligible story. Blacklisting alone changes visibility; it never erases history.

## Public interface / API surface

```ts
export const PERSONALIZATION_JOB_PAYLOAD_SCHEMA_VERSION: 1;

export interface RecordActivityResult {
  accepted: number;
  profileWorkEnqueued: boolean;
}

export interface ScorePendingSummary {
  completion: import("@tmtp/recommendations").RecommendationCompletion;
  scored: number;
  failed: number;
  retryableFailed: number;
  queued: number;
  audits: number;
}

export interface RecoverySummary extends ScorePendingSummary {
  rebuilt: boolean;
}

export interface QueueProjectionSummary {
  projected: number;
  complete: true;
  profileId: string;
  rankVersion?: string;
}

export interface Personalization {
  recordActivity(
    batch: readonly import("@tmtp/activity").RawActivity[],
    signal?: AbortSignal,
  ): Promise<RecordActivityResult>;
  rebuildProfile(
    reason: string,
    signal?: AbortSignal,
  ): Promise<import("@tmtp/domain").InterestProfile>;
  scorePending(signal?: AbortSignal): Promise<ScorePendingSummary>;
  applyPreferenceChange(
    rules: readonly import("@tmtp/domain").PreferenceRule[],
    signal?: AbortSignal,
  ): Promise<import("@tmtp/domain").InterestProfile>;
  recover(signal?: AbortSignal): Promise<RecoverySummary>;
  projectQueue(signal?: AbortSignal): Promise<QueueProjectionSummary>;
  runJob(
    job: import("@tmtp/domain").Job,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface PersonalizationOptions {
  store: import("@tmtp/reader-store").ReaderStore;
  jobs: import("@tmtp/job-queue").JobQueue;
  llm: import("@tmtp/llm-interface").LlmPort;
  model: string;
  clock: import("@tmtp/clock").Clock;
  activityPolicy: import("@tmtp/activity").ActivityPolicy;
  interestPolicy: import("@tmtp/interests").InterestPolicy;
  recommendationPolicy: import("@tmtp/recommendations").RecommendationPolicy;
  activityBatchSize: number;
  queueSyncBatchSize: number;
}

export type PersonalizationJobKind =
  | "personalization.profile-rebuild"
  | "personalization.score-pending"
  | "personalization.queue-project"
  | "personalization.recover";

export interface ProfileRebuildJobPayload {
  reason: string;
  rulesVersion: string;
  activityVersion: string;
}

export interface ProfileScopedJobPayload {
  profileId: string;
}

export interface RecoverJobPayload {}

export type PersonalizationJobPayload =
  | ProfileRebuildJobPayload
  | ProfileScopedJobPayload
  | RecoverJobPayload;

export type PersonalizationJobDescription =
  | {
      kind: "personalization.profile-rebuild";
      payload: ProfileRebuildJobPayload;
      runAfter: import("@tmtp/domain").IsoDateTime;
    }
  | {
      kind: "personalization.score-pending" | "personalization.queue-project";
      payload: ProfileScopedJobPayload;
      runAfter: import("@tmtp/domain").IsoDateTime;
    }
  | {
      kind: "personalization.recover";
      payload: RecoverJobPayload;
      runAfter: import("@tmtp/domain").IsoDateTime;
    };

export const personalizationJobCodecs:
  readonly import("@tmtp/job-queue").JobPayloadCodec[];

export function createPersonalizationJobEnqueue(
  description: PersonalizationJobDescription,
): import("@tmtp/job-queue").JobEnqueue;

export type PersonalizationErrorCode =
  | "invalid-options"
  | "invalid-input"
  | "invalid-job"
  | "activity-append-incomplete"
  | "audit-conflict"
  | "recommendation-conflict"
  | "cancelled"
  | "scoring-retryable";

export class PersonalizationError extends Error {
  readonly name: "PersonalizationError";
  readonly code: PersonalizationErrorCode;
  readonly retryable: boolean;
  readonly field?: string;
  readonly jobId?: string;
  constructor(
    code: PersonalizationErrorCode,
    details?: { field?: string; jobId?: string },
  );
}

export function personalizationJobFailure(
  error: unknown,
): import("@tmtp/job-queue").JobFailure;

export function createPersonalization(
  options: PersonalizationOptions,
): Personalization;
```

Runtime exports are exactly `PERSONALIZATION_JOB_PAYLOAD_SCHEMA_VERSION`, `personalizationJobCodecs`, `PersonalizationError`, `createPersonalizationJobEnqueue`, `personalizationJobFailure`, and `createPersonalization`. Type exports are exactly the other names shown above. Internal projection, audit-mapping, lock, and timestamp helpers are not public.

`createPersonalizationJobEnqueue` lets the service enqueue `personalization.recover` and lets other application compositions construct valid work without duplicating payload or dedupe rules. `personalizationJobCodecs` must be included in the service's `createJobQueue({ codecs })` registry before jobs are claimed. `runJob` receives a claimed job whose payload has already been decoded by `job-queue`; it performs the logical effect but never calls `claim`, `renew`, `complete`, `fail`, or `recoverExpired` for that claimed job. The service worker owns those lease transitions and uses `personalizationJobFailure` to obtain safe failure text.

## Validation and safe errors

### Options and direct calls

`createPersonalization` validates its complete options object synchronously. It rejects unknown keys and malformed dependencies. `model` must be non-empty with no leading/trailing whitespace and is sent/recorded exactly. `activityBatchSize` and `queueSyncBatchSize` are positive safe integers. Activity, interest, and recommendation policies obey their owning packages' ranges, including a non-negative `maxActivityEvents` and `maxStoriesPerRun`; zero is valid for both. There are no hidden defaults in this package.

Public methods validate JavaScript input at runtime even when callers use TypeScript. A supplied signal must be an `AbortSignal`. `reason` is preserved exactly, must contain non-whitespace, and has a 200 UTF-16-code-unit boundary limit. `recordActivity` first applies `activity.parseActivityBatch`; it then rejects more than `activityBatchSize` rows before storage. `applyPreferenceChange` requires an array of domain rules and lets `interests` enforce normalization, duplicate, and snapshot rules. Invalid direct input produces a rejected Promise, not a synchronous throw after the method begins asynchronous work.

A pre-aborted cancellable operation returns/rejects as specified under Cancellation without storage writes, provider work, new jobs, or synthetic audits. Validation precedes the abort outcome, so malformed input does not become cancellation merely because its signal is aborted.

### Error vocabulary

`PersonalizationError` has fixed safe messages:

| Code | Message | `retryable` |
|---|---|---:|
| `invalid-options` | `Personalization options are invalid.` | `false` |
| `invalid-input` | `Personalization input is invalid.` | `false` |
| `invalid-job` | `Personalization job is invalid.` | `false` |
| `activity-append-incomplete` | `Activity replay data changed during append.` | `true` |
| `audit-conflict` | `LLM audit identity conflicts with an existing record.` | `false` |
| `recommendation-conflict` | `Recommendation identity conflicts with an existing record.` | `false` |
| `cancelled` | `Personalization work was cancelled.` | `true` |
| `scoring-retryable` | `Recommendation work needs a later retry.` | `true` |

`field` is a stable option/input path and `jobId` is an opaque job identifier. Neither contains a reason string, preference value, story title, article text, prompt, profile payload, provider message, or captured payload. The class has no public `cause`.

Expected `ActivityError`, `InterestError`, `RecommendationError`, `QueueError`, `ReaderStoreError`, `JobQueueError`, and database errors propagate unchanged; personalization does not flatten their stable codes into message matching. `personalizationJobFailure` maps known errors to fixed safe `JobFailure` values, preserves `PersonalizationError.retryable`, treats validation/immutable/contract errors as non-retryable, and maps an unknown error to `{ code: "personalization-failed", message: "Personalization job failed.", retryable: true }`. Raw causes and messages are never copied into a job.

A transaction error rolls back every write in that boundary. No error path converts a failed/cancelled LLM operation into a score, negative preference, blacklist, dismissal, or synthetic recommendation.

## Activity recording: exact atomic protocol

`recordActivity` implements the `activity` composition contract exactly; it does not partition a request into independent per-story transactions.

1. Call `parseActivityBatch` before storage. A mixed-story batch, conflicting in-batch identity, malformed value, or future-invalid shape reaches no driver parameter binding. Enforce `activityBatchSize` before storage as well.
2. An empty valid batch returns `{ accepted: 0, profileWorkEnqueued: false }` without reading the clock, opening a transaction, reading a session, or enqueueing work.
3. Open one synchronous `store.transaction`. For every distinct incoming `clientEventId`, read its persisted event with `store.activity.query({ clientEventId, limit: 1 })`. Read `store.readingSessions.latestForStory(storyId)`, which returns the latest **active or terminal** session by `(updatedAt,id)`. An active-only lookup is invalid.
4. Call `reduceActivity` with the parsed batch, that latest session, the exact activity policy, the injected clock, and the complete replay record set. Do not `await` anything in the transaction.
5. Call `store.activity.appendIdempotent(reduction.events)`. Require the returned newly inserted count to equal `reduction.events.length`. A short append means the replay read was incomplete: throw `activity-append-incomplete` before any session or job write and roll back all event appends.
6. Upsert **every** `reduction.sessions` entry in array order. One batch can close and create several sessions; no single-session shortcut is permitted.
7. Only when `reduction.events.length > 0`, read the post-append `activity.latestVersion()` and `preferences.currentVersion()`, then enqueue one `personalization.profile-rebuild` job in the same transaction. Its payload is `{ reason: "activity", rulesVersion, activityVersion }`; its run time is the shared novel-event receipt timestamp. `profileWorkEnqueued` is the queue's actual `inserted` flag, so an already-active identical job yields `false` without losing the new source version in the dedupe key.
8. Commit events, all session upserts, and the conditional profile job together. Return `accepted = reduction.events.length`. A full replay accepts zero and enqueues nothing; a partial retry accepts only novel rows.

Unique `client_event_id` and `last_client_event_id` constraints are backstops, not replacements for replay preclassification or the append-count check. The synchronous transaction linearizes concurrent activity calls on the shared connection. Any failure rolls back events, sessions, and jobs together.

## Profile building and preference changes

### Canonical build input

Every profile build, including activity-triggered, manual, preference, and recovery builds, reads these values from the same synchronous store transaction:

- canonical `preferences.list()` and independent `preferences.currentVersion()`;
- `activity.latestWindow(interestPolicy.maxActivityEvents)`;
- independent `activity.latestVersion()`;
- every story referenced by the selected activity window through `stories.byId`.

`latestWindow` returns an ascending contiguous suffix. A zero activity budget calls `latestWindow(0)`, receives an empty suffix, and still passes the actual `latestVersion()` to `buildInterestProfile`; an empty window must not replace a nonempty log version with `"0"`. An actually empty log uses `"0"`. The activity budget limits arithmetic only, never activity retention or queue retention.

Call `buildInterestProfile` with that exact rule/activity/story set, `rulesVersion`, `activityVersion`, a composition timestamp, reason, and the exact interest policy. Its builder, policy, source-rule, and activity versions remain authoritative. Missing referenced stories are not silently dropped from validation; the builder's `missing-story` failure rolls back the transaction.

For a new profile version, `builtAt` is the clock time advanced, only if needed, to one millisecond after the previous current profile's `createdAt`, preserving useful history order during wall-clock regression. After building, query `profiles.byVersion` for the four-part version key. If a record exists, reuse that immutable record and its original `createdAt`/`reason`; do not insert changed metadata under the same key. Otherwise insert the new immutable profile. Then call `profiles.setCurrent(selectedProfile.id, builtAt)` in the same transaction and use its returned stored record. This explicit pointer can select a reused older profile without rewriting its timestamp or contents. Projection and job enqueue occur only after pointer selection succeeds; any store failure rolls back the build and related writes.

### Rebuild and preference transactions

`rebuildProfile(reason)` builds the current source head in one transaction. If the selected profile differs from the previously current profile, the same transaction immediately performs a complete projection for that profile so old-profile scored/failed rows become pending unless an exact current recommendation already exists, and blacklist visibility changes at once. It enqueues `personalization.score-pending` for the selected `profileId` in that transaction. If the source head already selects the current profile, it preserves existing failed states, still performs any requested complete repair projection, and may enqueue idempotent missed scoring work.

`applyPreferenceChange(rules)` performs `preferences.replaceAll`, reads back the canonical stored rules, builds the profile, performs the same complete projection, and enqueues profile-scoped scoring in **one** transaction. A builder/validation/projection/job error rolls back the rule replacement as well. Explicit excludes therefore affect visibility before any LLM call, while reading state and `queuedAt` survive. Historical activity, profiles, recommendations, and audits are never rewritten.

Both operations use the profile pipeline serialization described below. They do not hold a database transaction across any external call.

## Scoring and durable result composition

### Work plan and external call

`scorePending` runs under the profile pipeline lock and uses the current profile. If none exists, it uses the private build helper without enqueueing a duplicate score job because this operation is already the scoring handoff. It then creates a short read transaction for one deterministic work plan:

- when `recommendationPolicy.maxStoriesPerRun > 0`, call `stories.needingScoring` with the current `profileId`, `RECOMMENDATION_PROMPT_VERSION`, exact `model`, no cursor, and that limit;
- when the limit is zero, use an empty story array without calling the positive-limit repository query;
- load exactly the corresponding articles with `articles.byStoryIds`.

The store owns story/article freshness. Its story/article upserts atomically invalidate changed scored/failed rows to pending and clear stale recommendation/rank fields. Personalization must not invent a second stale-row repair algorithm. `needingScoring` supplies pending/failed stories with no immutable recommendation for the exact profile/story-content/current-article-content/prompt/model key.

Read one `scoreAt` from the clock and call, outside every store transaction:

```ts
scoreStories({
  stories: plannedStories,
  articles: plannedArticles,
  profile,
  llm: options.llm,
  model: options.model,
  policy: options.recommendationPolicy,
  at: scoreAt,
  signal, // property omitted only when the caller supplied no signal
});
```

The exact caller signal and all planned articles reach `recommendations`. That package owns story order, batch sizing, prompt limits, per-attempt provider behavior, and the returned `completion`/`attempts`. Personalization adds no provider retry, timeout, prompt mutation, or parallel fan-out.

### Audit mapping and immutable reuse

For a normal `RecommendationBatch`, open one synchronous result transaction only after `scoreStories` settles. Read one audit-observation timestamp from the clock. Map each `LlmCallAudit` to `LlmCallRecord` as follows:

```text
id = callId
purpose, model, status, requestHash, errorCode = same-named audit fields
inputTokens = usage.inputTokens
outputTokens = usage.outputTokens
latencyMs = usage.latencyMs
providerRequestId = usage.providerRequestId
requestPayload/requestPayloadSchemaVersion = audit fields when present
responsePayload/responsePayloadSchemaVersion = audit fields when present
createdAt = the first persistence-observation timestamp for this callId
```

Absent optional values remain absent, never `null`. The timestamp is assigned by personalization because `llm-interface` deliberately has no per-attempt wall timestamp; it is not derived from latency and must not be presented as the exact provider start time.

Persist every attempt from every returned result or readable error exactly once:

- Duplicate call IDs within one returned attempt stream are an `audit-conflict`.
- Across job retries, read `llmCalls.byId(callId)`. Reuse a byte-equivalent upstream audit with its original `createdAt`; a later retry must not replace that timestamp. Different upstream content for the same ID is `audit-conflict`.
- Insert all new audit rows before inserting any recommendation that can reference them. Every attempt is inserted once, including earlier failures before eventual success, terminal errors, invalid output, timeout, cancellation, and an empty-history error's zero inserts.

Keep each returned recommendation's `llmCallId` unchanged. For a newly inserted record it must reference an already persisted success audit—the final success for the batch that produced that recommendation, not merely the last audit across a multi-batch run. Earlier failed attempts remain separate audit rows. On exact-key retry, query `recommendations.byId` first. Reuse an existing record when its domain identity, score, rationale, and evidence match, preserving its original `createdAt` and original final-success `llmCallId`; a newly observed retry audit remains independently persisted. Changed judgment/identity content under the same ID is `recommendation-conflict`, and `insertImmutable` remains the store backstop. No historical recommendation is updated.

If `scoreStories` rejects with `RecommendationError`, persist every audit exposed by `error.attempts` in one short transaction using the same mapping/reuse rule, then rethrow that error. No recommendations or failures unavailable in that error are fabricated. Unexpected errors without an upstream audit stream propagate without inventing audits.

### Failure application and freshness at commit

Story/article/ingestion writes may occur while the LLM call is outside a transaction. Before applying a returned failure, re-read that story and article in the result transaction and compare their current content versions with the planned scoring input. Apply the failure only when both still match. A stale failure remains associated only with its audits and cannot fail the replacement content; upstream invalidation has already made the queue row reachable and pending.

For each still-current `RecommendationFailure`, call `queue.markEvaluation` with `evaluationState="failed"`, the existing row's current `rankVersion`, and a monotonic timestamp. Set `lastError` to `recommendation:<category>:<code>` when `code` is at most 192 UTF-16 code units and matches `^[a-z0-9]+(?:-[a-z0-9]+)*$`; otherwise use `recommendation:<category>:invalid-code`. This fixed mapping is bounded below 256 code units and never copies provider/parser text. `retryable` remains in the returned run summary for job policy; it is not a score or preference signal. A missing queue row is repaired by the complete projection rather than by a scored-only write.

`markEvaluation` accepts only `pending`/`failed`, and personalization uses it only for those states—normally the fresh failure path. It never marks a story `scored`; scored rows are written only by complete `upsertRankingPreservingState` projections. Successful results likewise do not bypass projection alignment.

A cancelled batch's returned failed stories follow this same current-version failure path. Unattempted stories and stories deferred by `maxStoriesPerRun` have no failure and remain pending. No cancelled operation creates a negative judgment.

## Complete queue projection

`projectQueue` selects the current profile under the pipeline lock, building one first if none exists. Every projection—after scoring, after a profile/preference change, through `projectQueue`, and during recovery—assembles one canonical input snapshot inside one synchronous transaction **before one `buildQueue` call**:

1. Read every story with `stories.forQueueProjection`, using story-ID keyset pages of at most `queueSyncBatchSize` until exhaustion.
2. Read all articles for those story IDs with `articles.byStoryIds` in bounded ID chunks. Missing articles remain missing and use the domain's logical `none` version downstream.
3. Read `recommendations.currentForStories` for the exact selected `profileId`, `RECOMMENDATION_PROMPT_VERSION`, and `model`, in bounded story-ID chunks. Supply all returned version candidates; `queue` performs active story/article alignment.
4. Read every existing queue entry with `queue.forReprojection`, again keyset-paged to exhaustion, after any fresh `markEvaluation` writes.
5. Compute `blacklistedStoryIds` by calling `interests.isBlacklisted(story, profile)` for every story in that same set. Never omit the array, including when empty.
6. Build `evaluationByStory`: an exact active recommendation means `scored`; a still-current failure from this scoring result means `failed`; otherwise preserve an existing `failed` state for the unchanged profile, use `pending` for new-profile unevaluated rows, and never preserve `scored` without an active recommendation. Missing entries default to pending.
7. Choose `at` from the clock, moved forward only as needed to equal the maximum existing `updatedAt`/`queuedAt` when wall time is behind. It never moves reading timestamps backward.
8. Call `recommendations.buildQueue` exactly once with the complete `stories`, `articles`, `recommendations`, `evaluationByStory`, `profile`, `existingEntries`, `blacklistedStoryIds`, exact recommendation policy, and `at`. The default exploration seed is the profile ID.
9. Persist the complete returned array with `queue.upsertRankingPreservingState`, optionally in write chunks of `queueSyncBatchSize`, inside the same transaction. All rows share the single returned rank version.
10. Call `queue.setProjection({ profileId: selectedProfile.id, rankVersion: returnedRankVersion, projectedAt: at })` in that same transaction. An empty result stores an absent rank version. This pointer is the application's active page namespace and tells later ingestion which version new pending rows must join.

`queueSyncBatchSize` bounds repository reads/writes only. It never bounds the rank input, publishes a rank per read batch, or permits deletion of rows outside a batch. `recommendations.maxStoriesPerRun` limits provider work only; it never limits this projection. Pending, failed, blacklisted, deleted/dead, missing-article, and previously read stories all remain in the complete set. No per-batch hash is published as a queue-wide cursor version.

A scoring result transaction commits audits, new immutable recommendations, current failure writes, complete rows, and the active projection pointer atomically. If ranking or any write fails, all of those writes roll back; a later job retry can safely reuse the external result only if the provider is called again and returns compatible immutable content. `projectQueue` returns `complete: true` only after this full transaction commits. `rankVersion` is absent only for a valid empty projection.

`QueueProjectionSummary.projected` counts the complete returned set. In `ScorePendingSummary`, `queued` is that complete projected count, not the number of provider stories or newly inserted rows. `scored` counts returned recommendations active in the final projection, `failed` counts still-current failures applied, `retryableFailed` counts the retryable subset, and `audits` counts attempts observed from upstream, including reused audit rows.

## Deterministic jobs and ownership

### Version-1 payloads and dedupe keys

`personalizationJobCodecs` owns payload validation for all four kinds. New work uses `PERSONALIZATION_JOB_PAYLOAD_SCHEMA_VERSION=1`; unknown future versions fail through `job-queue`. `profileId`, `rulesVersion`, and `activityVersion` are non-empty strings of at most 256 UTF-16 code units, and `reason` follows the same non-whitespace/200-unit rule as direct calls. Codecs reject unknown keys, wrong types, empty/oversized IDs and versions, invalid reasons, and noncanonical payload shapes without echoing payload data. The enqueue factory separately validates `runAfter` as a domain ISO timestamp. Payloads contain no story titles, article text, rules, prompts, credentials, AbortSignals, lease tokens, or provider errors.

Version-1 logical payloads are:

| Kind | Payload | Dedupe-key canonical JSON |
|---|---|---|
| `personalization.profile-rebuild` | `{ reason, rulesVersion, activityVersion }` | `JSON.stringify([kind,rulesVersion,activityVersion])` |
| `personalization.score-pending` | `{ profileId }` | `JSON.stringify([kind,profileId])` |
| `personalization.queue-project` | `{ profileId }` | `JSON.stringify([kind,profileId])` |
| `personalization.recover` | `{}` | `JSON.stringify([kind])` |

`createPersonalizationJobEnqueue` validates the description, selects these rules, and returns `{ kind, payload, payloadSchemaVersion: 1, dedupeKey, runAfter }`. Reason is deliberately excluded from the profile dedupe key: the source head identifies the logical effect, and first-active-payload-wins must not create duplicate builds for the same head. A newer activity/rules head produces a different key even while an older job is leased, preventing coalescing from losing trailing activity.

### Handler behavior

`runJob` validates kind, current payload version, and decoded payload again at the application boundary.

- **Profile rebuild:** ignore the payload's source head for execution and rebuild the latest committed head. The head is a dedupe/coalescing identity, not permission to reconstruct an unbounded historical activity window. This also lets a newer job become a harmless same-version rebuild if an older handler already observed the newer head.
- **Score pending / queue project:** read `profiles.current()`. If its ID differs from the payload's `profileId`, the job is stale and returns without scoring or publishing an old-profile rank. Otherwise run the current operation. The newer profile's own transactional job handoff remains responsible for its work.
- **Recover:** run `recover` against current stored state.

A successful or stale handler returns normally. After a scoring call has committed all returned work, `runJob` throws `cancelled` when `completion="cancelled"`, or `scoring-retryable` when `retryableFailed > 0`; this lets `job-queue` requeue with its normal lease/backoff policy. Non-retryable per-story failures do not fail the whole job and never block unrelated stories. The service translates thrown errors only through `personalizationJobFailure`.

## Recovery semantics

Durable jobs are at-least-once. `job-queue` owns lease expiration, attempts, backoff, and terminal job failure; personalization owns idempotent logical effects. Transactions make the following crash boundaries deterministic:

- Crash before an activity/profile/preference transaction commits: none of its events, sessions, profile, queue, or job writes exist.
- Crash after an external LLM result but before its result transaction commits: no judgment/audit/evaluation/projection writes exist; a later attempt can repeat the external call.
- Crash after the result transaction commits but before job completion: retry sees immutable recommendations/audits and current evaluation/projection state. Reuse rules prevent duplicate logical records and timestamp drift.
- Lease loss after an external call: a stale worker may still attempt its result transaction, but the single writer plus immutable/current-version checks prevents overwriting changed history. `job-queue` rejects stale lease completion/failure separately.

`recover` acquires the profile pipeline lock, builds/selects the profile for the latest rules/activity/policy/builder head without enqueueing a duplicate score job, and sets `rebuilt=true` only when that selected profile differs from the previously current profile. It then runs one bounded scoring pass and one complete projection as part of that scoring result flow, even when zero new provider stories are selected. It returns the combined summary only after all applicable work commits. A cancelled result retains its committed partial work and returns `completion="cancelled"`; the job handler converts that to retryable cancellation instead of declaring recovery complete.

Scheduled recovery supplements durable jobs; it does not replace `recoverExpired`, fabricate missing provider audits, truncate work to a cron batch, or mark unattempted stories failed. Retryable scoring failures use job backoff. The existing store work query also includes failed rows, so an explicit/manual recovery run is a new best-effort attempt for those rows; the persisted queue schema does not retain enough retry metadata to distinguish permanent from temporary past failures across separate runs.

## Cancellation and concurrency

### Cancellation

- All async public methods validate and honor a pre-aborted signal before their operation begins. `scorePending`/`recover` return a cancelled zero-work summary at that boundary; `runJob` throws `cancelled`. Synchronous-only public operations reject with `cancelled` before their transaction.
- Waiting for the in-process profile pipeline lock is cancellation-aware. Abort removes the waiter's listener and prevents later execution.
- `scorePending` forwards the identical signal to `scoreStories`. Adapter attempt deadlines and retries remain independent.
- A mid-run cancellation returns upstream's partial recommendations/failures/audits. Personalization commits that returned work and the complete queue projection before `runJob` reports cancellation. Later unattempted stories receive no synthetic audit/failure.
- Once a synchronous store transaction begins, it runs to commit/rollback without an `await`; abort cannot partially cancel SQL or pure ranking. The operation observes cancellation at its next composition boundary.
- After settlement no new LLM call, job, timer, listener, or transaction is started for that invocation. Non-cooperative custom LLM ports retain the upstream limitation that arbitrary Promise work cannot be forcibly stopped.

### Concurrency

One `Personalization` instance owns a private asynchronous profile pipeline mutex. `rebuildProfile`, `applyPreferenceChange`, `scorePending`, `projectQueue`, and `recover` serialize through it, including across the external scoring await. This prevents an older scoring run from publishing its profile after a newer profile operation. The mutex is per instance, never module-global, and is not a database transaction.

`recordActivity` does **not** wait for that mutex or an LLM call. Its short synchronous store transaction can commit while scoring awaits; the novel event creates a distinct source-head job. Ingestion/article/account writers likewise remain available. Their story/article invalidation runs upstream, and scoring rechecks current content before applying failures or activating judgments.

Independent `scoreStories` calls are not required for this composition: one instance has at most one scoring run, which itself has at most one in-flight `generate`. Multiple processes or independently constructed writer instances are outside the concurrency contract. SQLite constraints and immutable checks are defense in depth, not multi-process coordination.

## Security and privacy boundary

Prompts and capture policy are owned by `recommendations`/`llm-interface`; personalization forwards the configured model, exact `RecommendationPolicy.capturePayloads`, and no credentials. It never adds access tokens, HN cookies, API keys, authorization headers, secret paths, raw activity payloads, or arbitrary rule text to jobs/errors. Capture-off does not reduce provider input, while capture-on remains an explicit service/debug decision.

Stored rationales/evidence and article/story text remain untrusted data. Personalization performs no model-directed retrieval, HN mutation, DOM execution, or tool call. Public errors and job failures contain stable codes and bounded safe text only. Audit payload/version pairs and absent optionals are preserved exactly during domain mapping.

## Internal subcomponents

- Activity replay/session transaction coordinator and novel-work handoff.
- Canonical profile builder and preference-change composition.
- Per-instance profile pipeline lock and cancellation checkpoints.
- Scoring work planner, external-call adapter, and current-content recheck.
- Audit/recommendation immutable mapper and final-success linkage guard.
- Complete canonical queue assembler and one-rank projection writer.
- Deterministic job codecs/enqueue factory, stale-job dispatcher, and recovery composer.

These are private implementation units; only the API above is public.

## Dependencies on other libs

- `activity` — parsing, replay classification, event/session reduction.
- `clock` — composition timestamps; no monotonic values are persisted.
- `domain` — records, schemas, article content versions, ISO timestamps.
- `interests` — profile building and blacklist computation.
- `job-queue` — durable enqueue/lease vocabulary and payload-codec registration.
- `llm-interface` — injected provider port and audit types only.
- `queue` — rank/bootstrap/domain behavior reached through the composition contract.
- `reader-store` — repositories and synchronous transactions.
- `recommendations` — scoring, audits, prompt/version constants, and `buildQueue`.

No concrete LLM adapter, SDK, config loader, database driver, scheduler, HTTP framework, or new third-party runtime dependency is imported.

## New build or OSS wrapper

New composition over the existing workspace libraries and Node built-ins. No additional third-party dependency.

## Hosted by

`reader-app` commands and background job dispatch in `services/personal-reader`. The service registers `personalizationJobCodecs`, schedules `personalization.recover` through the enqueue factory, owns worker leases/shutdown, and injects the single shared store/queue/LLM/clock graph.

## Configuration

- `personalization.cron` — **optional**, default `7,37 * * * *`; service-owned schedule for enqueuing `personalization.recover`, not a retention or batch limit.
- `personalization.activity_batch_size` — **optional**, default `500`; positive safe-integer maximum rows accepted by one `recordActivity` call.
- `personalization.queue_sync_batch_size` — **optional**, default `500`; positive safe-integer repository read/write chunk size only. Every complete rank still receives the full canonical set.
- `activity.*`, `interests.*`, `recommendations.*`, `llm.*`, `jobs.*`, and `debug.include_llm_payloads` — validated/supplied by their owning components and injected through options. No duplicate personalization keys exist.

There is no personalization provider timeout/retry count, exploration secret, queue retention, profile retention, audit retention, clock-skew, rank-version, or payload-capture key. In particular, scoring `maxStoriesPerRun` and projection `queueSyncBatchSize` have different meanings and must never be substituted for one another.

## Deliberate timing and retry limits

These limits are recorded rather than silently patched in this package:

1. **Audit timing:** `LlmCallAudit` has no attempt start/finish timestamp. Personalization records only first persistence-observation time, not exact provider chronology.
2. **Failure retry metadata:** queue entries retain safe `lastError` but no structured category/retryable/profile evaluation key. Separate scheduled/manual recovery runs deliberately make a new best-effort attempt for failed rows rather than claiming perfect permanent-failure suppression. Job-local retry/backoff remains exact, and source/profile changes always make work eligible again.

## Acceptance-focused test expectations

Tests use real SQLite for composition, a fixed clock, a scripted `LlmPort`, and the public APIs of all owning packages. No fake active-only session repository or per-batch ranking shortcut is acceptable.

### API, validation, and errors

- `should export the exact public runtime surface and register all four version-one job codecs`.
- `should reject malformed options policies sizes reasons signals and job descriptions without raw value echo`.
- `should expose fixed safe error codes messages retryability and stable metadata`.
- `should propagate owning-library errors unchanged and map worker failures without raw causes prompts or payloads`.
- `should validate zero activity and scoring budgets without calling positive-only store queries`.

### Activity transactions

- `should reject mixed-story and malformed batches before any storage read or write`.
- `should read every replay record and the latest terminal session inside the write transaction`.
- `should append novel events upsert every returned session in order and enqueue one source-head profile job atomically`.
- `should roll back novel events and prevent session and job writes when append count is short`.
- `should make full retries accept zero and enqueue nothing while partial retries apply only novel observations`.
- `should commit one logical effect for concurrent duplicate activity calls and preserve terminal-session ordering`.

### Profiles and preferences

- `should build from canonical rules latestWindow and independent latestVersion with referenced stories`.
- `should preserve the nonempty activity log version when maxActivityEvents is zero`.
- `should reuse same-version immutable profiles and original timestamps rather than conflicting on retry`.
- `should make a reused historical profile current through the durable pointer and preserve that selection across restart without rewriting the profile`.
- `should apply rule replacement profile creation blacklist projection and scoring handoff in one transaction`.
- `should roll back preference replacement when build projection or job enqueue fails`.
- `should preserve reading state and history while resetting old-profile unevaluated rows to pending`.

### Scoring, audits, and failures

- `should pass stories exact articles profile model policy scoreAt and identical signal to scoreStories outside transactions`.
- `should persist every success and error attempt once before linked recommendations across multi-batch retries`.
- `should link each new recommendation to its own batch final successful callId after earlier failed attempts`.
- `should preserve first audit timestamps and original recommendation timestamps and call links on compatible retries`.
- `should persist RecommendationError attempts before rethrowing and never invent an audit for an empty attempt history`.
- `should reject conflicting audit or recommendation identities without overwriting immutable rows`.
- `should mark only still-current failures with safe text and leave replacement story or article content pending`.
- `should write scored rows only through complete projection and never call markEvaluation for scored`.
- `should retain no recommendation score blacklist or negative preference for failed or cancelled work`.

### Complete projection

- `should assemble all stories articles current recommendations existing entries and blacklist IDs before one buildQueue call`.
- `should pass articles explicit blacklist IDs existing entries exploration policy and monotonic at to ranking`.
- `should publish one common rank version across a queue larger than several read and write batches`.
- `should update the active projection pointer atomically with complete rows so later ingestion and queue reads never split into bootstrap and ranked pages`.
- `should retain pending failed blacklisted deleted dead missing-article and read stories without queue truncation`.
- `should keep deferred stories pending when maxStoriesPerRun is smaller than the complete queue`.
- `should roll back audits recommendations failures and projection when any complete-projection write fails`.

### Cancellation, jobs, and recovery

- `should make pre-abort perform no provider storage job or audit work`.
- `should stop lock waiters on abort and remove listeners after every settlement`.
- `should commit partial cancelled results and complete projection before the job reports retryable cancellation`.
- `should create no synthetic failure or audit for unattempted stories after cancellation`.
- `should validate exact job payloads and deterministic dedupe keys including distinct trailing activity heads`.
- `should no-op stale profile-scoped jobs without publishing an old profile rank`.
- `should requeue retryable scoring outcomes only after their durable result transaction commits`.
- `should recover expired work idempotently after real database reopen without duplicate events profiles recommendations or audits`.
- `should serialize profile operations across external awaits while allowing activity transactions to commit`.
- `should prove no LLM or other Promise-returning call occurs while a store transaction is open`.

### Workflow acceptance

For WF-03, build a queue spanning multiple batches and verify every non-blacklisted story remains reachable with stable rank-version pagination. For WF-04/WF-05, verify natural/account activity is replay-safe and later personalization failure does not remove content. For WF-06, verify immediate blacklist visibility, reproducible profiles, preserved explanations, and correction without rewritten history. For WF-07, restart between every transaction boundary and verify pending/failed work remains recoverable. For WF-08, verify capture-off stores usage/status/latency only, capture-on preserves versioned non-secret payloads, and all exposed errors remain redacted.
