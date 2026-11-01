import { createFixedClock } from "@tmtp/clock";
import { createJobQueue } from "@tmtp/job-queue";
import { afterEach, describe, expect, it } from "vitest";
import type { QueueEntry, ReadingSession } from "@tmtp/domain";
import { createReaderStore } from "../src/index.js";
import {
  article,
  BEFORE,
  cleanup,
  event,
  LATER,
  llmCall,
  NOW,
  profile,
  queueEntry,
  recommendation,
  rule,
  setup,
  story,
} from "./fixtures.js";

afterEach(cleanup);

describe("stories articles and transactional invalidation", () => {
  it("should preserve reading history while story changes invalidate stale judgments", () => {
    const { store } = setup();
    store.stories.upsertBatch([story(1)]);
    store.profiles.insert(profile());
    store.recommendations.insertImmutable([recommendation("rec-1", 1)]);
    store.queue.upsertRankingPreservingState([{ ...queueEntry(1, "scored"), state: "read" }]);
    const updated = { ...story(1, "story-v2"), firstSeenAt: LATER, lastSeenAt: LATER };
    store.stories.upsertBatch([updated]);
    expect(store.stories.byId(1)).toMatchObject({ contentVersion: "story-v2", firstSeenAt: BEFORE, lastSeenAt: LATER });
    expect(store.queue.byStoryId(1)).toMatchObject({
      state: "read", evaluationState: "pending", rankVersion: "rank-1", updatedAt: LATER,
    });
    expect(store.queue.byStoryId(1)).not.toHaveProperty("recommendationId");
    expect(store.queue.byStoryId(1)).not.toHaveProperty("rankScore");
    expect(store.queue.byStoryId(1)).not.toHaveProperty("rankPosition");
    expect(store.queue.byStoryId(1)).not.toHaveProperty("lastError");
    expect(store.stories.needingScoring({ profileId: "profile-1", promptVersion: "prompt-1", model: "model-1", limit: 10 }).map((row) => row.id)).toEqual([1]);
    store.recommendations.insertImmutable([recommendation("rec-new", 1, { storyContentVersion: "story-v2" })]);
    expect(store.stories.needingScoring({ profileId: "profile-1", promptVersion: "prompt-1", model: "model-1", limit: 10 })).toEqual([]);
  });

  it("should reject stale article sources and invalidate on changed derived content", () => {
    const { store } = setup();
    store.stories.upsertBatch([story(1)]);
    store.profiles.insert(profile());
    store.recommendations.insertImmutable([recommendation("rec-1", 1)]);
    store.queue.upsertRankingPreservingState([queueEntry(1, "scored")]);
    expect(store.articles.upsert({ ...article(1), sourceContentVersion: "older-story" })).toBe("stale-source");
    expect(store.articles.byStoryId(1)).toBeUndefined();
    expect(store.queue.byStoryId(1)?.evaluationState).toBe("scored");
    expect(store.articles.upsert(article(1))).toBe("applied");
    expect(store.queue.byStoryId(1)?.evaluationState).toBe("pending");
    expect(store.queue.byStoryId(1)).not.toHaveProperty("recommendationId");
    expect(store.articles.needingContent({ extractorVersion: "extractor-1", limit: 10 })).toEqual([]);
    expect(store.articles.needingContent({ extractorVersion: "extractor-2", limit: 10 }).map((row) => row.id)).toEqual([1]);
    store.stories.upsertBatch([story(1, "story-v2")]);
    expect(store.articles.needingContent({ extractorVersion: "extractor-1", limit: 10 }).map((row) => row.id)).toEqual([1]);
    expect(() => store.articles.upsert({ ...article(1), storyId: 99 })).toThrowError(expect.objectContaining({ code: "not-found" }));
  });

  it("should use bounded story keysets and deterministic batch reads", () => {
    const { store } = setup();
    store.stories.upsertBatch([story(3), story(1), story(2)]);
    expect(store.stories.byStoryIds([3, 1, 99, 1]).map((row) => row.id)).toEqual([1, 3]);
    expect(store.stories.forQueueProjection(1, 2).map((row) => row.id)).toEqual([2, 3]);
    expect(store.stories.needingRefresh(LATER, 1, 2).map((row) => row.id)).toEqual([2, 3]);
  });
});

