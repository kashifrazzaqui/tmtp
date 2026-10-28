# Clock Library Spec

## Purpose and responsibility

Provide wall-clock time, monotonic elapsed time, cancellation-aware sleeping, and a deterministic clock for tests. Consumers inject these capabilities instead of calling global time APIs in domain logic.

The package owns only time primitives. It does not own schedules, time zones, timeouts, retry policy, persistence formats, or process lifecycle.

## Public interface / API surface

The package root is `@tmtp/clock`. It has no default export or subpath exports.

```ts
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

export const systemClock: Clock;
export const systemSleep: Sleep;

export function createFixedClock(initial: Date): FixedClock;
```

Runtime exports are exactly `systemClock`, `systemSleep`, and `createFixedClock`. Type exports are exactly `Clock`, `Sleep`, and `FixedClock`. No global timers, `Date`, `performance`, or abort controllers are replaced or patched.

## Time contracts

### Wall-clock time

- `systemClock.now()` returns the current system wall-clock time as a new, valid `Date`.
- Every `Clock.now()` call returns a new object. Mutating a returned date never changes the clock, later results, or previously returned dates.
- Wall-clock time can move backward or forward when the system clock changes. Consumers must not use it to measure elapsed time.
- Consumers that persist timestamps convert the returned date to the system-wide ISO-8601 UTC representation. `Clock` does not format timestamps.

### Monotonic time

- `systemClock.monotonicNowMs()` returns a finite, non-negative number of milliseconds from Node's monotonic clock. Fractional milliseconds are allowed.
- The origin is arbitrary and process-local. Only a difference between two readings from the same clock instance is meaningful.
- Monotonic readings never move backward and are unaffected by wall-clock adjustments.
- A monotonic value must never be persisted, converted to a `Date`, compared with an epoch timestamp, or shared as an absolute timestamp.
- Elapsed time is `Math.max(0, end - start)` only when both readings come from the same clock. A conforming clock already makes the difference non-negative.

The two readings are independent: a wall-clock adjustment does not change monotonic time, and advancing a fixed clock changes both only because that test clock explicitly shares one advance operation.

## Sleep contract

`systemSleep` returns a Promise and never throws synchronously. Validation failures become rejected Promises.

### Delay validation

