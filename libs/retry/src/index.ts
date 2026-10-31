import { performance } from "node:perf_hooks";
import pRetry from "p-retry";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface RetryContext {
  attempt: number;
  elapsedMs: number;
  error: unknown;
}

export interface Sleep {
  (delayMs: number, signal?: AbortSignal): Promise<void>;
}

export type RandomSource = () => number;
export type MonotonicSource = () => number;

export interface RetryOptions<T> {
  operation: () => Promise<T>;
  policy: RetryPolicy;
  shouldRetry: (context: RetryContext) => boolean;
  sleep: Sleep;
  signal?: AbortSignal;
  random?: RandomSource;
  monotonicNowMs?: MonotonicSource;
}

const MAX_DELAY_MS = 2_147_483_647;

class OperationFailure extends Error {
  constructor(readonly reason: unknown) {
    super("Operation failed.");
    this.name = "OperationFailure";
  }
}

function validatePolicy(policy: RetryPolicy): void {
  if (policy === null || typeof policy !== "object") {
    throw new TypeError("Retry policy must be an object.");
  }
  for (const [name, value] of Object.entries(policy)) {
    if (typeof value !== "number") {
      throw new TypeError(`Retry policy ${name} must be a number.`);
    }
  }
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError("Retry maxAttempts must be a positive safe integer.");
  }
  for (const [name, value] of [
    ["baseDelayMs", policy.baseDelayMs],
    ["maxDelayMs", policy.maxDelayMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DELAY_MS) {
      throw new RangeError(`Retry ${name} is outside the supported timer range.`);
    }
  }
  if (policy.baseDelayMs > policy.maxDelayMs) {
    throw new RangeError("Retry baseDelayMs must not exceed maxDelayMs.");
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new RangeError("Retry jitterRatio must be between zero and one.");
  }
}

function readMonotonic(source: MonotonicSource, previous?: number): number {
  const value = source();
  if (!Number.isFinite(value) || value < 0 || (previous !== undefined && value < previous)) {
    throw new RangeError("Monotonic source returned an invalid reading.");
  }
  return value;
}

function calculateDelay(
  attempt: number,
  policy: RetryPolicy,
  random: RandomSource,
): number {
  const uncapped = policy.baseDelayMs === 0
    ? 0
    : policy.baseDelayMs * 2 ** (attempt - 1);
  const base = Math.min(policy.maxDelayMs, uncapped);
  if (policy.jitterRatio === 0) return Math.round(base);

  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("Random source must return a finite value in [0, 1).");
  }
  const multiplier = 1 + policy.jitterRatio * (2 * value - 1);
  return Math.min(policy.maxDelayMs, Math.max(0, Math.round(base * multiplier)));
}

export async function executeWithRetry<T>(options: RetryOptions<T>): Promise<T> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Retry options must be an object.");
  }
  const { operation, shouldRetry, sleep, signal } = options;
  const policy = options.policy === null || typeof options.policy !== "object"
    ? options.policy
    : { ...options.policy };
  validatePolicy(policy);
  if (typeof operation !== "function" || typeof shouldRetry !== "function" || typeof sleep !== "function") {
    throw new TypeError("Retry operation, classifier, and sleeper must be functions.");
  }
  if (options.random !== undefined && typeof options.random !== "function") {
    throw new TypeError("Retry random source must be a function.");
  }
  if (options.monotonicNowMs !== undefined && typeof options.monotonicNowMs !== "function") {
    throw new TypeError("Retry monotonic source must be a function.");
  }
  const random = options.random ?? Math.random;
  const monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());

  signal?.throwIfAborted();
  let previousMonotonic = readMonotonic(monotonicNowMs);
  const origin = previousMonotonic;

  try {
    return await pRetry<T>(
      async () => {
        signal?.throwIfAborted();
        try {
          return await operation();
        } catch (reason) {
          throw new OperationFailure(reason);
        }
      },
      {
        retries: policy.maxAttempts - 1,
        factor: 1,
        minTimeout: 0,
        maxTimeout: 0,
        randomize: false,
        signal,
        shouldRetry: async (context) => {
          signal?.throwIfAborted();
          if (!(context.error instanceof OperationFailure)) {
            throw new TypeError("Unexpected retry failure envelope.");
          }
          const current = readMonotonic(monotonicNowMs, previousMonotonic);
          previousMonotonic = current;
          const decision = shouldRetry({
            attempt: context.attemptNumber,
            elapsedMs: current - origin,
            error: context.error.reason,
          });
          if (typeof decision !== "boolean") {
            throw new TypeError("Retry classifier must return a boolean.");
          }
          if (!decision) return false;

          signal?.throwIfAborted();
          const delayMs = calculateDelay(context.attemptNumber, policy, random);
          await sleep(delayMs, signal);
          signal?.throwIfAborted();
          return true;
        },
      },
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof OperationFailure) throw error.reason;
    throw error;
  }
}
