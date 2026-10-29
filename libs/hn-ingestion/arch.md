# Hacker News Ingestion Architecture

## Architectural role

`hn-ingestion` is a tier-3 ESM composition over the public/account HN adapters and the synchronous reader/job stores. It turns bounded external reads into durable story, queue, cursor, run, and work-handoff state. It owns orchestration, not transport, normalization, ranking, or activity algorithms.

```text
reader-app / durable job handler
  -> hn-ingestion operation lane
       -> public planner -> hn-public-api
       -> account reader -> hn-account (optional)
       -> commit-time projection
            -> reader-store transaction
                 -> stories + initial queue + cursors + run
                 -> job-queue nested savepoints
```

The only workspace dependencies are `clock`, `domain`, `hn-account`, `hn-public-api`, `interests`, `job-queue`, and `reader-store`. Node crypto is a platform primitive. Neither `queue` nor `activity` appears in runtime imports, type imports, test-only production seams, or the package manifest. Their owners meet this composition at two structural boundaries:

- `reader-app` injects the queue bootstrap rank-version value as a callback.
- A versioned job payload carries raw reconciliation observations to the downstream activity handler.

## Internal module decomposition

These modules are package-private, not public subpaths:

| Module | Responsibility | Must not contain |
|---|---|---|
| `options` | Strict factory validation, defensive snapshots, bootstrap callback snapshot | Network/storage calls, configuration loading |
| `lane` | FIFO public/account operation serialization and queued cancellation | HN parser or repository policy |
| `errors` | Fixed public errors, dependency-code mapping, safe run errors | Raw causes, URLs, content, payloads |
| `time` | Valid Date-to-domain-ISO conversion and refresh cutoff arithmetic | Global time reads, persisted monotonic values |
| `checkpoints` | Strict version-1 cursor parsing/canonicalization and validation | Guess-and-repair, truncation, error interpolation |
| `public-plan` | Bootstrap feed/lookback merge, advance selection, refresh keyset planning | Story normalization or job execution |
| `fetch-pool` | Eight-worker item reads, per-item observations, stop/await-on-failure | Database transactions, partial commits |
| `stories` | Commit-time previous-story lookup and `normalizeStory` calls | A second field-merge/content-version algorithm |
| `bootstrap-queue` | Initial pending entries and current-profile blacklist decisions | Complete ranking, profile construction, queue import |
| `jobs` | Versioned article/scoring/activity payloads plus public/reconcile scheduling codecs, enqueues, dedupe identities, and safe worker failures | Handler execution, activity reduction, scheduler import |
| `runs` | Random run identity, start/complete/fail records, summaries | Treating a running row as a lock |
| `public-commit` | The single public result transaction | Any HN call, Promise, timer, or handler |
| `account-plan` | Validated username/capability selection and one-page continuations | Mutations, inferred absence, multi-page snapshot claims |
| `account-commit` | State/intent merges, activity outbox, account cursors, terminal run | Direct activity calls or placeholder stories |
| `index` | Exact public exports and factory composition | Extra convenience APIs |

The normalizer and blacklist matcher remain in their owning libraries. This package selects inputs and persists their outputs; it must not duplicate HN field fallback, content hashing, preference normalization, rank algorithms, or activity event construction.

## Construction and dependency snapshots

Validate the complete options object before retaining references. Clone the feeds array and reject duplicates so first-run feed calls and snapshot bounds are deterministic. Invoke `bootstrapRankVersion` once, validate its bounded string result, and store only that string. The callback does not remain reachable from later operations, so a mutable caller closure cannot change initial row versions halfway through an instance's life.

This supplies the pre-projection bootstrap fallback without teaching ingestion what `qb1.initial` means; the active projection pointer owns later initial-row membership. A reader-app composition test, rather than an ingestion-side literal check, proves that the callback returns `queue.QUEUE_BOOTSTRAP_RANK_VERSION`.

The store and queue must share the same database connection. The factory can check only their documented shapes, not prove connection identity; service composition and real-SQLite handoff tests own that guarantee. Likewise, the account adapter cannot be inspected for its HTTP retry configuration. Service composition must construct it with the dedicated `maxAttempts=1` client.

## Serialized operation lifecycle

One FIFO promise lane covers both public and account work. It prevents overlapping checkpoint planning and keeps the two reconciliation writers from interleaving their multi-request phases on one instance. Each queued entry retains its own signal and starts no run until all earlier work has settled.

