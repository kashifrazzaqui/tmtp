# Personalization Library Architecture

## Architectural role

Implement `spec.md` as the tier-3 stateful composition over pure activity, interest, recommendation, and queue libraries plus reader-store and job-queue. The package is the only place where those contracts become one durable personalization pipeline.

```text
activity command
  -> parse -> synchronous replay/session/job transaction

profile/preference/recovery command
  -> canonical store snapshot -> pure profile build -> complete rank -> job handoff

score command/job
  -> bounded current-version work plan
  -> external scoreStories call with no open transaction
  -> audits + immutable judgments + current failures + one complete rank transaction
```

The design has two kinds of coordination and they must not be confused:

- a **per-instance asynchronous pipeline mutex** orders profile/scoring/projection operations, including across an external await;
- **short synchronous SQLite transactions** make each durable boundary atomic. No transaction remains open while waiting for the mutex, provider, timer, or any other Promise.

`recordActivity` deliberately uses only the second mechanism. A reading command never waits behind an LLM call.

## Internal decomposition

These modules are private organizational units, not public subpaths:

| Module | Owns | Must not contain |
|---|---|---|
| `options` | Constructor/direct-call validation, safe option errors | Configuration-file loading or hidden defaults |
| `time` | ISO wall timestamps and not-before queue/profile times | Persisted monotonic readings or global `Date` access |
| `activity-command` | Parse-first batch boundary, replay/session reads, append-count guard | A second activity reduction algorithm |
| `profile-builder` | Latest window/version snapshot, referenced stories, immutable reuse, current-profile pointer selection | LLM calls or activity retention policy |
| `pipeline-lock` | Cancellation-aware serialization of profile/scoring/projection operations | Module-global state or database locking |
| `score-planner` | Current profile, `needingScoring`, planned articles/version fingerprints | Queue truncation or provider retries |
| `score-executor` | Exact `scoreStories` input, signal/at forwarding, external-call boundary | Open SQL transactions |
| `audit-writer` | Audit-to-domain mapping, first-observed timestamps, cross-retry reuse | Attempt timestamp fabrication or payload mutation |
| `judgment-writer` | Immutable recommendation reuse, judgment conflict checks, audit-first inserts | History overwrite or replacement call-link selection |
| `failure-writer` | Current-content comparison and safe pending/failed-only evaluation writes | Negative preferences or scored-only updates |
| `projection` | Full canonical assembly, blacklist set, evaluation map, one `buildQueue` call | Per-page ranking or per-batch rank publication |
| `jobs` | Payload codecs, deterministic enqueue descriptions/dedupe keys, stale-job dispatch | Lease ownership or worker polling |
| `recovery` | Current-head build, bounded scoring, complete repair projection | A second retry/lease system |
| `index` | Exact public API | Internal helpers or additional runtime exports |

The pure owning libraries remain the source of truth for algorithms. In particular, this package calls `domain.articleContentVersion` only through store/recommendation/queue contracts; it does not maintain a parallel article hash. It calls `interests.isBlacklisted` for the same story/profile snapshot used by `buildQueue` rather than duplicating rule matching.

## Instance state and lock design

A constructed instance holds only injected dependencies and synchronization state:

```text
options (validated, not mutated)
profilePipeline tail Promise
waiter abort listeners (only while waiting)
```

There is no module-level planner, attempt array, job registry, random source, controller, or cache of current domain records. Every operation reads the store snapshot it needs after acquiring the pipeline. This avoids stale in-memory profile selection and lets real SQLite integration tests observe the actual behavior.

The pipeline mutex covers:

- `rebuildProfile`;
- `applyPreferenceChange`;
- `scorePending`;
- `projectQueue`;
- `recover`, through private non-reentrant building/scoring/projection helpers.

Public methods must not acquire the same non-reentrant mutex recursively. `runJob` dispatches to these public operations or to one private equivalent; `recover` uses private helpers so its single lock scope covers the whole recovery pipeline.

The mutex remains held across `scoreStories`. That is intentional: if an old-profile scoring operation could publish after a newer preference rebuild, it would restore an obsolete rank version. Holding the mutex does not block activity, ingestion, article extraction, account reconciliation, reads, or the job-queue's own SQL because none of those operations needs this lock and none is called inside its database transaction.

Waiting is abortable. A waiter registers one abort listener, removes it on acquisition or abort, and never enters the critical section after abort. Once acquired, synchronous-only operations run to their transaction boundary. Scoring forwards the caller signal; lock ownership is always released in `finally`, including provider, validation, persistence, and cancellation outcomes.

