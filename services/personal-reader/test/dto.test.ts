import { describe, expect, it } from "vitest";
import type {
  Article,
  HnActionIntent,
  InterestProfile,
  Job,
  PreferenceRule,
  QueueEntry,
  Recommendation,
  StoredActivityEvent,
  Story,
} from "@tmtp/domain";
import type { AccountCapability, HnActionResult } from "@tmtp/hn-account";
import type { ReaderQueueResult } from "@tmtp/reader-app";
import {
  mapAccountCapabilities,
  mapAccountCapability,
  mapAccountReconciliationSummary,
  mapActivityHistory,
  mapArticle,
  mapHnActionHistory,
  mapHnActionHistoryPage,
  mapHnActionResult,
  mapIngestionSummary,
  mapInterestProfile,
  mapJob,
  mapPreferenceRule,
  mapPreferenceRules,
  mapQueueEntry,
  mapQueuePage,
  mapRecommendation,
  mapRecommendationHistory,
  mapRecordActivityResult,
  mapRecoverySummary,
  mapRunOnceResult,
  mapScorePendingSummary,
  mapStory,
  mapStoryDetail,
  QueueContractError,
  safeTransportCode,
} from "../src/dto.js";
import type { RunOnceResult } from "../src/dto.js";

const NOW = "2026-10-01T00:00:00.000Z";
const LATER = "2026-10-01T00:01:00.000Z";
const SECRET = "PRIVATE-RAW-VALUE";

function story(id = 1): Story {
  return {
    id,
    itemType: "story",
    url: `https://unsafe.example/${id}`,
    canonicalUrl: `https://canonical.example/${id}`,
    title: `Story ${id}`,
    author: "author",
    textHtml: `<script>${SECRET}</script>`,
    score: 10,
    descendants: 4,
    publishedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: LATER,
    contentVersion: "story-v1",
    raw: {
      id,
      type: "story",
      title: SECRET,
      deleted: false,
      dead: false,
      raw: { envelope: SECRET },
      rawSchemaVersion: 1,
    },
    rawSchemaVersion: 1,
    deleted: false,
    dead: false,
  };
}

function queueEntry(storyId = 1): QueueEntry {
  return {
    storyId,
    state: "unread",
    evaluationState: "pending",
    visibilityState: "visible",
    kind: "match",
    rankVersion: "rank-v1",
    lastError: SECRET,
    queuedAt: NOW,
    updatedAt: LATER,
  };
}

function recommendation(): Recommendation {
  return {
    id: "rec-1",
    storyId: 1,
    profileId: "profile-1",
    storyContentVersion: "story-v1",
    articleContentVersion: "article-v1",
    promptVersion: "prompt-v1",
    model: "model-v1",
    score: 0.75,
    rationale: "Relevant evidence",
    evidence: [
      { kind: "story", label: "Story match", value: 0.5, sourceId: "story-1" },
      { kind: "exploration", label: "Explore" },
    ],
    evidenceSchemaVersion: 1,
    llmCallId: "llm-1",
    createdAt: NOW,
  };
}

function article(): Article {
  return {
    storyId: 1,
    status: "ready",
    sourceContentVersion: "story-v1",
    contentVersion: "article-v1",
    sourceUrl: "https://source.example/private",
    finalUrl: "https://final.example/private",
    title: "Extracted title",
    byline: "Extractor",
    excerpt: "Safe excerpt",
    textContent: SECRET,
    sanitizedHtml: "<p>Safe HTML</p>",
    contentHash: "hash-not-for-transport",
    extractorVersion: "extractor-v1",
    fetchedAt: NOW,
    updatedAt: LATER,
    errorCode: "fetch-failed",
    errorMessage: SECRET,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    kind: "article.fetch-extract",
    payload: { secret: SECRET },
    payloadSchemaVersion: 1,
    dedupeKey: SECRET,
    status: "leased",
    runAfter: NOW,
    leaseToken: SECRET,
    leaseExpiresAt: LATER,
    attempts: 1,
    maxAttempts: 3,
    lastErrorCode: "dependency-failure",
    lastError: SECRET,
    createdAt: NOW,
    updatedAt: LATER,
    ...overrides,
  };
}

