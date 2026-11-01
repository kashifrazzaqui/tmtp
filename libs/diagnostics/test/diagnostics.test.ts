import { createFixedClock } from "@tmtp/clock";
import type { DiagnosticError, IngestionRun, InterestProfile, Job, LlmCallRecord, RecommendationVersionCount } from "@tmtp/domain";
import type { JobQueue } from "@tmtp/job-queue";
import type { ReaderStore } from "@tmtp/reader-store";
import { describe, expect, it, vi } from "vitest";
import { createDiagnostics, DiagnosticsError } from "../src/index.js";
import type { DiagnosticsOptions, HealthInput, ReadinessInput } from "../src/index.js";

const NOW = new Date("2026-03-01T00:00:00.000Z");
const TIME = NOW.toISOString();
function profile(id = "profile-1"): InterestProfile {
  return { id, rulesVersion: "rules-1", activityVersion: "activity-1", sourceRules: [], sourceRulesSchemaVersion: 1,
    policy: { secret: "hidden" }, policySchemaVersion: 1, policyVersion: "policy-1", builderVersion: "builder-1",
    interests: [], reason: "secret-reason", createdAt: TIME };
}
function run(id: string, startedAt = TIME): IngestionRun {
  return { id, kind: "public", status: "failed", cursorStart: "hidden-cursor", storiesUpserted: 2, nonStoriesSkipped: 1,
    errorCode: "fetch-failed", errorMessage: "secret-message", startedAt, completedAt: TIME };
}
function job(id: string, createdAt = TIME): Job {
  return { id, kind: "ingestion", payload: { secret: "hidden" }, payloadSchemaVersion: 1, dedupeKey: "hidden-dedupe",
    status: "failed", runAfter: TIME, attempts: 2, maxAttempts: 3, lastErrorCode: "fetch-failed", lastError: "secret-job-error",
    createdAt, updatedAt: TIME, completedAt: TIME };
}
function llm(id: string, createdAt = TIME): LlmCallRecord {
  return { id, purpose: "recommendations", model: "model-1", status: "success", requestHash: `sha256:${"a".repeat(64)}`,
    inputTokens: 10, outputTokens: 5, latencyMs: 20, providerRequestId: "hidden-provider-id", createdAt };
}
function diagnostic(id: string, occurredAt = TIME): DiagnosticError {
  return { id, code: "fetch-failed", message: "secret-message", component: "ingestion", occurredAt, runId: "run-1" };
}
function version(profileId: string): RecommendationVersionCount {
  return { profileId, promptVersion: "prompt-1", model: "model-1", rankVersion: "rank-1", queueEntryCount: 2 };
}
interface Fake {
  store: ReaderStore;
  jobs: JobQueue;
  reads: Record<string, ReturnType<typeof vi.fn>>;
}
function fake(): Fake {
  const reads = {
    profile: vi.fn(() => undefined as InterestProfile | undefined),
    versions: vi.fn(() => [] as RecommendationVersionCount[]),
    runs: vi.fn(() => [] as IngestionRun[]),
    counts: vi.fn(() => ({ pending: 0, scored: 0, failed: 0 })),
    llm: vi.fn(() => [] as LlmCallRecord[]),
    errors: vi.fn(() => [] as DiagnosticError[]),
    jobs: vi.fn(() => [] as Job[]),
    jobErrors: vi.fn(() => [] as DiagnosticError[]),
  };
  const store = {
    profiles: { current: reads.profile }, recommendations: { activeVersionCounts: reads.versions },
    sync: { recentRuns: reads.runs }, queue: { countsByEvaluationState: reads.counts },
    llmCalls: { recent: reads.llm }, diagnostics: { recentErrors: reads.errors },
  } as unknown as ReaderStore;
  const jobs = { list: reads.jobs, listDiagnosticErrors: reads.jobErrors } as unknown as JobQueue;
  return { store, jobs, reads };
}
interface Wait { ms: number; fire: () => void; settled: boolean; }
function sleepHarness() {
  const waits: Wait[] = [];
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal === undefined) throw new TypeError("Signal required");
    let settled = false;
    const abort = (): void => { if (!settled) { settled = true; wait.settled = true; reject(signal.reason); } };
    const wait: Wait = { ms, settled: false, fire: () => {
      if (!settled) { settled = true; wait.settled = true; signal.removeEventListener("abort", abort); resolve(); }
    } };
    waits.push(wait);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
  return { waits, sleep };
}
function options(fakeValue = fake(), overrides: Partial<DiagnosticsOptions> = {}): DiagnosticsOptions {
  const { sleep } = sleepHarness();
  return {
    store: fakeValue.store, jobs: fakeValue.jobs, clock: createFixedClock(NOW), sleep,
    secretValues: [], debug: { enabled: true, streamIntervalMs: 250, includeLlmPayloads: false }, ...overrides,
  };
}
const ready: ReadinessInput = {
  configuration: { ready: true, reason: "ok" }, sqlite: { ready: true, reason: "ok" },
  migrations: { ready: true, reason: "ok" }, workers: { ready: true, reason: "ok" },
};
const available = { configured: true, availability: "available", reason: "ok", observedAt: TIME } as const;
const health: HealthInput = { ...ready, llm: available, hnPublic: available, article: available };

