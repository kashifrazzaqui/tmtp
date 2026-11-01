import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  LlmCallAudit,
  LlmCallStatus,
  LlmError,
  LlmErrorCategory,
  LlmPort,
  LlmRequest,
  LlmUsage,
} from "@tmtp/llm-interface";
import type { JsonValue, PreparedRequest } from "./json.js";
import { alreadyAborted, prepareRequest, snapshotJson } from "./json.js";
import type { AdapterOptions } from "./options.js";
import type { Transport, TransportOutcome } from "./transport.js";

interface Failure {
  category: LlmErrorCategory;
  code: string;
  auditStatus: LlmCallStatus;
  retryable: boolean;
  internalRetry: boolean;
}
class LocalFailure extends Error {
  constructor(readonly failure: Failure) { super(); }
}

const MESSAGES: Record<string, string> = {
  "invalid-request": "LLM request is invalid.",
  cancelled: "LLM request was cancelled.",
  "attempt-timeout": "LLM provider attempt timed out.",
  "rate-limited": "LLM provider rate limit was reached.",
  "provider-request-timeout": "LLM provider request timed out.",
  "provider-conflict": "LLM provider reported a conflict.",
  "provider-server": "LLM provider server failed.",
  "provider-connection": "LLM provider connection failed.",
  "provider-authentication": "LLM provider authentication failed.",
  "provider-request": "LLM provider rejected the request.",
  "provider-error": "LLM provider failed.",
  "response-json-invalid": "LLM provider response was not valid JSON.",
  "response-shape-invalid": "LLM provider response shape was invalid.",
  "output-missing": "LLM provider output was missing.",
  "output-truncated": "LLM provider output was truncated.",
  "output-refused": "LLM provider refused the output.",
  "output-not-text": "LLM provider output was not structured text.",
  "output-json-invalid": "LLM provider output was not valid JSON.",
  "output-not-object": "LLM provider output was not a JSON object.",
  "output-rejected": "LLM output was rejected locally.",
};
const failure = (
  category: LlmErrorCategory,
  code: string,
  auditStatus: LlmCallStatus,
  retryable: boolean,
  internalRetry = false,
): Failure => ({ category, code, auditStatus, retryable, internalRetry });
const invalidRequest = () => failure("invalid-request", "invalid-request", "invalid-output", false);
const cancelled = () => failure("cancelled", "cancelled", "cancelled", false);
const timeout = () => failure("timeout", "attempt-timeout", "timeout", true, true);
const invalidOutput = (code: string) => failure("invalid-output", code, "invalid-output", false);

function publicError(cause: Failure, attempts: LlmCallAudit[]): LlmError {
  return Object.assign(new Error(MESSAGES[cause.code] ?? MESSAGES["provider-error"]), {
    name: "LlmError",
    category: cause.category,
    code: cause.code,
    retryable: cause.retryable,
    attempts,
  });
}

export interface AdapterSources {
  callId: () => string;
  monotonicNow: () => number;
  wallNowMs: () => number;
  random: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Aborted."));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const defaultSources: AdapterSources = {
  callId: randomUUID,
  monotonicNow: () => performance.now(),
  wallNowMs: Date.now,
  random: Math.random,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  sleep: abortableSleep,
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function latency(start: number, sources: AdapterSources): number {
  const elapsed = Math.floor(sources.monotonicNow() - start);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, elapsed);
}

function usage(body: unknown, requestId: string | undefined, latencyMs: number): LlmUsage {
  const root = record(body);
  const providerUsage = record(root?.usage);
  const inputTokens = tokenCount(providerUsage?.prompt_tokens);
  const outputTokens = tokenCount(providerUsage?.completion_tokens);
  const completionId = nonEmpty(root?.id) ? root.id : undefined;
  const providerRequestId = requestId ?? completionId;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    latencyMs,
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
  };
}

