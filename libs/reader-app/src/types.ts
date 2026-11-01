import type { RawActivity } from "@tmtp/activity";
import type { ArticleReader } from "@tmtp/article-reader";
import type {
  Article,
  EvaluationState,
  HnActionIntent,
  HnActionKind,
  InterestProfile,
  Job,
  PreferenceRule,
  QueueEntry,
  QueueState,
  ReadingSession,
  Recommendation,
  StoredActivityEvent,
  Story,
  StoryId,
  VisibilityState,
} from "@tmtp/domain";
import type { AccountCapability, HnAccount, HnActionResult } from "@tmtp/hn-account";
import type {
  AccountReconciliationSummary,
  HnIngestion,
  HnIngestionJobKind,
  IngestionSummary,
} from "@tmtp/hn-ingestion";
import type { JobQueue } from "@tmtp/job-queue";
import type { Personalization, PersonalizationJobKind, RecoverySummary, RecordActivityResult } from "@tmtp/personalization";
import type { ReaderStore } from "@tmtp/reader-store";

export type ReaderAppJobKind =
  | "article.fetch-extract"
  | "personalization.record-activity"
  | HnIngestionJobKind
  | PersonalizationJobKind;

export interface ArticleFetchExtractJobPayload {
  storyId: StoryId;
  storyContentVersion: string;
}

export interface RecordActivityJobPayload {
  batch: readonly RawActivity[];
}

export interface ReaderQueueQuery {
  state?: QueueState;
  evaluationState?: EvaluationState;
  visibilityState?: VisibilityState;
  cursor?: string;
  limit?: number;
}

export interface StoryFallback {
  kind: "original-page" | "hn-discussion";
  observationQuality: "partial";
}

export interface ReaderQueueStory {
  story: Story;
  originalUrl: string;
  fallback: StoryFallback;
}

export interface ReaderQueueResult {
  entries: QueueEntry[];
  storyDetails: ReaderQueueStory[];
  nextCursor?: string;
  evaluationCounts: Record<EvaluationState, number>;
  rankVersions: string[];
}

export interface StoryDetail {
  story: Story;
  article?: Article;
  recommendation?: Recommendation;
  queueEntry: QueueEntry;
  originalUrl: string;
  fallback: StoryFallback;
}

export interface RecommendationHistoryQuery {
  storyId: StoryId;
  afterId?: string;
  limit?: number;
}

export interface HnActionHistoryQuery {
  storyId: StoryId;
  afterId?: string;
  limit?: number;
}

export interface ActivityHistoryQuery {
  storyId?: StoryId;
  clientEventId?: string;
  afterEventId?: string;
  afterSessionId?: string;
  limit?: number;
}

export interface ActivityHistory {
  events: StoredActivityEvent[];
  sessions: ReadingSession[];
}

export interface HnActionCommand {
  storyId: StoryId;
  action: HnActionKind;
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

export interface ReaderApp {
  getQueue(query?: ReaderQueueQuery, signal?: AbortSignal): Promise<ReaderQueueResult>;
  getStory(storyId: StoryId, signal?: AbortSignal): Promise<StoryDetail>;
  getRecommendationHistory(query: RecommendationHistoryQuery, signal?: AbortSignal): Promise<Recommendation[]>;
  getHnActionHistory(query: HnActionHistoryQuery, signal?: AbortSignal): Promise<HnActionIntent[]>;
  getActivity(query?: ActivityHistoryQuery, signal?: AbortSignal): Promise<ActivityHistory>;
  setQueueState(storyId: StoryId, state: QueueState, signal?: AbortSignal): Promise<QueueEntry>;
  refreshArticle(storyId: StoryId, signal?: AbortSignal): Promise<Job>;
  recordActivity(batch: readonly RawActivity[], signal?: AbortSignal): Promise<RecordActivityResult>;
  getPreferences(signal?: AbortSignal): Promise<PreferenceRule[]>;
  replacePreferences(rules: readonly PreferenceRule[], signal?: AbortSignal): Promise<InterestProfile>;
  rebuildPersonalization(reason: string, signal?: AbortSignal): Promise<InterestProfile>;
  runPersonalization(signal?: AbortSignal): Promise<RecoverySummary>;
  getHnCapabilities(signal?: AbortSignal): Promise<AccountCapability[]>;
  performHnAction(command: HnActionCommand, signal?: AbortSignal): Promise<HnActionResult>;
  runIngestion(signal?: AbortSignal): Promise<IngestionSummary>;
  scheduleIngestion(signal?: AbortSignal): Promise<Job>;
  reconcileHnAccount(signal?: AbortSignal): Promise<AccountReconciliationSummary>;
  scheduleHnReconciliation(signal?: AbortSignal): Promise<Job>;
  runJob(job: Job, signal?: AbortSignal): Promise<void>;
}

export interface ReaderAppOptions {
  store: ReaderStore;
  jobs: JobQueue;
  articles: ArticleReader;
  ingestion: HnIngestion;
  personalization: Personalization;
  account?: HnAccount;
  queuePageSize: number;
  queueMaxPageSize: number;
  now: () => Date;
  createId: () => string;
}

export interface NormalizedReaderAppOptions extends ReaderAppOptions {
  readonly account?: HnAccount;
}

export interface ReaderAppErrorOptions {
  operation: ReaderAppOperation;
  retryable: boolean;
  field?: string;
  storyId?: StoryId;
  jobId?: string;
  dependency?: ReaderAppDependency;
  dependencyCode?: string;
}
