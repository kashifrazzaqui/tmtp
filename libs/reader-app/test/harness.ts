import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { migrate, openDatabase } from "@tmtp/database";
import type { Database } from "@tmtp/database";
import { articleContentVersion } from "@tmtp/domain";
import type {
  Article,
  HnActionIntent,
  InterestProfile,
  Job,
  PreferenceRule,
  QueueEntry,
  Recommendation,
  Story,
} from "@tmtp/domain";
import { createJobQueue, jobQueueMigrations } from "@tmtp/job-queue";
import type { JobQueue } from "@tmtp/job-queue";
import { createReaderStore, readerStoreMigrations } from "@tmtp/reader-store";
import type { ReaderStore } from "@tmtp/reader-store";
import { createReaderApp, readerAppJobCodecs } from "../src/index.js";
import type { ReaderApp, ReaderAppOptions } from "../src/index.js";

export const BEFORE = "2026-01-01T00:00:00.000Z";
export const NOW = "2026-02-01T00:00:00.000Z";
export const LATER = "2026-03-01T00:00:00.000Z";
const open: Database[] = [];
const paths: string[] = [];

export function story(id: number, contentVersion = `story-v${id}`, url: string | undefined = `https://example.com/${id}#fragment`): Story {
  return {
    id,
    itemType: "story",
    ...(url === undefined ? {} : { url }),
    title: `Story ${id}`,
    publishedAt: BEFORE,
    firstSeenAt: BEFORE,
    lastSeenAt: NOW,
    contentVersion,
    raw: { id, type: "story", title: `Story ${id}`, ...(url === undefined ? {} : { url }), deleted: false, dead: false, raw: {}, rawSchemaVersion: 1 },
    rawSchemaVersion: 1,
    deleted: false,
    dead: false,
  };
}

export function recommendation(id: string, storyId: number, contentVersion = `story-v${storyId}`): Recommendation {
  return {
    id, storyId, profileId: "profile-1", storyContentVersion: contentVersion, articleContentVersion: "none",
    promptVersion: "prompt-1", model: "model-1", score: 0.75, rationale: `Rationale ${id}`, evidence: [],
    evidenceSchemaVersion: 1, createdAt: NOW,
  };
}

export function queueEntry(
  storyId: number,
  rankVersion: string,
  evaluationState: QueueEntry["evaluationState"] = "pending",
  rankPosition?: number,
): QueueEntry {
  return {
    storyId,
    state: "unread",
    evaluationState,
    visibilityState: "visible",
    kind: "match",
    ...(evaluationState === "scored" ? { recommendationId: `rec-${storyId}`, rankScore: 0.75, rankPosition: rankPosition ?? storyId } : {}),
    rankVersion,
    queuedAt: NOW,
    updatedAt: NOW,
  };
}

export function readyArticle(storyId: number, sourceContentVersion = `story-v${storyId}`, extractorVersion = "article-reader-v1:test"): Article {
  const draft = {
    storyId,
    status: "ready" as const,
    sourceContentVersion,
    contentVersion: "",
    title: `Article ${storyId}`,
    textContent: "Readable text",
    sanitizedHtml: "<p>Readable text</p>",
    contentHash: `hash-${storyId}`,
    extractorVersion,
    updatedAt: NOW,
  };
  return { ...draft, contentVersion: articleContentVersion(draft as Article) };
}

export function failedArticle(storyId: number, sourceContentVersion = `story-v${storyId}`, extractorVersion = "article-reader-v1:test"): Article {
  const draft = {
    storyId,
    status: "failed" as const,
    sourceContentVersion,
    contentVersion: "",
    extractorVersion,
    updatedAt: NOW,
    errorCode: "timeout",
    errorMessage: "Article fetch timed out.",
  };
  return { ...draft, contentVersion: articleContentVersion(draft as Article) };
}

export function profile(id = "profile-1"): InterestProfile {
  return {
    id, rulesVersion: "rules-1", activityVersion: "0", sourceRules: [], sourceRulesSchemaVersion: 1,
    policy: {}, policySchemaVersion: 1, policyVersion: "policy-1", builderVersion: "builder-1",
    interests: [], reason: "test", createdAt: NOW,
  };
}

export function preference(id = "rule-1"): PreferenceRule {
  return {
    id, kind: "topic", effect: "include", value: "TypeScript", normalizedValue: "typescript",
    enabled: true, createdAt: BEFORE, updatedAt: BEFORE,
  };
}

