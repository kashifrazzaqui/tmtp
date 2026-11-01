import { createFixedClock } from "@tmtp/clock";
import type { HnActionIntent, HnActionKind } from "@tmtp/domain";
import { HttpError } from "@tmtp/http-client";
import type { HttpClient, HttpRequest, HttpResponse } from "@tmtp/http-client";
import { describe, expect, it, vi } from "vitest";
import { createHnAccount, HnAccountError } from "../src/index.js";
import type { HnAccountOptions } from "../src/index.js";

const ORIGIN = "https://news.ycombinator.com";
const NOW = new Date("2026-04-01T00:00:00.000Z");
const TIME = NOW.toISOString();
function response(html = "", status = 200, headers: Record<string, readonly string[]> = {}): HttpResponse {
  return { status, headers: status === 200 ? { "content-type": ["text/html; charset=utf-8"], ...headers } : headers, body: Buffer.from(html), finalUrl: `${ORIGIN}/` };
}
function identity(content = "", username = "reader"): string {
  return `<html><body><a href="user?id=${username}">${username}</a>${content}</body></html>`;
}
function listPage(ids: number[], more?: string, kind = "upvoted"): string {
  const rows = ids.map((id) => `<tr class="athing" id="${id}"><td class="titleline"><a href="https://example.com/${id}">Story ${id}</a></td></tr>`).join("");
  return identity(`<table>${rows}</table>${more === undefined ? "" : `<a class="morelink" href="${more}">More</a>`}`);
}
function actionPage(action: HnActionKind, state: "present" | "absent" | "unknown", storyId = 1, csrf = "csrf-one", extra = ""): string {
  const controls: Record<HnActionKind, { present: string; absent: string; form: string }> = {
    upvote: { present: `unvote?id=${storyId}`, absent: `vote?id=${storyId}&how=up`, form: "/vote" },
    favorite: { present: `unfavorite?id=${storyId}`, absent: `favorite?id=${storyId}`, form: "/favorite" },
    flag: { present: `unflag?id=${storyId}`, absent: `flag?id=${storyId}`, form: "/flag" },
  };
  const value = controls[action];
  const control = state === "unknown" ? "" : `<a href="${value[state]}">${state}</a>`;
  const how = action === "upvote" ? `<input type="hidden" name="how" value="up">` : "";
  const form = state === "absent" ? `<form method="post" action="${value.form}"><input type="hidden" name="id" value="${storyId}">${how}<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="goto" value="item?id=${storyId}">${extra}</form>` : "";
  return identity(`${control}${form}`);
}
function intent(id = "intent-1", action: HnActionKind = "upvote", status: HnActionIntent["status"] = "pending"): HnActionIntent {
  return { id, storyId: 1, action, idempotencyKey: `key-${id}`, status, createdAt: TIME, updatedAt: TIME };
}
interface Wait { ms: number; fire: () => void; settled: boolean; }
interface Harness {
  options: HnAccountOptions;
  requests: HttpRequest[];
  respond: ReturnType<typeof vi.fn>;
  queue: Array<Promise<HttpResponse> | HttpResponse>;
  waits: Wait[];
  clock: ReturnType<typeof createFixedClock>;
}
function harness(overrides: Partial<HnAccountOptions> = {}): Harness {
  const requests: HttpRequest[] = [];
  const queue: Harness["queue"] = [];
  const respond = vi.fn((request: HttpRequest): Promise<HttpResponse> => {
    requests.push(request);
    const next = queue.shift();
    if (next === undefined) return Promise.resolve(response(identity()));
    return Promise.resolve(next);
  });
  const clock = createFixedClock(NOW);
  const waits: Wait[] = [];
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    let settled = false;
    const abort = (): void => { if (!settled) { settled = true; wait.settled = true; reject(signal?.reason); } };
    const wait: Wait = { ms, settled: false, fire: () => {
      if (!settled) { settled = true; wait.settled = true; signal?.removeEventListener("abort", abort); clock.advance(ms); resolve(); }
    } };
    waits.push(wait);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
  const http: HttpClient = { request: respond, close: vi.fn(async () => {}) };
  return {
    options: { baseUrl: ORIGIN, http, clock, sleep, username: "reader", sessionCookie: "cookie-secret", maxRequestsPerMinute: 60, ...overrides },
    requests, respond, queue, waits, clock,
  };
}
async function expectCode(promise: Promise<unknown>, code: HnAccountError["code"]): Promise<HnAccountError> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(HnAccountError);
    expect((error as HnAccountError).code).toBe(code);
    return error as HnAccountError;
  }
  throw new Error(`Expected ${code}`);
}

