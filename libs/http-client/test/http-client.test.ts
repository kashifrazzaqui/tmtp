import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createFixedClock } from "@tmtp/clock";
import { describe, expect, it, vi } from "vitest";
import { createHttpClient, HttpError } from "../src/index.js";
import type {
  HttpClientOptions,
  HttpTransport,
  HttpTransportRequest,
  HttpTransportResponse,
} from "../src/index.js";

interface SleepCall {
  delay: number;
  signal?: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  settled: boolean;
}

function sleepHarness(autoResolve = (delay: number) => delay !== 1_000) {
  const calls: SleepCall[] = [];
  const sleep: HttpClientOptions["sleep"] = (delay, signal) => new Promise<void>((resolve, reject) => {
    let cleanup = () => {};
    const call: SleepCall = {
      delay,
      ...(signal === undefined ? {} : { signal }),
      settled: false,
      resolve: () => {
        if (call.settled) return;
        call.settled = true;
        cleanup();
        resolve();
      },
      reject: (reason) => {
        if (call.settled) return;
        call.settled = true;
        cleanup();
        reject(reason);
      },
    };
    calls.push(call);
    if (signal !== undefined) {
      const abort = () => call.reject(signal.reason);
      cleanup = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    if (autoResolve(delay)) queueMicrotask(call.resolve);
  });
  return { calls, sleep };
}

function body(chunks: Uint8Array[], closed: () => void = () => {}): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      let done = false;
      return {
        next: async (): Promise<IteratorResult<Uint8Array>> => {
          if (done || index >= chunks.length) {
            done = true;
            return { done: true, value: undefined };
          }
          return { done: false, value: chunks[index++]! };
        },
        return: async (): Promise<IteratorResult<Uint8Array>> => {
          if (!done) closed();
          done = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
}

const response = (
  status = 200,
  chunks: Uint8Array[] = [],
  headers: HttpTransportResponse["headers"] = {},
  closed?: () => void,
): HttpTransportResponse => ({ status, headers, body: body(chunks, closed) });
const text = (value: string) => new TextEncoder().encode(value);

class FakeTransport implements HttpTransport {
  readonly requests: HttpTransportRequest[] = [];
  closeCalls = 0;
  constructor(readonly steps: Array<HttpTransportResponse | unknown | ((request: HttpTransportRequest) => HttpTransportResponse | Promise<HttpTransportResponse>)> = []) {}
  async request(request: HttpTransportRequest): Promise<HttpTransportResponse> {
    this.requests.push({ ...request, headers: { ...request.headers }, ...(request.body instanceof Uint8Array ? { body: new Uint8Array(request.body) } : {}) });
    const step = this.steps.length === 0 ? response() : this.steps.shift();
    if (typeof step === "function") return step(request);
    if (step instanceof Error || (step !== null && typeof step === "object" && !(step as HttpTransportResponse).body)) throw step;
    return step as HttpTransportResponse;
  }
  async close(): Promise<void> { this.closeCalls += 1; }
}

function loggerFake() {
  const logger = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition was not reached.");
}

function setup(
  transport = new FakeTransport(),
  overrides: Partial<HttpClientOptions> = {},
) {
  const sleeps = sleepHarness();
  const logger = loggerFake();
  const clock = createFixedClock(new Date("2026-01-01T00:00:00.000Z"));
  const client = createHttpClient({
    clock,
    sleep: sleeps.sleep,
    timeoutMs: 1_000,
    userAgent: " test-agent ",
    retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
    logger,
    transport,
    ...overrides,
  });
  return { client, transport, sleeps, logger, clock };
}

const get = (url = "http://example.com/path"): Parameters<ReturnType<typeof createHttpClient>["request"]>[0] => ({
  method: "GET", url, redirect: "manual",
});

describe("validation and basic responses", () => {
  it("should normalize responses and snapshot URL headers and configured User-Agent", async () => {
    const transport = new FakeTransport([response(200, [text("hello")], { "X-Test": ["a", "b"], "Set-Cookie": ["a=1", "b=2"] })]);
    const { client } = setup(transport);
    const result = await client.request({ ...get("http://example.com/path?q=1#fragment"), headers: { "X-Key": "value" } });
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe("http://example.com/path?q=1");
    expect(result.body).toEqual(text("hello"));
    expect(result.headers["x-test"]).toEqual(["a", "b"]);
    expect(result.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect(transport.requests[0]).toMatchObject({ url: "http://example.com/path?q=1", headers: { "x-key": "value", "user-agent": "test-agent" } });
    await client.close();
  });

  it("should reject invalid requests before transport sleep or logging", async () => {
    const { client, transport, sleeps, logger } = setup();
    const requests = [
      { ...get(), method: "PUT" },
      { ...get("relative/path") },
      { ...get("ftp://example.com/a") },
      { ...get("http://user:pass@example.com/a") },
      { ...get(), body: "no" },
      { ...get(), timeoutMs: 0 },
      { ...get(), maxResponseBytes: -1 },
      { ...get(), redirect: "follow" },
      { ...get(), headers: { "Bad Header": "x" } },
      { ...get(), headers: { "X-Test": "a", "x-test": "b" } },
      { ...get(), headers: { Host: "other" } },
      { ...get(), headers: { "X-Test": "bad\nvalue" } },
      { ...get(), connection: { address: "localhost", port: 80, servername: "example.com" } },
      { ...get(), connection: { address: "127.0.0.1", port: 81, servername: "example.com" } },
      { ...get(), connection: { address: "127.0.0.1", port: 80, servername: "other.example" } },
    ];
    for (const request of requests) {
      await expect(client.request(request as never)).rejects.toMatchObject({ code: "invalid-request", attempts: 0, retryable: false });
    }
    expect(transport.requests).toHaveLength(0);
    expect(sleeps.calls).toHaveLength(0);
    expect(logger.debug).not.toHaveBeenCalled();
    await client.close();
  });

  it("should preserve pre-abort reason and validate before close and cancellation", async () => {
    const { client, transport, sleeps } = setup();
    const controller = new AbortController();
    const reason = { marker: "caller" };
    controller.abort(reason);
    await expect(client.request({ ...get(), signal: controller.signal })).rejects.toBe(reason);
    await client.close();
    await expect(client.request({ ...get("bad"), signal: controller.signal })).rejects.toMatchObject({ code: "invalid-request" });
    await expect(client.request(get())).rejects.toMatchObject({ code: "client-closed" });
    expect(transport.requests).toHaveLength(0);
    expect(sleeps.calls).toHaveLength(0);
  });
});

describe("retry and deadlines", () => {
  it("should retry GET transport failures sequentially with snapshotted headers", async () => {
    const transport = new FakeTransport([new Error("socket"), response(200, [text("ok")])]);
    const random = vi.fn(() => 0.5);
    const { client, sleeps } = setup(transport, { random });
    const headers = { "X-Original": "before" };
    const pending = client.request({ ...get(), headers });
    headers["X-Original"] = "after";
    const result = await pending;
    expect(result.status).toBe(200);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.every((request) => request.headers["x-original"] === "before")).toBe(true);
    expect(sleeps.calls.filter((call) => call.delay === 10)).toHaveLength(1);
    expect(random).not.toHaveBeenCalled();
    await client.close();
  });

  it("should retry eligible statuses and return the final status after exhaustion", async () => {
    const first = setup(new FakeTransport([response(503), response(200, [text("ok")])]));
    expect((await first.client.request(get())).status).toBe(200);
    expect(first.transport.requests).toHaveLength(2);
    await first.client.close();

    const second = setup(new FakeTransport([response(503, [text("one")]), response(429, [text("two")])]), {
      retryPolicy: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
    });
    const result = await second.client.request(get());
    expect(result.status).toBe(429);
    expect(new TextDecoder().decode(result.body)).toBe("two");
    expect(second.transport.requests).toHaveLength(2);
    await second.client.close();
  });

  it("should never retry POST or report its transport error as retryable", async () => {
    const random = vi.fn(() => 0.5);
    const { client, transport, sleeps } = setup(new FakeTransport([new Error("socket")]), { random });
    await expect(client.request({ ...get(), method: "POST", body: text("body") })).rejects.toMatchObject({
      code: "transport", retryable: false, attempts: 1,
    });
    expect(transport.requests).toHaveLength(1);
    expect(random).not.toHaveBeenCalled();
    expect(sleeps.calls.filter((call) => call.delay === 10)).toHaveLength(0);
    await client.close();
  });

  it("should apply one total deadline across retry backoff and prevent another attempt", async () => {
    const sleeps = sleepHarness(() => false);
    const transport = new FakeTransport([new Error("socket"), response(200)]);
    const { client } = setup(transport, { sleep: sleeps.sleep });
    const pending = client.request(get());
    await waitFor(() => sleeps.calls.some((call) => call.delay === 10 && !call.settled));
    sleeps.calls.find((call) => call.delay === 1_000)!.resolve();
    await expect(pending).rejects.toMatchObject({ code: "timeout", retryable: false, attempts: 1 });
    expect(transport.requests).toHaveLength(1);
    expect(sleeps.calls.every((call) => call.settled)).toBe(true);
    await client.close();
  });

  it("should preserve caller cancellation reason through in-flight transport", async () => {
    const reason = { marker: "stop" };
    const controller = new AbortController();
    const transport = new FakeTransport([
      (request: HttpTransportRequest) => new Promise<HttpTransportResponse>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      }),
    ]);
    const { client, logger } = setup(transport);
    const pending = client.request({ ...get(), signal: controller.signal });
    await waitFor(() => transport.requests.length === 1);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(logger.warn).toHaveBeenCalledWith("http.request.failed", expect.objectContaining({ errorCode: "cancelled" }));
    await client.close();
  });
});

