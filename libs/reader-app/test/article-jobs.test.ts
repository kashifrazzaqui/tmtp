import { afterEach, describe, expect, it, vi } from "vitest";
import { ARTICLE_READER_VERSION } from "@tmtp/article-reader";
import { JobQueueError } from "@tmtp/job-queue";
import { readerAppJobCodecs, readerAppJobFailure } from "../src/index.js";
import { cleanup, failedArticle, harness, LATER, NOW, queueEntry, readyArticle, story } from "./harness.js";

afterEach(cleanup);

function readResult(article: ReturnType<typeof readyArticle> | ReturnType<typeof failedArticle>) {
  return article.status === "ready"
    ? { outcome: "ready" as const, article, originalUrl: "https://example.com/1" }
    : {
      outcome: "failed" as const,
      article,
      originalUrl: "https://example.com/1",
      failure: { category: "fetch" as const, code: "timeout" as const, message: "Article fetch timed out.", retryable: true },
    };
}

async function refreshAndClaim(h: ReturnType<typeof harness>, storyId = 1) {
  await h.app.refreshArticle(storyId);
  const claim = h.jobs.claim(["article.fetch-extract"]);
  expect(claim.status).toBe("leased");
  return claim.status === "leased" ? claim.job : undefined;
}

describe("article refresh and conditional persistence", () => {
  it("enqueues canonical deduped work and no-ops a current ready replay", async () => {
    const h = harness();
    h.store.stories.upsertBatch([story(1)]);
    h.store.articles.upsert(readyArticle(1, "story-v1", ARTICLE_READER_VERSION));
    const first = await h.app.refreshArticle(1);
    const duplicate = await h.app.refreshArticle(1);
    expect(duplicate.id).toBe(first.id);
    expect(first).toMatchObject({
      kind: "article.fetch-extract", payloadSchemaVersion: 1,
      payload: { storyId: 1, storyContentVersion: "story-v1" }, dedupeKey: "1:story-v1", runAfter: NOW,
    });
    const claim = h.jobs.claim(["article.fetch-extract"]);
    expect(claim.status).toBe("leased");
    if (claim.status !== "leased") return;
    await h.app.runJob(claim.job);
    expect(h.articleRead).not.toHaveBeenCalled();
    h.jobs.complete(claim.job.id, claim.job.leaseToken!);
    expect(h.jobs.get(first.id)?.status).toBe("done");
  });

  it("retries a same-source current-pipeline failed record and persists ready content", async () => {
    const h = harness();
    h.store.stories.upsertBatch([story(1)]);
    h.store.queue.upsertRankingPreservingState([queueEntry(1, "rank")]);
    h.store.articles.upsert(failedArticle(1, "story-v1", ARTICLE_READER_VERSION));
    const ready = readyArticle(1, "story-v1", ARTICLE_READER_VERSION);
    h.articleRead.mockResolvedValue(readResult(ready));
    const job = await refreshAndClaim(h);
    await h.app.runJob(job!);
    expect(h.articleRead).toHaveBeenCalledWith(story(1), undefined);
    expect(h.store.articles.byStoryId(1)).toEqual(ready);
  });

  it("commits a failed outcome before throwing its safe retryable article failure", async () => {
    const h = harness();
    h.store.stories.upsertBatch([story(1)]);
    const failed = failedArticle(1, "story-v1", ARTICLE_READER_VERSION);
    h.articleRead.mockResolvedValue(readResult(failed));
    const job = await refreshAndClaim(h);
    const error = await h.app.runJob(job!).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "article-attempt-failed", retryable: true, dependencyCode: "timeout" });
    expect(h.store.articles.byStoryId(1)).toEqual(failed);
    expect(readerAppJobFailure(job!.kind, error)).toEqual({ code: "article:timeout", message: "Article extraction attempt failed.", retryable: true });
    h.jobs.fail(job!.id, job!.leaseToken!, readerAppJobFailure(job!.kind, error));
    expect(h.jobs.get(job!.id)).toMatchObject({ status: "queued", lastErrorCode: "article:timeout" });
  });

  it("no-ops stale payloads and discards commit-time stale-source outcomes", async () => {
    const stalePayload = harness();
    stalePayload.store.stories.upsertBatch([story(1)]);
    await stalePayload.app.refreshArticle(1);
    stalePayload.store.stories.upsertBatch([story(1, "story-v2")]);
    const staleClaim = stalePayload.jobs.claim(["article.fetch-extract"]);
    if (staleClaim.status !== "leased") throw new Error("Expected article lease");
    await stalePayload.app.runJob(staleClaim.job);
    expect(stalePayload.articleRead).not.toHaveBeenCalled();

    const h = harness();
    h.store.stories.upsertBatch([story(1)]);
    h.articleRead.mockImplementation(async () => {
      h.store.stories.upsertBatch([story(1, "story-v2")]);
      return readResult(readyArticle(1, "story-v1", ARTICLE_READER_VERSION));
    });
    const job = await refreshAndClaim(h);
    await h.app.runJob(job!);
    expect(h.store.articles.byStoryId(1)).toBeUndefined();
  });

  it("keeps a newer same-source ready result when an older failed attempt settles later", async () => {
    const h = harness();
    h.store.stories.upsertBatch([story(1)]);
    const ready = readyArticle(1, "story-v1", ARTICLE_READER_VERSION);
    h.articleRead.mockImplementation(async () => {
      h.store.articles.upsert(ready);
      return readResult(failedArticle(1, "story-v1", ARTICLE_READER_VERSION));
    });
    const job = await refreshAndClaim(h);
    await expect(h.app.runJob(job!)).resolves.toBeUndefined();
    expect(h.store.articles.byStoryId(1)).toEqual(ready);
  });

  it("normalizes cancellation without writing a synthetic article and maps unknown failures generically", async () => {
    const h = harness();
    h.store.stories.upsertBatch([story(1)]);
    const controller = new AbortController();
    const reason = { privateAbort: true };
    h.articleRead.mockImplementation(async (_story, signal) => {
      controller.abort(reason);
      throw signal.reason;
    });
    const job = await refreshAndClaim(h);
    await expect(h.app.runJob(job!, controller.signal)).rejects.toMatchObject({ code: "cancelled", retryable: true });
    expect(h.store.articles.byStoryId(1)).toBeUndefined();

    const unknown = harness();
    unknown.store.stories.upsertBatch([story(1)]);
    unknown.articleRead.mockRejectedValue(new Error("private parser details"));
    const unknownJob = await refreshAndClaim(unknown);
    const error = await unknown.app.runJob(unknownJob!).catch((value: unknown) => value);
    expect(readerAppJobFailure(unknownJob!.kind, error)).toEqual({ code: "reader-app-failed", message: "Reader application job failed.", retryable: true });
    expect(unknown.store.articles.byStoryId(1)).toBeUndefined();
  });

  it("commits an already-returned ready outcome before reporting job cancellation", async () => {
    const h = harness();
    h.store.stories.upsertBatch([story(1)]);
    const controller = new AbortController();
    const ready = readyArticle(1, "story-v1", ARTICLE_READER_VERSION);
    h.articleRead.mockImplementation(async () => {
      controller.abort({ privateReason: true });
      return readResult(ready);
    });
    const job = await refreshAndClaim(h);
    await expect(h.app.runJob(job!, controller.signal)).rejects.toMatchObject({ code: "cancelled", retryable: true });
    expect(h.store.articles.byStoryId(1)).toEqual(ready);
  });

  it("preserves committed effects across lease loss and suppresses duplicate work on recovery", async () => {
    const h = harness();
    h.store.stories.upsertBatch([story(1)]);
    h.articleRead.mockResolvedValue(readResult(readyArticle(1, "story-v1", ARTICLE_READER_VERSION)));
    const job = await refreshAndClaim(h);
    await h.app.runJob(job!);
    h.setNow("2026-02-01T00:00:02.000Z");
    expect(h.jobs.recoverExpired()).toBe(1);
    expect(() => h.jobs.complete(job!.id, job!.leaseToken!)).toThrow(JobQueueError);
    expect(h.store.articles.byStoryId(1)?.status).toBe("ready");
    const recovered = h.jobs.claim(["article.fetch-extract"]);
    expect(recovered.status).toBe("leased");
    if (recovered.status !== "leased") return;
    await h.app.runJob(recovered.job);
    expect(h.articleRead).toHaveBeenCalledTimes(1);
    h.jobs.complete(recovered.job.id, recovered.job.leaseToken!);
  });

  it("contains poison claims without dispatch and runs only leased jobs in a real worker loop", async () => {
    const h = harness();
    h.store.stories.upsertBatch([story(1)]);
    h.articleRead.mockResolvedValue(readResult(readyArticle(1, "story-v1", ARTICLE_READER_VERSION)));
    h.database.execute(`INSERT INTO jobs (
      id, kind, payload, payload_schema_version, dedupe_key, status, run_after,
      lease_token, lease_expires_at, attempts, max_attempts, last_error_code, last_error,
      created_at, updated_at, completed_at
    ) VALUES ('poison', 'article.fetch-extract', '{bad', 1, NULL, 'queued', ?, NULL, NULL, 0, 3, NULL, NULL, ?, ?, NULL)`, [NOW, NOW, NOW]);
    const rejected = h.jobs.claim(readerAppJobCodecs.map((codec) => codec.kind));
    expect(rejected.status).toBe("rejected");
    expect(h.articleRead).not.toHaveBeenCalled();
    expect(rejected.status === "rejected" && rejected.job.lastErrorCode).toBe("invalid-payload");
    await h.app.refreshArticle(1);
    const leased = h.jobs.claim(readerAppJobCodecs.map((codec) => codec.kind));
    expect(leased.status).toBe("leased");
    if (leased.status === "leased") {
      await h.app.runJob(leased.job);
      h.jobs.complete(leased.job.id, leased.job.leaseToken!);
    }
    expect(h.jobs.claim(readerAppJobCodecs.map((codec) => codec.kind)).status).toBe("idle");
  });
});

