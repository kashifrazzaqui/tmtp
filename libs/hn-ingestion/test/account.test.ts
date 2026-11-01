import type { HnActionIntent, HnActionKind } from "@tmtp/domain";
import { JobQueueError } from "@tmtp/job-queue";
import { describe, expect, it, vi } from "vitest";
import { OLD, setup, story, TIME } from "./harness.js";

const CAPABILITIES = [
  { name: "upvoted", state: "available" }, { name: "favorites", state: "available" },
  { name: "flagged", state: "unavailable", reason: "capability-disabled" },
  { name: "mutations", state: "unverified", reason: "capability-unverified" },
] as const;
function observation(storyId: number, kind: "upvote" | "favorite" | "flag", present = true, observedAt = TIME) {
  return { storyId, kind, present, observedAt };
}
function accountFixture() {
  return {
    validateSession: vi.fn(async () => ({ username: "alice" })),
    capabilities: vi.fn(async () => CAPABILITIES.map((capability) => ({ ...capability }))),
    readUpvoted: vi.fn(async () => ({ observations: [] })),
    readFavorites: vi.fn(async () => ({ observations: [] })),
    readFlagged: vi.fn(async () => ({ observations: [] })),
    performAction: vi.fn(),
  };
}
function intent(id: string, storyId: number, action: HnActionKind, status: HnActionIntent["status"]): HnActionIntent {
  return { id, storyId, action, idempotencyKey: `key-${id}`, status, createdAt: OLD, updatedAt: OLD,
    ...(status === "indeterminate" ? { errorCode: "post-outcome-unknown" } : {}) };
}

