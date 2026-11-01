import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawActivity } from "@tmtp/activity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, NOW, rawActivity, rule, seedStories, setup, story } from "./harness.js";

afterEach(cleanup);

function dwell(id: number, occurredAt = NOW): RawActivity {
  return { ...rawActivity(id, 1, "dwell", occurredAt), value: { activeMs: 5_000 } } as RawActivity;
}

describe("activity transactions", () => {
  it("should append novel events and sessions atomically then accept only novel rows on partial retry", async () => {
    const h = setup();
    seedStories(h.store, [story(1)]);
    const p = h.create();
    const batch = [rawActivity(1), dwell(2), rawActivity(3, 1, "complete")];
    await expect(p.recordActivity(batch)).resolves.toEqual({ accepted: 3, profileWorkEnqueued: true });
    expect(h.store.activity.latestVersion()).toBe("3");
    expect(h.store.readingSessions.latestForStory(1)).toMatchObject({ state: "complete", lastClientEventId: batch[2]!.clientEventId });
    const jobs = h.jobs.list({ limit: 100 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: "personalization.profile-rebuild",
      payload: { reason: "activity", activityVersion: "3" },
      runAfter: NOW,
    });

    await expect(p.recordActivity(batch)).resolves.toEqual({ accepted: 0, profileWorkEnqueued: false });
    expect(h.jobs.list({ limit: 100 })).toHaveLength(1);
    h.clock.advance(1_000);
    const later = new Date(h.clock.now()).toISOString();
    const resumed = rawActivity(4, 1, "open", later);
    await expect(p.recordActivity([...batch, resumed])).resolves.toEqual({ accepted: 1, profileWorkEnqueued: true });
    expect(h.store.activity.latestVersion()).toBe("4");
    expect(h.store.readingSessions.latestForStory(1)).toMatchObject({ state: "active", lastClientEventId: resumed.clientEventId });
    expect(h.jobs.list({ limit: 100 })).toHaveLength(2);
  });

  it("should reject mixed-story malformed and oversized batches before storage", async () => {
    const h = setup();
    const p = h.create({ activityBatchSize: 1 });
    const transactions = h.journal.transactions;
    await expect(p.recordActivity([rawActivity(1, 1), rawActivity(2, 2)])).rejects.toMatchObject({ name: "ActivityError", code: "invalid-activity" });
    await expect(p.recordActivity([rawActivity(1), rawActivity(2)])).rejects.toMatchObject({ code: "invalid-input", field: "batch" });
    await expect(p.recordActivity([{ secret: "SECRET" }] as never)).rejects.toMatchObject({ name: "ActivityError", code: "invalid-activity" });
    expect(h.journal.transactions).toBe(transactions);
    expect(h.store.activity.latestVersion()).toBe("0");
  });

  it("should roll back appended events and prevent session and job writes when the append count is short", async () => {
    const h = setup();
    seedStories(h.store, [story(1)]);
    const original = h.store.activity.appendIdempotent;
    vi.spyOn(h.store.activity, "appendIdempotent").mockImplementation((events) => {
      const inserted = original(events);
      return inserted - 1;
    });
    await expect(h.create().recordActivity([rawActivity(1)])).rejects.toMatchObject({ code: "activity-append-incomplete", retryable: true });
    expect(h.store.activity.latestVersion()).toBe("0");
    expect(h.store.readingSessions.query({ storyId: 1, limit: 10 })).toEqual([]);
    expect(h.jobs.list({ limit: 100 })).toEqual([]);
  });

  it("should linearize concurrent duplicate calls and resume after the latest terminal session", async () => {
    const h = setup();
    seedStories(h.store, [story(1)]);
    const p = h.create();
    const results = await Promise.all([p.recordActivity([rawActivity(1)]), p.recordActivity([rawActivity(1)])]);
    expect(results.map((result) => result.accepted).sort()).toEqual([0, 1]);
    expect(h.store.activity.latestVersion()).toBe("1");
    expect(h.jobs.list({ limit: 100 })).toHaveLength(1);

    await p.recordActivity([rawActivity(2, 1, "complete")]);
    h.clock.advance(1_000);
    await p.recordActivity([rawActivity(3, 1, "open", h.clock.now().toISOString())]);
    const sessions = h.store.readingSessions.query({ storyId: 1, limit: 10 });
    expect(sessions.map((session) => session.state).sort()).toEqual(["active", "complete"]);
    expect(new Set(sessions.map((session) => session.id)).size).toBe(2);
  });
});

