import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AccessSessionRecordSchema,
  ActivityEventSchema,
  ArticleSchema,
  DiagnosticErrorSchema,
  HnAccountStateSchema,
  HnActionIntentSchema,
  HnItemSchema,
  IngestionRunSchema,
  InterestProfileSchema,
  IsoDateTimeSchema,
  JobSchema,
  LlmCallRecordSchema,
  PreferenceRuleSchema,
  QueueEntrySchema,
  ReadingSessionSchema,
  RecommendationSchema,
  RecommendationVersionCountSchema,
  StoredActivityEventSchema,
  StoryIdSchema,
  StorySchema,
  articleContentVersion,
} from "../src/index.js";
import type { Article } from "../src/index.js";

const now = "2026-01-02T03:04:05.006Z";
const versioned = (article: Article): Article => ({
  ...article,
  contentVersion: articleContentVersion(article),
});
const hnItem = {
  id: 42,
  type: "story" as const,
  author: "reader",
  time: 1_767_000_000,
  title: "A story",
  url: "https://example.com/story",
  score: 10,
  descendants: 2,
  deleted: false,
  dead: false,
  raw: { id: 42, type: "story", arbitrary: { retained: true } },
  rawSchemaVersion: 1 as const,
};
const story = {
  id: 42,
  itemType: "story" as const,
  url: "https://example.com/story",
  canonicalUrl: "https://example.com/story",
  title: "A story",
  author: "reader",
  score: 10,
  descendants: 2,
  publishedAt: now,
  firstSeenAt: now,
  lastSeenAt: now,
  contentVersion: "story-v1",
  raw: hnItem,
  rawSchemaVersion: 1 as const,
  deleted: false,
  dead: false,
};
const pendingArticle = versioned({
  storyId: 42,
  status: "pending",
  sourceContentVersion: "story-v1",
  contentVersion: "placeholder",
  updatedAt: now,
});
const readyArticle = versioned({
  storyId: 42,
  status: "ready",
  sourceContentVersion: "story-v1",
  contentVersion: "placeholder",
  sourceUrl: "https://example.com/story",
  title: "Extracted",
  byline: "Author",
  excerpt: "Summary",
  textContent: "Readable text",
  sanitizedHtml: "<p>Readable text</p>",
  contentHash: `sha256:${"a".repeat(64)}`,
  extractorVersion: "article-reader-v1:1",
  fetchedAt: now,
  updatedAt: now,
});
const activity = {
  id: "activity-1",
  clientEventId: "client-1",
  storyId: 42,
  kind: "open" as const,
  value: { surface: "queue" },
  valueSchemaVersion: 1 as const,
  source: "embedded-reader" as const,
  observationQuality: "full" as const,
  occurredAt: now,
  receivedAt: now,
};
const preference = {
  id: "rule-1",
  kind: "topic" as const,
  effect: "include" as const,
  value: "Databases",
  normalizedValue: "databases",
  enabled: true,
  createdAt: now,
  updatedAt: now,
};
const profile = {
  id: "profile-1",
  rulesVersion: "rules-v1",
  activityVersion: "activity-v1",
  sourceRules: [preference],
  sourceRulesSchemaVersion: 1 as const,
  policy: { explorationRatio: 0.1 },
  policySchemaVersion: 1 as const,
  policyVersion: "policy-v1",
  builderVersion: "builder-v1",
  interests: [{
    topic: "databases",
    weight: 0.8,
    evidence: [{ kind: "explicit-rule" as const, count: 1, weight: 0.8 }],
  }],
  reason: "Explicit interest",
  createdAt: now,
};
const recommendation = {
  id: "recommendation-1",
  storyId: 42,
  profileId: "profile-1",
  storyContentVersion: "story-v1",
  articleContentVersion: readyArticle.contentVersion,
  promptVersion: "prompt-v1",
  model: "model-v1",
  score: 0.8,
  rationale: "Strong match",
  evidence: [{ kind: "story" as const, label: "Database story", value: 0.8 }],
  evidenceSchemaVersion: 1 as const,
  llmCallId: "call-1",
  createdAt: now,
};
const queueEntry = {
  storyId: 42,
  state: "unread" as const,
  evaluationState: "scored" as const,
  visibilityState: "visible" as const,
  kind: "match" as const,
  recommendationId: recommendation.id,
  rankScore: 0.8,
  rankPosition: 1,
  rankVersion: "rank-v1",
  queuedAt: now,
  updatedAt: now,
};

