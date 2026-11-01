# Personal Reader Service Spec

## 1. Purpose and scope

Run the complete single-user product as one Node process: a static reader UI, authenticated JSON API, in-memory cron triggers, one durable-worker loop, SQLite persistence, external HN/article/LLM integrations, health, and an opt-in live debug window. The same production artifact runs on a laptop or personal server.

This document is the external service and composition contract. [arch.md](arch.md) specifies the private modules, exact construction order, worker state machine, cancellation, and reverse-order cleanup. The service must preserve every current lower-library contract; it must not move HTTP, scheduling, worker leasing, configuration loading, or process lifecycle into a library.

The product invariant is continuity without silent loss. A reader can always reach stored stories, cached articles, activity, preferences, and explanations when local configuration, SQLite, and migrations are usable. New collection, fresh article work, account actions, and new LLM personalization degrade independently.

## 2. Hosted libraries and dependency invariant

Direct composition and lifecycle wiring uses only the dependencies already declared in `services/personal-reader/package.json`:

- `config`, `database`, `logging`, `clock`, `scheduler`, `job-queue`
- `reader-store`, `reader-app`, `diagnostics`
- `hn-ingestion`, `personalization`, `article-reader`
- `llm-openai-compatible`, `access-control`
- the concrete transitive graph already present in the manifest: `domain`, `retry`, `http-client`, `activity`, `interests`, `queue`, `article-fetcher`, `article-extractor`, `hn-public-api`, `hn-account`, `recommendations`, and `llm-interface`

No library opens a listener or owns process lifecycle. Batch F adds no runtime or type-only workspace package edge and no third-party package edge. The service imports the schema builder `z` from `@tmtp/config`, whose existing Zod dependency supports that public re-export; it never imports Zod as an undeclared transitive package.

## 3. Process topology and command modes

The supported topology is one operating-system process, one composed object graph, one `ReaderApp`, one `Personalization` writer, one `HnIngestion` writer, one `JobQueue`, one `ReaderStore`, and one synchronous SQLite connection. There is no separate worker, broker, Redis, database server, vector store, SSR server, or production browser-automation process.

The executable has three modes:

- `personal-reader start`: run the listener, scheduler, worker, and asynchronous capability probes.
- `personal-reader doctor`: validate the same configuration/secrets/database/migrations and probe configured external connections without listening, scheduling, recovering schedules, or polling jobs.
- `personal-reader jobs run-once`: construct the same storage/application graph without a listener or cron and execute at most one durable job through the normal worker runner.

All modes load and validate `auth.access_token_path`. Loopback, CLI-only operation, tests, and an absent public URL are not authentication-bypass modes. CLI run-once must not target a SQLite file owned by a running service; the current contracts support one writer, not multi-process coordination.

## 4. Configuration and secret ownership

### 4.1 One validated object

The service loads raw file/environment/flag values, uses `z` from `@tmtp/config` to compose one strict synchronous root schema, calls `parseConfig` exactly once for a candidate, reports only safe `ConfigIssue[]`, and obtains the complete defaulted object through `assertValidConfig`. Loading conventions are outside the library contracts, but every source converges on this one object. There is no component-local configuration read, second default layer, watcher, singleton, or reload in Batch F.

The root schema uses only static object keys and numeric array indices. Component fragments own their key shapes, requiredness, field constraints, and defaults. The composition root adds deployment rules. Invalid centralized configuration stops the command before SQLite, sockets, timers, workers, or provider clients are opened. A loaded secret rejected later by an owning factory instead triggers the documented reverse partial cleanup; the service does not duplicate that factory's validation in the schema.

Mandatory cross-field rules include:

- `auth.access_token_path` is required in every mode.
- `hn.username` and `hn.session_cookie_path` are both present or both absent/null.
- a non-loopback `server.host` requires an HTTPS `server.public_base_url`; independently, any configured non-loopback public origin must be HTTPS even when the bind host is loopback.
- `jobs.backoff_max_ms >= jobs.backoff_base_ms`.
- `debug.include_llm_payloads=true` requires `debug.enabled=true`.
- every delay passed to `systemSleep` is a safe integer in `0..2_147_483_647`; `jobs.lease_ms` remains at least `1000` as required by job-queue.

### 4.2 Service-owned keys

| Key | Required / default | Composition rule |
|---|---|---|
| `server.host` | optional `127.0.0.1` | Non-empty host; loopback classification is part of deployment validation. |
| `server.port` | optional `3000` | Integer `0..65535`; `0` selects an ephemeral harness port. |
| `server.public_base_url` | optional `null` | Absolute credential-free HTTP(S) origin with no non-root path, query, or fragment; HTTPS whenever its origin is non-loopback, and required for a non-loopback bind host. |
| `server.trust_proxy` | optional `false` | Boolean; enable only behind a trusted reverse proxy. |
| `server.shutdown_grace_ms` | optional `10000` | Safe integer within the `systemSleep` range. |

The complete aggregated key/default table remains in `docs/architecture.md`. Batch F adds no configuration keys. Fixed transport limits in this spec are service contract constants, not new operator settings.

### 4.3 Secret files and redaction inventory

After structural validation, the service reads each configured secret file as UTF-8 and removes at most one conventional terminal newline (`\n` or `\r\n`). It performs no other trimming or normalization. The owning factory validates the resulting value. File/validation errors identify only the configuration key and a fixed safe message; they never include file contents, raw driver text, or a supplied secret.