describe("health and capability aggregation", () => {
  it("should return live without reads and fail each readiness check independently", () => {
    const f = fake();
    const diagnostics = createDiagnostics(options(f));
    expect(diagnostics.liveness()).toEqual({ generatedAt: TIME, status: "live" });
    expect(Object.values(f.reads).every((read) => read.mock.calls.length === 0)).toBe(true);
    for (const name of ["configuration", "sqlite", "migrations", "workers"] as const) {
      const input = { ...ready, [name]: { ready: false, reason: name === "workers" ? "worker-failed" : name === "migrations" ? "migrations-pending" : name === "sqlite" ? "database-unavailable" : "configuration-invalid" } } as ReadinessInput;
      const snapshot = diagnostics.readiness(input);
      expect(snapshot.status).toBe("not-ready");
      expect(snapshot.checks.map((check) => check.name)).toEqual(["configuration", "sqlite", "migrations", "workers"]);
      expect(snapshot.checks.find((check) => check.name === name)).toMatchObject({ status: "fail", reason: input[name].reason });
    }
    expect(diagnostics.readiness(ready).status).toBe("ready");
  });

  it("should keep stored reading independent of workers and external failures", () => {
    const diagnostics = createDiagnostics(options());
    const failed = { configured: true, availability: "unavailable", reason: "timeout", observedAt: TIME } as const;
    const snapshot = diagnostics.capabilities({
      ...health, workers: { ready: false, reason: "workers-stopped" }, llm: failed, article: failed,
    });
    expect(snapshot.storedReading).toEqual({ state: "available", reason: "ok" });
    expect(snapshot.backgroundWork).toEqual({ state: "unavailable", reason: "workers-not-ready" });
    expect(snapshot.llmPersonalization.state).toBe("unavailable");
    expect(snapshot.freshArticleContent.state).toBe("unavailable");
    expect(snapshot.hnAccount).toEqual({ state: "disabled", reason: "not-configured" });
    const unknown = { configured: true, availability: "unknown", reason: "not-checked" } as const;
    expect(diagnostics.capabilities({ ...health, llm: unknown }).llmPersonalization.state).toBe("unknown");
    expect(() => diagnostics.readiness({ ...ready, sqlite: { ready: true, reason: "database-unavailable" } })).toThrowError(expect.objectContaining({ code: "invalid-input" }));
    expect(() => diagnostics.capabilities({ ...health, llm: { configured: false, availability: "available", reason: "ok" } })).toThrow(DiagnosticsError);
  });

  it("should validate debug and secret-source configuration", () => {
    expect(() => createDiagnostics(options(fake(), { secretValues: undefined }))).toThrowError(expect.objectContaining({ code: "invalid-configuration" }));
    expect(() => createDiagnostics(options(fake(), { secretValuesProvider: () => [] }))).toThrowError(expect.objectContaining({ code: "invalid-configuration" }));
    expect(() => createDiagnostics(options(fake(), { debug: { enabled: false, streamIntervalMs: 250, includeLlmPayloads: true } }))).toThrowError(expect.objectContaining({ code: "invalid-configuration" }));
    const disabled = createDiagnostics(options(fake(), { debug: { enabled: false, streamIntervalMs: 250, includeLlmPayloads: false } }));
    expect(() => disabled.debugSnapshot()).toThrowError(expect.objectContaining({ code: "debug-disabled" }));
    expect(() => disabled.debugStream()).toThrowError(expect.objectContaining({ code: "debug-disabled" }));
  });
});