const records = [
  ["HnItem", HnItemSchema, hnItem],
  ["Story", StorySchema, story],
  ["Article", ArticleSchema, readyArticle],
  ["ActivityEvent", ActivityEventSchema, activity],
  ["StoredActivityEvent", StoredActivityEventSchema, { ...activity, sequence: 1 }],
  ["ReadingSession", ReadingSessionSchema, {
    id: "session-1", storyId: 42, startedAt: now, updatedAt: now,
    activeDwellMs: 100, maxScrollRatio: 0.5, state: "active",
    observationQuality: "full", lastClientEventId: "client-1",
  }],
  ["PreferenceRule", PreferenceRuleSchema, preference],
  ["InterestProfile", InterestProfileSchema, profile],
  ["Recommendation", RecommendationSchema, recommendation],
  ["QueueEntry", QueueEntrySchema, queueEntry],
  ["HnActionIntent", HnActionIntentSchema, {
    id: "intent-1", storyId: 42, action: "upvote", idempotencyKey: "intent-key",
    status: "verified", result: { present: true }, resultSchemaVersion: 1,
    createdAt: now, updatedAt: now,
  }],
  ["HnAccountState", HnAccountStateSchema, {
    username: "reader", storyId: 42, kind: "upvote", present: true,
    firstObservedAt: now, lastObservedAt: now,
  }],
  ["Job", JobSchema, {
    id: "job-1", kind: "personalization.score-pending", payload: { storyId: 42 },
    payloadSchemaVersion: 1, status: "leased", runAfter: now,
    leaseToken: "lease-1", leaseExpiresAt: now, attempts: 1, maxAttempts: 3,
    createdAt: now, updatedAt: now,
  }],
  ["IngestionRun", IngestionRunSchema, {
    id: "run-1", kind: "hn.public.collect", status: "complete",
    cursorStart: "41", cursorEnd: "42", storiesUpserted: 1, nonStoriesSkipped: 0,
    startedAt: now, completedAt: now,
  }],
  ["LlmCallRecord", LlmCallRecordSchema, {
    id: "call-1", purpose: "recommendation", model: "model-v1", status: "success",
    requestHash: `sha256:${"b".repeat(64)}`, inputTokens: 10, outputTokens: 5,
    latencyMs: 100, providerRequestId: "provider-1", createdAt: now,
  }],
  ["AccessSessionRecord", AccessSessionRecordSchema, {
    sessionHash: "session-hash", csrfSecretHash: "csrf-hash", createdAt: now,
    expiresAt: now, lastUsedAt: now,
  }],
  ["DiagnosticError", DiagnosticErrorSchema, {
    id: "error-1", code: "provider-error", component: "recommendations", occurredAt: now,
  }],
  ["RecommendationVersionCount", RecommendationVersionCountSchema, {
    profileId: "profile-1", promptVersion: "prompt-v1", model: "model-v1",
    rankVersion: "rank-v1", queueEntryCount: 1,
  }],
] as const;