The service constructs one writer instance. Two processes, or two independently constructed personalization writers, do not share this mutex and are outside the design. Immutable stores and current-content checks are backstops, not a substitute for that topology.

## Timestamp architecture

`clock.now()` is read only at composition boundaries and converted to the domain ISO UTC representation. Monotonic time is never persisted.

Three timestamps have different meanings:

1. **Profile `builtAt`:** for a new version, at least the current wall time and, when necessary, one millisecond after the prior current profile's `createdAt`. A same-version existing profile retains its original timestamp instead.
2. **Recommendation `createdAt`:** one `scoreAt` captured before `scoreStories`, forwarded unchanged so the pure package can assemble deterministic records without a clock.
3. **Audit `createdAt`:** first persistence-observation time assigned after the external result settles. On later observations of the same `callId`, the stored first timestamp wins. The upstream audit has no exact attempt wall time, so this field must not be described as one.

Queue `at` is a separate not-before value. Calculate the maximum of current wall time and every existing entry's `updatedAt`/`queuedAt`; equal is valid. This avoids backward reading timestamps when the system clock regresses. It does not add a hidden skew configuration or alter `queuedAt`.

Job `runAfter` is explicit. Activity uses the shared receipt timestamp already assigned to novel events, avoiding another clock read. Other enqueue paths use their composition timestamp.

## Activity transaction design

The activity command is an exact adapter around `parseActivityBatch` and `reduceActivity`:

```text
parse outside storage
  -> reject empty/oversized/mixed-story boundaries as documented
  -> BEGIN synchronous transaction
       query every distinct incoming client ID
       query latest active-or-terminal session for the one story
       reduceActivity(parsed, latest, policy, clock, replayRows)
       appended = appendIdempotent(novelEvents)
       require appended === novelEvents.length
       upsert sessions[0..N] in reducer order
       if novelEvents nonempty:
         read post-append activity head and current rules head
         enqueue profile-rebuild(source head)
  -> COMMIT
  -> return novel count and actual job-inserted flag
```

The append-count guard detects an incomplete replay read before a session can double-count dwell or a job can claim a partially applied batch. It throws before session/job writes; the outer transaction removes already appended novel rows. Database uniqueness remains a second line of defense.

A latest-terminal-session read is essential. After completion, abandonment, or an orphan terminal observation, the terminal row carries the `(updatedAt,lastClientEventId)` high-watermark needed to reject stale events and start the next session. The composition must not wrap an active-only query with a more convenient-looking interface.

The transaction body has no Promise. On one JavaScript thread and one synchronous connection, concurrent calls therefore linearize. A replay-only batch performs no event insert, session update, clock read, or enqueue. A partial retry reduces only novel events, so sessions and accepted counts reflect new evidence only.

## Profile construction design

The profile builder runs inside the caller's synchronous transaction so rules, activity head, referenced stories, profile insertion, projection, and job handoff share one snapshot.

### Canonical snapshot

Read `latestWindow(maxActivityEvents)` and `latestVersion()` independently. This matters at zero: an empty selected suffix of a nonempty log still has the latest append sequence as its version. Do not infer the version from the returned window. For a nonzero window, the last window event's sequence is the head and `interests` validates that relationship.

Load referenced stories by unique story ID. Foreign keys should make missing rows impossible, but passing only found rows lets `buildInterestProfile` produce its documented `missing-story` error rather than silently inventing story features.

### Immutable version reuse

Build first to obtain the policy version, deterministic profile ID, and canonical content. Query `byVersion` before insert:

- no existing row: insert the newly built profile;
- existing row: use the stored row and discard the new timestamp/reason metadata;
- same ID with incompatible stored content: the repository immutable check fails the transaction.

This makes an at-least-once handler safe without overwriting explanation history. After insertion/reuse, call `profiles.setCurrent(selectedId, builtAt)` and use its returned stored record before projection or job enqueue. The singleton pointer makes selection durable even when the chosen profile is older than another history row. It changes no immutable profile field; pointer selection time is operational metadata. A failed pointer write rolls back the complete build/projection/job boundary rather than publishing a different current profile.

### Preference and rebuild boundary

Preference replacement, build, complete projection, and score-job enqueue share one outer transaction. Repository methods and queue enqueue can use nested savepoints, but only the outer return commits. Any invalid normalized rule, missing story, ranking conflict, or enqueue failure removes the preference replacement too.