describe("activity and reading sessions", () => {
  it("should advance activity heads by insertion sequence and keep replay idempotent", () => {
    const { store } = setup();
    store.stories.upsertBatch([story(1)]);
    expect(store.activity.latestVersion()).toBe("0");
    expect(store.activity.appendIdempotent([event("z", 1, LATER), event("a", 1, BEFORE)])).toBe(2);
    expect(store.activity.latestVersion()).toBe("2");
    expect(store.activity.query({ limit: 10 }).map((row) => row.id)).toEqual(["z", "a"]);
    expect(store.activity.appendIdempotent([event("z", 1, LATER)])).toBe(0);
    expect(store.activity.latestVersion()).toBe("2");
    expect(() => store.activity.appendIdempotent([{ ...event("z", 1, LATER), value: { changed: true } }])).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(store.activity.latestWindow(0)).toEqual([]);
    expect(store.activity.latestWindow(1).map((row) => row.id)).toEqual(["a"]);
    expect(store.activity.latestWindow(20).map((row) => row.id)).toEqual(["z", "a"]);
    expect(store.activity.afterVersion("1", 1).map((row) => row.id)).toEqual(["a"]);
    expect(store.activity.query({ afterId: "z", limit: 10 }).map((row) => row.id)).toEqual(["a"]);
    expect(() => store.activity.afterVersion("3", 10)).toThrowError(expect.objectContaining({ code: "unknown-version" }));
    expect(() => store.activity.afterVersion("01", 10)).toThrowError(expect.objectContaining({ code: "unknown-version" }));
    expect(() => store.activity.query({ storyId: 2, afterId: "z", limit: 10 })).toThrowError(expect.objectContaining({ code: "invalid-query" }));
  });

  it("should retain session maxima include terminal sessions and page independently", () => {
    const { store } = setup();
    store.stories.upsertBatch([story(1), story(2)]);
    const session: ReadingSession = {
      id: "a", storyId: 1, startedAt: BEFORE, endedAt: NOW, updatedAt: NOW,
      activeDwellMs: 100, maxScrollRatio: 0.5, state: "complete", observationQuality: "full", lastClientEventId: "event-a",
    };
    store.readingSessions.upsert(session);
    store.readingSessions.upsert({ ...session, id: "b", lastClientEventId: "event-b", activeDwellMs: 50 });
    expect(store.readingSessions.latestForStory(1)).toMatchObject({ id: "b", state: "complete" });
    store.readingSessions.upsert({ ...session, activeDwellMs: 10, maxScrollRatio: 0.1 });
    expect(store.readingSessions.latestForStory(1)).toMatchObject({ id: "b" });
    expect(store.readingSessions.query({ storyId: 1, limit: 10 }).find((row) => row.id === "a")).toMatchObject({ activeDwellMs: 100, maxScrollRatio: 0.5 });
    expect(store.readingSessions.query({ afterId: "a", limit: 10 }).map((row) => row.id)).toEqual(["b"]);
    expect(() => store.readingSessions.upsert({ ...session, id: "other" })).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(() => store.readingSessions.query({ storyId: 2, afterId: "a", limit: 10 })).toThrowError(expect.objectContaining({ code: "invalid-query" }));
  });
});

describe("preferences profiles and recommendations", () => {
  it("should version rules and select historical immutable profiles through one pointer", () => {
    const { store } = setup();
    const first = store.preferences.replaceAll([rule("b"), { ...rule("a"), kind: "author", normalizedValue: "a" }]);
    expect(store.preferences.currentVersion()).toBe(first);
    expect(store.preferences.list().map((row) => row.id)).toEqual(["a", "b"]);
    expect(store.preferences.replaceAll(store.preferences.list())).toBe(first);
    store.profiles.insert(profile("profile-1"));
    store.profiles.insert(profile("profile-1"));
    expect(() => store.profiles.insert({ ...profile("profile-1"), reason: "changed" })).toThrowError(expect.objectContaining({ code: "immutable-conflict" }));
    store.profiles.insert(profile("profile-2"));
    store.profiles.setCurrent("profile-2", NOW);
    store.profiles.setCurrent("profile-1", LATER);
    expect(store.profiles.current()?.id).toBe("profile-1");
    expect(store.profiles.history(undefined, 1).map((row) => row.id)).toEqual(["profile-1"]);
    expect(store.profiles.history("profile-1", 10).map((row) => row.id)).toEqual(["profile-2"]);
    expect(store.profiles.byVersion({ rulesVersion: "rules-profile-1", activityVersion: "1", policyVersion: "ip1.test", builderVersion: "interests/1" })?.id).toBe("profile-1");
  });

  it("should preserve recommendation history and derive active version counts from queue links", () => {
    const { store } = setup();
    store.stories.upsertBatch([story(1)]);
    store.profiles.insert(profile());
    store.recommendations.insertImmutable([
      recommendation("rec-a", 1),
      recommendation("rec-b", 1, { storyContentVersion: "older" }),
    ]);
    store.recommendations.insertImmutable([recommendation("rec-a", 1)]);
    expect(() => store.recommendations.insertImmutable([{ ...recommendation("rec-a", 1), score: 0.1 }])).toThrowError(expect.objectContaining({ code: "immutable-conflict" }));
    expect(store.recommendations.historyForStory(1, undefined, 1).map((row) => row.id)).toEqual(["rec-a"]);
    expect(store.recommendations.historyForStory(1, "rec-a", 10).map((row) => row.id)).toEqual(["rec-b"]);
    expect(store.recommendations.latestForStory(1)?.id).toBe("rec-b");
    expect(store.recommendations.currentForStories({ profileId: "profile-1", promptVersion: "prompt-1", model: "model-1", storyIds: [1] }).map((row) => row.id)).toEqual(["rec-a", "rec-b"]);
    store.queue.upsertRankingPreservingState([{ ...queueEntry(1, "scored"), recommendationId: "rec-a" }]);
    expect(store.recommendations.activeVersionCounts(undefined, 10)).toEqual([{
      profileId: "profile-1", promptVersion: "prompt-1", model: "model-1", rankVersion: "rank-1", queueEntryCount: 1,
    }]);
  });
});

