import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createFixedClock } from "@tmtp/clock";
import { createLogger, noopLogger } from "@tmtp/logging";
import type { Logger } from "@tmtp/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScheduler, SchedulerError } from "../src/index.js";
import type { SchedulerDriver, SchedulerDriverDefinition, SchedulerOptions, ScheduledTask } from "../src/index.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");
interface Harness {
  definitions: SchedulerDriverDefinition[];
  drivers: Array<SchedulerDriver & { started: number; stopped: number }>;
  logger: Logger & { records: Array<{ level: string; message: string; fields?: unknown }> };
  clock: ReturnType<typeof createFixedClock>;
  options: SchedulerOptions;
}
function harness(startFailureAt?: number, stopFailureAt?: number): Harness {
  const definitions: SchedulerDriverDefinition[] = [];
  const drivers: Harness["drivers"] = [];
  const records: Harness["logger"]["records"] = [];
  const record = (level: string) => (message: string, fields?: unknown) => { records.push({ level, message, ...(fields === undefined ? {} : { fields }) }); };
  const logger = {
    trace: record("trace"), debug: record("debug"), info: record("info"),
    warn: record("warn"), error: record("error"), child: vi.fn(() => logger), records,
  } as Harness["logger"];
  const clock = createFixedClock(NOW);
  const options: SchedulerOptions = {
    clock, logger, timezone: "UTC", overrunProtection: true,
    driverFactory(definition) {
      definitions.push(definition);
      const index = drivers.length;
      const driver = {
        started: 0, stopped: 0,
        start: vi.fn(() => { driver.started += 1; if (startFailureAt === index) throw new Error("start failed"); }),
        stop: vi.fn(() => { driver.stopped += 1; if (stopFailureAt === index) throw new Error("stop failed"); }),
      };
      drivers.push(driver);
      return driver;
    },
  };
  return { definitions, drivers, logger, clock, options };
}
const task = (name = "task", run: () => Promise<void> = async () => {}): ScheduledTask => ({
  name, expression: "*/5 * * * *", run,
});
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("validation registration and lifecycle", () => {
  it("should validate snapshot defaults overrides and callback references before driver creation", async () => {
    const h = harness();
    const scheduler = createScheduler(h.options);
    const original = vi.fn(async () => {});
    const replacement = vi.fn(async () => {});
    const mutable = {
      ...task("  task.one  ", original), expression: "  */5   * * * *  ",
      timezone: "America/New_York", overrunProtection: false,
    };
    scheduler.register(mutable);
    scheduler.register(task("default-task", async () => {}));
    mutable.name = "changed";
    mutable.expression = "0 0 1 1 0";
    mutable.timezone = "UTC";
    mutable.run = replacement;
    scheduler.start();
    expect(h.definitions.map((definition) => [definition.name, definition.expression, definition.timezone])).toEqual([
      ["task.one", "*/5 * * * *", "America/New_York"], ["default-task", "*/5 * * * *", "UTC"],
    ]);
    const running = h.definitions[0]!.trigger();
    await Promise.resolve();
    expect(original).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    await running;
    await scheduler.stop();
  });

  it("should reject duplicates invalid schedules and failed factories without changing prior registrations", () => {
    const h = harness();
    const scheduler = createScheduler(h.options);
    scheduler.register(task("valid"));
    for (const value of [task("valid"), task("bad name"), task("", async () => {})]) {
      expect(() => scheduler.register(value)).toThrow(SchedulerError);
    }
    for (const expression of ["* * * *", "* * * * * *", "@daily", "61 * * * *", "2026-01-01T00:00:00Z"]) {
      expect(() => scheduler.register({ ...task("other"), expression })).toThrowError(expect.objectContaining({ code: "invalid-schedule" }));
    }
    expect(() => scheduler.register({ ...task("other"), timezone: "Not/AZone" })).toThrowError(expect.objectContaining({ code: "invalid-schedule" }));
    expect(() => scheduler.register({ ...task("other"), expression: 42 as never })).toThrowError(expect.objectContaining({ code: "invalid-schedule" }));
    expect(h.drivers).toHaveLength(1);
    scheduler.start();
    expect(h.drivers[0]?.started).toBe(1);
    return scheduler.stop();
  });

  it("should enforce one-way registration start and stop states", async () => {
    const h = harness();
    const scheduler = createScheduler(h.options);
    scheduler.register(task());
    scheduler.start();
    expect(() => scheduler.start()).toThrowError(expect.objectContaining({ code: "invalid-state" }));
    expect(() => scheduler.register(task("late"))).toThrowError(expect.objectContaining({ code: "invalid-state" }));
    await scheduler.stop();
    expect(() => scheduler.start()).toThrowError(expect.objectContaining({ code: "invalid-state" }));
    expect(() => scheduler.register(task("later"))).toThrowError(expect.objectContaining({ code: "invalid-state" }));
  });

  it("should start empty registries and stop before start with one shared Promise", async () => {
    const h = harness();
    const scheduler = createScheduler(h.options);
    scheduler.register(task());
    const first = scheduler.stop();
    const second = scheduler.stop();
    expect(second).toBe(first);
    await first;
    expect(h.drivers[0]?.started).toBe(0);
    expect(h.drivers[0]?.stopped).toBe(1);
    const empty = createScheduler(harness().options);
    empty.start();
    await empty.stop();
  });

  it("should stop every driver after partial start failure and forbid restart", () => {
    const h = harness(1);
    const scheduler = createScheduler(h.options);
    scheduler.register(task("one"));
    scheduler.register(task("two"));
    expect(() => scheduler.start()).toThrowError(expect.objectContaining({ code: "driver-failure" }));
    expect(h.drivers.map((driver) => driver.stopped)).toEqual([1, 1]);
    expect(() => scheduler.start()).toThrowError(expect.objectContaining({ code: "invalid-state" }));
    expect(h.drivers[0]?.started).toBe(1);
  });
});