The centralized configuration retains paths, never loaded values. One service-owned secret registry begins with the startup-loaded access token, LLM API key, and optional HN cookie. Logging and diagnostics receive the same `secretValuesProvider`, which returns a fresh consistent snapshot for each emitted record/frame. Successful login adds both issued opaque-session and CSRF values with the session expiry; successful logout removes that session's values, and each provider snapshot prunes entries expired at that snapshot. Snapshot-time retention therefore contains only startup secrets plus then-unexpired issued sessions; expired values may remain between snapshots and until process discard when no snapshot occurs. There is no expiry timer or persistent secret copy. The registry is redaction-only and is never a CSRF recovery API. Raw secrets are never accepted from query parameters or placed in URLs.

## 5. Common HTTP contract

### 5.1 Transport rules

- JSON routes are under `/api/v1`; health routes are under `/health`. Successful JSON uses the exact DTOs below. Optional properties are absent, not converted to `null`, unless a DTO explicitly says otherwise.
- JSON request bodies are limited to 1 MiB, must have an object root where shown, and reject unknown keys. Malformed JSON, wrong media type, and over-limit bodies produce safe `400`, `415`, and `413` errors respectively.
- Numeric path/query values use canonical decimal input. Query objects reject unknown keys, repeated scalar values, noncanonical numbers, and out-of-range limits. Reader history limits default to `queue.page_size` and cannot exceed `queue.max_page_size`.
- The service generates one cryptographically random request ID per request. It does not trust or echo an inbound ID. The same value appears in `x-request-id`, safe logs, and the error envelope.
- Fastify's default request/response logging and default error serialization are not public contracts. The service uses allowlisted log fields and its own error mapper.
- Every request-driven reader-app/account/LLM operation receives a request-linked `AbortSignal`; startup probes receive the service probe signal. Client disconnect and forced shutdown cancel cooperative work. Abort reasons and exact caller cancellation values are never serialized.

### 5.2 Error envelope and status mapping

Every non-SSE API error has this exact outer shape:

```ts
{
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
    details?: {
      operation?: string;
      field?: string;
      storyId?: number;
      jobId?: string;
      dependency?: string;
      dependencyCode?: string;
      retryAfterSeconds?: number;
    };
  };
}
```

`details` contains only populated allowlisted fields. The message is selected from a fixed service/owning-library code table; it is never a raw exception, database, parser, provider, URL, or abort message. The response also carries `x-request-id` with the same ID.

| Condition | HTTP | Typical code |
|---|---:|---|
| Invalid JSON/path/query/body, invalid reader input/cursor | 400 | `invalid-input`, `invalid-query`, `invalid-cursor` |
| Missing/expired/revoked session or invalid login token | 401 | `authentication-required`, `invalid-token` |
| CSRF or origin verification failure | 403 | `csrf-invalid`, `origin-invalid` |
| Missing story/route or disabled debug route | 404 | `not-found` |
| Conflicting idempotency key, stale queue cursor, invalid state transition | 409 | `conflict`, `stale-queue-cursor`, `invalid-transition` |
| Payload too large / unsupported media type | 413 / 415 | `body-too-large`, `unsupported-media-type` |
| Login throttle | 429 | `login-rate-limited` |
| Account capability not configured or unavailable | 503 | `account-not-configured`, `dependency-failure` |
| Required local/worker capability unavailable, dependency failure whether retryable or not | 503 | `workers-stopped`, `dependency-failure` |
| Unexpected internal/store/crypto/transport-contract failure | 500 | `internal-failure` |

A returned HN `failed` or `indeterminate` `HnActionResult` is a successful HTTP command result with status 200, not an infrastructure exception. An expected failed article remains readable through story detail even when its durable job is retrying or exhausted.

`dependency-failure` always uses HTTP 503. Its envelope `retryable` member independently preserves the owning error's value; a non-retryable dependency/invalid-upstream-response failure is not reclassified as an internal failure.

### 5.3 Authentication, cookies, CSRF, and origin

`POST /api/v1/auth/login` accepts `{ accessToken: string }` and awaits `accessControl.login`. Immediately after success, and before response/logging work can serialize another record, it registers the issued opaque-session and CSRF values through expiry in the redaction registry. It returns 200 with `{ expiresAt, csrfSecret }` and sets the opaque session only in a cookie. The access token is not retained by the browser client after login.

The session cookie is named `tmtp_session`, has `HttpOnly`, `Path=/`, no `Domain`, and `SameSite=Strict`. It has `Secure` whenever the effective public origin is HTTPS and is always `Secure` for non-loopback deployment. There is no cross-origin CORS opening.

The effective public origin is `server.public_base_url` when configured. Otherwise it is the normalized `http://<server.host>:<actual-bound-port>` loopback origin, formed only after listen succeeds and using proper IPv6 URL brackets. Non-loopback mode always supplies an HTTPS public base URL. This one effective origin is the only allowed `Origin`; `server.trust_proxy` changes request interpretation, not the allowed origin. An ephemeral port therefore uses the actual assigned port, not zero.

`POST /api/v1/auth/logout` requires a valid session, CSRF, and origin, awaits `logout`, removes only the successfully revoked session's values from the redaction registry, clears the cookie, and returns 204. Logout revokes only the presented session. Failed authentication/CSRF/revocation does not unregister a still-active session.

`GET /api/v1/auth/session` returns 200 with `{ authenticated: false }` when no usable session exists. Otherwise it returns `{ authenticated: true, expiresAt, csrfState: "stored" }`. `stored` means the server holds only the CSRF hash; it does not mean the browser still holds the raw secret. No session, token, CSRF secret, or hash is returned by this route.