describe("redirects and size limits", () => {
  it("should convert POST to GET on 303 and preserve it on 307", async () => {
    const first = setup(new FakeTransport([
      response(303, [], { location: "/next" }), response(200),
    ]));
    await first.client.request({ ...get("http://example.com/start"), method: "POST", redirect: "same-origin", body: "body", headers: { "Content-Type": "text/plain", "X-Keep": "yes" } });
    expect(first.transport.requests[1]).toMatchObject({ method: "GET", url: "http://example.com/next", headers: { "x-keep": "yes", "user-agent": "test-agent" } });
    expect(first.transport.requests[1]?.body).toBeUndefined();
    expect(first.transport.requests[1]?.headers["content-type"]).toBeUndefined();
    await first.client.close();

    const second = setup(new FakeTransport([response(307, [], { location: "/next" }), response(200)]));
    await second.client.request({ ...get("http://example.com/start"), method: "POST", redirect: "same-origin", body: "body" });
    expect(second.transport.requests[1]?.method).toBe("POST");
    expect(second.transport.requests[1]?.body).toBe("body");
    await second.client.close();
  });

  it("should reject unsafe redirects without another hop and close their bodies", async () => {
    for (const [location, code] of [
      ["https://example.com/next", "redirect-policy"],
      ["http://other.example/next", "redirect-policy"],
      ["http://user:pass@example.com/next", "invalid-redirect"],
      ["http://[::1", "invalid-redirect"],
    ]) {
      const closed = vi.fn();
      const { client, transport } = setup(new FakeTransport([response(301, [], { location }, closed)]));
      await expect(client.request({ ...get(), redirect: "same-origin" })).rejects.toMatchObject({ code, status: 301, attempts: 1 });
      expect(transport.requests).toHaveLength(1);
      expect(closed).toHaveBeenCalledOnce();
      await client.close();
    }
  });

  it("should enforce five follows and leave manual redirects untouched", async () => {
    const redirects = Array.from({ length: 6 }, () => response(302, [], { location: "/next" }));
    const { client, transport } = setup(new FakeTransport(redirects));
    await expect(client.request({ ...get(), redirect: "same-origin" })).rejects.toMatchObject({ code: "redirect-limit", attempts: 1 });
    expect(transport.requests).toHaveLength(6);
    await client.close();

    const manual = setup(new FakeTransport([response(302, [text("manual")], { location: "http://other.example" })]));
    const result = await manual.client.request(get());
    expect(result.status).toBe(302);
    expect(manual.transport.requests).toHaveLength(1);
    await manual.client.close();
  });

  it("should enforce declared and streamed limits and permit exact and empty bodies", async () => {
    const declaredClosed = vi.fn();
    const declared = setup(new FakeTransport([response(200, [], { "content-length": "3" }, declaredClosed)]));
    await expect(declared.client.request({ ...get(), maxResponseBytes: 2 })).rejects.toMatchObject({ code: "response-too-large", retryable: false, status: 200 });
    expect(declaredClosed).toHaveBeenCalledOnce();
    expect(declared.transport.requests).toHaveLength(1);
    await declared.client.close();

    const streamedClosed = vi.fn();
    const streamed = setup(new FakeTransport([response(200, [text("ab"), text("c")], {}, streamedClosed)]));
    await expect(streamed.client.request({ ...get(), maxResponseBytes: 2 })).rejects.toMatchObject({ code: "response-too-large" });
    expect(streamedClosed).toHaveBeenCalledOnce();
    await streamed.client.close();

    const exact = setup(new FakeTransport([response(200, [text("ab")])]));
    expect((await exact.client.request({ ...get(), maxResponseBytes: 2 })).body).toEqual(text("ab"));
    await exact.client.close();
    const empty = setup(new FakeTransport([response(200, [text("a")])]));
    await expect(empty.client.request({ ...get(), maxResponseBytes: 0 })).rejects.toMatchObject({ code: "response-too-large" });
    await empty.client.close();
  });
});

