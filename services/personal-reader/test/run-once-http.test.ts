import { afterEach, describe, expect, it, vi } from "vitest";
import { JobQueueError } from "@tmtp/job-queue";
import { ReaderAppError } from "@tmtp/reader-app";
import { httpHarness, login, mutationHeaders, NOW, readJson } from "./harness.js";
import type { HttpHarness } from "./harness.js";

const active: HttpHarness[] = [];
async function setup(): Promise<{ local: HttpHarness; session: Awaited<ReturnType<typeof login>> }> {
  const local = await httpHarness();
  active.push(local);
  const session = await login(local.origin);
  return { local, session };
}

afterEach(async () => {
  while (active.length > 0) await active.pop()!.close();
  vi.restoreAllMocks();
});

function enqueue(local: HttpHarness, kind = "personalization.recover", payload: unknown = {}): void {
  local.graph.jobs.enqueue({ kind, payload, payloadSchemaVersion: 1, runAfter: NOW.toISOString() });
}

async function run(local: HttpHarness, session: Awaited<ReturnType<typeof login>>): Promise<Response> {
  return fetch(`${local.origin}/api/v1/operations/jobs/run-once`, {
    method: "POST", headers: mutationHeaders(session, local.origin),
  });
}

describe("HTTP run-once", () => {
  it("should return a fresh completed job DTO", async () => {
    const { local, session } = await setup();
    enqueue(local);
    const response = await run(local, session);
    expect(response.status).toBe(200);
    const body = await readJson(response) as { outcome: string; job: Record<string, unknown> };
    expect(body).toMatchObject({ outcome: "completed", job: { kind: "personalization.recover", status: "done", attempts: 1 } });
    expect(body.job).not.toHaveProperty("payload");
    expect(body.job).not.toHaveProperty("dedupeKey");
    expect(body.job).not.toHaveProperty("leaseToken");
    expect(body.job).not.toHaveProperty("lastError");
  });

  it("should return failed attempt with a fresh queued retry snapshot", async () => {
    const { local, session } = await setup();
    enqueue(local);
    vi.spyOn(local.graph.readerApp, "runJob").mockRejectedValue(
      new ReaderAppError("internal-failure", { operation: "run-job", retryable: true }),
    );
    const response = await run(local, session);
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ outcome: "failed", job: { status: "queued", attempts: 1, lastErrorCode: "reader-app-failed" } });
  });

  it("should distinguish a committed poison rejection from idle", async () => {
    const { local, session } = await setup();
    local.graph.database.execute(`INSERT INTO jobs (
      id, kind, payload, payload_schema_version, status, run_after, attempts, max_attempts, created_at, updated_at
    ) VALUES (?, ?, ?, 1, 'queued', ?, 0, 5, ?, ?)`, [
      "poison-http", "ingestion.collect", JSON.stringify({ bad: true }), NOW.toISOString(), NOW.toISOString(), NOW.toISOString(),
    ]);
    const handler = vi.spyOn(local.graph.readerApp, "runJob");
    const response = await run(local, session);
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ outcome: "rejected", job: { id: "poison-http", attempts: 0, status: "failed" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("should return lease-lost without a potentially newer job snapshot", async () => {
    const { local, session } = await setup();
    enqueue(local);
    vi.spyOn(local.graph.jobs, "complete").mockImplementation(() => { throw new JobQueueError("lease-lost"); });
    const response = await run(local, session);
    expect(response.status).toBe(200);
    const body = await readJson(response) as Record<string, unknown>;
    expect(body).toEqual({ outcome: "lease-lost", jobId: expect.any(String), kind: "personalization.recover", handlerOutcome: "completed" });
    expect(body).not.toHaveProperty("job");
  });

  it("should await authentication and CSRF and preserve their required order", async () => {
    const { local, session } = await setup();
    const calls: string[] = [];
    const originalAuthenticate = local.graph.accessControl.authenticate.bind(local.graph.accessControl);
    const originalCsrf = local.graph.accessControl.verifyCsrf.bind(local.graph.accessControl);
    let releaseAuth!: () => void;
    const authGate = new Promise<void>((resolve) => { releaseAuth = resolve; });
    vi.spyOn(local.graph.accessControl, "authenticate").mockImplementation(async (opaque) => {
      calls.push("authenticate-start");
      await authGate;
      calls.push("authenticate-end");
      return originalAuthenticate(opaque);
    });
    vi.spyOn(local.graph.accessControl, "verifyCsrf").mockImplementation(async (snapshot, csrf) => {
      calls.push("csrf");
      return originalCsrf(snapshot, csrf);
    });
    let settled = false;
    const pending = run(local, session).finally(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseAuth();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(calls).toEqual(["authenticate-start", "authenticate-end", "csrf"]);
  });

  it("should fail closed on crypto/store errors without treating them as auth misses", async () => {
    const { local, session } = await setup();
    vi.spyOn(local.graph.accessControl, "authenticate").mockRejectedValue(new Error("crypto-sentinel"));
    const response = await run(local, session);
    expect(response.status).toBe(500);
    const body = await readJson(response) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal-failure");
    expect(JSON.stringify(body)).not.toContain("crypto-sentinel");
  });
});
