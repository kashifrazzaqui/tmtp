import { createFixedClock } from "@tmtp/clock";
import { migrate, openDatabase } from "@tmtp/database";
import type { IngestionRun, LlmCallRecord } from "@tmtp/domain";
import { createJobQueue, jobQueueMigrations } from "@tmtp/job-queue";
import { createReaderStore, readerStoreMigrations } from "@tmtp/reader-store";
import { expect, it } from "vitest";
import { createDiagnostics } from "../src/index.js";

const NOW = new Date("2026-03-02T00:00:00.000Z");
const TIME = NOW.toISOString();
function run(id: string, status: IngestionRun["status"]): IngestionRun {
  return { id, kind: "public", status, cursorStart: "secret-cursor", storiesUpserted: 1, nonStoriesSkipped: 0,
    startedAt: TIME, ...(status === "running" ? {} : { completedAt: TIME, errorCode: "fetch-failed", errorMessage: "sqlite-secret" }) };
}

it("should page real store and job records and derive safe operational errors", async () => {
  const database = openDatabase({ path: ":memory:", busyTimeoutMs: 100, wal: false });
  try {
    migrate(database, [...readerStoreMigrations, ...jobQueueMigrations]);
    const clock = createFixedClock(NOW);
    const store = createReaderStore(database);
    const jobs = createJobQueue({
      database, clock, codecs: [{ kind: "ingestion", currentVersion: 1, decode: (payload) => payload }],
      leaseMs: 1_000, maxAttempts: 3, backoffBaseMs: 1, backoffMaxMs: 2, batchSize: 100,
    });
    for (const id of ["run-a", "run-b"]) {
      store.sync.startRun(run(id, "running"));
      store.sync.finishRun(run(id, "failed"));
    }
    const call: LlmCallRecord = {
      id: "call-1", purpose: "recommendations", model: "model-1", status: "success",
      requestHash: `sha256:${"b".repeat(64)}`, latencyMs: 5, createdAt: TIME,
      requestPayload: { note: "sqlite-secret" }, requestPayloadSchemaVersion: 1,
    };
    store.llmCalls.insert(call);
    const enqueued = jobs.enqueue({ kind: "ingestion", payload: { hidden: true }, payloadSchemaVersion: 1, runAfter: TIME });
    const claimed = jobs.claim(["ingestion"]);
    if (claimed.status !== "leased") throw new Error("Expected a leased job.");
    jobs.fail(claimed.job.id, claimed.job.leaseToken!, { code: "fetch-failed", message: "sqlite-secret", retryable: false });
    const diagnostics = createDiagnostics({
      store, jobs, clock, sleep: async () => {}, secretValues: ["sqlite-secret"],
      debug: { enabled: true, streamIntervalMs: 250, includeLlmPayloads: false },
    });
    const first = diagnostics.debugSnapshot({ syncRuns: { limit: 1 }, jobs: { status: "failed" } });
    expect(first.syncRuns.value.items.map((item) => item.id)).toEqual(["run-b"]);
    expect(first.syncRuns.value.nextCursor).toBeTypeOf("string");
    expect(first.jobs.value.items).toHaveLength(1);
    expect(first.jobs.value.items[0]).not.toHaveProperty("lastError");
    expect(first.llmCalls.value.items[0]?.requestPayload).toEqual({ state: "hidden-by-policy", truncated: false });
    expect(first.queueCounts.value).toEqual({ pending: 0, scored: 0, failed: 0 });
    expect(first.recentErrors.value.items.map((item) => item.id)).toEqual([`job:${enqueued.job.id}`, "ingestion:run-b", "ingestion:run-a"]);
    expect(JSON.stringify(first)).not.toContain("sqlite-secret");
    const second = diagnostics.debugSnapshot({ syncRuns: { limit: 1, after: first.syncRuns.value.nextCursor } });
    expect(second.syncRuns.value.items.map((item) => item.id)).toEqual(["run-a"]);
    expect(second.syncRuns.value).not.toHaveProperty("nextCursor");
  } finally {
    database.close();
  }
});
