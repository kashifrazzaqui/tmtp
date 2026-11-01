import { migrate, openDatabase } from "@tmtp/database";
import type { Database } from "@tmtp/database";
import { articleContentVersion } from "@tmtp/domain";
import type {
  ActivityEvent,
  Article,
  HnActionIntent,
  InterestProfile,
  LlmCallRecord,
  PreferenceRule,
  QueueEntry,
  Recommendation,
  Story,
} from "@tmtp/domain";
import { jobQueueMigrations } from "@tmtp/job-queue";
import { createReaderStore, readerStoreMigrations } from "../src/index.js";
import type { ReaderStore } from "../src/index.js";

export const BEFORE = "2026-01-01T00:00:00.000Z";
export const NOW = "2026-02-01T00:00:00.000Z";
export const LATER = "2026-03-01T00:00:00.000Z";
const databases: Database[] = [];
export function setup(withJobs = false): { database: Database; store: ReaderStore } {
  const database = openDatabase({ path: ":memory:", busyTimeoutMs: 1_000, wal: false });
  databases.push(database);
  migrate(database, withJobs ? [...readerStoreMigrations, ...jobQueueMigrations] : readerStoreMigrations);
  return { database, store: createReaderStore(database) };
}
export function cleanup(): void {
  for (const database of databases.splice(0)) if (database.isOpen()) database.close();
}
export function story(id: number, contentVersion = `story-v${id}`): Story {
  return {
    id, itemType: "story", url: `https://example.com/${id}`, canonicalUrl: `https://example.com/${id}`,
    title: `Story ${id}`, textHtml: id % 2 === 0 ? "<p>self</p>" : undefined,
    publishedAt: BEFORE, firstSeenAt: BEFORE, lastSeenAt: NOW, contentVersion,
    raw: { id, type: "story", title: `Story ${id}`, url: `https://example.com/${id}`, deleted: false, dead: false, raw: {}, rawSchemaVersion: 1 },
    rawSchemaVersion: 1, deleted: false, dead: false,
  };
}
export function profile(id = "profile-1"): InterestProfile {
  return {
    id, rulesVersion: `rules-${id}`, activityVersion: "1", sourceRules: [], sourceRulesSchemaVersion: 1,
    policy: {}, policySchemaVersion: 1, policyVersion: "ip1.test", builderVersion: "interests/1",
    interests: [], reason: "fixture", createdAt: NOW,
  };
}
export function recommendation(id: string, storyId: number, overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id, storyId, profileId: "profile-1", storyContentVersion: `story-v${storyId}`,
    articleContentVersion: "none", promptVersion: "prompt-1", model: "model-1", score: 0.8,
    rationale: "fixture", evidence: [], evidenceSchemaVersion: 1, createdAt: NOW, ...overrides,
  };
}
export function queueEntry(storyId: number, evaluationState: QueueEntry["evaluationState"] = "pending"): QueueEntry {
  return {
    storyId, state: "unread", evaluationState, visibilityState: "visible", kind: "match",
    ...(evaluationState === "scored" ? { recommendationId: `rec-${storyId}`, rankScore: 0.8, rankPosition: storyId } : {}),
    rankVersion: "rank-1", queuedAt: NOW, updatedAt: NOW,
  };
}
export function event(id: string, storyId = 1, receivedAt = NOW): ActivityEvent {
  return {
    id, clientEventId: `client-${id}`, storyId, kind: "open", value: { id }, valueSchemaVersion: 1,
    source: "embedded-reader", observationQuality: "full", occurredAt: receivedAt, receivedAt,
  };
}
export function article(storyId: number, contentHash = "hash-1"): Article {
  const base = {
    storyId, status: "ready" as const, sourceContentVersion: `story-v${storyId}`, contentVersion: "",
    title: `Article ${storyId}`, textContent: "text", contentHash, extractorVersion: "extractor-1", updatedAt: NOW,
  };
  return { ...base, contentVersion: articleContentVersion(base as Article) };
}
export function llmCall(id = "call-1"): LlmCallRecord {
  return {
    id, purpose: "recommendation", model: "model-1", status: "success", requestHash: `sha256:${"a".repeat(64)}`,
    inputTokens: 10, outputTokens: 5, latencyMs: 3, providerRequestId: "provider-1",
    requestPayload: { model: "model-1" }, requestPayloadSchemaVersion: 1,
    responsePayload: { choices: [] }, responsePayloadSchemaVersion: 1, createdAt: NOW,
  };
}
export function intent(id = "intent-1", storyId = 1): HnActionIntent {
  return {
    id, storyId, action: "upvote", idempotencyKey: `key-${id}`, status: "pending",
    createdAt: NOW, updatedAt: NOW,
  };
}
export function rule(id = "rule-1"): PreferenceRule {
  return {
    id, kind: "topic", effect: "include", value: "TypeScript", normalizedValue: "typescript",
    enabled: true, createdAt: BEFORE, updatedAt: BEFORE,
  };
}