describe("construction sessions lists and capabilities", () => {
  it("should validate and snapshot options without network or secret echoes", async () => {
    const h = harness();
    const mutable = { ...h.options };
    const account = createHnAccount(mutable);
    mutable.sessionCookie = "changed-cookie";
    mutable.username = "changed";
    expect(h.requests).toHaveLength(0);
    h.queue.push(response(identity()));
    await expect(account.validateSession()).resolves.toEqual({ username: "reader" });
    expect(h.requests[0]?.headers).toMatchObject({ Cookie: "user=cookie-secret" });
    expect(() => createHnAccount({ ...h.options, sessionCookie: "bad;cookie-secret" })).toThrow(RangeError);
    try { createHnAccount({ ...h.options, sessionCookie: "bad;cookie-secret" }); } catch (error) { expect(String(error)).not.toContain("cookie-secret"); }
    expect(h.options.http.close).not.toHaveBeenCalled();
  });

  it("should distinguish expired mismatched and transient session responses", async () => {
    const expired = harness();
    expired.queue.push(response(identity("<form action=\"/login\"></form>", "")));
    await expectCode(createHnAccount(expired.options).validateSession(), "session-expired");
    const mismatch = harness();
    mismatch.queue.push(response(identity("", "other")));
    await expectCode(createHnAccount(mismatch.options).validateSession(), "username-mismatch");
    const transient = harness();
    transient.respond.mockImplementation(async () => { throw new HttpError("transport", { retryable: true, attempts: 1, cause: "secret-transport" }); });
    const error = await expectCode(createHnAccount(transient.options).validateSession(), "transport");
    expect(error.message).not.toContain("secret-transport");
    expect(error).not.toHaveProperty("cause");
  });

  it("should parse positive list observations and validated continuations with one page timestamp", async () => {
    const h = harness();
    h.queue.push(response(listPage([2, 1], "/upvoted?id=reader&after=2")), response(listPage([3])));
    const account = createHnAccount(h.options);
    const first = await account.readUpvoted();
    expect(first.observations).toEqual([
      { storyId: 2, kind: "upvote", present: true, observedAt: TIME },
      { storyId: 1, kind: "upvote", present: true, observedAt: TIME },
    ]);
    const second = await account.readUpvoted(first.nextCursor);
    expect(second.observations.map((row) => row.storyId)).toEqual([3]);
    expect(second).not.toHaveProperty("nextCursor");
    expect(h.requests.map((request) => request.url)).toEqual([
      `${ORIGIN}/upvoted?id=reader`, `${ORIGIN}/upvoted?id=reader&after=2`,
    ]);
    expect(second.observations.every((row) => row.present)).toBe(true);
  });

  it("should reject duplicate rows and cross-origin continuations before another request", async () => {
    const duplicate = harness();
    duplicate.queue.push(response(listPage([1, 1])));
    await expectCode(createHnAccount(duplicate.options).readUpvoted(), "parse-failed");
    const cross = harness();
    cross.queue.push(response(listPage([1], "https://evil.example/upvoted?id=reader")));
    const error = await expectCode(createHnAccount(cross.options).readUpvoted(), "origin-policy");
    expect(JSON.stringify(error)).not.toContain("evil.example");
    expect(cross.requests).toHaveLength(1);
  });

  it("should keep flag readback disabled by default and report capabilities in order", async () => {
    const disabled = harness();
    const account = createHnAccount(disabled.options);
    await expectCode(account.readFlagged(), "capability-disabled");
    disabled.queue.push(response(identity()), response(listPage([1])), response(listPage([], undefined, "favorites")));
    const capabilities = await account.capabilities();
    expect(capabilities.map((row) => row.name)).toEqual(["upvoted", "favorites", "flagged", "mutations"]);
    expect(capabilities[2]).toEqual({ name: "flagged", state: "unavailable", reason: "capability-disabled" });
    expect(capabilities[3]?.state).toBe("unverified");
    const enabled = harness({ flagReadbackEnabled: true });
    enabled.queue.push(response(listPage([4], undefined, "flagged")));
    await expect(createHnAccount(enabled.options).readFlagged()).resolves.toMatchObject({ observations: [{ storyId: 4, kind: "flag", present: true }] });
  });
});