```text
validate signal
  -> reject pre-abort with identical reason
  -> enter FIFO lane
  -> reject again if aborted while queued
  -> read/validate checkpoints and plan
  -> insert running run
  -> external HN stage (outside transactions)
  -> cancellation checkpoint
  -> one synchronous result transaction
  -> return fresh summary
```

The fetch pool and account adapter may have their own internal concurrency/serialization; neither changes this outer ordering. No lane continuation starts external work after its caller has aborted.

### Cancellation and commit race

Every external call receives the original caller signal. On abort, stop scheduling new item/page work and await already-started fetch workers before settling the operation. This avoids returning while an untracked request can still complete.

Before opening the result transaction, check the signal one final time. Once the synchronous transaction starts, JavaScript cannot interleave an abort callback with its writes. Commit is therefore the linearization point. An abort after that point cannot produce a false rollback result or a half-written batch.

If cancellation follows run creation but precedes commit, attempt a small separate `finishRun(cancelled)` write. Preserve the exact abort reason even if that diagnostic write fails. Never serialize the reason itself: it can contain arbitrary application data.

## Checkpoint representation and planning

### Strict private envelopes

Use one strict parser for all persisted cursor envelopes. Require canonical version-1 shapes, positive/safe IDs and indices, exact feed/order invariants, and valid state transitions. Do not expose this parser publicly or put raw cursor text in errors.

The store's cursor values are text, but they are not opaque transport tokens. They are durable internal state and can be inspected by trusted migrations. A future shape change needs a new `schemaVersion` and explicit decode/migration behavior.

### Bootstrap merge

A bootstrap cursor retains the feed ID snapshot, not whole feed responses or story data. The sorted unique feed array is bounded by the official feed limits. The lookback range is represented only by its next ID and saved target, so an explicitly large backfill does not create a large cursor.

At each selection step, compare the next feed ID with `nextLookbackId`, choose the smaller, and advance every source that contains that same ID. Continue until `maxItemsPerRun` unique IDs are selected or the plan is exhausted. This gives one deterministic ascending stream with no duplicate item fetch.

The commit applies the already computed post-selection feed index/lookback position. If all work is exhausted, it instead writes the advance state at the saved target. If the transaction fails, none of those position changes survives. The next invocation repeats the same candidate plan and idempotent story/job effects.

While bootstrap is unfinished, do not refetch maxitem or feeds. This avoids moving the target and rewriting a partially completed plan. The first advance run after bootstrap collects everything above the saved target, including items created during bootstrap.

### Advance and refresh plans

Advance selection is a numeric range beginning immediately after `lastProcessedItemId`, clipped by the official target and run budget. Compute increments only when the ID is below `Number.MAX_SAFE_INTEGER`; do not overflow into an invalid API argument.

Refresh selection uses the store's story-ID keyset directly. Keep the selected story IDs and the last selected ID in the plan. A page shorter than `refreshBatchSize` means the next checkpoint restarts at the beginning. A full page stores its last ID even if it happens to be the current end; the next empty page then performs the reset.

Build the union of public and refresh IDs before network work. Retain separate plan metadata so both cursors can advance after one fetch. Sort the union for deterministic fetch/upsert/job order.

## Bounded fetch and observation pipeline

Feed/maxitem requests run sequentially in a fixed order. Item requests use eight worker slots and no recursive queue growth beyond the already bounded selected ID list. A worker:

1. Checks cancellation and the shared failure flag before taking another ID.
2. Calls `api.item(id, signal)`.
3. Takes a fresh wall-clock observation only after a successful response.
4. Stores `{ id, item, observedAt }` in a result slot; it performs no normalization or storage write.

On the first failure, set the failure flag. No worker takes new work, started calls are awaited, and the coordinator maps the earliest candidate failure deterministically after all workers settle. There is no internal retry or sibling abort reason that could replace the caller's own cancellation identity.

The eight-request bound limits upstream pressure and in-flight memory. The API's per-response byte bound and the selected candidate bound limit retained raw items. Results remain local to one operation; no cross-run item cache exists.

## Commit-time story and queue projection

### Previous story selection

Normalization is deliberately delayed until the result transaction. For each fetched item in ascending ID order, read `store.stories.byId(id)` and call:

```text
hn-public-api.normalizeStory({
  item,
  observedAt,
  previous: currentStoredStory
})
```

This is pure synchronous work and is allowed inside the transaction. Reading previous state at commit avoids merging a sparse tombstone against a stale pre-network snapshot. A concurrent application action cannot interleave with this synchronous writer critical section on the supported single-connection topology.

Keep three outcomes distinct:

