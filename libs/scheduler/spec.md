# Scheduler Library Spec

## Purpose and responsibility

Register named five-field periodic tasks, evaluate them in explicit time zones, prevent or permit overrun by task policy, contain task callback failures, and provide deterministic start/stop lifecycle control.

The package is an in-memory trigger adapter only. It does not make work durable, persist last-run records, enqueue missed occurrences, retry failed tasks, impose task timeouts, cancel running callbacks, or coordinate multiple processes. Tasks enqueue or resume idempotent work through `job-queue`; the service recovers missed work from durable store/job state during startup.

## Public interface / API surface

The package root is `@tmtp/scheduler`. It has no default export or subpath exports.

```ts
export interface ScheduledTask {
  name: string;
  expression: string;
  timezone?: string;
  overrunProtection?: boolean;
  run: () => Promise<void>;
}

export interface Scheduler {
  register(task: ScheduledTask): void;
  start(): void;
  stop(): Promise<void>;
}

export interface SchedulerDriverDefinition {
  readonly name: string;
  readonly expression: string;
  readonly timezone: string;
  readonly trigger: () => Promise<void>;
}

export interface SchedulerDriver {
  start(): void;
  stop(): void;
}

export type SchedulerDriverFactory = (
  definition: SchedulerDriverDefinition,
) => SchedulerDriver;

export interface SchedulerOptions {
  clock: import("@tmtp/clock").Clock;
  logger: import("@tmtp/logging").Logger;
  timezone: string;
  overrunProtection: boolean;
  driverFactory?: SchedulerDriverFactory;
}

export type SchedulerErrorCode =
  | "invalid-task"
  | "duplicate-task"
  | "invalid-schedule"
  | "invalid-state"
  | "driver-failure";

export class SchedulerError extends Error {
  readonly name: "SchedulerError";
  readonly code: SchedulerErrorCode;
  readonly taskName?: string;
  readonly cause?: unknown;
  constructor(
    code: SchedulerErrorCode,
    options?: { taskName?: string; cause?: unknown },
  );
}

export function createScheduler(options: SchedulerOptions): Scheduler;
```

Runtime exports are exactly `createScheduler` and `SchedulerError`. Type exports are exactly `ScheduledTask`, `Scheduler`, `SchedulerDriverDefinition`, `SchedulerDriver`, `SchedulerDriverFactory`, `SchedulerOptions`, and `SchedulerErrorCode`.

`SchedulerDriverFactory` is a deterministic schedule seam. The production default wraps Croner. A test driver captures definitions, starts/stops without real timers, and invokes `trigger` manually. It does not own registration, overrun, task outcome, or drain policy; those remain in this package and are therefore identical under fake and production drivers.

A conforming driver is initially paused, `start()` arms future triggers without invoking `trigger` inline, and `stop()` permanently prevents future driver callbacks. Driver `stop` does not need to wait for an admitted `trigger` Promise; the scheduler owns that drain.

## Construction and option validation

`createScheduler` validates and snapshots options synchronously. Wrong types throw `TypeError`; invalid time zones throw `RangeError`. No driver or timer is created until a task is registered.

- `clock.now`, `clock.monotonicNowMs`, and every logger method, including `trace` and `child`, are required functions.
- `timezone` is a non-empty IANA time-zone name accepted by the runtime's `Intl.DateTimeFormat`, including `UTC`. Numeric UTC offsets are not accepted.
- `overrunProtection` is a boolean. It is the default for tasks that omit their own flag.
- `driverFactory`, when supplied, is a function. Omitting it selects the Croner driver.

The options' `timezone` and `overrunProtection` are required factory inputs because the centralized configuration schema applies the documented defaults. The factory does not hide a second configuration default.

Separate schedulers have independent registries, lifecycle state, active-run sets, and drivers. There is no module-global task registry or scheduler singleton.

## Registration and validation

`register` is synchronous and allowed only before the first `start` or `stop`. Registration while running, stopping, or stopped throws `SchedulerError("invalid-state")`. There is no unregister, replace, pause, resume, or restart API.

Every task is validated and snapshotted before it is added:

