import type { HnFeed, HnItem, Story } from "@tmtp/domain";
import { HttpError } from "@tmtp/http-client";
import type { HttpClient, HttpRequest, HttpResponse } from "@tmtp/http-client";
import { describe, expect, it, vi } from "vitest";
import { createHnPublicApi, HnPublicApiError, normalizeStory } from "../src/index.js";
import type { HnPublicApiErrorCode, HnPublicApiOperation } from "../src/index.js";

const BASE = "https://hacker-news.firebaseio.com/v0/";
const OBSERVED = "2026-05-01T00:00:00.000Z";
function json(value: unknown, status = 200, headers: Record<string, readonly string[]> = {}): HttpResponse {
  return { status, headers: { "content-type": ["application/json"], ...headers }, body: Buffer.from(JSON.stringify(value)), finalUrl: `${BASE}fixture.json` };
}
function harness(baseUrl = "https://hacker-news.firebaseio.com/v0") {
  const requests: HttpRequest[] = [];
  const queue: Array<HttpResponse | Promise<HttpResponse>> = [];
  const request = vi.fn((input: HttpRequest): Promise<HttpResponse> => {
    requests.push(input);
    const next = queue.shift();
    if (next === undefined) throw new Error("No scripted response.");
    return Promise.resolve(next);
  });
  const http: HttpClient = { request, close: vi.fn(async () => {}) };
  return { api: createHnPublicApi({ baseUrl, http }), requests, queue, http, request };
}
async function expectApiError(promise: Promise<unknown>, code: HnPublicApiErrorCode, operation: HnPublicApiOperation): Promise<HnPublicApiError> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(HnPublicApiError);
    const value = error as HnPublicApiError;
    expect(value.code).toBe(code);
    expect(value.operation).toBe(operation);
    return value;
  }
  throw new Error(`Expected ${code}`);
}
function item(id = 42, changes: Partial<HnItem> = {}): HnItem {
  return {
    id, type: "story", author: "Zoë", time: 1_700_000_000, title: "Hello \"HN\" 👋",
    url: "https://Example.com:443/a#fragment", textHtml: "<b>x</b>", score: 10, descendants: 2,
    deleted: false, dead: false, raw: { id, type: "story", custom: "raw" }, rawSchemaVersion: 1, ...changes,
  };
}

