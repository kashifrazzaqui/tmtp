import { DatabaseError } from "@tmtp/database";
import { InterestError } from "@tmtp/interests";
import type { LlmCallAudit } from "@tmtp/llm-interface";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPersonalizationJobEnqueue,
  personalizationJobCodecs,
  PersonalizationError,
  personalizationJobFailure,
} from "../src/index.js";
import type { PersonalizationErrorCode, PersonalizationJobDescription } from "../src/index.js";
import { audit, cleanup, makeJob, NOW, rawActivity, rule, setup } from "./harness.js";

afterEach(cleanup);

describe("public API jobs and safe errors", () => {
  it("should export exactly the public runtime surface and four version-one codecs", async () => {
    const module = await import("../src/index.js");
    expect(Object.keys(module).sort()).toEqual([
      "PERSONALIZATION_JOB_PAYLOAD_SCHEMA_VERSION",
      "PersonalizationError",
      "createPersonalization",
      "createPersonalizationJobEnqueue",
      "personalizationJobCodecs",
      "personalizationJobFailure",
    ]);
    expect(personalizationJobCodecs.map((codec) => [codec.kind, codec.currentVersion])).toEqual([
      ["personalization.profile-rebuild", 1],
      ["personalization.score-pending", 1],
      ["personalization.queue-project", 1],
      ["personalization.recover", 1],
    ]);
    expect(module.PERSONALIZATION_JOB_PAYLOAD_SCHEMA_VERSION).toBe(1);
  });

  it("should produce canonical dedupe keys and reject noncanonical job descriptions without value echo", () => {
    const description: PersonalizationJobDescription = {
      kind: "personalization.profile-rebuild",
      payload: { reason: "activity", rulesVersion: "rules-1", activityVersion: "9" },
      runAfter: NOW,
    };
    const first = createPersonalizationJobEnqueue(description);
    const otherReason = createPersonalizationJobEnqueue({ ...description, payload: { ...description.payload, reason: "manual" } });
    const trailing = createPersonalizationJobEnqueue({ ...description, payload: { ...description.payload, activityVersion: "10" } });
    expect(first.dedupeKey).toBe(JSON.stringify([description.kind, "rules-1", "9"]));
    expect(otherReason.dedupeKey).toBe(first.dedupeKey);
    expect(trailing.dedupeKey).not.toBe(first.dedupeKey);
    expect(createPersonalizationJobEnqueue({ kind: "personalization.score-pending", payload: { profileId: "p/1" }, runAfter: NOW }).dedupeKey)
      .toBe(JSON.stringify(["personalization.score-pending", "p/1"]));
    expect(createPersonalizationJobEnqueue({ kind: "personalization.queue-project", payload: { profileId: "p/1" }, runAfter: NOW }).dedupeKey)
      .toBe(JSON.stringify(["personalization.queue-project", "p/1"]));
    expect(createPersonalizationJobEnqueue({ kind: "personalization.recover", payload: {}, runAfter: NOW }).dedupeKey)
      .toBe(JSON.stringify(["personalization.recover"]));

    const invalid = [
      { ...description, payload: { ...description.payload, reason: "SECRET" }, extra: true },
      { ...description, payload: { ...description.payload, reason: " " } },
      { ...description, payload: { ...description.payload, rulesVersion: "x".repeat(257) } },
      { ...description, runAfter: "not-a-time" },
    ];
    for (const value of invalid) {
      expect(() => createPersonalizationJobEnqueue(value as PersonalizationJobDescription)).toThrowError(expect.objectContaining({ code: "invalid-input" }));
    }
    for (const codec of personalizationJobCodecs) {
      expect(() => codec.decode({ secret: "SECRET" }, 99)).toThrowError(TypeError);
      expect(() => codec.decode({ secret: "SECRET" }, 1)).toThrowError(/^Invalid personalization job payload\.$/);
    }
  });

  it("should validate complete options including zero budgets and safe option paths", () => {
    const h = setup();
    expect(() => h.create({ interestPolicy: { ...h.options.interestPolicy, maxActivityEvents: 0 } })).not.toThrow();
    expect(() => h.create({ recommendationPolicy: { ...h.options.recommendationPolicy, maxStoriesPerRun: 0 } })).not.toThrow();
    for (const create of [
      () => h.create({ activityBatchSize: 0 }),
      () => h.create({ queueSyncBatchSize: 1.5 }),
      () => h.create({ model: " SECRET " }),
      () => h.create({ interestPolicy: { ...h.options.interestPolicy, maxActivityEvents: -1 } }),
      () => h.create({ recommendationPolicy: { ...h.options.recommendationPolicy, explorationRatio: 0.6 } }),
      () => h.create({ activityPolicy: { ...h.options.activityPolicy, idleTimeoutMs: 0 } }),
      () => h.create({ jobs: {} as typeof h.jobs }),
      () => h.create({ extra: true } as never),
    ]) {
      expect(create).toThrowError(expect.objectContaining({ name: "PersonalizationError", code: "invalid-options", message: "Personalization options are invalid." }));
    }
  });

  it("should expose fixed safe error messages retryability and redacted worker failures", () => {
    const expectations: Array<[PersonalizationErrorCode, string, boolean]> = [
      ["invalid-options", "Personalization options are invalid.", false],
      ["invalid-input", "Personalization input is invalid.", false],
      ["invalid-job", "Personalization job is invalid.", false],
      ["activity-append-incomplete", "Activity replay data changed during append.", true],
      ["audit-conflict", "LLM audit identity conflicts with an existing record.", false],
      ["recommendation-conflict", "Recommendation identity conflicts with an existing record.", false],
      ["cancelled", "Personalization work was cancelled.", true],
      ["scoring-retryable", "Recommendation work needs a later retry.", true],
    ];
    for (const [code, message, retryable] of expectations) {
      const error = new PersonalizationError(code, { field: "input.field", jobId: "job-opaque" });
      expect(error).toMatchObject({ name: "PersonalizationError", code, message, retryable, field: "input.field", jobId: "job-opaque" });
      expect("cause" in error).toBe(false);
      expect(personalizationJobFailure(error)).toEqual({ code: `personalization:${code}`, message, retryable });
    }
    expect(personalizationJobFailure(new Error("SECRET prompt"))).toEqual({ code: "personalization-failed", message: "Personalization job failed.", retryable: true });
    expect(JSON.stringify(personalizationJobFailure(new InterestError("invalid-rule", "SECRET preference")))).not.toContain("SECRET");
    expect(personalizationJobFailure(new DatabaseError("busy", "SECRET database", { retryable: true }))).toEqual({
      code: "database:busy", message: "Personalization database work failed.", retryable: true,
    });
  });

  it("should validate direct calls before abort and make every pre-aborted operation a no-op", async () => {
    const h = setup();
    const p = h.create();
    await expect(p.rebuildProfile("SECRET".repeat(100))).rejects.toMatchObject({ code: "invalid-input", field: "reason" });
    await expect(p.scorePending({} as AbortSignal)).rejects.toMatchObject({ code: "invalid-input", field: "signal" });
    await expect(p.runJob(makeJob("personalization.recover", { secret: "SECRET" } as never))).rejects.toMatchObject({ code: "invalid-job", message: "Personalization job is invalid." });

    const controller = new AbortController();
    controller.abort(new Error("SECRET abort"));
    const transactions = h.journal.transactions;
    const jobs = h.jobs.list({ limit: 100 });
    await expect(p.recordActivity([rawActivity(1)], controller.signal)).rejects.toMatchObject({ code: "cancelled", message: "Personalization work was cancelled." });
    await expect(p.rebuildProfile("manual", controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    await expect(p.applyPreferenceChange([], controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    await expect(p.projectQueue(controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    await expect(p.runJob(makeJob("personalization.recover", {}), controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    await expect(p.scorePending(controller.signal)).resolves.toEqual({ completion: "cancelled", scored: 0, failed: 0, retryableFailed: 0, queued: 0, audits: 0 });
    await expect(p.recover(controller.signal)).resolves.toEqual({ completion: "cancelled", scored: 0, failed: 0, retryableFailed: 0, queued: 0, audits: 0, rebuilt: false });
    expect(h.journal.transactions).toBe(transactions);
    expect(h.scripted.calls).toBe(0);
    expect(h.jobs.list({ limit: 100 })).toEqual(jobs);
  });
});

describe("standalone audit persistence", () => {
  it("should make empty audits a no-op and persist mapped payloads while ignoring unknown properties", async () => {
    const h = setup();
    const now = vi.fn(() => h.clock.now());
    const p = h.create({ clock: { now, monotonicNowMs: () => 0 } });
    await p.persistLlmAudits([]);
    expect(now).not.toHaveBeenCalled();
    expect(h.journal.transactions).toBe(0);

    const captured = audit("probe", "success", {
      requestPayload: { request: true },
      requestPayloadSchemaVersion: 1,
      responsePayload: [{ response: true }],
      responsePayloadSchemaVersion: 2,
      unknown: { secret: "not-persisted" },
    } as Partial<LlmCallAudit>);
    await p.persistLlmAudits([captured]);
    expect(now).toHaveBeenCalledTimes(1);
    expect(h.journal.transactions).toBe(1);
    expect(h.store.llmCalls.byId("probe")).toMatchObject({
      id: "probe",
      createdAt: NOW,
      requestPayload: { request: true },
      requestPayloadSchemaVersion: 1,
      responsePayload: [{ response: true }],
      responsePayloadSchemaVersion: 2,
    });
    expect(h.store.llmCalls.byId("probe")).not.toHaveProperty("unknown");
    h.clock.advance(1_000);
    await p.persistLlmAudits([{ ...captured, unknown: "changed" } as LlmCallAudit]);
    expect(h.store.llmCalls.byId("probe")?.createdAt).toBe(NOW);
  });

  it("should reject malformed and duplicate audit streams atomically without raw payload disclosure", async () => {
    const h = setup();
    const p = h.create();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = Array(1) as LlmCallAudit[];
    const malformed: unknown[] = [
      sparse,
      [audit("bad-hash", "success", { requestHash: "SECRET" })],
      [audit("bad-pair", "success", { errorCode: "not-allowed" })],
      [audit("bad-latency", "success", { usage: { latencyMs: 1.5 } })],
      [audit("bad-json", "success", { requestPayload: cyclic, requestPayloadSchemaVersion: 1 })],
      [audit("bad-hook", "success", { requestPayload: { toJSON: () => "SECRET" }, requestPayloadSchemaVersion: 1 })],
      [audit("bad-version", "success", { responsePayload: { secret: "SECRET" } })],
    ];
    for (const value of malformed) {
      const transactions = h.journal.transactions;
      await expect(p.persistLlmAudits(value as LlmCallAudit[])).rejects.toMatchObject({ code: "invalid-input", message: "Personalization input is invalid." });
      expect(h.journal.transactions).toBe(transactions);
    }
    await expect(p.persistLlmAudits([audit("duplicate"), audit("duplicate")])).rejects.toMatchObject({ code: "audit-conflict" });
    expect(h.store.llmCalls.byId("duplicate")).toBeUndefined();
  });

  it("should reject cross-retry audit conflicts without replacing the original record", async () => {
    const h = setup();
    const p = h.create();
    await p.persistLlmAudits([audit("same", "success", { responsePayload: { original: true }, responsePayloadSchemaVersion: 1 })]);
    h.clock.advance(1_000);
    await expect(p.persistLlmAudits([audit("same", "success", { responsePayload: { secret: "SECRET" }, responsePayloadSchemaVersion: 1 })]))
      .rejects.toMatchObject({ code: "audit-conflict", message: "LLM audit identity conflicts with an existing record." });
    expect(h.store.llmCalls.byId("same")).toMatchObject({ responsePayload: { original: true }, createdAt: NOW });
  });
});