The raw CSRF secret is returned only by login. The React client keeps it in memory for the live tab and may keep it in `sessionStorage` for that tab; it never uses `localStorage`. If the raw secret is absent or lost, the client must log in with the access token again and establish a new session. There is no recovery or implicit rotation endpoint. The new login does not revoke the old session.

All state-changing cookie-authenticated routes, logout, and both debug routes perform these steps in order:

1. await `authenticate(opaqueSession)`;
2. require the `x-tmtp-csrf` header and await `verifyCsrf` on that fresh session snapshot;
3. require an exact allowed `Origin` and reject a present cross-site `Sec-Fetch-Site` value, except for the narrow debug browser-fallback rule below.

Other authenticated GET routes require only step 1. Debug routes deliberately use the stronger mutation checks. Browsers omit `Origin` on ordinary same-origin GET requests, so after steps 1 and 2 the two debug GET routes accept an absent `Origin` only when `Sec-Fetch-Site` is exactly `same-origin`. They reject absent fetch metadata, every other fetch-site value, and any present non-matching origin. This exception does not apply to logout or any state-changing route; those always require exact `Origin`. The fetch-based SSE client can send `x-tmtp-csrf`; native `EventSource` cannot satisfy this contract and is not used.

## 6. Safe HTTP DTOs

The service maps records field-by-field. It never JSON-serializes a domain, store, job, account-intent, or reader-app result wholesale. React text values remain untrusted strings and are escaped by React. Transport error/code fields use the bounded lowercase kebab-case vocabulary; an invalid stored code becomes `unknown-error` instead of escaping as free-form text.

### 6.1 Reusable DTOs

- `QueueEntryDto`: required `storyId`, `state`, `evaluationState`, `visibilityState`, `kind`, `rankVersion`, `queuedAt`, `updatedAt`; optional `recommendationId`, `rankScore`, and `rankPosition`. Optional values are absent rather than null, including for pending/failed rows. It omits `lastError`.
- `QueueItemDto`: `{ entry: QueueEntryDto, story: StoryDto, originalUrl, fallback: StoryFallbackDto }`, projected from one entry-aligned reader-app `ReaderQueueStory`.
- `StoryDto`: required `id`, `itemType`, `title`, `publishedAt`, `firstSeenAt`, `lastSeenAt`, `contentVersion`, `deleted`, `dead`; optional `author`, `score`, `descendants`. It omits raw HN JSON, raw `textHtml`, and unnormalized story/canonical URLs. Safe navigation/source display uses `originalUrl` from story detail instead.
- `StoryFallbackDto`: `{ kind: "original-page" | "hn-discussion", observationQuality: "partial" }`.
- `ArticleDto`: required `storyId`, `status`, `sourceContentVersion`, `contentVersion`, `updatedAt`; optional `title`, `byline`, `excerpt`, `sanitizedHtml`, `extractorVersion`, `fetchedAt`, `errorCode`. `sanitizedHtml` is present only for a ready article that produced it. It omits raw text, source/final redirect URLs, and `errorMessage`.
- `RecommendationDto`: `id`, `storyId`, `profileId`, `storyContentVersion`, `articleContentVersion`, `promptVersion`, `model`, `score`, `rationale`, `evidence`, `evidenceSchemaVersion`, optional `llmCallId`, `createdAt`.
- `ActivityEventDto`: `id`, `clientEventId`, `storyId`, `kind`, optional kind-validated `value`, `valueSchemaVersion`, `source`, `observationQuality`, `occurredAt`, `receivedAt`, `sequence`.
- `ReadingSessionDto`: `id`, `storyId`, `startedAt`, optional `endedAt`, `updatedAt`, `activeDwellMs`, `maxScrollRatio`, `state`, `observationQuality`, `lastClientEventId`.
- `PreferenceRuleDto`: `id`, `kind`, `effect`, `value`, `normalizedValue`, `enabled`, `createdAt`, `updatedAt`.
- `InterestProfileDto`: the explicit same-named public fields of domain `InterestProfile`: `id`, `rulesVersion`, `activityVersion`, `sourceRules`, `sourceRulesSchemaVersion`, `policy`, `policySchemaVersion`, `policyVersion`, `builderVersion`, `interests`, `reason`, and `createdAt`. It is returned only to the authenticated single user, never injected into diagnostics by this mapper.
- `JobDto`: `id`, `kind`, `status`, `runAfter`, optional `leaseExpiresAt`, `attempts`, `maxAttempts`, optional `lastErrorCode`, `createdAt`, `updatedAt`, optional `completedAt`. It omits payload, dedupe key, lease token, and free-form `lastError`.
- `AccountCapabilityDto`: `name`, `state`, optional `reason`.
- `HnActionResultDto`: `intentId`, `status`, `observedAt`, optional `errorCode`.
- `HnActionHistoryDto`: `id`, `storyId`, `action`, `status`, `createdAt`, `updatedAt`, optional `errorCode`, and optional `outcome`. `outcome` contains only `status`, `observedAt`, and optional `errorCode`, normalized from either adapter result evidence or reconciliation evidence. It never contains `idempotencyKey` or raw result JSON.

`PreferenceRuleDto`, `RawActivity`, `IngestionSummary`, `AccountReconciliationSummary`, `RecordActivityResult`, `ScorePendingSummary`, `RecoverySummary`, and `HnActionResultDto` preserve the field names and value rules in their current owning-library contracts.

### 6.2 Queue and story routes

