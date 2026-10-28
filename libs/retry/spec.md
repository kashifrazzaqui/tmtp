# Retry Library Spec

## Purpose and responsibility

Execute one asynchronous operation under an explicit bounded attempt, backoff, jitter, and cancellation policy. The caller decides which failures are retryable. The package supplies orchestration only: no domain error classification, response handling, logging, persistence, timeout, or overall deadline.

## Public interface / API surface

The package root is `@tmtp/retry`. It has no default export or subpath exports.

```ts
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

export function executeWithRetry<T>(options: RetryOptions<T>): Promise<T>;
```

The only runtime export is `executeWithRetry`. Type exports are exactly `RetryPolicy`, `RetryContext`, `Sleep`, `RandomSource`, `MonotonicSource`, and `RetryOptions`.

`Sleep` is intentionally structural and matches `@tmtp/clock`'s `Sleep`; there is no runtime or type-only import from `clock`. `random` defaults to `Math.random`. `monotonicNowMs` defaults to a function returning Node's `performance.now()`. There are no default retry-policy values.

All failures, including option validation failures, are Promise rejections. `executeWithRetry` does not throw synchronously.

## Option validation and source contracts

Validation occurs once, before the initial cancellation check, clock read, random draw, operation call, or sleep. Invalid options therefore cannot run user work. If options are invalid and the signal is already aborted, the validation error wins.

### Policy

- `maxAttempts` is a safe integer greater than or equal to `1`. It counts the initial attempt plus all retries; `Infinity` is not supported.
- `baseDelayMs` and `maxDelayMs` are safe integers in the inclusive range `0..2_147_483_647` (`2^31 - 1`). This matches the `systemSleep` single-timer bound.
- `baseDelayMs <= maxDelayMs`.
- `jitterRatio` is a finite number in the inclusive range `0..1`. Fractions are allowed.
- A non-number policy field throws a rejected `TypeError`; a number outside its finite/integer/range constraints rejects with `RangeError`.
- The options and policy objects are read but never mutated. Later caller mutation does not change an execution: the implementation snapshots scalar policy values and dependency references during validation.

### Functions

- `operation`, `shouldRetry`, and `sleep` are required functions. Supplied `random` and `monotonicNowMs` values must also be functions. A violation rejects with `TypeError` before execution.
- `shouldRetry` is synchronous and returns a boolean. Any other runtime return value rejects with `TypeError`; a Promise is not awaited and is invalid.
- `operation` is typed as returning `Promise<T>`. A synchronous throw is treated exactly like a returned Promise rejection.
- A conforming `Sleep` follows the clock package's contract: it validates its delay, rejects with the identical abort reason, and cleans up its timer/listener. `executeWithRetry` relies on that cooperation while waiting.
- `random()` returns a finite number in the half-open interval `[0, 1)`. An invalid result rejects with `RangeError`. A value thrown by the source is not an operation failure and is never retried. The source is synchronous; a returned Promise is invalid.
- `monotonicNowMs()` returns a finite, non-negative number. Successive readings within one execution are non-decreasing. A negative, non-finite, or backward reading rejects with `RangeError`. A thrown value propagates unchanged and is not retried. Fractional milliseconds are allowed.

`random` and `monotonicNowMs` are dependency-injection seams, not global mocks. Separate executions do not share attempt, elapsed-time, or jitter state; shared source objects can of course have their own state.

## Attempt and result semantics

1. Validate and snapshot options, then reject immediately if `signal` is already aborted.
2. Read the monotonic source once to establish the execution's elapsed-time origin.
3. Invoke attempt 1 immediately. There is no initial sleep.
4. After a failed attempt with retry budget remaining and no observed cancellation, call `shouldRetry` once with that failure's context.
5. If it returns `false`, reject with the original failure. If it returns `true`, compute one delay and call `sleep` exactly once, including when the delay is zero.
6. After a successful sleep and another cancellation check, invoke the next attempt immediately.
7. Return the first successful operation value. A later abort cannot change an already-settled execution.

Additional rules:

- Attempts are strictly sequential and one-based. At most `policy.maxAttempts` operation calls occur, and at most `maxAttempts - 1` sleeps occur.
- `maxAttempts = 1` permits one operation call, no `shouldRetry` call, no random draw, and no sleep.
- `shouldRetry` is not called for success, a pre-aborted execution, an observed cancellation, or the final permitted failure. Exhaustion rejects directly with the final operation failure.
- There is no delay after success, a non-retryable failure, exhaustion, or cancellation.
- The operation receives no attempt argument or signal argument. A consumer that needs either closes over its own state and the same `AbortSignal` passed to `executeWithRetry`.
- The wrapper never starts concurrent attempts and never invokes the operation after its returned Promise has settled.

