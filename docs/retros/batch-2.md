# Batch B Retrospective — Storage and integration libraries

## What worked well
- All nine libraries implement the finalized contracts without changing the dependency graph or adding configuration keys.
- Tests exercise real boundaries where behavior matters: Web Crypto, Undici dialing, OpenAI SDK loopback HTTP, SQLite migrations/transactions/restarts, and Croner with fake timers.
- The store and pure queue tests pin complete queue reachability, content-addressed ranking, strict keysets, immutable history, and article/story stale-score invalidation.
- The scheduler's manual driver made overrun and drain behavior deterministic while the production-driver test verified actual five-field occurrence delivery and permanent cleanup.

## What didn't work or was harder than expected
- OpenAI SDK request IDs, error unwrapping, timeout behavior, and response parsing needed direct inspection of the pinned implementation. A local structured-output server was more useful than SDK mocks for proving adapter-owned retries and deadlines.
- Reader-store required one explicit mapping and keyset discipline across 16 tables. Cross-repository tests were necessary to prove atomic invalidation and activity/job rollback rather than only round-trip storage.
- Several failing assertions were fixture mistakes rather than implementation defects: section ordering, diagnostic tie-breaks, escaped JSON, absent optional properties, and microtask timing. Checking actual results before editing implementation prevented masking behavior.
- TypeScript 7.0.2 still provides no session LSP server; package and root compiler builds remained the diagnostic path.

## What we learned that changes our understanding of later batches
- Later HN, article, and service probes should use loopback servers and private deterministic seams first; live provider behavior remains a separate acceptance item.
- Compositions must keep external work outside the synchronous store transactions. The reader-store/job-queue rollback test is the pattern for activity, ingestion, and recommendation handoffs.
- Queue projection must publish one complete rank version and pointer in the same transaction as ranked rows; read/write chunking cannot create per-batch rank versions.
- Scheduler callbacks should only enqueue or recover idempotent durable work. No later package should rely on the in-memory scheduler for downtime catch-up.

## Concrete changes to make
- Keep `@tmtp/clock` and `@tmtp/job-queue` as reader-store development-only dependencies for cross-library tests; its runtime dependencies remain `database` and `domain`.
- Reuse the manual scheduler driver, OpenAI loopback harness, real SQLite fixtures, and independent golden cursor/rank calculations in later composition tests.
- Preserve the existing migration concatenation order: `0010_reader_foundation` before `0020_job_queue`.
- No spec, architecture, dependency-order, or finalized decision changes are required from this batch.

## Workflow coverage at this layer
- WF-01 lower-layer checks cover validated configuration, hash-only access sessions, migrations, and OpenAI-compatible structured calls. Service startup/readiness remains for Batch F.
- WF-02 lower-layer checks cover scheduler triggers, durable job leases/recovery, story/cursor persistence, and transaction handoffs. HN ingestion arrives in Batch D.
- WF-03 checks cover complete scored/pending/failed projection, blacklist retention, deterministic exploration, strict cursors, and stable SQL pages without a cap.
- WF-04 checks cover idempotent activity, insertion-sequence versions, session projections, and transport/content boundaries already available at this tier.
- WF-05/WF-06 storage and pure-policy checks cover durable HN intent/outcome history, immutable profiles/recommendations, explicit blacklist precedence, and history-preserving visibility changes. Live HN behavior remains for later batches.
- WF-07 checks cover real SQLite restart persistence, job recovery, and current-profile selection. Full service recovery remains for Batch F.
- All applicable checks were offline or loopback-only; no uncontrolled external network calls were used.

## Verification
- `pnpm build`: all 17 Batch A–B package builds passed serially.
- `pnpm test`: all 17 package suites passed; 280 tests total, including 138 Batch B tests.
- `reader-store`: 14 real-SQLite tests passed, including all 16 owned tables, restart persistence, and activity/job rollback/commit.
- `llm-openai-compatible`: 23 tests passed, including five real OpenAI SDK loopback tests.
- `scheduler`: 14 tests passed, including real Croner fake-timer firing and real-logger secret containment.
- LSP: unavailable for the same pinned TypeScript reason recorded in Batch A; compiler builds passed instead.
