import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HnPublicApiError } from "@tmtp/hn-public-api";
import { JobQueueError } from "@tmtp/job-queue";
import { describe, expect, it, vi } from "vitest";
import { createHnIngestionJobEnqueue, hnIngestionJobCodecs, hnIngestionJobFailure, HnIngestionError } from "../src/index.js";
import { apiFixture, item, NOW, OLD, profile, setup, story, TIME } from "./harness.js";

describe("construction and scheduling contracts", () => {
  it("should validate options and expose strict safe scheduling contracts", async () => {
    const h = setup();
    try {
      const bootstrap = vi.fn(() => "rank");
      const ingestion = h.create({ bootstrapRankVersion: bootstrap });
      expect(bootstrap).toHaveBeenCalledTimes(1);
      expect(h.api.maxItemId).not.toHaveBeenCalled();
      expect(() => h.create({ feeds: ["top", "top"] })).toThrow(RangeError);
      expect(() => h.create({ maxItemsPerRun: 0 })).toThrow(RangeError);
      await expect(ingestion.collectPublic({} as AbortSignal)).rejects.toMatchObject({ code: "invalid-input" });
      await expect(ingestion.reconcileAccount()).rejects.toMatchObject({ code: "account-not-configured", retryable: false });
      expect(hnIngestionJobCodecs).toHaveLength(2);
      for (const codec of hnIngestionJobCodecs) {
        const first = codec.decode({}, 1);
        expect(first).toEqual({});
        expect(codec.decode({}, 1)).not.toBe(first);
        expect(() => codec.decode({ secret: true }, 1)).toThrow(TypeError);
        expect(() => codec.decode(new Map(), 1)).toThrow(TypeError);
        expect(() => codec.decode(new Date(), 1)).toThrow(TypeError);
        expect(() => codec.decode({}, 2)).toThrow(TypeError);
        expect(createHnIngestionJobEnqueue({ kind: codec.kind as "ingestion.collect", payload: {}, runAfter: TIME })).toEqual({
          kind: codec.kind, payload: {}, payloadSchemaVersion: 1, dedupeKey: codec.kind, runAfter: TIME,
        });
      }
      expect(() => createHnIngestionJobEnqueue({ kind: "ingestion.collect", payload: { secret: "x" }, runAfter: TIME })).toThrow(TypeError);
      expect(() => createHnIngestionJobEnqueue(Object.assign([], { kind: "ingestion.collect", payload: {}, runAfter: TIME }))).toThrow(TypeError);
      expect(hnIngestionJobFailure(new HnIngestionError("invalid-checkpoint", { operation: "collect-public", retryable: true })).retryable).toBe(false);
      expect(hnIngestionJobFailure(new HnIngestionError("upstream-failure", { operation: "collect-public", retryable: true, dependencyCode: "timeout" }))).toEqual({
        code: "ingestion:timeout", message: "HN ingestion upstream operation failed.", retryable: true,
      });
      expect(hnIngestionJobFailure(new Error("secret-cursor"))).toEqual({ code: "ingestion-failed", message: "HN ingestion job failed.", retryable: true });
    } finally { h.close(); }
  });
});