describe("account current-state reconciliation", () => {
  it("should commit known observations, verify only positive matching intents, and outbox only changed evidence", async () => {
    const h = setup(); const account = accountFixture();
    try {
      h.store.stories.upsertBatch([story(1), story(2)]);
      h.store.hnActions.createIntent(intent("intent-1", 1, "upvote", "indeterminate"));
      h.store.hnActions.createIntent(intent("intent-2", 2, "favorite", "pending"));
      h.store.hnActions.createIntent(intent("intent-3", 2, "favorite", "indeterminate"));
      h.store.hnAccountStates.upsertObservations([{ username: "alice", storyId: 1, kind: "upvote", present: false,
        firstObservedAt: "2025-01-01T00:00:00.000Z", lastObservedAt: "2026-08-01T00:00:00.000Z", sourceCursor: "old-cursor" }]);
      account.readUpvoted.mockResolvedValue({ observations: [observation(1, "upvote"), observation(99, "upvote")], nextCursor: "next-up" });
      account.readFavorites.mockResolvedValue({ observations: [observation(2, "favorite", false)] });
      const ingestion = h.create({ account, refreshBatchSize: 2 });
      const first = await ingestion.reconcileAccount();
      expect(first).toMatchObject({ observations: 2, skippedUnknownStories: 1, activityJobsEnqueued: 2 });
      expect(first.capabilities).toEqual(CAPABILITIES);
      expect(h.store.stories.byId(99)).toBeUndefined();
      expect(h.store.hnAccountStates.byStoryIds("alice", "upvote", [1])[0]).toEqual({ username: "alice", storyId: 1, kind: "upvote", present: true,
        firstObservedAt: "2025-01-01T00:00:00.000Z", lastObservedAt: "2026-08-01T00:00:00.000Z" });
      expect(h.store.hnAccountStates.byStoryIds("alice", "favorite", [2])[0]).toMatchObject({ present: false, firstObservedAt: TIME, lastObservedAt: TIME });
      expect(h.store.hnActions.byId("intent-1")).toMatchObject({ status: "verified", result: { source: "hn-reconciliation", observedAt: TIME }, resultSchemaVersion: 1, updatedAt: TIME });
      expect(h.store.hnActions.byId("intent-1")).not.toHaveProperty("errorCode");
      expect(h.store.hnActions.byId("intent-2")?.status).toBe("pending");
      expect(h.store.hnActions.byId("intent-3")?.status).toBe("indeterminate");
      expect(account.readFlagged).not.toHaveBeenCalled(); expect(account.performAction).not.toHaveBeenCalled();
      const jobs = h.jobs.list({ limit: 100 });
      expect(jobs).toHaveLength(2);
      for (const job of jobs) {
        expect(job.kind).toBe("personalization.record-activity");
        const batch = (job.payload as { batch: Array<Record<string, unknown>> }).batch;
        expect(batch).toHaveLength(1);
        expect(batch[0]).toMatchObject({ storyId: expect.any(Number), source: "hn-reconciliation", value: { present: expect.any(Boolean) } });
        expect(batch[0]).not.toHaveProperty("occurredAt");
        expect(batch[0]?.clientEventId).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(job.dedupeKey).toBe(batch[0]?.clientEventId);
      }
      expect(h.store.sync.cursor("hn.account.upvote")).toBe('{"schemaVersion":1,"username":"alice","continuation":"next-up"}');
      expect(h.store.sync.cursor("hn.account.favorite")).toBe('{"schemaVersion":1,"username":"alice"}');
      expect(h.store.sync.latestRun("hn.account.reconcile")).toMatchObject({ status: "complete", storiesUpserted: 0, nonStoriesSkipped: 0 });

      const second = await ingestion.reconcileAccount();
      expect(second).toMatchObject({ observations: 2, skippedUnknownStories: 1, activityJobsEnqueued: 0 });
      expect(account.readUpvoted.mock.calls[1]?.[0]).toBe("next-up");
      expect(h.jobs.list({ limit: 100 })).toHaveLength(2);
      expect(h.store.hnAccountStates.byStoryIds("alice", "upvote", [1])[0]).toMatchObject({ sourceCursor: "next-up", lastObservedAt: "2026-08-01T00:00:00.000Z" });
    } finally { h.close(); }
  });

  it("should bind continuations to the validated username and skip unavailable flag reads", async () => {
    const h = setup(); const account = accountFixture();
    try {
      h.store.sync.setCursor("hn.account.upvote", '{"schemaVersion":1,"username":"bob","continuation":"bob-secret"}', OLD);
      const controller = new AbortController();
      await h.create({ account }).reconcileAccount(controller.signal);
      expect(account.readUpvoted).toHaveBeenCalledWith(undefined, controller.signal);
      expect(account.readFavorites).toHaveBeenCalledWith(undefined, controller.signal);
      expect(account.readFlagged).not.toHaveBeenCalled();
      expect(h.store.sync.cursor("hn.account.upvote")).toBe('{"schemaVersion":1,"username":"alice"}');
      expect(account.validateSession).toHaveBeenCalledWith(controller.signal);
      expect(account.capabilities).toHaveBeenCalledWith(controller.signal);
    } finally { h.close(); }
  });

  it("should roll back account state cursor and intent writes when activity handoff fails", async () => {
    const h = setup(); const account = accountFixture();
    try {
      h.store.stories.upsertBatch([story(1)]);
      h.store.hnActions.createIntent(intent("intent-1", 1, "upvote", "indeterminate"));
      account.readUpvoted.mockResolvedValue({ observations: [observation(1, "upvote")], nextCursor: "next" });
      h.jobs.enqueue = vi.fn(() => { throw new JobQueueError("invalid-payload", { cause: new Error("secret-account") }); });
      await expect(h.create({ account }).reconcileAccount()).rejects.toMatchObject({ code: "job-handoff-failure" });
      expect(h.store.hnAccountStates.current("alice")).toEqual([]);
      expect(h.store.hnActions.byId("intent-1")?.status).toBe("indeterminate");
      expect(h.store.sync.cursor("hn.account.upvote")).toBeUndefined();
      expect(h.jobs.list({ limit: 100 })).toEqual([]);
      const run = h.store.sync.latestRun("hn.account.reconcile");
      expect(run).toMatchObject({ status: "failed", errorCode: "job-handoff-failure", storiesUpserted: 0 });
      expect(JSON.stringify(run)).not.toContain("secret-account");
    } finally { h.close(); }
  });

  it("should not probe capabilities after a session-planning abort", async () => {
    const h = setup(); const account = accountFixture();
    let release!: (value: { username: string }) => void;
    account.validateSession.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    try {
      const controller = new AbortController(); const reason = { account: true };
      const pending = h.create({ account }).reconcileAccount(controller.signal);
      await vi.waitFor(() => { expect(account.validateSession).toHaveBeenCalledTimes(1); });
      controller.abort(reason); release({ username: "alice" });
      await expect(pending).rejects.toBe(reason);
      expect(account.capabilities).not.toHaveBeenCalled();
      expect(account.readUpvoted).not.toHaveBeenCalled();
      expect(h.store.sync.latestRun("hn.account.reconcile")).toMatchObject({ status: "failed", errorCode: "cancelled" });
    } finally { h.close(); }
  });
});
