import { createHash } from "node:crypto";
import { z } from "zod";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().min(0).max(MAX_SAFE_INTEGER);
const positiveInteger = z.number().int().min(1).max(MAX_SAFE_INTEGER);
const finiteNumber = z.number().finite();
const jsonRecord = z.record(z.string(), z.unknown());

export const IsoDateTimeSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => new Date(value).toISOString() === value, "Invalid UTC timestamp.");
export const StoryIdSchema = positiveInteger;
export const SchemaVersionSchema = positiveInteger;
export const ObservationQualitySchema = z.enum(["full", "partial"]);
export const ActivitySourceSchema = z.enum([
  "embedded-reader",
  "original-page",
  "hn-reconciliation",
  "app-action",
]);
export const ActivityKindSchema = z.enum([
  "impression",
  "open",
  "dwell",
  "scroll",
  "complete",
  "skip",
  "dismiss",
  "upvote",
  "flag",
  "favorite",
]);
export const QueueStateSchema = z.enum(["unread", "reading", "read", "dismissed", "archived"]);
export const EvaluationStateSchema = z.enum(["pending", "scored", "failed"]);
export const VisibilityStateSchema = z.enum(["visible", "blacklisted"]);
export const RecommendationKindSchema = z.enum(["match", "exploration"]);
export const HnFeedSchema = z.enum(["top", "new", "best", "ask", "show"]);
export const HnActionKindSchema = z.enum(["upvote", "flag", "favorite"]);
export const HnActionStatusSchema = z.enum(["pending", "verified", "indeterminate", "failed"]);
export const JobStatusSchema = z.enum(["queued", "leased", "done", "failed"]);
export const HnItemTypeSchema = z.enum(["story", "comment", "job", "poll", "pollopt"]);
export const ArticleStatusSchema = z.enum(["pending", "ready", "failed"]);
export const ReadingSessionStateSchema = z.enum(["active", "complete", "abandoned"]);
export const PreferenceKindSchema = z.enum(["topic", "keyword", "author", "domain"]);
export const PreferenceEffectSchema = z.enum(["include", "exclude"]);
export const IngestionRunStatusSchema = z.enum(["running", "complete", "failed"]);
export const LlmCallStatusSchema = z.enum([
  "success",
  "invalid-output",
  "provider-error",
  "timeout",
  "cancelled",
]);

export type StoryId = z.infer<typeof StoryIdSchema>;
export type ActivityId = string;
export type ProfileId = string;
export type RecommendationId = string;
export type JobId = string;
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;
export type ObservationQuality = z.infer<typeof ObservationQualitySchema>;
export type ActivitySource = z.infer<typeof ActivitySourceSchema>;
export type ActivityKind = z.infer<typeof ActivityKindSchema>;
export type QueueState = z.infer<typeof QueueStateSchema>;
export type EvaluationState = z.infer<typeof EvaluationStateSchema>;
export type VisibilityState = z.infer<typeof VisibilityStateSchema>;
export type RecommendationKind = z.infer<typeof RecommendationKindSchema>;
export type HnFeed = z.infer<typeof HnFeedSchema>;
export type HnActionKind = z.infer<typeof HnActionKindSchema>;
export type HnActionStatus = z.infer<typeof HnActionStatusSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type HnItemType = z.infer<typeof HnItemTypeSchema>;
export type ArticleStatus = z.infer<typeof ArticleStatusSchema>;
export type ReadingSessionState = z.infer<typeof ReadingSessionStateSchema>;
export type PreferenceKind = z.infer<typeof PreferenceKindSchema>;
export type PreferenceEffect = z.infer<typeof PreferenceEffectSchema>;
export type IngestionRunStatus = z.infer<typeof IngestionRunStatusSchema>;
export type LlmCallStatus = z.infer<typeof LlmCallStatusSchema>;

export interface VersionedJson<T> {
  schemaVersion: SchemaVersion;
  value: T;
}

export const HnItemSchema = z.strictObject({
  id: StoryIdSchema,
  type: HnItemTypeSchema.optional(),
  author: z.string().optional(),
  time: nonNegativeInteger.optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  textHtml: z.string().optional(),
  score: nonNegativeInteger.optional(),
  descendants: nonNegativeInteger.optional(),
  deleted: z.boolean(),
  dead: z.boolean(),
  raw: jsonRecord,
  rawSchemaVersion: z.literal(1),
});
export type HnItem = z.infer<typeof HnItemSchema>;

