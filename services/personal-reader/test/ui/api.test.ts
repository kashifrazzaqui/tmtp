import { afterEach, describe, expect, it, vi } from "vitest";
import { api, getCsrf, setCsrf, streamDebug } from "../../src/ui/api.js";
import type { DebugStreamFrame } from "../../src/ui/types.js";

afterEach(() => {
  setCsrf(undefined);
  vi.unstubAllGlobals();
});

describe("API transport", () => {
  it("should omit queue and history limits so server defaults apply", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://reader.test").pathname;
      const body = path.endsWith("/hn-actions") ? [] : {
        items: [],
        evaluationCounts: { pending: 0, scored: 0, failed: 0 },
        rankVersions: [],
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.queue({ visibilityState: "visible" });
    await api.hnHistory(42, "history-cursor");

    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://reader.test"));
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.searchParams.has("limit") === false)).toBe(true);
    expect(urls[1]?.searchParams.get("afterId")).toBe("history-cursor");
  });

  it("should prefer explicit in-memory CSRF state over readable but unwritable storage", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => "stale-csrf"),
      setItem: vi.fn(() => { throw new Error("storage is read-only"); }),
      removeItem: vi.fn(() => { throw new Error("storage is read-only"); }),
    });

    setCsrf("fresh-csrf");
    expect(getCsrf()).toBe("fresh-csrf");

    setCsrf(undefined);
    expect(getCsrf()).toBeUndefined();
  });

  it("should send CSRF only for protected commands and exact queue state input", async () => {
    setCsrf("test-csrf");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      storyId: 42,
      state: "read",
      evaluationState: "scored",
      visibilityState: "visible",
      kind: "match",
      rankVersion: "rank-1",
      queuedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.setQueueState(42, "read");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/queue/42");
    expect(init.method).toBe("PATCH");
    expect(new Headers(init.headers).get("x-tmtp-csrf")).toBe("test-csrf");
    expect(init.body).toBe(JSON.stringify({ state: "read" }));
  });

  it("should parse incremental fetch SSE with CSRF and ignore heartbeats", async () => {
    setCsrf("stream-csrf");
    const encoder = new TextEncoder();
    const chunks = [
      ": heartbeat\n\nretry: 3000\nevent: debug-snapshot\nid: 1\nda",
      "ta: {\"sequence\":1,\ndata: \"snapshot\":{\"schemaVersion\":1}}\n\n",
    ];
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const frames: DebugStreamFrame[] = [];

    await streamDebug({ signal: new AbortController().signal, onFrame: (frame) => frames.push(frame) });

    expect(frames).toHaveLength(1);
    expect(frames[0]?.sequence).toBe(1);
    expect(frames[0]?.snapshot).toEqual({ schemaVersion: 1 });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("x-tmtp-csrf")).toBe("stream-csrf");
    expect(new Headers(init.headers).get("Accept")).toBe("text/event-stream");
  });
});