| Route | Input and facade call | Success DTO |
|---|---|---|
| `GET /api/v1/queue` | Query `state`, `evaluationState`, `visibilityState`, `cursor`, `limit`; call `getQueue` with the same names. Default visibility is `visible`. | 200 `{ items: QueueItemDto[], nextCursor?, evaluationCounts: { pending, scored, failed }, rankVersions }` |
| `PATCH /api/v1/queue/:storyId` | Body `{ state }`; call `setQueueState(storyId, state)`. | 200 `QueueEntryDto` |
| `GET /api/v1/stories/:storyId` | Call `getStory`; cached read only, no fetch/enqueue. | 200 `{ story: StoryDto, article?: ArticleDto, recommendation?: RecommendationDto, queueEntry: QueueEntryDto, originalUrl, fallback: StoryFallbackDto }` |
| `GET /api/v1/stories/:storyId/recommendations` | Query `afterId`, `limit`; call `getRecommendationHistory({ storyId, afterId, limit })`. | 200 `RecommendationDto[]` |
| `GET /api/v1/stories/:storyId/hn-actions` | Query `afterId`, `limit`; call `getHnActionHistory`. | 200 `HnActionHistoryDto[]` |
| `POST /api/v1/stories/:storyId/article-refresh` | No body; call `refreshArticle`. | 202 `JobDto` |

The queue cursor is the opaque reader-app `rqa1` cursor. Recommendation and HN history `afterId` values are record IDs, not opaque cursors. Continue from the last returned recommendation/intent `id`; an empty page ends traversal. There is no fabricated `nextCursor`.

The route zips reader-app's entry-aligned `storyDetails` into `items` by index and verifies the story ID matches. It does not issue per-card story reads or direct store queries. Full article/recommendation detail remains on `GET /api/v1/stories/:storyId`; TanStack Query caches that detail by story ID when the reader opens it.

### 6.3 Activity and preference routes

| Route | Input and facade call | Success DTO |
|---|---|---|
| `POST /api/v1/activity/batches` | Body `{ batch: RawActivity[] }`; call `recordActivity(batch)`. One batch follows activity's one-story and idempotency rules. | 200 `{ accepted, profileWorkEnqueued }` |
| `GET /api/v1/activity` | Query `storyId`, `clientEventId`, `afterEventId`, `afterSessionId`, `limit`; call `getActivity` with the same names. | 200 `{ events: ActivityEventDto[], sessions: ReadingSessionDto[] }` |
| `GET /api/v1/preferences` | Call `getPreferences`. | 200 `PreferenceRuleDto[]` |
| `PUT /api/v1/preferences` | Body `{ rules: PreferenceRuleDto[] }`; call `replacePreferences(rules)`. | 200 `InterestProfileDto` |
| `POST /api/v1/personalization/rebuild` | Body `{ reason: string }`; call `rebuildPersonalization(reason)`. | 200 `InterestProfileDto` |

Activity continuation streams are independent. `clientEventId` filters events by `clientEventId` and sessions by `lastClientEventId`. `afterEventId` is an event `id` resolving to append sequence; `afterSessionId` is a session `id` resolving to `(updatedAt,id)`. Either may be supplied alone, neither is interchangeable with the other or with `clientEventId`, and `limit` independently bounds each array. There is no legacy `afterId` alias and no inferred ID type.

Preference replacement uses the complete current domain-rule representation because that is the current reader-app command input. The UI preserves IDs/timestamps for existing rules and constructs valid unique IDs/timestamps for new client-side draft rules before submission; the service performs no second normalization algorithm.

### 6.4 HN account routes

| Route | Facade call | Success DTO |
|---|---|---|
| `GET /api/v1/hn/capabilities` | `getHnCapabilities` | 200 `AccountCapabilityDto[]` |
| `POST /api/v1/hn/actions` | Body `{ storyId, action, idempotencyKey }`; call `performHnAction`. | 200 `HnActionResultDto` for verified, failed, or indeterminate |
| `POST /api/v1/hn/reconcile` | No body; call `scheduleHnReconciliation`. | 202 `JobDto` |

Without an account, capabilities remain the four canonical names in `upvoted`, `favorites`, `flagged`, `mutations` order, all unavailable with `capability-disabled`. Scheduling reconciliation or a new action without an account fails safely before enqueue/intent creation. Only an explicit user command invokes an HN mutation.

### 6.5 Operations and run-once

| Route | Behavior | Success DTO |
|---|---|---|
| `POST /api/v1/operations/ingestion?mode=enqueue` | Default mode; call `scheduleIngestion`. | 202 `JobDto` |
| `POST /api/v1/operations/ingestion?mode=run` | Explicit manual run; call `runIngestion`. | 200 `IngestionSummary` |
| `POST /api/v1/operations/personalization?mode=enqueue` | Default mode; enqueue `personalization.recover` through `createPersonalizationJobEnqueue` and `jobs.enqueue`. | 202 `JobDto` |
| `POST /api/v1/operations/personalization?mode=run` | Explicit manual run; call `runPersonalization`. | 200 `RecoverySummary` |
| `POST /api/v1/operations/jobs/run-once` | Run one eligible job through the same serialized worker runner used by polling. No body. | 200 run-once result below |

A run-once result is `{ outcome: "idle" }` only when `claim` returns `{ status: "idle" }`. A committed poison-payload transition returns `{ outcome: "rejected", job: JobDto }` from `{ status: "rejected", job }`; this is not a handler attempt and is distinct from both an empty queue and infrastructure failure.

