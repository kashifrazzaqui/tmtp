# Batch D Retrospective — Composition libraries

## What worked well
- All three libraries implement the finalized contracts without changing the dependency graph or adding configuration keys.
- `article-reader` composes safe fetching and extraction into domain-versioned terminal outcomes. Tests cover provenance, fallback URLs, exact self-text limits, real sanitization, failure mapping, and cancellation.
- `hn-ingestion` commits stories, initial queue rows, checkpoints, runs, and downstream jobs atomically. Real SQLite tests cover capped bootstrap, reopen recovery, lookback, refresh, sparse tombstones, rollback, account state, and activity outboxes.
- `personalization` combines replay-safe activity, immutable profiles, audits/judgments, current-content failure checks, and one complete queue projection per transaction. Its tests exercise real SQLite across multiple read/write batches, cancellation, recovery, and restart.

## What didn't work or was harder than expected
- Queued ingestion cancellation initially waited for the active operation. A regression test exposed the deadlock; queued aborts now reject immediately while active operations still await started workers.
- Independent review found that HN planning calls could escape run records and that an abort could allow a later planning request. Runs now start before every external request, with cancellation checks between stages.
- Fixed clocks make random run-ID tie-breaking unsuitable for identifying the latest invocation in tests. Tests now correlate by returned run ID.
- Strict payload checks need plain-object validation, not only enumerable-key checks; `Map`, `Date`, and array-shaped descriptions are covered.
- TypeScript 7.0.2 still provides no session LSP server; compiler builds and typechecks remained the diagnostic path.

## What we learned that changes our understanding of later batches
- Reader-app must register all eight contracted worker kinds and the structural activity handoff without importing ingestion into personalization or vice versa.
- Reader-app must pass the queue bootstrap callback and keep article/HN/LLM calls outside store transactions.
- Job handlers must preserve personalization's committed partial work before converting cancelled or retryable outcomes into lease failures.
- Service composition must use one writer instance and one shared SQLite connection for store/job atomicity.
- Live HN and provider behavior remains external verification; deterministic fixtures do not establish live support.

## Concrete changes to make
- Reuse the article reader's original-target projection in reader-app detail/fallback responses.
- Reuse real SQLite restart, rollback, and deferred-provider harnesses for reader-app and service workflow tests.
- Keep the test-only `@tmtp/database` links out of production imports.
- No spec, architecture, dependency-order, or finalized decision changes were required from this batch.

## Workflow coverage at this layer
- WF-02/WF-07 checks cover bounded collection, durable checkpoints, restart recovery, idempotent story/job effects, and failed-run diagnostics.
- WF-03/WF-06 checks cover complete queue projection, stable rank versions, pending/failed retention, immutable profile/recommendation reuse, and immediate blacklist visibility.
- WF-04 checks cover safe external/self-text article outcomes, replay-safe activity, terminal-session ordering, and novel-only profile handoffs.
- WF-05 checks cover account current-state reconciliation, conservative intent verification, and durable activity outboxes without mutations or fabricated occurrence times.
- WF-08 checks cover audit usage/status/latency persistence, optional versioned payloads, safe failures, and complete operational history at this layer.
- All applicable checks were offline and deterministic; no uncontrolled external network calls were used.

## Verification
- `pnpm build`: all 25 Batch A–D package builds passed serially.
- `pnpm test`: all 25 package suites passed; 422 tests total, including 58 Batch D tests.
- Batch D totals: `article-reader` 13, `hn-ingestion` 12, and `personalization` 33.
- `personalization` also passed its package typecheck independently.
- LSP: unavailable for the same pinned TypeScript reason recorded in earlier batches; compiler builds passed instead.
