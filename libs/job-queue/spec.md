# Job Queue Library Spec

## Purpose and responsibility

Persist background work in SQLite with validated versioned payloads, active-work deduplication, delayed execution, transactional leases, lease renewal, bounded retries, and restart recovery. Handlers run outside database transactions, are at-least-once, and must make logical effects idempotent.

## Public interface / API surface

### Payload registration

```ts
export interface JobPayloadCodec {
  kind: string;
  currentVersion: number; // integer >= 1
  decode(payload: unknown, sourceVersion: number): unknown;
}

export interface JobEnqueue {
  kind: string;
  payload: unknown;
  payloadSchemaVersion: number;
  dedupeKey?: string;
  runAfter: string; // domain ISO timestamp
}

export interface JobEnqueueResult {
  job: import("@tmtp/domain").Job;
  inserted: boolean;
}

export interface JobFailure {
  code: string;
  message: string; // safe, bounded diagnostic text
  retryable: boolean;
}

export type JobQueueErrorCode =
  | "unknown-kind"
  | "invalid-payload"
  | "unsupported-payload-version"
  | "job-not-found"
  | "lease-lost"
  | "invalid-transition";

export class JobQueueError extends Error {
  readonly name: "JobQueueError";
  readonly code: JobQueueErrorCode;
  readonly kind?: string;
  readonly jobId?: string;
  readonly cause?: unknown;
}
```

Each registered `kind` has exactly one codec. `decode` validates the source envelope, migrates older supported versions to `currentVersion`, validates the current payload, and returns the parsed current payload. It throws only safe errors; payload data is never included in messages. Unknown future versions are rejected rather than guessed.

### Queue operations

```ts
export interface JobQueueOptions {
  database: import("@tmtp/database").Database;
  clock: import("@tmtp/clock").Clock;
  codecs: readonly JobPayloadCodec[];
  leaseMs: number; // integer >= 1000
  maxAttempts: number; // integer >= 1
  backoffBaseMs: number; // integer >= 0
  backoffMaxMs: number; // integer >= backoffBaseMs
  batchSize: number; // integer >= 1; maximum rows per bounded operation
}

export interface JobListQuery {
  status?: import("@tmtp/domain").JobStatus;
  kind?: string;
  after?: JobCursorPosition;
  limit: number; // 1..options.batchSize
}

export interface JobCursorPosition {
  createdAt: string;
  id: string;
}

export interface DiagnosticJobCursor {
  occurredAt: string;
  id: string; // synthetic source-prefixed ID, including "job:"
}

export interface JobQueue {
  enqueue(job: JobEnqueue): JobEnqueueResult;
  get(jobId: string): import("@tmtp/domain").Job | undefined;
  claim(kinds: readonly string[]): import("@tmtp/domain").Job | undefined;
  renew(jobId: string, leaseToken: string): import("@tmtp/domain").Job;
  complete(jobId: string, leaseToken: string): void;
  fail(jobId: string, leaseToken: string, failure: JobFailure): void;
  recoverExpired(): number;
  list(query: JobListQuery): import("@tmtp/domain").Job[];
  listDiagnosticErrors(after: DiagnosticJobCursor | undefined, limit: number): import("@tmtp/domain").DiagnosticError[];
}

export function createJobQueue(options: JobQueueOptions): JobQueue;
export const jobQueueMigrations: import("@tmtp/database").Migration[];
```

Construction rejects duplicate codec kinds and registers no handlers. The service maps kinds to idempotent handlers separately. `claim` may decode and persist a migrated payload before returning the leased job; an undecodable stored job becomes terminally `failed` with `invalid-payload` instead of reaching a handler.

## State and idempotency contract

