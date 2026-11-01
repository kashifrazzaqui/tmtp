import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LlmError, LlmRequest } from "@tmtp/llm-interface";
import { createLlmWithTransport } from "../src/internal.js";
import type { AdapterSources } from "../src/internal.js";
import { snapshotOptions } from "../src/options.js";
import type { AdapterOptions } from "../src/options.js";
import type { Transport, TransportOutcome } from "../src/transport.js";
import * as publicModule from "../src/index.js";

const API_KEY = "api-key-secret-sentinel";
const options: AdapterOptions = {
  baseUrl: "http://provider.test/v1",
  apiKey: API_KEY,
  timeoutMs: 1_000,
  maxRetries: 0,
  maxOutputTokens: 123,
};
const completion = (content: unknown = { answer: 42 }, extra: Record<string, unknown> = {}) => ({
  id: "completion-id",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content), refusal: null } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  ...extra,
});
function request<T>(overrides: Partial<LlmRequest<T>> = {}): LlmRequest<T> {
  return {
    purpose: "recommendation",
    model: "configured-model",
    instructions: "  Judge the supplied input.  ",
    input: { z: 1, nested: { b: true, a: null } },
    outputSchema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
    parseOutput: ((value: unknown) => value) as (value: unknown) => T,
    capturePayload: false,
    ...overrides,
  };
}
function setup(
  scripted: Array<TransportOutcome | ((call: number) => TransportOutcome | Promise<TransportOutcome>)>,
  overrides: Partial<AdapterOptions> = {},
  suppliedSources: Partial<AdapterSources> = {},
) {
  const journal: Array<{ body: unknown; options: { timeoutMs: number; signal: AbortSignal } }> = [];
  let call = 0;
  const transport: Transport = async (body, callOptions) => {
    journal.push({ body, options: callOptions });
    const next = scripted[Math.min(call, scripted.length - 1)]!;
    call += 1;
    return typeof next === "function" ? next(call - 1) : next;
  };
  let id = 0;
  let time = 0;
  const port = createLlmWithTransport({ ...options, ...overrides }, transport, {
    callId: () => `call-${++id}`,
    monotonicNow: () => time += 1.75,
    random: () => 0,
    sleep: async () => {},
    ...suppliedSources,
  });
  return { port, journal };
}
const ok = (body: unknown = completion()): TransportOutcome => ({ ok: true, body, requestId: "header-request-id" });
const provider = (status: number, headers: { retryAfterMs?: string; retryAfter?: string } = {}): TransportOutcome => ({
  ok: false, kind: "provider", status, requestId: "error-request-id", ...headers,
});
async function rejection(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
    throw new Error("Expected rejection.");
  } catch (error) {
    return error as LlmError;
  }
}

describe("public factory and options", () => {
  it("should expose only the factory and snapshot valid options", () => {
    expect(Object.keys(publicModule)).toEqual(["createOpenAiCompatibleLlm"]);
    const mutable = { ...options, unknown: true } as AdapterOptions;
    const snapshot = snapshotOptions(mutable);
    mutable.baseUrl = "http://changed.test";
    mutable.apiKey = "changed";
    expect(snapshot).toEqual(options);
    expect(snapshotOptions({ ...options, unknown: true } as AdapterOptions)).toEqual(options);
  });

  it("should distinguish wrong types and invalid ranges without echoing secrets", () => {
    for (const [key, value] of [["baseUrl", 1], ["apiKey", 1], ["timeoutMs", "1"], ["maxRetries", null], ["maxOutputTokens", true]] as const) {
      expect(() => snapshotOptions({ ...options, [key]: value } as AdapterOptions)).toThrow(TypeError);
    }
    const invalidUrl = "http://user:secret-url-sentinel@example.com";
    for (const value of ["", "relative", "ftp://example.com", invalidUrl, "http://example.com?", "http://example.com#", " http://example.com"]) {
      expect(() => snapshotOptions({ ...options, baseUrl: value })).toThrow(RangeError);
    }
    for (const invalid of [
      { apiKey: " " }, { timeoutMs: 0 }, { timeoutMs: 2_147_483_648 }, { timeoutMs: 1.5 },
      { maxRetries: -1 }, { maxRetries: Number.POSITIVE_INFINITY }, { maxOutputTokens: 0 },
    ]) {
      expect(() => snapshotOptions({ ...options, ...invalid })).toThrow(RangeError);
    }
    try {
      snapshotOptions({ ...options, baseUrl: invalidUrl });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("secret-url-sentinel");
      expect((error as Error).message).not.toContain(API_KEY);
    }
  });
});