When the selected profile changes, the projection treats rows without an exact active recommendation as pending rather than carrying forward an old-profile scored/failed outcome. Exact historical recommendations for the selected profile/content/prompt/model may become active again. An unchanged profile preserves existing failed states. This distinction belongs in the projection evaluation-map builder, not in story/article invalidation.

## Scoring pipeline

### 1. Plan under the pipeline, without a write transaction

Read the current profile and a deterministic bounded set from `needingScoring`. Use the recommendation prompt constant and exact configured model; the store query already excludes exact immutable successes and sees upstream-invalidated pending/failed rows. Load the articles for precisely those story IDs.

Retain a private per-story fingerprint of story content version and domain article content version. Returned failures do not carry these versions, so the fingerprint is needed to decide whether a failure still applies after the external await.

A zero scoring limit produces an empty plan without calling a positive-limit repository query. The subsequent complete projection can still repair rank state.

### 2. Execute outside SQL

Call `scoreStories` once with the complete plan, articles, policy, `scoreAt`, and the exact signal object. The recommendations package performs sequential batch calls; personalization adds no concurrency or retry loop. While this Promise is pending, there is no open store transaction. Activity and ingestion can commit and are handled at the result snapshot rather than blocked for provider latency.

If `scoreStories` throws `RecommendationError`, its exposed attempts go through the audit writer in their own transaction and the original error is rethrown. If it returns normally, all result handling uses one outer result transaction.

### 3. Persist audits first

The audit writer processes the returned attempt array in order. It rejects duplicate IDs within that stream. For each ID:

```text
stored = llmCalls.byId(callId)
if absent:
  map audit + firstObservedAt -> LlmCallRecord
  insert(record)
else if upstream audit fields are equivalent:
  retain stored record and original createdAt
else:
  throw audit-conflict
```

Equivalence excludes only the composition-owned `createdAt`. Payload/version pairs, usage, status, request hash, model, purpose, provider request ID, and error code remain immutable upstream content. New rows are all inserted before any new recommendation satisfies its foreign key.

The design does not duplicate a batched call once per story. Many recommendations may reference one final successful audit; every failed earlier attempt remains a separate row.

### 4. Insert or reuse judgments

For each returned recommendation, query by deterministic ID. An absent record is inserted unchanged after verifying that its `llmCallId` resolves to a stored success audit. Do not replace it with the last audit in the overall run: different batches have different final successes.

An existing record can be reused only when its domain key, score, rationale, and evidence match the returned judgment. Preserve the stored `createdAt` and `llmCallId`; a repeated provider operation can legitimately have a new audit ID while representing the same immutable logical recommendation. Changed judgment content under the deterministic key fails instead of choosing first/last writer silently.

The canonical projection later reads recommendations back from the store, so it always links the persisted explanation rather than an unpersisted retry variant.

### 5. Re-check failure freshness

For each returned failure, compare the planned fingerprint with the story/article rows read in the result transaction. A mismatch means upstream content invalidation already superseded this operation. Keep the audits, keep any immutable historical judgments, but do not write the old failure onto new content.

For a current failure, use `markEvaluation("failed")` with the row's existing rank version and the spec's bounded `recommendation:<category>:<code>` mapping, including its safe fallback for an invalid/oversized code. Successful results never use `markEvaluation`: their scored state comes only from exact active recommendation alignment in the complete projection. This keeps store writes within the pending/failed-only API and keeps story/article stale invalidation in the upstream upsert where it belongs.

### 6. Project and commit once

Read the complete canonical projection set after audit/judgment/failure writes, rank once, and upsert the complete result. Audits, judgments, failure states, and queue rows therefore commit or roll back together. The result summary is calculated from the final projection and the still-current failure set, not from optimistic pre-commit counts.

## Complete projection algorithm

A single private projection function serves every flow. Its arguments identify the selected profile, whether the profile just changed, and any fresh failure outcomes; its store reads all occur in the caller's transaction.

```text
allStories       = exhaust forQueueProjection(afterStoryId, batchSize)
allArticles      = byStoryIds for every allStories ID, in ID chunks
allCandidates    = currentForStories(profile,prompt,model), in ID chunks
allExisting      = exhaust forReprojection(afterStoryId, batchSize)
blacklistedIDs   = allStories where isBlacklisted(story,profile)
evaluationByID   = align active recommendation / fresh failure / existing state
at               = notBefore(clock.now(), allExisting timestamps)
ranked           = buildQueue(one complete input)
                    -> queue.rankQueue(one complete input)
write ranked in chunks with upsertRankingPreservingState
setProjection(profileId, ranked.rankVersion, at) in the same transaction
```

