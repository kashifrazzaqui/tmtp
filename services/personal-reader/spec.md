# Personal Reader Service Spec

## Purpose
Run the complete single-user product as one Node process: static reader UI, authenticated JSON API, background scheduler/workers, SQLite persistence, external HN/LLM integrations, health, and an opt-in live debug window. The same artifact runs on a laptop or personal server.

## Hosted libs
Direct composition and lifecycle wiring uses:
- `config`, `database`, `logging`, `clock`, `scheduler`, `job-queue`
- `reader-store`, `reader-app`, `diagnostics`
- `hn-ingestion`, `personalization`, `article-reader`
- `llm-openai-compatible`, `access-control`

The service also supplies the concrete transitive graph: `domain`, `retry`, `http-client`, `activity`, `interests`, `queue`, `article-fetcher`, `article-extractor`, `hn-public-api`, `hn-account`, `recommendations`, and `llm-interface`. No library opens a listener or owns process lifecycle.

## Transport / wire protocol

### Static UI
- `GET /`, `/queue`, `/stories/:storyId`, `/settings` — Vite/React SPA with history fallback.
- `GET /debug` — same SPA debug route only when `debug.enabled=true`; otherwise 404.
- React `19.3.1`, Vite `8.3.5`, MUI `9.5.0`, TanStack Query, and React Router Declarative Mode. No production UI server or SSR process.
- Content Security Policy: default/self resources, no frames/objects, no remote form targets, and no third-party scripts. Article HTML is rendered through the sanitized reader component, never as an unsandboxed document.

### Authentication
- `POST /api/v1/auth/login` — exchange the pre-provisioned access token for an opaque `HttpOnly` session cookie and CSRF secret.
- `POST /api/v1/auth/logout` — revoke the session.
- `GET /api/v1/auth/session` — return expiry and CSRF state, never the session/token value.
- Cookie `Secure` is required with HTTPS/public deployment; `SameSite` is explicit and scope is narrow. State-changing cookie-authenticated routes require a CSRF header and origin check. No cross-origin CORS policy is opened by default.
- Every deployment mode requires the pre-provisioned token. Loopback binding reduces network exposure but does not create an unauthenticated bypass.

### Reader API
All data routes are versioned JSON and require access control except health.
- `GET /api/v1/queue?state=&evaluation=&cursor=&limit=` — complete queue page with stable cursor and evaluation counts.
- `PATCH /api/v1/queue/:storyId` — change reading state.
- `GET /api/v1/stories/:storyId` — story, cached article, queue entry, and recommendation explanation.
- `GET /api/v1/stories/:storyId/recommendations?cursor=&limit=` — immutable recommendation history for version/immutability assertions.
- `GET /api/v1/stories/:storyId/hn-actions?limit=` — redacted local action intents and verified/indeterminate/failed outcomes.
- `POST /api/v1/stories/:storyId/article-refresh` — enqueue idempotent article refresh.
- `POST /api/v1/activity/batches` — append idempotent natural-activity observations.
- `GET /api/v1/activity?storyId=&clientEventId=&afterId=&limit=` — authenticated activity/session projection for reading history and harness assertions.
- `GET /api/v1/preferences` — current explicit include/exclude rules.
- `PUT /api/v1/preferences` — replace rules and create a new profile version.
- `POST /api/v1/personalization/rebuild` — rebuild profile and enqueue pending scoring.
- `GET /api/v1/hn/capabilities` — available, unavailable, and unverified account capabilities.
- `POST /api/v1/hn/actions` — execute one explicit HN action intent and return verified/indeterminate outcome.
- `POST /api/v1/hn/reconcile` — enqueue best-effort account-state reconciliation.
- `POST /api/v1/operations/ingestion?mode=enqueue|run` — enqueue or synchronously run a headless ingestion cycle; default `enqueue`.
- `POST /api/v1/operations/personalization?mode=enqueue|run` — enqueue or synchronously run pending personalization work; default `enqueue`.
- `POST /api/v1/operations/jobs/run-once` — claim and run one eligible job for deterministic harness operation.

Errors use `{ "error": { "code", "message", "retryable", "details?" } }` with a request ID. Validation failures never echo secrets. HN action failures preserve local reading state and distinguish unavailable, ineligible, expired-session, indeterminate, and verified outcomes.

### Schedules and job topics
- `ingestion.cron` → enqueue `hn.public.collect` and optional `hn.account.reconcile`.
- `personalization.cron` → enqueue `personalization.recover`.
- Article jobs: `article.fetch-extract` keyed by story/content version.
- Personalization jobs: `personalization.profile-rebuild`, `personalization.score-pending`, and `personalization.queue-project`.
- Worker poll: `jobs.poll_interval_ms`; at-least-once handlers use dedupe keys and idempotent application methods.

### Health and debug protocol
- `GET /health/live` — process/event-loop liveness only; no external dependency requirement.
- `GET /health/ready` — migrations, SQLite, required LLM configuration, worker startup; optional HN account state reported separately.
- `GET /api/v1/debug/state` — redacted `DebugSnapshot`, authenticated and only when enabled.
- `GET /api/v1/debug/stream` — authenticated SSE stream of snapshots at `debug.stream_interval_ms`, only when enabled.

