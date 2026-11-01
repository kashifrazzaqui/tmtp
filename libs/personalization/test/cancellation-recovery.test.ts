import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmResult } from "@tmtp/llm-interface";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersonalizationJobEnqueue } from "../src/index.js";
import {
  article,
  audit,
  cleanup,
  deferred,
  judgments,
  llmError,
  makeJob,
  NOW,
  rawActivity,
  rule,
  seedStories,
  setup,
  story,
} from "./harness.js";

afterEach(cleanup);

describe("cancellation and pipeline serialization", () => {
  it("should commit partial cancelled work before runJob reports cancellation", async () => {
    const controller = new AbortController();
    const h = setup(":memory:", async (request): Promise<LlmResult<unknown>> => {
      controller.abort();
      return { value: judgments(request), attempts: [audit("partial")] };
    });
    seedStories(h.store, [story(1), story(2)]);
    const p = h.create({ recommendationPolicy: { ...h.options.recommendationPolicy, batchSize: 1 } });
    const profile = await p.rebuildProfile("initial");
    await expect(p.runJob(makeJob("personalization.score-pending", { profileId: profile.id }), controller.signal))
      .rejects.toMatchObject({ code: "cancelled", retryable: true, jobId: "job-test" });
    expect(h.scripted.calls).toBe(1);
    expect(h.store.llmCalls.recent(undefined, 10).map((call) => call.id)).toEqual(["partial"]);
    expect(h.store.queue.byStoryId(1)).toMatchObject({ evaluationState: "scored" });
    expect(h.store.queue.byStoryId(2)).toMatchObject({ evaluationState: "pending" });
    expect(h.store.queue.byStoryId(2)?.lastError).toBeUndefined();
    expect(h.journal.llmCallsInsideTransaction).toBe(0);
  });

  it("should abort lock waiters remove listeners and keep standalone audits independent", async () => {
    const pending = deferred<LlmResult<unknown>>();
    const h = setup(":memory:", async () => pending.promise);
    seedStories(h.store, [story(1)]);
    const p = h.create();
    const first = p.scorePending();
    await vi.waitFor(() => { expect(h.scripted.calls).toBe(1); });
    await p.persistLlmAudits([audit("probe", "success", { purpose: "connection-check" })]);
    expect(h.store.llmCalls.byId("probe")).toBeDefined();

    const controller = new AbortController();
    const signal = controller.signal;
    let listeners = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    Object.defineProperty(signal, "addEventListener", {
      value: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        if (type === "abort") listeners += 1;
        add(type, listener, options);
      },
    });
    Object.defineProperty(signal, "removeEventListener", {
      value: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
        if (type === "abort") listeners -= 1;
        remove(type, listener, options);
      },
    });
    const waiting = p.projectQueue(signal);
    expect(listeners).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
    expect(listeners).toBe(0);

    pending.resolve({ value: [], attempts: [audit("first")] });
    await expect(first).rejects.toMatchObject({ name: "RecommendationError", code: "llm-contract" });
    await expect(p.projectQueue()).resolves.toMatchObject({ complete: true, projected: 1 });
  });

  it("should allow activity to commit during scoring while serializing the following profile rebuild", async () => {
    const pending = deferred<LlmResult<unknown>>();
    const h = setup(":memory:", async () => pending.promise);
    seedStories(h.store, [story(1)]);
    const p = h.create();
    await p.rebuildProfile("initial");
    const scoring = p.scorePending();
    await vi.waitFor(() => { expect(h.scripted.calls).toBe(1); });
    await expect(p.recordActivity([rawActivity(1)])).resolves.toEqual({ accepted: 1, profileWorkEnqueued: true });
    expect(h.store.activity.latestVersion()).toBe("1");
    expect(h.store.profiles.current()?.activityVersion).toBe("0");
    const rebuilding = p.rebuildProfile("after-activity");
    pending.resolve({ value: judgments(h.scripted.requests[0]!), attempts: [audit("held")] });
    await expect(scoring).resolves.toMatchObject({ scored: 1 });
    const rebuilt = await rebuilding;
    expect(rebuilt.activityVersion).toBe("1");
    expect(rebuilt.reason).toBe("after-activity");
    expect(h.journal.llmCallsInsideTransaction).toBe(0);
  });

  it("should keep stale story and article failures off replacement content", async () => {
    const pending = deferred<LlmResult<unknown>>();
    const h = setup(":memory:", async () => pending.promise);
    seedStories(h.store, [story(1), story(2)]);
    h.store.articles.upsert(article(1));
    h.store.articles.upsert(article(2));
    const scoring = h.create().scorePending();
    await vi.waitFor(() => { expect(h.scripted.calls).toBe(1); });
    h.store.stories.upsertBatch([story(1, { contentVersion: "replacement-story" })]);
    h.store.articles.upsert(article(2, { contentHash: "replacement-article" }));
    pending.reject(llmError("provider", "provider-failed", true, [audit("stale", "provider-error")]));
    await expect(scoring).resolves.toMatchObject({ completion: "complete", failed: 0, retryableFailed: 0, audits: 1 });
    expect(h.store.queue.byStoryId(1)).toMatchObject({ evaluationState: "pending" });
    expect(h.store.queue.byStoryId(2)).toMatchObject({ evaluationState: "pending" });
    expect(h.store.queue.byStoryId(1)?.lastError).toBeUndefined();
    expect(h.store.queue.byStoryId(2)?.lastError).toBeUndefined();
    expect(h.store.llmCalls.byId("stale")).toBeDefined();
  });
});

