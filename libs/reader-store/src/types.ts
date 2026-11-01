import type { Database } from "@tmtp/database";
import type {
  AccessSessionRecord,
  ActivityEvent,
  Article,
  DiagnosticError,
  EvaluationState,
  HnActionIntent,
  HnActionKind,
  HnAccountState,
  IngestionRun,
  InterestProfile,
  LlmCallRecord,
  PreferenceRule,
  QueueEntry,
  QueueState,
  ReadingSession,
  Recommendation,
  RecommendationVersionCount,
  StoredActivityEvent,
  Story,
  VisibilityState,
} from "@tmtp/domain";

export interface StoryScoringQuery { profileId: string; promptVersion: string; model: string; afterStoryId?: number; limit: number; }
export interface StoryRepository {
  upsertBatch(stories: Story[]): void;
  byId(id: number): Story | undefined;
  byStoryIds(storyIds: number[]): Story[];
  needingScoring(query: StoryScoringQuery): Story[];
  needingRefresh(olderThan: string, afterStoryId: number | undefined, limit: number): Story[];
  forQueueProjection(afterStoryId: number | undefined, limit: number): Story[];
}
export type ArticleUpsertResult = "applied" | "stale-source";
export interface ArticleContentQuery { extractorVersion: string; afterStoryId?: number; limit: number; }
export interface ArticleRepository {
  upsert(article: Article): ArticleUpsertResult;
  byStoryId(storyId: number): Article | undefined;
  byStoryIds(storyIds: number[]): Article[];
  needingContent(query: ArticleContentQuery): Story[];
}
export interface ActivityQuery { storyId?: number; clientEventId?: string; afterId?: string; limit: number; }
export interface ActivityRepository {
  appendIdempotent(events: ActivityEvent[]): number;
  afterVersion(version: string, limit: number): StoredActivityEvent[];
  latestWindow(limit: number): StoredActivityEvent[];
  latestVersion(): string;
  query(query: ActivityQuery): StoredActivityEvent[];
}
export interface ReadingSessionQuery { storyId?: number; clientEventId?: string; afterId?: string; limit: number; }
export interface ReadingSessionRepository {
  latestForStory(storyId: number): ReadingSession | undefined;
  upsert(session: ReadingSession): void;
  query(query: ReadingSessionQuery): ReadingSession[];
}
export interface PreferenceRepository { list(): PreferenceRule[]; replaceAll(rules: PreferenceRule[]): string; currentVersion(): string; }
export interface ProfileVersionKey { rulesVersion: string; activityVersion: string; policyVersion: string; builderVersion: string; }
export interface RecommendationVersionCursor { profileId: string; promptVersion: string; model: string; rankVersion: string; }
export interface ProfileRepository {
  insert(profile: InterestProfile): void;
  setCurrent(profileId: string, selectedAt: string): InterestProfile;
  byId(id: string): InterestProfile | undefined;
  byVersion(key: ProfileVersionKey): InterestProfile | undefined;
  current(): InterestProfile | undefined;
  history(afterId: string | undefined, limit: number): InterestProfile[];
}
export interface RecommendationRepository {
  insertImmutable(recommendations: Recommendation[]): void;
  byId(id: string): Recommendation | undefined;
  latestForStory(storyId: number): Recommendation | undefined;
  currentForStories(input: { profileId: string; promptVersion: string; model: string; storyIds: number[] }): Recommendation[];
  historyForStory(storyId: number, afterId: string | undefined, limit: number): Recommendation[];
  activeVersionCounts(after: RecommendationVersionCursor | undefined, limit: number): RecommendationVersionCount[];
}
export interface QueueCursorPosition { rankVersion: string; evaluationState: EvaluationState; rankPosition?: number; storyId: number; }
export interface QueuePageQuery {
  state?: QueueState;
  evaluationState?: EvaluationState;
  visibilityState?: VisibilityState;
  rankVersion: string;
  after?: QueueCursorPosition;
  limit: number;
}
export interface QueueProjectionState { profileId: string; rankVersion?: string; projectedAt: string; }
export interface QueueRepository {
  insertPendingIfMissing(entries: QueueEntry[]): number;
  upsertRankingPreservingState(entries: QueueEntry[]): void;
  byStoryId(storyId: number): QueueEntry | undefined;
  updateState(storyId: number, state: QueueState, at: string): QueueEntry;
  markEvaluation(input: { storyId: number; evaluationState: "pending" | "failed"; rankVersion: string; lastError?: string; at: string }): void;
  page(query: QueuePageQuery): QueueEntry[];
  countsByEvaluationState(input?: { visibilityState?: VisibilityState; rankVersion?: string }): Record<string, number>;
  forReprojection(afterStoryId: number | undefined, limit: number): QueueEntry[];
  projection(): QueueProjectionState | undefined;
  setProjection(state: QueueProjectionState): void;
}
export interface TimestampIdCursor { timestamp: string; id: string; }
export interface SyncRepository {
  cursor(name: string): string | undefined;
  setCursor(name: string, value: string, at: string): void;
  startRun(run: IngestionRun): void;
  finishRun(run: IngestionRun): void;
  latestRun(kind: string): IngestionRun | undefined;
  recentRuns(after: TimestampIdCursor | undefined, limit: number): IngestionRun[];
}
export interface LlmCallRepository { insert(call: LlmCallRecord): void; byId(id: string): LlmCallRecord | undefined; recent(after: TimestampIdCursor | undefined, limit: number): LlmCallRecord[]; }
export interface DiagnosticErrorRepository { recentErrors(after: TimestampIdCursor | undefined, limit: number): DiagnosticError[]; }
export interface AccessSessionRepository {
  insert(session: AccessSessionRecord): void;
  find(sessionHash: string): AccessSessionRecord | undefined;
  touch(sessionHash: string, at: string): void;
  revoke(sessionHash: string, at: string): void;
}
export interface HnActionQuery { status?: "pending" | "indeterminate"; storyId?: number; action?: HnActionKind; afterId?: string; limit: number; }
export interface HnActionRepository {
  createIntent(intent: HnActionIntent): void;
  byId(id: string): HnActionIntent | undefined;
  byIdempotencyKey(key: string): HnActionIntent | undefined;
  updateOutcome(intent: HnActionIntent): void;
  historyForStory(storyId: number, afterId: string | undefined, limit: number): HnActionIntent[];
  pendingOrIndeterminate(query: HnActionQuery): HnActionIntent[];
}
export interface HnAccountStateRepository {
  upsertObservations(states: HnAccountState[]): void;
  current(username: string, kind?: HnActionKind): HnAccountState[];
  byStoryIds(username: string, kind: HnActionKind, storyIds: number[]): HnAccountState[];
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
export type ReaderStoreFactory = (database: Database) => ReaderStore;
