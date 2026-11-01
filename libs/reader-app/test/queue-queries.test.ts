import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent, ReadingSession } from "@tmtp/domain";
import { QUEUE_BOOTSTRAP_RANK_VERSION } from "@tmtp/queue";
import { cleanup, harness, intent, NOW, queueEntry, recommendation, story } from "./harness.js";

afterEach(cleanup);

function seedMixed(h: ReturnType<typeof harness>): void {
  h.store.stories.upsertBatch(Array.from({ length: 9 }, (_, index) => story(index + 1)));
  const entries = [
    queueEntry(1, "rank-b", "scored", 2),
    queueEntry(2, "rank-b"),
    queueEntry(3, "rank-b", "failed"),
    queueEntry(4, "rank-a", "scored", 1),
    queueEntry(5, "rank-a"),
    queueEntry(6, QUEUE_BOOTSTRAP_RANK_VERSION),
    queueEntry(7, QUEUE_BOOTSTRAP_RANK_VERSION, "failed"),
    queueEntry(8, QUEUE_BOOTSTRAP_RANK_VERSION, "scored", 1),
    queueEntry(9, "rank-b", "scored", 1),
  ];
  h.store.recommendations.insertImmutable(entries.filter((entry) => entry.evaluationState === "scored").map((entry) => recommendation(`rec-${entry.storyId}`, entry.storyId)));
  h.store.queue.upsertRankingPreservingState(entries);
  h.store.queue.setProjection({ profileId: "profile-1", rankVersion: "rank-b", projectedAt: NOW });
}

async function allPages(h: ReturnType<typeof harness>, limit: number) {
  const tuples: Array<[number, string]> = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await h.app.getQueue({ limit, ...(cursor === undefined ? {} : { cursor }) });
    tuples.push(...page.entries.map((entry) => [entry.storyId, entry.rankVersion] as [number, string]));
    expect(page.storyDetails.map((detail) => detail.story.id)).toEqual(page.entries.map((entry) => entry.storyId));
    cursor = page.nextCursor;
    pages += 1;
    expect(pages).toBeLessThan(20);
  } while (cursor !== undefined);
  return { tuples, pages };
}