- `name` is trimmed and matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. It is therefore 1..64 ASCII characters and safe as a stable log/correlation field. Names are unique after trimming.
- `expression` is trimmed, internal whitespace is normalized to single spaces, and exactly five cron fields remain. Croner `11.0.0` parses it in `5-part` mode with strict ranges, standard weekday numbering, and legacy day-of-month/day-of-week OR behavior. One-off ISO dates, nicknames, seconds, and year fields are not accepted.
- `timezone`, when present, overrides the scheduler default and follows the same IANA validation. Otherwise the task receives the scheduler default.
- `overrunProtection`, when present, is a boolean overriding the scheduler default. Otherwise the task receives the scheduler default.
- `run` is a function. The registration stores the function reference and scalar snapshots; later mutation of the input object does not alter the task.

Malformed names, callbacks, or override types throw `invalid-task`. Invalid expressions or time zones throw `invalid-schedule`. Duplicate names throw `duplicate-task`. These are synchronous `SchedulerError` failures with the normalized `taskName` when one is available.

The scheduler validates expression/time-zone policy independently of the injected driver, so a permissive fake cannot weaken the public contract. Only after validation does it call the driver factory and store the paused driver in registration order.

A Croner parse/validation failure maps to `invalid-schedule` with the original value in `cause`. A custom driver factory failure maps to `driver-failure`. A failed registration adds no registry entry and leaves previously registered tasks untouched.

Cron definitions are recreated from configuration after process restart. Starting a scheduler never runs a task immediately and never enumerates occurrences while the process was down. There is no hidden catch-up.

## Start behavior

The scheduler lifecycle is one-way:

```text
registered --start()--> running --stop()--> stopping --all runs settled--> stopped
    |                                                ^
    +--------------------stop()----------------------+
```

`start()` is valid only in `registered`. A second start, or start after stop, throws `invalid-state`. Starting an empty registry is valid.

Start arms each driver once in registration order. It does not invoke `run` itself, wait for the next occurrence, or return a Promise. Production Croner timers remain referenced (`unref=false`) so an otherwise idle service does not exit merely because only schedules remain.

If a driver fails to start, the scheduler permanently stops every registered driver, enters `stopped`, and throws `driver-failure`. Conforming drivers cannot trigger inline during start, so rollback has no admitted task runs. A scheduler with a partial start failure cannot be restarted; the service must construct a new instance after fixing startup.

## Trigger and overrun behavior

Every driver receives the same wrapper `trigger`, not the user's `run` directly.

When a trigger arrives:

1. If the scheduler is not `running`, return an already-resolved Promise without invoking or logging the task. This handles a stale callback racing with stop.
2. If this task has overrun protection and any earlier admitted run of the same task is still active, skip this occurrence. Emit the overrun log and return a resolved Promise without calling `run`.
3. Otherwise admit the run before invoking user code, so a re-entrant/concurrent trigger observes it. Different tasks have independent overrun guards and may run concurrently.
4. Invoke `run` in a microtask and await it. A synchronous throw, Promise rejection, or a non-Promise synchronous return is a task failure. A fulfilled Promise is success; any fulfillment value is ignored.
5. Emit the corresponding task outcome log, remove the run from the active set, and resolve the trigger after all outcome handling. A task callback failure does not reject the trigger, stop future occurrences, or reject `stop()`.

With `overrunProtection=false`, every trigger while running admits another run even when earlier runs of that task remain active. Runs can overlap; all are tracked individually. With protection enabled, skipped occurrences are dropped rather than queued. Completing a run does not replay skipped occurrences.

Overrun is per task name, not global. A long-running ingestion task cannot block a personalization trigger unless the caller's own task callback blocks the Node event loop.

There is no scheduler retry, task deadline, abort signal, or forced cancellation. Tasks that need those policies implement them in their own composition. The service's durable jobs remain at-least-once regardless of scheduler overrun settings.

## Task failure and infrastructure failure

Task failures are contained and logged with fixed safe metadata. They do not change scheduler lifecycle and do not prevent later triggers.

Driver start/stop failures are `SchedulerError("driver-failure")`. Logger failures and rejected trigger infrastructure are not task callback failures: they are never relabeled as a failed user run, retried by the scheduler, or silently discarded. They can reject the affected trigger or `stop()` and belong to the service's fatal/infrastructure error handling. The production driver does not add Croner overrun protection or retry behavior around the wrapper.

## Stop and drain behavior

`stop()` always returns a Promise and never throws synchronously. It is valid in `registered`, `running`, or an existing stopping/stopped state.

The first stop call:

