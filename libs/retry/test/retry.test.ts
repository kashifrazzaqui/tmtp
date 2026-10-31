import { describe, expect, it, vi } from "vitest";
import { executeWithRetry } from "../src/index.js";
import type { RetryContext, RetryPolicy } from "../src/index.js";

const policy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 250,
  jitterRatio: 0,
};

function setup(overrides: Partial<RetryPolicy> = {}) {
  const contexts: RetryContext[] = [];
  const delays: number[] = [];
  let now = 0;
  return {
    contexts,
    delays,
    shouldRetry: (context: RetryContext) => {
      contexts.push(context);
      return true;
    },
    sleep: async (delayMs: number) => {
      delays.push(delayMs);
      now += delayMs;
    },
    monotonicNowMs: () => now,
    policy: { ...policy, ...overrides },
  };
}

describe("executeWithRetry", () => {
  it("should return the first successful value without calling classifier sleeper or random", async () => {
    const random = vi.fn(() => 0.5);
    const shouldRetry = vi.fn(() => true);
    const sleep = vi.fn(async () => {});
    await expect(executeWithRetry({
      operation: async () => undefined,
      policy,
      shouldRetry,
      sleep,
      random,
      monotonicNowMs: () => 0,
    })).resolves.toBeUndefined();
    expect(shouldRetry).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });

  it("should retry sequentially until success and count the initial call in maxAttempts", async () => {
    const fixture = setup();
    let calls = 0;
    const events: string[] = [];
    const result = await executeWithRetry({
      ...fixture,
      operation: async () => {
        events.push(`start-${++calls}`);
        if (calls < 3) throw new Error(`failure-${calls}`);
        events.push(`end-${calls}`);
        return "ok";
      },
      sleep: async (delay) => {
        events.push(`sleep-${delay}`);
        fixture.delays.push(delay);
      },
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(events).toEqual(["start-1", "sleep-100", "start-2", "sleep-200", "start-3", "end-3"]);
  });

  it("should make no classifier random or sleep call when maxAttempts is one", async () => {
    const shouldRetry = vi.fn(() => true);
    const sleep = vi.fn(async () => {});
    const random = vi.fn(() => 0.5);
    const failure = new TypeError("original");
    await expect(executeWithRetry({
      operation: async () => { throw failure; },
      policy: { ...policy, maxAttempts: 1 },
      shouldRetry,
      sleep,
      random,
      monotonicNowMs: () => 0,
    })).rejects.toBe(failure);
    expect(shouldRetry).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });

  it.each([new TypeError("type"), "failure", null, undefined])(
    "should preserve original operation failure %s",
    async (failure) => {
      const fixture = setup({ maxAttempts: 1 });
      await expect(executeWithRetry({
        ...fixture,
        operation: async () => { throw failure; },
      })).rejects.toBe(failure);
    },
  );

  it("should preserve failure identity in retry contexts and final rejection", async () => {
    const fixture = setup({ maxAttempts: 2 });
    const first = { first: true };
    const second = { second: true };
    const failures = [first, second];
    await expect(executeWithRetry({
      ...fixture,
      operation: async () => { throw failures.shift(); },
    })).rejects.toBe(second);
    expect(fixture.contexts).toHaveLength(1);
    expect(fixture.contexts[0]?.error).toBe(first);
    expect(fixture.contexts[0]?.attempt).toBe(1);
  });

  it("should stop with the original failure when shouldRetry returns false", async () => {
    const failure = new Error("stop");
    const sleep = vi.fn(async () => {});
    await expect(executeWithRetry({
      operation: async () => { throw failure; },
      policy,
      shouldRetry: () => false,
      sleep,
      monotonicNowMs: () => 0,
    })).rejects.toBe(failure);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("should pass elapsed snapshots that include prior fake sleeps", async () => {
    const fixture = setup();
    await executeWithRetry({
      ...fixture,
      operation: async () => { throw new Error("again"); },
    }).catch(() => {});
    expect(fixture.contexts.map((context) => [context.attempt, context.elapsedMs])).toEqual([
      [1, 0],
      [2, 100],
    ]);
  });

  it("should produce 100 200 250 250 delays for the documented exponential example", async () => {
    const fixture = setup({ maxAttempts: 5 });
    await executeWithRetry({
      ...fixture,
      operation: async () => { throw new Error("again"); },
    }).catch(() => {});
    expect(fixture.delays).toEqual([100, 200, 250, 250]);
  });

  it.each([
    [0, 80],
    [0.5, 100],
    [0.75, 110],
  ])("should apply deterministic jitter for random %s", async (random, expected) => {
    const fixture = setup({ maxAttempts: 2, jitterRatio: 0.2 });
    await executeWithRetry({
      ...fixture,
      random: () => random,
      operation: async () => { throw new Error("again"); },
    }).catch(() => {});
    expect(fixture.delays).toEqual([expected]);
  });

  it("should draw random once per approved retry and cap jitter at the hard maximum", async () => {
    const random = vi.fn(() => 0.999);
    const fixture = setup({ maxAttempts: 3, baseDelayMs: 200, jitterRatio: 1 });
    await executeWithRetry({
      ...fixture,
      random,
      operation: async () => { throw new Error("again"); },
    }).catch(() => {});
    expect(fixture.delays).toEqual([250, 250]);
    expect(random).toHaveBeenCalledTimes(2);
  });

  it("should call sleep once with zero delay when an approved retry calculates zero", async () => {
    const fixture = setup({ maxAttempts: 2, baseDelayMs: 0 });
    await executeWithRetry({
      ...fixture,
      operation: async () => { throw new Error("again"); },
    }).catch(() => {});
    expect(fixture.delays).toEqual([0]);
  });

  it("should pass the identical signal to every sleep", async () => {
    const controller = new AbortController();
    const sleeper = vi.fn(async () => {});
    await executeWithRetry({
      operation: async () => { throw new Error("again"); },
      policy: { ...policy, maxAttempts: 2 },
      shouldRetry: () => true,
      sleep: sleeper,
      signal: controller.signal,
      monotonicNowMs: () => 0,
    }).catch(() => {});
    expect(sleeper).toHaveBeenCalledWith(100, controller.signal);
  });

  it("should reject with the identical pre-abort reason without reading sources or invoking work", async () => {
    const reason = { aborted: true };
    const controller = new AbortController();
    controller.abort(reason);
    const operation = vi.fn(async () => "no");
    const monotonicNowMs = vi.fn(() => 0);
    await expect(executeWithRetry({
      operation,
      policy,
      shouldRetry: () => true,
      sleep: async () => {},
      signal: controller.signal,
      monotonicNowMs,
    })).rejects.toBe(reason);
    expect(operation).not.toHaveBeenCalled();
    expect(monotonicNowMs).not.toHaveBeenCalled();
  });

  it("should reject with the identical reason and prevent another attempt when aborted during sleep", async () => {
    const reason = { aborted: true };
    const controller = new AbortController();
    const operation = vi.fn(async () => { throw new Error("again"); });
    await expect(executeWithRetry({
      operation,
      policy: { ...policy, maxAttempts: 2 },
      shouldRetry: () => true,
      sleep: async () => { controller.abort(reason); },
      signal: controller.signal,
      monotonicNowMs: () => 0,
    })).rejects.toBe(reason);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should wait for a non-cooperative operation before observing abort", async () => {
    const reason = { aborted: true };
    const controller = new AbortController();
    let finish: (() => void) | undefined;
    const pending = executeWithRetry({
      operation: () => new Promise<string>((resolve) => {
        finish = () => { controller.abort(reason); resolve("too late"); };
      }),
      policy,
      shouldRetry: () => true,
      sleep: async () => {},
      signal: controller.signal,
      monotonicNowMs: () => 0,
    });
    await Promise.resolve();
    finish?.();
    await expect(pending).rejects.toBe(reason);
  });

  it("should propagate classifier failures without retrying them", async () => {
    const failure = new Error("classifier");
    const operation = vi.fn(async () => { throw new Error("operation"); });
    await expect(executeWithRetry({
      operation,
      policy,
      shouldRetry: () => { throw failure; },
      sleep: async () => {},
      monotonicNowMs: () => 0,
    })).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should reject non-boolean classifier results", async () => {
    await expect(executeWithRetry({
      operation: async () => { throw new Error("operation"); },
      policy,
      shouldRetry: (() => Promise.resolve(true)) as unknown as () => boolean,
      sleep: async () => {},
      monotonicNowMs: () => 0,
    })).rejects.toBeInstanceOf(TypeError);
  });

  it("should reject invalid source values at their documented use", async () => {
    await expect(executeWithRetry({
      operation: async () => { throw new Error("operation"); },
      policy: { ...policy, maxAttempts: 2, jitterRatio: 1 },
      shouldRetry: () => true,
      sleep: async () => {},
      random: () => 1,
      monotonicNowMs: () => 0,
    })).rejects.toBeInstanceOf(RangeError);

    await expect(executeWithRetry({
      operation: async () => "ok",
      policy,
      shouldRetry: () => true,
      sleep: async () => {},
      monotonicNowMs: () => -1,
    })).rejects.toBeInstanceOf(RangeError);
  });

  it.each([
    { ...policy, maxAttempts: 0 },
    { ...policy, baseDelayMs: -1 },
    { ...policy, baseDelayMs: 251 },
    { ...policy, jitterRatio: 2 },
  ])("should reject invalid policy before work: %o", async (invalidPolicy) => {
    const operation = vi.fn(async () => "ok");
    await expect(executeWithRetry({
      operation,
      policy: invalidPolicy,
      shouldRetry: () => true,
      sleep: async () => {},
    })).rejects.toBeInstanceOf(RangeError);
    expect(operation).not.toHaveBeenCalled();
  });

  it("should snapshot options and isolate concurrent executions", async () => {
    const mutablePolicy = { ...policy, maxAttempts: 2 };
    let calls = 0;
    const pending = executeWithRetry({
      operation: async () => {
        calls += 1;
        if (calls === 1) throw new Error("again");
        return "ok";
      },
      policy: mutablePolicy,
      shouldRetry: () => true,
      sleep: async () => {},
      monotonicNowMs: () => 0,
    });
    mutablePolicy.maxAttempts = 1;
    await expect(pending).resolves.toBe("ok");
    expect(calls).toBe(2);

    const independent = setup({ maxAttempts: 2 });
    const other = setup({ maxAttempts: 2 });
    await Promise.all([
      executeWithRetry({ ...independent, operation: async () => { throw new Error("x"); } }).catch(() => {}),
      executeWithRetry({ ...other, operation: async () => { throw new Error("x"); } }).catch(() => {}),
    ]);
    expect(independent.delays).toEqual([100]);
    expect(other.delays).toEqual([100]);
  });
});
