# Job Queue Library Spec

## Purpose and responsibility
Persist background work in SQLite with deduplication, delayed execution, transactional leases, bounded retries, and restart recovery. Handlers are at-least-once and must be idempotent.

## Public interface / API surface
```ts
export interface JobEnqueue {
  kind: string;
  payload: unknown;
  payloadSchemaVersion: number;
  dedupeKey?: string;
  runAfter: string;
}

export interface JobQueueOptions {
  database: import("@tmtp/database").Database;
  clock: import("@tmtp/clock").Clock;
  leaseMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  batchSize: number;
}

export interface JobQueue {
  enqueue(job: JobEnqueue): import("@tmtp/domain").Job;
  claim(kinds: string[], now: string): import("@tmtp/domain").Job | undefined;
  complete(jobId: string, leaseToken: string): void;
  fail(jobId: string, leaseToken: string, error: unknown): void;
  recoverExpired(now: string): number;
  list(options: { status?: string; limit: number }): import("@tmtp/domain").Job[];
}

export function createJobQueue(options: JobQueueOptions): JobQueue;
export const jobQueueMigrations: import("@tmtp/database").Migration[];
```

Claim, completion, failure, and lease recovery are database transactions. External side effects are outside those transactions and require separate reconciliation.

## Internal subcomponents
- SQL migrations and dedupe indexes.
- Lease claim/recovery state machine.
- Backoff and terminal-failure policy.

## Dependencies on other libs
- `clock`
- `database`
- `domain`

## New build or OSS wrapper
New build over the shared SQLite database; no external queue service.

## Hosted by
`services/personal-reader` background worker loop.

## Configuration
- `jobs.poll_interval_ms` — **optional**, default `1000`.
- `jobs.lease_ms` — **optional**, default `120000`.
- `jobs.max_attempts` — **optional**, default `5`.
- `jobs.backoff_base_ms` — **optional**, default `1000`.
- `jobs.backoff_max_ms` — **optional**, default `300000`.
- `jobs.batch_size` — **optional**, default `20`.