export const StorySchema = z.strictObject({
  id: StoryIdSchema,
  itemType: z.literal("story"),
  url: z.string().optional(),
  canonicalUrl: z.string().optional(),
  title: z.string(),
  author: z.string().optional(),
  textHtml: z.string().optional(),
  score: nonNegativeInteger.optional(),
  descendants: nonNegativeInteger.optional(),
  publishedAt: IsoDateTimeSchema,
  firstSeenAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema,
  contentVersion: nonEmptyString,
  raw: HnItemSchema,
  rawSchemaVersion: z.literal(1),
  deleted: z.boolean(),
  dead: z.boolean(),
});
export type Story = z.infer<typeof StorySchema>;

interface ArticleVersionProjection {
  status: ArticleStatus;
  title?: string | undefined;
  byline?: string | undefined;
  excerpt?: string | undefined;
  contentHash?: string | undefined;
  extractorVersion?: string | undefined;
}

function deriveArticleContentVersion(article: ArticleVersionProjection | undefined): string {
  if (article === undefined) return "none";
  const projection = article.status === "ready"
    ? {
        status: article.status,
        title: article.title ?? null,
        byline: article.byline ?? null,
        excerpt: article.excerpt ?? null,
        contentHash: article.contentHash,
        extractorVersion: article.extractorVersion,
      }
    : { status: article.status };
  const digest = createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex");
  return `av1.${digest}`;
}

export const ArticleSchema = z.strictObject({
  storyId: StoryIdSchema,
  status: ArticleStatusSchema,
  sourceContentVersion: nonEmptyString,
  contentVersion: nonEmptyString,
  sourceUrl: z.string().optional(),
  finalUrl: z.string().optional(),
  title: z.string().optional(),
  byline: z.string().optional(),
  excerpt: z.string().optional(),
  textContent: z.string().optional(),
  sanitizedHtml: z.string().optional(),
  contentHash: nonEmptyString.optional(),
  extractorVersion: nonEmptyString.optional(),
  fetchedAt: IsoDateTimeSchema.optional(),
  updatedAt: IsoDateTimeSchema,
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
}).superRefine((article, context) => {
  if (article.status === "ready" && article.contentHash === undefined) {
    context.addIssue({ code: "custom", path: ["contentHash"], message: "Ready articles require a content hash." });
  }
  if ((article.status === "ready" || article.status === "failed") && article.extractorVersion === undefined) {
    context.addIssue({ code: "custom", path: ["extractorVersion"], message: "Terminal articles require extractor provenance." });
  }
  if (article.contentVersion !== deriveArticleContentVersion(article)) {
    context.addIssue({ code: "custom", path: ["contentVersion"], message: "Article content version is inconsistent." });
  }
});
export type Article = z.infer<typeof ArticleSchema>;

export function articleContentVersion(article: Article | undefined): string {
  return deriveArticleContentVersion(article);
}

const activityShape = {
  id: nonEmptyString,
  clientEventId: nonEmptyString,
  storyId: StoryIdSchema,
  kind: ActivityKindSchema,
  value: jsonRecord.optional(),
  valueSchemaVersion: z.literal(1),
  source: ActivitySourceSchema,
  observationQuality: ObservationQualitySchema,
  occurredAt: IsoDateTimeSchema,
  receivedAt: IsoDateTimeSchema,
};

function validateObservationQuality(
  event: { source: ActivitySource; observationQuality: ObservationQuality },
  context: z.RefinementCtx,
): void {
  if ((event.source === "original-page" || event.source === "hn-reconciliation") && event.observationQuality !== "partial") {
    context.addIssue({ code: "custom", path: ["observationQuality"], message: "This activity source is partially observed." });
  }
}

export const ActivityEventSchema = z.strictObject(activityShape).superRefine(validateObservationQuality);
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const StoredActivityEventSchema = z.strictObject({
  ...activityShape,
  sequence: positiveInteger,
}).superRefine(validateObservationQuality);
export type StoredActivityEvent = z.infer<typeof StoredActivityEventSchema>;

export const ReadingSessionSchema = z.strictObject({
  id: nonEmptyString,
  storyId: StoryIdSchema,
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.optional(),
  updatedAt: IsoDateTimeSchema,
  activeDwellMs: nonNegativeInteger,
  maxScrollRatio: finiteNumber.min(0).max(1),
  state: ReadingSessionStateSchema,
  observationQuality: ObservationQualitySchema,
  lastClientEventId: nonEmptyString,
});
export type ReadingSession = z.infer<typeof ReadingSessionSchema>;

