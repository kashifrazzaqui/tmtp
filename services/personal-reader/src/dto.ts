import { IsoDateTimeSchema } from "@tmtp/domain";
import type {
  ActivityKind,
  ActivitySource,
  Article,
  ArticleStatus,
  HnActionIntent,
  HnActionKind,
  HnActionStatus,
  InterestProfile,
  IsoDateTime,
  Job,
  JobStatus,
  ObservationQuality,
  PreferenceEffect,
  PreferenceKind,
  PreferenceRule,
  QueueEntry,
  QueueState,
  ReadingSession,
  ReadingSessionState,
  Recommendation,
  RecommendationKind,
  StoredActivityEvent,
  Story,
  StoryId,
  VisibilityState,
  EvaluationState,
} from "@tmtp/domain";
import type { AccountCapability, HnActionResult } from "@tmtp/hn-account";
import type { AccountReconciliationSummary, IngestionSummary } from "@tmtp/hn-ingestion";
import type { RecordActivityResult, RecoverySummary, ScorePendingSummary } from "@tmtp/personalization";
import type {
  ActivityHistory,
  ReaderQueueResult,
  ReaderQueueStory,
  StoryDetail,
  StoryFallback,
} from "@tmtp/reader-app";

export type SafeCode = string;

export interface QueueEntryDto {
  storyId: StoryId;
  state: QueueState;
  evaluationState: EvaluationState;
  visibilityState: VisibilityState;
  kind: RecommendationKind;
  recommendationId?: string;
  rankScore?: number;
  rankPosition?: number;
  rankVersion: string;
  queuedAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface StoryDto {
  id: StoryId;
  itemType: "story";
  title: string;
  author?: string;
  score?: number;
  descendants?: number;
  publishedAt: IsoDateTime;
  firstSeenAt: IsoDateTime;
  lastSeenAt: IsoDateTime;
  contentVersion: string;
  deleted: boolean;
  dead: boolean;
}

export interface StoryFallbackDto {
  kind: "original-page" | "hn-discussion";
  observationQuality: "partial";
}

export interface QueueItemDto {
  entry: QueueEntryDto;
  story: StoryDto;
  originalUrl: string;
  fallback: StoryFallbackDto;
}

export interface QueueEvaluationCountsDto {
  pending: number;
  scored: number;
  failed: number;
}

export interface QueuePageDto {
  items: QueueItemDto[];
  nextCursor?: string;
  evaluationCounts: QueueEvaluationCountsDto;
  rankVersions: string[];
}

export interface ArticleDto {
  storyId: StoryId;
  status: ArticleStatus;
  sourceContentVersion: string;
  contentVersion: string;
  title?: string;
  byline?: string;
  excerpt?: string;
  sanitizedHtml?: string;
  extractorVersion?: string;
  fetchedAt?: IsoDateTime;
  updatedAt: IsoDateTime;
  errorCode?: SafeCode;
}

export interface RecommendationEvidenceDto {
  kind: "explicit-rule" | "activity" | "story" | "exploration";
  label: string;
  value?: string | number;
  sourceId?: string;
}

export interface RecommendationDto {
  id: string;
  storyId: StoryId;
  profileId: string;
  storyContentVersion: string;
  articleContentVersion: string;
  promptVersion: string;
  model: string;
  score: number;
  rationale: string;
  evidence: RecommendationEvidenceDto[];
  evidenceSchemaVersion: 1;
  llmCallId?: string;
  createdAt: IsoDateTime;
}

export interface StoryDetailDto {
  story: StoryDto;
  article?: ArticleDto;
  recommendation?: RecommendationDto;
  queueEntry: QueueEntryDto;
  originalUrl: string;
  fallback: StoryFallbackDto;
}

export interface ActivityEventDto {
  id: string;
  clientEventId: string;
  storyId: StoryId;
  kind: ActivityKind;
  value?: Record<string, unknown>;
  valueSchemaVersion: 1;
  source: ActivitySource;
  observationQuality: ObservationQuality;
  occurredAt: IsoDateTime;
  receivedAt: IsoDateTime;
  sequence: number;
}

export interface ReadingSessionDto {
  id: string;
  storyId: StoryId;
  startedAt: IsoDateTime;
  endedAt?: IsoDateTime;
  updatedAt: IsoDateTime;
  activeDwellMs: number;
  maxScrollRatio: number;
  state: ReadingSessionState;
  observationQuality: ObservationQuality;
  lastClientEventId: string;
}

export interface ActivityHistoryDto {
  events: ActivityEventDto[];
  sessions: ReadingSessionDto[];
}

export interface PreferenceRuleDto {
  id: string;
  kind: PreferenceKind;
  effect: PreferenceEffect;
  value: string;
  normalizedValue: string;
  enabled: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface InterestEvidenceDto {
  kind: ActivityKind | "explicit-rule";
  count: number;
  weight: number;
}

export interface WeightedInterestDto {
  topic: string;
  weight: number;
  evidence: InterestEvidenceDto[];
}

export interface InterestProfileDto {
  id: string;
  rulesVersion: string;
  activityVersion: string;
  sourceRules: PreferenceRuleDto[];
  sourceRulesSchemaVersion: 1;
  policy: Record<string, unknown>;
  policySchemaVersion: 1;
  policyVersion: string;
  builderVersion: string;
  interests: WeightedInterestDto[];
  reason: string;
  createdAt: IsoDateTime;
}

export interface JobDto {
  id: string;
  kind: string;
  status: JobStatus;
  runAfter: IsoDateTime;
  leaseExpiresAt?: IsoDateTime;
  attempts: number;
  maxAttempts: number;
  lastErrorCode?: SafeCode;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  completedAt?: IsoDateTime;
}

export interface AccountCapabilityDto {
  name: "upvoted" | "favorites" | "flagged" | "mutations";
  state: "available" | "unavailable" | "unverified";
  reason?: SafeCode;
}

export interface HnActionOutcomeDto {
  status: "verified" | "indeterminate" | "failed";
  observedAt: IsoDateTime;
  errorCode?: SafeCode;
}

export interface HnActionResultDto extends HnActionOutcomeDto {
  intentId: string;
}

export interface HnActionHistoryDto {
  id: string;
  storyId: StoryId;
  action: HnActionKind;
  status: HnActionStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  errorCode?: SafeCode;
  outcome?: HnActionOutcomeDto;
}

export interface RecordActivityResultDto {
  accepted: number;
  profileWorkEnqueued: boolean;
}

export interface IngestionSummaryDto {
  runId: string;
  highestSeenItemId: number;
  storiesUpserted: number;
  nonStoriesSkipped: number;
  jobsEnqueued: number;
}

export interface AccountReconciliationSummaryDto {
  runId: string;
  observations: number;
  skippedUnknownStories: number;
  activityJobsEnqueued: number;
  capabilities: AccountCapabilityDto[];
}

export interface ScorePendingSummaryDto {
  completion: "complete" | "cancelled";
  scored: number;
  failed: number;
  retryableFailed: number;
  queued: number;
  audits: number;
}

export interface RecoverySummaryDto {
  completion: "complete" | "cancelled";
  scored: number;
  failed: number;
  retryableFailed: number;
  queued: number;
  audits: number;
  rebuilt: boolean;
}

export type RunOnceHandlerOutcome = "completed" | "failed";

export type RunOnceResult =
  | { outcome: "idle" }
  | { outcome: "rejected"; job: Job }
  | { outcome: RunOnceHandlerOutcome; job: Job }
  | { outcome: "lease-lost"; jobId: string; kind: string; handlerOutcome: RunOnceHandlerOutcome };

export type RunOnceResultDto =
  | { outcome: "idle" }
  | { outcome: "rejected"; job: JobDto }
  | { outcome: RunOnceHandlerOutcome; job: JobDto }
  | { outcome: "lease-lost"; jobId: string; kind: string; handlerOutcome: RunOnceHandlerOutcome };

export class QueueContractError extends Error {
  override readonly name = "QueueContractError" as const;
  readonly code = "queue-contract-mismatch" as const;