describe("safe DTOs pages and payload policy", () => {
  it("should copy only allowlisted fields and keep all queue count keys", () => {
    const f = fake();
    f.reads.profile.mockReturnValue(profile());
    f.reads.versions.mockReturnValue([version("profile-1")]);
    f.reads.runs.mockReturnValue([run("run-1")]);
    f.reads.jobs.mockReturnValue([job("job-1")]);
    f.reads.llm.mockReturnValue([llm("call-1")]);
    f.reads.errors.mockReturnValue([diagnostic("ingestion:run-1")]);
    f.reads.counts.mockReturnValue({ pending: 2, failed: 1 });
    const snapshot = createDiagnostics(options(f)).debugSnapshot();
    expect(snapshot.activeProfile.value).toEqual({ id: "profile-1", rulesVersion: "rules-1", activityVersion: "activity-1", policyVersion: "policy-1", builderVersion: "builder-1", createdAt: TIME });
    expect(snapshot.queueCounts.value).toEqual({ pending: 2, scored: 0, failed: 1 });
    const serialized = JSON.stringify(snapshot);
    for (const sentinel of ["secret-reason", "secret-message", "hidden-cursor", "hidden-dedupe", "secret-job-error", "hidden-provider-id"]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(snapshot.jobs.value.items[0]).not.toHaveProperty("payload");
    expect(snapshot.llmCalls.value.items[0]).not.toHaveProperty("providerRequestId");
    expect(snapshot.recentErrors.value.items[0]).not.toHaveProperty("message");
  });

  it("should create section-bound keyset pages and reject invalid cursors before reads", () => {
    const f = fake();
    f.reads.runs.mockReturnValue([run("c"), run("b"), run("a")]);
    const diagnostics = createDiagnostics(options(f));
    const first = diagnostics.debugSnapshot({ syncRuns: { limit: 2 } });
    expect(first.syncRuns.value.items.map((item) => item.id)).toEqual(["c", "b"]);
    expect(first.syncRuns.value.nextCursor).toBeTypeOf("string");
    f.reads.runs.mockReturnValue([run("a")]);
    const second = diagnostics.debugSnapshot({ syncRuns: { limit: 2, after: first.syncRuns.value.nextCursor } });
    expect(second.syncRuns.value.items.map((item) => item.id)).toEqual(["a"]);
    expect(second.syncRuns.value).not.toHaveProperty("nextCursor");
    const before = Object.values(f.reads).map((read) => read.mock.calls.length);
    expect(() => diagnostics.debugSnapshot({ syncRuns: { after: "!!!" } })).toThrowError(expect.objectContaining({ code: "invalid-cursor" }));
    expect(Object.values(f.reads).map((read) => read.mock.calls.length)).toEqual(before);
    expect(() => diagnostics.debugSnapshot({ jobs: { after: first.syncRuns.value.nextCursor } })).toThrowError(expect.objectContaining({ code: "cursor-query-mismatch" }));
  });

  it("should bind job cursors to complete filters", () => {
    const f = fake();
    f.reads.jobs.mockReturnValue([job("b"), job("a")]);
    const diagnostics = createDiagnostics(options(f));
    const first = diagnostics.debugSnapshot({ jobs: { limit: 1, kind: "ingestion", status: "failed" } });
    expect(first.jobs.value.nextCursor).toBeTypeOf("string");
    expect(() => diagnostics.debugSnapshot({ jobs: { limit: 1, kind: "other", status: "failed", after: first.jobs.value.nextCursor } }))
      .toThrowError(expect.objectContaining({ code: "cursor-query-mismatch" }));
  });

  it("should merge bounded recent-error candidates in descending source-prefixed order", () => {
    const f = fake();
    f.reads.errors.mockReturnValue([diagnostic("llm:z"), diagnostic("ingestion:a")]);
    f.reads.jobErrors.mockReturnValue([{ ...diagnostic("job:m"), component: "jobs" }]);
    const snapshot = createDiagnostics(options(f)).debugSnapshot({ recentErrors: { limit: 2 } });
    expect(snapshot.recentErrors.value.items.map((item) => item.id)).toEqual(["llm:z", "job:m"]);
    expect(snapshot.recentErrors.value.nextCursor).toBeTypeOf("string");
    expect(f.reads.errors).toHaveBeenCalledWith(undefined, 3);
    expect(f.reads.jobErrors).toHaveBeenCalledWith(undefined, 3);
  });

  it("should isolate every section failure without leaking upstream text", () => {
    const names = ["profile", "versions", "runs", "jobs", "counts", "llm", "errors"] as const;
    for (const name of names) {
      const f = fake();
      f.reads[name].mockImplementation(() => { throw new Error("secret-upstream-message"); });
      const snapshot = createDiagnostics(options(f)).debugSnapshot();
      expect(snapshot.partial).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain("secret-upstream-message");
      expect(Object.values(snapshot).filter((value) => typeof value === "object" && value !== null && "status" in value && value.status === "unavailable")).toHaveLength(1);
    }
  });

  it("should redact secrets URLs sensitive keys and suppress failed response payloads", () => {
    const f = fake();
    const record: LlmCallRecord = {
      ...llm("call-secret"), status: "provider-error", errorCode: "rate-limited",
      requestPayload: { authorization: "access-secret", nested: [{ text: "access-secret at https://user:pw@example.com/a?q=access-secret" }] }, requestPayloadSchemaVersion: 1,
      responsePayload: { error: "provider-secret" }, responsePayloadSchemaVersion: 1,
    };
    f.reads.llm.mockReturnValue([record]);
    const snapshot = createDiagnostics(options(f, {
      secretValues: ["access-secret", "provider-secret"], debug: { enabled: true, streamIntervalMs: 250, includeLlmPayloads: true },
    })).debugSnapshot();
    const call = snapshot.llmCalls.value.items[0]!;
    expect(call.requestPayload.state).toBe("included");
    expect(call.responsePayload).toEqual({ state: "suppressed-error-response", truncated: false });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("access-secret");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("https://user:pw");
    expect(serialized).toContain("[RedactedUrl]");
    const hidden = createDiagnostics(options(f)).debugSnapshot().llmCalls.value.items[0]!;
    expect(hidden.requestPayload).toEqual({ state: "hidden-by-policy", truncated: false });
    expect(hidden.responsePayload).toEqual({ state: "hidden-by-policy", truncated: false });
  });

  it("should enforce per-value and whole-snapshot payload budgets", () => {
    const f = fake();
    const payload = Object.fromEntries(["a", "b", "c", "d"].map((key) => [key, "x".repeat(1_800)]));
    f.reads.llm.mockReturnValue(Array.from({ length: 5 }, (_, index) => ({
      ...llm(`call-${index}`), requestPayload: payload, requestPayloadSchemaVersion: 1,
    })));
    const snapshot = createDiagnostics(options(f, { debug: { enabled: true, streamIntervalMs: 250, includeLlmPayloads: true } })).debugSnapshot();
    expect(snapshot.llmCalls.value.items.slice(0, 4).every((call) => call.requestPayload.state === "included")).toBe(true);
    expect(snapshot.llmCalls.value.items[4]?.requestPayload).toEqual({ state: "omitted-budget", truncated: false });
    f.reads.llm.mockReturnValue([{ ...llm("large"), requestPayload: { ...payload, e: "x".repeat(1_800) }, requestPayloadSchemaVersion: 1 }]);
    expect(createDiagnostics(options(f, { debug: { enabled: true, streamIntervalMs: 250, includeLlmPayloads: true } })).debugSnapshot().llmCalls.value.items[0]?.requestPayload.state).toBe("omitted-too-large");
  });

  it("should fail a section rather than emit a secret-bearing cursor key", () => {
    const f = fake();
    f.reads.runs.mockReturnValue([run("run-access-secret"), run("older")]);
    const snapshot = createDiagnostics(options(f, { secretValues: ["access-secret"] })).debugSnapshot({ syncRuns: { limit: 1 } });
    expect(snapshot.syncRuns).toEqual({ status: "unavailable", value: { items: [] }, errorCode: "read-failed" });
    expect(snapshot.partial).toBe(true);
  });
});

describe("secret provider and streams", () => {
  it("should use one consistent provider inventory per snapshot and fail closed", () => {
    const f = fake();
    let secrets = ["first-secret"];
    const provider = vi.fn(() => secrets);
    let reads = 0;
    f.reads.profile.mockImplementation(() => {
      const id = secrets[0]!;
      if (reads++ === 0) secrets = ["second-secret"];
      return profile(id);
    });
    f.reads.runs.mockReturnValue([run("first-secret")]);
    const diagnostics = createDiagnostics(options(f, { secretValues: undefined, secretValuesProvider: provider }));
    const first = diagnostics.debugSnapshot();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain("first-secret");
    const second = diagnostics.debugSnapshot();
    expect(provider).toHaveBeenCalledTimes(2);
    expect(second.activeProfile.value?.id).toBe("[Redacted]");
    const failing = fake();
    const badProvider = vi.fn(() => { throw new Error("provider-secret"); });
    const failed = createDiagnostics(options(failing, { secretValues: undefined, secretValuesProvider: badProvider }));
    expect(() => failed.debugSnapshot()).toThrowError(expect.objectContaining({ code: "redaction-provider-failed" }));
    expect(badProvider).toHaveBeenCalledTimes(1);
    expect(Object.values(failing.reads).every((read) => read.mock.calls.length === 0)).toBe(true);
  });

  it("should snapshot static secrets at construction and return fresh DTOs", () => {
    const f = fake();
    const secrets = ["initial-secret"];
    f.reads.runs.mockReturnValue([run("initial-secret"), run("later-secret")]);
    const diagnostics = createDiagnostics(options(f, { secretValues: secrets }));
    secrets.push("later-secret");
    const first = diagnostics.debugSnapshot();
    expect(first.syncRuns.value.items[0]?.id).toBe("[Redacted]");
    expect(first.syncRuns.value.items[1]?.id).toBe("later-secret");
    first.syncRuns.value.items[1]!.id = "mutated";
    expect(diagnostics.debugSnapshot().syncRuns.value.items[1]?.id).toBe("later-secret");
  });

  it("should emit immediate and delayed full frames with one provider call each", async () => {
    const f = fake();
    const { waits, sleep } = sleepHarness();
    const provider = vi.fn(() => [] as string[]);
    const clock = createFixedClock(NOW);
    const diagnostics = createDiagnostics(options(f, { clock, sleep, secretValues: undefined, secretValuesProvider: provider }));
    const stream = diagnostics.debugStream();
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first).toMatchObject({ done: false, value: { sequence: 1 } });
    expect(provider).toHaveBeenCalledTimes(1);
    clock.advance(100);
    const secondPending = iterator.next();
    await Promise.resolve();
    expect(waits).toHaveLength(1);
    expect(waits[0]?.ms).toBe(150);
    expect(provider).toHaveBeenCalledTimes(1);
    waits[0]!.fire();
    const second = await secondPending;
    expect(second).toMatchObject({ done: false, value: { sequence: 2 } });
    expect(provider).toHaveBeenCalledTimes(2);
    await iterator.return!();
  });

  it("should serialize concurrent pulls and preserve abort reasons and return cleanup", async () => {
    const f = fake();
    const { waits, sleep } = sleepHarness();
    const diagnostics = createDiagnostics(options(f, { sleep }));
    const iterator = diagnostics.debugStream()[Symbol.asyncIterator]();
    const first = iterator.next();
    const second = iterator.next();
    expect((await first).value?.sequence).toBe(1);
    await Promise.resolve();
    expect(waits).toHaveLength(1);
    waits[0]!.fire();
    expect((await second).value?.sequence).toBe(2);
    const third = iterator.next();
    await Promise.resolve();
    const reason = { abort: true };
    const controller = new AbortController();
    const other = diagnostics.debugStream({ signal: controller.signal })[Symbol.asyncIterator]();
    await other.next();
    const waiting = other.next();
    await Promise.resolve();
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    const returning = iterator.return!();
    await expect(third).resolves.toMatchObject({ done: true });
    await returning;
    expect((await iterator.next()).done).toBe(true);
    expect(waits.every((wait) => wait.settled)).toBe(true);
  });

  it("should not consume a sequence or retry the provider after a frame failure", async () => {
    const f = fake();
    let fail = true;
    const provider = vi.fn(() => { if (fail) throw new Error("no"); return []; });
    const diagnostics = createDiagnostics(options(f, { secretValues: undefined, secretValuesProvider: provider }));
    const iterator = diagnostics.debugStream()[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "redaction-provider-failed" });
    expect(provider).toHaveBeenCalledTimes(1);
    fail = false;
    expect((await iterator.next()).value?.sequence).toBe(1);
    expect(provider).toHaveBeenCalledTimes(2);
    await iterator.return!();
  });
});
