import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmRequest } from "@tmtp/llm-interface";
import { createOpenAiCompatibleLlm } from "../src/index.js";

const API_KEY = "sdk-api-key-secret-sentinel";
interface RecordedRequest {
  method?: string;
  url?: string;
  authorization?: string;
  contentType?: string;
  body: unknown;
}
type Reply = (response: ServerResponse, call: number) => void;
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  vi.unstubAllEnvs();
});

async function fakeProvider(reply: Reply) {
  const journal: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      journal.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body: text === "" ? undefined : JSON.parse(text),
      });
      reply(response, journal.length - 1);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { journal, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

function completion(response: ServerResponse, requestId = "sdk-request-id") {
  response.writeHead(200, { "content-type": "application/json", "x-request-id": requestId });
  response.end(JSON.stringify({
    id: "sdk-completion-id", object: "chat.completion", created: 1, model: "configured-model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{\"accepted\":true}", refusal: null } }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    provider_extension: { retained: true },
  }));
}

function request(): LlmRequest<{ accepted: boolean }> {
  return {
    purpose: "connection-check",
    model: "configured-model",
    instructions: "Return a connection judgment.",
    input: { probe: true },
    outputSchema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] },
    parseOutput: (value) => {
      const accepted = (value as { accepted?: unknown }).accepted;
      if (typeof accepted !== "boolean") throw new Error("invalid fixture");
      return { accepted };
    },
    capturePayload: true,
  };
}

describe("real OpenAI SDK loopback integration", () => {
  it("should join the base URL send exact auth and wire JSON and retain response metadata", async () => {
    vi.stubEnv("OPENAI_LOG", "debug");
    const provider = await fakeProvider((response) => completion(response));
    const mutable = {
      baseUrl: provider.baseUrl, apiKey: API_KEY, timeoutMs: 1_000, maxRetries: 0, maxOutputTokens: 77,
    };
    const port = createOpenAiCompatibleLlm(mutable);
    mutable.baseUrl = "http://127.0.0.1:1/wrong";
    mutable.apiKey = "changed-secret";
    const result = await port.generate(request());
    expect(result.value).toEqual({ accepted: true });
    expect(provider.journal).toHaveLength(1);
    expect(provider.journal[0]).toMatchObject({
      method: "POST", url: "/v1/chat/completions", authorization: `Bearer ${API_KEY}`, contentType: "application/json",
      body: {
        model: "configured-model", response_format: { type: "json_object" },
        max_completion_tokens: 77, n: 1, stream: false,
      },
    });
    expect(result.attempts[0]).toMatchObject({
      status: "success",
      usage: { inputTokens: 12, outputTokens: 3, providerRequestId: "sdk-request-id" },
      requestPayloadSchemaVersion: 1, responsePayloadSchemaVersion: 1,
    });
    expect(result.attempts[0]?.responsePayload).toMatchObject({ provider_extension: { retained: true } });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain("changed-secret");
  });

  it("should expose exactly two attempts for a 429 then success without hidden SDK retries", async () => {
    const provider = await fakeProvider((response, call) => {
      if (call === 0) {
        response.writeHead(429, { "content-type": "application/json", "retry-after-ms": "0", "x-request-id": "limited-request" });
        response.end(JSON.stringify({ error: { message: "provider-body-secret-sentinel", type: "rate_limit" } }));
      } else {
        completion(response, "successful-request");
      }
    });
    const port = createOpenAiCompatibleLlm({ baseUrl: provider.baseUrl, apiKey: API_KEY, timeoutMs: 1_000, maxRetries: 1, maxOutputTokens: 77 });
    const result = await port.generate(request());
    expect(provider.journal).toHaveLength(2);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["provider-error", "success"]);
    expect(result.attempts[0]).toMatchObject({
      errorCode: "rate-limited", usage: { providerRequestId: "limited-request" }, requestPayloadSchemaVersion: 1,
    });
    expect(result.attempts[0]).not.toHaveProperty("responsePayload");
    expect(JSON.stringify(result)).not.toContain("provider-body-secret-sentinel");
  });

  it("should make one provider call when retries are disabled", async () => {
    const provider = await fakeProvider((response) => {
      response.writeHead(429, { "content-type": "application/json", "retry-after-ms": "0" });
      response.end(JSON.stringify({ error: { message: "rate limited" } }));
    });
    const port = createOpenAiCompatibleLlm({ baseUrl: provider.baseUrl, apiKey: API_KEY, timeoutMs: 1_000, maxRetries: 0, maxOutputTokens: 77 });
    await expect(port.generate(request())).rejects.toMatchObject({ category: "rate-limit", code: "rate-limited", retryable: true });
    expect(provider.journal).toHaveLength(1);
  });

  it("should normalize malformed successful outer JSON without capturing or retrying", async () => {
    const provider = await fakeProvider((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not-json-secret-sentinel");
    });
    const port = createOpenAiCompatibleLlm({ baseUrl: provider.baseUrl, apiKey: API_KEY, timeoutMs: 1_000, maxRetries: 3, maxOutputTokens: 77 });
    const error = await port.generate(request()).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ category: "invalid-output", code: "response-json-invalid", retryable: false });
    expect(provider.journal).toHaveLength(1);
    expect((error as { attempts: unknown[] }).attempts).toHaveLength(1);
    expect((error as { attempts: Array<Record<string, unknown>> }).attempts[0]).not.toHaveProperty("responsePayload");
    expect(JSON.stringify(error)).not.toContain("not-json-secret-sentinel");
  });

  it("should abort a real stalled provider call at the attempt deadline", async () => {
    const provider = await fakeProvider((response) => {
      const timer = setTimeout(() => completion(response), 500);
      response.on("close", () => clearTimeout(timer));
    });
    const port = createOpenAiCompatibleLlm({ baseUrl: provider.baseUrl, apiKey: API_KEY, timeoutMs: 15, maxRetries: 0, maxOutputTokens: 77 });
    await expect(port.generate(request())).rejects.toMatchObject({ category: "timeout", code: "attempt-timeout", retryable: true });
    expect(provider.journal).toHaveLength(1);
  });
});