1. Changes state to `stopping` synchronously, preventing any new trigger admission or registration.
2. Calls every driver `stop()` synchronously in registration order, attempting all drivers even if one fails. No schedule timer remains active after a conforming driver stops.
3. Waits for every admitted run across all tasks to settle, including concurrent runs allowed with overrun protection disabled. Already admitted runs are not cancelled and receive no new signal.
4. Enters `stopped` and fulfills after all drivers are stopped and all active runs/outcome logs have settled.

Calling stop before start permanently stops the paused drivers and prevents a later start. Concurrent and later stop calls return the same Promise, including the same rejection if cleanup failed. Task callback failures do not reject stop. Driver stop failures reject with `driver-failure` only after all stop calls and active-run draining have been attempted. Other infrastructure failures propagate without being converted into task failures.

`stop()` has no built-in grace timeout. A non-cooperative task can keep it pending. The service owns `server.shutdown_grace_ms`, must call scheduler stop before closing the database/log-dependent resources, and must handle any forced shutdown outside this package. Lifecycle code must call `stop()` from outside scheduled task callbacks; waiting for the currently executing callback from inside itself is not a supported shutdown path.

## Time and Croner semantics

The injected clock supplies task `startedAt` wall timestamps and monotonic durations for logs. It does not drive Croner. In particular, advancing `FixedClock` does not fire a production schedule and does not control Croner's global Date/timer basis. Deterministic scheduler tests therefore inject a manual driver as well as a fixed clock.

The production adapter pins these Croner behaviors:

- five-field cron only, with minute-level precision;
- the task's explicit IANA time zone;
- standard weekday numbering and strict ranges;
- legacy day-of-month/day-of-week OR behavior (`domAndDow=false`);
- no start/stop date, minimum interval, day offset, maximum run count, one-off date, or allow-past catch-up;
- referenced timers;
- no Croner `protect` callback and no automatic retry; the wrapper owns overrun and outcomes.

DST occurrence selection follows the pinned Croner `11.0.0` five-field implementation. The wrapper adds no second DST correction and does not persist occurrence state. A process restart schedules only future occurrences; durable recovery is a service responsibility.

## Typed errors

`SchedulerError` has fixed messages and safe optional metadata:

| Code | Message |
|---|---|
| `invalid-task` | `Invalid scheduled task.` |
| `duplicate-task` | `Scheduled task name is already registered.` |
| `invalid-schedule` | `Invalid schedule expression or time zone.` |
| `invalid-state` | `Scheduler lifecycle state does not allow this operation.` |
| `driver-failure` | `Scheduler driver operation failed.` |

`taskName`, when present, is the validated safe name. `cause` preserves an underlying parser/driver value for diagnostics but is never required for control flow. Messages and `taskName` never contain the expression, callback source, or arbitrary dependency text. Consumers log only safe projected fields, not raw causes.

## Allowlisted logging

The scheduler uses the supplied `Logger` directly so parent correlation fields survive. It creates no random run IDs and logs no expression, callback source, raw error, error message/stack/cause, payload, job data, or global Croner object.

`taskName` is the validated name. `startedAt` is the injected wall clock converted to the system ISO-8601 UTC representation. `durationMs` is a non-negative monotonic difference from the same clock. Log events and fields are exactly:

| Event | Level | Fields |
|---|---|---|
| `scheduler.task.started` | `debug` | `taskName`, `timezone`, `startedAt` |
| `scheduler.task.completed` | `info` | `taskName`, `timezone`, `startedAt`, `durationMs` |
| `scheduler.task.failed` | `error` | `taskName`, `timezone`, `startedAt`, `durationMs`, `errorCode="task-run-failed"` |
| `scheduler.task.overrun` | `warn` | `taskName`, `timezone`, `activeRuns` |

An overrun record is emitted instead of started/completed/failed records for that skipped occurrence. A failed run still removes its active marker only after its failure log completes. The fixed error code is deliberate: arbitrary task errors can contain secrets and are not safe default log fields. The task's owning composition must emit any additional diagnostics through its own allowlisted logger events.

## Durability and service composition

The service registers `ingestion.cron` and `personalization.cron` as short idempotent enqueue/recovery callbacks. Durable queues, active dedupe keys, ingestion cursors/run records, and recovery logic own correctness after failure.

No generic scheduler last-run table or repository is supplied. Startup recovery must enqueue idempotent work from current `reader-store`/`job-queue` state rather than waiting for the next cron occurrence or expecting this package to replay downtime. If a future policy needs wall-clock last-run comparisons, that persistence contract must be added to the owning store separately.

