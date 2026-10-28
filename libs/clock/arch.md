# Clock Library Architecture

## Design goal and boundary

Implement the contract in `spec.md` as a small tier-0 ESM package. Keep wall time, monotonic time, and waiting as separate mechanisms behind one public entry point. No other workspace package is imported, including with `import type`.

The package has no configuration object, global mutable clock, singleton fixed clock, or timer registry. The only shared runtime values are the stateless `systemClock` and the stateless `systemSleep` function.

## Internal decomposition

A minimal implementation can use these internal modules without exporting them as package subpaths:

- **Public entry:** exports `Clock`, `Sleep`, and `FixedClock` types plus the three runtime values.
- **System adapter:** constructs fresh dates, reads `performance.now()`, and implements cancellable timer sleep.
- **Fixed adapter:** validates constructor/advance input and owns the state of each fixed clock.
- **Numeric guards:** shared local predicates for safe integer delays and valid fixed-clock transitions. Keep these private rather than creating a general utility package.

The decomposition is organizational, not additional API surface. A single source module is also acceptable while the same responsibilities and tests remain clear.

## System clock algorithm

### Wall time

Call `new Date()` for every `now()` invocation. Do not cache a date or return a shared mutable object.

### Monotonic time

Use `performance.now()` from `node:perf_hooks` (or the equivalent Node global) on every invocation. Return the reading directly: no epoch offset, rounding, persistence, or synchronization with wall time.

This satisfies elapsed-time measurement under wall-clock corrections. It deliberately gives no absolute-time meaning to the result.

### Cancellable sleep

`systemSleep` is an async-capability boundary, so input validation and cancellation both produce Promise rejection rather than synchronous throws.

For each call:

1. Validate the safe-integer range `0..2_147_483_647` before inspecting the signal.
2. Reject an already-aborted signal with its exact `reason` before allocating resources.
3. Create one Promise and one referenced `setTimeout`, including for a zero delay.
4. Register at most one `{ once: true }` abort listener when a signal exists.
5. On timer fire, remove the listener and fulfill with `undefined`.
6. On abort, clear the timeout, remove the listener, and reject with the exact reason.
7. Guard settlement and cleanup so only the first event has an effect. A post-registration abort check can close the setup race without changing the contract.

Do not implement sleep by polling `Date.now()`, chaining short timers, or compensating for event-loop delay. Node timers already provide the required interval semantics. Do not call `unref()`; doing so would let an otherwise idle process exit before a requested delay completes.

## Fixed clock algorithm

Each instance closes over two numeric fields:

- `wallTimeMs`, initialized from a cloned valid input date's epoch milliseconds;
- `monotonicTimeMs`, initialized to zero.

`now()` constructs a new `Date(wallTimeMs)`. `monotonicNowMs()` returns `monotonicTimeMs`.

`advance(ms)` first validates the increment and computes both candidate values. Commit only if:

- `ms` is a non-negative safe integer;
- the candidate wall value passes JavaScript `Date` validity/TimeClip limits; and
- the candidate monotonic value is a safe integer.

Compute before assigning either field so overflow cannot leave wall and monotonic time disagreeing. Dates handed to callers are snapshots and need no defensive copying beyond constructing a new object per call.

The fixed clock intentionally has no `set`, backward advance, sleep queue, or automatic task runner. Those features would create a virtual-time scheduler with ordering and cancellation rules beyond this package's required surface. Tests compose this clock with a purpose-built fake `Sleep` instead.

## Dependency use

- Node `Date`, `setTimeout`, `clearTimeout`, `AbortSignal`, and monotonic `performance.now()` are the complete runtime basis.
- No third-party runtime dependency is needed.
- No import from `retry` or any other internal package is permitted. Structural typing lets `retry` accept `systemSleep` while both remain tier 0.

## Trade-offs

- **Separate wall and monotonic readings:** callers must choose the correct time domain, but cannot accidentally treat an elapsed-time reading as a timestamp.
- **Fresh `Date` objects:** a small allocation cost prevents mutation bugs across consumers.
- **Forward-only fixed time:** less flexible than a general fake timer, but deterministic and sufficient for domain tests without patching globals.
- **No virtual sleep attached to `FixedClock`:** deterministic delay tests need a second injected fake, while the clock package avoids owning task ordering and promise scheduling.
- **Single-timer upper bound:** delays above roughly 24.8 days are rejected instead of being silently shortened by Node. Longer scheduling belongs to a scheduler that can persist and re-evaluate deadlines.
- **Referenced timers:** a pending sleep can hold the process open, which favors predictable completion. Shutdown code must abort its sleeps.
- **Real timers plus fake-timer tests:** system timing behavior remains integrated with Node while tests avoid real waits.

## Testing seams and verification design

All behavior is tested through the public package root. No private hooks are exported.

### Deterministic suites

- Use `createFixedClock` for date identity, snapshot isolation, initial monotonic origin, joint advancement, overflow atomicity, and instance isolation.
- Use Vitest fake timers for `systemSleep`; capture the Promise before advancing time and attach rejection handlers before triggering aborts.
- Use custom objects as abort reasons to assert identity rather than only error names/messages.
- Use fake-timer pending counts to check timer cleanup. Where listener cleanup cannot be observed portably, verify it through repeated settle/abort cycles and implementation review rather than adding a test-only export.
- Use scripted invalid inputs to prove validation occurs before timer creation and before the abort check.

### Minimal system integration checks

- Assert that two system monotonic readings are finite and ordered.
- Assert that system wall time returns valid independent dates.
- Use one short real sleep only as a smoke test with a generous lower/upper tolerance; do not encode scheduler precision as a contract test.

Retry tests must not use real sleeps. They inject a scripted structural `Sleep` and advance their own monotonic source explicitly.
