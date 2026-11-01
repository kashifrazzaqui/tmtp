# Phase 06 — Batch F: Personal Reader service
Status: DONE

## Goal
Deliver the complete single-process service, static React reader, authenticated HTTP/debug surfaces, durable worker/scheduling, CLI modes, and lifecycle.

## Tasks
- [x] Implement personal-reader service and production UI
- [x] Verify service composition, HTTP, worker, health/debug, UI, CLI, and restart behavior
- [x] Run every package test and all WF-01 through WF-08 acceptance checks
- [x] Write the Batch F retrospective and delivery audit

## Acceptance Criteria
- The service builds and starts under the pinned Node 24 toolchain with one shared SQLite connection and exact eight-kind worker registry.
- Configuration/secrets, authentication/CSRF/origin, safe DTOs/errors, scheduler/worker, health/debug, and reverse cleanup follow their contracts.
- The Vite/React UI provides the specified reader workflows with sanitized content and production CSP.
- All package suites and all eight workflows pass through their applicable public surfaces.
- The Batch F retrospective is written and the batch is committed.

## Decisions Made This Phase
- User approved the debug-only absent-`Origin` fallback requiring `Sec-Fetch-Site: same-origin` after session and CSRF checks; mutations retain exact `Origin`.
- Observe LLM health at actual personalization port calls, not from personalization job kind alone.
- Keep ordered graceful cleanup under one shared grace deadline; initiate forced worker drain at the deadline without closing borrowed resources prematurely.
- Final gate: 27 project builds, 693 unit/integration tests, and nine browser workflows in each of Chromium, Firefox, and WebKit passed under Node 24.22.1.
