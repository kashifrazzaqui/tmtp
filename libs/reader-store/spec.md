# Reader Store Library Spec

## Purpose and responsibility

Own reader-domain SQL migrations, repositories, projections, keyset queries, and transaction boundaries over the shared database. This includes every reader table and `ingestion_cursors`/`ingestion_runs`; `job-queue` alone owns the `jobs` migration and `database` owns the migration ledger. The store performs no ranking, scheduling, network access, or LLM calls.

## Public interface / API surface

### Store and errors

```ts
export type ReaderStoreErrorCode =
  | "not-found"
  | "conflict"
  | "immutable-conflict"
  | "unknown-version"
  | "invalid-query";

export class ReaderStoreError extends Error {
  readonly name: "ReaderStoreError";
  readonly code: ReaderStoreErrorCode;
  readonly cause?: unknown;
}

export interface ReaderStore {
  stories: StoryRepository;
  articles: ArticleRepository;
  activity: ActivityRepository;
  readingSessions: ReadingSessionRepository;
  preferences: PreferenceRepository;
  profiles: ProfileRepository;
  recommendations: RecommendationRepository;
  queue: QueueRepository;
  sync: SyncRepository;
  llmCalls: LlmCallRepository;
  diagnostics: DiagnosticErrorRepository;
  accessSessions: AccessSessionRepository;
  hnActions: HnActionRepository;
  hnAccountStates: HnAccountStateRepository;
  transaction<T>(work: () => T): T;
}

export function createReaderStore(database: import("@tmtp/database").Database): ReaderStore;
export const readerStoreMigrations: import("@tmtp/database").Migration[];
```

`transaction` is synchronous and supports nested savepoints through `database`. It may include `job-queue` operations on the same connection, which is required for atomic activity→profile-work and ingestion→article/recommendation handoffs. A Promise return is invalid. All multi-row writes in one documented application boundary execute in one such transaction.

### Stories and articles

```ts
export interface StoryScoringQuery {
  profileId: string;
  promptVersion: string;
  model: string;
  afterStoryId?: number;
  limit: number;
}

export interface StoryRepository {
  upsertBatch(stories: import("@tmtp/domain").Story[]): void;
  byId(id: number): import("@tmtp/domain").Story | undefined;
  byStoryIds(storyIds: number[]): import("@tmtp/domain").Story[];
  needingScoring(query: StoryScoringQuery): import("@tmtp/domain").Story[];
  needingRefresh(olderThan: string, afterStoryId: number | undefined, limit: number): import("@tmtp/domain").Story[];
  forQueueProjection(afterStoryId: number | undefined, limit: number): import("@tmtp/domain").Story[];
}

export interface ArticleRepository {
  upsert(article: import("@tmtp/domain").Article): ArticleUpsertResult;
  byStoryId(storyId: number): import("@tmtp/domain").Article | undefined;
  byStoryIds(storyIds: number[]): import("@tmtp/domain").Article[];
  needingContent(query: ArticleContentQuery): import("@tmtp/domain").Story[];
}

export type ArticleUpsertResult = "applied" | "stale-source";

export interface ArticleContentQuery {
  extractorVersion: string;
  afterStoryId?: number;
  limit: number;
}
```

`stories.byStoryIds` resolves only supplied unique positive IDs and returns story-ID ascending records; an empty input returns no rows without SQL. It is the bounded batch-read seam for queue presentation. Consumers that need page order map returned records by ID rather than issuing one query per entry.

Story upsert preserves `firstSeenAt`, reading state, queued time, visibility, and immutable history. When `Story.contentVersion` changes, the same transaction moves any existing scored/failed queue row to `pending`, clears recommendation/rank score/rank position/error, retains its prior rank version until complete reprojection, and advances queue update time without moving it backward. Article upsert requires both a non-empty `sourceContentVersion` and `contentVersion === domain.articleContentVersion(article)`. In the same transaction it reads the current story: a missing story is `not-found`; a source-version mismatch returns `stale-source` without changing the article or queue; otherwise it writes and returns `applied`. A changed derived article version performs the same atomic stale-evaluation invalidation. Thus an older read cannot overwrite a newer story attempt, and `needingScoring` sees every stale row as pending/failed and returns those with no immutable recommendation for the exact `(profile,storyContent,currentArticleContent,prompt,model)` key, comparing the stored article version or logical `none` in SQL. `needingContent` includes URL and self-text stories whose article is absent/pending, whose `article.sourceContentVersion` differs from `story.contentVersion`, or whose ready/failed article's attempted `extractorVersion` differs from the query's current reader-pipeline version. Every terminal article carries that attempted composite version; a current-pipeline terminal failure is not selected again merely because it failed, while a later source/pipeline change makes it eligible again. The extractor version is a non-empty string and results are story-ID keyset ordered.

