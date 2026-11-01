import { afterEach, describe, expect, it, vi } from "vitest";
import { RECOMMENDATION_PROMPT_VERSION } from "@tmtp/recommendations";
import type { LlmResult } from "@tmtp/llm-interface";
import { PersonalizationError } from "../src/index.js";
import {
  article,
  audit,
  cleanup,
  judgments,
  llmError,
  makeJob,
  NOW,
  rule,
  seedStories,
  setup,
  story,
} from "./harness.js";

afterEach(cleanup);

describe("scoring audits judgments and failures", () => {
  it("should persist every attempt and link each recommendation to its own batch final success", async () => {
    const h = setup(":memory:", async (request, index) => ({
      value: judgments(request),
      attempts: [audit(`failed-${index}`, "invalid-output"), audit(`success-${index}`)],
    }));
    seedStories(h.store, [story(1), story(2)]);
    h.store.articles.upsert(article(1));
    const mark = vi.spyOn(h.store.queue, "markEvaluation");
    const policy = { ...h.options.recommendationPolicy, batchSize: 1 };
    const controller = new AbortController();
    const summary = await h.create({ recommendationPolicy: policy }).scorePending(controller.signal);
    expect(summary).toEqual({ completion: "complete", scored: 2, failed: 0, retryableFailed: 0, queued: 2, audits: 4 });
    expect(h.scripted.calls).toBe(2);
    expect(h.scripted.requests.every((request) => request.signal === controller.signal)).toBe(true);
    expect(h.scripted.requests.every((request) => request.model === "model-1" && request.capturePayload === policy.capturePayloads)).toBe(true);
    const profileId = h.store.profiles.current()!.id;
    const recommendations = h.store.recommendations.currentForStories({
      profileId,
      promptVersion: RECOMMENDATION_PROMPT_VERSION,
      model: "model-1",
      storyIds: [1, 2],
    });
    expect(recommendations.map((recommendation) => [recommendation.storyId, recommendation.llmCallId])).toEqual([[1, "success-0"], [2, "success-1"]]);
    expect(recommendations[0]?.articleContentVersion).toBe(article(1).contentVersion);
    expect(recommendations[1]?.articleContentVersion).toBe("none");
    expect(recommendations.every((recommendation) => recommendation.createdAt === NOW)).toBe(true);
    for (const id of ["failed-0", "success-0", "failed-1", "success-1"]) expect(h.store.llmCalls.byId(id)).toBeDefined();
    expect(mark).not.toHaveBeenCalled();
    expect(h.journal.llmCallsInsideTransaction).toBe(0);
  });

  it("should preserve original recommendation timestamps and call links on compatible retries", async () => {
    const h = setup();
    seedStories(h.store, [story(1)]);
    const p = h.create();
    await p.scorePending();
    const profileId = h.store.profiles.current()!.id;
    const [original] = h.store.recommendations.currentForStories({ profileId, promptVersion: RECOMMENDATION_PROMPT_VERSION, model: "model-1", storyIds: [1] });
    expect(original?.llmCallId).toBe("call-0");
    h.clock.advance(1_000);
    vi.spyOn(h.store.stories, "needingScoring").mockReturnValueOnce([story(1)]);
    const summary = await p.scorePending();
    expect(summary.scored).toBe(1);
    expect(h.store.recommendations.byId(original!.id)).toEqual(original);
    expect(h.store.llmCalls.byId("call-1")).toBeDefined();
    expect(h.store.profiles.history(undefined, 10)).toHaveLength(1);
  });

  it("should reject changed judgment content and roll back its newly observed audit", async () => {
    const h = setup(":memory:", async (request, index) => ({ value: judgments(request, index === 0 ? 0.75 : 0.25), attempts: [audit(`call-${index}`)] }));
    seedStories(h.store, [story(1)]);
    const p = h.create();
    await p.scorePending();
    const profileId = h.store.profiles.current()!.id;
    const [original] = h.store.recommendations.currentForStories({ profileId, promptVersion: RECOMMENDATION_PROMPT_VERSION, model: "model-1", storyIds: [1] });
    h.clock.advance(1_000);
    vi.spyOn(h.store.stories, "needingScoring").mockReturnValueOnce([story(1)]);
    await expect(p.scorePending()).rejects.toMatchObject({ code: "recommendation-conflict", message: "Recommendation identity conflicts with an existing record." });
    expect(h.store.recommendations.byId(original!.id)).toEqual(original);
    expect(h.store.llmCalls.byId("call-1")).toBeUndefined();
  });

  it("should roll back all result writes on an audit identity conflict", async () => {
    const h = setup(":memory:", async (request) => ({
      value: judgments(request),
      attempts: [audit("call-0", "success", { usage: { latencyMs: 4 } })],
    }));
    seedStories(h.store, [story(1)]);
    const p = h.create();
    await p.persistLlmAudits([audit("call-0")]);
    await expect(p.scorePending()).rejects.toMatchObject({ code: "audit-conflict" });
    expect(h.store.llmCalls.byId("call-0")).toMatchObject({ latencyMs: 3 });
    expect(h.store.recommendations.currentForStories({
      profileId: h.store.profiles.current()!.id,
      promptVersion: RECOMMENDATION_PROMPT_VERSION,
      model: "model-1",
      storyIds: [1],
    })).toEqual([]);
    expect(h.store.queue.byStoryId(1)).toMatchObject({ evaluationState: "pending" });
  });

  it("should persist readable RecommendationError attempts and never invent empty-history audits", async () => {
    const observed = setup(":memory:", async (): Promise<LlmResult<unknown>> => ({
      value: [],
      attempts: [audit("observed", "provider-error")],
    }));
    seedStories(observed.store, [story(1)]);
    await expect(observed.create().scorePending()).rejects.toMatchObject({ name: "RecommendationError", code: "llm-contract" });
    expect(observed.store.llmCalls.byId("observed")).toBeDefined();
    expect(observed.store.queue.byStoryId(1)).toMatchObject({ evaluationState: "pending" });
    expect(observed.store.queue.byStoryId(1)?.lastError).toBeUndefined();

    const empty = setup(":memory:", async () => { throw new Error("SECRET port failure"); });
    seedStories(empty.store, [story(1)]);
    await expect(empty.create().scorePending()).rejects.toMatchObject({ name: "RecommendationError", code: "llm-contract", attempts: [] });
    expect(empty.store.llmCalls.recent(undefined, 10)).toEqual([]);
  });

  it("should commit current failures with safe text before runJob requests retry", async () => {
    const h = setup(":memory:", async () => {
      throw llmError("provider", "SECRET provider message", true, [audit("failed", "provider-error")]);
    });
    seedStories(h.store, [story(1)]);
    const p = h.create();
    const profile = await p.rebuildProfile("initial");
    let thrown: unknown;
    try {
      await p.runJob(makeJob("personalization.score-pending", { profileId: profile.id }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PersonalizationError);
    expect(thrown).toMatchObject({ code: "scoring-retryable", retryable: true, jobId: "job-test" });
    expect(h.store.llmCalls.byId("failed")).toBeDefined();
    expect(h.store.queue.byStoryId(1)).toMatchObject({
      evaluationState: "failed",
      lastError: "recommendation:provider:invalid-code",
    });
    expect(JSON.stringify(thrown)).not.toContain("SECRET");
  });
});

describe("complete queue projection", () => {
  it("should retain the complete queue across read and write batches while scoring only the bounded plan", async () => {
    const h = setup();
    const stories = [
      story(1),
      story(2, { deleted: true }),
      story(3, { dead: true }),
      story(4, { title: "TypeScript excluded" }),
      story(5),
      story(6),
      story(7),
    ];
    seedStories(h.store, stories);
    h.store.articles.upsert(article(1));
    h.store.articles.upsert(article(2));
    const p = h.create({
      recommendationPolicy: { ...h.options.recommendationPolicy, batchSize: 1, maxStoriesPerRun: 2 },
      queueSyncBatchSize: 2,
    });
    await p.applyPreferenceChange([rule()]);
    h.store.queue.updateState(6, "read", h.options.clock.now().toISOString());
    const summary = await p.scorePending();
    expect(summary).toMatchObject({ scored: 2, failed: 0, queued: 7, audits: 2 });
    const pointer = h.store.queue.projection()!;
    const entries = h.store.queue.forReprojection(undefined, 100);
    expect(entries).toHaveLength(7);
    expect(new Set(entries.map((entry) => entry.rankVersion))).toEqual(new Set([pointer.rankVersion]));
    expect(entries.find((entry) => entry.storyId === 2)).toMatchObject({ evaluationState: "scored" });
    expect(entries.find((entry) => entry.storyId === 3)).toMatchObject({ evaluationState: "pending" });
    expect(entries.find((entry) => entry.storyId === 4)).toMatchObject({ evaluationState: "pending", visibilityState: "blacklisted" });
    expect(entries.find((entry) => entry.storyId === 5)).toMatchObject({ evaluationState: "pending" });
    expect(entries.find((entry) => entry.storyId === 6)).toMatchObject({ evaluationState: "pending", state: "read" });
    expect(entries.find((entry) => entry.storyId === 7)).toMatchObject({ evaluationState: "pending" });
    expect(entries.find((entry) => entry.storyId === 7)?.lastError).toBeUndefined();
  });

  it("should skip the positive-limit work query at zero but still repair the complete projection", async () => {
    const h = setup();
    seedStories(h.store, [story(1), story(2), story(3)]);
    vi.spyOn(h.store.stories, "needingScoring").mockImplementation(() => { throw new Error("must not query"); });
    const summary = await h.create({ recommendationPolicy: { ...h.options.recommendationPolicy, maxStoriesPerRun: 0 } }).scorePending();
    expect(summary).toEqual({ completion: "complete", scored: 0, failed: 0, retryableFailed: 0, queued: 3, audits: 0 });
    expect(h.scripted.calls).toBe(0);
    expect(h.store.queue.forReprojection(undefined, 100).every((entry) => entry.evaluationState === "pending")).toBe(true);
  });

  it("should roll back audits judgments and projection when a complete-projection write fails", async () => {
    const h = setup();
    seedStories(h.store, [story(1)]);
    const p = h.create();
    await p.rebuildProfile("initial");
    const beforeQueue = h.store.queue.byStoryId(1);
    const beforeProjection = h.store.queue.projection();
    vi.spyOn(h.store.queue, "upsertRankingPreservingState").mockImplementation(() => { throw new Error("SECRET projection failure"); });
    await expect(p.scorePending()).rejects.toThrow("SECRET projection failure");
    expect(h.store.llmCalls.byId("call-0")).toBeUndefined();
    expect(h.store.recommendations.currentForStories({
      profileId: h.store.profiles.current()!.id,
      promptVersion: RECOMMENDATION_PROMPT_VERSION,
      model: "model-1",
      storyIds: [1],
    })).toEqual([]);
    expect(h.store.queue.byStoryId(1)).toEqual(beforeQueue);
    expect(h.store.queue.projection()).toEqual(beforeProjection);
  });
});
