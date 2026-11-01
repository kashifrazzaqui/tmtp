import { Cron, CronPattern } from "croner";
import type { Clock } from "@tmtp/clock";
import type { Logger } from "@tmtp/logging";

export interface ScheduledTask {
  name: string;
  expression: string;
  timezone?: string;
  overrunProtection?: boolean;
  run: () => Promise<void>;
}
export interface Scheduler { register(task: ScheduledTask): void; start(): void; stop(): Promise<void>; }
export interface SchedulerDriverDefinition {
  readonly name: string;
  readonly expression: string;
  readonly timezone: string;
  readonly trigger: () => Promise<void>;
}
export interface SchedulerDriver { start(): void; stop(): void; }
export type SchedulerDriverFactory = (definition: SchedulerDriverDefinition) => SchedulerDriver;
export interface SchedulerOptions {
  clock: Clock;
  logger: Logger;
  timezone: string;
  overrunProtection: boolean;
  driverFactory?: SchedulerDriverFactory;
}
export type SchedulerErrorCode = "invalid-task" | "duplicate-task" | "invalid-schedule" | "invalid-state" | "driver-failure";
const MESSAGES: Record<SchedulerErrorCode, string> = {
  "invalid-task": "Invalid scheduled task.",
  "duplicate-task": "Scheduled task name is already registered.",
  "invalid-schedule": "Invalid schedule expression or time zone.",
  "invalid-state": "Scheduler lifecycle state does not allow this operation.",
  "driver-failure": "Scheduler driver operation failed.",
};
export class SchedulerError extends Error {
  override readonly name = "SchedulerError" as const;
  readonly taskName?: string;
  override readonly cause?: unknown;
  constructor(readonly code: SchedulerErrorCode, options: { taskName?: string; cause?: unknown } = {}) {
    super(MESSAGES[code]);
    if (options.taskName !== undefined) this.taskName = options.taskName;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

type State = "registered" | "running" | "stopping" | "stopped";
interface Entry {
  definition: SchedulerDriverDefinition;
  run: () => Promise<void>;
  overrunProtection: boolean;
  driver: SchedulerDriver;
  active: Set<Promise<void>>;
}

function validTimezone(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || /^[+-]/.test(value) || /^(?:UTC|GMT)[+-]/i.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
function validatePattern(expression: string, timezone: string, taskName: string): void {
  try {
    new CronPattern(expression, timezone, { mode: "5-part", alternativeWeekdays: false, sloppyRanges: false });
  } catch (cause) {
    throw new SchedulerError("invalid-schedule", { taskName, cause });
  }
}
function cronerDriver(definition: SchedulerDriverDefinition): SchedulerDriver {
  const cron = new Cron(definition.expression, {
    paused: true,
    timezone: definition.timezone,
    mode: "5-part",
    legacyMode: false,
    domAndDow: false,
    alternativeWeekdays: false,
    sloppyRanges: false,
    protect: false,
    catch: false,
    unref: false,
    allowPast: false,
  }, definition.trigger);
  return {
    start() {
      if (!cron.resume() || !cron.isRunning()) throw new Error("Cron driver did not resume.");
    },
    stop() { cron.stop(); },
  };
}
function driverFailure(taskName: string, cause: unknown): SchedulerError {
  return new SchedulerError("driver-failure", { taskName, cause });
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  if (options === null || typeof options !== "object" || options.clock === null || typeof options.clock !== "object" ||
    typeof options.clock.now !== "function" || typeof options.clock.monotonicNowMs !== "function" ||
    options.logger === null || typeof options.logger !== "object") throw new TypeError("Invalid scheduler options.");
  for (const method of ["trace", "debug", "info", "warn", "error", "child"] as const) {
    if (typeof options.logger[method] !== "function") throw new TypeError("Invalid scheduler logger.");
  }
  if (typeof options.timezone !== "string" || typeof options.overrunProtection !== "boolean" ||
    (options.driverFactory !== undefined && typeof options.driverFactory !== "function")) throw new TypeError("Invalid scheduler options.");
  if (!validTimezone(options.timezone)) throw new RangeError("Invalid scheduler time zone.");
  const { clock, logger, timezone, overrunProtection } = options;
  const factory = options.driverFactory ?? cronerDriver;
  const entries = new Map<string, Entry>();
  const activeRuns = new Set<Promise<void>>();
  let state: State = "registered";
  let stopPromise: Promise<void> | undefined;

  function register(task: ScheduledTask): void {
    if (state !== "registered") throw new SchedulerError("invalid-state");
    if (task === null || typeof task !== "object" || typeof task.name !== "string") throw new SchedulerError("invalid-task");
    const name = task.name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new SchedulerError("invalid-task", { taskName: name });
    if (entries.has(name)) throw new SchedulerError("duplicate-task", { taskName: name });
    if (typeof task.run !== "function" ||
      (task.timezone !== undefined && typeof task.timezone !== "string") ||
      (task.overrunProtection !== undefined && typeof task.overrunProtection !== "boolean")) {
      throw new SchedulerError("invalid-task", { taskName: name });
    }
    if (typeof task.expression !== "string") throw new SchedulerError("invalid-schedule", { taskName: name });
    const expression = task.expression.trim().replace(/\s+/g, " ");
    const taskTimezone = task.timezone ?? timezone;
    if (expression.split(" ").length !== 5 || !validTimezone(taskTimezone)) {
      throw new SchedulerError("invalid-schedule", { taskName: name });
    }
    validatePattern(expression, taskTimezone, name);
    const entry: Partial<Entry> = {
      run: task.run,
      overrunProtection: task.overrunProtection ?? overrunProtection,
      active: new Set(),
    };
    const trigger = (): Promise<void> => {
      if (state !== "running") return Promise.resolve();
      const current = entry as Entry;
      if (current.overrunProtection && current.active.size > 0) {
        return Promise.resolve().then(() => logger.warn("scheduler.task.overrun", {
          taskName: name, timezone: taskTimezone, activeRuns: current.active.size,
        }));
      }
      const execute = async (): Promise<void> => {
        try {
          const startedAt = clock.now().toISOString();
          const started = clock.monotonicNowMs();
          logger.debug("scheduler.task.started", { taskName: name, timezone: taskTimezone, startedAt });
          try {
            const run = current.run;
            const result = run() as unknown;
            if (result === null || (typeof result !== "object" && typeof result !== "function") || typeof (result as { then?: unknown }).then !== "function") {
              throw new TypeError("Scheduled task must return a Promise.");
            }
            await result;
          } catch {
            const durationMs = Math.max(0, clock.monotonicNowMs() - started);
            logger.error("scheduler.task.failed", {
              taskName: name, timezone: taskTimezone, startedAt, durationMs, errorCode: "task-run-failed",
            });
            return;
          }
          const durationMs = Math.max(0, clock.monotonicNowMs() - started);
          logger.info("scheduler.task.completed", { taskName: name, timezone: taskTimezone, startedAt, durationMs });
        } finally {
          current.active.delete(promise);
          activeRuns.delete(promise);
        }
      };
      const promise = Promise.resolve().then(execute);
      current.active.add(promise);
      activeRuns.add(promise);
      return promise;
    };
    const definition = Object.freeze({ name, expression, timezone: taskTimezone, trigger });
    entry.definition = definition;
    try {
      entry.driver = factory(definition);
      if (entry.driver === null || typeof entry.driver !== "object" || typeof entry.driver.start !== "function" || typeof entry.driver.stop !== "function") {
        throw new TypeError("Invalid scheduler driver.");
      }
    } catch (cause) {
      if (cause instanceof SchedulerError && cause.code === "driver-failure") throw cause;
      throw driverFailure(name, cause);
    }
    entries.set(name, entry as Entry);
  }

  function start(): void {
    if (state !== "registered") throw new SchedulerError("invalid-state");
    state = "running";
    try {
      for (const entry of entries.values()) entry.driver.start();
    } catch (cause) {
      for (const entry of entries.values()) {
        try { entry.driver.stop(); } catch { /* Preserve the start failure. */ }
      }
      state = "stopped";
      stopPromise = Promise.resolve();
      throw new SchedulerError("driver-failure", { cause });
    }
  }

  function stop(): Promise<void> {
    if (stopPromise !== undefined) return stopPromise;
    state = "stopping";
    stopPromise = (async () => {
      let firstDriverFailure: unknown;
      for (const entry of entries.values()) {
        try { entry.driver.stop(); } catch (cause) { firstDriverFailure ??= cause; }
      }
      const settled = await Promise.allSettled([...activeRuns]);
      state = "stopped";
      if (firstDriverFailure !== undefined) throw new SchedulerError("driver-failure", { cause: firstDriverFailure });
      const infrastructure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (infrastructure !== undefined) throw infrastructure.reason;
    })();
    return stopPromise;
  }
  return { register, start, stop };
}
