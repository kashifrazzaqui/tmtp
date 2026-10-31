import { performance } from "node:perf_hooks";

export interface Clock {
  now(): Date;
  monotonicNowMs(): number;
}

export interface Sleep {
  (delayMs: number, signal?: AbortSignal): Promise<void>;
}

export interface FixedClock extends Clock {
  advance(ms: number): void;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const systemClock: Clock = {
  now: () => new Date(),
  monotonicNowMs: () => performance.now(),
};

export const systemSleep: Sleep = (delayMs, signal) =>
  new Promise<void>((resolve, reject) => {
    if (typeof delayMs !== "number") {
      throw new TypeError("Sleep delay must be a number.");
    }
    if (
      !Number.isSafeInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > MAX_TIMER_DELAY_MS
    ) {
      throw new RangeError("Sleep delay is outside the supported timer range.");
    }
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });

export function createFixedClock(initial: Date): FixedClock {
  if (!(initial instanceof Date)) {
    throw new TypeError("Initial fixed-clock value must be a Date.");
  }
  if (!Number.isFinite(initial.getTime())) {
    throw new RangeError("Initial fixed-clock value must be valid.");
  }

  let wallTimeMs = initial.getTime();
  let monotonicTimeMs = 0;

  return {
    now: () => new Date(wallTimeMs),
    monotonicNowMs: () => monotonicTimeMs,
    advance(ms: number): void {
      if (typeof ms !== "number") {
        throw new TypeError("Fixed-clock advance must be a number.");
      }
      if (!Number.isSafeInteger(ms) || ms < 0) {
        throw new RangeError("Fixed-clock advance must be a non-negative safe integer.");
      }

      const nextWallTimeMs = wallTimeMs + ms;
      const nextMonotonicTimeMs = monotonicTimeMs + ms;
      if (
        !Number.isFinite(new Date(nextWallTimeMs).getTime()) ||
        !Number.isSafeInteger(nextMonotonicTimeMs)
      ) {
        throw new RangeError("Fixed-clock advance exceeds its supported range.");
      }

      wallTimeMs = nextWallTimeMs;
      monotonicTimeMs = nextMonotonicTimeMs;
    },
  };
}
