import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HnActionResult } from "@tmtp/hn-account";
import { cleanup, harness, intent, LATER, NOW, story } from "./harness.js";

afterEach(cleanup);

function verified(intentId: string, observedAt = NOW): HnActionResult {
  return { intentId, status: "verified", observedAt };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("durable HN intents, outcomes, and activity outbox", () => {
  it("commits intent before account and verified outcome plus exact activity handoff after it", async () => {
    const h = harness(true);
    h.store.stories.upsertBatch([story(1)]);
    let observedIntent = false;
    h.accountPerform.mockImplementation(async (stored) => {
      observedIntent = h.store.hnActions.byId(stored.id) !== undefined;
      return verified(stored.id);
    });
    const result = await h.app.performHnAction({ storyId: 1, action: "upvote", idempotencyKey: "action-key" });
    expect(observedIntent).toBe(true);
    expect(result.status).toBe("verified");
    const stored = h.store.hnActions.byIdempotencyKey("action-key")!;
    expect(stored.status).toBe("verified");
    expect(stored.result).toEqual(result);
    const jobs = h.jobs.list({ kind: "personalization.record-activity", limit: 10 });
    expect(jobs).toHaveLength(1);
    const expectedId = createHash("sha256").update(`tmtp/hn-action-activity/1\0${stored.id}`, "utf8").digest("base64url");
    expect(jobs[0]).toMatchObject({ dedupeKey: expectedId, runAfter: NOW });
    expect(jobs[0]!.payload).toEqual({ batch: [{
      clientEventId: expectedId, storyId: 1, kind: "upvote", source: "app-action", value: { present: true }, occurredAt: NOW,
    }] });

    await expect(h.app.performHnAction({ storyId: 1, action: "upvote", idempotencyKey: "action-key" })).resolves.toEqual(result);
    expect(h.accountPerform).toHaveBeenCalledTimes(1);
    expect(h.jobs.list({ kind: "personalization.record-activity", limit: 10 })).toHaveLength(1);
  });

  it("replays adapter and reconciliation evidence without an account and ensures verified replay activity", async () => {
    const adapterHarness = harness();
    adapterHarness.store.stories.upsertBatch([story(1)]);
    const result = verified("stored-adapter", LATER);
    adapterHarness.store.hnActions.createIntent(intent("stored-adapter", 1, {
      status: "verified", result, resultSchemaVersion: 1, updatedAt: LATER,
    }));
    await expect(adapterHarness.app.performHnAction({ storyId: 1, action: "upvote", idempotencyKey: "key-stored-adapter" })).resolves.toEqual(result);
    expect(adapterHarness.jobs.list({ kind: "personalization.record-activity", limit: 10 })).toHaveLength(1);

    const reconciliationHarness = harness();
    reconciliationHarness.store.stories.upsertBatch([story(1)]);
    reconciliationHarness.store.hnActions.createIntent(intent("stored-reconciliation", 1, {
      status: "verified", result: { source: "hn-reconciliation", observedAt: LATER }, resultSchemaVersion: 1, updatedAt: LATER,
    }));
    await expect(reconciliationHarness.app.performHnAction({ storyId: 1, action: "upvote", idempotencyKey: "key-stored-reconciliation" })).resolves.toEqual({
      intentId: "stored-reconciliation", status: "verified", observedAt: LATER,
    });
    expect(reconciliationHarness.jobs.list({ kind: "personalization.record-activity", limit: 10 })).toHaveLength(1);
  });

  it("replays failed results without work and requires an account for pending retries", async () => {
    const h = harness();
    h.store.stories.upsertBatch([story(1)]);
    const failure: HnActionResult = { intentId: "failed-intent", status: "failed", observedAt: NOW, errorCode: "session-expired" };
    h.store.hnActions.createIntent(intent("failed-intent", 1, {
      status: "failed", result: failure, resultSchemaVersion: 1, errorCode: "session-expired",
    }));
    h.store.hnActions.createIntent(intent("pending-intent", 1));
    await expect(h.app.performHnAction({ storyId: 1, action: "upvote", idempotencyKey: "key-failed-intent" })).resolves.toEqual(failure);
    await expect(h.app.performHnAction({ storyId: 1, action: "upvote", idempotencyKey: "key-pending-intent" })).rejects.toMatchObject({ code: "account-not-configured" });
    expect(h.jobs.list({ kind: "personalization.record-activity", limit: 10 })).toEqual([]);
  });

  it("rejects malformed non-verified outcomes and terminal evidence without persisting them", async () => {
    const h = harness(true);
    h.store.stories.upsertBatch([story(1)]);
    h.accountPerform.mockImplementation(async (stored) => ({ intentId: stored.id, status: "failed", observedAt: NOW }));
    const command = { storyId: 1, action: "upvote" as const, idempotencyKey: "malformed-outcome" };
    await expect(h.app.performHnAction(command)).rejects.toMatchObject({ code: "dependency-failure", dependency: "hn-account", dependencyCode: "invalid-result" });
    expect(h.store.hnActions.byIdempotencyKey(command.idempotencyKey)?.status).toBe("pending");
    expect(h.store.hnActions.byIdempotencyKey(command.idempotencyKey)?.result).toBeUndefined();

    const stored = h.store.hnActions.byIdempotencyKey(command.idempotencyKey)!;
    h.store.hnActions.updateOutcome({
      ...stored,
      status: "failed",
      result: { intentId: stored.id, status: "failed", observedAt: NOW },
      resultSchemaVersion: 1,
      updatedAt: NOW,
    });
    await expect(h.app.performHnAction(command)).rejects.toMatchObject({ code: "dependency-failure", dependency: "reader-store", dependencyCode: "invalid-result" });
  });

  it("preserves indeterminate state when a later pre-dispatch attempt fails", async () => {
    const h = harness(true);
    h.store.stories.upsertBatch([story(1)]);
    const prior: HnActionResult = { intentId: "uncertain", status: "indeterminate", observedAt: NOW, errorCode: "post-outcome-unknown" };
    h.store.hnActions.createIntent(intent("uncertain", 1, {
      status: "indeterminate", result: prior, resultSchemaVersion: 1, errorCode: "post-outcome-unknown",
    }));
    h.accountPerform.mockResolvedValue({ intentId: "uncertain", status: "failed", observedAt: LATER, errorCode: "session-expired" });
    const result = await h.app.performHnAction({ storyId: 1, action: "upvote", idempotencyKey: "key-uncertain" });
    expect(result).toEqual({ intentId: "uncertain", status: "indeterminate", observedAt: LATER, errorCode: "session-expired" });
    expect(h.store.hnActions.byId("uncertain")).toMatchObject({ status: "indeterminate", errorCode: "session-expired", result });
    expect(h.jobs.list({ kind: "personalization.record-activity", limit: 10 })).toEqual([]);
  });

  it("joins identical commands, rejects conflicting reuse, and isolates follower cancellation", async () => {
    const h = harness(true);
    h.store.stories.upsertBatch([story(1)]);
    const pending = deferred<HnActionResult>();
    h.accountPerform.mockImplementation(async (stored) => {
      expect(h.store.hnActions.byId(stored.id)?.status).toBe("pending");
      return pending.promise;
    });
    const leader = h.app.performHnAction({ storyId: 1, action: "upvote", idempotencyKey: "shared" });
    const followerController = new AbortController();
    const followerReason = { follower: true };
    const follower = h.app.performHnAction({ storyId: 1, action: "upvote", idempotencyKey: "shared" }, followerController.signal);
    await vi.waitFor(() => expect(h.accountPerform).toHaveBeenCalledTimes(1));
    await expect(h.app.performHnAction({ storyId: 1, action: "flag", idempotencyKey: "shared" })).rejects.toMatchObject({ code: "conflict" });
    followerController.abort(followerReason);
    await expect(follower).rejects.toBe(followerReason);
    const stored = h.store.hnActions.byIdempotencyKey("shared")!;
    pending.resolve(verified(stored.id));
    await expect(leader).resolves.toMatchObject({ status: "verified" });
    expect(h.accountPerform).toHaveBeenCalledTimes(1);
  });

  it("persists a post-dispatch outcome after leader cancellation and never shares the leader reason", async () => {
    const h = harness(true);
    h.store.stories.upsertBatch([story(1)]);
    const pending = deferred<HnActionResult>();
    h.accountPerform.mockReturnValue(pending.promise);
    const leaderController = new AbortController();
    const leaderReason = { leaderSecret: true };
    const command = { storyId: 1, action: "upvote" as const, idempotencyKey: "cancel-shared" };
    const leader = h.app.performHnAction(command, leaderController.signal);
    const follower = h.app.performHnAction(command);
    await vi.waitFor(() => expect(h.accountPerform).toHaveBeenCalledTimes(1));
    const stored = h.store.hnActions.byIdempotencyKey(command.idempotencyKey)!;
    leaderController.abort(leaderReason);
    await expect(leader).rejects.toBe(leaderReason);
    pending.resolve({ intentId: stored.id, status: "indeterminate", observedAt: NOW, errorCode: "cancelled-after-dispatch" });
    await expect(follower).resolves.toMatchObject({ status: "indeterminate", errorCode: "cancelled-after-dispatch" });
    expect(h.store.hnActions.byId(stored.id)?.status).toBe("indeterminate");

    const rejected = deferred<HnActionResult>();
    h.accountPerform.mockImplementation((_intent, signal) => {
      signal?.addEventListener("abort", () => rejected.reject(signal.reason), { once: true });
      return rejected.promise;
    });
    const secondLeaderController = new AbortController();
    const secondReason = { doNotShare: true };
    const secondCommand = { ...command, idempotencyKey: "cancel-before-outcome" };
    const secondLeader = h.app.performHnAction(secondCommand, secondLeaderController.signal);
    const secondFollower = h.app.performHnAction(secondCommand);
    await vi.waitFor(() => expect(h.accountPerform).toHaveBeenCalledTimes(2));
    secondLeaderController.abort(secondReason);
    await expect(secondLeader).rejects.toBe(secondReason);
    await expect(secondFollower).rejects.toMatchObject({ code: "cancelled", retryable: true });
    expect(JSON.stringify(await secondFollower.catch((error) => error))).not.toContain("doNotShare");
  });

  it("returns local capabilities and durable schedules without direct HN calls", async () => {
    const h = harness();
    expect(await h.app.getHnCapabilities()).toEqual([
      { name: "upvoted", state: "unavailable", reason: "capability-disabled" },
      { name: "favorites", state: "unavailable", reason: "capability-disabled" },
      { name: "flagged", state: "unavailable", reason: "capability-disabled" },
      { name: "mutations", state: "unavailable", reason: "capability-disabled" },
    ]);
    const first = await h.app.scheduleIngestion();
    const deduped = await h.app.scheduleIngestion();
    expect(deduped.id).toBe(first.id);
    expect(first).toMatchObject({ kind: "ingestion.collect", payload: {}, payloadSchemaVersion: 1, dedupeKey: "ingestion.collect" });
    await expect(h.app.scheduleHnReconciliation()).rejects.toMatchObject({ code: "account-not-configured" });
    expect(h.ingestion.collectPublic).not.toHaveBeenCalled();
    expect(h.ingestion.reconcileAccount).not.toHaveBeenCalled();

    const withAccount = harness(true);
    const reconciliation = await withAccount.app.scheduleHnReconciliation();
    expect(reconciliation).toMatchObject({ kind: "ingestion.reconcile-account", dedupeKey: "ingestion.reconcile-account" });
    expect(withAccount.accountPerform).not.toHaveBeenCalled();
  });

  it("rolls back a verified outcome when its activity handoff fails and reconciles on retry", async () => {
    const h = harness(true);
    h.store.stories.upsertBatch([story(1)]);
    h.accountPerform.mockImplementation(async (stored) => verified(stored.id));
    const enqueue = vi.spyOn(h.jobs, "enqueue").mockImplementation(() => { throw new Error("private database details"); });
    const command = { storyId: 1, action: "upvote" as const, idempotencyKey: "rollback" };
    const error = await h.app.performHnAction(command).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "internal-failure", message: "Reader application failed unexpectedly." });
    expect(JSON.stringify(error)).not.toContain("private database details");
    expect(h.store.hnActions.byIdempotencyKey(command.idempotencyKey)?.status).toBe("pending");
    expect(h.jobs.list({ kind: "personalization.record-activity", limit: 10 })).toEqual([]);
    enqueue.mockRestore();
    await expect(h.app.performHnAction(command)).resolves.toMatchObject({ status: "verified" });
    expect(h.accountPerform).toHaveBeenCalledTimes(2);
    expect(h.store.hnActions.byIdempotencyKey(command.idempotencyKey)?.status).toBe("verified");
  });

  it("replays a committed outcome without new work after closing and reopening SQLite", async () => {
    const h = harness(true);
    h.store.stories.upsertBatch([story(1)]);
    h.accountPerform.mockImplementation(async (stored) => verified(stored.id));
    const command = { storyId: 1, action: "upvote" as const, idempotencyKey: "restart" };
    const first = await h.app.performHnAction(command);
    const path = h.path;
    h.database.close();
    const reopened = harness(false, 2, 3, path);
    await expect(reopened.app.performHnAction(command)).resolves.toEqual(first);
    expect(reopened.jobs.list({ kind: "personalization.record-activity", limit: 10 })).toHaveLength(1);
  });
});
