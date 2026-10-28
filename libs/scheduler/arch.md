# Scheduler Library Architecture

## Design goal and boundary

Implement `spec.md` as a tier-1 ESM package over `croner@11.0.0`, `@tmtp/clock`, and `@tmtp/logging`. Keep Croner responsible for occurrence calculation and timers. Keep registration, lifecycle, overrun, outcome logging, and active-run draining in the project-owned wrapper.

Do not expose Cron, CronPattern, CronOptions, CronDate, or Croner's global `scheduledJobs` array. Do not import durable stores or job queues. The public `SchedulerDriverFactory` seam replaces only occurrence delivery, not scheduler policy.

## Internal decomposition

Keep these responsibilities private behind the package root:

- **Definition validator:** normalize and validate task names, five-field expressions, IANA time zones, defaults, and callbacks.
- **Registry/lifecycle:** preserve registration order, reject duplicates/state violations, and own the one-way state machine.
- **Run coordinator:** admit triggers, apply per-task overrun policy, execute callbacks, track active runs, and emit outcomes.
- **Croner driver:** construct paused Cron instances with fixed options and translate start/stop to resume/stop.
- **Timing/log projection:** read the injected wall/monotonic clock and create allowlisted fields.
- **Public entry:** export only the documented factory, error class, and types.

The parser and runner are not public test hooks. Contract tests drive them through `register`, `start`, `stop`, and a manual driver.

## Scheduler state

A scheduler instance closes over:

```text
state = registered | running | stopping | stopped
entries: Map<normalizedName, {
  definition: immutable SchedulerDriverDefinition,
  run: () => Promise<void>,
  overrunProtection: boolean,
  driver: SchedulerDriver,
  active: Set<Promise<void>>
}>
activeRuns: Set<Promise<void>>
stopPromise?: Promise<void>
```

The map preserves JavaScript insertion order for driver start/stop. There is no module-level registry. In particular, the Croner adapter omits Croner's `name` option so tasks do not enter Croner's process-global named-job array.

`createScheduler` validates and snapshots only options. `register` validates one complete task, creates its paused driver, and inserts the entry atomically. If any step fails, no partial entry remains.

## Definition validation

Normalize the task before driver creation:

1. Trim the name and apply the exact ASCII/length rule.
2. Trim the expression, collapse whitespace, and require five fields.
3. Resolve task time-zone and overrun values from the task override or scheduler default.
4. Validate the time zone with `Intl.DateTimeFormat` so a custom driver cannot accept an invalid name.
5. Parse the normalized expression with Croner's `CronPattern` in `5-part` mode, `alternativeWeekdays=false`, and `sloppyRanges=false`.
6. Require a function callback and boolean override types, then snapshot every scalar and the callback reference.

`CronPattern` validation is used even with a fake driver. The production Cron constructor receives the same normalized values and fixed day-policy options, so registration and runtime cannot silently use different expression modes.

Map parser failures to `invalid-schedule`; map factory failures to `driver-failure`. Preserve causes only for programmatic diagnostics. No log event serializes them.

## Croner driver

For each definition, construct the equivalent of:

```ts
new Cron(expression, {
  paused: true,
  timezone,
  mode: "5-part",
  legacyMode: false,
  domAndDow: false,
  alternativeWeekdays: false,
  sloppyRanges: false,
  protect: false,
  catch: false,
  unref: false,
  allowPast: false
}, trigger)
```

Omit `name`, `startAt`, `stopAt`, `interval`, `maxRuns`, `dayOffset`, `utcOffset`, and one-off date inputs. Thus there is no hidden catch-up, minimum interval, run-count bound, or global named registration. `domAndDow=false` supplies the documented standard OR behavior; `legacyMode=false` avoids the deprecated compatibility switch. Five-field mode fixes minute-level precision.

The driver starts paused. `start()` calls `resume()` and verifies that the Cron instance is running; a failed resume becomes a driver failure. `stop()` calls Croner `stop()`, permanently clearing future schedule timers. It does not await the callback Promise because the wrapper's active set owns draining.