## Invariants

1. Names are unique, expressions are validated five-field schedules, and registration is complete before start.
2. A driver starts and stops at most once; stale triggers and post-stop registrations cannot admit work.
3. Overrun protection is per task, skipped occurrences are never queued, and every admitted run is tracked until outcome handling finishes.
4. Task failures do not stop future schedules or reject stop; infrastructure failures are not hidden as task failures.
5. Stop prevents new work before draining all admitted work and does not claim to cancel callbacks.
6. Production timing belongs to Croner; deterministic tests use an injected driver plus fixed clock rather than assuming `FixedClock` controls timers.
7. Log records contain only validated task/time-zone and injected timing metadata.

## Deterministic seams and acceptance-focused tests

Tests inject a manual `SchedulerDriverFactory`, `createFixedClock`, and a recording logger. The fake factory returns definitions and drivers with start/stop journals. Tests call `definition.trigger()` and control each run Promise explicitly; they never wait on a real cron timer. A fixed clock is advanced manually for exact timestamps/durations.

The recording logger implements `trace`, `debug`, `info`, `warn`, `error`, and `child`; no fake omits `trace`. At least one logging integration test uses the real logger with a capture destination and secret sentinels in task errors to prove those values are not projected into scheduler records.

At minimum, cover:

- `should validate and snapshot names expressions time zones defaults and callback references before driver creation`.
- `should reject duplicate names invalid five-field expressions and invalid time zones without changing prior registrations`.
- `should apply scheduler defaults and per-task timezone and overrun overrides`.
- `should register only before start and reject start twice registration after start and start after stop`.
- `should start drivers once in registration order without running tasks immediately`.
- `should roll back a partial driver start and reject later restart`.
- `should ignore stale triggers after stop without invoking or logging the task`.
- `should skip a concurrent trigger for a protected task and emit only an overrun record`.
- `should permit later protected runs after the active run finishes and never replay skipped occurrences`.
- `should track concurrent unprotected runs independently while isolating other task names`.
- `should contain synchronous throws rejections and invalid synchronous returns and allow later triggers`.
- `should stop every driver before awaiting all admitted runs and their outcome logs`.
- `should stop before start and share one stop Promise across repeated calls`.
- `should reject stop for driver failure only after attempting every stop and drain`.
- `should keep task failures separate from driver and logger infrastructure failures`.
- `should log only allowlisted metadata using exact fixed timestamps and monotonic durations with trace-capable logger fakes`.
- `should recover no work implicitly when a new scheduler is created after downtime`.

A small production-driver integration suite uses Vitest fake timers/system time to verify five-field Croner firing, explicit time zones, referenced-timer cleanup, no inline start run, and permanent stop. It must not depend on real wall-clock waits. Durable restart/recovery acceptance remains in service/job/store tests, not this in-memory package.

## Internal subcomponents

- Named registry, validation, and immutable task definitions.
- One-way lifecycle and active-run state machine.
- Per-task overrun guard and task outcome runner.
- Paused Croner driver adapter and manual-driver seam.
- Safe timing projection and structured task logging.

These are implementation details; only the API above is public.

## Dependencies on other libs

- `clock` — wall timestamps and monotonic durations only.
- `logging` — structural `Logger` only.

The dependency graph is unchanged. The scheduler does not import `job-queue`, `reader-store`, configuration, or service code.

## New build or OSS wrapper

New narrow wrapper around Croner `11.0.0`, with project-owned registration, overrun, outcome, and drain behavior. Croner's global named-job registry is not used.

## Hosted by

`services/personal-reader` lifecycle. Production composition supplies `systemClock`, the real logger, the configured scheduler defaults, and no custom driver. Tests supply the manual driver.

## Configuration

Existing keys, owners, and defaults are unchanged:

- `scheduler.timezone` — **optional**, default `UTC`; supplies `SchedulerOptions.timezone` and tasks without an override.
- `scheduler.overrun_protection` — **optional**, default `true`; supplies `SchedulerOptions.overrunProtection` and tasks without an override.

`ingestion.cron` and `personalization.cron` remain owned by their respective feature packages. They are task definitions supplied by the service, not scheduler configuration keys. No durability, catch-up, task-timeout, or shutdown-grace key is added to this package.