- **Normalized story:** include in the upsert/projection set.
- **Known non-story or missing item:** no story write; advance the processed checkpoint.
- **Incomplete story/tombstone:** no story write; preserve any previous row and advance the processed checkpoint. Do not infer a type or manufacture required metadata.

For normalized stories, compare with the same previous row to decide whether article/scoring work is needed: previous absent or previous content version differs. Observation, score, descendants, and raw-only changes still upsert current state but do not create content jobs.

### Initial queue entries

Read the current profile and active queue-projection pointer once in the transaction. Build pending entries only after all normalized stories are known, using the pointer's rank version when present, otherwise the snapshot bootstrap rank version, and `isBlacklisted` for that profile. With no profile, visibility is visible. New rows therefore remain in the same application page as existing ranked rows while waiting for their own scoring/projection.

Call `insertPendingIfMissing` with the complete sorted entry set. This repository method is the only ingestion queue write. Do not call ranking upserts, state updates, or evaluation updates here. Consequently:

- replay cannot reset reading state or queued time;
- ingestion does not overwrite a later complete rank projection;
- the reader-store story upsert remains the only content-version invalidation path;
- initial rows never split into a separate bootstrap page after a complete projection exists.

A later personalization projection recomputes profile-specific visibility for all rows. Initial visibility is still required so a newly blacklisted story is hidden immediately rather than waiting for that later work.

## Transactional job handoffs

### Durable scheduled entry points

`ingestion.collect` and `ingestion.reconcile-account` are empty-payload version-1 jobs. Their codecs reject every unknown field and unsupported version, and their enqueue factory uses the kind as the active-work dedupe key. Reader-app calls the factory at scheduler ticks and dispatches a claimed job to the same public methods used by manual commands. The operation lane therefore serializes scheduled and direct work without a second execution path. Owner failure mapping preserves safe known codes/retryability and converts unknown worker failures to generic retryable `ingestion-failed`; reader-app owns safe cancellation normalization and all lease transitions.

### Article and scoring

Construct all job inputs before calling `jobs.enqueue`, but execute the calls inside the outer store transaction. `job-queue` joins through nested savepoints. Its active dedupe index is a backstop and its `inserted` result feeds summary counts.

Article dedupe identity contains the complete logical extraction input: story ID and story content version. The downstream handler must compare the payload source version with the current story before writing an article, because an older active extraction can coexist with a newer one.

The scoring handoff uses the exact `{ profileId }` payload and canonical JSON `[kind,profileId]` dedupe identity owned by personalization. Ingestion constructs that shape structurally rather than importing the downstream package. An active dedupe hit is an existing handoff and is not counted as newly inserted.

With no current profile, emit the canonical `personalization.recover` handoff with `{}` and `[kind]` dedupe identity. Recovery builds/selects a profile before scoring, so ingestion does not invent an ID or a parallel no-profile scoring protocol. Profile-scoped scoring and recovery follow the downstream stale-job/current-state behavior rather than introducing run-scoped payload variants that its codecs would reject.

### Structural activity outbox

Account reconciliation cannot call the activity package directly without adding a forbidden dependency. Use the job table as a transactional outbox:

```text
account current-state write
  + personalization.record-activity job containing one raw observation
  + account cursor / intent / run writes
  -> one SQLite commit
```

Generate the 32-byte client identity only for a novel current-state observation that survives the known-story filter. Store its base64url form in both the payload and dedupe key. Once committed, that exact identity survives claim, lease expiry, handler retry, and process restart. If the result transaction rolls back, the job and generated identity disappear together and no external activity effect was visible.

The handler belongs to `reader-app`, which already depends on activity/personalization. It decodes the version-1 payload and passes the one-story batch to `personalization.recordActivity`. The activity reducer, not ingestion, assigns receipt-derived `occurredAt`/`receivedAt` and `evt_` event identity. A repeated handler attempt therefore performs replay classification against the same `clientEventId`.

This design avoids two failure modes:

- a direct state-then-activity call can lose the activity effect on a crash;
- regenerating an ID on each retry can duplicate current-state evidence.

It also avoids deriving transition identity from observation timestamps. Such a derivation is unstable before the state commit and can collide when a wall clock ties or moves backward.

## Public run transaction and failure handling

A public run has exactly one result transaction. The run starts separately so operators can see in-flight work, then all external calls complete before the final transaction:

```text
startRun(running)
  -> external planning/fetch work
  -> store.transaction:
       previous reads + pure normalization
       story upserts
       initial pending inserts
       public + refresh cursor writes
       article + scoring enqueues
       finishRun(complete, final counters and cursor)
  -> summary
```

