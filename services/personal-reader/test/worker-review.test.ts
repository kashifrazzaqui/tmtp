import { afterEach, describe, expect, it, vi } from "vitest";
import { articleContentVersion } from "@tmtp/domain";
import type { Article, Job } from "@tmtp/domain";
import type { HnAccount } from "@tmtp/hn-account";
import { noopLogger } from "@tmtp/logging";
import { ReaderAppError } from "@tmtp/reader-app";
import type { ReaderApp } from "@tmtp/reader-app";
import type { ReaderStore } from "@tmtp/reader-store";
import { httpHarness, login, mutationHeaders, NOW, testGraph } from "./harness.js";
import type { TestGraph } from "./harness.js";
import { readyArticleFixture, seedStory } from "./fixtures.js";
import { WorkerRunner } from "../src/worker.js";
import type { IntegrationName } from "../src/health.js";
import { observeLlm } from "../src/health.js";

const active: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (active.length > 0) await active.pop()!.close();
  vi.restoreAllMocks();
});

async function setup(accountConfigured = false): Promise<TestGraph> {
  const account: HnAccount = {
    capabilities: vi.fn(async () => []),
    validateSession: vi.fn(async () => ({ username: "reader" })),
    readUpvoted: vi.fn(async () => ({ observations: [] })),
    readFavorites: vi.fn(async () => ({ observations: [] })),
    readFlagged: vi.fn(async () => ({ observations: [] })),
    performAction: vi.fn(),
  };
  const local = await testGraph({}, accountConfigured ? { account, accountCookie: "local-cookie" } : { account });
  active.push(local);
  return local;
}

function appWithHandler(handler: (job: Job, signal?: AbortSignal) => Promise<void>): ReaderApp {
  return { runJob: handler } as ReaderApp;
}

function runner(
  local: TestGraph,
  app: ReaderApp,
  options: { onFatal?: () => void; store?: Readonly<ReaderStore> } = {},
): WorkerRunner {
  return new WorkerRunner({
    jobs: local.graph.jobs,
    readerApp: app,
    sleep: local.graph.sleep,
    leaseMs: local.config.jobs.lease_ms,
    pollIntervalMs: local.config.jobs.poll_interval_ms,
    logger: noopLogger,
    health: local.graph.health,
    integrations: local.graph.integrations,
    now: local.clock.now,
    operationSignal: local.graph.operations.signal,
    store: options.store ?? local.graph.store,
    ...(options.onFatal === undefined ? {} : { onFatal: options.onFatal }),
  });
}

function enqueue(local: TestGraph, kind: string, payload: unknown = {}): Job {
  return local.graph.jobs.enqueue({
    kind,
    payload,
    payloadSchemaVersion: 1,
    runAfter: local.clock.now().toISOString(),
  }).job;
}

function integration(local: TestGraph, name: IntegrationName) {
  return local.graph.integrations.input(local.graph.health.readiness())[name];
}

describe("reviewed worker cancellation and failure containment", () => {
  it("should apply polling fatal semantics to a manual infrastructure failure", async () => {
    const local = await setup();
    local.graph.health.workersReady();
    const failure = new Error("claim-failed");
    vi.spyOn(local.graph.jobs, "claim").mockImplementation(() => { throw failure; });
    const onFatal = vi.fn();
    const worker = runner(local, appWithHandler(async () => undefined), { onFatal });

    await expect(worker.runNext()).rejects.toBe(failure);

    expect(onFatal).toHaveBeenCalledOnce();
    expect(local.graph.health.readiness().workers).toEqual({ ready: false, reason: "worker-failed" });
    await expect(worker.runNext()).rejects.toMatchObject({ code: "workers-stopped" });
    expect(onFatal).toHaveBeenCalledOnce();
  });

  it("should keep an expected handler failure nonfatal", async () => {
    const local = await setup();
    local.graph.health.workersReady();
    enqueue(local, "personalization.recover");
    const onFatal = vi.fn();
    const worker = runner(local, appWithHandler(async () => {
      throw new ReaderAppError("internal-failure", { operation: "run-job", retryable: true });
    }), { onFatal });

    await expect(worker.runNext()).resolves.toMatchObject({ outcome: "failed", job: { status: "queued" } });

    expect(onFatal).not.toHaveBeenCalled();
    expect(local.graph.health.readiness().workers).toEqual({ ready: true, reason: "ok" });
    await expect(worker.runNext()).resolves.toEqual({ outcome: "idle" });
  });

  it("should cancel the leased handler through the caller signal", async () => {
    const local = await setup();
    enqueue(local, "personalization.recover");
    const controller = new AbortController();
    const onFatal = vi.fn();
    let handlerSignal: AbortSignal | undefined;
    const worker = runner(local, appWithHandler(async (_job, signal) => {
      handlerSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new ReaderAppError("cancelled", {
          operation: "run-job", retryable: true,
        })), { once: true });
      });
    }), { onFatal });

    const result = worker.runNext(controller.signal);
    await vi.waitFor(() => expect(handlerSignal).toBeDefined());
    controller.abort();

    await expect(result).resolves.toMatchObject({ outcome: "failed", job: { status: "queued" } });
    expect(handlerSignal?.aborted).toBe(true);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("should pass the HTTP request signal into run-once", async () => {
    const local = await httpHarness();
    active.push(local);
    const session = await login(local.origin);
    enqueue(local, "personalization.recover");
    const runNext = vi.spyOn(local.worker, "runNext");

    const response = await fetch(`${local.origin}/api/v1/operations/jobs/run-once`, {
      method: "POST",
      headers: mutationHeaders(session, local.origin),
    });

    expect(response.status).toBe(200);
    expect(runNext).toHaveBeenCalledOnce();
    expect(runNext.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });
});

