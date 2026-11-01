import { createFixedClock } from "@tmtp/clock";
import type { FixedClock } from "@tmtp/clock";
import { migrate, openDatabase } from "@tmtp/database";
import type { Database } from "@tmtp/database";
import { articleContentVersion } from "@tmtp/domain";
import type { Article, Job, PreferenceRule, QueueEntry, Story } from "@tmtp/domain";
import { createJobQueue, jobQueueMigrations } from "@tmtp/job-queue";
import type { JobQueue } from "@tmtp/job-queue";
import type { LlmCallAudit, LlmError, LlmPort, LlmRequest, LlmResult } from "@tmtp/llm-interface";
import { QUEUE_BOOTSTRAP_RANK_VERSION } from "@tmtp/queue";
import { createReaderStore, readerStoreMigrations } from "@tmtp/reader-store";
import type { ReaderStore } from "@tmtp/reader-store";
import type { RawActivity } from "@tmtp/activity";
import { createPersonalization, personalizationJobCodecs } from "../src/index.js";
import type { Personalization, PersonalizationJobKind, PersonalizationJobPayload, PersonalizationOptions } from "../src/index.js";

export const NOW = "2026-06-01T00:00:00.000Z";
export const BEFORE = "2026-01-01T00:00:00.000Z";
const databases: Database[] = [];

export type Handler = (request: LlmRequest<unknown>, index: number) => Promise<LlmResult<unknown>>;
export interface ScriptedLlm { llm: LlmPort; requests: LlmRequest<unknown>[]; readonly calls: number; }

export function judgments(request: LlmRequest<unknown>, score = 0.75): unknown {
  const stories = (request.input as { stories: Array<{ storyId: number }> }).stories;
  return request.parseOutput({
    judgments: stories.map(({ storyId }) => ({
      storyId,
      score,
      rationale: `Rationale ${storyId}`,
      evidence: [{ kind: "story", label: "Story evidence", sourceId: `story:${storyId}` }],
    })),
  });
}

export function audit(callId: string, status: LlmCallAudit["status"] = "success", changes: Partial<LlmCallAudit> = {}): LlmCallAudit {
  const value: LlmCallAudit = {
    callId,
    purpose: "recommendation",
    model: "model-1",
    requestHash: `sha256:${"a".repeat(64)}`,
    status,
    usage: { inputTokens: 10, outputTokens: 5, latencyMs: 3 },
    ...changes,
  };
  if (status !== "success" && value.errorCode === undefined) value.errorCode = "provider-failed";
  return value;
}

export const defaultHandler: Handler = async (request, index) => ({ value: judgments(request), attempts: [audit(`call-${index}`)] });
export function scripted(handler: Handler = defaultHandler, onCall?: () => void): ScriptedLlm {
  const requests: LlmRequest<unknown>[] = [];
  let calls = 0;
  return {
    requests,
    get calls() { return calls; },
    llm: {
      generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
        requests.push(request as LlmRequest<unknown>);
        onCall?.();
        return handler(request as LlmRequest<unknown>, calls++) as Promise<LlmResult<T>>;
      },
    },
  };
}

export function llmError(category: LlmError["category"], code: string, retryable: boolean, attempts: LlmCallAudit[]): LlmError {
  return Object.assign(new Error("secret provider body"), { category, code, retryable, attempts });
}

export function story(id: number, changes: Partial<Story> = {}): Story {
  return {
    id,
    itemType: "story",
    url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
    title: `Story ${id}`,
    textHtml: "<p>story text</p>",
    publishedAt: BEFORE,
    firstSeenAt: BEFORE,
    lastSeenAt: NOW,
    contentVersion: `story-v${id}`,
    raw: { id, type: "story", title: `Story ${id}`, url: `https://example.com/${id}`, deleted: false, dead: false, raw: {}, rawSchemaVersion: 1 },
    rawSchemaVersion: 1,
    deleted: false,
    dead: false,
    ...changes,
  };
}

export function article(storyId: number, changes: Partial<Article> = {}): Article {
  const value = {
    storyId,
    status: "ready" as const,
    sourceContentVersion: `story-v${storyId}`,
    contentVersion: "pending",
    title: `Article ${storyId}`,
    textContent: "article body",
    contentHash: `hash-${storyId}`,
    extractorVersion: "extractor-1",
    updatedAt: NOW,
    ...changes,
  } as Article;
  value.contentVersion = articleContentVersion(value);
  return value;
}

