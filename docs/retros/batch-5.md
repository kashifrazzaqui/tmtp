# Batch E Retrospective — Reader application

## What worked well
- `reader-app` implements the transport-free facade without adding production dependencies or moving ownership out of the lower libraries.
- Complete queue queries discover every rank version, preserve canonical group/page order, bind strict `rqa1` cursors to a complete manifest, and return aligned batch story details.
- HN commands commit intents before external work and outcomes plus verified activity handoffs afterward. Tests cover replay, reconciliation evidence, single-flight cancellation, rollback, and real worker processing.
- Article jobs preserve source/pipeline eligibility, conditional upserts, terminal failure evidence, retry policy, and duplicate/lease recovery behavior.
- The exact eight-codec registry and central dispatcher keep owner payload rules and lease transitions separate.

## What didn't work or was harder than expected
- The domain ISO refinement can throw `RangeError` for malformed preference timestamps. A reader-app regression now proves that this becomes safe `invalid-input` before delegation.
- Independent review found that `hn-account` labeled throttle cancellation as `cancelled-after-dispatch` even when no POST occurred. The lower-layer dispatch boundary now rethrows the exact pre-dispatch abort reason and reserves indeterminate outcomes for actual dispatch.
- The first cross-layer workflow test requested a page above its fixture maximum. Correcting the fixture kept the application bound intact.
- The implementation child's fresh shell used Node 26. The parent reran build, typecheck, and tests under the required Node 24.22.1 toolchain.
- TypeScript 7.0.2 still provides no session LSP server; compiler builds remained the diagnostic path.

## What we learned that changes our understanding of the service batch
- The service must register `readerAppJobCodecs` before constructing job-queue and must pass `readerAppBootstrapRankVersion` into ingestion.
- Worker loops must branch on `idle`, `leased`, and `rejected`; only leased claims enter `runJob`, and all lease transitions use the original ID/token.
- Service scheduling calls `scheduleIngestion`/`scheduleHnReconciliation`; it never performs HN work in cron callbacks.
- HN action cancellation must distinguish pre-dispatch waits from actual POST dispatch. The service must not turn safe cancellation into an unverified mutation.
- Queue responses already include aligned story details; the HTTP/UI layer should not issue N+1 detail requests.

## Concrete changes to make
- Reuse the real cross-layer workflow and poison/leased/idle worker fixtures in service tests.
- Keep browser rendering, cookies, CSP, HTTP, schedules, and process lifecycle above reader-app.
- Preserve the test-only database dependency boundary in service composition.
- No spec, architecture, dependency-order, or finalized decision changes were required from this batch.

## Workflow coverage at this layer
- WF-02/WF-03/WF-07: a real SQLite test ingests bootstrap rows, runs a complete projection, ingests again, and proves new pending rows join the active rank. Mixed-version pagination and restart/lease tests cover complete reachability and recovery.
- WF-04: cached story/fallback queries, independent histories, article eligibility, conditional result persistence, replay-safe activity, and real worker handoffs are covered.
- WF-05: durable HN intent/outcome transactions, reconciliation replay, stable app-action activity, single-flight cancellation, and pre/post-dispatch outcomes are covered without live HN claims.
- WF-06: preference/profile delegates, exact linked explanations, queue transitions, and preserved history are covered.
- WF-08: safe facade and worker errors, strict codecs, poison-job containment, and fixed failure text are covered at the application boundary.
- All applicable checks were offline and deterministic; no uncontrolled external network calls were used.

## Verification
- `pnpm build`: all 26 Batch A–E package builds passed serially under Node 24.22.1.
- `pnpm test`: all 26 package suites passed; 470 tests total.
- Batch E added 48 tests: `reader-app` 47 and one `hn-account` pre-dispatch cancellation regression.
- `reader-app` also passed its package typecheck independently.
- LSP: unavailable for the same pinned TypeScript reason recorded in earlier batches; compiler builds passed instead.
