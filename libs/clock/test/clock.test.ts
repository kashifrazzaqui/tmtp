import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixedClock, systemClock, systemSleep } from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createFixedClock", () => {
  it("should return independent dates with the current fixed value when now is called repeatedly", () => {
    const clock = createFixedClock(new Date("2026-01-02T03:04:05.006Z"));
    const first = clock.now();
    const second = clock.now();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first.setUTCFullYear(1999);
    expect(second.toISOString()).toBe("2026-01-02T03:04:05.006Z");
    expect(clock.now().toISOString()).toBe("2026-01-02T03:04:05.006Z");
  });

  it("should snapshot the constructor date and returned dates when callers mutate them", () => {
    const initial = new Date(1_000);
    const clock = createFixedClock(initial);
    initial.setTime(5_000);
    expect(clock.now().getTime()).toBe(1_000);
  });

  it("should start fixed monotonic time at zero and advance wall and monotonic time together", () => {
    const clock = createFixedClock(new Date(1_000));
    expect(clock.monotonicNowMs()).toBe(0);
    clock.advance(0);
    clock.advance(250);
    expect(clock.now().getTime()).toBe(1_250);
    expect(clock.monotonicNowMs()).toBe(250);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "should reject invalid advance %s without changing either reading",
    (value) => {
      const clock = createFixedClock(new Date(1_000));
      expect(() => clock.advance(value)).toThrow(RangeError);
      expect(clock.now().getTime()).toBe(1_000);
      expect(clock.monotonicNowMs()).toBe(0);
    },
  );

  it("should reject date overflow atomically", () => {
    const nearDateLimit = createFixedClock(new Date(8_640_000_000_000_000));
    expect(() => nearDateLimit.advance(1)).toThrow(RangeError);
    expect(nearDateLimit.now().getTime()).toBe(8_640_000_000_000_000);
    expect(nearDateLimit.monotonicNowMs()).toBe(0);
  });

  it("should keep separate fixed clock instances independent", () => {
    const first = createFixedClock(new Date(0));
    const second = createFixedClock(new Date(0));
    first.advance(10);
    expect(second.now().getTime()).toBe(0);
    expect(second.monotonicNowMs()).toBe(0);
  });

  it("should reject invalid constructor inputs", () => {
    expect(() => createFixedClock("2026-01-01" as unknown as Date)).toThrow(TypeError);
    expect(() => createFixedClock(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("systemSleep", () => {
  it("should fulfill with undefined only after the requested delay including zero", async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = systemSleep(0).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.runAllTimersAsync();
    expect(await pending).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should reject immediately with the identical pre-abort reason and allocate no timer", async () => {
    vi.useFakeTimers();
    const reason = { marker: "stop" };
    const controller = new AbortController();
    controller.abort(reason);
    await expect(systemSleep(1, controller.signal)).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should clear a pending sleep and reject with the identical reason when aborted", async () => {
    vi.useFakeTimers();
    const reason = { marker: "stop" };
    const controller = new AbortController();
    const pending = systemSleep(1_000, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
  });

  it("should ignore aborts after fulfillment", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = systemSleep(1, controller.signal);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    controller.abort(new Error("late"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should reject invalid delays before observing an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("abort"));
    await expect(systemSleep("1" as unknown as number, controller.signal)).rejects.toBeInstanceOf(TypeError);
    await expect(systemSleep(-1, controller.signal)).rejects.toBeInstanceOf(RangeError);
    await expect(systemSleep(2_147_483_648, controller.signal)).rejects.toBeInstanceOf(RangeError);
  });

  it("should keep independent sleeps independent when one is aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancelled = systemSleep(10, controller.signal);
    const completed = systemSleep(10);
    controller.abort("cancel");
    await expect(cancelled).rejects.toBe("cancel");
    await vi.runAllTimersAsync();
    await expect(completed).resolves.toBeUndefined();
  });
});

describe("systemClock", () => {
  it("should expose valid independent wall dates and ordered finite monotonic readings", () => {
    const firstDate = systemClock.now();
    const secondDate = systemClock.now();
    expect(firstDate).not.toBe(secondDate);
    expect(Number.isFinite(firstDate.getTime())).toBe(true);
    const first = systemClock.monotonicNowMs();
    const second = systemClock.monotonicNowMs();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
