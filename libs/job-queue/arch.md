# Job Queue Library Architecture

## Internal modules

- `codecs`: immutable kind registry, current-version checks, and old-payload migration/validation.
- `schema`: the `0020_job_queue` migration containing the `jobs` table (including separate `last_error_code`/safe-message columns), partial active-dedupe index, claim index, lease-expiry index, and descending list keyset. It follows reader-store's `0010_reader_foundation` in the service's global migration sequence.
- `repository`: row mapping, JSON serialization/parsing, small parameterized SQL statements, and the separate failed-job diagnostic projection ordered by `(updatedAt,"job:"+id)`.
- `state-machine`: enqueue, claim, renew, complete, fail, and recovery transitions.
- `policy`: lease and exponential-backoff calculations using the injected clock.

Handlers and polling are deliberately outside this package. The service owns the worker loop and heartbeat cadence; application libraries own kind-specific effects.

## SQL and concurrency design

SQLite is the coordination primitive. Each transition executes in a short synchronous transaction through `database`. Claim selects an eligible candidate and updates it with status/attempt predicates before returning the leased row. Active dedupe is enforced by a partial unique index on `(kind,dedupeKey)` for queued/leased rows, not just by a read-then-insert check.

The target topology has one connection and one writer, but token/status predicates still protect against stale asynchronous handlers. No `SELECT ... FOR UPDATE` is used because SQLite does not support it. Lease loss is an expected concurrency outcome, not a retryable database failure.

## Payload migration design

Codecs form an explicit registry rather than a global schema map in `domain`. New payloads are accepted only at the codec's current version. Claimed old payloads are decoded through deterministic migrations and rewritten at the current version in the same lease transaction. This keeps debug listings and handler input consistent.

A poison payload is terminally failed before handler invocation. This prevents one malformed row from blocking the queue forever. Codec errors never echo payload content because payloads can contain story/profile text.

## Lease and failure design

Attempts increment at claim, making exhaustion observable even if the process dies during a handler. Renewal compares the same token as completion/failure. Recovery treats an expired lease as a failed attempt and applies backoff; it does not increment attempts again.

A worker should renew at a fraction of `leaseMs`, stop renewing during shutdown, and still make every effect idempotent because a lease can expire between renewal and an external result. The queue cannot make an external HN/LLM request exactly-once.

## Transaction composition

Queue methods call the shared database transaction helper, which uses savepoints when already inside a `reader-store` transaction. This permits ingestion to commit stories and jobs together and activity to commit observations and profile work together. Handlers run only after their claim transaction has committed.

## Trade-offs

- A project-owned queue avoids Redis but requires focused tests for leases, recovery, dedupe, and payload migration.
- Deterministic backoff is reproducible; lack of jitter is acceptable for one personal worker but would need revisiting for many workers.
- First-active-payload-wins dedupe is simple and safe only when dedupe keys cover the full logical effect, including content/profile versions where required.
- Bounded recovery may require several startup passes, but avoids an unbounded migration-like transaction.

## Testing seams

Tests use real temporary/in-memory SQLite, fixed clocks, deterministic token injection at the internal boundary, and explicit codecs. Public behavior is asserted through returned domain jobs and debug listings. Integration tests kill/reopen a database between lease and recovery rather than simulating restart with mocks.