describe("complete mixed-rank-version queue", () => {
  it("concatenates every group in deterministic order with no duplicates omissions or terminal cursor", async () => {
    const h = harness(false, 2, 3);
    seedMixed(h);
    const result = await allPages(h, 2);
    expect(result.tuples).toEqual([
      [9, "rank-b"], [1, "rank-b"], [2, "rank-b"], [3, "rank-b"],
      [4, "rank-a"], [5, "rank-a"],
      [8, QUEUE_BOOTSTRAP_RANK_VERSION], [6, QUEUE_BOOTSTRAP_RANK_VERSION], [7, QUEUE_BOOTSTRAP_RANK_VERSION],
    ]);
    expect(result.pages).toBe(5);
    const first = await h.app.getQueue({ limit: 3 });
    expect(first.rankVersions).toEqual(["rank-b", "rank-a", QUEUE_BOOTSTRAP_RANK_VERSION]);
    expect(first.evaluationCounts).toEqual({ pending: 3, scored: 4, failed: 2 });
  });

  it("keeps empty-under-filter groups and applies all filters to continuation cursors", async () => {
    const h = harness();
    seedMixed(h);
    const page = await h.app.getQueue({ evaluationState: "pending", limit: 2 });
    expect(page.entries.map((entry) => entry.storyId)).toEqual([2, 5]);
    expect(page.rankVersions).toHaveLength(3);
    expect(page.nextCursor).toBeDefined();
    await expect(h.app.getQueue({ evaluationState: "failed", cursor: page.nextCursor })).rejects.toMatchObject({ code: "invalid-cursor" });
    await expect(h.app.getQueue({ visibilityState: "blacklisted", cursor: page.nextCursor })).rejects.toMatchObject({ code: "invalid-cursor" });
    const last = await h.app.getQueue({ evaluationState: "pending", limit: 2, cursor: page.nextCursor });
    expect(last.entries.map((entry) => entry.storyId)).toEqual([6]);
    expect(last.nextCursor).toBeUndefined();
    const empty = await h.app.getQueue({ visibilityState: "blacklisted" });
    expect(empty.entries).toEqual([]);
    expect(empty.storyDetails).toEqual([]);
    expect(empty.evaluationCounts).toEqual({ pending: 0, scored: 0, failed: 0 });
  });

  it("uses bounded reads even when the requested limit equals the maximum and batches story details once", async () => {
    const h = harness(false, 3, 3);
    seedMixed(h);
    const pageSpy = vi.spyOn(h.store.queue, "page");
    const manifestSpy = vi.spyOn(h.store.queue, "forReprojection");
    const storiesSpy = vi.spyOn(h.store.stories, "byStoryIds");
    const page = await h.app.getQueue({ limit: 3 });
    expect(page.entries).toHaveLength(3);
    expect(page.nextCursor).toBeDefined();
    expect(pageSpy.mock.calls.every(([query]) => query.limit <= 3)).toBe(true);
    expect(manifestSpy.mock.calls.every(([, limit]) => limit <= 3)).toBe(true);
    expect(storiesSpy).toHaveBeenCalledTimes(1);
    const empty = await h.app.getQueue({ visibilityState: "blacklisted" });
    expect(empty.entries).toEqual([]);
    expect(storiesSpy).toHaveBeenCalledTimes(1);
  });

  it("allows unfiltered reading-state changes but invalidates state-filtered and manifest changes", async () => {
    const h = harness();
    seedMixed(h);
    const first = await h.app.getQueue({ limit: 2 });
    h.store.queue.updateState(1, "read", "2026-04-01T00:00:00.000Z");
    await expect(h.app.getQueue({ limit: 2, cursor: first.nextCursor })).resolves.toMatchObject({ entries: expect.any(Array) });

    const filtered = await h.app.getQueue({ state: "unread", limit: 2 });
    h.store.queue.updateState(2, "read", "2026-04-01T00:00:00.000Z");
    await expect(h.app.getQueue({ state: "unread", limit: 2, cursor: filtered.nextCursor })).rejects.toMatchObject({ code: "stale-queue-cursor" });

    const active = await h.app.getQueue({ limit: 2 });
    h.store.queue.setProjection({ profileId: "profile-1", rankVersion: "rank-a", projectedAt: NOW });
    await expect(h.app.getQueue({ limit: 2, cursor: active.nextCursor })).rejects.toMatchObject({ code: "stale-queue-cursor" });
  });

  it("rejects malformed noncanonical and check summing cursor input safely before manifest SQL", async () => {
    const h = harness();
    seedMixed(h);
    const first = await h.app.getQueue({ limit: 2 });
    const cursor = first.nextCursor!;
    const projection = vi.spyOn(h.store.queue, "projection");
    await expect(h.app.getQueue({ cursor: `${cursor}x` })).rejects.toMatchObject({ code: "invalid-cursor" });
    const [, encoded] = cursor.split(".");
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { filters: object; manifestHash: string; after: string };
    const reordered = JSON.stringify({ manifestHash: value.manifestHash, filters: value.filters, after: value.after });
    const bytes = Buffer.from(reordered, "utf8");
    const bad = `rqa1.${bytes.toString("base64url")}.${createHash("sha256").update(bytes).digest("base64url")}`;
    await expect(h.app.getQueue({ cursor: bad })).rejects.toMatchObject({ code: "invalid-cursor" });
    expect(projection).not.toHaveBeenCalled();
  });

  it("validates malformed cursors before reader-app pre-cancellation", async () => {
    const h = harness();
    const controller = new AbortController();
    const reason = { abortSentinel: true };
    controller.abort(reason);
    const projection = vi.spyOn(h.store.queue, "projection");
    await expect(h.app.getQueue({ cursor: "bad" }, controller.signal)).rejects.toMatchObject({ code: "invalid-cursor" });
    expect(projection).not.toHaveBeenCalled();
  });

  it("fails safely when a required queue story is absent rather than misaligning details", async () => {
    const h = harness();
    seedMixed(h);
    vi.spyOn(h.store.stories, "byStoryIds").mockReturnValue([]);
    await expect(h.app.getQueue()).rejects.toMatchObject({ code: "dependency-failure", dependency: "reader-store", dependencyCode: "missing-story" });
  });

  it("resumes an identical mixed-version page after closing and reopening SQLite", async () => {
    const h = harness();
    seedMixed(h);
    const first = await h.app.getQueue({ limit: 2 });
    const path = h.path;
    h.database.close();
    const reopened = harness(false, 2, 3, path);
    const second = await reopened.app.getQueue({ limit: 2, cursor: first.nextCursor });
    expect(second.entries.map((entry) => [entry.storyId, entry.rankVersion])).toEqual([[2, "rank-b"], [3, "rank-b"]]);
    expect(second.storyDetails.map((detail) => detail.story.id)).toEqual([2, 3]);
  });
});