describe("request validation", () => {
  it("should give pre-abort precedence over every invalid field", async () => {
    const controller = new AbortController();
    controller.abort();
    const parser = vi.fn();
    const { port, journal } = setup([]);
    const error = await rejection(port.generate({ signal: controller.signal, parseOutput: parser } as never));
    expect(error).toMatchObject({ category: "cancelled", code: "cancelled", retryable: false, attempts: [] });
    expect(journal).toHaveLength(0);
    expect(parser).not.toHaveBeenCalled();
  });

  it("should reject every malformed request before provider I/O", async () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const sparse = Array(2); sparse[1] = 1;
    const accessor = {}; Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
    const invalid: unknown[] = [
      null, [], { ...request(), purpose: "other" }, { ...request(), model: " model" },
      { ...request(), instructions: " \n" }, { ...request(), parseOutput: null },
      { ...request(), capturePayload: 1 }, { ...request(), signal: null },
      { ...request(), input: undefined }, { ...request(), input: Number.NaN },
      { ...request(), input: 1n }, { ...request(), input: new Date() },
      { ...request(), input: cyclic }, { ...request(), input: sparse },
      { ...request(), input: { value: undefined } }, { ...request(), input: { toJSON: () => ({}) } },
      { ...request(), input: accessor }, { ...request(), outputSchema: null },
      { ...request(), outputSchema: { type: "array" } }, { ...request(), outputSchema: { type: "string" } },
      { ...request(), outputSchema: { type: "" } },
      { ...request(), outputSchema: { type: "object", required: ["a", "a"] } },
      { ...request(), outputSchema: { type: "object", properties: { a: { required: "a" } } } },
      { ...request(), outputSchema: { type: "object", items: 4 } },
      { ...request(), outputSchema: { type: "object", additionalProperties: null } },
    ];
    for (const value of invalid) {
      const { port, journal } = setup([]);
      const error = await rejection(port.generate(value as never));
      expect(error).toMatchObject({ category: "invalid-request", code: "invalid-request", retryable: false, attempts: [] });
      expect(journal).toHaveLength(0);
    }
  });
});