Croner receives the wrapper trigger directly. The wrapper contains task callback failures, so normal task errors do not reach Croner. Croner `protect` is disabled because the wrapper's per-task active set provides the same policy for every injected driver and produces the required overrun log. Croner `catch` is disabled so an infrastructure/logger rejection is not silently relabeled or discarded.

The injected `Clock` is deliberately not passed into Croner. Croner 11 uses runtime Date/timer facilities internally; pretending that `FixedClock.advance()` controls it would be incorrect. The manual driver is the deterministic occurrence seam.

## Start algorithm

`start` first validates `state === registered`, then changes to `running` and starts drivers in registration order. Conforming drivers do not trigger inline, so no user run can race this loop.

If a driver start throws or returns an invalid running state:

1. Call `stop()` on every registered driver, including drivers not yet started.
2. Change state directly to `stopped`; no task can have been admitted under the conforming-driver contract.
3. Throw `SchedulerError("driver-failure")` with the original cause.

The instance is not restartable after this rollback. A later `start` or `register` receives `invalid-state`. Starting an empty registry simply leaves a running scheduler with no drivers.

No task is invoked by `start` itself. The first task execution can come only from a later driver occurrence.

## Trigger admission and overrun

The wrapper trigger is a Promise-returning function. It first checks scheduler state; stale triggers in any other state return `Promise.resolve()` without task or log work.

For a running scheduler, inspect the named entry's active set before invoking user code:

- If protection is enabled and the set is non-empty, emit only `scheduler.task.overrun` and return a resolved Promise. `activeRuns` is the current per-task count. No new run record is created and no occurrence is queued.
- Otherwise create a deferred completion Promise and add it to both the per-task and global active sets **before** scheduling the callback microtask. This makes admission synchronous with respect to re-entrant/manual triggers.

Use a microtask to begin each admitted run. This lets the trigger finish its bookkeeping before user code executes and gives synchronous throws the same outcome path as Promise rejections. Once admitted, a run proceeds even if `stop` changes lifecycle state before its microtask; stop has already accepted responsibility for draining it.

Different entries have independent active sets. Unprotected tasks receive one new completion record per trigger, so their concurrency is explicit rather than hidden inside Croner.

## Run execution and outcomes

At actual run start:

1. Read `clock.now()` and `clock.monotonicNowMs()` once each. Convert the wall date to the system ISO-8601 UTC string for `startedAt`.
2. Emit `scheduler.task.started` with safe fields.
3. Call the stored callback with no scheduler-owned arguments or `this` context.
4. Require a thenable/Promise result at runtime. A synchronous non-Promise result follows the task-failure path rather than being mistaken for an async completion.
5. Await the result. On fulfillment, read monotonic time and emit `completed`. On synchronous throw or rejection, read monotonic time and emit `failed` with the fixed error code.
6. Remove the completion from both active sets in `finally`, after outcome logging has finished.

Duration is `currentMonotonicMs - startMonotonicMs`; a conforming clock makes it non-negative. Do not read wall time to measure it. Do not include the thrown value in fields. Arbitrary task errors can carry URLs, cookies, prompts, or other secrets in messages, stacks, causes, and custom properties.

Normal task failure resolves the trigger after the failure log. It does not change lifecycle or block a later occurrence. A logger/clock infrastructure failure rejects the trigger and still removes active bookkeeping in `finally`; it is not retried or converted into a user-task result.

The active Promise represents the entire admitted trigger, including outcome logging, not just the user's Promise. This distinction ensures `stop()` does not report drained work while a failure/success log is still pending or has not yet been attempted.

## Stop and drain algorithm

On the first `stop` call, create one shared async operation whose synchronous prefix performs lifecycle and driver changes before its first await:

1. Set `state=stopping` immediately.
2. Iterate every entry and call `driver.stop()`, recording the first driver failure but continuing through all entries.
3. Snapshot/observe the global active set and wait for all admitted completions to settle. Since admission is disabled, the set can only shrink. Use all-settled draining so one infrastructure rejection does not leave other runs unobserved.
4. Set `state=stopped` after every completion and cleanup attempt.
5. Reject with `driver-failure` if a driver stop failed. Otherwise propagate an active trigger's infrastructure failure, if any. Ordinary task failures have already been contained and do not reject stop.