A `{ status: "leased", job }` handler returns `{ outcome: "completed" | "failed", job: JobDto }`, where `outcome` describes the handler attempt and `job` is a fresh post-transition snapshot. A failed attempt can therefore have `job.status="queued"` because retry/backoff remains. If expected finalization reports `lease-lost`, the result is instead `{ outcome: "lease-lost", jobId, kind, handlerOutcome: "completed" | "failed" }`; no possibly newer attempt's snapshot is returned. Other claim/renew/finalization infrastructure errors use the normal safe error envelope.

## 7. Durable jobs, schedules, and worker contract

### 7.1 Exact codec registry

`createJobQueue` receives `readerAppJobCodecs` before any enqueue or claim. The worker claims exactly `readerAppJobCodecs.map(codec => codec.kind)`. The registry has exactly these eight kinds in this order:

| # | Kind | Version-1 payload | Logical dispatch |
|---:|---|---|---|
| 1 | `article.fetch-extract` | `{ storyId, storyContentVersion }` | reader-app article coordinator |
| 2 | `personalization.record-activity` | `{ batch: [one RawActivity] }` | `personalization.recordActivity` |
| 3 | `ingestion.collect` | `{}` | `ingestion.collectPublic` |
| 4 | `ingestion.reconcile-account` | `{}` | `ingestion.reconcileAccount` |
| 5 | `personalization.profile-rebuild` | `{ reason, rulesVersion, activityVersion }` | `personalization.runJob` |
| 6 | `personalization.score-pending` | `{ profileId }` | `personalization.runJob` |
| 7 | `personalization.queue-project` | `{ profileId }` | `personalization.runJob` |
| 8 | `personalization.recover` | `{}` | `personalization.runJob` |

`hn.public.collect` and `hn.account.reconcile` are retired names and are not registered, enqueued, claimed, or dispatched. Their replacements are `ingestion.collect` and `ingestion.reconcile-account`. Article and activity handoffs keep their owner-defined version/dedupe rules; the service does not duplicate payload validation.

### 7.2 Cron only enqueues

Two scheduler tasks are registered before start:

- `ingestion.cron`: await `readerApp.scheduleIngestion()` and, only when an account is configured, `readerApp.scheduleHnReconciliation()`. Both enqueue attempts are made even if one fails; the callback then reports a safe failure to the scheduler. These methods return durable jobs and perform no HN operation.
- `personalization.cron`: call `jobs.enqueue(createPersonalizationJobEnqueue({ kind: "personalization.recover", payload: {}, runAfter: now }))`. It does not call `recover`, `runPersonalization`, or an LLM directly.

Fixed-kind active dedupe coalesces overlapping ticks. There is no article cron and no direct scheduled HN execution. Manual `mode=run` routes are explicit user operations and are the only HTTP direct-execution ingestion path.

At startup, after migrations and lease recovery but before claims/scheduler start, the service ensures one active public collection job, one active account reconciliation job when configured, and one active personalization recovery job using those same enqueue functions. It does not replay every missed wall-clock occurrence or execute missed HN work inline. Existing active jobs win through dedupe.

### 7.3 Worker, renewal, and drain

The service owns the only polling/execution lane. Startup repeats `recoverExpired()` until it returns less than `jobs.batch_size`, then starts polling. One loop claims and runs one job at a time; HTTP run-once and CLI run-once reuse the same runner rather than implementing a second dispatch path.

For each `{ status: "leased", job }` claim the runner:

1. retains the job ID and lease token after the claim transaction commits;
2. starts renewal at `max(1, floor(jobs.lease_ms / 3))` milliseconds using `systemSleep` and calls `renew` with the same ID/token before expiry;
3. awaits `readerApp.runJob(job, signal)` outside every database transaction;
4. stops renewal and calls `complete` on success, or `fail` with `readerAppJobFailure(kind, error)` on handler failure;
5. treats `lease-lost` as an expected stale-worker outcome without undoing committed effects, and treats other queue/database failures as infrastructure failures.

An idle poll waits `jobs.poll_interval_ms` through `systemSleep`. A rejected claim is logged with safe job ID/kind/code, returns no handler outcome, and lets polling continue without marking readiness failed. Poll, heartbeat, and grace waits are cancellation-aware. A worker-loop infrastructure failure marks readiness `worker-failed` and stops new claims. Expected handler failure does not stop the loop.

On shutdown the worker synchronously stops new claims, cancels idle polling, and keeps a cooperative active job leased while graceful drain proceeds. At the grace boundary it stops renewal and aborts the active operation; an unsettled lease is left for startup recovery. No final queue transition uses a stale token. External effects remain at-least-once.

## 8. Health, capabilities, and debug

### 8.1 Liveness, readiness, and capabilities

`GET /health/live` is unauthenticated and returns 200 `LivenessSnapshot`. It reads only the clock. If the event loop can answer, LLM, HN, article, SQLite, and worker state do not alter liveness.

`GET /health/ready` is unauthenticated and returns `ReadinessSnapshot`, with HTTP 200 only for `status="ready"` and 503 otherwise. Exactly four checks appear in this order:

1. **configuration:** loaded and valid, including mandatory secrets;
2. **sqlite:** the one connection is open, startup integrity passed, and a current lightweight read probe works;
3. **migrations:** the complete reader-store/job-queue migration sequence and checksum validation passed; a recorded `DatabaseError.migrationReason="checksum-mismatch"` maps to `migration-checksum-mismatch`, while the other migration reasons map to `migration-failed` without message matching;
4. **workers:** startup lease recovery is complete and the required worker loop is running.