### Activity and sessions

```ts
export interface ActivityQuery {
  storyId?: number;
  clientEventId?: string;
  afterId?: string;
  limit: number;
}

export interface ActivityRepository {
  appendIdempotent(events: import("@tmtp/domain").ActivityEvent[]): number;
  afterVersion(version: string, limit: number): import("@tmtp/domain").StoredActivityEvent[];
  latestWindow(limit: number): import("@tmtp/domain").StoredActivityEvent[];
  latestVersion(): string;
  query(query: ActivityQuery): import("@tmtp/domain").StoredActivityEvent[];
}

export interface ReadingSessionRepository {
  latestForStory(storyId: number): import("@tmtp/domain").ReadingSession | undefined;
  upsert(session: import("@tmtp/domain").ReadingSession): void;
  query(query: ReadingSessionQuery): import("@tmtp/domain").ReadingSession[];
}

export interface ReadingSessionQuery {
  storyId?: number;
  clientEventId?: string; // exact lastClientEventId match
  afterId?: string;
  limit: number;
}
```

Activity append ordering is a store-assigned positive safe-integer `sequence`, independent of receipt timestamps and random event IDs. `appendIdempotent` assigns increasing sequences to newly inserted rows and returns only the newly inserted count; exact replay inserts no event and therefore does not advance the logical head. Sequence gaps are valid. `latestVersion()` returns the canonical decimal maximum sequence or `"0"` for an empty log, so every novel append advances the profile/dedupe version even when receipt time goes backward or an ID sorts earlier. `afterVersion` accepts `"0"` or a canonical positive decimal sequence no greater than the current head and returns a bounded page with greater sequence; malformed, leading-zero, unsafe, or unknown future versions throw `unknown-version`. `latestWindow(limit)` returns the newest `limit` events in ascending sequence, or the whole log when shorter; zero returns an empty suffix without changing the independent `latestVersion()` result. This gives interest building a bounded contiguous suffix in append order without scanning the full history. `ActivityQuery` returns ascending sequence pages with optional exact story/client-ID filters; its `afterId` resolves an event ID to its stored sequence, and an unknown ID or one outside the effective story/client-ID filters is `invalid-query`. Reusing a `clientEventId` with byte-equivalent domain content is an idempotent no-op; sequence is excluded from logical replay comparison, and different content throws `conflict`.

`latestForStory` returns the latest active **or terminal** session by `(updatedAt,id)`, which is required for activity replay ordering and orphan-closer high-watermarks. `ReadingSessionRepository.query` returns bounded ascending `(updatedAt,id)` pages with optional exact story/`lastClientEventId` filters. Its `afterId` resolves a session ID to that tuple and resumes strictly after it; an unknown ID or one outside the effective story/`lastClientEventId` filters is `invalid-query`. Event and session IDs/cursors are never interchangeable. Session upsert validates `lastClientEventId` idempotency and never reduces dwell/scroll accumulated by an already-applied event. Events, session projection, and profile-work enqueue are committed by the calling composition in one transaction.

### Preferences and profiles

```ts
export interface PreferenceRepository {
  list(): import("@tmtp/domain").PreferenceRule[];
  replaceAll(rules: import("@tmtp/domain").PreferenceRule[]): string;
  currentVersion(): string;
}

export interface ProfileVersionKey {
  rulesVersion: string;
  activityVersion: string;
  policyVersion: string;
  builderVersion: string;
}

export interface RecommendationVersionCursor {
  profileId: string;
  promptVersion: string;
  model: string;
  rankVersion: string;
}

export interface ProfileRepository {
  insert(profile: import("@tmtp/domain").InterestProfile): void;
  setCurrent(profileId: string, selectedAt: string): import("@tmtp/domain").InterestProfile;
  byId(id: string): import("@tmtp/domain").InterestProfile | undefined;
  byVersion(key: ProfileVersionKey): import("@tmtp/domain").InterestProfile | undefined;
  current(): import("@tmtp/domain").InterestProfile | undefined;
  history(afterId: string | undefined, limit: number): import("@tmtp/domain").InterestProfile[];
}
```

