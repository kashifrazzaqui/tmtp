import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions/completions";
import type { AdapterOptions } from "./options.js";

export interface TransportCallOptions {
  signal: AbortSignal;
  timeoutMs: number;
}
export type TransportOutcome =
  | { ok: true; body: unknown; requestId?: string }
  | {
    ok: false;
    kind: "provider" | "connection" | "timeout" | "response-json" | "unknown";
    status?: number;
    requestId?: string;
    retryAfterMs?: string;
    retryAfter?: string;
  };
export type Transport = (body: unknown, options: TransportCallOptions) => Promise<TransportOutcome>;

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function createOpenAiClient(options: AdapterOptions): OpenAI {
  return new OpenAI({
    baseURL: options.baseUrl,
    apiKey: options.apiKey,
    timeout: options.timeoutMs,
    maxRetries: 0,
    logLevel: "off",
  });
}

export function normalizeSdkError(error: unknown): TransportOutcome {
  if (error instanceof APIConnectionTimeoutError) return { ok: false, kind: "timeout" };
  if (error instanceof APIConnectionError) return { ok: false, kind: "connection" };
  if (error instanceof SyntaxError) return { ok: false, kind: "response-json" };
  if (error instanceof APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const requestId = nonEmpty(error.requestID) ? error.requestID : undefined;
    const retryAfterMs = error.headers?.get("retry-after-ms") ?? undefined;
    const retryAfter = error.headers?.get("retry-after") ?? undefined;
    return {
      ok: false,
      kind: status === undefined ? "unknown" : "provider",
      ...(status === undefined ? {} : { status }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(retryAfter === undefined ? {} : { retryAfter }),
    };
  }
  return { ok: false, kind: "unknown" };
}

export function createSdkTransport(client: OpenAI): Transport {
  return async (body, options) => {
    try {
      const { data, request_id } = await client.chat.completions.create(
        body as ChatCompletionCreateParamsNonStreaming,
        { timeout: options.timeoutMs, maxRetries: 0, signal: options.signal },
      ).withResponse();
      return {
        ok: true,
        body: data,
        ...(nonEmpty(request_id) ? { requestId: request_id } : {}),
      };
    } catch (error) {
      return normalizeSdkError(error);
    }
  };
}