function preference(): PreferenceRule {
  return {
    id: "rule-1",
    kind: "topic",
    effect: "include",
    value: "TypeScript",
    normalizedValue: "typescript",
    enabled: true,
    createdAt: NOW,
    updatedAt: LATER,
  };
}

describe("safe transport codes", () => {
  it("should preserve bounded lowercase kebab-case and replace every invalid value", () => {
    const valid = ["a", "dependency-failure", "x9-2", "a".repeat(64)];
    for (const code of valid) expect(safeTransportCode(code)).toBe(code);

    const invalid: unknown[] = [
      "",
      "Uppercase",
      "two words",
      "article:timeout",
      "-leading",
      "trailing-",
      "double--dash",
      "under_score",
      "a".repeat(65),
      null,
      undefined,
      42,
      { code: SECRET },
    ];
    for (const code of invalid) expect(safeTransportCode(code)).toBe("unknown-error");
  });
});

describe("queue and story DTOs", () => {
  it("should map scored entries and stories field-by-field while omitting raw and error fields", () => {
    const entry: QueueEntry = {
      ...queueEntry(),
      evaluationState: "scored",
      recommendationId: "rec-1",
      rankScore: 0,
      rankPosition: 1,
    };
    expect(mapQueueEntry(entry)).toEqual({
      storyId: 1,
      state: "unread",
      evaluationState: "scored",
      visibilityState: "visible",
      kind: "match",
      recommendationId: "rec-1",
      rankScore: 0,
      rankPosition: 1,
      rankVersion: "rank-v1",
      queuedAt: NOW,
      updatedAt: LATER,
    });
    expect(mapStory(story())).toEqual({
      id: 1,
      itemType: "story",
      title: "Story 1",
      author: "author",
      score: 10,
      descendants: 4,
      publishedAt: NOW,
      firstSeenAt: NOW,
      lastSeenAt: LATER,
      contentVersion: "story-v1",
      deleted: false,
      dead: false,
    });
    expect(JSON.stringify(mapStory(story()))).not.toContain(SECRET);
  });

  it("should omit optional entry and story keys for absent and null stored values", () => {
    const nullableEntry = {
      ...queueEntry(),
      recommendationId: null,
      rankScore: null,
      rankPosition: null,
    } as unknown as QueueEntry;
    expect(mapQueueEntry(nullableEntry)).toEqual({
      storyId: 1,
      state: "unread",
      evaluationState: "pending",
      visibilityState: "visible",
      kind: "match",
      rankVersion: "rank-v1",
      queuedAt: NOW,
      updatedAt: LATER,
    });
    const nullableStory = {
      ...story(),
      author: null,
      score: null,
      descendants: null,
    } as unknown as Story;
    const mappedStory = mapStory(nullableStory);
    expect(mappedStory).not.toHaveProperty("author");
    expect(mappedStory).not.toHaveProperty("score");
    expect(mappedStory).not.toHaveProperty("descendants");
  });

  it("should zip queue entries and details by index with exact page fields", () => {
    const page: ReaderQueueResult = {
      entries: [queueEntry()],
      storyDetails: [{
        story: story(),
        originalUrl: "https://safe.example/story-1",
        fallback: { kind: "original-page", observationQuality: "partial" },
      }],
      nextCursor: "rqa1.next",
      evaluationCounts: { pending: 1, scored: 0, failed: 0 },
      rankVersions: ["rank-v1"],
    };
    expect(mapQueuePage(page)).toEqual({
      items: [{
        entry: {
          storyId: 1,
          state: "unread",
          evaluationState: "pending",
          visibilityState: "visible",
          kind: "match",
          rankVersion: "rank-v1",
          queuedAt: NOW,
          updatedAt: LATER,
        },
        story: {
          id: 1,
          itemType: "story",
          title: "Story 1",
          author: "author",
          score: 10,
          descendants: 4,
          publishedAt: NOW,
          firstSeenAt: NOW,
          lastSeenAt: LATER,
          contentVersion: "story-v1",
          deleted: false,
          dead: false,
        },
        originalUrl: "https://safe.example/story-1",
        fallback: { kind: "original-page", observationQuality: "partial" },
      }],
      nextCursor: "rqa1.next",
      evaluationCounts: { pending: 1, scored: 0, failed: 0 },
      rankVersions: ["rank-v1"],
    });
    const pageWithoutCursor = { ...page };
    delete pageWithoutCursor.nextCursor;
    const withoutCursor = mapQueuePage(pageWithoutCursor);
    expect(withoutCursor).not.toHaveProperty("nextCursor");
    const nullCursor = mapQueuePage({ ...page, nextCursor: null } as unknown as ReaderQueueResult);
    expect(nullCursor).not.toHaveProperty("nextCursor");
  });

  it("should throw a dedicated safe contract error for length and story ID mismatches", () => {
    const aligned: ReaderQueueResult = {
      entries: [queueEntry(1)],
      storyDetails: [{
        story: story(1),
        originalUrl: "https://safe.example/1",
        fallback: { kind: "original-page", observationQuality: "partial" },
      }],
      evaluationCounts: { pending: 1, scored: 0, failed: 0 },
      rankVersions: ["rank-v1"],
    };
    const wrongId: ReaderQueueResult = {
      ...aligned,
      storyDetails: [{ ...aligned.storyDetails[0]!, story: story(999) }],
    };
    for (const invalid of [{ ...aligned, storyDetails: [] }, wrongId]) {
      let thrown: unknown;
      try {
        mapQueuePage(invalid);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(QueueContractError);
      expect(thrown).toMatchObject({
        name: "QueueContractError",
        code: "queue-contract-mismatch",
        message: "Queue entries and story details are not aligned.",
      });
      expect(JSON.stringify(thrown)).not.toContain("999");
    }
  });
});

describe("article, recommendation, and story detail DTOs", () => {
  it("should project safe article and recommendation fields into story detail", () => {
    const detail = mapStoryDetail({
      story: story(),
      article: article(),
      recommendation: recommendation(),
      queueEntry: queueEntry(),
      originalUrl: "https://safe.example/story-1",
      fallback: { kind: "original-page", observationQuality: "partial" },
    });
    expect(detail).toEqual({
      story: {
        id: 1,
        itemType: "story",
        title: "Story 1",
        author: "author",
        score: 10,
        descendants: 4,
        publishedAt: NOW,
        firstSeenAt: NOW,
        lastSeenAt: LATER,
        contentVersion: "story-v1",
        deleted: false,
        dead: false,
      },
      article: {
        storyId: 1,
        status: "ready",
        sourceContentVersion: "story-v1",
        contentVersion: "article-v1",
        title: "Extracted title",
        byline: "Extractor",
        excerpt: "Safe excerpt",
        sanitizedHtml: "<p>Safe HTML</p>",
        extractorVersion: "extractor-v1",
        fetchedAt: NOW,
        updatedAt: LATER,
        errorCode: "fetch-failed",
      },
      recommendation: {
        id: "rec-1",
        storyId: 1,
        profileId: "profile-1",
        storyContentVersion: "story-v1",
        articleContentVersion: "article-v1",
        promptVersion: "prompt-v1",
        model: "model-v1",
        score: 0.75,
        rationale: "Relevant evidence",
        evidence: [
          { kind: "story", label: "Story match", value: 0.5, sourceId: "story-1" },
          { kind: "exploration", label: "Explore" },
        ],
        evidenceSchemaVersion: 1,
        llmCallId: "llm-1",
        createdAt: NOW,
      },
      queueEntry: {
        storyId: 1,
        state: "unread",
        evaluationState: "pending",
        visibilityState: "visible",
        kind: "match",
        rankVersion: "rank-v1",
        queuedAt: NOW,
        updatedAt: LATER,
      },
      originalUrl: "https://safe.example/story-1",
      fallback: { kind: "original-page", observationQuality: "partial" },
    });
    expect(JSON.stringify(detail)).not.toContain(SECRET);
    expect(JSON.stringify(detail.article)).not.toContain("source.example");
    expect(JSON.stringify(detail.article)).not.toContain("final.example");
    expect(JSON.stringify(detail.article)).not.toContain("contentHash");
  });

  it("should omit absent detail, article, and recommendation optionals and non-ready HTML", () => {
    const detail = mapStoryDetail({
      story: story(),
      queueEntry: queueEntry(),
      originalUrl: "https://safe.example/story-1",
      fallback: { kind: "original-page", observationQuality: "partial" },
    });
    expect(detail).not.toHaveProperty("article");
    expect(detail).not.toHaveProperty("recommendation");

    const pending = {
      ...article(),
      status: "pending",
      title: null,
      byline: null,
      excerpt: null,
      sanitizedHtml: SECRET,
      extractorVersion: null,
      fetchedAt: null,
      errorCode: null,
    } as unknown as Article;
    expect(mapArticle(pending)).toEqual({
      storyId: 1,
      status: "pending",
      sourceContentVersion: "story-v1",
      contentVersion: "article-v1",
      updatedAt: LATER,
    });
    const failed = mapArticle({ ...article(), status: "failed", sanitizedHtml: SECRET });
    expect(failed).not.toHaveProperty("sanitizedHtml");
    expect(JSON.stringify(failed)).not.toContain(SECRET);

    const nullableRecommendation = {
      ...recommendation(),
      llmCallId: null,
      evidence: [{ kind: "story", label: "Story", value: null, sourceId: null }],
    } as unknown as Recommendation;
    const mapped = mapRecommendation(nullableRecommendation);
    expect(mapped).not.toHaveProperty("llmCallId");
    expect(mapped.evidence[0]).toEqual({ kind: "story", label: "Story" });
    expect(mapRecommendationHistory([recommendation()])).toHaveLength(1);
  });
});

describe("activity, preference, and interest profile DTOs", () => {
  it("should map activity history and omit optional event values and session end times", () => {
    const event: StoredActivityEvent = {
      id: "evt-1",
      clientEventId: "client-1",
      storyId: 1,
      kind: "dwell",
      value: { activeMs: 25 },
      valueSchemaVersion: 1,
      source: "embedded-reader",
      observationQuality: "full",
      occurredAt: NOW,
      receivedAt: NOW,
      sequence: 1,
    };
    const open: StoredActivityEvent = {
      ...event,
      id: "evt-2",
      clientEventId: "client-2",
      kind: "open",
      sequence: 2,
    };
    delete open.value;
    expect(mapActivityHistory({
      events: [event, open],
      sessions: [
        {
          id: "session-1",
          storyId: 1,
          startedAt: NOW,
          endedAt: LATER,
          updatedAt: LATER,
          activeDwellMs: 25,
          maxScrollRatio: 0.5,
          state: "complete",
          observationQuality: "full",
          lastClientEventId: "client-1",
        },
        {
          id: "session-2",
          storyId: 1,
          startedAt: NOW,
          updatedAt: NOW,
          activeDwellMs: 0,
          maxScrollRatio: 0,
          state: "active",
          observationQuality: "full",
          lastClientEventId: "client-2",
        },
      ],
    })).toEqual({
      events: [
        {
          id: "evt-1",
          clientEventId: "client-1",
          storyId: 1,
          kind: "dwell",
          value: { activeMs: 25 },
          valueSchemaVersion: 1,
          source: "embedded-reader",
          observationQuality: "full",
          occurredAt: NOW,
          receivedAt: NOW,
          sequence: 1,
        },
        {
          id: "evt-2",
          clientEventId: "client-2",
          storyId: 1,
          kind: "open",
          valueSchemaVersion: 1,
          source: "embedded-reader",
          observationQuality: "full",
          occurredAt: NOW,
          receivedAt: NOW,
          sequence: 2,
        },
      ],
      sessions: [
        {
          id: "session-1",
          storyId: 1,
          startedAt: NOW,
          endedAt: LATER,
          updatedAt: LATER,
          activeDwellMs: 25,
          maxScrollRatio: 0.5,
          state: "complete",
          observationQuality: "full",
          lastClientEventId: "client-1",
        },
        {
          id: "session-2",
          storyId: 1,
          startedAt: NOW,
          updatedAt: NOW,
          activeDwellMs: 0,
          maxScrollRatio: 0,
          state: "active",
          observationQuality: "full",
          lastClientEventId: "client-2",
        },
      ],
    });
  });

  it("should map preference rules and every explicit interest profile field", () => {
    const profile: InterestProfile = {
      id: "profile-1",
      rulesVersion: "rules-v1",
      activityVersion: "activity-v1",
      sourceRules: [preference()],
      sourceRulesSchemaVersion: 1,
      policy: { maximumInterests: 5 },
      policySchemaVersion: 1,
      policyVersion: "policy-v1",
      builderVersion: "builder-v1",
      interests: [{
        topic: "typescript",
        weight: 2.5,
        evidence: [{ kind: "explicit-rule", count: 1, weight: 2.5 }],
      }],
      reason: "preference-change",
      createdAt: NOW,
    };
    expect(mapPreferenceRule(preference())).toEqual(preference());
    expect(mapPreferenceRules([preference()])).toEqual([preference()]);
    expect(mapInterestProfile(profile)).toEqual({
      id: "profile-1",
      rulesVersion: "rules-v1",
      activityVersion: "activity-v1",
      sourceRules: [preference()],
      sourceRulesSchemaVersion: 1,
      policy: { maximumInterests: 5 },
      policySchemaVersion: 1,
      policyVersion: "policy-v1",
      builderVersion: "builder-v1",
      interests: [{
        topic: "typescript",
        weight: 2.5,
        evidence: [{ kind: "explicit-rule", count: 1, weight: 2.5 }],
      }],
      reason: "preference-change",
      createdAt: NOW,
    });
  });
});

describe("job and account capability DTOs", () => {
  it("should omit job payload, dedupe, lease token, and free-form errors", () => {
    expect(mapJob(job())).toEqual({
      id: "job-1",
      kind: "article.fetch-extract",
      status: "leased",
      runAfter: NOW,
      leaseExpiresAt: LATER,
      attempts: 1,
      maxAttempts: 3,
      lastErrorCode: "dependency-failure",
      createdAt: NOW,
      updatedAt: LATER,
    });
    const failed = mapJob(job({
      status: "failed",
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      completedAt: LATER,
      lastErrorCode: SECRET,
    }));
    expect(failed).toEqual({
      id: "job-1",
      kind: "article.fetch-extract",
      status: "failed",
      runAfter: NOW,
      attempts: 1,
      maxAttempts: 3,
      lastErrorCode: "unknown-error",
      createdAt: NOW,
      updatedAt: LATER,
      completedAt: LATER,
    });
    expect(JSON.stringify(failed)).not.toContain(SECRET);
    const nullOptionals = mapJob({
      ...job(),
      leaseExpiresAt: null,
      lastErrorCode: null,
      completedAt: null,
    } as unknown as Job);
    expect(nullOptionals).not.toHaveProperty("leaseExpiresAt");
    expect(nullOptionals).not.toHaveProperty("lastErrorCode");
    expect(nullOptionals).not.toHaveProperty("completedAt");
  });

  it("should map account capabilities and normalize only their optional reason code", () => {
    const available: AccountCapability = { name: "upvoted", state: "available" };
    const unavailable: AccountCapability = {
      name: "flagged",
      state: "unavailable",
      reason: "capability-disabled",
    };
    expect(mapAccountCapability(available)).toEqual({ name: "upvoted", state: "available" });
    expect(mapAccountCapabilities([available, unavailable])).toEqual([
      { name: "upvoted", state: "available" },
      { name: "flagged", state: "unavailable", reason: "capability-disabled" },
    ]);
    const invalid = { name: "mutations", state: "unverified", reason: SECRET } as unknown as AccountCapability;
    expect(mapAccountCapability(invalid)).toEqual({
      name: "mutations",
      state: "unverified",
      reason: "unknown-error",
    });
  });
});

describe("HN action result and history DTOs", () => {
  it("should map verified, failed, and indeterminate command results with optional codes", () => {
    const verified: HnActionResult = { intentId: "intent-1", status: "verified", observedAt: NOW };
    const failed: HnActionResult = {
      intentId: "intent-2",
      status: "failed",
      observedAt: LATER,
      errorCode: "session-expired",
    };
    const indeterminate = {
      intentId: "intent-3",
      status: "indeterminate",
      observedAt: NOW,
      errorCode: SECRET,
    } as unknown as HnActionResult;
    expect(mapHnActionResult(verified)).toEqual({
      intentId: "intent-1",
      status: "verified",
      observedAt: NOW,
    });
    expect(mapHnActionResult(failed)).toEqual({
      intentId: "intent-2",
      status: "failed",
      observedAt: LATER,
      errorCode: "session-expired",
    });
    expect(mapHnActionResult(indeterminate)).toEqual({
      intentId: "intent-3",
      status: "indeterminate",
      observedAt: NOW,
      errorCode: "unknown-error",
    });
  });

  it("should normalize adapter evidence without exposing intent keys or raw result JSON", () => {
    const intent: HnActionIntent = {
      id: "intent-1",
      storyId: 1,
      action: "upvote",
      idempotencyKey: SECRET,
      status: "failed",
      result: {
        intentId: "intent-1",
        status: "failed",
        observedAt: LATER,
        errorCode: "session-expired",
        raw: SECRET,
      },
      resultSchemaVersion: 1,
      errorCode: "session-expired",
      createdAt: NOW,
      updatedAt: LATER,
    };
    const mapped = mapHnActionHistory(intent);
    expect(mapped).toEqual({
      id: "intent-1",
      storyId: 1,
      action: "upvote",
      status: "failed",
      createdAt: NOW,
      updatedAt: LATER,
      errorCode: "session-expired",
      outcome: {
        status: "failed",
        observedAt: LATER,
        errorCode: "session-expired",
      },
    });
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
    expect(JSON.stringify(mapped)).not.toContain("idempotencyKey");
    expect(JSON.stringify(mapped.outcome)).not.toContain("intentId");
  });

  it("should normalize reconciliation evidence and omit missing or malformed outcomes", () => {
    const reconciliation: HnActionIntent = {
      id: "intent-2",
      storyId: 1,
      action: "favorite",
      idempotencyKey: SECRET,
      status: "verified",
      result: { source: "hn-reconciliation", observedAt: LATER, raw: SECRET },
      resultSchemaVersion: 1,
      createdAt: NOW,
      updatedAt: LATER,
    };
    expect(mapHnActionHistory(reconciliation)).toEqual({
      id: "intent-2",
      storyId: 1,
      action: "favorite",
      status: "verified",
      createdAt: NOW,
      updatedAt: LATER,
      outcome: { status: "verified", observedAt: LATER },
    });

    const pending: HnActionIntent = {
      id: "intent-3",
      storyId: 1,
      action: "flag",
      idempotencyKey: SECRET,
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(mapHnActionHistory(pending)).not.toHaveProperty("outcome");
    expect(mapHnActionHistory(pending)).not.toHaveProperty("errorCode");

    const malformed = {
      ...pending,
      status: "failed",
      errorCode: SECRET,
      result: { intentId: "intent-3", status: "failed", observedAt: "invalid", raw: SECRET },
      resultSchemaVersion: 1,
    } as HnActionIntent;
    const mappedMalformed = mapHnActionHistory(malformed);
    expect(mappedMalformed.errorCode).toBe("unknown-error");
    expect(mappedMalformed).not.toHaveProperty("outcome");
    expect(JSON.stringify(mappedMalformed)).not.toContain(SECRET);
    expect(mapHnActionHistoryPage([reconciliation, pending])).toHaveLength(2);
  });
});

describe("operation summary and run-once DTOs", () => {
  it("should map every safe operation summary field explicitly", () => {
    expect(mapRecordActivityResult({ accepted: 2, profileWorkEnqueued: true })).toEqual({
      accepted: 2,
      profileWorkEnqueued: true,
    });
    expect(mapIngestionSummary({
      runId: "run-1",
      highestSeenItemId: 100,
      storiesUpserted: 8,
      nonStoriesSkipped: 2,
      jobsEnqueued: 3,
    })).toEqual({
      runId: "run-1",
      highestSeenItemId: 100,
      storiesUpserted: 8,
      nonStoriesSkipped: 2,
      jobsEnqueued: 3,
    });
    expect(mapAccountReconciliationSummary({
      runId: "run-2",
      observations: 4,
      skippedUnknownStories: 1,
      activityJobsEnqueued: 2,
      capabilities: [{ name: "upvoted", state: "available" }],
    })).toEqual({
      runId: "run-2",
      observations: 4,
      skippedUnknownStories: 1,
      activityJobsEnqueued: 2,
      capabilities: [{ name: "upvoted", state: "available" }],
    });
    expect(mapScorePendingSummary({
      completion: "complete",
      scored: 4,
      failed: 1,
      retryableFailed: 1,
      queued: 2,
      audits: 5,
    })).toEqual({
      completion: "complete",
      scored: 4,
      failed: 1,
      retryableFailed: 1,
      queued: 2,
      audits: 5,
    });
    expect(mapRecoverySummary({
      completion: "cancelled",
      scored: 0,
      failed: 0,
      retryableFailed: 0,
      queued: 0,
      audits: 0,
      rebuilt: false,
    })).toEqual({
      completion: "cancelled",
      scored: 0,
      failed: 0,
      retryableFailed: 0,
      queued: 0,
      audits: 0,
      rebuilt: false,
    });
  });

  it("should map idle, rejected, completed, failed, and lease-lost run-once results", () => {
    expect(mapRunOnceResult({ outcome: "idle" })).toEqual({ outcome: "idle" });
    expect(mapRunOnceResult({ outcome: "rejected", job: job() })).toEqual({
      outcome: "rejected",
      job: {
        id: "job-1",
        kind: "article.fetch-extract",
        status: "leased",
        runAfter: NOW,
        leaseExpiresAt: LATER,
        attempts: 1,
        maxAttempts: 3,
        lastErrorCode: "dependency-failure",
        createdAt: NOW,
        updatedAt: LATER,
      },
    });
    expect(mapRunOnceResult({ outcome: "completed", job: job() }).outcome).toBe("completed");
    const retrying = job({
      status: "queued",
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      lastErrorCode: "dependency-failure",
    });
    const failed = mapRunOnceResult({ outcome: "failed", job: retrying });
    expect(failed).toMatchObject({ outcome: "failed", job: { status: "queued" } });
    expect(failed).not.toHaveProperty("job.payload");
    const leaseLost = {
      outcome: "lease-lost",
      jobId: "job-1",
      kind: "article.fetch-extract",
      handlerOutcome: "failed",
      job: job(),
    } as RunOnceResult;
    expect(mapRunOnceResult(leaseLost)).toEqual({
      outcome: "lease-lost",
      jobId: "job-1",
      kind: "article.fetch-extract",
      handlerOutcome: "failed",
    });
  });
});
