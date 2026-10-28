# Retry Library Spec

## Purpose and responsibility
Execute asynchronous operations under explicit bounded retry, delay, jitter, and cancellation policies. It does not decide which domain errors are retryable.

## Public interface / API surface
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

export function executeWithRetry<T>(options: {
  operation: () => Promise<T>;
  policy: RetryPolicy;
  shouldRetry: (context: RetryContext) => boolean;
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}): Promise<T>;
```

The implementation uses an injected `Sleep` contract but has no runtime import from `clock`; callers provide it.

## Internal subcomponents
- Backoff calculation with bounded jitter.
- Attempt/cancellation orchestration.

## Dependencies on other libs
None. The `Sleep` type is structurally typed at implementation time to avoid a runtime dependency.

## New build or OSS wrapper
New policy wrapper around `p-retry` `8.0.1`.

## Hosted by
`http-client`, job adapters, and `services/personal-reader` in process.

## Configuration
None globally. Every caller supplies a policy from its own namespaced configuration keys.