function providerFailure(outcome: Extract<TransportOutcome, { ok: false }>): Failure {
  if (outcome.kind === "timeout") return timeout();
  if (outcome.kind === "response-json") return invalidOutput("response-json-invalid");
  if (outcome.kind === "connection") return failure("provider", "provider-connection", "provider-error", true, true);
  if (outcome.kind === "unknown") return failure("provider", "provider-error", "provider-error", false);
  if (outcome.status === 429) return failure("rate-limit", "rate-limited", "provider-error", true, true);
  if (outcome.status === 408) return failure("provider", "provider-request-timeout", "provider-error", true, true);
  if (outcome.status === 409) return failure("provider", "provider-conflict", "provider-error", true, true);
  if (outcome.status !== undefined && outcome.status >= 500 && outcome.status <= 599) {
    return failure("provider", "provider-server", "provider-error", true, true);
  }
  if (outcome.status === 401 || outcome.status === 403) {
    return failure("provider", "provider-authentication", "provider-error", false);
  }
  if (outcome.status !== undefined) return failure("provider", "provider-request", "provider-error", false);
  return failure("provider", "provider-error", "provider-error", false);
}

function parseOutput<T>(body: unknown, request: PreparedRequest<T>): T {
  const root = record(body);
  const choices = root?.choices;
  if (root === undefined || !Array.isArray(choices) || choices.length !== 1) {
    throw new LocalFailure(invalidOutput("response-shape-invalid"));
  }
  const choice = record(choices[0]);
  const message = record(choice?.message);
  if (choice === undefined || message === undefined || message.role !== "assistant") {
    throw new LocalFailure(invalidOutput("response-shape-invalid"));
  }
  const finish = choice.finish_reason;
  if (finish === "length") throw new LocalFailure(invalidOutput("output-truncated"));
  if (finish === "content_filter") throw new LocalFailure(invalidOutput("output-refused"));
  if (finish === "tool_calls" || finish === "function_call") throw new LocalFailure(invalidOutput("output-not-text"));
  if (finish !== "stop") throw new LocalFailure(invalidOutput("output-missing"));
  if (message.refusal !== null && message.refusal !== undefined) {
    throw new LocalFailure(invalidOutput("output-refused"));
  }
  const toolCalls = message.tool_calls;
  if ((Array.isArray(toolCalls) && toolCalls.length > 0) || (!Array.isArray(toolCalls) && toolCalls != null) || message.function_call != null) {
    throw new LocalFailure(invalidOutput("output-not-text"));
  }
  if (typeof message.content !== "string") throw new LocalFailure(invalidOutput("output-missing"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.content);
  } catch {
    throw new LocalFailure(invalidOutput("output-json-invalid"));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LocalFailure(invalidOutput("output-not-object"));
  }
  try {
    return request.parseOutput(parsed);
  } catch {
    throw new LocalFailure(invalidOutput("output-rejected"));
  }
}

interface AttemptOutcome<T> {
  audit: LlmCallAudit;
  value?: T;
  failure?: Failure;
  retryAfterMs?: string;
  retryAfter?: string;
}