export function intent(id: string, storyId: number, overrides: Partial<HnActionIntent> = {}): HnActionIntent {
  return {
    id, storyId, action: "upvote", idempotencyKey: `key-${id}`, status: "pending",
    createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

export function rawActivity(clientEventId: string, storyId = 1) {
  return { clientEventId, storyId, kind: "open" as const, occurredAt: BEFORE, source: "embedded-reader" as const };
}

export interface Harness {
  database: Database;
  path: string;
  store: ReaderStore;
  jobs: JobQueue;
  app: ReaderApp;
  options: ReaderAppOptions;
  articleRead: ReturnType<typeof vi.fn>;
  account: NonNullable<ReaderAppOptions["account"]>;
  accountPerform: ReturnType<typeof vi.fn>;
  personalization: ReaderAppOptions["personalization"];
  ingestion: ReaderAppOptions["ingestion"];
  setNow(value: string): void;
}

export function harness(withAccount = false, pageSize = 2, maxPageSize = 3, filePath?: string): Harness {
  const directory = filePath === undefined ? mkdtempSync(join(tmpdir(), "reader-app-")) : undefined;
  if (directory !== undefined) paths.push(directory);
  const path = filePath ?? join(directory!, "reader.sqlite");
  const database = openDatabase({ path, busyTimeoutMs: 1_000, wal: false });
  open.push(database);
  migrate(database, [...readerStoreMigrations, ...jobQueueMigrations]);
  const store = createReaderStore(database);
  store.profiles.insert(profile());
  let current = NOW;
  const now = () => new Date(current);
  const jobs = createJobQueue({
    database,
    clock: { now },
    codecs: readerAppJobCodecs,
    leaseMs: 1_000,
    maxAttempts: 3,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
    batchSize: 100,
  });
  const articleRead = vi.fn();
  const accountPerform = vi.fn();
  const account = {
    capabilities: vi.fn(async () => [
      { name: "upvoted", state: "available" },
      { name: "favorites", state: "available" },
      { name: "flagged", state: "unavailable", reason: "capability-disabled" },
      { name: "mutations", state: "unverified", reason: "capability-unverified" },
    ]),
    validateSession: vi.fn(async () => ({ username: "reader" })),
    readUpvoted: vi.fn(async () => ({ observations: [] })),
    readFavorites: vi.fn(async () => ({ observations: [] })),
    readFlagged: vi.fn(async () => ({ observations: [] })),
    performAction: accountPerform,
  } as unknown as NonNullable<ReaderAppOptions["account"]>;
  const personalization: ReaderAppOptions["personalization"] = {
    recordActivity: vi.fn(async () => ({ accepted: 0, profileWorkEnqueued: false })),
    rebuildProfile: vi.fn(async () => profile()),
    scorePending: vi.fn(async () => ({ completion: "complete", scored: 0, failed: 0, retryableFailed: 0, queued: 0, audits: 0 })),
    persistLlmAudits: vi.fn(async () => undefined),
    applyPreferenceChange: vi.fn(async () => profile()),
    recover: vi.fn(async () => ({ completion: "complete", scored: 1, failed: 2, retryableFailed: 3, queued: 4, audits: 5, rebuilt: true })),
    projectQueue: vi.fn(async () => ({ projected: 0, complete: true as const, profileId: "profile-1" })),
    runJob: vi.fn(async () => undefined),
  };
  const ingestion: ReaderAppOptions["ingestion"] = {
    collectPublic: vi.fn(async () => ({ runId: "run-1", highestSeenItemId: 10, storiesUpserted: 2, nonStoriesSkipped: 1, jobsEnqueued: 3 })),
    reconcileAccount: vi.fn(async () => ({ runId: "run-2", observations: 4, skippedUnknownStories: 1, activityJobsEnqueued: 2, capabilities: [] })),
  };
  let generated = 0;
  const options: ReaderAppOptions = {
    store,
    jobs,
    articles: { read: articleRead },
    ingestion,
    personalization,
    ...(withAccount ? { account } : {}),
    queuePageSize: pageSize,
    queueMaxPageSize: maxPageSize,
    now,
    createId: () => `intent-created-${++generated}`,
  };
  return {
    database,
    path,
    store,
    jobs,
    options,
    app: createReaderApp(options),
    articleRead,
    account,
    accountPerform,
    personalization,
    ingestion,
    setNow(value: string) { current = value; },
  };
}

export function cleanup(): void {
  for (const database of open.splice(0)) if (database.isOpen()) database.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
}

export function asLeased(job: Job): Job {
  return { ...job, status: "leased", leaseToken: "lease-test", leaseExpiresAt: LATER, attempts: 1 };
}
