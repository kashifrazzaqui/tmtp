import { afterEach, describe, expect, it, vi } from "vitest";
import type { HnItem } from "@tmtp/domain";
import { createHnIngestion } from "@tmtp/hn-ingestion";
import { createPersonalization } from "@tmtp/personalization";
import { QUEUE_BOOTSTRAP_RANK_VERSION } from "@tmtp/queue";
import { createReaderApp, readerAppBootstrapRankVersion, readerAppJobCodecs } from "../src/index.js";
import { BEFORE, cleanup, harness, NOW, preference, rawActivity, story } from "./harness.js";

afterEach(cleanup);

function realPersonalization(h: ReturnType<typeof harness>, generate: ReturnType<typeof vi.fn>, maxStoriesPerRun = 50) {
  return createPersonalization({
    store: h.store,
    jobs: h.jobs,
    llm: { generate },
    model: "model-1",
    clock: { now: () => new Date(NOW) },
    activityPolicy: { idleTimeoutMs: 60_000, minDwellMs: 1_000, maxSessionGapMs: 300_000 },
    interestPolicy: { decayHalfLifeDays: 30, maxInferredTopics: 10, maxActivityEvents: 100 },
    recommendationPolicy: { batchSize: 10, maxStoriesPerRun, maxPromptChars: 100_000, explorationRatio: 0.1, capturePayloads: false },
    activityBatchSize: 500,
    queueSyncBatchSize: 2,
  });
}

describe("real SQLite composition workflows", () => {
  it("preserves activity replay identity across direct and job-driven retries without synchronous LLM work", async () => {
    const h = harness();
    h.store.stories.upsertBatch([story(1)]);
    const generate = vi.fn();
    const app = createReaderApp({ ...h.options, personalization: realPersonalization(h, generate) });
    const raw = rawActivity("A".repeat(43));
    await expect(app.recordActivity([raw])).resolves.toEqual({ accepted: 1, profileWorkEnqueued: true });
    await expect(app.recordActivity([raw])).resolves.toEqual({ accepted: 0, profileWorkEnqueued: false });
    expect(h.store.activity.query({ clientEventId: raw.clientEventId, limit: 1 })).toHaveLength(1);
    expect(h.jobs.list({ kind: "personalization.profile-rebuild", limit: 10 })).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it("executes a verified HN activity handoff through the real worker and dedupes handler replay", async () => {
    const h = harness(true);
    h.store.stories.upsertBatch([story(1)]);
    h.accountPerform.mockImplementation(async (stored) => ({ intentId: stored.id, status: "verified", observedAt: NOW }));
    const generate = vi.fn();
    const app = createReaderApp({ ...h.options, personalization: realPersonalization(h, generate) });
    await app.performHnAction({ storyId: 1, action: "upvote", idempotencyKey: "real-worker" });
    const claim = h.jobs.claim(readerAppJobCodecs.map((codec) => codec.kind));
    expect(claim.status).toBe("leased");
    if (claim.status !== "leased") return;
    expect(claim.job.kind).toBe("personalization.record-activity");
    await app.runJob(claim.job);
    h.jobs.complete(claim.job.id, claim.job.leaseToken!);
    const stored = h.store.hnActions.byIdempotencyKey("real-worker")!;
    const clientEventId = (claim.job.payload as { batch: Array<{ clientEventId: string }> }).batch[0]!.clientEventId;
    expect(h.store.activity.query({ clientEventId, limit: 1 })).toHaveLength(1);
    expect(h.store.hnActions.byId(stored.id)?.status).toBe("verified");
    await app.runJob(claim.job);
    expect(h.store.activity.query({ clientEventId, limit: 1 })).toHaveLength(1);
    expect(h.jobs.list({ kind: "personalization.profile-rebuild", limit: 10 })).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns fresh canonical preferences from the real store", async () => {
    const h = harness();
    h.store.preferences.replaceAll([preference()]);
    const first = await h.app.getPreferences();
    const second = await h.app.getPreferences();
    expect(first).toEqual([preference()]);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
  });

  it("ingests bootstrap rows, projects completely, then joins new pending rows to the active rank", async () => {
    const h = harness();
    const items = new Map<number, HnItem>();
    const item = (id: number): HnItem => ({
      id, type: "story", title: `Story ${id}`, url: `https://example.com/${id}`,
      time: Math.floor(Date.parse(BEFORE) / 1000), deleted: false, dead: false, raw: {}, rawSchemaVersion: 1,
    });
    let maximum = 1;
    items.set(1, item(1));
    const ingestion = createHnIngestion({
      api: {
        maxItemId: vi.fn(async () => maximum),
        item: vi.fn(async (id: number) => items.get(id)),
        feed: vi.fn(async () => []),
      },
      store: h.store,
      jobs: h.jobs,
      clock: { now: h.options.now },
      bootstrapRankVersion: readerAppBootstrapRankVersion,
      feeds: ["top"], initialLookbackItems: 1, maxItemsPerRun: 10, refreshBatchSize: 10, refreshAfterHours: 24,
    });
    const generate = vi.fn();
    const app = createReaderApp({ ...h.options, ingestion, personalization: realPersonalization(h, generate, 0) });

    await app.runIngestion();
    expect(h.store.queue.byStoryId(1)?.rankVersion).toBe(QUEUE_BOOTSTRAP_RANK_VERSION);
    await expect(app.runPersonalization()).resolves.toMatchObject({ completion: "complete", queued: 1, scored: 0 });
    const active = h.store.queue.projection()?.rankVersion;
    expect(active).toBeDefined();
    expect(active).not.toBe(QUEUE_BOOTSTRAP_RANK_VERSION);

    maximum = 2;
    items.set(2, item(2));
    await app.runIngestion();
    expect(h.store.queue.byStoryId(2)?.rankVersion).toBe(active);
    const queue = await app.getQueue({ limit: 2 });
    expect(queue.entries.map((entry) => entry.storyId)).toEqual([1, 2]);
    expect(queue.rankVersions).toEqual([active]);
    expect(generate).not.toHaveBeenCalled();
  });
});