describe("construction endpoints and cancellation", () => {
  it("should validate and snapshot base URLs without echoing secrets", async () => {
    for (const baseUrl of ["https://user:pass@example.com/v0", "https://example.com/v0?key=secret", "https://example.com/v0#secret", "file:///tmp/secret"]) {
      expect(() => createHnPublicApi({ baseUrl, http: { request: vi.fn(), close: vi.fn() } })).toThrow(TypeError);
      try { createHnPublicApi({ baseUrl, http: { request: vi.fn(), close: vi.fn() } }); } catch (error) { expect(String(error)).not.toContain("secret"); }
    }
    const options = { baseUrl: "https://example.com/v0", http: { request: vi.fn(async () => json(9)), close: vi.fn(async () => {}) } };
    const api = createHnPublicApi(options);
    options.baseUrl = "https://changed.example/";
    await expect(api.maxItemId()).resolves.toBe(9);
    expect(options.http.request.mock.calls[0]?.[0].url).toBe("https://example.com/v0/maxitem.json");
  });

  it("should map every official endpoint and exact request policy", async () => {
    const h = harness("https://example.com/v0/");
    const feedPaths: Record<HnFeed, string> = { top: "topstories", new: "newstories", best: "beststories", ask: "askstories", show: "showstories" };
    for (const [feed, path] of Object.entries(feedPaths)) {
      h.queue.push(json([]));
      await expect(h.api.feed(feed as HnFeed)).resolves.toEqual([]);
      expect(h.requests.at(-1)?.url).toBe(`https://example.com/v0/${path}.json`);
    }
    h.queue.push(json(100), json(null));
    await h.api.maxItemId();
    await h.api.item(7);
    expect(h.requests.at(-2)?.url).toBe("https://example.com/v0/maxitem.json");
    expect(h.requests.at(-1)?.url).toBe("https://example.com/v0/item/7.json");
    for (const request of h.requests) {
      expect(request).toMatchObject({ method: "GET", headers: { accept: "application/json" }, redirect: "same-origin", maxResponseBytes: 5_000_000 });
      expect(request).not.toHaveProperty("body");
      expect(request).not.toHaveProperty("timeoutMs");
      expect(request.headers).not.toHaveProperty("cookie");
      expect(request.headers).not.toHaveProperty("authorization");
      expect(request.headers).not.toHaveProperty("accept-encoding");
    }
    expect(h.http.close).not.toHaveBeenCalled();
  });

  it("should reject invalid operation input before pre-abort and preserve caller reasons", async () => {
    const h = harness();
    const controller = new AbortController();
    const reason = { cancel: "identity" };
    controller.abort(reason);
    await expectApiError(h.api.item(0, controller.signal), "invalid-input", "item");
    expect(h.requests).toHaveLength(0);
    await expect(h.api.item(1, controller.signal)).rejects.toBe(reason);
    await expectApiError(h.api.feed("other" as HnFeed), "invalid-input", "feed");
    const inFlight = harness();
    const inFlightController = new AbortController();
    inFlight.request.mockImplementation(async (request: HttpRequest) => {
      inFlightController.abort(reason);
      return json(8);
    });
    await expect(inFlight.api.maxItemId(inFlightController.signal)).rejects.toBe(reason);
    expect(inFlight.request.mock.calls[0]?.[0].signal).toBe(inFlightController.signal);
  });

  it("should map every HTTP error and final status safely", async () => {
    const cases: Array<[ConstructorParameters<typeof HttpError>[0], HnPublicApiErrorCode, boolean]> = [
      ["invalid-request", "invalid-input", false], ["timeout", "timeout", false], ["response-too-large", "response-too-large", false],
      ["redirect-policy", "redirect-policy", false], ["redirect-limit", "redirect-limit", false], ["invalid-redirect", "invalid-redirect", false],
      ["transport", "transport", true], ["client-closed", "client-closed", false],
    ];
    for (const [upstream, code, retryable] of cases) {
      const h = harness();
      h.queue.push(Promise.reject(new HttpError(upstream, { retryable: true, attempts: 2, status: 503, cause: "secret-cause" })));
      const error = await expectApiError(h.api.maxItemId(), code, "max-item");
      expect(error.retryable).toBe(retryable);
      if (code !== "invalid-input" && code !== "timeout" && code !== "transport" && code !== "client-closed") expect(error.status).toBe(503);
      expect(JSON.stringify(error)).not.toContain("secret-cause");
      expect(error).not.toHaveProperty("cause");
    }
    for (const status of [400, 408, 425, 429, 500, 502, 503, 504]) {
      const h = harness();
      h.queue.push(json({ ignored: true }, status));
      const error = await expectApiError(h.api.maxItemId(), "http-status", "max-item");
      expect(error.status).toBe(status);
      expect(error.retryable).toBe([408, 425, 429, 500, 502, 503, 504].includes(status));
    }
  });
});

