import { isIP } from "node:net";
import type { Clock, Sleep } from "@tmtp/clock";
import type { Logger } from "@tmtp/logging";
import { executeWithRetry } from "@tmtp/retry";
import type { RandomSource, RetryPolicy } from "@tmtp/retry";
import { createDefaultTransport } from "./transport.js";

export type HttpMethod = "GET" | "POST";
export type HttpRedirectPolicy = "manual" | "same-origin";
export interface HttpConnection { address: string; port: number; servername: string; }
export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxResponseBytes?: number;
  redirect: HttpRedirectPolicy;
  connection?: HttpConnection;
  signal?: AbortSignal;
}
export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string, readonly string[]>>;
  body: Uint8Array;
  finalUrl: string;
}
export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
  close(): Promise<void>;
}
export interface HttpTransportRequest {
  method: HttpMethod;
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
  connection?: HttpConnection;
  signal: AbortSignal;
}
export interface HttpTransportResponse {
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
}
export interface HttpTransport {
  request(request: HttpTransportRequest): Promise<HttpTransportResponse>;
  close(): Promise<void>;
}
export interface HttpClientOptions {
  clock: Clock;
  sleep: Sleep;
  timeoutMs: number;
  maxResponseBytes?: number;
  userAgent: string;
  retryPolicy: RetryPolicy;
  logger: Logger;
  random?: RandomSource;
  transport?: HttpTransport;
}
export type HttpErrorCode =
  | "invalid-request"
  | "timeout"
  | "response-too-large"
  | "redirect-policy"
  | "redirect-limit"
  | "invalid-redirect"
  | "transport"
  | "client-closed";

const ERROR_MESSAGES: Record<HttpErrorCode, string> = {
  "invalid-request": "Invalid HTTP request.",
  timeout: "HTTP request timed out.",
  "response-too-large": "HTTP response exceeded the byte limit.",
  "redirect-policy": "HTTP redirect is not allowed by the origin policy.",
  "redirect-limit": "HTTP redirect limit was exceeded.",
  "invalid-redirect": "HTTP redirect location is invalid.",
  transport: "HTTP transport failed.",
  "client-closed": "HTTP client is closed.",
};

export class HttpError extends Error {
  override readonly name = "HttpError" as const;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly status?: number;
  override readonly cause?: unknown;
  constructor(readonly code: HttpErrorCode, options: {
    retryable: boolean;
    attempts: number;
    status?: number;
    cause?: unknown;
  }) {
    super(ERROR_MESSAGES[code]);
    this.retryable = options.retryable;
    this.attempts = options.attempts;
    if (options.status !== undefined) this.status = options.status;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

interface NormalizedRequest {
  method: HttpMethod;
  url: string;
  origin: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs: number;
  maxResponseBytes: number;
  redirect: HttpRedirectPolicy;
  connection?: HttpConnection;
  signal?: AbortSignal;
}
interface AttemptOutcome { response: HttpResponse; redirectCount: number; }
class StatusFailure {
  constructor(readonly outcome: AttemptOutcome) {}
}

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding", "upgrade", "expect", "te", "trailer", "user-agent",
]);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_TIMER = 2_147_483_647;

function validateTimer(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= MAX_TIMER;
}

function validatePolicy(policy: RetryPolicy): void {
  if (policy === null || typeof policy !== "object") throw new TypeError("Retry policy must be an object.");
  for (const value of Object.values(policy)) {
    if (typeof value !== "number") throw new TypeError("Retry policy values must be numbers.");
  }
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError("Retry maxAttempts must be positive.");
  }
  if (!validateTimer(policy.baseDelayMs, 0) || !validateTimer(policy.maxDelayMs, 0) || policy.baseDelayMs > policy.maxDelayMs) {
    throw new RangeError("Retry delays are invalid.");
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new RangeError("Retry jitter is invalid.");
  }
}

function normalizeServername(value: string): string | undefined {
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return undefined;
  }
}

