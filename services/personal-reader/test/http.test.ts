import { afterEach, describe, expect, it, vi } from "vitest";
import { httpHarness, login, mutationHeaders, NOW, readJson } from "./harness.js";
import type { HttpHarness } from "./harness.js";
import { seedStory } from "./fixtures.js";

const active: HttpHarness[] = [];
async function harness(debug = false): Promise<HttpHarness> {
  const value = await httpHarness({ debug: { enabled: debug, stream_interval_ms: 250, include_llm_payloads: false } });
  active.push(value);
  return value;
}

afterEach(async () => {
  while (active.length > 0) await active.pop()!.close();
  vi.restoreAllMocks();
});

describe("public HTTP transport", () => {
  it("should report local health without consuming external integrations", async () => {
    const local = await harness();
    const live = await fetch(`${local.origin}/health/live`);
    expect(live.status).toBe(200);
    expect(await readJson(live)).toEqual({ generatedAt: "2026-01-02T03:04:05.000Z", status: "live" });
    const ready = await fetch(`${local.origin}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await readJson(ready)).toMatchObject({ status: "ready", checks: [
      { name: "configuration", status: "pass", reason: "ok" },
      { name: "sqlite", status: "pass", reason: "ok" },
      { name: "migrations", status: "pass", reason: "ok" },
      { name: "workers", status: "pass", reason: "ok" },
    ] });
    const capabilities = await fetch(`${local.origin}/health/capabilities`);
    expect(await readJson(capabilities)).toMatchObject({
      storedReading: { state: "available" },
      llmPersonalization: { state: "unknown", reason: "not-checked" },
      hnPublicCollection: { state: "unknown", reason: "not-checked" },
      hnAccount: { state: "disabled", reason: "not-configured" },
      freshArticleContent: { state: "unknown", reason: "not-checked" },
    });
  });

  it("should issue an HttpOnly strict cookie and require independent CSRF and origin checks", async () => {
    const local = await harness();
    const session = await login(local.origin);
    expect(session.setCookie).toContain("tmtp_session=");
    expect(session.setCookie).toContain("HttpOnly");
    expect(session.setCookie).toContain("Path=/");
    expect(session.setCookie).toContain("SameSite=Strict");
    expect(session.setCookie).not.toContain("Secure");
    expect(session.setCookie).not.toContain("Domain=");

    const missingCsrf = await fetch(`${local.origin}/api/v1/operations/jobs/run-once`, {
      method: "POST", headers: { cookie: session.cookie, origin: local.origin },
    });
    expect(missingCsrf.status).toBe(403);
    expect(await readJson(missingCsrf)).toMatchObject({ error: { code: "csrf-invalid" } });

    const badOrigin = await fetch(`${local.origin}/api/v1/operations/jobs/run-once`, {
      method: "POST", headers: { ...mutationHeaders(session, local.origin), origin: "https://attacker.invalid" },
    });
    expect(badOrigin.status).toBe(403);
    expect(await readJson(badOrigin)).toMatchObject({ error: { code: "origin-invalid" } });

    const result = await fetch(`${local.origin}/api/v1/operations/jobs/run-once`, {
      method: "POST", headers: mutationHeaders(session, local.origin),
    });
    expect(result.status).toBe(200);
    expect(await readJson(result)).toEqual({ outcome: "idle" });
  });

  it("should keep sessions independent and revoke only the logged-out session", async () => {
    const local = await harness();
    const first = await login(local.origin);
    const second = await login(local.origin);
    const logout = await fetch(`${local.origin}/api/v1/auth/logout`, {
      method: "POST", headers: mutationHeaders(first, local.origin),
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("tmtp_session=;");
    const revoked = await fetch(`${local.origin}/api/v1/auth/session`, { headers: { cookie: first.cookie } });
    expect(await readJson(revoked)).toEqual({ authenticated: false });
    const retained = await fetch(`${local.origin}/api/v1/auth/session`, { headers: { cookie: second.cookie } });
    expect(await readJson(retained)).toEqual({ authenticated: true, expiresAt: second.expiresAt, csrfState: "stored" });
  });

  it("should generate its own correlated request IDs and safe transport errors", async () => {
    const local = await harness();
    const supplied = "inbound-id-must-not-survive";
    const response = await fetch(`${local.origin}/api/v1/queue`, { headers: { "x-request-id": supplied } });
    const body = await readJson(response) as { error: { requestId: string; code: string; message: string } };
    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBe(body.error.requestId);
    expect(body.error.requestId).not.toBe(supplied);
    expect(body.error).toMatchObject({ code: "authentication-required", message: "Authentication is required.", retryable: false });

    const malformed = await fetch(`${local.origin}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{bad",
    });
    expect(malformed.status).toBe(400);
    expect(await readJson(malformed)).toMatchObject({ error: { code: "invalid-input" } });
    const media = await fetch(`${local.origin}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: "token",
    });
    expect(media.status).toBe(415);
    const large = await fetch(`${local.origin}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken: "x".repeat(1_048_600) }),
    });
    expect(large.status).toBe(413);
    expect(await readJson(large)).toMatchObject({ error: { code: "body-too-large" } });
  });

  it("should reject unknown, repeated and noncanonical query values before facade work", async () => {
    const local = await harness();
    const session = await login(local.origin);
    const query = vi.spyOn(local.graph.readerApp, "getQueue");
    for (const suffix of ["unknown=1", "limit=01", "limit=1&limit=2", "limit=0", "limit=999999999999999999999"]) {
      const response = await fetch(`${local.origin}/api/v1/queue?${suffix}`, { headers: { cookie: session.cookie } });
      expect(response.status, suffix).toBe(400);
    }
    expect(query).not.toHaveBeenCalled();
    const oldAlias = await fetch(`${local.origin}/api/v1/activity?afterId=event-1`, { headers: { cookie: session.cookie } });
    expect(oldAlias.status).toBe(400);
  });

  it("should expose safe empty queue and canonical disabled account capabilities", async () => {
    const local = await harness();
    const session = await login(local.origin);
    const queue = await fetch(`${local.origin}/api/v1/queue`, { headers: { cookie: session.cookie } });
    expect(queue.status).toBe(200);
    expect(await readJson(queue)).toEqual({
      items: [], evaluationCounts: { pending: 0, scored: 0, failed: 0 }, rankVersions: [],
    });
    const capabilities = await fetch(`${local.origin}/api/v1/hn/capabilities`, { headers: { cookie: session.cookie } });
    expect(await readJson(capabilities)).toEqual(["upvoted", "favorites", "flagged", "mutations"].map((name) => ({
      name, state: "unavailable", reason: "capability-disabled",
    })));
    seedStory(local.graph, 1);
    const action = await fetch(`${local.origin}/api/v1/hn/actions`, {
      method: "POST",
      headers: { ...mutationHeaders(session, local.origin), "content-type": "application/json" },
      body: JSON.stringify({ storyId: 1, action: "upvote", idempotencyKey: "local-key" }),
    });
    expect(action.status).toBe(503);
    expect(await readJson(action)).toMatchObject({ error: { code: "account-not-configured" } });
  });

  it("should serve constrained SPA routes with production CSP and no asset fallback", async () => {
    const local = await harness();
    for (const path of ["/", "/queue", "/stories/42", "/settings"]) {
      const response = await fetch(`${local.origin}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
    expect((await fetch(`${local.origin}/debug`)).status).toBe(404);
    expect((await fetch(`${local.origin}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${local.origin}/api/v1/not-a-route`)).status).toBe(404);
  });

  it("should remove disabled debug APIs and require mutation checks when enabled", async () => {
    const disabled = await harness();
    expect((await fetch(`${disabled.origin}/api/v1/debug/state`)).status).toBe(404);
    expect((await fetch(`${disabled.origin}/api/v1/debug/stream`)).status).toBe(404);

    const local = await harness(true);
    const session = await login(local.origin);
    expect((await fetch(`${local.origin}/api/v1/debug/state`, { headers: { cookie: session.cookie } })).status).toBe(403);
    const browserSameOrigin = await fetch(`${local.origin}/api/v1/debug/state`, {
      headers: { cookie: session.cookie, "x-tmtp-csrf": session.csrf, "sec-fetch-site": "same-origin" },
    });
    expect(browserSameOrigin.status).toBe(200);
    for (const path of ["/api/v1/debug/state", "/api/v1/debug/stream"]) {
      for (const fetchSite of [undefined, "same-site", "cross-site"]) {
        const rejected = await fetch(`${local.origin}${path}`, {
          headers: {
            cookie: session.cookie,
            "x-tmtp-csrf": session.csrf,
            ...(fetchSite === undefined ? {} : { "sec-fetch-site": fetchSite }),
          },
        });
        expect(rejected.status).toBe(403);
      }
    }
    const wrongOrigin = await fetch(`${local.origin}/api/v1/debug/state`, {
      headers: {
        ...mutationHeaders(session, "https://wrong-origin.example"),
        "sec-fetch-site": "same-origin",
      },
    });
    expect(wrongOrigin.status).toBe(403);
    const mutationWithoutOrigin = await local.transport.app.inject({
      method: "POST",
      url: "/api/v1/operations/jobs/run-once",
      headers: { cookie: session.cookie, "x-tmtp-csrf": session.csrf, "sec-fetch-site": "same-origin" },
    });
    expect(mutationWithoutOrigin.statusCode).toBe(403);
    const snapshot = await fetch(`${local.origin}/api/v1/debug/state`, { headers: mutationHeaders(session, local.origin) });
    expect(snapshot.status).toBe(200);
    expect(await readJson(snapshot)).toMatchObject({
      schemaVersion: 1,
      payloadPolicy: { llmPayloads: false },
      partial: false,
      jobs: { status: "ok" },
      recentErrors: { status: "ok" },
    });
    expect((await fetch(`${local.origin}/debug`)).status).toBe(200);
  });

  it("should stream an immediate redacted full debug frame over fetch-readable SSE", async () => {
    const local = await harness(true);
    const session = await login(local.origin);
    const response = await fetch(`${local.origin}/api/v1/debug/stream`, {
      headers: {
        cookie: session.cookie,
        "x-tmtp-csrf": session.csrf,
        "sec-fetch-site": "same-origin",
        accept: "text/event-stream",
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("retry: 3000");
    expect(text).toContain("event: debug-snapshot");
    expect(text).toContain("id: 1");
    expect(text).toContain('"sequence":1');
    expect(text).not.toContain(session.cookie);
    expect(text).not.toContain(session.csrf);
    await reader.cancel();
  });

  it("should paginate diagnostics with bounded cursors and reset SSE reconnects", async () => {
    const local = await harness(true);
    for (let index = 0; index < 2; index += 1) {
      local.graph.jobs.enqueue({
        kind: "personalization.recover", payload: {}, payloadSchemaVersion: 1, runAfter: NOW.toISOString(),
      });
    }
    const session = await login(local.origin);
    const firstResponse = await fetch(`${local.origin}/api/v1/debug/state?jobs.limit=1`, {
      headers: mutationHeaders(session, local.origin),
    });
    const first = await readJson(firstResponse) as {
      jobs: { status: string; value: { items: Array<{ id: string }>; nextCursor?: string } };
    };
    expect(first.jobs.status).toBe("ok");
    expect(first.jobs.value.items).toHaveLength(1);
    expect(first.jobs.value.nextCursor).toBeDefined();
    const secondResponse = await fetch(`${local.origin}/api/v1/debug/state?jobs.limit=1&jobs.after=${encodeURIComponent(first.jobs.value.nextCursor!)}`, {
      headers: mutationHeaders(session, local.origin),
    });
    const second = await readJson(secondResponse) as { jobs: { value: { items: Array<{ id: string }> } } };
    expect(second.jobs.value.items).toHaveLength(1);
    expect(second.jobs.value.items[0]!.id).not.toBe(first.jobs.value.items[0]!.id);
    const badStreamCursor = await fetch(`${local.origin}/api/v1/debug/stream?jobs.after=abc`, {
      headers: mutationHeaders(session, local.origin),
    });
    expect(badStreamCursor.status).toBe(400);

    for (let index = 0; index < 2; index += 1) {
      const stream = await fetch(`${local.origin}/api/v1/debug/stream`, { headers: mutationHeaders(session, local.origin) });
      const streamReader = stream.body!.getReader();
      const chunk = await streamReader.read();
      expect(new TextDecoder().decode(chunk.value)).toContain("id: 1");
      await streamReader.cancel();
    }
  });
});