describe("queue projection and keyset pages", () => {
  it("should share the active rank namespace preserve state and page every evaluation section", () => {
    const { store } = setup();
    store.stories.upsertBatch([story(1), story(2), story(3), story(4), story(5)]);
    store.profiles.insert(profile());
    store.recommendations.insertImmutable([recommendation("rec-1", 1)]);
    store.queue.setProjection({ profileId: "profile-1", rankVersion: "rank-1", projectedAt: NOW });
    const entries: QueueEntry[] = [
      { ...queueEntry(1, "scored"), state: "read", queuedAt: BEFORE },
      { ...queueEntry(2, "failed"), rankPosition: undefined, lastError: "safe" },
      queueEntry(3),
      { ...queueEntry(4), visibilityState: "blacklisted" },
    ];
    store.queue.upsertRankingPreservingState(entries);
    expect(store.queue.insertPendingIfMissing([{ ...queueEntry(5), rankVersion: "qb1.initial" }])).toBe(1);
    expect(store.queue.byStoryId(5)?.rankVersion).toBe("rank-1");
    const collected: number[] = [];
    let after: Parameters<typeof store.queue.page>[0]["after"];
    for (;;) {
      const page = store.queue.page({ rankVersion: "rank-1", limit: 1, ...(after === undefined ? {} : { after }) });
      if (page.length === 0) break;
      collected.push(page[0]!.storyId);
      const last = page[0]!;
      after = { rankVersion: last.rankVersion, evaluationState: last.evaluationState, ...(last.rankPosition === undefined ? {} : { rankPosition: last.rankPosition }), storyId: last.storyId };
      if (collected.length > 10) throw new Error("pagination did not terminate");
    }
    expect(collected).toEqual([1, 3, 5, 2]);
    expect(store.queue.page({ rankVersion: "rank-1", visibilityState: "blacklisted", limit: 10 }).map((row) => row.storyId)).toEqual([4]);
    expect(store.queue.countsByEvaluationState({ rankVersion: "rank-1" })).toEqual({ scored: 1, pending: 3, failed: 1 });
    store.queue.upsertRankingPreservingState([{ ...queueEntry(1, "scored"), state: "unread", queuedAt: LATER, updatedAt: LATER }]);
    expect(store.queue.byStoryId(1)).toMatchObject({ state: "read", queuedAt: BEFORE, updatedAt: LATER });
    expect(store.queue.updateState(3, "reading", LATER)).toMatchObject({ state: "reading", updatedAt: LATER });
    expect(() => store.queue.updateState(99, "read", NOW)).toThrowError(expect.objectContaining({ code: "not-found" }));
    store.queue.markEvaluation({ storyId: 1, evaluationState: "failed", rankVersion: "rank-2", lastError: "failed", at: LATER });
    expect(store.queue.byStoryId(1)).toMatchObject({ evaluationState: "failed", rankVersion: "rank-2" });
    expect(store.queue.byStoryId(1)).not.toHaveProperty("recommendationId");
    expect(store.queue.byStoryId(1)).not.toHaveProperty("rankScore");
    expect(store.queue.byStoryId(1)).not.toHaveProperty("rankPosition");
  });
});

describe("shared transaction composition", () => {
  it("should roll back activity and job writes together and commit them together", () => {
    const { database, store } = setup(true);
    store.stories.upsertBatch([story(1)]);
    const jobs = createJobQueue({
      database, clock: createFixedClock(new Date(NOW)),
      codecs: [{ kind: "test", currentVersion: 1, decode: (payload) => payload }],
      leaseMs: 1_000, maxAttempts: 2, backoffBaseMs: 1, backoffMaxMs: 2, batchSize: 10,
    });
    expect(() => store.transaction(() => {
      store.activity.appendIdempotent([event("rollback")]);
      jobs.enqueue({ kind: "test", payload: {}, payloadSchemaVersion: 1, runAfter: NOW });
      throw new Error("force rollback");
    })).toThrow("force rollback");
    expect(store.activity.latestVersion()).toBe("0");
    expect(jobs.list({ limit: 10 })).toEqual([]);
    store.transaction(() => {
      store.activity.appendIdempotent([event("commit")]);
      jobs.enqueue({ kind: "test", payload: {}, payloadSchemaVersion: 1, runAfter: NOW });
    });
    expect(store.activity.latestVersion()).toBe("1");
    expect(jobs.list({ limit: 10 })).toHaveLength(1);
    expect(createReaderStore(database).activity.latestVersion()).toBe("1");
  });
});