There is no loop that commits a second batch under the same run. This is what lets terminal `finishRun` participate in the same atomic boundary as every result write despite the store having no running-counter update method.

If any result write fails, the database helper rolls back the complete transaction. The failure path writes a terminal failed run separately with no claimed batch counters. If the process dies before either terminal write, the running row remains stale but harmless. A later run reads only cursors for recovery; it does not wait for or reuse the old run ID.

Run IDs and handoff client IDs come from Node crypto. Run IDs provide correlation, not exactly-once execution. Exactly-once external HN requests are neither claimed nor required; logical persistence and downstream handlers are idempotent.

## Account reconciliation architecture

### Page planning and capability evidence

Account reconciliation first establishes positive username evidence and then obtains capabilities. These operations are separate because `capabilities()` does not return the validated username. Both are read-only and remain outside storage transactions.

For each available list kind, load its strict continuation envelope and require the same kind and validated username. Read at most one page per kind in a fixed order. Disabled/unverified flag capability results in no `readFlagged` call.

A page's input cursor is retained with its observations for `sourceCursor`; its `nextCursor` belongs to the account checkpoint. No continuation crosses account or kind. A terminal page clears continuation, causing the next run to begin a new current-state scan rather than stopping reconciliation permanently.

The run does not fetch unknown story stubs and does not call public API to fill account history. Unknown-story observations are counted and omitted. This keeps account work bounded and avoids turning reconciliation into an implicit queue backfill.

### Current-state and intent merge

Read existing account states inside the commit transaction through `byStoryIds(username, kind, observationStoryIds)` and index by story/kind. Each list is derived from that kind's bounded observation page, so existing-row reads are bounded by actual candidates rather than total account history. First-observation preservation does not require a full current-state scan.

For each observation, construct a fresh domain state:

- existing first observation wins;
- last observation is the maximum durable/new observation timestamp;
- latest actual presence and source cursor win even under a backward wall clock.

Only novel first/changed presence creates an activity outbox row. Repeated presence still refreshes current-state observation metadata and can reconcile an indeterminate intent.

Intent reconciliation is intentionally narrower than state reconciliation. For each positive observation, use the filtered `pendingOrIndeterminate({status:"indeterminate",storyId,action,...})` keyset within one total candidate budget. Change only exact story/action matches with explicit positive presence. Verified rows leave subsequent candidate pages, and unrelated pending/history rows cannot starve the target. Version-1 result evidence records reconciliation source and observation time. It contains no claim that the earlier POST was the request that caused the state. Pending intents, false observations, and missing rows remain untouched.

The account result transaction has the same single-batch shape as public collection: states + account cursors + intent outcomes + activity jobs + complete run. No direct activity callback occurs inside it.

## Error normalization and secret containment

Keep a private operation/run/dependency context while work proceeds. At the outer boundary:

1. Re-throw caller abort reasons unchanged.
2. Map expected public/account adapter errors to `upstream-failure`, retaining only safe code/retryability.
3. Map store/database and enqueue errors by their stage, retaining only safe code and database retryability.
4. Map invalid persisted checkpoints to `invalid-checkpoint` before using their values.
5. Map unexpected application errors to `internal-failure` without a public cause.

Fixed messages are used both publicly and in failed run rows. Do not attach raw error objects as `cause`, even privately on the returned public error. A debugging logger, if added by a higher layer, must receive only allowlisted codes/correlation IDs rather than the discarded values.

Checkpoint text and HN continuation URLs are especially important exclusions: account continuations are unauthenticated read URLs but can contain implementation-specific query data. Story titles/HTML, account usernames/cookies, intent idempotency keys, job payloads, and raw dependency messages likewise never enter safe errors.

## Concurrency, consistency, and resource bounds

- One instance has one operation lane and at most eight public item requests in flight. Account operations additionally inherit the account adapter's serial/throttled lane.
- All result transactions are synchronous. On one process/connection, they cannot interleave with another local writer transaction. SQLite constraints and job active-dedupe indexes remain backstops, not replacements for planning/idempotency.
- A multi-request account list is not a point-in-time snapshot. Current-state rows are idempotent evidence from different observation times.
- A public batch is one atomic projection, but separate invocations do not form a global HN snapshot. `maxitem`, feeds, and items can change upstream between requests.
- Bounded work never means bounded retention. Unselected IDs/stories remain for later runs; pending queue rows and historical observations are not deleted.
- Wall-clock values record observations and age cutoffs. Monotonic values are not used for persisted freshness, request scheduling, or account occurrence.
- The library owns no scheduler, close method, worker loop, or shutdown timer. The service stops new jobs, signals active operations, drains them, and then closes borrowed resources.