describe("public checkpoints and durable commits", () => {
  it("should resume capped bootstrap after reopen and advance to items created during bootstrap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tmtp-ingestion-"));
    const path = join(directory, "reader.sqlite");
    const api = apiFixture();
    api.maxItemId.mockResolvedValueOnce(5).mockResolvedValueOnce(7);
    api.feed.mockResolvedValue([3, 1, 2]);
    api.item.mockImplementation(async (id: number) => {
      if (id === 1 || id === 6) return item(id);
      if (id === 2) return item(id, { type: "comment" });
      return undefined;
    });
    const first = setup(path, api);
    try {
      const summary = await first.create({ feeds: ["top"], maxItemsPerRun: 2 }).collectPublic();
      expect(summary).toMatchObject({ highestSeenItemId: 5, storiesUpserted: 1, nonStoriesSkipped: 1, jobsEnqueued: 2 });
      expect(first.store.stories.byId(1)?.id).toBe(1);
      expect(first.store.queue.byStoryId(1)).toMatchObject({ evaluationState: "pending", rankVersion: "bootstrap-rank", visibilityState: "visible" });
      expect(first.store.sync.cursor("hn.public.collection")).toContain('"state":"bootstrap"');
    } finally { first.close(); }
    const second = setup(path, api);
    try {
      const ingestion = second.create({ feeds: ["top"], maxItemsPerRun: 2 });
      expect(await ingestion.collectPublic()).toMatchObject({ highestSeenItemId: 5, storiesUpserted: 0, nonStoriesSkipped: 1, jobsEnqueued: 0 });
      expect(api.feed).toHaveBeenCalledTimes(1);
      expect(api.maxItemId).toHaveBeenCalledTimes(1);
      const third = await ingestion.collectPublic();
      expect(third).toMatchObject({ highestSeenItemId: 7, storiesUpserted: 1, nonStoriesSkipped: 1, jobsEnqueued: 1 });
      expect(api.maxItemId).toHaveBeenCalledTimes(2);
      expect(api.item.mock.calls.map(([id]) => id)).toEqual([1, 2, 3, 6, 7]);
      expect(second.store.stories.byStoryIds([1, 6]).map((value) => value.id)).toEqual([1, 6]);
      expect(second.store.queue.byStoryId(6)?.rankVersion).toBe("bootstrap-rank");
      expect(second.store.sync.cursor("hn.public.collection")).toBe('{"schemaVersion":1,"state":"advance","lastProcessedItemId":7}');
      const jobs = second.jobs.list({ limit: 100 });
      expect(jobs).toHaveLength(3);
      const article = jobs.find((job) => job.kind === "article.fetch-extract" && (job.payload as { storyId: number }).storyId === 6);
      expect(article?.payload).toEqual({ storyId: 6, storyContentVersion: second.store.stories.byId(6)!.contentVersion });
      expect(second.store.sync.recentRuns(undefined, 10).find((run) => run.id === third.runId)).toMatchObject({ status: "complete", storiesUpserted: 1, nonStoriesSkipped: 1 });
    } finally { second.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("should clamp explicit lookback to one and process bounded ascending batches", async () => {
    const api = apiFixture(); api.maxItemId.mockResolvedValue(3);
    const h = setup(":memory:", api);
    try {
      const ingestion = h.create({ initialLookbackItems: 10, maxItemsPerRun: 2 });
      expect(await ingestion.collectPublic()).toMatchObject({ highestSeenItemId: 3, nonStoriesSkipped: 2 });
      expect(await ingestion.collectPublic()).toMatchObject({ highestSeenItemId: 3, nonStoriesSkipped: 1 });
      expect(api.item.mock.calls.map(([id]) => id)).toEqual([1, 2, 3]);
      expect(h.store.sync.cursor("hn.public.collection")).toContain('"lastProcessedItemId":3');
    } finally { h.close(); }
  });

  it("should refresh score-only changes without jobs and merge sparse tombstones on later refresh", async () => {
    const api = apiFixture(); api.maxItemId.mockResolvedValue(1);
    const h = setup(":memory:", api);
    try {
      h.store.stories.upsertBatch([story(2, OLD)]);
      h.store.profiles.insert(profile()); h.store.profiles.setCurrent("profile-1", TIME);
      h.store.queue.setProjection({ profileId: "profile-1", rankVersion: "rank-active", projectedAt: TIME });
      h.store.sync.setCursor("hn.public.collection", '{"schemaVersion":1,"state":"advance","lastProcessedItemId":1}', OLD);
      api.item.mockResolvedValue(item(2, { score: 99 }));
      const ingestion = h.create();
      expect(await ingestion.collectPublic()).toMatchObject({ storiesUpserted: 1, nonStoriesSkipped: 0, jobsEnqueued: 0 });
      expect(h.store.stories.byId(2)).toMatchObject({ score: 99, firstSeenAt: OLD });
      expect(h.store.queue.byStoryId(2)).toMatchObject({ rankVersion: "rank-active", visibilityState: "blacklisted", evaluationState: "pending" });
      expect(api.item).toHaveBeenCalledTimes(1);
      h.store.queue.updateState(2, "reading", TIME);
      h.clock.advance(25 * 3_600_000);
      api.item.mockResolvedValue({ id: 2, deleted: true, dead: false, raw: { id: 2, deleted: true }, rawSchemaVersion: 1 });
      expect(await ingestion.collectPublic()).toMatchObject({ storiesUpserted: 1, jobsEnqueued: 2 });
      expect(h.store.stories.byId(2)).toMatchObject({ id: 2, title: "Story 2", deleted: true, firstSeenAt: OLD, score: 99 });
      expect(h.store.queue.byStoryId(2)).toMatchObject({ state: "reading", rankVersion: "rank-active", visibilityState: "blacklisted" });
      expect(h.jobs.list({ limit: 100 }).map((job) => job.kind).sort()).toEqual(["article.fetch-extract", "personalization.score-pending"]);
    } finally { h.close(); }
  });

  it("should roll back every result write when a job handoff fails", async () => {
    const api = apiFixture(); api.feed.mockResolvedValue([1]); api.item.mockResolvedValue(item(1));
    const h = setup(":memory:", api);
    try {
      const enqueue = h.jobs.enqueue;
      h.jobs.enqueue = vi.fn((input) => {
        if (input.kind === "personalization.recover") throw new JobQueueError("invalid-payload", { cause: new Error("secret-payload") });
        return enqueue(input);
      });
      await expect(h.create({ feeds: ["top"] }).collectPublic()).rejects.toMatchObject({ code: "job-handoff-failure", dependency: "job-queue" });
      expect(h.store.stories.byId(1)).toBeUndefined();
      expect(h.store.queue.byStoryId(1)).toBeUndefined();
      expect(h.store.sync.cursor("hn.public.collection")).toBeUndefined();
      expect(h.jobs.list({ limit: 100 })).toEqual([]);
      const run = h.store.sync.latestRun("hn.public.collect");
      expect(run).toMatchObject({ status: "failed", storiesUpserted: 0, nonStoriesSkipped: 0, errorCode: "job-handoff-failure" });
      expect(JSON.stringify(run)).not.toContain("secret-payload");
    } finally { h.close(); }
  });

  it("should advance no checkpoint after upstream failure and reject malformed checkpoints safely", async () => {
    const api = apiFixture(); api.maxItemId.mockResolvedValue(2);
    api.item.mockRejectedValue(new HnPublicApiError("timeout", { operation: "item", retryable: true }));
    const h = setup(":memory:", api);
    try {
      api.maxItemId.mockRejectedValueOnce(new HnPublicApiError("timeout", { operation: "max-item", retryable: true }));
      const planningError = await h.create().collectPublic().catch((error: unknown) => error);
      expect(planningError).toMatchObject({ code: "upstream-failure", runId: expect.any(String) });
      expect(h.store.sync.recentRuns(undefined, 10).find((run) => run.id === (planningError as HnIngestionError).runId)).toMatchObject({ status: "failed", storiesUpserted: 0 });
      h.store.sync.setCursor("hn.public.collection", '{"schemaVersion":1,"state":"advance","lastProcessedItemId":1}', OLD);
      await expect(h.create().collectPublic()).rejects.toMatchObject({ code: "upstream-failure", dependencyCode: "timeout", retryable: true });
      expect(h.store.sync.cursor("hn.public.collection")).toBe('{"schemaVersion":1,"state":"advance","lastProcessedItemId":1}');
      expect(h.store.sync.latestRun("hn.public.collect")).toMatchObject({ status: "failed", errorCode: "upstream-failure" });
      h.store.sync.setCursor("hn.public.collection", '{"schemaVersion":1,"state":"advance","lastProcessedItemId":1,"secret":"cursor"}', OLD);
      await expect(h.create().collectPublic()).rejects.toMatchObject({ code: "invalid-checkpoint", retryable: false });
      expect(JSON.stringify(await h.create().collectPublic().catch((error: unknown) => error))).not.toContain("secret");
    } finally { h.close(); }
  });
});