function validateRequest(input: HttpRequest, defaultTimeout: number, defaultLimit: number, userAgent: string): NormalizedRequest {
  if (input === null || typeof input !== "object" || (input.method !== "GET" && input.method !== "POST")) {
    throw new TypeError("Invalid method.");
  }
  if (input.method === "GET" && input.body !== undefined) throw new TypeError("GET body is forbidden.");
  if (input.body !== undefined && typeof input.body !== "string" && !(input.body instanceof Uint8Array)) {
    throw new TypeError("Invalid body.");
  }
  if (typeof input.url !== "string") throw new TypeError("Invalid URL.");
  const url = new URL(input.url);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "" || url.username !== "" || url.password !== "") {
    throw new TypeError("Invalid URL.");
  }
  url.hash = "";
  if (input.redirect !== "manual" && input.redirect !== "same-origin") throw new TypeError("Invalid redirect policy.");
  const timeoutMs = input.timeoutMs === undefined ? defaultTimeout : input.timeoutMs;
  const maxResponseBytes = input.maxResponseBytes === undefined ? defaultLimit : input.maxResponseBytes;
  if (!validateTimer(timeoutMs, 1) || !validateTimer(maxResponseBytes, 0)) throw new RangeError("Invalid request limits.");
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw new TypeError("Invalid signal.");
  if (input.headers !== undefined && (input.headers === null || typeof input.headers !== "object" || Array.isArray(input.headers))) {
    throw new TypeError("Invalid headers.");
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const lower = name.toLowerCase();
    if (!TOKEN.test(name) || typeof value !== "string" || /[\r\n\0]/.test(value) || FORBIDDEN_HEADERS.has(lower)) {
      throw new TypeError("Invalid header.");
    }
    if (Object.prototype.hasOwnProperty.call(headers, lower)) throw new TypeError("Duplicate header.");
    headers[lower] = value;
  }
  headers["user-agent"] = userAgent;

  let connection: HttpConnection | undefined;
  if (input.connection !== undefined) {
    const pin = input.connection;
    if (pin === null || typeof pin !== "object" || isIP(pin.address) === 0 || !Number.isInteger(pin.port) || pin.port < 1 || pin.port > 65535) {
      throw new TypeError("Invalid connection pin.");
    }
    const effectivePort = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    if (
      pin.port !== effectivePort || typeof pin.servername !== "string" || pin.servername === "" ||
      normalizeServername(pin.servername) !== url.hostname
    ) throw new TypeError("Invalid connection pin.");
    connection = { address: pin.address, port: pin.port, servername: pin.servername };
  }

  return {
    method: input.method,
    url: url.href,
    origin: url.origin,
    headers,
    ...(input.body === undefined ? {} : { body: typeof input.body === "string" ? input.body : new Uint8Array(input.body) }),
    timeoutMs,
    maxResponseBytes,
    redirect: input.redirect,
    ...(connection === undefined ? {} : { connection }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function normalizeHeaders(headers: Readonly<Record<string, string | readonly string[] | undefined>>): Record<string, readonly string[]> {
  const normalized: Record<string, readonly string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    normalized[name.toLowerCase()] = typeof value === "string" ? [value] : [...value];
  }
  return normalized;
}

async function closeIterator<T>(iterator: AsyncIterator<T>): Promise<void> {
  if (iterator.return !== undefined) await iterator.return();
}

async function collectResponse(
  response: HttpTransportResponse,
  finalUrl: string,
  limit: number,
  attempts: number,
): Promise<HttpResponse> {
  const headers = normalizeHeaders(response.headers);
  const iterator = response.body[Symbol.asyncIterator]();
  let complete = false;
  try {
    const lengthValues = headers["content-length"];
    if (lengthValues?.length === 1 && /^\d+$/.test(lengthValues[0]!)) {
      const declared = Number(lengthValues[0]);
      if (Number.isSafeInteger(declared) && declared > limit) {
        throw new HttpError("response-too-large", { retryable: false, attempts, status: response.status });
      }
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const result = await iterator.next();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw new TypeError("Invalid response chunk.");
      if (received + result.value.length > limit) {
        throw new HttpError("response-too-large", { retryable: false, attempts, status: response.status });
      }
      chunks.push(new Uint8Array(result.value));
      received += result.value.length;
    }
    const body = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    complete = true;
    return { status: response.status, headers, body, finalUrl };
  } finally {
    if (!complete) await closeIterator(iterator);
  }
}

async function discardBody(body: AsyncIterable<Uint8Array>): Promise<void> {
  await closeIterator(body[Symbol.asyncIterator]());
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  if (
    options === null || typeof options !== "object" ||
    options.clock === null || typeof options.clock !== "object" || typeof options.clock.monotonicNowMs !== "function" ||
    typeof options.sleep !== "function" ||
    typeof options.userAgent !== "string" ||
    options.logger === null || typeof options.logger !== "object" ||
    !["trace", "debug", "info", "warn", "error", "child"].every((key) =>
      typeof (options.logger as unknown as Record<string, unknown>)[key] === "function"
    ) ||
    (options.random !== undefined && typeof options.random !== "function") ||
    (options.transport !== undefined && (
      options.transport === null || typeof options.transport !== "object" ||
      typeof options.transport.request !== "function" || typeof options.transport.close !== "function"
    ))
  ) throw new TypeError("Invalid HTTP client options.");
  if (!validateTimer(options.timeoutMs, 1)) throw new RangeError("Invalid HTTP timeout.");
  if (options.maxResponseBytes !== undefined && !validateTimer(options.maxResponseBytes, 0)) {
    throw new RangeError("Invalid response limit.");
  }
  validatePolicy(options.retryPolicy);
  const userAgent = options.userAgent.trim();
  if (userAgent === "" || /[\r\n\0]/.test(userAgent)) throw new TypeError("Invalid User-Agent.");

  const defaultTimeout = options.timeoutMs;
  const defaultLimit = options.maxResponseBytes ?? 5_000_000;
  const retryPolicy = { ...options.retryPolicy };
  const { clock, sleep, logger, random } = options;
  const transport = options.transport ?? createDefaultTransport();
  let closing = false;
  let active = 0;
  let closePromise: Promise<void> | undefined;
  const drainWaiters = new Set<() => void>();

  function settled(): void {
    active -= 1;
    if (active === 0) {
      for (const resolve of drainWaiters) resolve();
      drainWaiters.clear();
    }
  }

  function close(): Promise<void> {
    if (closePromise !== undefined) return closePromise;
    closing = true;
    closePromise = (async () => {
      while (active > 0) await new Promise<void>((resolve) => drainWaiters.add(resolve));
      await transport.close();
    })();
    return closePromise;
  }

  async function runAttempt(request: NormalizedRequest, attempts: number, signal: AbortSignal): Promise<AttemptOutcome> {
    let method = request.method;
    let url = request.url;
    let headers = { ...request.headers };
    let body = request.body;
    let redirectCount = 0;

    const transportFailure = (error: unknown): never => {
      if (signal.aborted) throw signal.reason;
      if (error instanceof HttpError) throw error;
      throw new HttpError("transport", {
        retryable: request.method === "GET",
        attempts,
        cause: error,
      });
    };

    while (true) {
      let response: HttpTransportResponse;
      try {
        response = await transport.request({
          method,
          url,
          headers,
          ...(body === undefined ? {} : { body }),
          ...(request.connection === undefined ? {} : { connection: request.connection }),
          signal,
        });
      } catch (error) {
        return transportFailure(error);
      }

      let normalized: Record<string, readonly string[]>;
      try {
        normalized = normalizeHeaders(response.headers);
      } catch (error) {
        await discardBody(response.body);
        return transportFailure(error);
      }
      const location = normalized.location?.[0];
      if (request.redirect === "same-origin" && REDIRECT_STATUSES.has(response.status) && location !== undefined) {
        try {
          if (redirectCount >= 5) {
            throw new HttpError("redirect-limit", { retryable: false, attempts, status: response.status });
          }
          let target: URL;
          try {
            target = new URL(location, url);
          } catch {
            throw new HttpError("invalid-redirect", { retryable: false, attempts, status: response.status });
          }
          if (target.username !== "" || target.password !== "") {
            throw new HttpError("invalid-redirect", { retryable: false, attempts, status: response.status });
          }
          if ((target.protocol !== "http:" && target.protocol !== "https:") || target.origin !== request.origin) {
            throw new HttpError("redirect-policy", { retryable: false, attempts, status: response.status });
          }
          target.hash = "";
          await discardBody(response.body);
          if ((response.status === 301 || response.status === 302 || response.status === 303) && method === "POST") {
            method = "GET";
            body = undefined;
            headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith("content-")));
          }
          url = target.href;
          redirectCount += 1;
          continue;
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          if (error.code === "redirect-limit" || error.code === "invalid-redirect" || error.code === "redirect-policy") {
            await discardBody(response.body);
          }
          throw error;
        }
      }

      let collected: HttpResponse;
      try {
        collected = await collectResponse(response, url, request.maxResponseBytes, attempts);
      } catch (error) {
        return transportFailure(error);
      }
      const outcome = { response: collected, redirectCount };
      if (RETRY_STATUSES.has(collected.status)) throw new StatusFailure(outcome);
      return outcome;
    }
  }

  async function request(input: HttpRequest): Promise<HttpResponse> {
    let normalized: NormalizedRequest;
    try {
      normalized = validateRequest(input, defaultTimeout, defaultLimit, userAgent);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError("invalid-request", { retryable: false, attempts: 0 });
    }
    if (closing) throw new HttpError("client-closed", { retryable: false, attempts: 0 });
    if (normalized.signal?.aborted) throw normalized.signal.reason;

    active += 1;
    const operationController = new AbortController();
    const deadlineController = new AbortController();
    const timeoutReason = Symbol("HTTP timeout");
    let deadlineObservation: Promise<void> | undefined;
    let attempts = 0;
    let startedAt = 0;
    const callerAbort = (): void => operationController.abort(normalized.signal?.reason);
    try {
      normalized.signal?.addEventListener("abort", callerAbort);
      if (normalized.signal?.aborted) callerAbort();
      const sleeping = sleep(normalized.timeoutMs, deadlineController.signal);
      deadlineObservation = Promise.resolve(sleeping).then(
        () => {
          if (!deadlineController.signal.aborted) operationController.abort(timeoutReason);
        },
        (error: unknown) => {
          if (!deadlineController.signal.aborted) operationController.abort(error);
        },
      );
      startedAt = clock.monotonicNowMs();
      logger.debug("http.request.started", {
        method: normalized.method,
        origin: normalized.origin,
        timeoutMs: normalized.timeoutMs,
        maxResponseBytes: normalized.maxResponseBytes,
        redirectPolicy: normalized.redirect,
        connectionPinned: normalized.connection !== undefined,
      });

      const throwIfAborted = (): void => {
        if (!operationController.signal.aborted) return;
        if (operationController.signal.reason === timeoutReason) {
          throw new HttpError("timeout", { retryable: false, attempts });
        }
        throw operationController.signal.reason;
      };

      let outcome: AttemptOutcome;
      try {
        outcome = await executeWithRetry<AttemptOutcome>({
          operation: () => {
            attempts += 1;
            return runAttempt(normalized, attempts, operationController.signal);
          },
          policy: normalized.method === "POST" ? { ...retryPolicy, maxAttempts: 1 } : retryPolicy,
          sleep,
          signal: operationController.signal,
          ...(random === undefined ? {} : { random }),
          monotonicNowMs: () => clock.monotonicNowMs(),
          shouldRetry: (context) => {
            if (normalized.method !== "GET") return false;
            if (context.error instanceof StatusFailure) {
              logger.debug("http.request.retry", {
                method: normalized.method,
                origin: normalized.origin,
                attempt: context.attempt,
                elapsedMs: context.elapsedMs,
                reason: "http-status",
                status: context.error.outcome.response.status,
              });
              return true;
            }
            if (context.error instanceof HttpError && context.error.code === "transport" && context.error.retryable) {
              logger.debug("http.request.retry", {
                method: normalized.method,
                origin: normalized.origin,
                attempt: context.attempt,
                elapsedMs: context.elapsedMs,
                reason: context.error.code,
              });
              return true;
            }
            return false;
          },
        });
      } catch (error) {
        throwIfAborted();
        if (error instanceof StatusFailure) outcome = error.outcome;
        else throw error;
      }
      throwIfAborted();
      logger.info("http.request.completed", {
        method: normalized.method,
        origin: normalized.origin,
        status: outcome.response.status,
        attempts,
        elapsedMs: clock.monotonicNowMs() - startedAt,
        responseBytes: outcome.response.body.length,
        redirectCount: outcome.redirectCount,
        connectionPinned: normalized.connection !== undefined,
      });
      return outcome.response;
    } catch (error) {
      if (normalized.signal?.aborted && operationController.signal.reason === normalized.signal.reason) {
        logger.warn("http.request.failed", {
          method: normalized.method,
          origin: normalized.origin,
          errorCode: "cancelled",
          attempts,
          elapsedMs: clock.monotonicNowMs() - startedAt,
          connectionPinned: normalized.connection !== undefined,
        });
      } else if (error instanceof HttpError) {
        logger.warn("http.request.failed", {
          method: normalized.method,
          origin: normalized.origin,
          errorCode: error.code,
          attempts: error.attempts,
          elapsedMs: clock.monotonicNowMs() - startedAt,
          connectionPinned: normalized.connection !== undefined,
          ...(error.status === undefined ? {} : { status: error.status }),
        });
      }
      throw error;
    } finally {
      normalized.signal?.removeEventListener("abort", callerAbort);
      deadlineController.abort();
      if (deadlineObservation !== undefined) await deadlineObservation;
      settled();
    }
  }

  return { request, close };
}