## Retry context and elapsed time

For a failed attempt `n` that can still retry:

- `context.attempt` is exactly `n`, starting at `1`.
- `context.error` is the exact value thrown by the operation or used to reject its Promise. Object identity and primitive values are preserved, including `TypeError`, strings, `null`, and `undefined`.
- `context.elapsedMs` is `currentMonotonicMs - initialMonotonicMs`, read when the wrapper handles that failure and before `shouldRetry` runs. It is finite and non-negative and is not rounded.
- Elapsed time includes previous operation durations and retry sleeps. It excludes time spent in the current `shouldRetry` callback, delay calculation, and any later work; later contexts naturally include that earlier work.
- Each context is a snapshot for one failure. Changing it does not alter the policy or internal attempt state.

Elapsed time is diagnostic input for `shouldRetry`, not an implicit time budget. This package has no `maxRetryTime` or total timeout. A caller that needs a total deadline applies its own timeout/abort policy.

## Backoff and jitter algorithm

A delay is calculated only after a failed attempt `n`, where `1 <= n < maxAttempts`, has been classified as retryable. That delay precedes attempt `n + 1`.

First calculate the capped exponential value in milliseconds:

```text
u(n) = min(maxDelayMs, baseDelayMs × 2^(n - 1))
```

For `baseDelayMs = 0`, define `u(n) = 0` for every attempt rather than evaluating `0 × Infinity` at large exponents. Overflow of a positive exponential intermediate to `Infinity` is harmless because the value is capped.

Then apply symmetric bounded jitter:

- If `jitterRatio = 0`, do not call `random`; the delay is `round(u(n))` (already an integer after the cap).
- Otherwise call `random` exactly once for this retry to obtain `r`, even when `u(n) = 0`, and calculate:

```text
multiplier = 1 + jitterRatio × (2r - 1)
delayMs = min(maxDelayMs, max(0, round(u(n) × multiplier)))
```

`round` is JavaScript `Math.round`. The result is always an integer in `0..maxDelayMs`. The multiplier lies in `[1 - jitterRatio, 1 + jitterRatio)` before rounding. Because `r < 1`, the continuous upper bound is exclusive, although rounding can produce the inclusive integer endpoint.

Capping the exponential before jitter and capping the final delay after jitter guarantees the hard maximum. Values at the cap can accumulate at `maxDelayMs`; this is an accepted distribution trade-off, not a uniform-distribution promise.

Examples with no jitter and `baseDelayMs = 100`, `maxDelayMs = 250`:

| Failed attempt | Delay before next attempt |
|---|---:|
| 1 | 100 ms |
| 2 | 200 ms |
| 3 | 250 ms |
| 4 and later | 250 ms |

With `u(n) = 100` and `jitterRatio = 0.2`, random values `0`, `0.5`, and `0.75` produce delays of `80`, `100`, and `110` ms respectively. With jitter disabled, a supplied random source is never observed.

The wrapper passes the calculated integer and the original `signal` object (or `undefined`) to `sleep` unchanged. It does not add a second hidden delay.

## Failure and error semantics

| Situation | Result |
|---|---|
| Operation succeeds | Fulfill with its exact value, including `undefined` |
| Operation fails and classifier returns `false` | Reject with the original thrown/rejection value |
| Operation exhausts the attempt budget | Reject with the final original thrown/rejection value |
| `shouldRetry` throws or returns a non-boolean | Abort execution; propagate the thrown value or `TypeError`; no sleep or next attempt |
| `sleep` throws/rejects | Abort execution; propagate that exact value; no next attempt |
| Random/monotonic source fails or returns invalid data | Abort execution; propagate that failure/validation error; no next attempt |
| Caller signal is aborted | Reject with the exact `signal.reason` once cancellation can be observed |

The library does not normalize non-`Error` operation failures, attach a new `cause`, wrap the final error, or replace operation errors with a retry-exhausted error. In particular, `p-retry` error classes and its special `TypeError` behavior are not part of this public contract.

Errors thrown by the classifier, sleeper, random source, or monotonic source are infrastructure/callback failures, not new operation attempts. They are not passed to `shouldRetry` and are not retried.

## Cancellation semantics