`currentForStories` intentionally supplies version candidates rather than a created-time latest row. `queue.rankQueue` selects the one exact profile/story-content/article-content active recommendation and rejects ambiguity. The evaluation map must agree: active means scored, and no active record can remain scored. For an unchanged profile, an existing failed row stays failed unless a current success activates. For a changed profile, an unevaluated row starts pending; fresh failures still become failed.

Only after the complete arrays exist does the code call `buildQueue`. Read/write chunking is an I/O strategy, not a ranking hierarchy. In particular, this invalid design is forbidden:

```text
for each story page:
  rankQueue(page)       // wrong: different hash and incomplete exploration pool
  upsert(page)          // wrong: publishes incompatible cursor namespaces
```

There is no deletion step for stories absent from a scoring plan. The story pages define the complete desired set, so upserting that full ranked result preserves all collected stories. The singleton projection pointer commits with those rows and records the same profile/rank/at values returned to the caller. Later ingestion places new pending rows in that namespace; before the first nonempty projection it uses the shared bootstrap namespace. `maxStoriesPerRun` appears only in the planner, never here.

### Resource behavior

For `S` stories, `R` current recommendation candidates, and `E` existing entries, assembly indexes are `O(S+R+E)` after bounded reads; ranking retains queue's `O(S log S)` worst-case sorting and complete-set memory. `queueSyncBatchSize` limits SQL result/parameter/write chunk sizes, not total memory or retention. This is deliberate: one canonical exploration pool and one content-addressed rank version require the complete logical input.

The result transaction can be larger than an activity transaction, but it remains synchronous and has no external wait. That is the correctness/throughput trade-off for the target single-user SQLite monolith.

## Job codec and dispatch architecture

`personalizationJobCodecs` is a side-effect-free registry suitable for service construction before `createPersonalization` exists. Each codec validates version 1 and returns a fresh current payload. Future payload versions are rejected by job-queue rather than guessed. The enqueue factory uses the same validators, so locally produced and stored/decoded jobs share one contract.

Dedupe keys are canonical JSON tuples rather than delimiter concatenation, avoiding ambiguity in opaque versions. Profile rebuild keys include source heads but exclude reason. Score/project keys include profile ID. Recovery has one active logical effect.

```text
activity novel head -> profile-rebuild(rulesHead,activityHead)
profile selected    -> score-pending(profileId)
explicit repair     -> queue-project(profileId)
cron                -> recover({})
```

A profile job executes the latest head, not a historical window. A score/project job first compares its payload profile to `profiles.current()` and no-ops when stale. This prevents an old queued job from publishing an old profile after a newer build. Distinct source-head keys ensure that an active leased older rebuild cannot suppress a newer activity commit's only job.

The application handler does not manage leases. The worker claims/renews/completes/fails outside this package. A handler that returns cancellation or retryable scoring has already committed returned work; throwing the safe composition error then lets job-queue apply bounded backoff without losing audits or judgments.

## Recovery and crash consistency

Recovery is composition, not another storage protocol:

1. Acquire the pipeline.
2. Snapshot the prior current profile and build/select the latest source-head profile without enqueueing a second score job.
3. Report `rebuilt` only if the selected profile differs from that prior current profile.
4. Run one bounded score pass; even an empty plan performs complete projection repair.
5. Return only after the applicable transaction commits. Cancellation returns partial status to a direct caller and becomes a retryable job failure through `runJob`.

At-least-once execution is safe because each logical write is either immutable/reused, current-version guarded, or a complete deterministic projection. External generation itself is not exactly-once and may be repeated after a crash. The design does not claim otherwise.

| Crash/lease point | Durable outcome and retry |
|---|---|
| Before activity/profile/preference commit | Entire boundary absent, including its job; caller/job can retry. |
| During provider await | No result writes; lease recovery starts a new attempt later. |
| After provider return, before result commit | No result writes; external call may repeat. |
| After result commit, before lease completion | Audits/judgments/projection exist; retry queries/reuses them and performs no duplicate logical insert. |
| Stale worker after lease loss | Pipeline/current-content/immutable checks constrain writes; job-queue rejects stale lease transitions. |

Job attempts and terminal failures remain observable through job-queue. Personalization does not reset attempts, swallow a failing transaction, or mark an exhausted job complete merely because some stories succeeded.

Cross-run failure policy is deliberately best-effort: `needingScoring` includes both pending and failed rows, while queue entries lack structured retryable/category/profile failure metadata. Job-local retryable failures use backoff correctly; a later independent recovery can retry an old permanent failure rather than claiming perfect suppression. This avoids a parallel retry table and never makes failed work unreachable.

