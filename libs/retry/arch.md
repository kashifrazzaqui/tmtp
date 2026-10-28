# Retry Library Architecture

## Design goal and boundary

Implement `spec.md` as a tier-0 ESM adapter over `p-retry@8.0.1`. The adapter owns generic orchestration and arithmetic; callers own retry classification, operation timeout/cancellation, and policy configuration.

The public API deliberately differs from raw `p-retry`: attempts include the first call, delays use symmetric bounded jitter, sleep and randomness are injectable, elapsed time is injectable, and original thrown values survive unchanged. No raw `p-retry` option or error type is re-exported.

## Internal decomposition

Keep these responsibilities private behind the package root:

- **Execution snapshot and guards:** validate options, copy scalar policy/dependency references, and reject invalid inputs before work begins.
- **Pure backoff calculator:** calculate capped exponential delay and symmetric jitter for a one-based failed-attempt number.
- **Operation-failure envelope:** privately carry arbitrary operation thrown values through `p-retry` without normalization.
- **Orchestration adapter:** translate the attempt budget and structural `Sleep` into `p-retry`, supply retry context, and enforce cancellation checkpoints.
- **Public entry:** export only `executeWithRetry` and the documented TypeScript types.

The backoff calculator should be a pure internal function tested through public delay observations. It does not need to become another package or public export.

## Why `p-retry` needs an adapter

Version 8.0.1 provides the sequential attempt loop, retry budget, and signal checks, but its native behavior conflicts with this package's contract in four ways:

1. It converts non-`Error` throws into `TypeError`.
2. It suppresses retries for most `TypeError` values even when `shouldRetry` would allow them.
3. Its delay timer uses global `setTimeout` and its randomizer uses global `Math.random`.
4. It measures its optional total retry time with global `performance.now()`.

The wrapper must contain all four behaviors. It must not expose `p-retry`'s `AbortError`, network-error detection, `maxRetryTime`, `randomize`, or native delay options as implicit policy.

## Execution setup

`executeWithRetry` performs synchronous validation inside its async execution boundary so callers always receive a Promise rejection. It then:

1. Copies the four policy values and all callback/source references into a local execution snapshot.
2. Applies `Math.random` and a `() => performance.now()` wrapper only when the corresponding source was omitted.
3. Checks `signal.throwIfAborted()` after validation and before reading the monotonic origin.
4. Reads and validates the initial monotonic value.
5. Calls `pRetry` with the translated options below.

Separate invocations hold separate attempt/source state. No policy, controller, timer, random generator, or context is stored at module scope.

## `p-retry` option translation

Use one `pRetry` call per execution with behavior equivalent to:

```ts
{
  retries: policy.maxAttempts - 1,
  factor: 1,
  minTimeout: 0,
  maxTimeout: 0,
  randomize: false,
  signal,
  shouldRetry: adapterShouldRetry
}
```

Leave `maxRetryTime` at infinity and do not enable `unref`. With both native timeout values at zero, `p-retry` performs no actual retry wait. The adapter's `shouldRetry` performs classification and the injected sleep before allowing the loop to continue. Thus the public sleeper is the only delay mechanism.

`p-retry` calls `shouldRetry` only while retry budget remains. This matches the contract that the classifier is not called on the final permitted failure. The adapter still performs its own signal check at entry to that callback.

## Original-error preservation

Wrap the public operation in an adapter input function. Catch both synchronous throws and asynchronous rejections and throw a private ordinary `Error` subclass, for example `OperationFailure`, containing a `reason: unknown` field.

This envelope is essential:

- It is always an `Error`, so `p-retry` does not normalize primitive throws.
- It is not a `TypeError`, so `p-retry` does not bypass the caller's classifier for operation `TypeError` values.
- It is not `p-retry`'s `AbortError`, so an operation error with that shape still receives ordinary caller classification.
- Its `reason` preserves exact object identity and primitive values for `RetryContext.error` and final rejection.

The outermost catch unwraps only this private envelope. If cancellation is observed at that checkpoint, the signal reason takes precedence as specified. Otherwise rethrow an envelope's `reason` unchanged; rethrow every other callback/source error unchanged. The class and envelope never escape the package.

Do not put caller callbacks inside this operation wrapper. A classifier, sleeper, random source, or monotonic failure must not be mistaken for an operation failure or become retryable.

## Attempt failure and sleep sequence

The adapter's `shouldRetry` receives `p-retry` context but uses only its one-based `attemptNumber`; its error is the private envelope. For each eligible failure:

1. Check the signal.
2. Read `monotonicNowMs`, validate it, and ensure it is not below the previous reading.
3. Build `{ attempt: attemptNumber, elapsedMs: current - start, error: envelope.reason }`.
4. Invoke the caller's classifier once and require an actual boolean.
5. Return `false` immediately for a non-retryable failure.
6. Check the signal, calculate the delay, and validate any random result used.
7. Await `sleep(delayMs, signal)` exactly once, including for zero.
8. Check the signal again and return `true` to permit the next attempt.