Readiness never consumes LLM/HN/article inputs. During shutdown it becomes not ready before new work stops. Startup failures prevent the listener from advertising ready; later SQLite/worker failures change the corresponding check.

`GET /health/capabilities` is unauthenticated and returns 200 `CapabilitiesSnapshot`. Stored reading depends only on configuration/SQLite/migrations, background work also depends on workers, and integration states are copied from the latest service observations. An unconfigured HN account is disabled. An unprobed integration is unknown/`not-checked`, never available.

Startup LLM/public-HN/optional-account probes run asynchronously after local readiness and do not delay stored reading. There is no arbitrary article-origin startup probe; fresh-article state begins unknown and changes after actual article outcomes. `doctor` performs the same probes synchronously and reports their failures even though `start` remains ready.

### 8.2 Opt-in debug state and SSE

When `debug.enabled=false`, `/debug`, `/api/v1/debug/state`, and `/api/v1/debug/stream` return 404 and no debug navigation/drawer is rendered. The diagnostics `debug-disabled` guard remains a second boundary.

When enabled, `GET /api/v1/debug/state` requires the debug authentication/CSRF/origin checks and returns `DebugSnapshot`. Optional flat query names are `<section>.limit` and `<section>.after` for `syncRuns`, `jobs`, `llmCalls`, `recentErrors`, and `recommendationVersions`, plus `jobs.status` and `jobs.kind`. The service maps these to `DebugWindowQuery`; defaults and cursor rules remain diagnostics-owned.

`GET /api/v1/debug/stream` uses the same checks and the stream variants without `after`. It returns `text/event-stream`, disables buffering/compression, and maps each diagnostics frame to:

- event `debug-snapshot`;
- ID equal to the decimal frame sequence;
- data equal to the complete JSON `DebugStreamFrame`.

The first pull is immediate. Frames replace prior client state, have no queued catch-up burst, and contain no replay/resume guarantee. The service emits a comment-only heartbeat every 15 seconds and may send `retry: 3000`. Reconnect starts at sequence 1 with a fresh full snapshot; `Last-Event-ID` is ignored. Disconnect and shutdown abort the stream and call iterator `return()` without serializing the abort reason.

`debug.include_llm_payloads` independently controls capture and preview, defaults to false, and never relaxes secret redaction. The service passes it to `RecommendationPolicy.capturePayloads` and to diagnostics. Access/session/CSRF values, HN cookies/forms, API keys, raw errors, job payloads/tokens, article content, and arbitrary URLs/messages remain outside debug DTOs.

## 9. Static UI and design language

### 9.1 Static artifact and routes

The production browser application is Vite-built React 19 with MUI, TanStack Query, and React Router Declarative Mode. Fastify serves the compiled assets and SPA history fallback for `/`, `/queue`, `/stories/:storyId`, `/settings`, and, only when enabled, `/debug`. API, health, asset, and missing-file paths never fall through to the SPA. There is no SSR or separate UI server.

The design language is the system in `docs/architecture.md#design-language`: one central MUI theme/CSS variables, warm-paper light scheme plus dark/sepia schemes, 8px spacing, compact queue density, 19px/1.65 serif article body at 72ch, modest borders/radii, restrained motion, and visible focus. The primary components are `AppShell`, `QueueList`/`StoryCard`, `RecommendationReasonDrawer`, `ReaderView`, `PreferenceEditor`, `AuthPanel`, `HealthBanner`, `Empty/ErrorState`, and optional `DebugDrawer`.

TanStack Query owns server state and story-detail caching. React Router owns navigation. Ranking changes do not animate while scanning. Keyboard operation, semantic headings/lists, screen-reader labels, contrast, and reduced motion remain application acceptance requirements.

### 9.2 Sanitized article display and CSP

`ReaderView` inserts only `ArticleDto.sanitizedHtml` produced by article-reader/article-extractor. It never inserts raw HN `textHtml`, fetched source HTML, model output, or `textContent` as markup. Ordinary story/rationale/evidence values are rendered as escaped text. Original-page/HN-discussion navigation uses the supplied safe `originalUrl`, is user initiated, marks observation partial, and uses `noopener noreferrer nofollow` for a new tab.

Every HTML response uses this production CSP:

```text
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self' data:;
connect-src 'self';
media-src 'none';
object-src 'none';
frame-src 'none';
base-uri 'none';
form-action 'self';
frame-ancestors 'none'
```

The inline-style allowance supports MUI/Emotion; it does not permit inline scripts, remote article subresources, frames, objects, third-party scripts, or remote form targets. Sanitization is the primary article boundary and CSP is defense in depth.

## 10. Lifecycle and external integrations

### 10.1 Construction and startup

The exact ordered factory/migration sequence is normative in `arch.md`. Its required phases are:

1. load/validate configuration and secrets; create the redacting logger;
2. open one SQLite connection, verify integrity, and apply `[...readerStoreMigrations, ...jobQueueMigrations]` globally;
3. create the shared store and queue with all eight codecs;
4. create the general HTTP client, dedicated account HTTP client when configured, HN/article/LLM adapters, access control, ingestion, personalization, and one reader-app;
5. create diagnostics, recover expired leases, and ensure durable startup recovery jobs;
6. register cron tasks, construct the worker and Fastify transport, start worker/scheduler, bind the listener, and mark local readiness;
7. start non-blocking capability probes.

`readerAppBootstrapRankVersion` itself is passed to ingestion. `systemClock.now` and a cryptographically random ID generator are passed to reader-app. The account client copies general HTTP policy except `retryPolicy.maxAttempts=1`; account GET and POST therefore make no hidden retry, and account throttling counts actual wire attempts.

