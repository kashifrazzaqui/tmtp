# Phase 01 — Batch A: Foundational libraries
Status: DONE

## Goal
Deliver the eight tier-0 libraries and the shared TypeScript/Vitest workspace setup, with their public contracts covered by tests.

## Tasks
- [x] Implement article-extractor
- [x] Implement clock
- [x] Implement config
- [x] Implement database
- [x] Implement domain
- [x] Implement llm-interface
- [x] Implement logging
- [x] Implement retry
- [x] Run every Batch A test suite and applicable workflow acceptance checks
- [x] Write the Batch A retrospective

## Acceptance Criteria
- All eight libraries expose the contracts in their specs and build under the pinned Node/TypeScript toolchain.
- Every Batch A package test suite passes.
- Applicable workflow acceptance flows pass without network access.
- The Batch A retrospective is written and the batch is committed.

## Decisions Made This Phase
- Used package-local TypeScript output paths and declaration-based workspace exports; producers must build before consumers.
- Used jsdom 30's default inert resource mode and verified it with a real loopback network trap instead of the removed `ResourceLoader` API.
- Kept logger bindings in immutable facade snapshots until each record's redaction boundary instead of allowing Pino to serialize child bindings early.
- Used `{ status }` as the pending/failed article-version projection, matching the domain contract's status-only identity rule.