async function runAttempt<T>(
  request: PreparedRequest<T>,
  options: AdapterOptions,
  transport: Transport,
  sources: AdapterSources,
): Promise<AttemptOutcome<T>> {
  const callId = sources.callId();
  const started = sources.monotonicNow();
  const controller = new AbortController();
  let deadlineObserved = false;
  const onAbort = () => controller.abort();
  if (request.signal !== undefined) {
    if (request.signal.aborted) controller.abort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = sources.setTimeout(() => {
    deadlineObserved = true;
    controller.abort();
  }, options.timeoutMs);
  let outcome: TransportOutcome;
  try {
    outcome = await transport(request.body, { signal: controller.signal, timeoutMs: options.timeoutMs });
  } catch {
    outcome = { ok: false, kind: "unknown" };
  } finally {
    sources.clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }

  let responsePayload: JsonValue | undefined;
  if (outcome.ok && request.capturePayload) {
    try {
      responsePayload = snapshotJson(outcome.body);
    } catch {
      responsePayload = undefined;
    }
  }
  const finish = (status: LlmCallStatus, code?: string): LlmCallAudit => ({
    callId,
    purpose: request.purpose,
    model: request.model,
    requestHash: request.requestHash,
    status,
    usage: usage(outcome.ok ? outcome.body : undefined, nonEmpty(outcome.requestId) ? outcome.requestId : undefined, latency(started, sources)),
    ...(code === undefined ? {} : { errorCode: code }),
    ...(request.capturePayload ? {
      requestPayload: snapshotJson(request.projection),
      requestPayloadSchemaVersion: 1,
    } : {}),
    ...(responsePayload === undefined ? {} : { responsePayload, responsePayloadSchemaVersion: 1 }),
  });

  if (request.signal?.aborted) {
    const failed = cancelled();
    return { audit: finish(failed.auditStatus, failed.code), failure: failed };
  }
  if (deadlineObserved || (!outcome.ok && outcome.kind === "timeout")) {
    const failed = timeout();
    return { audit: finish(failed.auditStatus, failed.code), failure: failed };
  }
  if (!outcome.ok) {
    const failed = providerFailure(outcome);
    return {
      audit: finish(failed.auditStatus, failed.code),
      failure: failed,
      ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
      ...(outcome.retryAfter === undefined ? {} : { retryAfter: outcome.retryAfter }),
    };
  }
  try {
    const value = parseOutput(outcome.body, request);
    if (request.signal?.aborted) {
      const failed = cancelled();
      return { audit: finish(failed.auditStatus, failed.code), failure: failed };
    }
    return { audit: finish("success"), value };
  } catch (error) {
    if (request.signal?.aborted) {
      const failed = cancelled();
      return { audit: finish(failed.auditStatus, failed.code), failure: failed };
    }
    const failed = error instanceof LocalFailure ? error.failure : invalidOutput("response-shape-invalid");
    return { audit: finish(failed.auditStatus, failed.code), failure: failed };
  }
}

function headerDelay(outcome: AttemptOutcome<unknown>, sources: AdapterSources): number | undefined {
  let candidate: number | undefined;
  if (outcome.retryAfterMs !== undefined) {
    const milliseconds = Number.parseFloat(outcome.retryAfterMs);
    if (!Number.isNaN(milliseconds)) candidate = milliseconds;
  }
  if (candidate === undefined && outcome.retryAfter !== undefined) {
    const seconds = Number.parseFloat(outcome.retryAfter);
    candidate = Number.isNaN(seconds)
      ? Date.parse(outcome.retryAfter) - sources.wallNowMs()
      : seconds * 1_000;
  }
  return candidate !== undefined && Number.isFinite(candidate) && candidate >= 0 && candidate <= 60_000
    ? candidate
    : undefined;
}
function retryDelay(retryIndex: number, outcome: AttemptOutcome<unknown>, sources: AdapterSources): number {
  const directed = headerDelay(outcome, sources);
  if (directed !== undefined) return directed;
  const base = Math.min(8_000, 500 * 2 ** retryIndex);
  return base * (1 - 0.25 * sources.random());
}

export function createLlmWithTransport(
  options: AdapterOptions,
  transport: Transport,
  suppliedSources: Partial<AdapterSources> = {},
): LlmPort {
  const sources: AdapterSources = { ...defaultSources, ...suppliedSources };
  return {
    async generate<T>(request: LlmRequest<T>) {
      if (alreadyAborted(request)) throw publicError(cancelled(), []);
      let prepared: PreparedRequest<T>;
      try {
        prepared = prepareRequest(request, options.maxOutputTokens);
      } catch {
        throw publicError(invalidRequest(), []);
      }
      const attempts: LlmCallAudit[] = [];
      for (let retryIndex = 0; ; retryIndex += 1) {
        if (prepared.signal?.aborted) throw publicError(cancelled(), attempts);
        const outcome = await runAttempt(prepared, options, transport, sources);
        attempts.push(outcome.audit);
        if (outcome.failure === undefined) return { value: outcome.value as T, attempts };
        if (prepared.signal?.aborted) throw publicError(cancelled(), attempts);
        if (!outcome.failure.internalRetry || retryIndex >= options.maxRetries) {
          throw publicError(outcome.failure, attempts);
        }
        try {
          await sources.sleep(retryDelay(retryIndex, outcome, sources), prepared.signal);
        } catch {
          throw publicError(cancelled(), attempts);
        }
        if (prepared.signal?.aborted) throw publicError(cancelled(), attempts);
      }
    },
  };
}
