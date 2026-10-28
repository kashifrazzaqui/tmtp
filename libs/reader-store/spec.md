# Reader Store Library Spec

## Purpose and responsibility
Own reader-domain SQL migrations, repositories, projections, and transaction boundaries over the shared database. This includes `ingestion_cursors` and `ingestion_runs`; `job-queue` alone owns the `jobs` migration. It does not implement ranking, scheduling, or external calls.

## Public interface / API surface
```ts
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
  accessSessions: AccessSessionRepository;
  hnActions: HnActionRepository;
  hnAccountStates: HnAccountStateRepository;
  transaction<T>(work: () => T): T;
}

export interface StoryRepository {
  upsertBatch(stories: import("@tmtp/domain").Story[]): void;
  byId(id: number): import("@tmtp/domain").Story | undefined;
  needingScoring(profileId: string, limit: number): import("@tmtp/domain").Story[];
  forQueueProjection(afterStoryId: number | undefined, limit: number): import("@tmtp/domain").Story[];
}

export interface ArticleRepository {
  upsert(article: import("@tmtp/domain").Article): void;
  byStoryId(storyId: number): import("@tmtp/domain").Article | undefined;
  needingContent(limit: number): import("@tmtp/domain").Story[];
}

export interface ActivityQuery {
  storyId?: number;
  clientEventId?: string;
  afterId?: string;
  limit: number;
}

export interface ActivityRepository {
  appendIdempotent(events: import("@tmtp/domain").ActivityEvent[]): number;
  afterVersion(version: string, limit: number): import("@tmtp/domain").ActivityEvent[];
  latestVersion(): string;
  query(query: ActivityQuery): import("@tmtp/domain").ActivityEvent[];
}

export interface ReadingSessionRepository {
  openForStory(storyId: number): import("@tmtp/domain").ReadingSession | undefined;
  upsert(session: import("@tmtp/domain").ReadingSession): void;
  query(query: ActivityQuery): import("@tmtp/domain").ReadingSession[];
}

export interface PreferenceRepository {
  list(): import("@tmtp/domain").PreferenceRule[];
  replaceAll(rules: import("@tmtp/domain").PreferenceRule[]): string;
  currentVersion(): string;
}

export interface ProfileRepository {
  insert(profile: import("@tmtp/domain").InterestProfile): void;
  byId(id: string): import("@tmtp/domain").InterestProfile | undefined;
  current(): import("@tmtp/domain").InterestProfile | undefined;
  history(afterId: string | undefined, limit: number): import("@tmtp/domain").InterestProfile[];
}

export interface RecommendationRepository {
  insertImmutable(recommendations: import("@tmtp/domain").Recommendation[]): void;
  latestForStory(storyId: number): import("@tmtp/domain").Recommendation | undefined;
  historyForStory(storyId: number, afterId: string | undefined, limit: number): import("@tmtp/domain").Recommendation[];
  activeVersionCounts(): import("@tmtp/domain").RecommendationVersionCount[];
}

export interface QueueQuery {
  state?: import("@tmtp/domain").QueueState;
  evaluationState?: import("@tmtp/domain").EvaluationState;
  cursor?: string;
  limit: number;
}

export interface QueueRepository {
  insertPendingIfMissing(entries: import("@tmtp/domain").QueueEntry[]): number;
  upsertRankingPreservingState(entries: import("@tmtp/domain").QueueEntry[]): void;
  byStoryId(storyId: number): import("@tmtp/domain").QueueEntry | undefined;
  updateState(storyId: number, state: import("@tmtp/domain").QueueState): void;
  page(query: QueueQuery): import("@tmtp/domain").QueueEntry[];
  countsByEvaluationState(): Record<string, number>;
  forReprojection(afterStoryId: number | undefined, limit: number): import("@tmtp/domain").QueueEntry[];
}

export interface SyncRepository {
  cursor(name: string): string | undefined;
  setCursor(name: string, value: string, at: string): void;
  startRun(run: import("@tmtp/domain").IngestionRun): void;
  finishRun(run: import("@tmtp/domain").IngestionRun): void;
  recentRuns(limit: number): import("@tmtp/domain").IngestionRun[];
}

export interface LlmCallRepository {
  insert(call: import("@tmtp/domain").LlmCallRecord): void;
  byId(id: string): import("@tmtp/domain").LlmCallRecord | undefined;
  recent(limit: number): import("@tmtp/domain").LlmCallRecord[];
}

export interface AccessSessionRepository {
  insert(session: import("@tmtp/domain").AccessSessionRecord): void;
  find(sessionHash: string): import("@tmtp/domain").AccessSessionRecord | undefined;
  touch(sessionHash: string, at: string): void;
  revoke(sessionHash: string, at: string): void;
}

export interface HnActionRepository {
  createIntent(intent: import("@tmtp/domain").HnActionIntent): void;
  byIdempotencyKey(key: string): import("@tmtp/domain").HnActionIntent | undefined;
  updateOutcome(intent: import("@tmtp/domain").HnActionIntent): void;
  historyForStory(storyId: number, limit: number): import("@tmtp/domain").HnActionIntent[];
}

export interface HnAccountStateRepository {
  upsertObservations(states: import("@tmtp/domain").HnAccountState[]): void;
  current(username: string, kind?: string): import("@tmtp/domain").HnAccountState[];
}

export function createReaderStore(database: import("@tmtp/database").Database): ReaderStore;
export const readerStoreMigrations: import("@tmtp/database").Migration[];
```

`transaction` uses SQLite transactions and savepoints for nested calls. A transaction may include `job-queue` operations on the same database, which is required for atomic activity→profile-work and ingestion→article/recommendation handoff. No repository returns unvalidated persisted JSON.

## Internal subcomponents
- Story/article and ingestion repositories.
- Activity/session, preferences/profile, and immutable recommendation repositories.
- Queue projection and stable page queries.
- Sync, LLM-audit, access-session, and HN action/state repositories.

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