describe("canonical profiles and preferences", () => {
  it("should retain the independent activity head when the activity arithmetic budget is zero", async () => {
    const h = setup();
    seedStories(h.store, [story(1)]);
    const p = h.create({ interestPolicy: { ...h.options.interestPolicy, maxActivityEvents: 0 } });
    await p.recordActivity([rawActivity(1)]);
    const profile = await p.rebuildProfile("zero-budget");
    expect(profile.activityVersion).toBe("1");
    expect(profile.interests).toEqual([]);
    expect(profile.reason).toBe("zero-budget");
  });

  it("should reuse same-version profiles and their original timestamps and reasons", async () => {
    const h = setup();
    const p = h.create();
    const first = await p.rebuildProfile("first");
    h.clock.advance(1_000);
    const second = await p.rebuildProfile("second");
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.reason).toBe("first");
    expect(h.store.profiles.history(undefined, 10)).toHaveLength(1);
    expect(h.jobs.list({ limit: 100 })).toHaveLength(1);
  });

  it("should select a historical profile through the durable pointer without rewriting it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "personalization-profile-"));
    const path = join(directory, "reader.sqlite");
    const firstHarness = setup(path);
    try {
      seedStories(firstHarness.store, [story(1)]);
      const p = firstHarness.create();
      const original = await p.rebuildProfile("original");
      const changed = await p.applyPreferenceChange([rule("rule-include", "include")]);
      expect(changed.id).not.toBe(original.id);
      const reverted = await p.applyPreferenceChange([]);
      expect(reverted).toEqual(original);
      firstHarness.database.close();

      const reopened = setup(path);
      expect(reopened.store.profiles.current()).toEqual(original);
      const projection = await reopened.create().projectQueue();
      expect(projection.profileId).toBe(original.id);
      expect(reopened.store.profiles.history(undefined, 10)).toHaveLength(2);
      reopened.database.close();
    } finally {
      if (firstHarness.database.isOpen()) firstHarness.database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("should apply blacklist projection immediately while preserving reading state and queued time", async () => {
    const h = setup();
    seedStories(h.store, [story(1, { title: "TypeScript story" })]);
    const p = h.create();
    await p.rebuildProfile("initial");
    const before = h.store.queue.byStoryId(1)!;
    h.store.queue.updateState(1, "read", NOW);
    h.store.queue.markEvaluation({ storyId: 1, evaluationState: "failed", rankVersion: before.rankVersion, lastError: "old", at: NOW });
    await p.applyPreferenceChange([rule()]);
    const after = h.store.queue.byStoryId(1)!;
    expect(after).toMatchObject({ state: "read", evaluationState: "pending", visibilityState: "blacklisted", queuedAt: before.queuedAt });
    expect(after.lastError).toBeUndefined();
    expect(h.jobs.list({ kind: "personalization.score-pending", limit: 100 }).some((job) =>
      JSON.stringify(job.payload) === JSON.stringify({ profileId: h.store.profiles.current()!.id }))).toBe(true);
  });

  it("should roll back preference replacement when validation or job handoff fails", async () => {
    const h = setup();
    seedStories(h.store, [story(1)]);
    const p = h.create();
    const original = await p.rebuildProfile("initial");
    const jobs = h.jobs.list({ limit: 100 });
    await expect(p.applyPreferenceChange([{ ...rule(), normalizedValue: "not-normalized" }])).rejects.toMatchObject({ name: "InterestError", code: "invalid-rule" });
    expect(h.store.preferences.list()).toEqual([]);
    expect(h.store.profiles.current()).toEqual(original);
    expect(h.jobs.list({ limit: 100 })).toEqual(jobs);

    vi.spyOn(h.jobs, "enqueue").mockImplementation(() => { throw new Error("SECRET enqueue failure"); });
    await expect(p.applyPreferenceChange([rule()])).rejects.toThrow("SECRET enqueue failure");
    expect(h.store.preferences.list()).toEqual([]);
    expect(h.store.profiles.current()).toEqual(original);
    expect(h.store.profiles.history(undefined, 10)).toHaveLength(1);
    expect(h.store.queue.byStoryId(1)).toMatchObject({ visibilityState: "visible", rankVersion: h.store.queue.projection()!.rankVersion });
  });

  it("should surface missing referenced stories instead of silently dropping them", async () => {
    const h = setup();
    seedStories(h.store, [story(1)]);
    const p = h.create();
    await p.recordActivity([rawActivity(1)]);
    vi.spyOn(h.store.stories, "byId").mockReturnValue(undefined);
    await expect(p.rebuildProfile("missing")).rejects.toMatchObject({ name: "InterestError", code: "missing-story" });
    expect(h.store.profiles.current()).toBeUndefined();
  });
});