Rules are returned in canonical `(kind,effect,normalizedValue)` order. `replaceAll` replaces the complete rule set in the caller's transaction and returns its canonical rules version; it does not create a profile or queue jobs itself. Profiles are immutable. Inserting an identical existing ID/version is a no-op; conflicting immutable content throws `immutable-conflict`. `setCurrent` moves the singleton current-profile pointer to any existing historical profile and records `selectedAt`; a missing ID is `not-found`. It returns the selected record and can therefore make a reused older version current again. `current` reads only that pointer, never latest creation order. The profile-building transaction must insert/reuse and then set the pointer before projection or job enqueue.

### Recommendations

`historyForStory` returns bounded ascending `(createdAt,id)` pages for one story. Its optional `afterId` resolves the immutable recommendation's tuple and resumes strictly after it; an unknown ID or one belonging to another story is `invalid-query`. `latestForStory` uses the same ordering solely for history/debug reads; current queue explanations always follow `queue_entries.recommendation_id` instead.

```ts
export interface RecommendationRepository {
  insertImmutable(recommendations: import("@tmtp/domain").Recommendation[]): void;
  byId(id: string): import("@tmtp/domain").Recommendation | undefined;
  latestForStory(storyId: number): import("@tmtp/domain").Recommendation | undefined;
  currentForStories(input: {
    profileId: string;
    promptVersion: string;
    model: string;
    storyIds: number[];
  }): import("@tmtp/domain").Recommendation[];
  historyForStory(storyId: number, afterId: string | undefined, limit: number): import("@tmtp/domain").Recommendation[];
  activeVersionCounts(after: RecommendationVersionCursor | undefined, limit: number): import("@tmtp/domain").RecommendationVersionCount[];
}
```

Insertion is idempotent only for byte-equivalent existing records with the same ID and uniqueness key. A different record for an existing ID or `(story,profile,storyContent,articleContent,prompt,model)` key throws `immutable-conflict`. Producers use deterministic recommendation IDs for retry safety. History is ordered `(createdAt,id)` and keyset-paged; earlier explanations are never updated. `latestForStory` is a history query, not a substitute for reading the queue's exact `recommendationId`. `activeVersionCounts` is bounded and ascending by `(profileId,promptVersion,model,rankVersion)`, resuming strictly after the supplied complete tuple.

### Queue projection and keyset pages

```ts
export interface QueueCursorPosition {
  rankVersion: string;
  evaluationState: import("@tmtp/domain").EvaluationState;
  rankPosition?: number;
  storyId: number;
}

export interface QueuePageQuery {
  state?: import("@tmtp/domain").QueueState;
  evaluationState?: import("@tmtp/domain").EvaluationState;
  visibilityState?: import("@tmtp/domain").VisibilityState; // default visible
  rankVersion: string;
  after?: QueueCursorPosition;
  limit: number;
}

export interface QueueProjectionState {
  profileId: string;
  rankVersion?: string; // absent only for a complete empty projection
  projectedAt: string;
}

export interface QueueRepository {
  insertPendingIfMissing(entries: import("@tmtp/domain").QueueEntry[]): number;
  upsertRankingPreservingState(entries: import("@tmtp/domain").QueueEntry[]): void;
  byStoryId(storyId: number): import("@tmtp/domain").QueueEntry | undefined;
  updateState(storyId: number, state: import("@tmtp/domain").QueueState, at: string): import("@tmtp/domain").QueueEntry;
  markEvaluation(input: {
    storyId: number;
    evaluationState: "pending" | "failed";
    rankVersion: string;
    lastError?: string;
    at: string;
  }): void;
  page(query: QueuePageQuery): import("@tmtp/domain").QueueEntry[];
  countsByEvaluationState(input?: { visibilityState?: import("@tmtp/domain").VisibilityState; rankVersion?: string }): Record<string, number>;
  forReprojection(afterStoryId: number | undefined, limit: number): import("@tmtp/domain").QueueEntry[];
  projection(): QueueProjectionState | undefined;
  setProjection(state: QueueProjectionState): void;
}
```

Default pages include visible entries only; history queries may explicitly include blacklisted entries. Ordering is `scored` by `(rankPosition,storyId)`, then `pending` by `storyId`, then `failed` by `storyId`, within one `rankVersion` and the requested filters. `after` must match the query's rank version and evaluation filter. This total order covers unranked initial entries and has no silent cap.