describe("logging and lifecycle", () => {
  it("should log only allowlisted fields and drain active work before closing once", async () => {
    let finish: ((value: HttpTransportResponse) => void) | undefined;
    const transport = new FakeTransport([
      () => new Promise<HttpTransportResponse>((resolve) => { finish = resolve; }),
    ]);
    const { client, logger } = setup(transport);
    const pending = client.request({ ...get("http://example.com/private?token=secret"), headers: { Authorization: "secret" } });
    await waitFor(() => transport.requests.length === 1);
    const firstClose = client.close();
    const secondClose = client.close();
    expect(secondClose).toBe(firstClose);
    await expect(client.request(get())).rejects.toMatchObject({ code: "client-closed" });
    finish!(response(200, [text("ok")], { "content-length": "2" }));
    expect((await pending).status).toBe(200);
    await firstClose;
    expect(transport.closeCalls).toBe(1);
    expect(logger.debug).toHaveBeenCalledWith("http.request.started", {
      method: "GET", origin: "http://example.com", timeoutMs: 1_000, maxResponseBytes: 5_000_000,
      redirectPolicy: "manual", connectionPinned: false,
    });
    expect(logger.info).toHaveBeenCalledWith("http.request.completed", {
      method: "GET", origin: "http://example.com", status: 200, attempts: 1, elapsedMs: 0,
      responseBytes: 2, redirectCount: 0, connectionPinned: false,
    });
    for (const call of [...logger.debug.mock.calls, ...logger.info.mock.calls, ...logger.warn.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain("secret");
      expect(JSON.stringify(call)).not.toContain("/private");
    }
  });

  it("should keep concurrent clients and close promises independent", async () => {
    const first = setup();
    const second = setup();
    await Promise.all([first.client.request(get()), second.client.request(get())]);
    await Promise.all([first.client.close(), second.client.close()]);
    expect(first.transport.closeCalls).toBe(1);
    expect(second.transport.closeCalls).toBe(1);
  });
});

describe("real Undici transport", () => {
  it("should dial a pinned address without DNS and preserve the original Host", async () => {
    const hosts: string[] = [];
    const paths: string[] = [];
    const server = createServer((request, response) => {
      hosts.push(request.headers.host ?? "");
      paths.push(request.url ?? "");
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const client = createHttpClient({
      clock: createFixedClock(new Date("2026-01-01T00:00:00.000Z")),
      sleep: sleepHarness().sleep,
      timeoutMs: 1_000,
      userAgent: "test-agent",
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      logger: loggerFake(),
    });
    try {
      const ordinary = await client.request(get(`http://127.0.0.1:${port}/ordinary`));
      expect(ordinary.status).toBe(200);
      const pinned = await client.request({
        ...get(`http://example.test:${port}/pinned`),
        connection: { address: "127.0.0.1", port, servername: "example.test" },
      });
      expect(pinned.status).toBe(200);
      expect(paths).toEqual(["/ordinary", "/pinned"]);
      expect(hosts).toEqual([`127.0.0.1:${port}`, `example.test:${port}`]);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