### 10.2 Startup and request cancellation

A service-owned operation controller links startup probes, HTTP work, direct operations, and active jobs. Startup failure aborts admitted work and cleans up only resources already constructed, in reverse order. Request cleanup removes all signal listeners. No SQL transaction contains an external call, timer, secret read, or Promise.

### 10.3 Shutdown and reverse-order close

Shutdown starts on SIGINT/SIGTERM or fatal local infrastructure failure and runs once:

1. mark readiness not ready and initiate Fastify close immediately to stop new HTTP connections/work, retaining its close Promise;
2. close debug SSE iterators and cancel/drain background capability probes;
3. stop scheduler admission/drain admitted enqueue callbacks and stop worker polling/claims;
4. gracefully drain in-flight HTTP/job work within `server.shutdown_grace_ms`, then cancel remaining cooperative work and stop lease renewal;
5. after all database users settle, complete the already-initiated Fastify close, close the dedicated account HTTP client, the general HTTP client, and SQLite in reverse ownership order; the LLM adapter has no per-client close because the pinned SDK uses the process-wide fetch dispatcher, so all its admitted operations are first cancelled/drained and process exit is the final dispatcher cleanup boundary;
6. leave synchronous stdout logging to process exit; there is no logger flush/close API.

A non-cooperative operation is never allowed to trigger SQLite close while it can still write. Forced cleanup failure exits nonzero and makes no clean-drain claim. The complete resource-by-resource order and partial-startup variants are in `arch.md`.

## 11. Headless CLI

Before the root logger exists, every command reports configuration/secret-file/CLI failures through a service-owned fallback that writes one fixed-shape NDJSON `personal-reader.startup.failed` record to stderr. It contains only level, time, service, message, and safe issue/check keys. After root construction, normal structured logs use the logger's synchronous stdout contract. Neither path emits raw errors, loaded objects, secrets, or secret-file contents.

### 11.1 `personal-reader start`

Validates all required configuration/secrets and runs the full service. Invalid local startup exits 1. A clean signal-driven shutdown exits 0 only if required cleanup succeeds. External capability failure alone does not make readiness fail or force exit.

### 11.2 `personal-reader doctor`

Uses the same config/secret loader, opens the same single connection, runs integrity and the same ordered migration function, constructs adapters, and closes in reverse order. It may apply pending migrations; there is no second migration implementation. It does not bind a listener, recover leases, enqueue recovery work, start cron, or start a worker.

Doctor awaits a minimal structured `purpose="connection-check"` LLM request with `capturePayload=false`, a public-HN `maxItemId` read, and optional account `validateSession` without mutation. It persists every returned LLM attempt audit through `personalization.persistLlmAudits`, preserving the single audit mapping/reuse implementation and redacted payload policy. Article fresh-content capability is `not-checked` because no fixed article origin exists.

The command emits safe structured results through the service's NDJSON logging contract. Exit 0 means all local checks and configured external probes passed. Exit 1 means any local/probe/cleanup check failed. CLI usage errors exit 2. Output names safe keys/codes only and never contains a secret, raw response, arbitrary provider message, or secret-file content.

### 11.3 `personal-reader jobs run-once`

Uses the same full local construction and eight-codec worker runner but no listener, cron, startup recovery enqueues, or external health probes. It recovers expired leases and executes at most one eligible job. Exit 0 covers idle and completed attempts; exit 3 reports a leased handler failure recorded through job-queue; exit 4 reports expected finalization lease loss; exit 5 reports a committed claim-time poison rejection; exit 1 is local/infrastructure/cleanup failure; exit 2 is usage error. The command must be run while the normal service is stopped.

## 12. Deployment artifact and runtime dependencies

- Node `24.22.1` LTS line and the production workspace dependencies already declared.
- One local SQLite file through `better-sqlite3`; the parent directory must already exist.
- Official public HN Firebase API; optional authenticated HN HTML origin and secret cookie.
- One OpenAI-compatible LLM endpoint and API token.
- Arbitrary public article origins only through the SSRF-safe fetcher.
- A self-contained production workspace containing compiled ESM, Vite assets, SQL migrations, manifests, and the platform-appropriate `better-sqlite3` binary.
- HTTPS termination through a trusted reverse proxy for public/custom-domain deployment; proxy provisioning and CI/CD/container contracts are out of scope.

## 13. Acceptance-focused test expectations

Batch F tests use public service/library interfaces, real temporary SQLite, real process restart, local fake HN/API, HN/HTML, article, and OpenAI-compatible servers, a fixed clock plus separately scripted sleep/manual scheduler driver, and deterministic LLM outputs. No live HN/provider is required. Runtime test execution is outside this documentation-only change, but these are the implementation acceptance suites.

### 13.1 Composition, configuration, and storage

- Prove exact construction order, manifest dependency preservation, one store/queue connection identity, and no factory I/O before its documented phase.
- Cover every command mode without `auth.access_token_path`, one-sided HN settings, loopback/non-loopback origin rules including a loopback bind with non-loopback HTTP public origin rejection, invalid defaults/cross-field rules, and every `systemSleep` bound.
- Build the root schema through config's exported `z`. Put secret sentinels in values, unknown keys, custom schema messages, file errors, provider errors, and logs; assert safe issue keys/codes and no sentinel/path-content disclosure.
- Cover each `DatabaseError.migrationReason`, exact checksum/readiness mapping, and no message-based classification or second migration inspector.
- Register issued session/CSRF sentinels after root construction, prove later logs/snapshots/frames redact them, remove them on logout and prune them on expiry, and assert provider failure emits no unredacted record/frame.
- Verify integrity/migration ordering, atomic resume, checksum failure, one connection across auth/diagnostics/workers, and readiness before/after each local gate.

