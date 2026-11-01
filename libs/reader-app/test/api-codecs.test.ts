import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityError } from "@tmtp/activity";
import { HnIngestionError, hnIngestionJobCodecs } from "@tmtp/hn-ingestion";
import { PersonalizationError, personalizationJobCodecs } from "@tmtp/personalization";
import { QUEUE_BOOTSTRAP_RANK_VERSION } from "@tmtp/queue";
import {
  createReaderApp,
  READER_APP_JOB_PAYLOAD_SCHEMA_VERSION,
  ReaderAppError,
  readerAppBootstrapRankVersion,
  readerAppJobCodecs,
  readerAppJobFailure,
} from "../src/index.js";
import * as publicApi from "../src/index.js";
import manifest from "../package.json" with { type: "json" };
import { asLeased, cleanup, harness, NOW, rawActivity } from "./harness.js";

afterEach(cleanup);

describe("public API and strict boundaries", () => {
  it("exports exactly the documented runtime API and eight owner-ordered codecs", () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      "READER_APP_JOB_PAYLOAD_SCHEMA_VERSION", "ReaderAppError", "createReaderApp",
      "readerAppBootstrapRankVersion", "readerAppJobCodecs", "readerAppJobFailure",
    ].sort());
    expect(READER_APP_JOB_PAYLOAD_SCHEMA_VERSION).toBe(1);
    expect(readerAppBootstrapRankVersion()).toBe(QUEUE_BOOTSTRAP_RANK_VERSION);
    expect(readerAppJobCodecs.map((codec) => codec.kind)).toEqual([
      "article.fetch-extract", "personalization.record-activity",
      "ingestion.collect", "ingestion.reconcile-account",
      "personalization.profile-rebuild", "personalization.score-pending",
      "personalization.queue-project", "personalization.recover",
    ]);
    expect(readerAppJobCodecs.slice(2, 4)).toEqual(hnIngestionJobCodecs);
    expect(readerAppJobCodecs.slice(4)).toEqual(personalizationJobCodecs);
    expect(Object.keys(manifest.dependencies)).toHaveLength(9);
  });

  it("validates and snapshots construction options without invoking callbacks", () => {
    const h = harness();
    const now = vi.fn(() => new Date(NOW));
    const createId = vi.fn(() => "id");
    const options = { ...h.options, now, createId };
    const app = createReaderApp(options);
    expect(now).not.toHaveBeenCalled();
    expect(createId).not.toHaveBeenCalled();
    options.queuePageSize = 1;
    options.now = () => new Date("invalid");
    return expect(app.getPreferences()).resolves.toEqual([]);
  });

  it("rejects unknown options and malformed limits with fixed field errors", () => {
    const h = harness();
    expect(() => createReaderApp({ ...h.options, extra: true } as never)).toThrow("options");
    expect(() => createReaderApp({ ...h.options, queuePageSize: 0 })).toThrow("queuePageSize");
    expect(() => createReaderApp({ ...h.options, queuePageSize: 4 })).toThrow("queuePageSize");
    expect(() => createReaderApp({ ...h.options, jobs: {} } as never)).toThrow("jobs.enqueue");
  });

  it("validates input before cancellation or dependency side effects and preserves pre-abort reasons", async () => {
    const h = harness();
    const controller = new AbortController();
    const reason = { sentinel: "private-abort" };
    controller.abort(reason);
    await expect(h.app.getStory(0, controller.signal)).rejects.toMatchObject({ code: "invalid-input", field: "storyId" });
    await expect(h.app.getStory(1, controller.signal)).rejects.toBe(reason);
    await expect(h.app.getQueue({ cursor: "bad" })).rejects.toMatchObject({ code: "invalid-cursor" });
    await expect(h.app.getActivity({ afterEventId: "ses_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(h.app.performHnAction({ storyId: 1, action: "upvote", idempotencyKey: "secret\n" })).rejects.toMatchObject({ code: "invalid-input" });
    expect(h.accountPerform).not.toHaveBeenCalled();
  });

  it("normalizes malformed preference timestamps to invalid input before delegation", async () => {
    const h = harness();
    const rule = {
      id: "rule-1", kind: "topic", effect: "include", value: "TypeScript", normalizedValue: "typescript",
      enabled: true, createdAt: "2026-13-01T00:00:00.000Z", updatedAt: NOW,
    };
    await expect(h.app.replacePreferences([rule] as never)).rejects.toMatchObject({ code: "invalid-input", field: "rules.0" });
    expect(h.personalization.applyPreferenceChange).not.toHaveBeenCalled();
  });

  it("maps errors to fixed safe facade DTOs without public causes", async () => {
    const h = harness();
    vi.mocked(h.ingestion.collectPublic).mockRejectedValue(new HnIngestionError("upstream-failure", {
      operation: "collect-public", retryable: true, dependency: "hn-public-api", dependencyCode: "timeout",
    }));
    const error = await h.app.runIngestion().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ReaderAppError);
    expect(error).toMatchObject({
      code: "dependency-failure", operation: "run-ingestion", retryable: true,
      dependency: "hn-ingestion", dependencyCode: "upstream-failure",
      message: "Reader application dependency operation failed.",
    });
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("secret");
    vi.mocked(h.personalization.recordActivity).mockRejectedValue(new ActivityError("invalid-activity"));
    await expect(h.app.recordActivity([rawActivity("A".repeat(43))])).rejects.toMatchObject({ dependency: "activity", dependencyCode: "invalid-activity" });
  });
});