describe("simple delegates", () => {
  it("forwards complete activity, preference, profile, recovery, and ingestion values and signals", async () => {
    const h = harness(true);
    const signal = new AbortController().signal;
    const batch = [
      { clientEventId: "A".repeat(43), storyId: 1, kind: "open" as const, occurredAt: NOW, source: "embedded-reader" as const },
      { clientEventId: "B".repeat(43), storyId: 1, kind: "dwell" as const, occurredAt: NOW, source: "embedded-reader" as const, value: { activeMs: 10 } },
    ];
    vi.mocked(h.personalization.recordActivity).mockResolvedValue({ accepted: 2, profileWorkEnqueued: true });
    await expect(h.app.recordActivity(batch, signal)).resolves.toEqual({ accepted: 2, profileWorkEnqueued: true });
    expect(h.personalization.recordActivity).toHaveBeenCalledWith(batch, signal);
    await h.app.replacePreferences([], signal);
    expect(h.personalization.applyPreferenceChange).toHaveBeenCalledWith([], signal);
    await h.app.rebuildPersonalization("manual", signal);
    expect(h.personalization.rebuildProfile).toHaveBeenCalledWith("manual", signal);
    await expect(h.app.runPersonalization(signal)).resolves.toMatchObject({ completion: "complete", scored: 1, failed: 2, retryableFailed: 3, queued: 4, audits: 5, rebuilt: true });
    await expect(h.app.runIngestion(signal)).resolves.toMatchObject({ runId: "run-1", jobsEnqueued: 3 });
    await expect(h.app.reconcileHnAccount(signal)).resolves.toMatchObject({ runId: "run-2", skippedUnknownStories: 1, activityJobsEnqueued: 2 });
    await expect(h.app.getHnCapabilities(signal)).resolves.toHaveLength(4);
  });

  it("rejects mixed-story activity without splitting or invoking the delegate", async () => {
    const h = harness();
    const batch = [
      { clientEventId: "A".repeat(43), storyId: 1, kind: "open" as const, occurredAt: NOW, source: "embedded-reader" as const },
      { clientEventId: "B".repeat(43), storyId: 2, kind: "open" as const, occurredAt: NOW, source: "embedded-reader" as const },
    ];
    await expect(h.app.recordActivity(batch)).rejects.toMatchObject({ code: "invalid-input", field: "batch" });
    expect(h.personalization.recordActivity).not.toHaveBeenCalled();
  });
});