describe("canonical requests success and capture", () => {
  it("should map the exact wire body and return the exact parser result with usage", async () => {
    const typed = { accepted: true };
    const parser = vi.fn(() => typed);
    const { port, journal } = setup([ok()]);
    const result = await port.generate(request({ parseOutput: parser }));
    expect(result.value).toBe(typed);
    expect(parser).toHaveBeenCalledOnce();
    expect(parser).toHaveBeenCalledWith({ answer: 42 });
    expect(journal).toHaveLength(1);
    expect(journal[0]?.options.timeoutMs).toBe(1_000);
    expect(journal[0]?.body).toEqual({
      model: "configured-model",
      messages: [
        { role: "system", content: "  Judge the supplied input.  " },
        { role: "user", content: "Input JSON:\n{\"nested\":{\"a\":null,\"b\":true},\"z\":1}\n\nReturn only one JSON object that conforms to this JSON Schema:\n{\"properties\":{\"answer\":{\"type\":\"number\"}},\"required\":[\"answer\"],\"type\":\"object\"}" },
      ],
      response_format: { type: "json_object" }, max_completion_tokens: 123, n: 1, stream: false,
    });
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      callId: "call-1", purpose: "recommendation", model: "configured-model", status: "success",
      usage: { inputTokens: 10, outputTokens: 5, latencyMs: 1, providerRequestId: "header-request-id" },
    });
    expect(result.attempts[0]).not.toHaveProperty("errorCode");
    expect(result.attempts[0]).not.toHaveProperty("requestPayload");
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("should preserve one golden hash across key order capture and unknown fields", async () => {
    const first = setup([ok()], { capturePayload: undefined } as never);
    const base = request({ capturePayload: true, unknown: "ignored" } as never);
    const result = await first.port.generate(base);
    const audit = result.attempts[0]!;
    const expectedProjection = {
      input: { nested: { a: null, b: true }, z: 1 }, instructions: "  Judge the supplied input.  ",
      maxOutputTokens: 123, model: "configured-model",
      outputSchema: { properties: { answer: { type: "number" } }, required: ["answer"], type: "object" },
      purpose: "recommendation",
    };
    const independent = createHash("sha256").update(JSON.stringify(expectedProjection)).digest("hex");
    expect(audit.requestHash).toBe(`sha256:${independent}`);
    expect(audit).toMatchObject({ requestPayloadSchemaVersion: 1, responsePayloadSchemaVersion: 1 });
    expect(Object.keys(audit.requestPayload as object).sort()).toEqual(["input", "instructions", "maxOutputTokens", "model", "outputSchema", "purpose"]);
    expect(audit.requestPayload).toEqual({
      purpose: "recommendation", model: "configured-model", instructions: "  Judge the supplied input.  ",
      input: { z: 1, nested: { b: true, a: null } },
      outputSchema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
      maxOutputTokens: 123,
    });
    expect(audit.responsePayload).toMatchObject({ id: "completion-id" });

    const second = setup([ok()]);
    const reordered = request({ input: { nested: { a: null, b: true }, z: 1 }, capturePayload: false });
    const other = await second.port.generate(reordered);
    expect(other.attempts[0]?.requestHash).toBe(audit.requestHash);
    expect(other.attempts[0]).not.toHaveProperty("requestPayloadSchemaVersion");
    expect(other.attempts[0]).not.toHaveProperty("responsePayloadSchemaVersion");
  });

  it("should use a stable request snapshot after caller mutation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { port, journal } = setup([async () => { await gate; return ok(); }]);
    const mutable = request({ capturePayload: true });
    const pending = port.generate(mutable);
    (mutable.input as { z: number }).z = 999;
    (mutable.outputSchema.properties!.answer as { type: string }).type = "string";
    release();
    const result = await pending;
    expect(journal[0]?.body).toMatchObject({ max_completion_tokens: 123 });
    expect((journal[0]?.body as { messages: Array<{ content: string }> }).messages[1]?.content).toContain('"z":1');
    expect(JSON.stringify(journal[0]?.body)).not.toContain("999");
    expect(JSON.stringify(result.attempts[0]?.requestPayload)).toContain('"type":"number"');
  });

  it("should omit malformed usage and fall back to completion IDs", async () => {
    const body = completion({ ok: true }, { usage: { prompt_tokens: -1, completion_tokens: 2.5 } });
    const { port } = setup([{ ok: true, body, requestId: "" }]);
    const result = await port.generate(request());
    expect(result.attempts[0]?.usage).toEqual({ latencyMs: 1, providerRequestId: "completion-id" });
  });
});