Ranking writes preserve `state` and `queuedAt`, while persisting the visibility and ranking fields computed for the new profile. Thus a preference/blacklist change can hide or reveal a row without rewriting its reading history. `updateState` throws `not-found` and otherwise returns the updated row. `markEvaluation` accepts only pending/failed, clears recommendation/rank score/rank position, sets the supplied rank version/error, and never changes reading state; scored rows are written only as complete `upsertRankingPreservingState` projections. Queue state transitions themselves are validated by `queue` before persistence.

`projection` is the singleton active-rank pointer for application pagination and ingestion. `setProjection` updates it in the same transaction as the complete ranked rows, recording the selected profile and not-before projection time; a valid empty projection stores an absent `rankVersion`. Before any projection exists, application/ingestion use `QUEUE_BOOTSTRAP_RANK_VERSION`. Once a nonempty pointer exists, newly inserted pending rows join that rank version rather than creating a second bootstrap namespace. The pointer is projection metadata, not a second ranking algorithm or queue history.

### Sync, LLM audits, access, and HN records

```ts
export interface TimestampIdCursor {
  timestamp: string;
  id: string;
}

export interface SyncRepository {
  cursor(name: string): string | undefined;
  setCursor(name: string, value: string, at: string): void;
  startRun(run: import("@tmtp/domain").IngestionRun): void;
  finishRun(run: import("@tmtp/domain").IngestionRun): void;
  latestRun(kind: string): import("@tmtp/domain").IngestionRun | undefined;
  recentRuns(after: TimestampIdCursor | undefined, limit: number): import("@tmtp/domain").IngestionRun[];
}

export interface LlmCallRepository {
  insert(call: import("@tmtp/domain").LlmCallRecord): void;
  byId(id: string): import("@tmtp/domain").LlmCallRecord | undefined;
  recent(after: TimestampIdCursor | undefined, limit: number): import("@tmtp/domain").LlmCallRecord[];
}

export interface DiagnosticErrorRepository {
  recentErrors(after: TimestampIdCursor | undefined, limit: number): import("@tmtp/domain").DiagnosticError[];
}

export interface AccessSessionRepository {
  insert(session: import("@tmtp/domain").AccessSessionRecord): void;
  find(sessionHash: string): import("@tmtp/domain").AccessSessionRecord | undefined;
  touch(sessionHash: string, at: string): void;
  revoke(sessionHash: string, at: string): void;
}

export interface HnActionRepository {
  createIntent(intent: import("@tmtp/domain").HnActionIntent): void;
  byId(id: string): import("@tmtp/domain").HnActionIntent | undefined;
  byIdempotencyKey(key: string): import("@tmtp/domain").HnActionIntent | undefined;
  updateOutcome(intent: import("@tmtp/domain").HnActionIntent): void;
  historyForStory(storyId: number, afterId: string | undefined, limit: number): import("@tmtp/domain").HnActionIntent[];
  pendingOrIndeterminate(query: HnActionQuery): import("@tmtp/domain").HnActionIntent[];
}

export interface HnActionQuery {
  status?: "pending" | "indeterminate";
  storyId?: number;
  action?: import("@tmtp/domain").HnActionKind;
  afterId?: string;
  limit: number;
}

export interface HnAccountStateRepository {
  upsertObservations(states: import("@tmtp/domain").HnAccountState[]): void;
  current(username: string, kind?: import("@tmtp/domain").HnActionKind): import("@tmtp/domain").HnAccountState[];
  byStoryIds(username: string, kind: import("@tmtp/domain").HnActionKind, storyIds: number[]): import("@tmtp/domain").HnAccountState[];
}
```

`finishRun` updates only the named run and requires a terminal status/completion time. `recentRuns` and `llmCalls.recent` are descending `(startedAt,id)` and `(createdAt,id)` keyset pages respectively; cursor `timestamp` names the corresponding record field and results resume strictly before it. LLM calls are immutable audits; every retry attempt is inserted separately. Access sessions store hashes only and satisfy access-control's structural session-store port. HN idempotency keys are unique. Outcome updates may move `pending` to any terminal attempt state and may enrich an `indeterminate` record through reconciliation; they never turn failure into success without new result evidence.

`hnActions.pendingOrIndeterminate` is ascending `(createdAt,id)` with optional exact status/story/action filters and an `afterId` keyset position. Account reconciliation uses exact story/action plus `status="indeterminate"`, so unrelated pending history cannot hide a matching candidate. `hnAccountStates.byStoryIds` resolves only the supplied unique positive IDs for one username/kind and returns story-ID order; an empty list returns no rows. Reconciliation uses this observation-bounded read instead of scanning all current account history.