describe("JSON and endpoint shapes", () => {
  it("should require JSON media type UTF-8 charset and identity encoding", async () => {
    const invalid: HttpResponse[] = [
      { ...json(1), headers: {} },
      { ...json(1), headers: { "content-type": ["application/json", "application/json"] } },
      { ...json(1), headers: { "content-type": ["text/json"] } },
      { ...json(1), headers: { "content-type": ["application/json; charset=utf-16"] } },
      { ...json(1), headers: { "content-type": ["application/json; charset=utf-8; charset=utf8"] } },
      { ...json(1), headers: { "content-type": ["application/json"], "content-encoding": ["gzip"] } },
      { ...json(1), body: new Uint8Array([0xff]) },
      { ...json(1), body: Buffer.from("") },
      { ...json(1), body: Buffer.from("{bad") },
      { ...json(1), body: Buffer.from("1 2") },
    ];
    for (const response of invalid) {
      const h = harness();
      h.queue.push(response);
      await expectApiError(h.api.maxItemId(), "invalid-response", "max-item");
    }
    const valid = harness();
    valid.queue.push({ ...json(1), headers: { "content-type": ["Application/JSON; CHARSET=\"UTF8\""], "content-encoding": ["identity"] } });
    await expect(valid.api.maxItemId()).resolves.toBe(1);
  });

  it("should enforce max-item and feed ID and count boundaries", async () => {
    for (const value of [0, -1, 1.5, "1", null, true, Number.MAX_SAFE_INTEGER + 1]) {
      const h = harness(); h.queue.push(json(value));
      await expectApiError(h.api.maxItemId(), "invalid-response", "max-item");
    }
    const h = harness();
    h.queue.push(json([3, 1, 2]), json([]), json([1, 1]), json(Array.from({ length: 501 }, (_, i) => i + 1)), json(Array.from({ length: 201 }, (_, i) => i + 1)));
    await expect(h.api.feed("top")).resolves.toEqual([3, 1, 2]);
    await expect(h.api.feed("new")).resolves.toEqual([]);
    await expectApiError(h.api.feed("best"), "invalid-response", "feed");
    await expectApiError(h.api.feed("top"), "invalid-response", "feed");
    await expectApiError(h.api.feed("ask"), "invalid-response", "feed");
  });

  it("should distinguish null tombstones and non-story items while preserving raw fields", async () => {
    const h = harness();
    h.queue.push(json(null), json({ id: 2, type: "comment", by: "Case", text: "<i>raw</i>", parent: 1, kids: [3], future: { keep: true } }),
      json({ id: 3, deleted: true }), json({ id: 4, dead: true }));
    await expect(h.api.item(1)).resolves.toBeUndefined();
    const comment = await h.api.item(2);
    expect(comment).toMatchObject({ id: 2, type: "comment", author: "Case", textHtml: "<i>raw</i>", deleted: false, dead: false, rawSchemaVersion: 1 });
    expect(comment?.raw).toEqual({ id: 2, type: "comment", by: "Case", text: "<i>raw</i>", parent: 1, kids: [3], future: { keep: true } });
    expect(comment).not.toHaveProperty("parent");
    await expect(h.api.item(3)).resolves.toMatchObject({ id: 3, deleted: true, dead: false });
    await expect(h.api.item(4)).resolves.toMatchObject({ id: 4, deleted: false, dead: true });
  });

  it("should validate known fields and omit only empty URLs", async () => {
    const invalid = [
      { id: 2, type: "story" }, { id: 1 }, { id: 1, type: "unknown" }, { id: 1, type: null },
      { id: 1, type: "story", time: -1 }, { id: 1, type: "story", score: 1.5 }, { id: 1, type: "story", descendants: null },
      { id: 1, type: "story", deleted: null }, { id: 1, type: "story", by: 3 }, { id: 1, type: "story", time: Number.MAX_SAFE_INTEGER },
    ];
    for (const value of invalid) {
      const h = harness(); h.queue.push(json(value));
      await expectApiError(h.api.item(1), "invalid-response", "item");
    }
    const h = harness(); h.queue.push(json({ id: 1, type: "story", title: "Ask", url: "", text: "body" }));
    const result = await h.api.item(1);
    expect(result).toMatchObject({ title: "Ask", textHtml: "body", deleted: false, dead: false });
    expect(result).not.toHaveProperty("url");
  });

  it("should return detached raw and feed results across concurrent calls", async () => {
    const h = harness();
    const raw = { id: 1, type: "story", title: "One", nested: { value: 1 } };
    h.queue.push(json(raw), json(raw), json([1, 2]), json([1, 2]));
    const [first, second, feedOne, feedTwo] = await Promise.all([h.api.item(1), h.api.item(1), h.api.feed("top"), h.api.feed("top")]);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first?.raw).not.toBe(second?.raw);
    first!.raw.nested = { value: 99 };
    expect(second?.raw.nested).toEqual({ value: 1 });
    feedOne.push(3);
    expect(feedTwo).toEqual([1, 2]);
  });
});

