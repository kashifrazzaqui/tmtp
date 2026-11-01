import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createFixedClock } from "@tmtp/clock";
import { HttpError } from "@tmtp/http-client";
import type { HttpClient, HttpRequest, HttpResponse } from "@tmtp/http-client";
import { describe, expect, it, vi } from "vitest";
import { ArticleFetchError, createArticleFetcher } from "../src/index.js";
import type { ArticleFetchErrorCode, ArticleFetcherOptions } from "../src/index.js";

const NOW = new Date("2026-02-03T04:05:06.789Z");
const PUBLIC = "93.184.216.34";
interface Wait { ms: number; signal: AbortSignal; fire: () => void; settled: boolean; }
function sleepHarness() {
  const waits: Wait[] = [];
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal === undefined) throw new TypeError("Signal required");
    let settled = false;
    const abort = (): void => { if (!settled) { settled = true; wait.settled = true; reject(signal.reason); } };
    const wait: Wait = {
      ms, signal, settled: false,
      fire: () => { if (!settled) { settled = true; wait.settled = true; signal.removeEventListener("abort", abort); resolve(); } },
    };
    waits.push(wait);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
  return { waits, sleep };
}
function response(body: Uint8Array | string = "<html>ok</html>", headers: Record<string, readonly string[]> = {}, status = 200): HttpResponse {
  return { status, headers: { "content-type": ["text/html; charset=utf-8"], ...headers }, body: typeof body === "string" ? Buffer.from(body) : body, finalUrl: "https://unused.example/" };
}
interface Harness {
  options: ArticleFetcherOptions;
  requests: HttpRequest[];
  http: HttpClient;
  clock: ReturnType<typeof createFixedClock>;
  waits: Wait[];
  resolve: ReturnType<typeof vi.fn>;
  respond: ReturnType<typeof vi.fn>;
}
function harness(overrides: Partial<ArticleFetcherOptions> = {}): Harness {
  const requests: HttpRequest[] = [];
  const respond = vi.fn((request: HttpRequest): Promise<HttpResponse> => { requests.push(request); return Promise.resolve(response()); });
  const http: HttpClient = { request: respond, close: vi.fn(async () => {}) };
  const clock = createFixedClock(NOW);
  const { waits, sleep } = sleepHarness();
  const resolve = vi.fn(async () => [PUBLIC]);
  return {
    options: {
      http, clock, sleep, timeoutMs: 1_000, dnsTimeoutMs: 100, maxResponseBytes: 1_000,
      maxRedirects: 2, allowedProtocols: ["https", "http"], allowedPorts: [80, 443], resolver: { resolve }, ...overrides,
    },
    requests, http, clock, waits, resolve, respond,
  };
}
async function expectCode(promise: Promise<unknown>, code: ArticleFetchErrorCode): Promise<ArticleFetchError> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(ArticleFetchError);
    expect((error as ArticleFetchError).code).toBe(code);
    return error as ArticleFetchError;
  }
  throw new Error(`Expected ${code}`);
}

 describe("URL policy DNS and redirects", () => {
  it("should validate snapshot policies and reject malformed options", () => {
    const h = harness();
    const protocols = ["https"] as Array<"http" | "https">;
    const ports = [443];
    const options = { ...h.options, allowedProtocols: protocols, allowedPorts: ports };
    const fetcher = createArticleFetcher(options);
    protocols.push("http");
    ports.push(80);
    options.timeoutMs = 1;
    expect(h.waits).toHaveLength(0);
    return expect(fetcher.fetch("https://example.com/")).resolves.toMatchObject({ finalUrl: "https://example.com/" });
  });

  it("should reject invalid numeric ranges and duplicate or empty allowlists", () => {
    const h = harness();
    for (const options of [
      { ...h.options, timeoutMs: 0 }, { ...h.options, dnsTimeoutMs: Number.POSITIVE_INFINITY },
      { ...h.options, maxRedirects: 101 }, { ...h.options, allowedProtocols: [] },
      { ...h.options, allowedPorts: [80, 80] }, { ...h.options, allowedProtocols: ["https", "https"] },
    ]) expect(() => createArticleFetcher(options)).toThrow(RangeError);
    expect(() => createArticleFetcher({ ...h.options, timeoutMs: "1" } as never)).toThrow(TypeError);
  });

  it("should reject malformed credentials disallowed protocols and ports before DNS or HTTP", async () => {
    const h = harness({ allowedProtocols: ["https"], allowedPorts: [443] });
    const fetcher = createArticleFetcher(h.options);
    expect(await expectCode(fetcher.fetch("not a url"), "invalid-url")).toMatchObject({ retryable: false });
    await expectCode(fetcher.fetch("https://user:pass@example.com/"), "url-policy");
    await expectCode(fetcher.fetch("http://example.com/"), "url-policy");
    await expectCode(fetcher.fetch("https://example.com:8443/"), "url-policy");
    await expectCode(fetcher.fetch("file:///etc/passwd"), "url-policy");
    await expectCode(fetcher.fetch(42 as never), "invalid-url");
    await expectCode(fetcher.fetch("https://example.com", {} as never), "invalid-request");
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.waits).toHaveLength(0);
  });

  it("should honor pre-cancellation only after input validation and before waits", async () => {
    const h = harness();
    const reason = { marker: "cancel" };
    const controller = new AbortController();
    controller.abort(reason);
    const fetcher = createArticleFetcher(h.options);
    await expect(fetcher.fetch("bad url", controller.signal)).rejects.toMatchObject({ code: "invalid-url" });
    await expect(fetcher.fetch("https://example.com", controller.signal)).rejects.toBe(reason);
    expect(h.waits).toHaveLength(0);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("should reject mixed private special mapped and NAT64 answers without selecting a safe subset", async () => {
    const addresses = [
      [PUBLIC, "127.0.0.1"], ["10.0.0.1"], ["169.254.1.1"], ["100.64.0.1"], ["224.0.0.1"],
      ["0.0.0.0"], ["192.0.2.1"], ["198.18.0.1"], ["fc00::1"], ["::1"], ["fe80::1"],
      ["::ffff:127.0.0.1"], ["64:ff9b::127.0.0.1"], ["64:ff9b:1::1"],
    ];
    for (const answer of addresses) {
      const h = harness({ resolver: { resolve: async () => answer } });
      await expectCode(createArticleFetcher(h.options).fetch("https://example.com"), "address-policy");
      expect(h.respond).not.toHaveBeenCalled();
    }
  });

  it("should select only after complete classification and preserve mapped address family and hostname", async () => {
    const h = harness({ resolver: { resolve: async () => ["::ffff:93.184.216.34", "2606:4700:4700::1111"] } });
    await createArticleFetcher(h.options).fetch("https://example.com./a#fragment");
    expect(h.requests[0]).toMatchObject({
      url: "https://example.com./a", connection: { address: "::ffff:5db8:d822", port: 443, servername: "example.com." },
    });
    const literal = harness();
    await createArticleFetcher(literal.options).fetch("https://[2606:4700:4700::1111]/");
    expect(literal.resolve).not.toHaveBeenCalled();
    expect(literal.requests[0]?.connection).toEqual({ address: "2606:4700:4700::1111", port: 443, servername: "[2606:4700:4700::1111]" });
  });

  it("should map empty malformed and failed resolver outcomes", async () => {
    for (const [answer, code] of [[[], "dns-failed"], [["not-an-ip"], "address-policy"]] as const) {
      const h = harness({ resolver: { resolve: async () => answer } });
      await expectCode(createArticleFetcher(h.options).fetch("https://example.com"), code);
    }
    const h = harness({ resolver: { resolve: async () => { throw new Error("dns-secret"); } } });
    const error = await expectCode(createArticleFetcher(h.options).fetch("https://example.com"), "dns-failed");
    expect(error.message).not.toContain("dns-secret");
  });

  it("should re-resolve every redirect and stop a rebound private target before its request", async () => {
    const h = harness();
    h.resolve.mockResolvedValueOnce([PUBLIC]).mockResolvedValueOnce(["127.0.0.1"]);
    h.respond.mockImplementationOnce(async (request: HttpRequest) => { h.requests.push(request); return response("", { location: ["/next"] }, 302); })
      .mockImplementationOnce(async (request: HttpRequest) => { h.requests.push(request); return response(); });
    await expectCode(createArticleFetcher(h.options).fetch("https://example.com/start"), "address-policy");
    expect(h.resolve).toHaveBeenCalledTimes(2);
    expect(h.requests).toHaveLength(1);
  });

  it("should resolve redirect forms and enforce limits and malformed locations before target work", async () => {
    const h = harness({ maxRedirects: 1 });
    h.respond.mockImplementationOnce(async (request: HttpRequest) => { h.requests.push(request); return response("", { location: ["//other.example/b"] }, 301); })
      .mockImplementationOnce(async (request: HttpRequest) => { h.requests.push(request); return response("done"); });
    await expect(createArticleFetcher(h.options).fetch("https://example.com/a")).resolves.toMatchObject({ finalUrl: "https://other.example/b", html: "done" });
    const zero = harness({ maxRedirects: 0 });
    zero.respond.mockImplementation(async (request: HttpRequest) => { zero.requests.push(request); return response("", { location: ["https://other.example/"] }, 302); });
    await expectCode(createArticleFetcher(zero.options).fetch("https://example.com"), "redirect-limit");
    expect(zero.resolve).toHaveBeenCalledTimes(1);
    const malformed = harness();
    malformed.respond.mockImplementation(async (request: HttpRequest) => { malformed.requests.push(request); return response("", { location: ["http://[bad"] }, 302); });
    await expectCode(createArticleFetcher(malformed.options).fetch("https://example.com"), "invalid-redirect");
    const multiple = harness();
    multiple.respond.mockImplementation(async (request: HttpRequest) => { multiple.requests.push(request); return response("", { location: ["/a", "/b"] }, 302); });
    await expectCode(createArticleFetcher(multiple.options).fetch("https://example.com"), "invalid-redirect");
    const other = harness();
    other.respond.mockImplementation(async (request: HttpRequest) => { other.requests.push(request); return response("", { location: ["/not-followed"] }, 304); });
    await expectCode(createArticleFetcher(other.options).fetch("https://example.com"), "http-status");
  });
});

describe("deadline cancellation and lifecycle", () => {
  it("should derive each request timeout from monotonic remaining budget", async () => {
    const h = harness();
    h.resolve.mockImplementation(async () => { h.clock.advance(100); return [PUBLIC]; });
    h.respond.mockImplementationOnce(async (request: HttpRequest) => { h.requests.push(request); h.clock.advance(200); return response("", { location: ["/next"] }, 302); })
      .mockImplementationOnce(async (request: HttpRequest) => { h.requests.push(request); return response(); });
    await createArticleFetcher(h.options).fetch("https://example.com");
    expect(h.requests.map((request) => request.timeoutMs)).toEqual([900, 600]);
    expect(h.waits[0]?.ms).toBe(1_000);
    expect(h.waits[1]?.ms).toBe(100);
    expect(h.waits[2]?.ms).toBe(100);
  });

  it("should distinguish per-DNS timeout from overall timeout and stop late lookup continuations", async () => {
    let lateResolve!: (addresses: string[]) => void;
    const h = harness({ resolver: { resolve: () => new Promise<string[]>((resolve) => { lateResolve = resolve; }) } });
    const fetching = createArticleFetcher(h.options).fetch("https://example.com");
    await Promise.resolve();
    expect(h.waits).toHaveLength(2);
    h.waits[1]!.fire();
    await expectCode(fetching, "dns-timeout");
    lateResolve([PUBLIC]);
    await Promise.resolve();
    expect(h.respond).not.toHaveBeenCalled();

    const overall = harness({ resolver: { resolve: () => new Promise<string[]>(() => {}) } });
    const pending = createArticleFetcher(overall.options).fetch("https://example.com");
    await Promise.resolve();
    overall.waits[0]!.fire();
    await expectCode(pending, "timeout");
  });

  it("should preserve exact caller reasons and prevent the next hop", async () => {
    const h = harness();
    const pending = new Promise<HttpResponse>(() => {});
    h.respond.mockImplementation((request: HttpRequest) => { h.requests.push(request); return pending; });
    const controller = new AbortController();
    const reason = { exact: true };
    const fetching = createArticleFetcher(h.options).fetch("https://example.com", controller.signal);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    controller.abort(reason);
    await expect(fetching).rejects.toBe(reason);
    expect(h.requests).toHaveLength(1);
  });

  it("should cancel waits and never close borrowed clients or resolvers", async () => {
    const h = harness();
    await createArticleFetcher(h.options).fetch("https://example.com");
    expect(h.waits.every((wait) => wait.settled)).toBe(true);
    expect(h.http.close).not.toHaveBeenCalled();
  });
});

describe("content decoding and safe outcomes", () => {
  it("should decode identity gzip deflate brotli and stacked encodings in reverse order", async () => {
    const plain = Buffer.from("<html>compressed</html>");
    const fixtures: Array<[string | undefined, Uint8Array]> = [
      [undefined, plain], ["identity", plain], ["gzip", gzipSync(plain)], ["deflate", deflateSync(plain)],
      ["br", brotliCompressSync(plain)], ["gzip, br", brotliCompressSync(gzipSync(plain))],
    ];
    for (const [encoding, body] of fixtures) {
      const h = harness();
      h.respond.mockImplementation(async (request: HttpRequest) => { h.requests.push(request); return response(body, encoding === undefined ? {} : { "content-encoding": [encoding] }); });
      await expect(createArticleFetcher(h.options).fetch("https://example.com")).resolves.toMatchObject({ html: plain.toString() });
    }
  });

  it("should reject unsupported mixed identity empty and malformed compressed streams", async () => {
    for (const encoding of ["zstd", "identity, gzip", "gzip,,br", ""]) {
      const h = harness();
      h.respond.mockImplementation(async (request: HttpRequest) => { h.requests.push(request); return response("bad", { "content-encoding": [encoding] }); });
      await expectCode(createArticleFetcher(h.options).fetch("https://example.com"), "unsupported-content-encoding");
    }
    for (const body of [Buffer.from("not-gzip"), gzipSync("truncated").subarray(0, 8)]) {
      const h = harness();
      h.respond.mockImplementation(async (request: HttpRequest) => { h.requests.push(request); return response(body, { "content-encoding": ["gzip"] }); });
      await expectCode(createArticleFetcher(h.options).fetch("https://example.com"), "invalid-content-encoding");
    }
  });

  it("should enforce decoded size independently and accept exactly at-limit output", async () => {
    const exact = harness({ maxResponseBytes: 4 });
    exact.respond.mockImplementation(async (request: HttpRequest) => { exact.requests.push(request); return response("1234"); });
    await expect(createArticleFetcher(exact.options).fetch("https://example.com")).resolves.toMatchObject({ html: "1234" });
    const excess = harness({ maxResponseBytes: 64 });
    excess.respond.mockImplementation(async (request: HttpRequest) => { excess.requests.push(request); return response(gzipSync("x".repeat(1_000)), { "content-encoding": ["gzip"] }); });
    const error = await expectCode(createArticleFetcher(excess.options).fetch("https://example.com"), "response-too-large");
    expect(error.status).toBe(200);
  });

  it("should validate HTML media charset and fatal UTF-8 decoding", async () => {
    const xhtml = harness();
    xhtml.respond.mockImplementation(async (request: HttpRequest) => { xhtml.requests.push(request); return response("x", { "content-type": ["Application/XHTML+XML; Charset=\"UTF8\""] }); });
    await expect(createArticleFetcher(xhtml.options).fetch("https://example.com")).resolves.toMatchObject({ contentType: "application/xhtml+xml" });
    for (const [headers, code] of [
      [{ "content-type": [] }, "unsupported-content-type"],
      [{ "content-type": ["text/html", "text/html"] }, "unsupported-content-type"],
      [{ "content-type": ["application/json"] }, "unsupported-content-type"],
      [{ "content-type": ["text/html; charset=latin1"] }, "unsupported-charset"],
      [{ "content-type": ["text/html; charset=utf8; charset=utf-8"] }, "unsupported-charset"],
    ] as const) {
      const h = harness();
      h.respond.mockImplementation(async (request: HttpRequest) => { h.requests.push(request); return response("x", headers); });
      await expectCode(createArticleFetcher(h.options).fetch("https://example.com"), code);
    }
    const invalid = harness();
    invalid.respond.mockImplementation(async (request: HttpRequest) => { invalid.requests.push(request); return response(Uint8Array.from([0xc3, 0x28])); });
    await expectCode(createArticleFetcher(invalid.options).fetch("https://example.com"), "invalid-text");
  });

  it("should map final statuses and upstream errors to safe retryability and optional status", async () => {
    for (const status of [404, 503]) {
      const h = harness();
      h.respond.mockImplementation(async (request: HttpRequest) => { h.requests.push(request); return response("secret", {}, status); });
      const error = await expectCode(createArticleFetcher(h.options).fetch("https://example.com"), "http-status");
      expect(error).toMatchObject({ status, retryable: status === 503 });
    }
    const codes = ["invalid-request", "timeout", "response-too-large", "redirect-policy", "redirect-limit", "invalid-redirect", "transport", "client-closed"] as const;
    for (const code of codes) {
      const h = harness();
      h.respond.mockImplementation(async () => { throw new HttpError(code, { retryable: true, attempts: 1, status: 503, cause: "secret-cause" }); });
      const error = await expectCode(createArticleFetcher(h.options).fetch("https://example.com"), code === "redirect-policy" ? "url-policy" : code);
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(error)).not.toContain("secret-cause");
      if (code !== "response-too-large") expect(error).not.toHaveProperty("status");
    }
  });

  it("should return normalized provenance exact HTML and fixed timestamp without exposing sentinels", async () => {
    const h = harness();
    h.respond.mockImplementation(async (request: HttpRequest) => { h.requests.push(request); return response("<script>sentinel-body</script>", { "content-type": ["TEXT/HTML"] }); });
    const result = await createArticleFetcher(h.options).fetch("https://example.com/a?b=c#secret-fragment");
    expect(result).toEqual({
      sourceUrl: "https://example.com/a?b=c", finalUrl: "https://example.com/a?b=c",
      contentType: "text/html", html: "<script>sentinel-body</script>", fetchedAt: NOW.toISOString(),
    });
    expect(h.requests[0]).toMatchObject({ maxResponseBytes: 1_000, redirect: "manual", method: "GET" });
  });
});