`hnActions.historyForStory` is also ascending `(createdAt,id)`, restricted to one story and bounded by limit. Its optional `afterId` resolves the durable intent's tuple and resumes strictly after it; an unknown ID or one belonging to another story is `invalid-query`, never a cross-story continuation.

`diagnostics.recentErrors` is a bounded descending `(occurredAt,id)` union projection over store-owned ingestion runs, LLM audits, and HN action intents with stable error codes. It does not read the job table or require a new diagnostic table. IDs are source-prefixed (`ingestion:<runId>`, `llm:<callId>`, `hn-action:<intentId>`); components are fixed; occurrence is run completion/start, call creation, or intent update. Correlation IDs are copied where owned and arbitrary messages are omitted. Diagnostics merges this page with failed-job projections from `job-queue` before applying the same ordering key.

## Persistence and validation contract

- `readerStoreMigrations` creates the 16 reader/access/ingestion tables documented in `docs/architecture.md`, including the singleton current-profile and queue-projection pointers; the jobs table and migration ledger are owned elsewhere.
- Repository rows are mapped explicitly between SQLite booleans/nulls and domain booleans/optionals.
- Every persisted JSON value is decoded and validated by the corresponding domain schema before return. Kind-specific payload/policy validation remains with its owning library.
- List/history limits are positive and bounded by the caller's component policy, except `latestWindow(0)`, which is the explicit empty-suffix case for a zero activity budget. Story/article/activity/profile/recommendation/sync/LLM lists are deterministic and keyset- or indexed-ordered.
- Repository constraint failures are mapped to safe store errors where a domain contract exists; other `DatabaseError` values propagate unchanged.

## Internal subcomponents

- Story/article and ingestion repositories.
- Activity/session, preferences/profile, and immutable recommendation repositories.
- Queue projection and stable keyset-page queries.
- Sync, LLM-audit, derived diagnostic-error, access-session, and HN action/state repositories.
- Explicit row/JSON mapping and shared transaction composition.

## Dependencies on other libs

- `database`
- `domain`

`AccessSessionRepository` is structurally compatible with `access-control`'s session-store port without importing it.

## New build or OSS wrapper

New handwritten SQL repositories over `database`; no ORM.

## Hosted by

All compositions in `services/personal-reader`; one shared instance.

## Configuration

None. Retention is indefinite by default; any future retention policy requires new explicit configuration rather than inline deletion.

## Acceptance-focused test expectations

- Round-trip every table and versioned JSON record through real SQLite.
- Verify duplicate activity, story upsert, profile/recommendation retry, HN intent, and active dedupe behavior.
- Prove activity/session/job and ingestion/queue/job handoffs roll back together when any write fails.
- Verify queue pages include pending/failed/blacklisted-by-request entries with stable keyset order and no duplicates or omissions, and story batch reads resolve only requested IDs in deterministic order without per-entry queries.
- Verify new pending rows and application reads share the active projection pointer after ingestion, while bootstrap is used only before the first complete projection.
- Verify ranking never resets reading state, preference-driven visibility changes persist, and immutable history cannot be overwritten.
- Verify story/article version changes atomically invalidate stale scored/failed rows into reachable pending rows, extraction queries compare the stored source story version, and pending/failed-only evaluation writes clear all scored fields.
- Verify conditional article upserts reject stale sources without writes, historical profiles can become current again after restart, and account reconciliation reads only keyed states/intents with stable pagination.
- Verify latest-session lookup includes terminal sessions, newest-activity windows remain contiguous at zero/exact/over-limit sizes, and content queries detect stale extractor versions as well as changed source content.
- Verify append sequence heads advance for same-millisecond smaller-ID and backward-clock inserts, remain unchanged on exact replay, and drive ordered suffix/keyset reads across valid sequence gaps.
- Verify event sequence, session `(updatedAt,id)`, and recommendation/HN-intent `(createdAt,id)` pages resume independently with exact client/story filters and reject unknown or cross-story continuation IDs.
- Verify expired/revoked access sessions and indeterminate HN outcomes remain inspectable without exposing raw secrets.
- Verify every debug read is bounded and keyset ordered, derived error IDs remain stable across retries, and no diagnostic union reads the job table or creates another persisted history.
