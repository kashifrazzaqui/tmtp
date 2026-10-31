# Batch A Retrospective — Foundational libraries

## What worked well
- The implementation contracts were specific enough to drive public-API tests without inventing product behavior.
- Real dependency tests caught integration behavior that mocks would hide: SQLite savepoints and lock errors, Readability table selection, jsdom resource defaults, Pino record shaping, and p-retry error normalization.
- A single strict ESM/declaration build pattern made every downstream package boundary explicit.
- The eight package suites cover the Batch A portions of WF-01 and WF-04: safe configuration and migrations, inert extraction, sanitization, bounded content, cancellation, redaction, and deterministic retry.

## What didn't work or was harder than expected
- TypeScript 7.0.2 does not ship `tsserver.js`, so the session LSP could not provide diagnostics. The pinned compiler was the working diagnostic path.
- Base-config `rootDir`/`outDir` paths resolve from the base file, not the extending package. Package-local output settings were required.
- Pinned jsdom 30 no longer exports `ResourceLoader`; its default no-resource-loading mode plus a real loopback network trap is the correct inert setup.
- Several initial test fixtures made incorrect assumptions about Zod refinement scheduling, driver integer output, Readability data tables, and JavaScript object spread. Checking actual dependency behavior before changing implementation avoided masking those mistakes.

## What we learned that changes our understanding of later batches
- Every workspace package needs its own `rootDir` and `outDir`; downstream type resolution depends on building producers before consumers.
- Tests involving external data must assert behavior at the real library boundary rather than assume third-party normalization details.
- Dynamic secret redaction cannot rely on Pino child binding serialization. Later service session tests must exercise provider-backed redaction after login, logout, and expiry.
- Migration tests should keep using real temporary files for restart and lock behavior; `:memory:` is appropriate only for isolated statement/transaction tests.

## Concrete changes to make
- Apply the established package build/test pattern in Batches B–F; no sequence or dependency changes are needed.
- Use the pinned TypeScript compiler for diagnostics throughout this run because the LSP cannot load TypeScript 7.
- Keep the real network trap in extractor tests and add equivalent transport-boundary tests for HTTP and HN adapters.
- No spec or architecture contract changes are required from this batch.

## Verification
- `pnpm build`: all 8 Batch A packages passed.
- `pnpm test`: 8 test files, 142 tests passed.
- LSP: unavailable because the pinned workspace TypeScript provides no `tsserver.js`; compiler builds passed instead.