## Security and dependency boundaries

The composition imports no concrete provider, SDK, database driver, scheduler, or configuration package. Its LLM dependency is the `LlmPort` structural interface; its provider call is still indirect through `scoreStories`. `reader-store` and `job-queue` must share the same database for outer transaction enqueue handoffs.

Audit mapping copies only the versioned fields supplied upstream. It does not add `null` payloads, provider headers, endpoint settings, or credentials. Job payloads carry identifiers and a bounded reason only. Safe failure text uses stable category/code fields and never raw provider/parser messages.

The package does not render rationale/evidence, follow model-provided URLs, invoke tools, or initiate HN actions. Article and story text remains inside the documented recommendation projection and optional explicit capture path.

## Design trade-offs

- **Pipeline mutex versus duplicate scoring throughput.** Serializing one instance can repeat less provider work and prevents old-profile publication, but sacrifices concurrent independent scoring. The single-user provider-bound workload favors deterministic writes and simple cancellation.
- **Lock across external await versus shorter critical sections.** Holding the in-memory lock is necessary for profile order; holding a SQL transaction would be harmful and is forbidden. Activity/ingestion remain outside the lock to preserve reading and collection responsiveness.
- **Complete in-memory rank versus incremental ranking.** Complete assembly costs memory and a larger synchronous transaction, but it is the only way to preserve one exploration pool, one rank version, and complete queue retention with the existing pure API.
- **First-observed audit time versus fabricated attempt time.** Persistence time is coarse but honest. Exact per-attempt chronology requires an upstream timestamp field.
- **Reuse existing judgment links versus rewrite to latest retry.** Preserving original `createdAt`/final-success link keeps explanations immutable. New retry audits remain available even when the compatible existing recommendation is reused.
- **Current-content failure check versus blocking content writers.** Rechecking after the external call allows ingestion/extraction to continue and avoids attaching old failures to new content. It requires keeping version fingerprints in the plan.
- **Stale job no-op versus executing payload history.** Current-profile execution avoids old ranks and unbounded historical reconstruction. Source/profile payloads are logical work identities, not snapshots for replay.
- **Durable current-profile pointer versus creation-order selection.** One mutable singleton adds a store write but supports historical reversion without changing immutable profile timestamps or adding in-memory selection state.

## Testing seams and verification design

Use the real package composition with real temporary SQLite, all reader/job migrations, a fixed clock, and a controllable fake `LlmPort`. Avoid mocks for SQL behavior. The fake port journals requests, returns multi-attempt results, throws interface-shaped errors, and holds settlement open for cancellation/concurrency tests. A transaction journal can assert that no provider call occurs between transaction begin/commit without replacing repository behavior.

Test layers are:

1. **Codec/API unit tests:** exact exports, strict payload/version validation, canonical dedupe keys, options/errors, abort validation, and safe job-failure mapping.
2. **Activity integration tests:** complete replay reads, terminal latest session, append-count rollback, multi-session upserts, novel-only jobs, and concurrent duplicates.
3. **Profile integration tests:** latest window plus independent version at zero/nonzero budgets, referenced-story validation, immutable reuse, durable current-pointer selection, successful historical reversion across restart, preference rollback, and immediate complete blacklist projection.
4. **Scoring integration tests:** exact articles/at/signal arguments, audits-before-recommendations, per-batch final-success linkage, timestamp reuse, `RecommendationError.attempts`, current-content failure checks, and no scored `markEvaluation` call.
5. **Projection golden/integration tests:** more stories than two batch sizes, exact article/blacklist/existing/at inputs, one rank version, complete pending/failed/history retention, and rollback across every result write.
6. **Cancellation/concurrency tests:** pre-abort, lock-wait abort, mid-call partial commit, no unattempted failures, stale-job no-op, and old/new profile ordering across a held provider Promise.
7. **Restart tests:** close/reopen SQLite around every commit boundary, recover real expired leases, rerun handlers, and assert logical counts plus original timestamps/call links remain stable.

For cross-package proof, compare the projection's one `buildQueue` call with direct `queue.rankQueue` on the identical full fixture. Assert input arrays were fully assembled before that call; a final-row count alone would not detect per-batch rank publication. Use independent expected rank versions and audit/recommendation linkage fixtures rather than production serializers to compute expectations.

The historical-profile-reversion test must reopen the database after selecting the older profile and verify that `profiles.current()`, stale-job guards, and subsequent projections still use that selected version without any rewritten profile timestamp or contents.
