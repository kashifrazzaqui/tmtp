import { afterEach, describe, expect, it, vi } from "vitest";
import { JobQueueError } from "@tmtp/job-queue";
import { noopLogger } from "@tmtp/logging";
import { ReaderAppError, readerAppJobCodecs } from "@tmtp/reader-app";
import type { ReaderApp } from "@tmtp/reader-app";
import type { Job } from "@tmtp/domain";
import type { HnAccount } from "@tmtp/hn-account";
import { createServiceScheduler } from "../src/schedules.js";
import { ensureStartupRecovery } from "../src/recovery.js";
import { recoverExpiredLeases } from "../src/storage.js";
import { WorkerRunner } from "../src/worker.js";
import { testGraph, NOW } from "./harness.js";
import type { TestGraph } from "./harness.js";

const active: TestGraph[] = [];
async function setup(overrides: Record<string, unknown> = {}): Promise<TestGraph> {
  const value = await testGraph(overrides);
  active.push(value);
  return value;
}

afterEach(async () => {
  while (active.length > 0) await active.pop()!.close();
  vi.restoreAllMocks();
});

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function appWithHandler(handler: (job: Job, signal?: AbortSignal) => Promise<void>): ReaderApp {
  return { runJob: handler } as ReaderApp;
}

function runner(local: TestGraph, app: ReaderApp, sleep = local.graph.sleep): WorkerRunner {
  return new WorkerRunner({
    jobs: local.graph.jobs,
    readerApp: app,
    sleep,
    leaseMs: local.config.jobs.lease_ms,
    pollIntervalMs: local.config.jobs.poll_interval_ms,
    logger: noopLogger,
    health: local.graph.health,
    integrations: local.graph.integrations,
    now: local.clock.now,
    operationSignal: local.graph.operations.signal,
  });
}

function enqueue(local: TestGraph, kind: string, payload: unknown): Job {
  return local.graph.jobs.enqueue({ kind, payload, payloadSchemaVersion: 1, runAfter: local.clock.now().toISOString() }).job;
}

const payloads: Record<string, unknown> = {
  "article.fetch-extract": { storyId: 1, storyContentVersion: "story-version" },
  "personalization.record-activity": { batch: [{
    clientEventId: "c".repeat(43), storyId: 1, kind: "open", occurredAt: "2026-01-02T03:04:05.000Z", source: "embedded-reader",
  }] },
  "ingestion.collect": {},
  "ingestion.reconcile-account": {},
  "personalization.profile-rebuild": { reason: "test", rulesVersion: "rules-1", activityVersion: "activity-1" },
  "personalization.score-pending": { profileId: "profile-1" },
  "personalization.queue-project": { profileId: "profile-1" },
  "personalization.recover": {},
};