Assign `stopPromise` before returning. Every later call returns it without repeating driver stops. Stop from `registered` follows the same path with no active runs and permanently prevents start. Stop from `stopping` or `stopped` never creates a second drain.

There is intentionally no abort controller or grace timer in this state machine. The service must bound its own shutdown wait and must not close resources required by admitted callbacks until they have drained. Calling stop from inside a task and awaiting that same task's drain is unsupported; lifecycle shutdown belongs outside callbacks.

## Logging design

Construct each event from the validated definition and timing values only. Use the supplied logger directly so any existing child/correlation bindings remain intact. No child creation is required per run and no random run ID is generated.

The runner never passes the task error as `err`, never interpolates it into a message, and never logs the cron expression or callback. Overrun is a warn with no corresponding started/completed/failed event. Completion is info, start is debug, and failure is error. All numeric values are finite values from validated counters or the injected monotonic clock.

Logger behavior remains the Batch A contract: synchronous writes, fixed redaction, and thrown destination failures. Scheduler redaction is defense in depth around an already allowlisted projection. A recording test logger must implement the entire interface, including `trace`; a real-capture integration test proves the projection emits no secret sentinel contained only in a task error.

## Dependency use

- `@tmtp/clock`: fresh wall `Date` values and monotonic readings. No sleep is needed by this package.
- `@tmtp/logging`: complete structural `Logger`, including `trace` and `child`.
- `croner@11.0.0`: private expression parsing and occurrence/timer driver.

No runtime or type-only dependency is added on `job-queue`, `reader-store`, `config`, `retry`, service code, or a random source. Existing graph tiers and configuration keys remain unchanged.

## Trade-offs

- **Project-owned overrun rather than Croner `protect`:** a small active-set guard duplicates one dependency feature but gives identical fake/production behavior, exact skip logs, and reliable stop accounting.
- **One-way lifecycle:** no pause/resume/restart API keeps timer and registration state deterministic. Recovery constructs a new scheduler instead of reviving stopped Cron jobs.
- **Drain without cancellation:** shutdown preserves admitted work but can wait for a non-cooperative task. The service's grace policy, not a hidden task abort, must resolve that trade-off.
- **Dropped protected occurrences:** this prevents memory/latency buildup. Durable idempotent enqueue/recovery, not a growing scheduler backlog, supplies missed-work correctness.
- **Separate Croner time and injected log time:** production occurrence scheduling retains Croner semantics, while deterministic tests must use two explicit seams. This is clearer than a partially virtualized clock.
- **Contained task errors but visible infrastructure errors:** periodic work survives ordinary failures, while broken logging/driver behavior is not silently normalized into a task failure.
- **No durable last-run state:** the package stays small and single-process. The service must use existing store/job evidence or add a separate persistence contract if wall-clock last-run policy becomes necessary.

## Testing seams and verification design

### Manual driver harness

A fake `driverFactory` records every immutable definition and returns a fake driver with `started`, `stopped`, and trigger journals. `start` only flips the fake's armed flag. Tests retain `definition.trigger` even after fake stop so they can prove stale callbacks are ignored by the wrapper.

Use deferred user callbacks to control exact completion order:

- fire two triggers without resolving the first to test protected skip or unprotected overlap;
- resolve/reject callbacks in an order different from admission to test independent tracking;
- call stop while runs are pending and assert every driver stops before any run is released;
- reject a task and then trigger it again to prove schedule continuity;
- use invalid synchronous callback returns as a separate failure case.

Advance `createFixedClock` between start/end for exact `startedAt` and duration fields. The recording logger includes `trace`, `debug`, `info`, `warn`, `error`, and `child`, and stores complete field objects for allowlist assertions.

### Croner integration and service boundary

Use Vitest fake timers/system time for the real driver integration suite. Verify that start is paused/non-immediate, a five-field occurrence fires in its configured time zone, stop clears future timers, and no global named Cron registry is used. Keep real-time waits out of the suite.

Service tests, not scheduler unit tests, prove startup enqueue/recovery from real SQLite state and shutdown within grace. Those tests must also cover a newly constructed scheduler after downtime: it schedules future occurrences only and performs no implicit catch-up.