describe("local output and provider errors", () => {
  it("should classify the complete output failure matrix without retries or raw messages", async () => {
    const variants: Array<[unknown, string]> = [
      [null, "response-shape-invalid"], [{ choices: [] }, "response-shape-invalid"],
      [completion({ answer: 42 }, { choices: [{}, {}] }), "response-shape-invalid"],
      [{ choices: [{ finish_reason: "stop", message: { role: "user", content: "{}" } }] }, "response-shape-invalid"],
      [completion({ answer: 42 }, { choices: [{ finish_reason: "length", message: { role: "assistant", content: "{}" } }] }), "output-truncated"],
      [completion({ answer: 42 }, { choices: [{ finish_reason: "content_filter", message: { role: "assistant", content: "{}" } }] }), "output-refused"],
      [completion({ answer: 42 }, { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "{}" } }] }), "output-not-text"],
      [completion({ answer: 42 }, { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}", refusal: "secret-refusal" } }] }), "output-refused"],
      [completion({ answer: 42 }, { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}", tool_calls: [{}] } }] }), "output-not-text"],
      [completion({ answer: 42 }, { choices: [{ finish_reason: "stop", message: { role: "assistant", content: null } }] }), "output-missing"],
      [completion("```json\n{}\n```"), "output-json-invalid"], [completion("[]"), "output-not-object"],
    ];
    for (const [body, code] of variants) {
      const { port, journal } = setup([ok(body)], { maxRetries: 3 });
      const error = await rejection(port.generate(request({ capturePayload: true })));
      expect(error).toMatchObject({ category: "invalid-output", code, retryable: false });
      expect(error.attempts).toHaveLength(1);
      expect(error.attempts[0]).toMatchObject({ status: "invalid-output", errorCode: code, responsePayloadSchemaVersion: 1 });
      expect(journal).toHaveLength(1);
      expect(error.message).not.toContain("secret-refusal");
      expect(error.code).not.toContain("secret-refusal");
    }
    const parser = () => { throw new Error("parser-secret-sentinel"); };
    const { port } = setup([ok()]);
    const error = await rejection(port.generate(request({ parseOutput: parser })));
    expect(error).toMatchObject({ code: "output-rejected", category: "invalid-output" });
    expect(JSON.stringify(error)).not.toContain("parser-secret-sentinel");
    const malformed = setup([{ ok: false, kind: "response-json" }]);
    await expect(malformed.port.generate(request({ capturePayload: true }))).rejects.toMatchObject({ code: "response-json-invalid" });
  });

  it("should apply precedence when responses have multiple invalid features", async () => {
    const body = {
      choices: [{
        finish_reason: "length",
        message: { role: "assistant", content: null, refusal: "no", tool_calls: [{}] },
      }],
    };
    const { port } = setup([ok(body)]);
    await expect(port.generate(request())).rejects.toMatchObject({ code: "output-truncated" });
  });

  it("should normalize provider status and transport failures", async () => {
    const cases: Array<[TransportOutcome, string, string, boolean]> = [
      [provider(400), "provider", "provider-request", false],
      [provider(401), "provider", "provider-authentication", false],
      [provider(403), "provider", "provider-authentication", false],
      [provider(404), "provider", "provider-request", false],
      [provider(422), "provider", "provider-request", false],
      [provider(408), "provider", "provider-request-timeout", true],
      [provider(409), "provider", "provider-conflict", true],
      [provider(429), "rate-limit", "rate-limited", true],
      [provider(500), "provider", "provider-server", true],
      [{ ok: false, kind: "connection" }, "provider", "provider-connection", true],
      [{ ok: false, kind: "timeout" }, "timeout", "attempt-timeout", true],
      [{ ok: false, kind: "unknown" }, "provider", "provider-error", false],
    ];
    for (const [outcome, category, code, retryable] of cases) {
      const { port } = setup([outcome]);
      const error = await rejection(port.generate(request()));
      expect(error).toMatchObject({ category, code, retryable });
      expect(error.attempts[0]).toMatchObject({ status: category === "timeout" ? "timeout" : "provider-error", errorCode: code });
    }
  });
});

describe("retry timeout and cancellation", () => {
  it("should preserve three attempts distinct IDs one hash and exact retry delays", async () => {
    const delays: number[] = [];
    const { port, journal } = setup([provider(429), provider(500), ok()], { maxRetries: 2 }, {
      sleep: async (delay) => { delays.push(delay); },
    });
    const result = await port.generate(request({ capturePayload: true }));
    expect(journal).toHaveLength(3);
    expect(delays).toEqual([500, 1_000]);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["provider-error", "provider-error", "success"]);
    expect(new Set(result.attempts.map((attempt) => attempt.callId)).size).toBe(3);
    expect(new Set(result.attempts.map((attempt) => attempt.requestHash)).size).toBe(1);
    expect(result.attempts.every((attempt) => attempt.requestPayloadSchemaVersion === 1)).toBe(true);
    expect(result.attempts[0]).not.toHaveProperty("responsePayload");
    expect(result.attempts[2]).toHaveProperty("responsePayload");
  });

  it("should honor retry headers and fall back for invalid values", async () => {
    const cases: Array<[{ retryAfterMs?: string; retryAfter?: string }, number]> = [
      [{ retryAfterMs: "25" }, 25], [{ retryAfter: "2" }, 2_000],
      [{ retryAfter: new Date(60_000).toUTCString() }, 50_000],
      [{ retryAfterMs: "70000" }, 500], [{ retryAfter: "-1" }, 500],
      [{ retryAfterMs: "invalid", retryAfter: "3" }, 3_000],
    ];
    for (const [headers, expected] of cases) {
      const delays: number[] = [];
      const { port } = setup([provider(429, headers), ok()], { maxRetries: 1 }, {
        wallNowMs: () => 10_000, sleep: async (delay) => { delays.push(delay); },
      });
      await port.generate(request());
      expect(delays).toEqual([expected]);
    }
  });

  it("should observe an in-flight deadline and permit a fresh later attempt", async () => {
    let calls = 0;
    const transport: Transport = async (_body, callOptions) => {
      calls += 1;
      if (calls === 2) return ok();
      return new Promise((resolve) => {
        callOptions.signal.addEventListener("abort", () => resolve({ ok: false, kind: "unknown" }), { once: true });
      });
    };
    const port = createLlmWithTransport({ ...options, timeoutMs: 10, maxRetries: 1 }, transport, { sleep: async () => {} });
    const result = await port.generate(request());
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["timeout", "success"]);
    expect(calls).toBe(2);
  });

  it("should classify caller cancellation and never start another attempt", async () => {
    const controller = new AbortController();
    const transport: Transport = async (_body, callOptions) => new Promise((resolve) => {
      callOptions.signal.addEventListener("abort", () => resolve(provider(500)), { once: true });
    });
    const port = createLlmWithTransport({ ...options, maxRetries: 3 }, transport);
    const pending = port.generate(request({ signal: controller.signal }));
    controller.abort();
    const error = await rejection(pending);
    expect(error).toMatchObject({ category: "cancelled", code: "cancelled", retryable: false });
    expect(error.attempts).toHaveLength(1);
    expect(error.attempts[0]).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
  });

  it("should preserve the completed audit when cancelled between attempts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const { port } = setup([provider(429)], { maxRetries: 3 }, {
      sleep: async () => { calls += 1; controller.abort(); },
    });
    const error = await rejection(port.generate(request({ signal: controller.signal })));
    expect(error).toMatchObject({ category: "cancelled", code: "cancelled" });
    expect(error.attempts).toHaveLength(1);
    expect(error.attempts[0]).toMatchObject({ status: "provider-error", errorCode: "rate-limited" });
    expect(calls).toBe(1);
  });

  it("should prevent success when the parser aborts the caller", async () => {
    const controller = new AbortController();
    const { port, journal } = setup([ok()]);
    const error = await rejection(port.generate(request({
      signal: controller.signal,
      parseOutput: () => { controller.abort(); return { shouldNotWin: true }; },
    })));
    expect(error).toMatchObject({ category: "cancelled", code: "cancelled" });
    expect(error.attempts[0]).toMatchObject({ status: "cancelled" });
    expect(journal).toHaveLength(1);
  });

  it("should isolate interleaved operations and their call IDs", async () => {
    const releases = new Map<string, () => void>();
    const transport: Transport = async (body) => {
      const model = (body as { model: string }).model;
      await new Promise<void>((resolve) => { releases.set(model, resolve); });
      return ok(completion({ model }));
    };
    const port = createLlmWithTransport(options, transport);
    const first = port.generate(request({ model: "first", parseOutput: (value) => value }));
    const second = port.generate(request({ model: "second", parseOutput: (value) => value }));
    releases.get("second")!(); releases.get("first")!();
    const [one, two] = await Promise.all([first, second]);
    expect(one.value).toEqual({ model: "first" });
    expect(two.value).toEqual({ model: "second" });
    expect(one.attempts[0]?.callId).not.toBe(two.attempts[0]?.callId);
    expect(one.attempts[0]?.model).toBe("first");
    expect(two.attempts[0]?.model).toBe("second");
  });
});