describe("pure story normalization", () => {
  it("should normalize a complete story and match the golden content version", () => {
    const story = normalizeStory({ item: item(), observedAt: OBSERVED });
    expect(story).toMatchObject({
      id: 42, itemType: "story", url: "https://Example.com:443/a#fragment", canonicalUrl: "https://example.com/a",
      title: "Hello \"HN\" 👋", author: "Zoë", textHtml: "<b>x</b>", publishedAt: "2023-11-14T22:13:20.000Z",
      firstSeenAt: OBSERVED, lastSeenAt: OBSERVED, contentVersion: "sha256:4ab7c6f089feed45ea03e1bd95a9e5e519ba33b76f32f51455b125c1aee02988",
      rawSchemaVersion: 1, deleted: false, dead: false,
    });
    expect(story?.raw.raw).toEqual({ id: 42, type: "story", custom: "raw" });
  });

  it("should preserve previous first-seen data only for tombstone metadata", () => {
    const previous = normalizeStory({ item: item(), observedAt: "2026-01-01T00:00:00.000Z" })!;
    const tombstone = item(42, { title: undefined, time: undefined, author: undefined, textHtml: undefined, score: undefined, descendants: undefined, deleted: true, raw: { id: 42, deleted: true }, type: undefined });
    const merged = normalizeStory({ item: tombstone, observedAt: OBSERVED, previous })!;
    expect(merged).toMatchObject({
      title: previous.title, author: previous.author, textHtml: previous.textHtml, publishedAt: previous.publishedAt,
      firstSeenAt: previous.firstSeenAt, lastSeenAt: OBSERVED, deleted: true, score: previous.score, descendants: previous.descendants,
    });
    expect(merged.raw.type).toBeUndefined();
    const live = normalizeStory({ item: item(42, { author: undefined, textHtml: undefined }), observedAt: OBSERVED, previous })!;
    expect(live).not.toHaveProperty("author");
    expect(live).not.toHaveProperty("textHtml");
    expect(normalizeStory({ item: tombstone, observedAt: OBSERVED })).toBeUndefined();
    expect(normalizeStory({ item: item(42, { type: "comment" }), observedAt: OBSERVED, previous })).toBeUndefined();
  });

  it("should retain source URLs without canonicalizing invalid or credential-bearing values", () => {
    for (const url of ["not a url", "ftp://example.com/a#b", "https://user:pass@example.com/a#b"]) {
      const story = normalizeStory({ item: item(42, { url }), observedAt: OBSERVED });
      expect(story?.url).toBe(url);
      expect(story).not.toHaveProperty("canonicalUrl");
    }
  });

  it("should change versions only for included reader-facing fields", () => {
    const base = normalizeStory({ item: item(), observedAt: OBSERVED })!;
    const unchanged = [
      item(42, { score: 999 }), item(42, { descendants: 999 }), item(42, { raw: { id: 42, type: "story", custom: "changed" } }),
    ];
    for (const value of unchanged) expect(normalizeStory({ item: value, observedAt: "2027-01-01T00:00:00.000Z", previous: base })?.contentVersion).toBe(base.contentVersion);
    const changed = [item(42, { title: "Changed" }), item(42, { url: "https://example.com/other" }), item(42, { dead: true }), item(42, { author: "Other" })];
    for (const value of changed) expect(normalizeStory({ item: value, observedAt: OBSERVED })?.contentVersion).not.toBe(base.contentVersion);
  });

  it("should validate the complete input and detach returned structures", () => {
    const source = item();
    const previous = normalizeStory({ item: source, observedAt: "2026-01-01T00:00:00.000Z" })!;
    const result = normalizeStory({ item: source, observedAt: OBSERVED, previous })!;
    source.title = "mutated";
    source.raw.custom = "mutated";
    previous.firstSeenAt = "2020-01-01T00:00:00.000Z";
    expect(result.title).toBe("Hello \"HN\" 👋");
    expect(result.raw.raw.custom).toBe("raw");
    expect(result.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
    expect(() => normalizeStory({ item: source, observedAt: "invalid" })).toThrowError(expect.objectContaining({ code: "invalid-input", operation: "normalize-story" }));
    expect(() => normalizeStory({ item: source, observedAt: OBSERVED, previous: item() as unknown as Story })).toThrow(HnPublicApiError);
    expect(() => normalizeStory({ item: source, observedAt: OBSERVED, previous })).not.toThrow();
    expect(() => normalizeStory({ item: item(43), observedAt: OBSERVED, previous })).toThrowError(expect.objectContaining({ code: "invalid-input" }));
    expect(() => normalizeStory({ item: source, observedAt: OBSERVED, extra: true } as never)).toThrow(HnPublicApiError);
  });
});