- `enqueue` validates the payload at the supplied current version. `payloadSchemaVersion` must equal the codec's current version for new work.
- A non-empty `dedupeKey` identifies the complete logical effect. The first active payload wins. A duplicate active `(kind,dedupeKey)` returns `inserted=false` and the existing job without changing its schedule or payload. Completed/failed jobs do not block later logical work.
- `claim` selects the oldest eligible queued job whose kind is requested, `runAfter<=now`, and `attempts<maxAttempts`. It atomically changes status to `leased`, generates a random lease token, sets expiry to `now+leaseMs`, and increments `attempts`. Attempt counts therefore count started handler attempts.
- `renew` requires the matching leased token and sets a new expiry from the current clock. Long-running workers renew before expiry; renewal does not increment attempts.
- `complete` requires the matching leased token, marks `done`, clears lease fields, and sets `completedAt`/`updatedAt`.
- `fail` requires the matching leased token. It persists `lastErrorCode=failure.code` and the separately bounded safe `lastError=failure.message`. Retryable failure with attempts remaining returns the job to `queued` with cleared lease fields and deterministic backoff; otherwise it becomes terminally `failed` and sets `completedAt`. Recovery uses stable `lease-expired`/`attempts-exhausted` codes rather than parsing message text.
- Backoff after attempt `n` is `min(backoffMaxMs, backoffBaseMs * 2^(n-1))`. There is no hidden jitter; callers can include deterministic jitter in a future policy version if needed.
- `recoverExpired` processes at most `batchSize` expired leases. It requeues jobs with attempts remaining using the same backoff rule and terminally fails exhausted jobs. The service repeats recovery while a full batch is returned during startup.
- Lease-affected writes compare job ID, token, and `leased` status. A zero-row transition throws `lease-lost`; a stale worker can never complete or fail a newer attempt.

All timestamps come from the injected clock. Job execution and external effects never occur inside queue transactions. Queue methods may join an outer `reader-store` transaction on the same database for atomic enqueue handoffs.

`list` is a descending `(createdAt,id)` keyset page with the requested status/kind filters. `after` must be a valid domain timestamp/non-empty ID and resumes strictly before that tuple under the same filters; it carries no payload or lease token. The queue returns at most `limit` rows and does not synthesize an opaque transport cursor. Diagnostics encodes the last row and binds its own filter fingerprint.

`listDiagnosticErrors` is a separate bounded failed-job projection ordered descending by `(updatedAt, "job:" + id)`. Its cursor contains that exact `(occurredAt,source-prefixed ID)` tuple, making it compatible with reader-store's derived recent-error stream. Each result has `id="job:"+jobId`, `component="job-queue"`, `code=lastErrorCode`, `occurredAt=updatedAt`, and `jobId`; only failed rows with a stable code are included and no message/payload/lease token is returned. Ordinary job pages retain their independent `(createdAt,id)` contract.

## Internal subcomponents

- Payload codec registry and migration/validation boundary.
- SQL migration, active dedupe index, and row/domain mapping.
- Atomic enqueue/claim/renew/complete/fail state machine.
- Backoff, bounded lease recovery, and debug listing.

## Dependencies on other libs

- `clock`
- `database`
- `domain`

## New build or OSS wrapper

New build over the shared SQLite database; no external queue service.

## Hosted by

`services/personal-reader` background worker loop.

## Configuration

- `jobs.poll_interval_ms` — **optional**, default `1000`; consumed by the service worker loop.
- `jobs.lease_ms` — **optional**, default `120000`, minimum `1000`.
- `jobs.max_attempts` — **optional**, default `5`, minimum `1`.
- `jobs.backoff_base_ms` — **optional**, default `1000`, minimum `0`.
- `jobs.backoff_max_ms` — **optional**, default `300000`, at least the base value.
- `jobs.batch_size` — **optional**, default `20`, minimum `1`; operation bound, not retention.

## Acceptance-focused test expectations

- Validate/migrate every registered payload version; reject unknown kinds and future/corrupt versions without exposing payload data.
- Deduplicate only active matching keys and report whether insertion occurred, including under an outer store transaction.
- Prove claim, renewal, completion, failure, and recovery transitions against real SQLite and stale lease tokens.
- Cover retry exhaustion, deterministic backoff, delayed jobs, bounded recovery, and crash/restart after lease expiry.
- Verify stable `lastErrorCode` persistence, descending job keyset pages with unchanged filters, exact-timestamp tie-breaking, and no payload/lease-token data in cursor positions.
- Verify failed-job diagnostic candidates use the same synthetic-ID/update-time ordering as merged error cursors, including equal-timestamp prefix comparisons.
- Demonstrate that an at-least-once duplicate handler attempt does not duplicate logical application effects.