- After validation, an already-aborted signal rejects with its exact reason before any source or user operation is called.
- Cancellation is checked before retry classification, before each new attempt, after an operation settles, and after each sleep. Once observed, it wins over the operation/classifier outcome and rejects with the identical reason.
- Aborting during a conforming sleep stops that sleep and prevents another attempt. No retry delay timer owned by `p-retry` remains active.
- Aborting while `operation`, `shouldRetry`, `random`, `monotonicNowMs`, or a non-conforming custom `sleep` is running cannot forcibly stop that callback or Promise. The wrapper waits for the in-flight operation/custom wait to settle before it can observe cancellation.
- The operation opts into prompt cancellation by closing over and honoring the same signal. The retry wrapper does not create a linked controller or race the operation with an abort Promise.
- No further attempt, classifier call, random draw, or sleep begins after cancellation has been observed. An abort after fulfillment or rejection has no effect.

## Invariants

1. Total operation calls are in `1..maxAttempts`; total sleeps never exceed operation calls minus one.
2. Attempt numbers increase by one and no attempts overlap.
3. Every operation failure visible to `shouldRetry` and every terminal operation rejection preserve the original value.
4. Every approved retry causes exactly one injected sleep with the calculated delay and original signal; every delay is an integer within the configured maximum.
5. Jitter is the only random behavior. With jitter disabled, random is untouched.
6. All elapsed readings come from one injected monotonic source per execution and never use wall time.
7. Cancellation and callback/source failures never consume another attempt.
8. The wrapper adds no global state, configuration, logging, timers, or hidden retry classification.

## Deterministic testing and test expectations

Tests inject a scripted `sleep`, `random`, and `monotonicNowMs`; they never wait on real timers. A useful fake sleep records `(delayMs, signal)`, advances the fake monotonic value by the delay, and then applies a scripted completion or abort. Tests control source readings explicitly rather than relying on fake wall-clock dates.

At minimum, cover these public behaviors:

- `should return the first successful value without calling classifier sleeper or random`.
- `should retry sequentially until success and count the initial call in maxAttempts`.
- `should make no classifier random or sleep call when maxAttempts is one`.
- `should preserve object identity and primitive operation failures for context and final rejection`, including `TypeError` and non-`Error` values.
- `should stop with the original failure when shouldRetry returns false`.
- `should stop with the final original failure when attempts are exhausted`.
- `should pass one-based attempt numbers and monotonic elapsed snapshots that include prior fake sleeps`.
- `should produce 100 200 250 250 delays for the documented exponential example`.
- `should produce deterministic symmetric jitter for scripted random values and enforce both zero and maximum bounds`.
- `should draw random exactly once per approved retry when jitter is enabled and never when disabled`.
- `should call sleep once with zero delay when an approved retry calculates zero`.
- `should pass the identical signal to every sleep and introduce no additional delay`.
- `should reject with the identical pre-abort reason without reading sources or invoking work`.
- `should reject with the identical reason and prevent another attempt when aborted during sleep`.
- `should wait for a non-cooperative in-flight operation before observing abort`, then prefer the abort reason over its result.
- `should propagate classifier sleeper random and monotonic failures without retrying them`.
- `should reject invalid policies and callback/source results before or at their documented use without partially running work`.
- `should snapshot options and isolate concurrent executions`.
- `should not read or mutate global Math.random Date or timers when all deterministic sources are injected`.

## Internal subcomponents

- Option/policy validation and immutable execution snapshot.
- `p-retry` compatibility adapter and original-error preservation.
- Attempt/cancellation orchestration and monotonic context creation.
- Pure capped exponential backoff and bounded-jitter calculation.

These are private implementation details; only the API above is public.

## Dependencies on other libs

None. This package is tier 0 and has no internal runtime or type-only dependencies. The structural `Sleep` contract avoids a dependency on `clock`.

## New build or OSS wrapper

New policy wrapper around `p-retry` `8.0.1`; its built-in timer, jitter, error normalization, and domain-specific retry suppression are deliberately adapted rather than exposed.

## Hosted by

`http-client`, job adapters, and `services/personal-reader` in process. Durable job scheduling remains owned by `job-queue`; this package does not replace it.

## Configuration

None globally. Every caller supplies a policy from its own namespaced configuration keys. Existing owners and defaults are unchanged: for example, `http.retry.*` belongs to `http-client`, while `jobs.*` belongs to `job-queue`. Random and monotonic sources are dependency-injection/test concerns, not configuration keys.
