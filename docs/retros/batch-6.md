# Batch F Retrospective — Personal Reader service

## What worked well
- The service composes all 26 libraries behind one Node process, one shared SQLite connection, the exact eight-codec worker registry, enqueue-only cron tasks, and reader-app business operations.
- Strict configuration/secrets, session/CSRF/origin checks, safe DTOs/errors, bounded diagnostics, CLI modes, and reverse lifecycle cleanup preserve the lower-layer contracts.
- The React reader provides cached and fallback reading, queue/history cursors, explanations, preference correction, explicit HN commands, health/debug views, and accessible theme controls without exposing stored unsafe fields.
- Real SQLite and real-process restart tests exercise composition rather than replacing the owned storage/job layers with mocks.

## What review caught and changed
- Fastify supplies `reply` as a hook's second argument. A shared guard incorrectly interpreted that argument as permission for the debug-only Origin fallback. Separate mutation/debug hook wrappers now keep exact Origin enforcement on every mutation.
- Browsers omit `Origin` on ordinary same-origin GET requests. The user approved a narrow debug GET/SSE exception: after session and CSRF checks, absent `Origin` requires `Sec-Fetch-Site: same-origin`; missing metadata, other fetch-site values, and wrong explicit origins fail. The service spec, architecture, and decision log record this contract decision.
- LLM capability now follows actual personalization port outcomes, not personalization job kind. Article observations use persisted outcomes, and request cancellation reaches manual run-once handlers.
- Graceful shutdown retains its stage order under one shared deadline. Probe cancellation starts with debug-stream closure, forced worker drain starts at the deadline, cleanup failures remain visible, and local resources do not close ahead of unsettled borrowers.
- Cron validation now matches the scheduler's stepped-field grammar, malformed LLM audits classify as invalid provider evidence rather than SQLite failure, and CLI `--set` blocks prototype-pollution path segments.
- The UI uses server queue/history defaults, ordered single-event activity sends, stable retry IDs, per-story Web Locks, authoritative in-memory CSRF state, and logout failure protection. Queue impressions and explicit skip observations complete the WF-04 producer surface.

## Workflow delivery audit

| Workflow | Verified evidence | Result |
|---|---|---|
| WF-01 install/connect | Configuration/secret suites, real local provider probes and persisted audits, authentication/health HTTP tests, doctor exits, and secret-redaction checks. External failures leave stored reading available. | Pass with local fixtures |
| WF-02 continuous collection | Enqueue-only named cron tests, idempotent public ingestion with durable cursor and downstream jobs, worker/scheduling tests, and restart persistence. | Pass |
| WF-03 complete queue | Mixed scored/pending/failed HTTP pagination, safe explanation DTOs, browser cursor paging with server-default one-item pages, detail caching, and recommendation explanation drawer. | Pass |
| WF-04 cached reading/activity | Sanitized cached content and fallback HTTP tests, immutable/idempotent activity, browser impressions/open/complete/skip, safe fallback links, single-event batching/retry, and real hostile-HTML/CSP checks. | Pass |
| WF-05 explicit HN action | Durable intent/outcome HTTP tests, safe indeterminate history, and browser proof that confirmation precedes dispatch and indeterminate outcomes disable blind retry while offering reconciliation. | Pass with a fake account |
| WF-06 preference correction | HTTP preference replacement, immediate blacklist visibility, preserved story/history, profile rebuild, and browser rule editing/save/rebuild. | Pass |
| WF-07 restart/recovery | Real process start/stop/restart preserves queue, activity, preferences, migrations, and cursors; lifecycle tests cover bounded cleanup, cancellation, failures, and worker recovery. | Pass |
| WF-08 health/debug | Independent local/external health, disabled debug removal, authenticated snapshot/SSE, bounded cursors/reconnects, secret redaction, and browser live debug state. | Pass |

## Verification
- Runtime: Node `24.22.1`, pnpm `10.26.2`.
- `pnpm build`: all 26 libraries and `personal-reader` built serially, including the production Vite UI.
- `pnpm test`: 693 tests passed — 470 library tests and 223 service tests. No test was skipped in the final gate.
- Playwright: nine reader workflows passed in each of Chromium, Firefox 157.0, and WebKit 27.2 — 27 browser runs total.
- `personal-reader` typecheck passed independently. TypeScript `7.0.2` still provides no session LSP server, so pinned `tsc` remained the diagnostic path.
- The production build retains Vite's advisory for the 638.42 kB main UI chunk; it is a warning, not a failed gate.

## External limits and follow-ups
- Live Hacker News public/account markup and readback, and provider/model-specific structured output, remain unverified. Tests use controlled local providers and do not claim live compatibility.
- The OpenAI SDK's process-wide fetch dispatcher is released at process exit; deterministic per-adapter socket cleanup is not claimed.
- Web Locks coordinate same-origin tabs on the tested target engines. The no-Web-Locks fallback preserves per-client ordering and retries but cannot provide cross-tab mutual exclusion.
- No dependency-order change was needed. The only contract change was the user-approved debug Origin fallback recorded above.
