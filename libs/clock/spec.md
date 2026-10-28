# Clock Library Spec

## Purpose and responsibility
Provide wall-clock and monotonic time, cancellation-aware sleeping, and deterministic test clocks without leaking global time calls into domain logic.

## Public interface / API surface
```ts
export interface Clock {
  now(): Date;
  monotonicNowMs(): number;
}

export interface Sleep {
  (delayMs: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock;
export const systemSleep: Sleep;
export function createFixedClock(initial: Date): Clock & { advance(ms: number): void };
```

`Clock.now()` returns a new `Date` on every call. Monotonic values are used only for elapsed-time measurement, never persisted timestamps.

## Internal subcomponents
None. System and deterministic implementations are small variants of one contract.

## Dependencies on other libs
None.

## New build or OSS wrapper
New narrow build over the Node runtime; no third-party dependency.

## Hosted by
`services/personal-reader` in process; pure consumers may also use it in tests and scripts.

## Configuration
None. Time zones belong to schedule definitions, not this primitive.
