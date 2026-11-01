export type QueueState = "unread" | "reading" | "read" | "dismissed" | "archived";
export type EvaluationState = "pending" | "scored" | "failed";
export type VisibilityState = "visible" | "blacklisted";
export type RecommendationKind = "match" | "exploration";
export type ArticleStatus = "pending" | "ready" | "failed";
export type HnActionKind = "upvote" | "flag" | "favorite";
export type HnActionStatus = "pending" | "verified" | "indeterminate" | "failed";
export type PreferenceKind = "topic" | "keyword" | "author" | "domain";
export type PreferenceEffect = "include" | "exclude";
export type ActivitySource = "embedded-reader" | "original-page" | "app-action";

export interface StoryDto {
  id: number;
  itemType: "story";
  title: string;
  publishedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  contentVersion: string;
  deleted: boolean;
  dead: boolean;
  author?: string;
  score?: number;
  descendants?: number;
}

export interface QueueEntryDto {
  storyId: number;
  state: QueueState;
  evaluationState: EvaluationState;
  visibilityState: VisibilityState;
  kind: RecommendationKind;
  rankVersion: string;
  queuedAt: string;
  updatedAt: string;
  recommendationId?: string;
  rankScore?: number;
  rankPosition?: number;
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

export interface QueueDto {
  items: QueueItemDto[];
  nextCursor?: string;
  evaluationCounts: Record<EvaluationState, number>;
  rankVersions: string[];
}

export interface ArticleDto {
  storyId: number;
  status: ArticleStatus;
  sourceContentVersion: string;
  contentVersion: string;
  updatedAt: string;
  title?: string;
  byline?: string;
  excerpt?: string;
  sanitizedHtml?: string;
  extractorVersion?: string;
  fetchedAt?: string;
  errorCode?: string;
}

export interface RecommendationEvidence {
  kind: "explicit-rule" | "activity" | "story" | "exploration";
  label: string;
  value?: string | number;
  sourceId?: string;
}

export interface RecommendationDto {
  id: string;
  storyId: number;
  profileId: string;
  storyContentVersion: string;
  articleContentVersion: string;
  promptVersion: string;
  model: string;
  score: number;
  rationale: string;
  evidence: RecommendationEvidence[];
  evidenceSchemaVersion: 1;
  llmCallId?: string;
  createdAt: string;
}

export interface StoryDetailDto {
  story: StoryDto;
  article?: ArticleDto;
  recommendation?: RecommendationDto;
  queueEntry: QueueEntryDto;
  originalUrl: string;
  fallback: StoryFallbackDto;
}

export interface JobDto {
  id: string;
  kind: string;
  status: "queued" | "leased" | "done" | "failed";
  runAfter: string;
  leaseExpiresAt?: string;
  attempts: number;
  maxAttempts: number;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type RawActivity =
  | { clientEventId: string; storyId: number; kind: "impression" | "open" | "complete" | "skip"; occurredAt: string; source: "embedded-reader" | "original-page"; value?: never }
  | { clientEventId: string; storyId: number; kind: "dwell"; occurredAt: string; source: "embedded-reader" | "original-page"; value: { activeMs: number } }
  | { clientEventId: string; storyId: number; kind: "scroll"; occurredAt: string; source: "embedded-reader" | "original-page"; value: { ratio: number } }
  | { clientEventId: string; storyId: number; kind: "dismiss"; occurredAt: string; source: "app-action"; value?: never }
  | { clientEventId: string; storyId: number; kind: HnActionKind; occurredAt: string; source: "app-action"; value: { present: true } };

export interface PreferenceRuleDto {
  id: string;
  kind: PreferenceKind;
  effect: PreferenceEffect;
  value: string;
  normalizedValue: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
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
  interests: Array<{
    topic: string;
    weight: number;
    evidence: Array<{ kind: string; count: number; weight: number }>;
  }>;
  reason: string;
  createdAt: string;
}

export interface AccountCapabilityDto {
  name: "upvoted" | "favorites" | "flagged" | "mutations";
  state: "available" | "unavailable" | "unverified";
  reason?: string;
}

export interface HnActionResultDto {
  intentId: string;
  status: "verified" | "indeterminate" | "failed";
  observedAt: string;
  errorCode?: string;
}

export interface HnActionHistoryDto {
  id: string;
  storyId: number;
  action: HnActionKind;
  status: HnActionStatus;
  createdAt: string;
  updatedAt: string;
  errorCode?: string;
  outcome?: { status: "verified" | "indeterminate" | "failed"; observedAt: string; errorCode?: string };
}

export interface ReadinessSnapshot {
  generatedAt: string;
  status: "ready" | "not-ready";
  checks: Array<{
    name: "configuration" | "sqlite" | "migrations" | "workers";
    status: "pass" | "fail";
    reason: string;
  }>;
}

export interface CapabilityStatus {
  state: "available" | "degraded" | "unavailable" | "disabled" | "unknown";
  reason: string;
  observedAt?: string;
}

export interface CapabilitiesSnapshot {
  generatedAt: string;
  storedReading: CapabilityStatus;
  backgroundWork: CapabilityStatus;
  llmPersonalization: CapabilityStatus;
  hnPublicCollection: CapabilityStatus;
  hnAccount: CapabilityStatus;
  freshArticleContent: CapabilityStatus;
}

export interface DebugSection<T> {
  status: "ok" | "unavailable";
  value: T;
  errorCode?: "read-failed";
}

export interface DebugPage<T> { items: T[]; nextCursor?: string }

export interface DebugSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  payloadPolicy: { llmPayloads: boolean };
  partial: boolean;
  activeProfile: DebugSection<{ id: string; rulesVersion: string; activityVersion: string; policyVersion: string; builderVersion: string; createdAt: string } | undefined>;
  recommendationVersions: DebugSection<DebugPage<{ profileId: string; promptVersion: string; model: string; rankVersion: string; queueEntryCount: number }>>;
  syncRuns: DebugSection<DebugPage<{ id: string; kind: string; status: string; storiesUpserted: number; nonStoriesSkipped: number; errorCode?: string; startedAt: string; completedAt?: string }>>;
  jobs: DebugSection<DebugPage<{ id: string; kind: string; status: string; runAfter: string; attempts: number; maxAttempts: number; updatedAt: string }>>;
  queueCounts: DebugSection<{ pending: number; scored: number; failed: number }>;
  llmCalls: DebugSection<DebugPage<{ id: string; purpose: string; model: string; status: string; inputTokens?: number; outputTokens?: number; latencyMs: number; errorCode?: string; createdAt: string }>>;
  recentErrors: DebugSection<DebugPage<{ id: string; code: string; component: string; occurredAt: string; jobId?: string; storyId?: number; requestId?: string }>>;
}

export interface DebugStreamFrame { sequence: number; snapshot: DebugSnapshot }

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
    details?: {
      operation?: string;
      field?: string;
      storyId?: number;
      jobId?: string;
      dependency?: string;
      dependencyCode?: string;
      retryAfterSeconds?: number;
    };
  };
}