describe("operation cancellation", () => {
  it("should not start feed requests after a planning abort and should record the active run", async () => {
    const api = apiFixture();
    let release!: (value: number) => void;
    api.maxItemId.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const h = setup(":memory:", api);
    try {
      const controller = new AbortController(); const reason = { planning: true };
      const pending = h.create({ feeds: ["top"] }).collectPublic(controller.signal);
      await vi.waitFor(() => { expect(api.maxItemId).toHaveBeenCalledTimes(1); });
      controller.abort(reason); release(2);
      await expect(pending).rejects.toBe(reason);
      expect(api.feed).not.toHaveBeenCalled();
      expect(h.store.sync.latestRun("hn.public.collect")).toMatchObject({ status: "failed", errorCode: "cancelled" });
    } finally { h.close(); }
  });

  it("should preserve queued and in-flight abort reasons and await started item work", async () => {
    const api = apiFixture(); api.maxItemId.mockResolvedValue(2);
    let release!: () => void;
    let settled = false;
    api.item.mockImplementation(async () => { await new Promise<void>((resolve) => { release = resolve; }); settled = true; return item(2); });
    const h = setup(":memory:", api);
    try {
      h.store.sync.setCursor("hn.public.collection", '{"schemaVersion":1,"state":"advance","lastProcessedItemId":1}', OLD);
      const ingestion = h.create();
      const firstController = new AbortController(); const queuedController = new AbortController();
      const firstReason = { first: true }; const queuedReason = { queued: true };
      const first = ingestion.collectPublic(firstController.signal);
      await vi.waitFor(() => { expect(api.item).toHaveBeenCalledTimes(1); });
      const queued = ingestion.collectPublic(queuedController.signal);
      queuedController.abort(queuedReason);
      await expect(queued).rejects.toBe(queuedReason);
      firstController.abort(firstReason); release();
      await expect(first).rejects.toBe(firstReason);
      expect(settled).toBe(true);
      expect(api.maxItemId).toHaveBeenCalledTimes(1);
      expect(h.store.stories.byId(2)).toBeUndefined();
      expect(h.store.sync.latestRun("hn.public.collect")).toMatchObject({ status: "failed", errorCode: "cancelled" });
      expect(h.store.sync.recentRuns(undefined, 10)).toHaveLength(1);
    } finally { h.close(); }
  });
});