### Headless CLI
- `personal-reader start` — validate config and run the service.
- `personal-reader doctor` — validate config/migrations and required external connections without starting listeners.
- `personal-reader jobs run-once` — process one durable job for scripting and recovery.

The command does not prescribe how configuration files/environment/flags are loaded; all loaded values converge on the centralized schema.

## Lifecycle

### Startup
1. Load secret values through their configured paths without logging them; validate centralized config and cross-field rules.
2. Open SQLite, set pragmas, verify integrity, and apply ordered migrations from all owning libraries.
3. Construct store/job queue and recover expired leases.
4. Probe the configured LLM with a minimal structured request and persist the redacted audit. An unavailable LLM degrades new scoring but does not block stored reading. Optional HN account failure degrades only account capabilities.
5. Construct application/diagnostics, recover missed schedules from durable run/job records, register handlers/schedules, and start the worker.
6. Bind Fastify and advertise readiness after local configuration, migration, SQLite, and worker checks pass.

### Shutdown
1. Stop readiness and new HTTP connections; drain in-flight requests within grace.
2. Stop cron schedules and job polling; close SSE clients.
3. Allow the active job to finish within grace or persist its expired lease for recovery.
4. Close SQLite and flush synchronous logs. Exit nonzero if forced cleanup fails.

### Health checks
Liveness is independent of HN/LLM. Readiness fails for invalid migrations, unavailable SQLite, missing required configuration, or workers that cannot start. LLM, account HTML, and article-source failures are degraded capabilities, not global unavailability; `doctor` still reports an LLM probe failure.

## Runtime dependencies
- Node `24.22.1` LTS line and production workspace dependencies.
- One local SQLite file through `better-sqlite3`; no database server, Redis, broker, or vector store.
- Official public HN Firebase API.
- Optional authenticated HN HTML origin and secret session cookie.
- One OpenAI-compatible LLM endpoint and API token.
- Arbitrary public article origins through the SSRF-safe fetcher.
- Reverse proxy supplying HTTPS is expected for a public custom domain; this plan does not prescribe proxy provisioning.

## Deployment artifact type
A self-contained production workspace directory containing compiled ESM service/library JavaScript, Vite static assets, SQL migrations, package manifests, and the platform-appropriate `better-sqlite3` binary. It runs as one Node service with one start command. The same artifact supports laptop and personal-server deployment; no CI/CD or container contract is prescribed.

## Agent harness

### Headless driver
- Start the service on an ephemeral loopback port with a temporary SQLite file, fixed clock where supported, and local fake HN/API, HN/HTML, article, and OpenAI-compatible servers.
- Drive every workflow through the JSON API and `jobs run-once`; use `doctor` for startup/config assertions and real process restart for durability tests.
- Assert database-backed outcomes only through public API plus debug projections, not private module internals. Use deterministic fake LLM judgments and recorded HN HTML fixtures.
- Exercise malicious article HTML, private-address/redirect rejection, duplicate activity, expired job leases, LLM failure, and HN indeterminate action outcomes.

### Computer-use path
- Playwright drives login, queue pagination, story reading, explanation, preference correction, HN action confirmation, and the debug drawer.
- Stable ARIA roles and scoped `data-testid` values support assertions; screenshots are supplementary rather than a substitute for DOM/API state.
- Playwright traces capture DOM, console, network, and failed actions locally. Chromium is the fast path; Firefox/WebKit cover release compatibility.

### Assertion instrumentation
Request IDs, sync run IDs, job IDs/leases, story/profile/recommendation versions, evaluation counts, redacted LLM usage, and SSE debug snapshots provide observable state. Fake servers expose request journals so tests can assert exactly which story/profile payload left the instance without logging secrets.

## Debug window
An authenticated UI drawer plus `/api/v1/debug/state` and SSE stream shows current sync runs, job status/leases/attempts, queue counts by evaluation state, recent redacted errors, LLM latency/token usage, and active profile/recommendation versions. `debug.enabled` toggles the entire surface and defaults to `false`.

`debug.include_llm_payloads` separately controls non-secret prompt/profile/content capture and defaults to `false`. The service passes this policy to the recommendation producer through `RecommendationPolicy.capturePayloads`, not only to the diagnostics reader. Access tokens, session IDs, cookies, API keys, and secret-file values are never included.

## Configuration

### Service-owned keys
- `server.host` — **optional**, default `127.0.0.1`.
- `server.port` — **optional**, default `3000`.
- `server.public_base_url` — **optional**, default `null`; required for custom-domain cookie/origin policy.
- `server.trust_proxy` — **optional**, default `false`; enable only for a trusted reverse proxy.
- `server.shutdown_grace_ms` — **optional**, default `10000`.

### Component-owned runtime keys
The service aggregates every key from `access-control`, `activity`, `article-extractor`, `article-fetcher`, `database`, `diagnostics`, `hn-account`, `hn-ingestion`, `hn-public-api`, `http-client`, `interests`, `job-queue`, `llm-openai-compatible`, `logging`, `queue`, `recommendations`, `personalization`, and `scheduler`. Each is listed with its required/optional status in the component spec and the complete configuration table in `docs/architecture.md`.