Because native `p-retry` delay is zero, step 7 is the complete inter-attempt delay. If classification, source access, or sleep fails, the adapter callback rejects and the outer catch propagates that failure without another operation call.

The public operation closes over any signal it needs. The adapter does not race a pending operation against abort: doing so would settle the wrapper while the operation continued in the background, creating misleading lifecycle semantics. Cancellation becomes observable when that operation or custom sleep cooperates/settles.

## Backoff implementation details

For failed attempt `n`:

- Special-case a zero base to produce a zero capped value at every exponent.
- Otherwise compute `base * 2 ** (n - 1)` and cap with `maxDelayMs`; positive overflow safely becomes the cap.
- Skip the random source entirely when `jitterRatio === 0`.
- With jitter enabled, draw once, require `0 <= r < 1`, apply `1 + ratio * (2 * r - 1)`, round with `Math.round`, and clamp to `0..maxDelayMs`.

The pre-jitter cap avoids overflow-driven `NaN`; the post-jitter cap enforces the public hard maximum. `Number.isSafeInteger` policy validation and the `2^31 - 1` delay bound ensure the value passed to `systemSleep` is directly valid.

No random value is embedded in `RetryContext`, and no delay history is retained after the sleep call. Tests observe the sequence through the injected sleeper.

## Cancellation and settlement

Use native `signal.throwIfAborted()` where available so the exact reason propagates. The outer catch checks an aborted signal before unwrapping/propagating another outcome, providing a final cancellation checkpoint for races at operation or classifier settlement.

This gives deterministic priority once cancellation is observed without claiming instantaneous cancellation of arbitrary Promises. There is no module-level abort listener. The only long-lived abort listener belongs to the injected sleep, whose contract requires cleanup.

Do not convert reasons to `DOMException` or `AbortError`. A caller can abort with an `Error`, string, object, or other JavaScript value and receives that same value.

## Dependency use

- Runtime dependency: exact workspace catalog version `p-retry@8.0.1`.
- Node runtime: `performance.now()`, `Math.random()`, and standard `AbortSignal` behavior.
- Internal dependencies: none, including type-only imports. `Sleep` is declared locally and is structurally compatible with `@tmtp/clock`.

`is-network-error` is a transitive implementation detail of `p-retry`, not a direct dependency or classification feature of this package. Private operation envelopes prevent its `TypeError` exception rules from deciding public retry behavior.

## Trade-offs

- **Adapter over `p-retry` versus a hand-written loop:** the adapter retains a small, reviewed sequential retry engine but needs private envelopes and zero native delays to override unwanted defaults. A future major-version upgrade requires rerunning the compatibility suite against these behaviors.
- **Injected sleep inside `shouldRetry`:** this is slightly unconventional, but in 8.0.1 it runs after the retry-budget check and before the next attempt. It prevents sleeping for non-retryable/final failures and avoids global timers.
- **Capping before and after jitter:** this guarantees a hard maximum and safe arithmetic but creates additional probability mass at the cap. It does not promise a statistically uniform backoff distribution.
- **Symmetric jitter rather than `p-retry` randomize:** symmetric jitter can lower or raise the base delay and supports full decorrelation at ratio 1; it differs from the dependency's native `[1, 2)` multiplier.
- **No total deadline:** callers must compose operation timeouts or an overall abort signal. Attempt count alone cannot bound a hung operation.
- **No abort race around operation:** cancellation can wait for a non-cooperative operation, but the wrapper never reports completion while silently leaving a new attempt running.
- **Local structural `Sleep`:** a small type duplication preserves tier 0 and avoids a clock dependency solely for a function signature.

## Testing seams and verification design

Test exclusively through `executeWithRetry`; do not export the envelope, delay calculator, or adapter callback for tests.

### Deterministic harness

Use:

- an operation script of values and thrown/rejected values, including synchronous throws and primitives;
- a classifier journal capturing contexts and scripted decisions;
- a fake sleeper recording delay/signal pairs, advancing fake monotonic time, and supporting abort scripts;
- a queued random source with call counts and invalid-output cases;
- a queued monotonic source with exact fractional readings and backward/invalid cases.

Attach Promise assertions before resolving fake sleeps to avoid unhandled rejections. Never use real retry delays in the unit suite.

### Compatibility and contract suites

- Prove attempt/sleep counts, strict sequence, no initial/final sleep, and exhaustion behavior.
- Prove original-value identity across success, non-retryable failure, final failure, `TypeError`, and non-`Error` throws. These tests guard the `p-retry` adapter specifically.
- Prove exact formula examples, caps, zero delay, random call counts, and no hidden second timer.
- Prove elapsed snapshots include fake operation/sleep durations and reject backward source readings.
- Prove pre-abort, sleep-abort, operation-settlement abort priority, exact reason identity, and no later attempt.
- Prove classifier/sleeper/source errors are not fed back into the retry loop.
- Prove invalid policy/source setup performs no work and concurrent executions keep isolated state.

A minimal integration test may compose `@tmtp/clock`'s structural `systemSleep` in a higher-level consumer test, but `retry` itself must not import `clock` or add that dependency to its manifest.