export const PreferenceRuleSchema = z.strictObject({
  id: nonEmptyString,
  kind: PreferenceKindSchema,
  effect: PreferenceEffectSchema,
  value: nonEmptyString,
  normalizedValue: nonEmptyString,
  enabled: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type PreferenceRule = z.infer<typeof PreferenceRuleSchema>;

export const InterestEvidenceSchema = z.strictObject({
  kind: z.union([ActivityKindSchema, z.literal("explicit-rule")]),
  count: nonNegativeInteger,
  weight: finiteNumber,
});
export type InterestEvidence = z.infer<typeof InterestEvidenceSchema>;

export const WeightedInterestSchema = z.strictObject({
  topic: nonEmptyString,
  weight: finiteNumber.min(0),
  evidence: z.array(InterestEvidenceSchema),
});
export type WeightedInterest = z.infer<typeof WeightedInterestSchema>;

export const InterestProfileSchema = z.strictObject({
  id: nonEmptyString,
  rulesVersion: nonEmptyString,
  activityVersion: nonEmptyString,
  sourceRules: z.array(PreferenceRuleSchema),
  sourceRulesSchemaVersion: z.literal(1),
  policy: jsonRecord,
  policySchemaVersion: z.literal(1),
  policyVersion: nonEmptyString,
  builderVersion: nonEmptyString,
  interests: z.array(WeightedInterestSchema),
  reason: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type InterestProfile = z.infer<typeof InterestProfileSchema>;

export const RecommendationEvidenceSchema = z.strictObject({
  kind: z.enum(["explicit-rule", "activity", "story", "exploration"]),
  label: z.string(),
  value: z.union([z.string(), finiteNumber]).optional(),
  sourceId: z.string().optional(),
});
export type RecommendationEvidence = z.infer<typeof RecommendationEvidenceSchema>;

export const RecommendationSchema = z.strictObject({
  id: nonEmptyString,
  storyId: StoryIdSchema,
  profileId: nonEmptyString,
  storyContentVersion: nonEmptyString,
  articleContentVersion: nonEmptyString,
  promptVersion: nonEmptyString,
  model: nonEmptyString,
  score: finiteNumber.min(0).max(1),
  rationale: z.string(),
  evidence: z.array(RecommendationEvidenceSchema),
  evidenceSchemaVersion: z.literal(1),
  llmCallId: nonEmptyString.optional(),
  createdAt: IsoDateTimeSchema,
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const QueueEntrySchema = z.strictObject({
  storyId: StoryIdSchema,
  state: QueueStateSchema,
  evaluationState: EvaluationStateSchema,
  visibilityState: VisibilityStateSchema,
  kind: RecommendationKindSchema,
  recommendationId: nonEmptyString.optional(),
  rankScore: finiteNumber.optional(),
  rankPosition: positiveInteger.optional(),
  rankVersion: nonEmptyString,
  lastError: z.string().optional(),
  queuedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).superRefine((entry, context) => {
  if (entry.evaluationState === "scored") {
    if (entry.recommendationId === undefined) {
      context.addIssue({ code: "custom", path: ["recommendationId"], message: "Scored entries require a recommendation." });
    }
    if (entry.rankScore === undefined) {
      context.addIssue({ code: "custom", path: ["rankScore"], message: "Scored entries require a rank score." });
    }
  }
});
export type QueueEntry = z.infer<typeof QueueEntrySchema>;

export const HnActionIntentSchema = z.strictObject({
  id: nonEmptyString,
  storyId: StoryIdSchema,
  action: HnActionKindSchema,
  idempotencyKey: nonEmptyString,
  status: HnActionStatusSchema,
  result: jsonRecord.optional(),
  resultSchemaVersion: z.literal(1).optional(),
  errorCode: nonEmptyString.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).superRefine((intent, context) => {
  if ((intent.result === undefined) !== (intent.resultSchemaVersion === undefined)) {
    context.addIssue({ code: "custom", path: ["resultSchemaVersion"], message: "Result and schema version must appear together." });
  }
  if (intent.status === "verified" && (intent.result === undefined || intent.errorCode !== undefined)) {
    context.addIssue({ code: "custom", path: ["status"], message: "Verified actions require evidence and no error." });
  }
});
export type HnActionIntent = z.infer<typeof HnActionIntentSchema>;

export const HnAccountStateSchema = z.strictObject({
  username: nonEmptyString,
  storyId: StoryIdSchema,
  kind: HnActionKindSchema,
  present: z.boolean(),
  firstObservedAt: IsoDateTimeSchema,
  lastObservedAt: IsoDateTimeSchema,
  sourceCursor: nonEmptyString.optional(),
});
export type HnAccountState = z.infer<typeof HnAccountStateSchema>;

export const JobSchema = z.strictObject({
  id: nonEmptyString,
  kind: nonEmptyString,
  payload: z.unknown(),
  payloadSchemaVersion: SchemaVersionSchema,
  dedupeKey: nonEmptyString.optional(),
  status: JobStatusSchema,
  runAfter: IsoDateTimeSchema,
  leaseToken: nonEmptyString.optional(),
  leaseExpiresAt: IsoDateTimeSchema.optional(),
  attempts: nonNegativeInteger,
  maxAttempts: positiveInteger,
  lastErrorCode: nonEmptyString.optional(),
  lastError: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.optional(),
}).superRefine((job, context) => {
  const hasLease = job.leaseToken !== undefined || job.leaseExpiresAt !== undefined;
  if (job.status === "leased" && (job.leaseToken === undefined || job.leaseExpiresAt === undefined)) {
    context.addIssue({ code: "custom", path: ["leaseToken"], message: "Leased jobs require a complete lease." });
  }
  if (job.status !== "leased" && hasLease) {
    context.addIssue({ code: "custom", path: ["leaseToken"], message: "Only leased jobs may retain lease fields." });
  }
});
export type Job = z.infer<typeof JobSchema>;

export const IngestionRunSchema = z.strictObject({
  id: nonEmptyString,
  kind: nonEmptyString,
  status: IngestionRunStatusSchema,
  cursorStart: nonEmptyString.optional(),
  cursorEnd: nonEmptyString.optional(),
  storiesUpserted: nonNegativeInteger,
  nonStoriesSkipped: nonNegativeInteger,
  errorCode: nonEmptyString.optional(),
  errorMessage: z.string().optional(),
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.optional(),
});
export type IngestionRun = z.infer<typeof IngestionRunSchema>;

export const LlmCallRecordSchema = z.strictObject({
  id: nonEmptyString,
  purpose: nonEmptyString,
  model: nonEmptyString,
  status: LlmCallStatusSchema,
  requestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  inputTokens: nonNegativeInteger.optional(),
  outputTokens: nonNegativeInteger.optional(),
  latencyMs: nonNegativeInteger,
  providerRequestId: nonEmptyString.optional(),
  errorCode: nonEmptyString.optional(),
  requestPayload: z.unknown().optional(),
  requestPayloadSchemaVersion: SchemaVersionSchema.optional(),
  responsePayload: z.unknown().optional(),
  responsePayloadSchemaVersion: SchemaVersionSchema.optional(),
  createdAt: IsoDateTimeSchema,
}).superRefine((record, context) => {
  if ((record.requestPayload === undefined) !== (record.requestPayloadSchemaVersion === undefined)) {
    context.addIssue({ code: "custom", path: ["requestPayloadSchemaVersion"], message: "Request payload and version must appear together." });
  }
  if ((record.responsePayload === undefined) !== (record.responsePayloadSchemaVersion === undefined)) {
    context.addIssue({ code: "custom", path: ["responsePayloadSchemaVersion"], message: "Response payload and version must appear together." });
  }
});
export type LlmCallRecord = z.infer<typeof LlmCallRecordSchema>;

export const AccessSessionRecordSchema = z.strictObject({
  sessionHash: nonEmptyString,
  csrfSecretHash: nonEmptyString,
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  lastUsedAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.optional(),
});
export type AccessSessionRecord = z.infer<typeof AccessSessionRecordSchema>;

export const DiagnosticErrorSchema = z.strictObject({
  id: nonEmptyString,
  code: nonEmptyString,
  message: z.string().optional(),
  component: nonEmptyString,
  occurredAt: IsoDateTimeSchema,
  runId: nonEmptyString.optional(),
  jobId: nonEmptyString.optional(),
  storyId: StoryIdSchema.optional(),
  profileId: nonEmptyString.optional(),
  requestId: nonEmptyString.optional(),
});
export type DiagnosticError = z.infer<typeof DiagnosticErrorSchema>;

export const RecommendationVersionCountSchema = z.strictObject({
  profileId: nonEmptyString,
  promptVersion: nonEmptyString,
  model: nonEmptyString,
  rankVersion: nonEmptyString,
  queueEntryCount: nonNegativeInteger,
});
export type RecommendationVersionCount = z.infer<typeof RecommendationVersionCountSchema>;