### 13.2 Authentication and HTTP DTOs

- Use delayed async authentication/CSRF operations to prove hooks await them, fail closed, and do not confuse crypto/store failure with an auth miss.
- Assert cookie attributes, exact origin/CSRF checks, logout revocation, independent sessions, and raw-CSRF-loss re-login with no recovery response or old-session revocation claim.
- Golden-test every request/response DTO and exact optional-key behavior. Assert queue `items` align entry/story IDs and arrive from one facade page without N+1 story-detail requests. Assert raw HN envelopes/HTML, article text/errors, queue errors, job payloads/dedupe/lease tokens, HN idempotency keys/raw results, sessions/hashes, and provider errors never escape.
- Verify queue `evaluationState`/`visibilityState`, recommendation `afterId`, activity `clientEventId` plus independent `afterEventId`/`afterSessionId`, and HN history `afterId`. Reject old aliases, unknown/cross-story IDs, and interchanged event/session continuations before storage work.
- Assert request IDs correlate header/body/logs, all status mappings, no raw abort reason, and expected HN failed/indeterminate outcomes remain HTTP 200 result DTOs.

### 13.3 Scheduling, worker, and run-once

- Assert the exact ordered eight-codec registry and absence of `hn.public.collect`/`hn.account.reconcile`. Assert task names and `expression=ingestion.cron`/`expression=personalization.cron`. Fire manual cron triggers and prove only `scheduleIngestion`, optional `scheduleHnReconciliation`, and recovery enqueue occur; fake HN/LLM journals stay empty until a worker claim.
- Prove overlapping ticks dedupe, startup recovery enqueues without inline execution, and no scheduler start performs immediate catch-up.
- Execute every kind through the real worker with deferred handlers. Verify renewal before expiry, same-token complete/fail, safe failure mapping, stale-lease handling, retry/backoff, exhausted jobs, and recovery batches larger than `batch_size`.
- Run HTTP and CLI run-once against idle, success, retryable-failure, terminal-failure, poison, and lease-loss cases. Compare their dispatch/finalization with polling, assert fresh safe post-attempt DTOs only for the same leased attempt, and check exact idle/rejected/failed/lease-lost outcomes and CLI exits including rejected=5. Verify rejected poison attempts remain unchanged and polling continues. Exercise CLI only after stopping the normal service; no concurrent-writer detection or support is claimed.

### 13.4 Health, probes, and debug

- Independently fail configuration, SQLite, integrity, migrations, and workers; assert exact readiness checks/statuses. Fail LLM, public HN, account, and article origins separately and prove stored reading remains available while only the corresponding capability degrades.
- Verify startup probes do not delay ready, begin unknown/`not-checked`, persist every connection-check audit without payloads, and never expose provider messages. Verify doctor reports the same failure synchronously with nonzero exit and no listener/jobs/schedules.
- With debug disabled assert UI/API/SSE 404/removal. With it enabled assert auth/CSRF/origin on snapshot and stream, exact bounded DTO keys/cursors, fetch-based SSE headers/framing/heartbeat, immediate full first frame, reconnect sequence reset, no catch-up queue, and disconnect/shutdown iterator cleanup.
- Test payload capture/visibility independently and secret sentinels in every output family; enabling capture never enables secret or failed-provider-response disclosure.

### 13.5 UI, article safety, lifecycle, and workflows

- Playwright drives login, queue paging/detail caching, story reading, explanation, preference correction, HN confirmation/outcome, original-page fallback, and optional debug drawer using DOM/ARIA state rather than screenshots alone.
- Exercise malicious article/HN HTML and assert scripts/forms/frames/remote subresources cannot execute or load, only sanitized markup reaches `ReaderView`, external navigation is explicit, and CSP is present on every HTML response. Check keyboard/focus/contrast/reduced-motion behavior in Chromium and release compatibility in Firefox/WebKit.
- Start on an ephemeral port, restart real processes, and prove queue/activity/preferences/cursors/job outcomes survive. Inject startup failure at every construction phase and assert reverse partial cleanup with no SQLite close ahead of active users.
- During shutdown prove readiness fails first, no new HTTP/cron/claims arrive, SSE and idle sleeps close, active work drains within grace, cancellation is cooperative at the boundary, clients close before SQLite, and forced/non-cooperative cleanup exits nonzero without a false success claim. Assert all LLM operations settle before adapter disposal and make no unsupported per-client socket-close claim; process exit releases the process-wide dispatcher.
- Re-run WF-01 through WF-08 through public HTTP/debug/browser surfaces: collection continuity, complete mixed-version queue reachability, cached reading/activity idempotency, HN uncertain outcomes, preference correction, restart recovery, and redacted diagnostics.

## 14. Resolved composition boundaries

The service composes public owner APIs without new dependency edges or replacement algorithms: config supplies `z`; database supplies `migrationReason`; logging/diagnostics share the service secret provider; reader-app supplies aligned batch story details; job-queue distinguishes leased/rejected/idle claims. The pinned OpenAI SDK has no per-client disposal API and the adapter owns no private dispatcher, so cancellation/drain plus process exit is the explicit LLM resource boundary rather than a fictitious close method. [arch.md](arch.md#resolved-composition-boundaries) records these boundaries and their verification expectations.