describe("durable worker", () => {
  it("should claim exactly the ordered eight owner codecs and dispatch every kind", async () => {
    const local = await setup();
    const expected = [
      "article.fetch-extract",
      "personalization.record-activity",
      "ingestion.collect",
      "ingestion.reconcile-account",
      "personalization.profile-rebuild",
      "personalization.score-pending",
      "personalization.queue-project",
      "personalization.recover",
    ];
    expect(readerAppJobCodecs.map((codec) => codec.kind)).toEqual(expected);
    expect(expected).not.toContain("hn.public.collect");
    expect(expected).not.toContain("hn.account.reconcile");
    const handled: string[] = [];
    const worker = runner(local, appWithHandler(async (job) => { handled.push(job.kind); }));
    for (const kind of expected) enqueue(local, kind, payloads[kind]);
    for (let index = 0; index < expected.length; index += 1) {
      const result = await worker.runNext();
      expect(result.outcome).toBe("completed");
      if ("job" in result) expect(result.job.status).toBe("done");
    }
    expect(handled.sort()).toEqual([...expected].sort());
    expect(await worker.runNext()).toEqual({ outcome: "idle" });
    expect(worker.supportedKinds).toEqual(expected);
  });

  it("should renew with the claimed token before completion", async () => {
    const local = await setup();
    const handler = deferred();
    let leased!: Job;
    const sleeps: Array<{ delay: number; signal?: AbortSignal; resolve(): void }> = [];
    const sleep = (delay: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
      const entry = { delay, signal, resolve: () => resolve() };
      sleeps.push(entry);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const worker = runner(local, appWithHandler(async (job) => { leased = job; await handler.promise; }), sleep);
    const renew = vi.spyOn(local.graph.jobs, "renew");
    const complete = vi.spyOn(local.graph.jobs, "complete");
    enqueue(local, "personalization.recover", {});
    const pending = worker.runNext();
    await vi.waitFor(() => expect(sleeps.length).toBe(1));
    expect(sleeps[0]!.delay).toBe(Math.floor(local.config.jobs.lease_ms / 3));
    sleeps[0]!.resolve();
    await vi.waitFor(() => expect(renew).toHaveBeenCalledWith(leased.id, leased.leaseToken));
    handler.resolve();
    expect((await pending).outcome).toBe("completed");
    expect(complete).toHaveBeenCalledWith(leased.id, leased.leaseToken);
    expect(renew.mock.calls[0]![1]).toBe(complete.mock.calls[0]![1]);
  });

  it("should return fresh queued state after retryable failure and failed state after terminal failure", async () => {
    const local = await setup();
    enqueue(local, "personalization.recover", {});
    const retryable = runner(local, appWithHandler(async () => {
      throw new ReaderAppError("internal-failure", { operation: "run-job", retryable: true });
    }));
    const first = await retryable.runNext();
    expect(first).toMatchObject({ outcome: "failed", job: { status: "queued", attempts: 1 } });

    const terminalLocal = await setup();
    enqueue(terminalLocal, "personalization.recover", {});
    const terminal = runner(terminalLocal, appWithHandler(async () => {
      throw new ReaderAppError("invalid-job", { operation: "run-job", retryable: false });
    }));
    const second = await terminal.runNext();
    expect(second).toMatchObject({ outcome: "failed", job: { status: "failed", attempts: 1, lastErrorCode: "invalid-job" } });
  });

  it("should distinguish committed poison rejection without invoking a handler", async () => {
    const local = await setup();
    const timestamp = NOW.toISOString();
    local.graph.database.execute(`INSERT INTO jobs (
      id, kind, payload, payload_schema_version, status, run_after, attempts, max_attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', ?, 0, 5, ?, ?)`, [
      "poison-job", "ingestion.collect", JSON.stringify({ unexpected: true }), 1, timestamp, timestamp, timestamp,
    ]);
    const handler = vi.fn(async () => undefined);
    const worker = runner(local, appWithHandler(handler));
    const result = await worker.runNext();
    expect(result).toMatchObject({ outcome: "rejected", job: { id: "poison-job", status: "failed", attempts: 0, lastErrorCode: "invalid-payload" } });
    expect(handler).not.toHaveBeenCalled();
    expect(await worker.runNext()).toEqual({ outcome: "idle" });
  });

  it("should report expected finalization lease loss without a newer snapshot", async () => {
    const local = await setup();
    enqueue(local, "personalization.recover", {});
    vi.spyOn(local.graph.jobs, "complete").mockImplementation(() => {
      throw new JobQueueError("lease-lost");
    });
    const worker = runner(local, appWithHandler(async () => undefined));
    const result = await worker.runNext();
    expect(result).toMatchObject({ outcome: "lease-lost", kind: "personalization.recover", handlerOutcome: "completed" });
    expect(result).not.toHaveProperty("job");
  });

  it("should recover more than one batch before allowing claims", async () => {
    const local = await setup({ jobs: { batch_size: 2, backoff_base_ms: 0, backoff_max_ms: 0 } });
    for (let index = 0; index < 3; index += 1) enqueue(local, "personalization.recover", {});
    for (let index = 0; index < 3; index += 1) expect(local.graph.jobs.claim(["personalization.recover"]).status).toBe("leased");
    local.clock.advance(local.config.jobs.lease_ms + 1);
    const recover = vi.spyOn(local.graph.jobs, "recoverExpired");
    recoverExpiredLeases(local.graph.jobs, local.config.jobs.batch_size);
    expect(recover.mock.results.map((result) => result.value)).toEqual([3, 0]);
    expect(local.graph.jobs.list({ limit: 2 }).every((job) => job.status === "queued")).toBe(true);
  });

  it("should mark an expired final attempt exhausted without blocking unrelated work", async () => {
    const local = await setup({ jobs: { max_attempts: 1, backoff_base_ms: 0, backoff_max_ms: 0 } });
    const exhausted = enqueue(local, "personalization.recover", {});
    const unrelated = enqueue(local, "ingestion.collect", {});
    expect(local.graph.jobs.claim(["personalization.recover"]).status).toBe("leased");
    local.clock.advance(local.config.jobs.lease_ms + 1);
    recoverExpiredLeases(local.graph.jobs, local.config.jobs.batch_size);
    expect(local.graph.jobs.get(exhausted.id)).toMatchObject({ status: "failed", lastErrorCode: "attempts-exhausted" });
    expect(local.graph.jobs.get(unrelated.id)).toMatchObject({ status: "queued" });
  });

  it("should cancel idle polling and stop admitting run-once work", async () => {
    const local = await setup();
    const worker = runner(local, appWithHandler(async () => undefined));
    worker.start();
    await vi.waitFor(() => expect(local.graph.health.readiness().workers.ready).toBe(true));
    worker.stopClaims();
    await worker.drain();
    await expect(worker.runNext()).rejects.toMatchObject({ code: "workers-stopped", statusCode: 503 });
  });
});

describe("enqueue-only schedules and startup recovery", () => {
  it("should ensure durable jobs without executing external work", async () => {
    const local = await setup();
    const ingest = vi.spyOn(local.graph.readerApp, "runIngestion");
    const personalize = vi.spyOn(local.graph.readerApp, "runPersonalization");
    await ensureStartupRecovery(local.graph);
    await ensureStartupRecovery(local.graph);
    expect(local.graph.jobs.list({ limit: 20 }).map((job) => job.kind).sort()).toEqual([
      "ingestion.collect", "personalization.recover",
    ]);
    expect(ingest).not.toHaveBeenCalled();
    expect(personalize).not.toHaveBeenCalled();
  });

  it("should register two named cron tasks that only enqueue", async () => {
    const local = await setup();
    const definitions: Array<{ name: string; expression: string; trigger: () => Promise<void> }> = [];
    const scheduler = createServiceScheduler(local.graph, (definition) => {
      definitions.push(definition);
      return { start: vi.fn(), stop: vi.fn() };
    });
    scheduler.start();
    expect(local.graph.jobs.list({ limit: 20 })).toEqual([]);
    expect(definitions.map(({ name, expression }) => ({ name, expression }))).toEqual([
      { name: "ingestion.cron", expression: "*/15 * * * *" },
      { name: "personalization.cron", expression: "7,37 * * * *" },
    ]);
    const ingest = vi.spyOn(local.graph.readerApp, "runIngestion");
    const personalize = vi.spyOn(local.graph.readerApp, "runPersonalization");
    await definitions[0]!.trigger();
    await definitions[0]!.trigger();
    await definitions[1]!.trigger();
    expect(local.graph.jobs.list({ limit: 20 }).map((job) => job.kind).sort()).toEqual([
      "ingestion.collect", "personalization.recover",
    ]);
    expect(ingest).not.toHaveBeenCalled();
    expect(personalize).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it("should recover and enqueue account reconciliation without calling the account adapter", async () => {
    const account: HnAccount = {
      capabilities: vi.fn(async () => []),
      validateSession: vi.fn(async () => ({ username: "reader" })),
      readUpvoted: vi.fn(async () => ({ observations: [] })),
      readFavorites: vi.fn(async () => ({ observations: [] })),
      readFlagged: vi.fn(async () => ({ observations: [] })),
      performAction: vi.fn(),
    };
    const local = await testGraph({}, { account, accountCookie: "local-cookie" });
    active.push(local);
    await ensureStartupRecovery(local.graph);
    expect(local.graph.jobs.list({ limit: 20 }).map((job) => job.kind).sort()).toEqual([
      "ingestion.collect", "ingestion.reconcile-account", "personalization.recover",
    ]);
    expect(account.validateSession).not.toHaveBeenCalled();
    expect(account.performAction).not.toHaveBeenCalled();
  });
});