describe("throttle redirects and cancellation", () => {
  it("should reserve throttle per manual GET redirect and reject a sixth hop", async () => {
    const h = harness({ maxRequestsPerMinute: 1 });
    h.queue.push(response("", 302, { location: ["/login"] }), response(identity("<form action=\"/login\"></form>", "")));
    const pending = createHnAccount(h.options).validateSession();
    await vi.waitFor(() => expect(h.waits).toHaveLength(1));
    h.waits[0]!.fire();
    await expectCode(pending, "session-expired");
    expect(h.requests).toHaveLength(2);
    expect(h.requests.every((request) => request.redirect === "manual")).toBe(true);

    const limited = harness();
    for (let index = 0; index < 6; index += 1) limited.queue.push(response("", 302, { location: [`/?hop=${index + 1}`] }));
    await expectCode(createHnAccount(limited.options).validateSession(), "redirect-limit");
    expect(limited.requests).toHaveLength(6);
  });

  it("should enforce a sliding request window with monotonic sleep", async () => {
    const h = harness({ maxRequestsPerMinute: 1 });
    const account = createHnAccount(h.options);
    h.queue.push(response(identity()), response(identity()));
    await account.validateSession();
    const second = account.validateSession();
    await vi.waitFor(() => expect(h.waits).toHaveLength(1));
    expect(h.waits[0]?.ms).toBe(60_000);
    expect(h.requests).toHaveLength(1);
    h.waits[0]!.fire();
    await second;
    expect(h.requests).toHaveLength(2);
  });

  it("should preserve exact abort reasons before dispatch and cancel queued work", async () => {
    const h = harness();
    let release!: (value: HttpResponse) => void;
    h.queue.push(new Promise<HttpResponse>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const reason = { cancel: true };
    const pending = createHnAccount(h.options).validateSession(controller.signal);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    release(response(identity()));
    expect(h.requests).toHaveLength(1);
  });
});

describe("action safety and outcomes", () => {
  it("should return verified without POST when current state is already present", async () => {
    const h = harness();
    h.queue.push(response(actionPage("upvote", "present")));
    const result = await createHnAccount(h.options).performAction(intent());
    expect(result).toEqual({ intentId: "intent-1", status: "verified", observedAt: TIME });
    expect(h.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  it("should issue exactly one fresh form POST and require positive readback", async () => {
    const h = harness();
    h.queue.push(response(actionPage("upvote", "absent", 1, "fresh-csrf-secret")), response("", 200), response(actionPage("upvote", "present")));
    const result = await createHnAccount(h.options).performAction(intent());
    expect(result.status).toBe("verified");
    expect(h.requests.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
    const post = h.requests[1]!;
    expect(post).toMatchObject({ url: `${ORIGIN}/vote`, redirect: "manual", maxResponseBytes: 5_000_000 });
    expect(post.body).toBe("id=1&how=up&csrf=fresh-csrf-secret&goto=item%3Fid%3D1");
    expect(post.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded", Cookie: "user=cookie-secret" });
  });

  it("should return indeterminate when a completed POST lacks positive readback", async () => {
    const h = harness();
    h.queue.push(response(actionPage("upvote", "absent")), response("", 200), response(actionPage("upvote", "absent")));
    const result = await createHnAccount(h.options).performAction(intent());
    expect(result).toMatchObject({ status: "indeterminate", errorCode: "verification-unavailable" });
    expect(h.requests.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("should map POST transport and redirect uncertainty without a second POST", async () => {
    for (const outcome of ["error", "redirect", "server"] as const) {
      const h = harness();
      h.queue.push(response(actionPage("upvote", "absent")));
      if (outcome === "error") h.queue.push(Promise.reject(new HttpError("timeout", { retryable: false, attempts: 1 })));
      else h.queue.push(response("", outcome === "redirect" ? 302 : 503, outcome === "redirect" ? { location: ["/vote"] } : {}));
      h.queue.push(response(actionPage("upvote", "absent")));
      const result = await createHnAccount(h.options).performAction(intent());
      expect(result).toMatchObject({ status: "indeterminate", errorCode: "post-outcome-unknown" });
      expect(h.requests.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
    }
  });

  it("should allow positive readback to win over an uncertain POST result", async () => {
    const h = harness();
    h.queue.push(response(actionPage("upvote", "absent")), Promise.reject(new HttpError("transport", { retryable: true, attempts: 1 })), response(actionPage("upvote", "present")));
    await expect(createHnAccount(h.options).performAction(intent())).resolves.toMatchObject({ status: "verified" });
  });

  it("should map definitive POST rejections to failed after readback", async () => {
    const h = harness();
    h.queue.push(response(actionPage("upvote", "absent")), response("", 400), response(actionPage("upvote", "absent")));
    await expect(createHnAccount(h.options).performAction(intent())).resolves.toMatchObject({ status: "failed", errorCode: "http-status" });
  });

  it("should refuse unknown state and malformed forms before dispatch", async () => {
    const unknown = harness();
    unknown.queue.push(response(actionPage("upvote", "unknown")));
    await expect(createHnAccount(unknown.options).performAction(intent())).resolves.toMatchObject({ status: "failed", errorCode: "capability-unverified" });
    expect(unknown.requests.map((request) => request.method)).toEqual(["GET"]);
    const malformed = harness();
    malformed.queue.push(response(actionPage("upvote", "absent", 1, "csrf-secret", "<input type=\"hidden\" name=\"admin\" value=\"true\">")));
    const result = await createHnAccount(malformed.options).performAction(intent());
    expect(result).toMatchObject({ status: "failed", errorCode: "action-conflict" });
    expect(JSON.stringify(result)).not.toContain("csrf-secret");
    expect(malformed.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  it("should reconcile an indeterminate retry before suppressing another POST", async () => {
    const h = harness();
    h.queue.push(response(actionPage("upvote", "present")));
    const result = await createHnAccount(h.options).performAction(intent("retry", "upvote", "indeterminate"));
    expect(result.status).toBe("verified");
    expect(h.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  it("should return cancelled-after-dispatch when abort follows POST invocation", async () => {
    const h = harness();
    h.queue.push(response(actionPage("upvote", "absent")), new Promise<HttpResponse>(() => {}));
    const controller = new AbortController();
    const reason = { abort: true };
    const pending = createHnAccount(h.options).performAction(intent(), controller.signal);
    await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    controller.abort(reason);
    await expect(pending).resolves.toMatchObject({ status: "indeterminate", errorCode: "cancelled-after-dispatch" });
    expect(h.requests.map((request) => request.method)).toEqual(["GET", "POST"]);
  });

  it("should preserve the exact abort reason when throttle cancellation precedes POST dispatch", async () => {
    const h = harness({ maxRequestsPerMinute: 1 });
    h.queue.push(response(actionPage("upvote", "absent")));
    const controller = new AbortController();
    const reason = { abortBeforeDispatch: true };
    const pending = createHnAccount(h.options).performAction(intent(), controller.signal);
    await vi.waitFor(() => expect(h.waits).toHaveLength(1));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(h.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  it("should share identical concurrent intents and reject conflicting reuse", async () => {
    const h = harness();
    let complete!: (value: HttpResponse) => void;
    h.queue.push(response(actionPage("upvote", "absent")), new Promise<HttpResponse>((resolve) => { complete = resolve; }), response(actionPage("upvote", "present")));
    const account = createHnAccount(h.options);
    const first = account.performAction(intent());
    const second = account.performAction(intent());
    await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    await expect(account.performAction({ ...intent(), idempotencyKey: "different" })).rejects.toMatchObject({ code: "invalid-input" });
    complete(response(""));
    const results = await Promise.all([first, second]);
    expect(results.every((result) => result.status === "verified")).toBe(true);
    expect(h.requests.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("should reject terminal intents instead of re-executing them", async () => {
    const h = harness();
    await expectCode(createHnAccount(h.options).performAction(intent("terminal", "upvote", "failed")), "action-conflict");
    expect(h.requests).toHaveLength(0);
  });
});