describe("trigger outcomes and overrun", () => {
  it("should skip protected concurrent runs and permit later occurrences without replay", async () => {
    const h = harness();
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const scheduler = createScheduler(h.options);
    scheduler.register(task("protected", run));
    scheduler.start();
    const trigger = h.definitions[0]!.trigger;
    const first = trigger();
    await Promise.resolve();
    await trigger();
    expect(run).toHaveBeenCalledOnce();
    expect(h.logger.records.filter((record) => record.message === "scheduler.task.overrun")).toEqual([
      { level: "warn", message: "scheduler.task.overrun", fields: { taskName: "protected", timezone: "UTC", activeRuns: 1 } },
    ]);
    h.clock.advance(25);
    gate.resolve();
    await first;
    expect(h.logger.records.at(-1)).toEqual({
      level: "info", message: "scheduler.task.completed",
      fields: { taskName: "protected", timezone: "UTC", startedAt: NOW.toISOString(), durationMs: 25 },
    });
    const later = deferred();
    run.mockImplementationOnce(() => later.promise);
    const next = trigger();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    later.resolve();
    await next;
    await scheduler.stop();
  });

  it("should track concurrent unprotected runs independently and isolate task names", async () => {
    const h = harness();
    const gates = [deferred(), deferred()];
    let invocation = 0;
    const run = vi.fn(() => gates[invocation++]!.promise);
    const scheduler = createScheduler(h.options);
    scheduler.register({ ...task("unprotected", run), overrunProtection: false });
    scheduler.register(task("other"));
    scheduler.start();
    const first = h.definitions[0]!.trigger();
    const second = h.definitions[0]!.trigger();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    expect(h.logger.records.some((record) => record.message === "scheduler.task.overrun")).toBe(false);
    gates[1]!.resolve();
    await second;
    gates[0]!.resolve();
    await first;
    await scheduler.stop();
  });

  it("should contain throws rejections and non-Promise returns and allow later runs", async () => {
    const h = harness();
    const run = vi.fn()
      .mockImplementationOnce(() => { throw new Error("secret-sync-error"); })
      .mockImplementationOnce(() => Promise.reject(new Error("secret-rejection")))
      .mockImplementationOnce(() => 42)
      .mockResolvedValueOnce(undefined);
    const scheduler = createScheduler(h.options);
    scheduler.register(task("failure", run as () => Promise<void>));
    scheduler.start();
    for (let index = 0; index < 4; index += 1) await h.definitions[0]!.trigger();
    expect(run).toHaveBeenCalledTimes(4);
    expect(h.logger.records.filter((record) => record.message === "scheduler.task.failed")).toHaveLength(3);
    expect(h.logger.records.filter((record) => record.message === "scheduler.task.completed")).toHaveLength(1);
    expect(JSON.stringify(h.logger.records)).not.toContain("secret-sync-error");
    expect(JSON.stringify(h.logger.records)).not.toContain("secret-rejection");
    await scheduler.stop();
  });

  it("should ignore stale triggers after stop without task or log work", async () => {
    const h = harness();
    const run = vi.fn(async () => {});
    const scheduler = createScheduler(h.options);
    scheduler.register(task("stale", run));
    scheduler.start();
    const trigger = h.definitions[0]!.trigger;
    await scheduler.stop();
    await trigger();
    expect(run).not.toHaveBeenCalled();
    expect(h.logger.records).toEqual([]);
  });

  it("should propagate logger failures as infrastructure rather than task failures", async () => {
    const h = harness();
    const infrastructure = new Error("logger failed");
    vi.spyOn(h.logger, "debug").mockImplementation(() => { throw infrastructure; });
    const run = vi.fn(async () => {});
    const scheduler = createScheduler(h.options);
    scheduler.register(task("logging", run));
    scheduler.start();
    await expect(h.definitions[0]!.trigger()).rejects.toBe(infrastructure);
    expect(run).not.toHaveBeenCalled();
    expect(h.logger.records.some((record) => record.message === "scheduler.task.failed")).toBe(false);
    await scheduler.stop();
  });

  it("should keep task error secrets out of real logger records", async () => {
    let output = "";
    const spy = vi.spyOn(fs, "writeSync").mockImplementation(((_fd: number, data: Uint8Array, offset: number, length: number) => {
      output += Buffer.from(data).subarray(offset, offset + length).toString("utf8");
      return length;
    }) as typeof fs.writeSync);
    syncBuiltinESMExports();
    try {
      const h = harness();
      const scheduler = createScheduler({
        ...h.options,
        logger: createLogger({ level: "debug", service: "scheduler-test", secretValues: [] }),
      });
      scheduler.register(task("secret-safe", () => Promise.reject(new Error("task-secret-sentinel"))));
      scheduler.start();
      await h.definitions[0]!.trigger();
      await scheduler.stop();
      expect(output).toContain("scheduler.task.failed");
      expect(output).toContain("task-run-failed");
      expect(output).not.toContain("task-secret-sentinel");
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });
});

describe("stop draining and driver failures", () => {
  it("should stop all drivers before awaiting admitted runs and their outcome logs", async () => {
    const h = harness();
    const first = deferred();
    const second = deferred();
    const scheduler = createScheduler(h.options);
    scheduler.register({ ...task("one", () => first.promise), overrunProtection: false });
    scheduler.register({ ...task("two", () => second.promise), overrunProtection: false });
    scheduler.start();
    const one = h.definitions[0]!.trigger();
    const two = h.definitions[1]!.trigger();
    await Promise.resolve();
    const stopping = scheduler.stop();
    expect(h.drivers.map((driver) => driver.stopped)).toEqual([1, 1]);
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    second.resolve();
    await two;
    expect(stopped).toBe(false);
    first.resolve();
    await one;
    await stopping;
    expect(stopped).toBe(true);
    expect(h.logger.records.filter((record) => record.message === "scheduler.task.completed")).toHaveLength(2);
  });

  it("should reject driver stop failure only after attempting every stop and drain", async () => {
    const h = harness(undefined, 0);
    const gate = deferred();
    const scheduler = createScheduler(h.options);
    scheduler.register(task("one", () => gate.promise));
    scheduler.register(task("two"));
    scheduler.start();
    const running = h.definitions[0]!.trigger();
    await Promise.resolve();
    const stopping = scheduler.stop();
    expect(h.drivers.map((driver) => driver.stopped)).toEqual([1, 1]);
    gate.resolve();
    await running;
    await expect(stopping).rejects.toMatchObject({ code: "driver-failure" });
    expect(h.logger.records.at(-1)?.message).toBe("scheduler.task.completed");
    expect(scheduler.stop()).toBe(stopping);
  });
});

describe("production Croner driver", () => {
  it("should fire a five-field schedule in its time zone without inline start and stop permanently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T13:59:00.000Z"));
    const run = vi.fn(async () => {});
    const scheduler = createScheduler({
      clock: createFixedClock(NOW), logger: noopLogger, timezone: "UTC", overrunProtection: true,
    });
    scheduler.register({ name: "cron", expression: "0 9 * * *", timezone: "America/New_York", run });
    scheduler.start();
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledOnce();
    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledOnce();
  });
});