- `delayMs` must be a number, a safe integer, and in the inclusive range `0..2_147_483_647` (`2^31 - 1`, Node's maximum single timer delay).
- A non-number rejects with `TypeError`. `NaN`, infinity, a negative value, a fraction, an unsafe integer, or a value above the maximum rejects with `RangeError`.
- Delay validation happens before the abort check. If both the delay and signal are invalid/aborted, the delay error wins.
- The upper bound prevents Node from silently converting an overflowing timeout into a short delay. Retry and scheduling policies that use `systemSleep` must honor the same bound.

### Completion and timing

- Every valid, non-aborted sleep, including `systemSleep(0)`, schedules a timer. There is no synchronous completion fast path.
- The Promise fulfills with `undefined` after the timer fires. Event-loop load can make the actual wait longer; the contract does not promise real-time precision.
- The timer uses runtime timer semantics, not `Date.now()`, so wall-clock changes do not alter the requested interval.
- The timer remains referenced: an otherwise idle Node process stays alive until the sleep settles. `systemSleep` does not call `unref()`.
- Each invocation owns an independent timer and, when supplied, an independent abort listener.

### Cancellation

- If `signal` is already aborted after validation, no timer or listener is created and the Promise rejects with `signal.reason`.
- If the signal aborts while the timer is pending, the implementation clears the timer, removes its abort listener, and rejects with the exact `signal.reason` value. Reasons are not wrapped, converted to `AbortError`, or replaced.
- Aborting after fulfillment has no effect. Aborting after a previous rejection also has no effect.
- Normal completion removes the abort listener. Every settlement path leaves no timer or listener behind.
- When timer completion and abortion are both pending, the operation whose callback settles the Promise first determines the result; later events are ignored.
- `systemSleep` does not create an `AbortController`, abort the caller, or cancel unrelated work.

## Deterministic fixed clock

`createFixedClock(initial)` creates an isolated mutable test clock.

- `initial` must be a `Date`; another runtime type throws `TypeError`. An invalid `Date` throws `RangeError`.
- The constructor snapshots `initial.getTime()`. Later mutation of `initial` does not affect the fixed clock.
- The initial wall-clock value is the supplied epoch milliseconds. The initial monotonic reading is exactly `0`.
- While no advance occurs, `now()` returns equal but distinct dates and `monotonicNowMs()` remains constant.
- `advance(ms)` accepts only a non-negative safe integer. A non-number throws `TypeError`; `NaN`, infinity, a negative value, a fraction, or an unsafe integer throws `RangeError`.
- A valid advance atomically adds `ms` to both wall-clock epoch milliseconds and monotonic milliseconds. `advance(0)` is a no-op.
- An advance that would produce an invalid `Date` or make monotonic time exceed `Number.MAX_SAFE_INTEGER` throws `RangeError` and changes neither reading.
- Backward movement is not supported. Tests that need another timeline create another fixed clock.
- Separate fixed clock instances do not share state.

A fixed clock does **not** control `systemSleep`, global timers, `Date`, or `performance`. Consumers that need deterministic waiting must also inject a fake `Sleep`; advancing a `FixedClock` alone never completes a sleep.

## Consumer and composition rules

- Production composition uses `systemClock` and, where waiting is needed, `systemSleep`.
- Tests use `createFixedClock` for timestamps and elapsed-time logic, plus a separately controlled `Sleep` where delays are involved.
- Consumers accept the narrowest capability they need. A timestamp-only consumer accepts `Clock`; a retry implementation can accept a structurally compatible `Sleep` without importing this package.
- Callers own cancellation scopes and pass the same signal to sleep and to the in-flight operation whose work they want to cancel.
- No consumer assumes that monotonic readings from different clock instances share an origin.

## Invariants

1. Every `now()` result is an independent valid `Date`.
2. Monotonic time from one instance is finite and non-decreasing.
3. A fixed clock changes only through `advance`, and each successful advance preserves `wallDeltaMs === monotonicDeltaMs` from construction.
4. A pending system sleep has exactly one timer and at most one abort listener; a settled sleep has neither.
5. Cancellation rejects with the original abort reason and never produces a later fulfillment.
6. Invalid input never creates a timer or mutates fixed-clock state.

## Test expectations

Tests use the public API only. Vitest fake timers control `systemSleep` tests; fixed-clock tests need no global mocks. At minimum, cover:

- `should return independent dates with the current fixed value when now is called repeatedly`.
- `should snapshot the constructor date and returned dates when callers mutate them`.
- `should start fixed monotonic time at zero and advance wall and monotonic time together`.
- `should reject backward, fractional, non-finite, unsafe, and overflowing advances without changing either reading`.
- `should keep separate fixed clock instances independent`.
- `should fulfill systemSleep with undefined after the requested fake-timer delay`, including zero delay.
- `should not settle systemSleep before its timer fires`.
- `should reject immediately with the identical reason when the signal is already aborted`.
- `should clear a pending sleep and reject with the identical reason when aborted`.
- `should ignore aborts and timer callbacks after settlement`.
- `should remove listeners and pending timers on both fulfillment and abortion`.
- `should reject invalid delays before observing an aborted signal`.
- `should keep independent sleeps independent when one is aborted`.
- A small real-timer smoke test can establish Node integration, but correctness tests must not depend on wall-clock sleeps or tight timing tolerances.

## Internal subcomponents

- System wall/monotonic adapter and cancellable timer sleep.
- Forward-only fixed-clock state.

These are implementation details; only the API above is public.

## Dependencies on other libs

None. This package is tier 0 and has no internal runtime or type-only dependencies.

## New build or OSS wrapper

New narrow build over the Node runtime; no third-party dependency.

## Hosted by

`services/personal-reader` in process; pure consumers may also use it in tests and scripts.

## Configuration

None. Time zones belong to schedule definitions, retry delays belong to their callers, and this primitive owns no configuration keys or defaults.