describe("persisted record schemas", () => {
  it.each(records)("should round-trip a valid %s record and reject unknown keys", (_name, schema, value) => {
    expect(schema.parse(value)).toEqual(value);
    expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
  });

  it("should retain type-less HN tombstones", () => {
    const tombstone = { id: 42, deleted: true, dead: false, raw: { id: 42 }, rawSchemaVersion: 1 };
    expect(HnItemSchema.parse(tombstone)).toEqual(tombstone);
  });

  it("should reject invalid timestamps unsafe IDs and non-finite numbers", () => {
    expect(IsoDateTimeSchema.safeParse("2026-01-02T03:04:05Z").success).toBe(false);
    expect(IsoDateTimeSchema.safeParse("2026-02-30T03:04:05.000Z").success).toBe(false);
    expect(StoryIdSchema.safeParse(0).success).toBe(false);
    expect(StoryIdSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
    expect(RecommendationSchema.safeParse({ ...recommendation, score: Number.NaN }).success).toBe(false);
    expect(RecommendationSchema.safeParse({ ...recommendation, score: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it("should enforce partial observation for original-page and reconciliation activity", () => {
    expect(ActivityEventSchema.safeParse({
      ...activity,
      source: "original-page",
      observationQuality: "full",
    }).success).toBe(false);
    expect(ActivityEventSchema.safeParse({
      ...activity,
      source: "hn-reconciliation",
      observationQuality: "partial",
    }).success).toBe(true);
  });

  it("should add positive append sequence without changing logical event identity", () => {
    const stored = StoredActivityEventSchema.parse({ ...activity, sequence: 1 });
    const { sequence, ...logical } = stored;
    expect(sequence).toBe(1);
    expect(logical).toEqual(activity);
    expect(StoredActivityEventSchema.safeParse({ ...activity, sequence: 0 }).success).toBe(false);
  });

  it("should enforce scored queue recommendation and rank fields", () => {
    expect(QueueEntrySchema.safeParse({ ...queueEntry, recommendationId: undefined }).success).toBe(false);
    expect(QueueEntrySchema.safeParse({ ...queueEntry, rankScore: undefined }).success).toBe(false);
  });

  it("should enforce HN verification evidence and result version pairs", () => {
    const verified = HnActionIntentSchema.parse(records[10][2]);
    expect(HnActionIntentSchema.safeParse({ ...verified, result: undefined }).success).toBe(false);
    expect(HnActionIntentSchema.safeParse({ ...verified, errorCode: "unknown" }).success).toBe(false);
  });

  it("should enforce complete leased-job fields and omit them in other states", () => {
    const leased = JobSchema.parse(records[12][2]);
    expect(JobSchema.safeParse({ ...leased, leaseToken: undefined }).success).toBe(false);
    expect(JobSchema.safeParse({ ...leased, status: "done" }).success).toBe(false);
    expect(JobSchema.safeParse({
      ...leased,
      status: "done",
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    }).success).toBe(true);
  });

  it("should enforce LLM payload and schema-version pairs", () => {
    const audit = LlmCallRecordSchema.parse(records[14][2]);
    expect(LlmCallRecordSchema.safeParse({ ...audit, requestPayload: { safe: true } }).success).toBe(false);
    expect(LlmCallRecordSchema.safeParse({
      ...audit,
      requestPayload: { safe: true },
      requestPayloadSchemaVersion: 1,
    }).success).toBe(true);
  });
});

describe("articleContentVersion", () => {
  const hash = (projection: unknown): string =>
    `av1.${createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex")}`;

  it("should return none for an absent article and independent golden pending failed and ready versions", () => {
    expect(articleContentVersion(undefined)).toBe("none");
    expect(pendingArticle.contentVersion).toBe(hash({ status: "pending" }));
    const failed = versioned({
      ...pendingArticle,
      status: "failed",
      extractorVersion: "article-reader-v1:1",
    });
    expect(failed.contentVersion).toBe(hash({ status: "failed" }));
    expect(readyArticle.contentVersion).toBe(hash({
      status: "ready",
      title: "Extracted",
      byline: "Author",
      excerpt: "Summary",
      contentHash: readyArticle.contentHash,
      extractorVersion: readyArticle.extractorVersion,
    }));
  });

  it("should change for every projected ready metadata value", () => {
    for (const change of [
      { title: "Changed" },
      { byline: "Changed" },
      { excerpt: "Changed" },
      { contentHash: `sha256:${"c".repeat(64)}` },
      { extractorVersion: "article-reader-v2:1" },
    ]) {
      expect(articleContentVersion({ ...readyArticle, ...change })).not.toBe(readyArticle.contentVersion);
    }
  });

  it("should exclude raw text URLs errors source version and timestamps from ready identity", () => {
    expect(articleContentVersion({
      ...readyArticle,
      textContent: "Different stale text",
      sourceUrl: "https://other.example/",
      finalUrl: "https://redirect.example/",
      errorCode: "ignored",
      errorMessage: "ignored",
      sourceContentVersion: "story-v2",
      updatedAt: "2027-01-01T00:00:00.000Z",
    })).toBe(readyArticle.contentVersion);
  });

  it("should hash only failed status while retaining attempted pipeline provenance", () => {
    const failed = versioned({
      ...readyArticle,
      status: "failed",
      title: undefined,
      byline: undefined,
      excerpt: undefined,
      contentHash: undefined,
    });
    expect(failed.contentVersion).toBe(hash({ status: "failed" }));
    expect(failed.extractorVersion).toBe(readyArticle.extractorVersion);
    expect(articleContentVersion({ ...failed, extractorVersion: "article-reader-v2:1" })).toBe(failed.contentVersion);
  });

  it("should reject ready articles without hash terminal articles without provenance and inconsistent versions", () => {
    expect(ArticleSchema.safeParse({ ...readyArticle, contentHash: undefined }).success).toBe(false);
    expect(ArticleSchema.safeParse({ ...readyArticle, extractorVersion: undefined }).success).toBe(false);
    expect(ArticleSchema.safeParse({ ...readyArticle, contentVersion: "wrong" }).success).toBe(false);
    expect(ArticleSchema.safeParse(versioned({
      ...pendingArticle,
      status: "failed",
    })).success).toBe(false);
  });
});