describe("jobs and restart recovery", () => {
  it("should no-op stale profile-scoped jobs without provider work or an old projection", async () => {
    const h = setup();
    seedStories(h.store, [story(1)]);
    const p = h.create();
    const old = await p.rebuildProfile("old");
    const current = await p.applyPreferenceChange([rule("new-rule", "include")]);
    const pointer = h.store.queue.projection();
    await p.runJob(makeJob("personalization.score-pending", { profileId: old.id }));
    await p.runJob(makeJob("personalization.queue-project", { profileId: old.id }));
    expect(h.scripted.calls).toBe(0);
    expect(h.store.profiles.current()?.id).toBe(current.id);
    expect(h.store.queue.projection()).toEqual(pointer);
  });

  it("should recover idempotently after reopen and preserve immutable logical records", async () => {
    const directory = mkdtempSync(join(tmpdir(), "personalization-recovery-"));
    const path = join(directory, "reader.sqlite");
    const firstHarness = setup(path);
    let reopened: ReturnType<typeof setup> | undefined;
    try {
      seedStories(firstHarness.store, [story(1), story(2)]);
      const first = await firstHarness.create().recover();
      expect(first).toMatchObject({ rebuilt: true, scored: 2, queued: 2, audits: 1 });
      const profileId = firstHarness.store.profiles.current()!.id;
      const recommendations = firstHarness.store.recommendations.currentForStories({
        profileId,
        promptVersion: "recommendation-prompt/1",
        model: "model-1",
        storyIds: [1, 2],
      });
      const audits = firstHarness.store.llmCalls.recent(undefined, 100);
      const profiles = firstHarness.store.profiles.history(undefined, 100);
      firstHarness.database.close();

      reopened = setup(path);
      const second = await reopened.create().recover();
      expect(second).toMatchObject({ rebuilt: false, scored: 0, failed: 0, queued: 2, audits: 0 });
      expect(reopened.scripted.calls).toBe(0);
      expect(reopened.store.recommendations.currentForStories({
        profileId,
        promptVersion: "recommendation-prompt/1",
        model: "model-1",
        storyIds: [1, 2],
      })).toEqual(recommendations);
      expect(reopened.store.llmCalls.recent(undefined, 100)).toEqual(audits);
      expect(reopened.store.profiles.history(undefined, 100)).toEqual(profiles);

      const enqueued = reopened.jobs.enqueue(createPersonalizationJobEnqueue({ kind: "personalization.recover", payload: {}, runAfter: NOW }));
      const leased = reopened.jobs.claim(["personalization.recover"]);
      expect(leased).toMatchObject({ status: "leased", job: { id: enqueued.job.id } });
      reopened.clock.advance(1_000);
      expect(reopened.jobs.recoverExpired()).toBe(1);
      const retry = reopened.jobs.claim(["personalization.recover"]);
      expect(retry).toMatchObject({ status: "leased", job: { id: enqueued.job.id, attempts: 2 } });
      if (retry.status !== "leased") throw new Error("expected a leased retry");
      await reopened.create().runJob(retry.job);
      reopened.jobs.complete(retry.job.id, retry.job.leaseToken!);
      expect(reopened.jobs.get(enqueued.job.id)).toMatchObject({ status: "done" });
      expect(reopened.store.llmCalls.recent(undefined, 100)).toEqual(audits);
    } finally {
      if (firstHarness.database.isOpen()) firstHarness.database.close();
      if (reopened?.database.isOpen()) reopened.database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
