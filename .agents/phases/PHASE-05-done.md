# Phase 05 — Batch E: Reader application
Status: DONE

## Goal
Deliver the transport-free application facade, complete mixed-version queue queries, durable action/article coordinators, and all eight job handlers.

## Tasks
- [x] Implement reader-app
- [x] Run every Batch A–E test suite and applicable workflow acceptance checks
- [x] Write the Batch E retrospective

## Acceptance Criteria
- Reader-app exposes its specified contract and builds under the pinned Node/TypeScript toolchain.
- Mixed-version queue pagination retains every row with strict cursor and manifest behavior.
- HN intents/outcomes, article attempts, activity handoffs, and job dispatch preserve their durable transaction boundaries.
- Every Batch A–E package test suite passes.
- Applicable workflow acceptance flows pass with deterministic external adapters and real SQLite boundaries.
- The Batch E retrospective is written and the batch is committed.

## Decisions Made This Phase
- Preserve exact pre-dispatch HN abort reasons in the owning account library; only actual POST dispatch produces `cancelled-after-dispatch`.
- Treat malformed preference timestamp refinements as reader-app `invalid-input` rather than leaking `RangeError`.