export function pendingEntry(storyId: number): QueueEntry {
  return {
    storyId,
    state: "unread",
    evaluationState: "pending",
    visibilityState: "visible",
    kind: "match",
    rankVersion: QUEUE_BOOTSTRAP_RANK_VERSION,
    queuedAt: NOW,
    updatedAt: NOW,
  };
}

export function seedStories(store: ReaderStore, values: Story[]): void {
  store.stories.upsertBatch(values);
  store.queue.insertPendingIfMissing(values.map((value) => pendingEntry(value.id)));
}

export function rule(id = "rule-1", effect: PreferenceRule["effect"] = "exclude", value = "TypeScript"): PreferenceRule {
  return {
    id,
    kind: "topic",
    effect,
    value,
    normalizedValue: value.toLowerCase(),
    enabled: true,
    createdAt: BEFORE,
    updatedAt: BEFORE,
  };
}

export const clientId = (value: number): string => String(value).padStart(43, "0");
export function rawActivity(value: number, storyId = 1, kind: RawActivity["kind"] = "open", occurredAt = NOW): RawActivity {
  return { clientEventId: clientId(value), storyId, kind, source: "embedded-reader", occurredAt } as RawActivity;
}

export function makeJob(kind: PersonalizationJobKind, payload: PersonalizationJobPayload, changes: Partial<Job> = {}): Job {
  return {
    id: "job-test",
    kind,
    payload,
    payloadSchemaVersion: 1,
    status: "queued",
    runAfter: NOW,
    attempts: 1,
    maxAttempts: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...changes,
  };
}

export interface Journal { transactions: number; depth: number; maximumDepth: number; llmCallsInsideTransaction: number; }
export interface Harness {
  database: Database;
  store: ReaderStore;
  jobs: JobQueue;
  clock: FixedClock;
  scripted: ScriptedLlm;
  journal: Journal;
  options: PersonalizationOptions;
  create(changes?: Partial<PersonalizationOptions>): Personalization;
}

export function setup(path = ":memory:", handler: Handler = defaultHandler): Harness {
  const database = openDatabase({ path, busyTimeoutMs: 1_000, wal: false });
  databases.push(database);
  migrate(database, [...readerStoreMigrations, ...jobQueueMigrations]);
  const store = createReaderStore(database);
  const journal: Journal = { transactions: 0, depth: 0, maximumDepth: 0, llmCallsInsideTransaction: 0 };
  const transaction = store.transaction;
  store.transaction = function <T>(work: () => T): T {
    journal.transactions += 1;
    journal.depth += 1;
    journal.maximumDepth = Math.max(journal.maximumDepth, journal.depth);
    try { return transaction(work); } finally { journal.depth -= 1; }
  };
  const clock = createFixedClock(new Date(NOW));
  const jobs = createJobQueue({
    database,
    clock,
    codecs: personalizationJobCodecs,
    leaseMs: 1_000,
    maxAttempts: 5,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
    batchSize: 100,
  });
  const fake = scripted(handler, () => { if (journal.depth > 0) journal.llmCallsInsideTransaction += 1; });
  const options: PersonalizationOptions = {
    store,
    jobs,
    llm: fake.llm,
    model: "model-1",
    clock,
    activityPolicy: { idleTimeoutMs: 60_000, minDwellMs: 1_000, maxSessionGapMs: 300_000 },
    interestPolicy: { decayHalfLifeDays: 30, maxInferredTopics: 10, maxActivityEvents: 100 },
    recommendationPolicy: { batchSize: 10, maxStoriesPerRun: 50, maxPromptChars: 100_000, explorationRatio: 0.1, capturePayloads: false },
    activityBatchSize: 500,
    queueSyncBatchSize: 2,
  };
  return {
    database,
    store,
    jobs,
    clock,
    scripted: fake,
    journal,
    options,
    create(changes = {}) { return createPersonalization({ ...options, ...changes }); },
  };
}

export function cleanup(): void {
  for (const database of databases.splice(0)) if (database.isOpen()) database.close();
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
