# Scheduler Library Spec

## Purpose and responsibility
Register named periodic tasks, prevent overrun, and provide deterministic lifecycle control. It does not make work durable; tasks enqueue or resume durable jobs.

## Public interface / API surface
```ts
export interface ScheduledTask {
  name: string;
  expression: string;
  timezone: string;
  overrunProtection: boolean;
  run: () => Promise<void>;
}

export interface Scheduler {
  register(task: ScheduledTask): void;
  start(): void;
  stop(): Promise<void>;
}

export function createScheduler(options: {
  clock: import("@tmtp/clock").Clock;
  logger: import("@tmtp/logging").Logger;
}): Scheduler;
```

The service compares durable last-run records with schedule policy during startup. Cron definitions are recreated on restart; missed work is recovered through `reader-store` and `job-queue`, never through hidden scheduler catch-up.

## Internal subcomponents
- Croner schedule adapter.
- Named-task registry and overlap guard.
- Structured task outcome logging and shutdown.

## Dependencies on other libs
- `clock`
- `logging`

## New build or OSS wrapper
New wrapper around Croner `11.0.0`.

## Hosted by
`services/personal-reader` lifecycle.

## Configuration
- `scheduler.timezone` — **optional**, default `UTC`.
- `scheduler.overrun_protection` — **optional**, default `true`.
