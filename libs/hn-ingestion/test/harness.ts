import { createFixedClock } from "@tmtp/clock";
import type { FixedClock } from "@tmtp/clock";
import { openDatabase, migrate } from "@tmtp/database";
import type { Database } from "@tmtp/database";
import type { HnItem, InterestProfile, Story } from "@tmtp/domain";
import { normalizeStory } from "@tmtp/hn-public-api";
import { createJobQueue, jobQueueMigrations } from "@tmtp/job-queue";
import type { JobQueue } from "@tmtp/job-queue";
import { createReaderStore, readerStoreMigrations } from "@tmtp/reader-store";
import type { ReaderStore } from "@tmtp/reader-store";
import { vi } from "vitest";
import { createHnIngestion, hnIngestionJobCodecs } from "../src/index.js";
import type { HnIngestionOptions } from "../src/index.js";

export const NOW = new Date("2026-07-01T00:00:00.000Z");
export const TIME = NOW.toISOString();
export const OLD = "2026-01-01T00:00:00.000Z";
export function item(id: number, changes: Partial<HnItem> = {}): HnItem {
  return { id, type: "story", author: "alice", time: 1_767_225_600, title: `Story ${id}`, url: `https://example.com/${id}`,
    score: 10, descendants: 2, deleted: false, dead: false, raw: { id, type: "story" }, rawSchemaVersion: 1, ...changes };
}
export function story(id: number, observedAt = TIME, changes: Partial<HnItem> = {}): Story {
  const value = normalizeStory({ item: item(id, changes), observedAt });
  if (value === undefined) throw new Error("Expected a normalized story.");
  return value;
}
export function profile(id = "profile-1"): InterestProfile {
  return { id, rulesVersion: "rules-1", activityVersion: "0", sourceRules: [{ id: "rule-1", kind: "domain", effect: "exclude",
    value: "example.com", normalizedValue: "example.com", enabled: true, createdAt: TIME, updatedAt: TIME }], sourceRulesSchemaVersion: 1,
    policy: { decayHalfLifeDays: 30, maxInferredTopics: 10, maxActivityEvents: 100 }, policySchemaVersion: 1,
    policyVersion: "policy-1", builderVersion: "interests/1", interests: [], reason: "test", createdAt: TIME };
}
export function apiFixture() {
  return { maxItemId: vi.fn(async () => 1), item: vi.fn(async (_id: number) => undefined), feed: vi.fn(async () => [] as number[]) };
}
export interface Harness {
  database: Database; store: ReaderStore; jobs: JobQueue; clock: FixedClock; api: ReturnType<typeof apiFixture>;
  close: () => void; create: (changes?: Partial<HnIngestionOptions>) => ReturnType<typeof createHnIngestion>;
}
export function setup(path = ":memory:", api = apiFixture(), clock = createFixedClock(NOW)): Harness {
  const database = openDatabase({ path, busyTimeoutMs: 100, wal: false });
  migrate(database, [...readerStoreMigrations, ...jobQueueMigrations]);
  const store = createReaderStore(database);
  const passthrough = ["article.fetch-extract", "personalization.score-pending", "personalization.recover", "personalization.record-activity"].map((kind) => ({
    kind, currentVersion: 1, decode: (payload: unknown) => payload,
  }));
  const jobs = createJobQueue({ database, clock, codecs: [...hnIngestionJobCodecs, ...passthrough], leaseMs: 1_000,
    maxAttempts: 3, backoffBaseMs: 1, backoffMaxMs: 2, batchSize: 100 });
  return {
    database, store, jobs, clock, api, close: () => database.close(),
    create: (changes = {}) => createHnIngestion({ api, store, jobs, clock, bootstrapRankVersion: () => "bootstrap-rank",
      feeds: [], initialLookbackItems: 0, maxItemsPerRun: 2, refreshBatchSize: 2, refreshAfterHours: 24, ...changes }),
  };
}