describe("codecs and worker failure mapping", () => {
  it("validates local payloads strictly and returns fresh values", () => {
    const article = readerAppJobCodecs[0]!;
    const input = { storyId: 1, storyContentVersion: "source-1" };
    const first = article.decode(input, 1) as typeof input;
    const second = article.decode(input, 1) as typeof input;
    expect(first).toEqual(input);
    expect(first).not.toBe(second);
    expect(() => article.decode({ ...input, extra: true }, 1)).toThrow("Invalid reader application job payload.");
    expect(() => article.decode(input, 2)).toThrow("Invalid reader application job payload.");
    const activity = readerAppJobCodecs[1]!;
    const raw = rawActivity("A".repeat(43));
    const activityInput = { batch: [raw] };
    const decoded = activity.decode(activityInput, 1) as { batch: unknown[] };
    expect(decoded.batch).toEqual([raw]);
    expect(decoded.batch).not.toBe(activityInput.batch);
    expect(() => activity.decode({ batch: [raw, raw] }, 1)).toThrow("Invalid reader application job payload.");
    const reconciliation = { clientEventId: "B".repeat(43), storyId: 1, kind: "upvote", source: "hn-reconciliation", value: { present: false } };
    expect(activity.decode({ batch: [reconciliation] }, 1)).toEqual({ batch: [reconciliation] });
  });

  it("maps facade, article, owner, and unsupported failures without inspecting unsupported errors", () => {
    const failed = new ReaderAppError("article-attempt-failed", {
      operation: "run-job", retryable: true, dependencyCode: "timeout",
    });
    expect(readerAppJobFailure("article.fetch-extract", failed)).toEqual({
      code: "article:timeout", message: "Article extraction attempt failed.", retryable: true,
    });
    expect(readerAppJobFailure("article.fetch-extract", new ReaderAppError("cancelled", { operation: "run-job", retryable: true }))).toMatchObject({ code: "cancelled", retryable: true });
    expect(readerAppJobFailure("ingestion.collect", new ReaderAppError("not-found", { operation: "run-job", retryable: false }))).toMatchObject({ code: "not-found", retryable: false });
    expect(readerAppJobFailure("personalization.recover", new PersonalizationError("scoring-retryable"))).toMatchObject({ code: "personalization:scoring-retryable", retryable: true });
    const poison = new Proxy({}, { get() { throw new Error("must not inspect"); } });
    expect(readerAppJobFailure("unknown", poison)).toEqual({ code: "invalid-job", message: "Reader application job is invalid.", retryable: false });
    expect(readerAppJobFailure("article.fetch-extract", new Error("private"))).toEqual({ code: "reader-app-failed", message: "Reader application job failed.", retryable: true });
  });

  it("dispatches all non-article kinds once with decoded payloads and identical signals", async () => {
    const h = harness();
    const signal = new AbortController().signal;
    const raw = rawActivity("A".repeat(43));
    await h.app.runJob(asLeased({ id: "a", kind: "personalization.record-activity", payload: { batch: [raw] }, payloadSchemaVersion: 1, status: "queued", runAfter: NOW, attempts: 0, maxAttempts: 3, createdAt: NOW, updatedAt: NOW }), signal);
    expect(h.personalization.recordActivity).toHaveBeenCalledWith([raw], signal);
    await h.app.runJob(asLeased({ id: "b", kind: "ingestion.collect", payload: {}, payloadSchemaVersion: 1, status: "queued", runAfter: NOW, attempts: 0, maxAttempts: 3, createdAt: NOW, updatedAt: NOW }), signal);
    await h.app.runJob(asLeased({ id: "c", kind: "ingestion.reconcile-account", payload: {}, payloadSchemaVersion: 1, status: "queued", runAfter: NOW, attempts: 0, maxAttempts: 3, createdAt: NOW, updatedAt: NOW }), signal);
    expect(h.ingestion.collectPublic).toHaveBeenCalledWith(signal);
    expect(h.ingestion.reconcileAccount).toHaveBeenCalledWith(signal);
    for (const codec of personalizationJobCodecs) {
      const payload = codec.kind === "personalization.profile-rebuild"
        ? { reason: "test", rulesVersion: "r", activityVersion: "a" }
        : codec.kind === "personalization.recover" ? {} : { profileId: "p" };
      await h.app.runJob(asLeased({ id: codec.kind, kind: codec.kind, payload, payloadSchemaVersion: 1, status: "queued", runAfter: NOW, attempts: 0, maxAttempts: 3, createdAt: NOW, updatedAt: NOW }), signal);
    }
    expect(h.personalization.runJob).toHaveBeenCalledTimes(4);
  });

  it("normalizes job cancellation and rejects malformed or unleased jobs safely", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort({ secret: true });
    const job = asLeased({ id: "job", kind: "ingestion.collect", payload: {}, payloadSchemaVersion: 1, status: "queued", runAfter: NOW, attempts: 0, maxAttempts: 3, createdAt: NOW, updatedAt: NOW });
    await expect(h.app.runJob(job, controller.signal)).rejects.toMatchObject({ code: "cancelled", retryable: true, message: "Reader application operation was cancelled." });
    await expect(h.app.runJob({ ...job, status: "queued" } as never)).rejects.toMatchObject({ code: "invalid-job" });
    await expect(h.app.runJob({ ...job, payloadSchemaVersion: 2 })).rejects.toMatchObject({ code: "invalid-job" });
  });
});