describe("reviewed worker integration observations", () => {
  it.each([
    ["ingestion.collect", "hnPublic"],
    ["ingestion.reconcile-account", "hnAccount"],
  ] as const)("should mark %s available after a successful handler outcome", async (kind, name) => {
    const local = await setup(true);
    enqueue(local, kind, kind === "personalization.score-pending" ? { profileId: "profile-1" } : {});
    const worker = runner(local, appWithHandler(async () => undefined));

    await expect(worker.runNext()).resolves.toMatchObject({ outcome: "completed" });
    expect(integration(local, name)).toMatchObject({ availability: "available", reason: "ok" });
  });

  it.each([
    ["ingestion.collect", "hnPublic"],
    ["ingestion.reconcile-account", "hnAccount"],
  ] as const)("should degrade %s after a failed handler outcome", async (kind, name) => {
    const local = await setup(true);
    enqueue(local, kind, kind === "personalization.score-pending" ? { profileId: "profile-1" } : {});
    const worker = runner(local, appWithHandler(async () => {
      throw new ReaderAppError("internal-failure", { operation: "run-job", retryable: true });
    }));

    await expect(worker.runNext()).resolves.toMatchObject({ outcome: "failed" });
    expect(integration(local, name)).toMatchObject({ availability: "degraded" });
  });

  it("should not infer LLM health from a personalization job that made no LLM call", async () => {
    const local = await setup();
    enqueue(local, "personalization.recover");
    const worker = runner(local, appWithHandler(async () => undefined));
    await expect(worker.runNext()).resolves.toMatchObject({ outcome: "completed" });
    expect(integration(local, "llm")).toMatchObject({ availability: "unknown", reason: "not-checked" });
  });

  it("should observe actual LLM success and failure at the port boundary", async () => {
    const local = await setup();
    const request = {
      purpose: "recommendation" as const, model: "model-1", instructions: "test", input: {},
      outputSchema: { type: "object" }, parseOutput: (value: unknown) => value, capturePayload: false,
    };
    vi.spyOn(local.graph.llm, "generate").mockResolvedValue({ value: { ok: true }, attempts: [] });
    const wrapped = observeLlm(local.graph.llm, local.graph.integrations, local.clock);
    await wrapped.generate(request);
    expect(integration(local, "llm")).toMatchObject({ availability: "available", reason: "ok" });
    vi.spyOn(local.graph.llm, "generate").mockRejectedValue({ category: "provider", code: "provider-error" });
    await expect(wrapped.generate(request)).rejects.toMatchObject({ code: "provider-error" });
    expect(integration(local, "llm")).toMatchObject({ availability: "degraded" });
  });

  it("should leave article health unobserved when a nonthrowing job persists no outcome", async () => {
    const local = await setup();
    const story = seedStory(local.graph, 1);
    enqueue(local, "article.fetch-extract", {
      storyId: story.id,
      storyContentVersion: story.contentVersion,
    });
    const worker = runner(local, appWithHandler(async () => undefined));

    await expect(worker.runNext()).resolves.toMatchObject({ outcome: "completed" });
    expect(integration(local, "article")).toMatchObject({ availability: "unknown", reason: "not-checked" });
  });

  it("should observe a persisted ready article outcome", async () => {
    const local = await setup();
    const story = seedStory(local.graph, 1);
    enqueue(local, "article.fetch-extract", {
      storyId: story.id,
      storyContentVersion: story.contentVersion,
    });
    const worker = runner(local, appWithHandler(async () => {
      local.graph.store.articles.upsert(readyArticleFixture(story));
    }));

    await expect(worker.runNext()).resolves.toMatchObject({ outcome: "completed" });
    expect(integration(local, "article")).toMatchObject({ availability: "available", reason: "ok" });
  });

  it("should observe a persisted expected article failure", async () => {
    const local = await setup();
    const story = seedStory(local.graph, 1);
    enqueue(local, "article.fetch-extract", {
      storyId: story.id,
      storyContentVersion: story.contentVersion,
    });
    const worker = runner(local, appWithHandler(async () => {
      const failed = {
        storyId: story.id,
        status: "failed" as const,
        sourceContentVersion: story.contentVersion,
        contentVersion: "pending",
        extractorVersion: "review-reader",
        updatedAt: NOW.toISOString(),
        errorCode: "extraction-failed",
      };
      local.graph.store.articles.upsert({
        ...failed,
        contentVersion: articleContentVersion(failed as Article),
      });
      throw new ReaderAppError("article-attempt-failed", {
        operation: "run-job",
        retryable: false,
        dependencyCode: "extraction-failed",
      });
    }));

    await expect(worker.runNext()).resolves.toMatchObject({ outcome: "failed" });
    expect(integration(local, "article")).toMatchObject({ availability: "degraded", reason: "extraction-failed" });
  });
});