describe("cached detail, reading state, and histories", () => {
  it("returns the exact linked recommendation and safe cached fallback without article reads", async () => {
    const h = harness();
    h.store.stories.upsertBatch([story(1, "source", "https://user:pass@example.com/private#fragment")]);
    h.store.recommendations.insertImmutable([
      recommendation("rec-1", 1, "source"),
      { ...recommendation("rec-new", 1, "source"), articleContentVersion: "other", createdAt: "2026-04-01T00:00:00.000Z" },
    ]);
    h.store.queue.upsertRankingPreservingState([queueEntry(1, "rank", "scored", 1)]);
    const detail = await h.app.getStory(1);
    expect(detail.recommendation?.id).toBe("rec-1");
    expect(detail.originalUrl).toBe("https://news.ycombinator.com/item?id=1");
    expect(detail.fallback).toEqual({ kind: "hn-discussion", observationQuality: "partial" });
    expect(detail.article).toBeUndefined();
    expect(h.articleRead).not.toHaveBeenCalled();
    await expect(h.app.getStory(99)).rejects.toMatchObject({ code: "not-found" });
  });

  it("normalizes original URLs and applies monotonic queue transitions without implicit activity", async () => {
    const h = harness();
    h.store.stories.upsertBatch([story(1)]);
    h.store.queue.upsertRankingPreservingState([queueEntry(1, "rank")]);
    const detail = await h.app.getStory(1);
    expect(detail.originalUrl).toBe("https://example.com/1");
    h.setNow("2026-01-01T00:00:00.000Z");
    const reading = await h.app.setQueueState(1, "reading");
    expect(reading.updatedAt).toBe(NOW);
    expect(reading.state).toBe("reading");
    const same = await h.app.setQueueState(1, "reading");
    expect(same.updatedAt).toBe(NOW);
    const read = await h.app.setQueueState(1, "read");
    expect(read.updatedAt).toBe(NOW);
    const dismissed = await h.app.setQueueState(1, "dismissed");
    expect(dismissed.state).toBe("dismissed");
    await expect(h.app.setQueueState(1, "reading")).rejects.toMatchObject({ code: "invalid-transition" });
    expect(h.store.activity.query({ limit: 10 })).toEqual([]);
  });

  it("pages recommendation and HN histories by their own IDs and rejects cross-story continuation", async () => {
    const h = harness();
    h.store.stories.upsertBatch([story(1), story(2)]);
    h.store.recommendations.insertImmutable([
      recommendation("r1", 1),
      { ...recommendation("r2", 1), articleContentVersion: "a2", createdAt: "2026-02-02T00:00:00.000Z" },
      recommendation("other", 2),
    ]);
    h.store.hnActions.createIntent(intent("i1", 1));
    h.store.hnActions.createIntent(intent("i2", 1, { createdAt: "2026-02-02T00:00:00.000Z", updatedAt: "2026-02-02T00:00:00.000Z" }));
    h.store.hnActions.createIntent(intent("other", 2));
    expect((await h.app.getRecommendationHistory({ storyId: 1, limit: 1 })).map((row) => row.id)).toEqual(["r1"]);
    expect((await h.app.getRecommendationHistory({ storyId: 1, afterId: "r1", limit: 2 })).map((row) => row.id)).toEqual(["r2"]);
    expect((await h.app.getHnActionHistory({ storyId: 1, afterId: "i1", limit: 2 })).map((row) => row.id)).toEqual(["i2"]);
    await expect(h.app.getRecommendationHistory({ storyId: 1, afterId: "other" })).rejects.toMatchObject({ code: "invalid-input", field: "afterId" });
    await expect(h.app.getHnActionHistory({ storyId: 1, afterId: "other" })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(h.app.getHnActionHistory({ storyId: 99 })).rejects.toMatchObject({ code: "not-found" });
  });

  it("reads event and session histories independently with client identity and correct keysets", async () => {
    const h = harness();
    h.store.stories.upsertBatch([story(1), story(2)]);
    const ids = ["A".repeat(43), "B".repeat(43), "C".repeat(43)];
    const events: ActivityEvent[] = ids.map((clientEventId, index) => ({
      id: `evt_${clientEventId}`, clientEventId, storyId: index === 2 ? 2 : 1, kind: "open",
      valueSchemaVersion: 1, source: "embedded-reader", observationQuality: "full",
      occurredAt: `2026-01-0${index + 1}T00:00:00.000Z`, receivedAt: NOW,
    }));
    h.store.activity.appendIdempotent(events);
    const sessions: ReadingSession[] = events.map((event) => ({
      id: `ses_${event.clientEventId}`, storyId: event.storyId, startedAt: event.occurredAt, updatedAt: event.occurredAt,
      activeDwellMs: 0, maxScrollRatio: 0, state: "active", observationQuality: "full", lastClientEventId: event.clientEventId,
    }));
    for (const session of sessions) h.store.readingSessions.upsert(session);
    const first = await h.app.getActivity({ storyId: 1, limit: 1 });
    expect(first.events.map((event) => event.id)).toEqual([`evt_${ids[0]}`]);
    expect(first.sessions.map((session) => session.id)).toEqual([`ses_${ids[0]}`]);
    const rest = await h.app.getActivity({ storyId: 1, afterEventId: `evt_${ids[0]}`, afterSessionId: `ses_${ids[0]}`, limit: 2 });
    expect(rest.events.map((event) => event.id)).toEqual([`evt_${ids[1]}`]);
    expect(rest.sessions.map((session) => session.id)).toEqual([`ses_${ids[1]}`]);
    const filtered = await h.app.getActivity({ clientEventId: ids[1] });
    expect(filtered.events).toHaveLength(1);
    expect(filtered.sessions).toHaveLength(1);
    await expect(h.app.getActivity({ storyId: 1, afterEventId: `evt_${ids[2]}` })).rejects.toMatchObject({ code: "invalid-input", field: "afterEventId" });
    await expect(h.app.getActivity({ storyId: 1, afterSessionId: `ses_${ids[2]}` })).rejects.toMatchObject({ code: "invalid-input", field: "afterSessionId" });
  });
});