  constructor() {
    super("Queue entries and story details are not aligned.");
  }
}

const TRANSPORT_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function safeTransportCode(value: unknown): SafeCode {
  return typeof value === "string" && value.length <= 64 && TRANSPORT_CODE.test(value)
    ? value
    : "unknown-error";
}

function present<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

function isIsoDateTime(value: unknown): value is IsoDateTime {
  try {
    return IsoDateTimeSchema.safeParse(value).success;
  } catch {
    return false;
  }
}

function isHnOutcomeStatus(value: unknown): value is HnActionOutcomeDto["status"] {
  return value === "verified" || value === "indeterminate" || value === "failed";
}

export function mapQueueEntry(entry: QueueEntry): QueueEntryDto {
  return {
    storyId: entry.storyId,
    state: entry.state,
    evaluationState: entry.evaluationState,
    visibilityState: entry.visibilityState,
    kind: entry.kind,
    ...(present(entry.recommendationId) ? { recommendationId: entry.recommendationId } : {}),
    ...(present(entry.rankScore) ? { rankScore: entry.rankScore } : {}),
    ...(present(entry.rankPosition) ? { rankPosition: entry.rankPosition } : {}),
    rankVersion: entry.rankVersion,
    queuedAt: entry.queuedAt,
    updatedAt: entry.updatedAt,
  };
}

export function mapStory(story: Story): StoryDto {
  return {
    id: story.id,
    itemType: story.itemType,
    title: story.title,
    ...(present(story.author) ? { author: story.author } : {}),
    ...(present(story.score) ? { score: story.score } : {}),
    ...(present(story.descendants) ? { descendants: story.descendants } : {}),
    publishedAt: story.publishedAt,
    firstSeenAt: story.firstSeenAt,
    lastSeenAt: story.lastSeenAt,
    contentVersion: story.contentVersion,
    deleted: story.deleted,
    dead: story.dead,
  };
}

export function mapStoryFallback(fallback: StoryFallback): StoryFallbackDto {
  return { kind: fallback.kind, observationQuality: fallback.observationQuality };
}

export function mapQueueItem(entry: QueueEntry, detail: ReaderQueueStory): QueueItemDto {
  if (entry.storyId !== detail.story.id) throw new QueueContractError();
  return {
    entry: mapQueueEntry(entry),
    story: mapStory(detail.story),
    originalUrl: detail.originalUrl,
    fallback: mapStoryFallback(detail.fallback),
  };
}

export function mapQueuePage(page: ReaderQueueResult): QueuePageDto {
  if (page.entries.length !== page.storyDetails.length) throw new QueueContractError();
  return {
    items: page.entries.map((entry, index) => {
      const detail = page.storyDetails[index];
      if (detail === undefined) throw new QueueContractError();
      return mapQueueItem(entry, detail);
    }),
    ...(present(page.nextCursor) ? { nextCursor: page.nextCursor } : {}),
    evaluationCounts: {
      pending: page.evaluationCounts.pending,
      scored: page.evaluationCounts.scored,
      failed: page.evaluationCounts.failed,
    },
    rankVersions: [...page.rankVersions],
  };
}

export function mapArticle(article: Article): ArticleDto {
  return {
    storyId: article.storyId,
    status: article.status,
    sourceContentVersion: article.sourceContentVersion,
    contentVersion: article.contentVersion,
    ...(present(article.title) ? { title: article.title } : {}),
    ...(present(article.byline) ? { byline: article.byline } : {}),
    ...(present(article.excerpt) ? { excerpt: article.excerpt } : {}),
    ...(article.status === "ready" && present(article.sanitizedHtml)
      ? { sanitizedHtml: article.sanitizedHtml }
      : {}),
    ...(present(article.extractorVersion) ? { extractorVersion: article.extractorVersion } : {}),
    ...(present(article.fetchedAt) ? { fetchedAt: article.fetchedAt } : {}),
    updatedAt: article.updatedAt,
    ...(present(article.errorCode) ? { errorCode: safeTransportCode(article.errorCode) } : {}),
  };
}

export function mapRecommendation(recommendation: Recommendation): RecommendationDto {
  return {
    id: recommendation.id,
    storyId: recommendation.storyId,
    profileId: recommendation.profileId,
    storyContentVersion: recommendation.storyContentVersion,
    articleContentVersion: recommendation.articleContentVersion,
    promptVersion: recommendation.promptVersion,
    model: recommendation.model,
    score: recommendation.score,
    rationale: recommendation.rationale,
    evidence: recommendation.evidence.map((evidence) => ({
      kind: evidence.kind,
      label: evidence.label,
      ...(present(evidence.value) ? { value: evidence.value } : {}),
      ...(present(evidence.sourceId) ? { sourceId: evidence.sourceId } : {}),
    })),
    evidenceSchemaVersion: recommendation.evidenceSchemaVersion,
    ...(present(recommendation.llmCallId) ? { llmCallId: recommendation.llmCallId } : {}),
    createdAt: recommendation.createdAt,
  };
}

export function mapRecommendationHistory(recommendations: readonly Recommendation[]): RecommendationDto[] {
  return recommendations.map(mapRecommendation);
}

export function mapStoryDetail(detail: StoryDetail): StoryDetailDto {
  return {
    story: mapStory(detail.story),
    ...(present(detail.article) ? { article: mapArticle(detail.article) } : {}),
    ...(present(detail.recommendation) ? { recommendation: mapRecommendation(detail.recommendation) } : {}),
    queueEntry: mapQueueEntry(detail.queueEntry),
    originalUrl: detail.originalUrl,
    fallback: mapStoryFallback(detail.fallback),
  };
}

export function mapActivityEvent(event: StoredActivityEvent): ActivityEventDto {
  return {
    id: event.id,
    clientEventId: event.clientEventId,
    storyId: event.storyId,
    kind: event.kind,
    ...(present(event.value) ? { value: { ...event.value } } : {}),
    valueSchemaVersion: event.valueSchemaVersion,
    source: event.source,
    observationQuality: event.observationQuality,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    sequence: event.sequence,
  };
}

export function mapReadingSession(session: ReadingSession): ReadingSessionDto {
  return {
    id: session.id,
    storyId: session.storyId,
    startedAt: session.startedAt,
    ...(present(session.endedAt) ? { endedAt: session.endedAt } : {}),
    updatedAt: session.updatedAt,
    activeDwellMs: session.activeDwellMs,
    maxScrollRatio: session.maxScrollRatio,
    state: session.state,
    observationQuality: session.observationQuality,
    lastClientEventId: session.lastClientEventId,
  };
}

export function mapActivityHistory(history: ActivityHistory): ActivityHistoryDto {
  return {
    events: history.events.map(mapActivityEvent),
    sessions: history.sessions.map(mapReadingSession),
  };
}

export function mapPreferenceRule(rule: PreferenceRule): PreferenceRuleDto {
  return {
    id: rule.id,
    kind: rule.kind,
    effect: rule.effect,
    value: rule.value,
    normalizedValue: rule.normalizedValue,
    enabled: rule.enabled,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

export function mapPreferenceRules(rules: readonly PreferenceRule[]): PreferenceRuleDto[] {
  return rules.map(mapPreferenceRule);
}

export function mapInterestProfile(profile: InterestProfile): InterestProfileDto {
  return {
    id: profile.id,
    rulesVersion: profile.rulesVersion,
    activityVersion: profile.activityVersion,
    sourceRules: mapPreferenceRules(profile.sourceRules),
    sourceRulesSchemaVersion: profile.sourceRulesSchemaVersion,
    policy: { ...profile.policy },
    policySchemaVersion: profile.policySchemaVersion,
    policyVersion: profile.policyVersion,
    builderVersion: profile.builderVersion,
    interests: profile.interests.map((interest) => ({
      topic: interest.topic,
      weight: interest.weight,
      evidence: interest.evidence.map((evidence) => ({
        kind: evidence.kind,
        count: evidence.count,
        weight: evidence.weight,
      })),
    })),
    reason: profile.reason,
    createdAt: profile.createdAt,
  };
}

export function mapJob(job: Job): JobDto {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    runAfter: job.runAfter,
    ...(present(job.leaseExpiresAt) ? { leaseExpiresAt: job.leaseExpiresAt } : {}),
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    ...(present(job.lastErrorCode) ? { lastErrorCode: safeTransportCode(job.lastErrorCode) } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(present(job.completedAt) ? { completedAt: job.completedAt } : {}),
  };
}

export function mapAccountCapability(capability: AccountCapability): AccountCapabilityDto {
  return {
    name: capability.name,
    state: capability.state,
    ...(present(capability.reason) ? { reason: safeTransportCode(capability.reason) } : {}),
  };
}

export function mapAccountCapabilities(capabilities: readonly AccountCapability[]): AccountCapabilityDto[] {
  return capabilities.map(mapAccountCapability);
}

export function mapHnActionOutcome(result: HnActionResult): HnActionOutcomeDto {
  return {
    status: result.status,
    observedAt: result.observedAt,
    ...(present(result.errorCode) ? { errorCode: safeTransportCode(result.errorCode) } : {}),
  };
}

export function mapHnActionResult(result: HnActionResult): HnActionResultDto {
  return { intentId: result.intentId, ...mapHnActionOutcome(result) };
}

function mapStoredHnOutcome(intent: HnActionIntent): HnActionOutcomeDto | undefined {
  const evidence = intent.result;
  if (evidence === undefined || intent.resultSchemaVersion !== 1) return undefined;
  if (evidence.source === "hn-reconciliation") {
    if (!isHnOutcomeStatus(intent.status) || !isIsoDateTime(evidence.observedAt)) return undefined;
    return { status: intent.status, observedAt: evidence.observedAt };
  }
  if (
    evidence.intentId !== intent.id ||
    !isHnOutcomeStatus(evidence.status) ||
    !isIsoDateTime(evidence.observedAt)
  ) return undefined;
  return {
    status: evidence.status,
    observedAt: evidence.observedAt,
    ...(present(evidence.errorCode) ? { errorCode: safeTransportCode(evidence.errorCode) } : {}),
  };
}

export function mapHnActionHistory(intent: HnActionIntent): HnActionHistoryDto {
  const outcome = mapStoredHnOutcome(intent);
  return {
    id: intent.id,
    storyId: intent.storyId,
    action: intent.action,
    status: intent.status,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    ...(present(intent.errorCode) ? { errorCode: safeTransportCode(intent.errorCode) } : {}),
    ...(outcome === undefined ? {} : { outcome }),
  };
}

export function mapHnActionHistoryPage(intents: readonly HnActionIntent[]): HnActionHistoryDto[] {
  return intents.map(mapHnActionHistory);
}

export function mapRecordActivityResult(result: RecordActivityResult): RecordActivityResultDto {
  return { accepted: result.accepted, profileWorkEnqueued: result.profileWorkEnqueued };
}

export function mapIngestionSummary(summary: IngestionSummary): IngestionSummaryDto {
  return {
    runId: summary.runId,
    highestSeenItemId: summary.highestSeenItemId,
    storiesUpserted: summary.storiesUpserted,
    nonStoriesSkipped: summary.nonStoriesSkipped,
    jobsEnqueued: summary.jobsEnqueued,
  };
}

export function mapAccountReconciliationSummary(
  summary: AccountReconciliationSummary,
): AccountReconciliationSummaryDto {
  return {
    runId: summary.runId,
    observations: summary.observations,
    skippedUnknownStories: summary.skippedUnknownStories,
    activityJobsEnqueued: summary.activityJobsEnqueued,
    capabilities: mapAccountCapabilities(summary.capabilities),
  };
}

export function mapScorePendingSummary(summary: ScorePendingSummary): ScorePendingSummaryDto {
  return {
    completion: summary.completion,
    scored: summary.scored,
    failed: summary.failed,
    retryableFailed: summary.retryableFailed,
    queued: summary.queued,
    audits: summary.audits,
  };
}

export function mapRecoverySummary(summary: RecoverySummary): RecoverySummaryDto {
  return {
    completion: summary.completion,
    scored: summary.scored,
    failed: summary.failed,
    retryableFailed: summary.retryableFailed,
    queued: summary.queued,
    audits: summary.audits,
    rebuilt: summary.rebuilt,
  };
}

export function mapRunOnceResult(result: RunOnceResult): RunOnceResultDto {
  switch (result.outcome) {
    case "idle":
      return { outcome: "idle" };
    case "lease-lost":
      return {
        outcome: "lease-lost",
        jobId: result.jobId,
        kind: result.kind,
        handlerOutcome: result.handlerOutcome,
      };
    case "rejected":
    case "completed":
    case "failed":
      return { outcome: result.outcome, job: mapJob(result.job) };
  }
}