## Design trade-offs

- **One result batch per run versus multi-batch runs.** Catch-up needs multiple invocations, but every terminal run record can commit atomically with its entire result. This fits the current store API and keeps failure counters unambiguous. A future multi-batch runner needs a running-progress repository contract first.
- **Persisted bootstrap feed snapshot versus refetching feeds.** The snapshot uses bounded cursor storage and makes retry/cap behavior deterministic. It may temporarily omit a feed row added during bootstrap, but the advance maxitem cursor collects that item afterward.
- **Commit-time normalization versus normalize-before-transaction.** It repeats a small previous-story read after network work, but ensures sparse tombstones merge against the latest durable record and keeps transaction writes based on one current snapshot.
- **Fixed item concurrency versus sequential collection.** Eight requests reduce wall time without introducing a new setting or unbounded upstream fan-out. Sequential feed/maxitem calls keep planning deterministic.
- **Callback bootstrap version versus a queue dependency.** The callback is one extra composition line, but preserves tier direction and supplies the shared pre-projection fallback while the active projection pointer handles later rows.
- **Empty durable scheduling payloads versus direct cron execution.** Fixed-kind active dedupe can coalesce overlapping ticks, but collection survives process restart and uses the same codecs, worker recovery, and operation lane as other background work.
- **Canonical profile/recovery handoffs versus custom run-scoped jobs.** Active profile-scoped dedupe and periodic recovery can delay trailing work, but using the personalization owner's payload and stale-job contracts avoids an incompatible parallel protocol. Recommendation/store version checks keep repeated drains idempotent.
- **Transactional activity outbox versus direct reduction.** A new job topic/handler is required, but state and handoff cannot diverge and retry identity remains durable without an activity import.
- **Skip unknown account stories versus implicit story backfill.** Some old account observations remain unrecorded until public collection knows their stories. This is preferable to unbounded account-triggered public fetching and unexpected queue expansion; the summary makes the omission visible.
- **Observation-keyed account reads versus complete current-state scans.** Keyed state/intent reads require more targeted queries but bound work by the current observation/candidate budget and prevent unrelated history from starving reconciliation.

## Testing seams and verification design

Use public factory/method calls only. Private checkpoint formats are verified through `store.sync` values in integration tests, not exported helpers. Scripted adapters control page/item ordering, deferred settlement, malformed outputs, and error codes. A fixed clock controls observation/cutoff/run timestamps; crypto IDs are asserted for shape, retention, and correlation rather than exact values.

### Public contract suite

Table-drive empty/partial bootstrap plans, feed overlap, lookback overlap, safe-integer boundaries, advance targets moving forward/backward, and full/short/empty refresh pages. Reopen the real database between every batch in one scenario to prove cursor recovery rather than in-memory continuation.

Use official-shaped typed/type-less sparse tombstone fixtures from `hn-public-api`. Verify the exact previous object and observation passed by using the real normalizer and inspecting persisted stories. Do not replace it with a fake that accepts incomplete stories, which would hide missing-required-field behavior.

Assert initial queue rows across two profiles and blacklist states, exact article/scoring payloads and dedupe keys, and replay preservation. Instrument each repository/job method to fail in turn and assert the complete pre-transaction snapshot is restored except for the separate terminal failed run.

### Cancellation and concurrency suite

Use deferred API responses to abort before queue entry, while queued, during eight-worker fetch, and immediately before commit. Assert exact reason identity, no later scheduling, all started workers settled before rejection, and no result batch. Use a synchronous commit marker to prove post-linearization abort cannot roll back.

Run public and account calls together and verify FIFO execution on one instance. Confirm no adapter call occurs while the store reports an open result transaction and no listener/worker remains after settlement.

### Account/outbox suite

Fixture capabilities independently for all list kinds and both flag states. Bind saved continuations to the wrong username/kind and prove they are not used. Include repeated, changed, false-positive-evidence, absent, and unknown-story observations.

Claim the real activity handoff job, pass it through the actual reader-app/personalization handler, and repeat the handler attempt. Assert one logical activity event with receipt-derived timestamps and partial quality, while the raw payload itself has no `occurredAt`. Roll back the account transaction and prove no job or activity effect survives. Separately enqueue both public scheduling kinds repeatedly, restart the worker, and prove active dedupe plus exact dispatch to the public methods without scheduler or lease logic in this package.

Finally, compose the account adapter with its dedicated no-retry HTTP client and count exact wire attempts through validation, capabilities, and page reads. This is the only acceptable way to verify that ingestion did not bypass account throttling with hidden retries.
