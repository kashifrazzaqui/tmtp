# Personal Reader Architecture

## 1. Architectural role

`services/personal-reader` is the tier-5 composition root for the single-user product. It owns configuration/secret loading, one SQLite connection and global migrations, concrete external adapters, Fastify transport, static React assets, authentication hooks, HTTP DTO projection, cron callbacks, worker polling/leases, run-once, capability probes, SSE transport, CLI behavior, cancellation, and shutdown.

`reader-app` remains the only application command/query/job-handler facade used by HTTP, cron, and workers. The explicit composition exceptions are durable recovery enqueue through `createPersonalizationJobEnqueue` plus `JobQueue.enqueue`, and probe-audit persistence through `personalization.persistLlmAudits`; neither duplicates a reader-app business operation. No HTTP route or cron callback calls a lower-library business operation directly. Lower libraries keep their domain algorithms and transactions. The service composes public APIs rather than duplicating queue ranking, activity reduction, profile construction, recommendation/audit mapping, article extraction, account parsing, payload validation, or SQL.

```text
CLI / signals
     |
configuration + secrets + lifecycle
     |
one SQLite <--> ReaderStore + JobQueue (eight reader-app codecs)
     |
concrete HN/article/LLM/access adapters
     |
HnIngestion + Personalization + ReaderApp
     |
worker runner ---- scheduler (enqueue only)
     |
Fastify auth/DTO/routes ---- Diagnostics ---- SSE
     |
static Vite/React/MUI assets
```

There is one writer object graph in one process. Independent service instances or CLI writers against the same database are outside the concurrency contract. No module in this service adds a package dependency edge.

## 2. Private module decomposition

These are package-private organizational units, not public package subpaths or new libraries:

| Module | Responsibility | Must not contain |
|---|---|---|
| `cli` | Command parsing, exit codes, start/doctor/run-once selection | A second composition path |
| `config` | Raw-value assembly, strict root schema, deployment refinements, resolved config types | Secret-file contents or component-local reads |
| `secrets` | Secret-file loading, validation handoff, bounded active-session redaction registry/provider | Logging values, CSRF recovery, or persisting secrets |
| `composition` | Ordered factories, resource stack, one object graph | HTTP routes or domain algorithms |
| `storage` | One database, integrity, global migrations, store/queue identity, startup lease recovery | Per-request connections or lazy migrations |
| `http-adapters` | General and dedicated account clients, public HN/account/article fetch construction | Account GET retries or arbitrary article policy |
| `application` | Ingestion, personalization, access, reader-app, diagnostics construction | Listener, timer, or schedule ownership in libraries |
| `recovery` | Startup public/account/personalization enqueue guarantees | Direct HN/LLM execution or wall-clock tick replay |
| `worker` | Poll, one-job execution lane, heartbeat, finalization, run-once, drain | Handler-specific effects or payload codecs |
| `schedules` | Two named cron definitions and enqueue callbacks | Direct scheduled external work |
| `probes` | LLM/public-HN/account checks, audit persistence, integration-state observations | Readiness gating on external state |
| `http` | Fastify setup, request IDs, cancellation links, safe errors, body/query validation | Raw framework error/request serialization |
| `auth` | Awaited login/authenticate/logout/CSRF hooks, cookies, origin policy | Synchronous auth assumptions or CSRF recovery |
| `dto` | Explicit request parsing and response allowlists | Domain-record spread/pass-through |
| `routes` | Route-to-reader-app/owner calls and status selection | Business transactions or HN form handling |
| `health` | Local readiness inputs and capability snapshots | External dependencies in liveness/readiness |
| `debug-transport` | Debug gates, snapshot queries, SSE framing/heartbeat/iterator registry | Authentication bypass or replay buffer |
| `static` | Compiled asset serving, constrained SPA fallback, CSP | SSR, API fallback, unsanitized markup |
| `ui` | React routes, MUI theme/components, Query cache, activity and debug clients | A parallel design system or remote article execution |
| `lifecycle` | Operation controllers, grace, signal handling, reverse close | SQLite close ahead of active users |

Each module has one responsibility. Shared service behavior such as safe error mapping, secret registration, operation cancellation, and run-once has one implementation used by every entry point.

## 3. Resource and ownership table

| Resource | Creator / owner | Close or drain behavior |
|---|---|---|
| Configuration/startup secrets and active-session redaction registry | Service | Prune on provider snapshots, remove on logout, discard after final process logging; never persist |
| Root logger and children | Service | Synchronous stdout; no flush/close API and stdout is never closed by a library |
| SQLite `Database` | Service storage module | Idempotent `close()` only after every store/queue user drains |
| `ReaderStore`, `JobQueue` | Service | Borrow the same database; no independent close |
| General `HttpClient` | Service | `close()` after public-HN/article operations settle |
| Dedicated account `HttpClient` | Service when account configured | `close()` after account operations settle; separate retry policy and pool |
| Public HN/account/article-reader wrappers | Service | No close; their borrowed clients are service-owned |
| OpenAI-compatible LLM port | Service adapter; global fetch dispatcher is process-owned | Cancel/drain admitted operations; no per-client close in pinned SDK, process exit releases dispatcher |
| Access control | Service | No close; sessions remain in reader-store as hashes |
| Ingestion/personalization/reader-app | Service | No close; cancel/drain admitted operations |
| Scheduler | Service | `stop()` prevents triggers and drains admitted enqueue callbacks |
| Worker | Service | Stop claims, cancel idle sleep, renew/drain/cancel active job by grace policy |
| Diagnostics | Service | No global close; each debug iterator is transport-owned |
| Fastify listener | Service | Stop admission and drain requests; static/cookie plugins borrow this lifecycle |
| SSE iterators/controllers | Service debug transport | Abort, call `return()`, remove from registry on every settlement |
| Capability probes | Service | Abort through operation controller; persist already-returned LLM audits before close |

A resource is closed only by its owner. No borrowed library is asked to close another library's database, HTTP client, logger, scheduler, worker, or abort controller.

## 4. Exact construction and startup order

The following order is normative for `start`. Doctor and run-once use explicit subsets in section 13. A failure at any step aborts already-admitted work and runs the applicable reverse cleanup from section 12; it never continues with a partial graph.

### Phase 1 — configuration, secrets, and logging

1. Parse the command and load raw non-secret configuration. Import `z` from `@tmtp/config` and compose the strict synchronous root schema from owning fragments plus service deployment refinements; no undeclared Zod import is used.
2. Call `parseConfig` once, emit only safe issues, and call `assertValidConfig`. Do not open a resource on failure.
3. Load `auth.access_token_path` and `llm.api_key_path`, and `hn.session_cookie_path` only when the paired account settings exist. Create the redaction registry with these startup values and `systemClock`. Owning factories validate these values at their construction steps below; the service does not create a second secret-validation algorithm.
4. Create one root logger with `level=logging.level`, `service="personal-reader"`, and the registry's `secretValuesProvider`. Create child loggers with fixed component names only. Each emitted log record obtains one current provider snapshot; later login values therefore need no logger reconstruction.

### Phase 2 — one database and global migrations

5. Call `openDatabase` with `path=database.path`, `busyTimeoutMs=database.busy_timeout_ms`, and `wal=database.wal`. This is the process's only connection.
6. Call `integrityCheck()` and require `ok=true`. On failure, record `integrity-check-failed` and close this connection without constructing repositories.
7. Call `migrate(database, [...readerStoreMigrations, ...jobQueueMigrations])` once. The global order is `0010_reader_foundation`, then `0020_job_queue`; the database owns the ledger. Do not migrate lazily in any repository or request.
8. Require a lightweight SQLite read probe. Record migration success/readiness inputs without exposing SQL, paths, parameters, or driver messages.
9. Call `createReaderStore(database)` once. Every access-session, reader, ingestion, personalization, and diagnostics repository uses this instance.

### Phase 3 — queue and concrete adapters

10. Call `createJobQueue` with the same database, `systemClock`, `readerAppJobCodecs`, and the resolved lease/retry/backoff/batch policies. All eight codecs are registered before any enqueue or claim.
11. Create the general HTTP client with `systemClock`, `systemSleep`, `http.timeout_ms`, `http.user_agent`, the complete configured GET retry policy, and an HTTP child logger. It is shared only by public HN and article fetching.
12. If account settings exist, create a separate account HTTP client with the same options except `retryPolicy.maxAttempts=1` and an account HTTP child logger. No account operation uses the general client. POST remains single-attempt independently.
13. Construct adapters in this exact order, with no probe or network call:
    1. `createHnPublicApi({ baseUrl: hn.api_base_url, http: generalHttp })`.
    2. When configured, `createHnAccount` with `baseUrl=hn.web_base_url`, the dedicated account client, `systemClock`, `systemSleep`, exact `hn.username`, loaded cookie, `hn.max_requests_per_minute`, and `hn.flag_readback_enabled`.
    3. `createArticleFetcher` with the general client, `systemClock`, `systemSleep`, `article.timeout_ms`, `article.dns_timeout_ms`, `article.max_response_bytes`, `article.max_redirects`, `article.allowed_protocols`, and `article.allowed_ports`; omit the resolver in production.
    4. `createArticleReader` with that fetcher, `maxContentChars=article.max_content_chars`, `maxInputBytes=article.max_response_bytes`, and `now=systemClock.now`; omit the extraction seam in production.
    5. `createOpenAiCompatibleLlm` with `baseUrl=llm.base_url`, exact loaded API key, `llm.timeout_ms`, `llm.max_retries`, and `llm.max_output_tokens`. The model is not a factory option.
14. Create access control with the loaded access token, `store.accessSessions`, `systemClock`, and resolved session/login policies. Construction performs no login, session creation, timer, or I/O.

### Phase 4 — application compositions

15. Create one `HnIngestion` with the public API, optional account, shared store/queue, `systemClock`, `bootstrapRankVersion=readerAppBootstrapRankVersion`, and resolved feeds/lookback/run/refresh policies. The callback itself is passed and invoked once by ingestion; its literal value is not copied by the service.
16. Create one `Personalization` with shared store/queue, the LLM port, exact `llm.model`, `systemClock`, resolved batch sizes, and these policy mappings:

| Option | Source |
|---|---|
| `activityPolicy.idleTimeoutMs` | `activity.idle_timeout_ms` |
| `activityPolicy.minDwellMs` | `activity.min_dwell_ms` |
| `activityPolicy.maxSessionGapMs` | `activity.max_session_gap_ms` |
| `interestPolicy.decayHalfLifeDays` | `interests.decay_half_life_days` |
| `interestPolicy.maxInferredTopics` | `interests.max_inferred_topics` |
| `interestPolicy.maxActivityEvents` | `interests.max_activity_events` |
| `recommendationPolicy.batchSize` | `recommendations.batch_size` |
| `recommendationPolicy.maxStoriesPerRun` | `recommendations.max_stories_per_run` |
| `recommendationPolicy.maxPromptChars` | `recommendations.max_prompt_chars` |
| `recommendationPolicy.explorationRatio` | `recommendations.exploration_ratio` |
| `recommendationPolicy.capturePayloads` | `debug.include_llm_payloads` |
| `activityBatchSize` | `personalization.activity_batch_size` |
| `queueSyncBatchSize` | `personalization.queue_sync_batch_size` |

17. Create one `ReaderApp` with the same store/queue, article reader, ingestion, personalization, optional account, `queuePageSize=queue.page_size`, `queueMaxPageSize=queue.max_page_size`, `now=systemClock.now`, and a cryptographically random application ID generator. There is no second application facade or direct lower-library command/query HTTP route. The personalization recovery enqueue exception in section 1 remains service composition, not a second business facade.
18. Create diagnostics with the same store/queue, `systemClock`, `systemSleep`, the identical registry `secretValuesProvider`, and resolved debug policy. Every snapshot/stream frame uses one fresh provider snapshot consistent for that complete emitted unit. Create the service integration-state registry with every integration initially unknown/`not-checked`, except an absent account which is unconfigured/`not-configured`.

### Phase 5 — recovery and service surfaces

19. Before any claim, call `recoverExpired()` repeatedly until it returns less than `jobs.batch_size`. Each call is bounded; no handler runs during this recovery.
20. Ensure startup recovery work in this order: `readerApp.scheduleIngestion()`, `readerApp.scheduleHnReconciliation()` only when configured, then recovery enqueue through `createPersonalizationJobEnqueue` and `jobs.enqueue`. All three use current `runAfter`; active dedupe retains earlier work. No external method executes here.
21. Construct the worker runner over the same queue/reader-app and supported-kind list. Construct the scheduler with `systemClock`, the scheduler child logger, `scheduler.timezone`, and `scheduler.overrun_protection`. Register `{ name: "ingestion.cron", expression: ingestion.cron }` first and `{ name: "personalization.cron", expression: personalization.cron }` second, with the callbacks in section 6 and scheduler defaults for the other task fields.
22. Construct Fastify with `trustProxy=server.trust_proxy`, the 1 MiB body limit, service request IDs, safe error hooks, unsigned cookie support, routes, debug transport, and static assets. The opaque random session needs no cookie-signing secret. All routes are registered before listen; disabled debug routes are absent/404.
23. Start the worker loop and mark its state running only after its first polling iteration is armed. Start the scheduler; scheduler start performs no immediate task. Start order is worker, then scheduler.
24. Bind `server.host`/`server.port`. Only after configuration, SQLite, migrations, and workers are ready does `/health/ready` return ready. Record the actual bound port for loopback logs/harness discovery without logging secrets.
25. Launch LLM/public-HN/optional-account capability probes asynchronously with the service operation signal. Do not await them before serving stored reads or advertising local readiness. Article capability remains unprobed until real work supplies evidence.

No factory above secretly performs the next phase. In particular, constructors do not authenticate HN, call an LLM, open another database, start a timer, or register global process handlers.

## 5. Storage and readiness state

### 5.1 Connection and transaction boundary

Store and queue receive the identical `Database` object, so nested queue enqueues join outer store transactions as savepoints. Every external HN/article/LLM call and every Promise occurs outside these transactions. The service never opens a separate connection for access sessions, diagnostics, run-once, or doctor.

A synchronous transaction is not interrupted by abort. Request/worker cancellation is checked before and after composition stages; commit is the write's linearization point. Closing the database is forbidden until every admitted operation that can use it has settled.

### 5.2 Local readiness inputs

The service holds four independent check states:

- **configuration:** starts not-loaded, becomes invalid on safe validation/secret failure, then ok only after complete resolved config and secrets.
- **sqlite:** starts unavailable, becomes integrity-failed or database-unavailable on the corresponding failure, then ok after integrity and read probes. A later `isOpen=false` or failed read probe makes it unavailable.
- **migrations:** starts pending, becomes ok only after the complete global migration call succeeds. `DatabaseError.migrationReason="checksum-mismatch"` maps to `migration-checksum-mismatch`; `invalid-order`, `sql-failed`, and `invalid-migration` map to `migration-failed`. No message matching or second ledger query is used.
- **workers:** starts starting, becomes ok after lease recovery and loop start, stopped during shutdown, and failed after an unrecovered polling/heartbeat/queue infrastructure failure.

Readiness is a pure diagnostics fold over these inputs. It performs no external probe and does not wait for the integration registry. Stored-reading capability ignores worker state; background-work capability includes it.

A full integrity check runs at startup, not on every readiness request. Ready requests use `isOpen` plus a lightweight read probe. Migration readiness is the recorded result of the startup global migration/checksum pass; there is no second SQL ledger implementation in the service.

## 6. Scheduler and durable recovery

### 6.1 Cron callbacks

The ingestion task calls the two reader-app scheduling methods, not `runIngestion` or `reconcileHnAccount`. It attempts public enqueue and configured account enqueue independently so one local enqueue failure cannot prevent the other attempt. After both settle, it returns success or throws a fixed safe task failure for the scheduler to contain. Fixed-kind active dedupe makes concurrent/duplicate ticks harmless.

The personalization task calls only the owner enqueue factory and `jobs.enqueue` for `personalization.recover`. It never calls `runPersonalization` or `recover` in the callback. Cron callbacks use the service operation signal so forced shutdown can prevent a not-yet-started enqueue stage; synchronous SQLite enqueue itself cannot be interrupted.

Both tasks use scheduler defaults for timezone and overrun protection. Protected skipped occurrences are dropped; durable active jobs and startup recovery provide continuity rather than an in-memory missed-tick backlog.

### 6.2 Startup recovery policy

The scheduler has no durable last-run table and performs no catch-up. The service therefore ensures one current logical job of each periodic kind after lease recovery and before claims. It does not infer a series of missed occurrences, compare arbitrary run timestamps, or perform direct work. One active job per periodic kind is sufficient because each execution reads current durable cursors/profile state.

The old names `hn.public.collect` and `hn.account.reconcile` have no place in this design. Public/account scheduling produces `ingestion.collect` and `ingestion.reconcile-account`; personalization scheduling produces `personalization.recover`.

## 7. Worker and run-once state machine

### 7.1 One execution lane

The worker owns an asynchronous single-flight lane. The polling loop and HTTP run-once call the same `runNext` operation through that lane; a manual request cannot run concurrently with a poll-selected job. CLI uses the same operation in its own stopped-service process. The lane has states `idle`, `claiming`, `running`, `stopping`, and `stopped`.

The supported kind list is derived once from `readerAppJobCodecs` in registry order. No route or CLI argument accepts an arbitrary kind/payload. This keeps run-once deterministic and prevents it from becoming an unauthenticated code/job-injection surface.

### 7.2 Claim, heartbeat, and finalization

`runNext` performs the following transitions:

1. If stopping/stopped, return a safe workers-stopped error. Otherwise claim one eligible job and branch on `JobClaimResult.status`: `idle` returns `{ outcome: "idle" }`; `rejected` returns `{ outcome: "rejected", job }` after its invalid-payload terminal transition has committed, with no handler/heartbeat/finalization; only `leased` continues below. Polling logs a rejected job's safe ID/kind/code and continues without treating it as infrastructure failure.
2. Capture the leased job's ID/token after the synchronous claim commits. Create a job controller linked to the service operation controller and a separate heartbeat controller.
3. Start the heartbeat at `max(1, floor(leaseMs/3))`. Each heartbeat waits through `systemSleep`, then synchronously calls `renew(id,token)`. Renewal does not increment attempts. The next wait begins only after the previous renewal settles.
4. Invoke `readerApp.runJob(job,jobSignal)` and await it. No handler calls lease methods.
5. When the handler settles, stop heartbeat admission and cancel its pending sleep before finalization. Await any already-admitted renewal so it cannot race finalization.
6. On success, call `complete(id,token)`. On handler error, compute only `readerAppJobFailure(kind,error)` and call `fail(id,token,failure)`. Then stop the heartbeat task completely. After a same-token finalization succeeds, re-read the job for run-once output.

A renewal `lease-lost` aborts the job with a private service reason and is treated as an expected stale-worker result. The eventual stale complete/fail is not retried and does not undo application effects. Run-once then returns `{ outcome: "lease-lost", jobId, kind, handlerOutcome }` with no re-read snapshot, because a newer attempt may already own that record. A different renewal/claim/finalization database or queue infrastructure failure marks the worker failed, stops new claims, and is not passed through a handler-failure mapper.

A caller cancellation reason never enters the jobs table. Reader-app normalizes job cancellation to safe retryable `cancelled`; an HN post-dispatch outcome still follows reader-app's durable indeterminate protocol.

### 7.3 Idle polling and failure containment

When no job is eligible, the poll loop waits `jobs.poll_interval_ms` with `systemSleep` and its worker signal. Ordinary handler failure is recorded and the loop continues. A failed required polling/sleep/database operation marks `worker-failed` and stops claims rather than spinning or pretending background work is ready.

### 7.4 Drain and forced cancellation

Worker stop synchronously disables new claims and cancels idle polling. If a job is active, heartbeat renewal continues during graceful drain so its lease does not expire merely because shutdown began. At the global grace boundary, heartbeat stops and the job controller aborts. The worker waits for cooperative settlement before allowing HTTP clients/SQLite to close.

If the handler does not settle, the job remains leased with no renewed expiry and is recovered after a later restart. The service reports forced/non-clean shutdown and never closes SQLite while that handler can still write. At-least-once replay, not exactly-once external behavior, is the recovery guarantee.

## 8. HTTP, authentication, and DTO composition

### 8.1 Request pipeline

Each API request passes through these stages:

1. assign the service request ID and create a request controller linked to client disconnect and service forced cancellation;
2. validate route/path/query/body at the transport boundary;
3. for protected routes, await session authentication; for mutation/debug routes, await CSRF and apply origin policy;
4. call the exact reader-app/owner operation from `spec.md` with the linked signal;
5. map the result through its explicit DTO allowlist and select the documented status;
6. remove disconnect/shutdown listeners and consume expected cancellation of request-local sleeps.

Unexpected lower errors pass through one safe error mapper. Only stable code/retryability/allowlisted correlation fields survive. The service does not expose Fastify's default error object, library `cause`, stack, parser text, provider body, or raw abort reason.

### 8.2 Authentication sequencing

Login token verification and digest operations are asynchronous. The auth module awaits every access-control call; a synchronous-looking store port does not justify synchronous HTTP hooks. Authentication uses the fresh snapshot returned by `authenticate` for CSRF verification and does not treat CSRF verification as a second revocation lookup.

The cookie module sets only the opaque session cookie from `IssuedSession.opaqueSession`. The login JSON carries only `expiresAt` and `csrfSecret`. Immediately after successful login, the redaction registry stores both raw values with `expiresAt`; successful logout removes that presented session's entry, and every provider snapshot prunes entries whose expiry has passed. The registry is keyed by opaque session for exact removal and returns a fresh array to each logging/diagnostics serialization call. Its provider is total and non-throwing under the service lifecycle; a provider-contract failure fails closed rather than emitting an unredacted record/frame. No timer, persistence, response DTO, or CSRF recovery path reads this registry. Session inspection reports hash presence as `csrfState="stored"`, never a recoverable value. Losing browser CSRF state starts a fresh login; no rotation route or hidden recovery exists.

Origin enforcement remains exact for every mutation and logout. Debug GET/SSE alone has a browser-compatible fallback after session and CSRF verification: an absent `Origin` is accepted only with `Sec-Fetch-Site: same-origin`; absent metadata, other fetch-site values, and wrong explicit origins are rejected. This exception exists because browsers omit `Origin` on ordinary same-origin GET requests.

### 8.3 DTO ownership and story presentation

Transport DTOs are service-owned because reader-app is transport-free. They intentionally differ from persistence records where those records contain raw or unsafe fields. In particular, HN history normalizes only safe outcome evidence; jobs omit lease/payload data; story detail omits raw HN input and article error text; queue entries omit free-form errors.

Reader-app returns `storyDetails` in exact entry order from one batch story read in the same snapshot. The DTO module zips entries/details by index, verifies matching story IDs, and emits `QueueItemDto[]` with safe story/original-target/fallback projections. The browser renders those items directly and fetches full `StoryDetail` only when a reader opens a story; it performs no N+1 queue-card detail requests and no direct store reads around the facade.

## 9. Static UI and article trust boundary

### 9.1 UI data flow

The React application has declarative routes for auth, queue, story, settings, and optional debug. TanStack Query stores server responses and invalidates affected queue/detail queries after mutations; it does not become a second durable store. Queue cards consume batched `QueueItemDto` data directly; full story detail is cached only for opened stories. Session/CSRF state is client-session state only. Raw access tokens are discarded after login.

`QueueList` renders each `QueueItemDto.entry` with its aligned safe story/original-target data. `ReaderView` renders `StoryDto`, optional `ArticleDto`, exact linked recommendation, and safe fallback. `RecommendationReasonDrawer` uses the queue-linked recommendation, not an accidental latest-history substitution. `HealthBanner` uses readiness/capabilities without hiding stored reading because an integration failed. `DebugDrawer` exists only when enabled and authenticated.

The single MUI theme and component vocabulary follow `docs/architecture.md`. Service-specific UI code does not create a parallel card/button/drawer system or a second CSS token source.

### 9.2 Sanitized rendering

Fetched HTML crosses these boundaries in order:

```text
article-fetcher (hostile transfer/DNS policy)
  -> article-reader/article-extractor (inert DOM + Readability + sanitizer)
  -> reader-app conditional persistence
  -> StoryDetail cached query
  -> ArticleDto sanitizedHtml allowlist
  -> ReaderView + restrictive CSP
```

The browser never receives raw source HTML or raw HN self-text as markup. Text/rationale/evidence values use React escaping. The service CSP in `spec.md` blocks remote article subresources and all frames/objects/scripts outside the compiled self origin. Original-page navigation is a user action with partial observation quality, not an automatic redirect or iframe.

## 10. Probes and capability observation

### 10.1 Integration-state registry

The registry stores only diagnostics `IntegrationInput` values and safe observation timestamps. It has no raw error/response/body fields. Initial values are configured+unknown/`not-checked`; an absent account is unconfigured/`not-configured`. The registry updates after actual probes or operations, and diagnostics copies the latest values.

Representative mappings are:

| Evidence | Capability reason |
|---|---|
| Successful probe/operation | `ok` |
| LLM/provider/HN transport connection failure | `connection-failed` |
| LLM/HN/article deadline | `timeout` |
| Provider/HN rate limit | `rate-limited` |
| HN expired session or username mismatch | `authentication-failed` |
| Invalid structured LLM/HN/API response | `invalid-response` |
| Article fetch policy/transport/status failure | `fetch-failed` |
| Article extraction/empty/content failure | `extraction-failed` |

Shutdown cancellation does not fabricate a provider outage or overwrite a later observation. Local audit persistence failure is a local SQLite/readiness issue, not an LLM connection result.

### 10.2 LLM connection check and audit persistence

The service owns the connection-check request because the adapter has no health method. Its fixed non-secret request has:

- `purpose="connection-check"` and exact `llm.model`;
- instructions asking for the smallest valid connection acknowledgment;
- empty JSON object input;
- an object-root schema with one required boolean `ok` and no additional properties;
- synchronous output acceptance requiring exactly `ok=true`;
- `capturePayload=false` regardless of debug payload policy;
- the probe's cancellation signal.

On success, await `personalization.persistLlmAudits(result.attempts)`; on a conforming `LlmError`, await it with every `error.attempts` entry. Personalization's one audit writer owns the field mapping, first-observed `createdAt`, immutable reuse, conflict handling, and safe errors; the service has no second audit mapper and invents no attempt start/end timestamps.

All audit inserts for one settled probe occur in personalization's one short store transaction after the external call. No provider Promise runs inside it, and the probe does not wait for the profile pipeline mutex. A malformed nonconforming port error cannot be mined for hidden audits and becomes safe invalid-response capability evidence.

### 10.3 Public HN, account, and article observations

The public-HN probe is `maxItemId(signal)` and performs no ingestion/cursor write. The account probe is `validateSession(signal)`, with no mutation; capability details can be refreshed through `getHnCapabilities` without presenting unverified state as available. Article has no fixed health origin, so actual reader/job outcomes update fresh-article capability.

Start launches these probes after readiness and does not block stored reading on their latency/failure. Doctor awaits them and exits nonzero on failure. Probe attempts do not enqueue periodic work or advance ingestion cursors.

## 11. Debug/SSE transport

The debug transport owns a registry of active connection controllers and iterators. For each enabled/authenticated request it:

1. maps flat query parameters to `DebugStreamQuery` and creates a connection controller linked to disconnect/shutdown;
2. obtains `diagnostics.debugStream({ query, signal })`;
3. pulls one frame at a time and writes the exact event/ID/data mapping from `spec.md`;
4. sends comment heartbeats between frames without creating another diagnostics read;
5. on disconnect, write failure, shutdown, or iterator completion, aborts and awaits iterator `return()` in `finally`, then removes the connection from the registry.

There is at most one outstanding iterator pull per connection. The service does not add a frame queue, replay buffer, `Last-Event-ID` resume, global snapshot cache, or cross-section transaction. Reconnection creates a new iterator and full sequence-1 snapshot.

The browser uses fetch with the session cookie and `x-tmtp-csrf`, parses SSE incrementally, and replaces its debug state per frame. Native `EventSource` is not used because it cannot set the required header. Disabled debug returns 404 before invoking diagnostics; diagnostics' own `debug-disabled` check remains defense in depth.

## 12. Cancellation and reverse-order shutdown

### 12.1 Controllers and grace

The lifecycle owns a service operation controller, a worker controller, a separate background-probe controller, a shutdown-once state, and the global grace wait. HTTP disconnects and SSE streams have child controllers. There is no library-global abort controller.

SIGINT/SIGTERM or fatal local infrastructure failure starts shutdown once. Startup failure uses the same sequence for the resources that exist. Expected private shutdown reasons are never logged/serialized. `systemSleep` cancellation settles idle waits; it is not itself a failed job.

The grace bound covers the complete graceful phase, not a fresh timeout per resource. At its boundary the lifecycle stops renewal and aborts remaining cooperative HTTP/job/probe/stream work. It does not close a resource while a non-cooperative borrower can still use it.

### 12.2 Exact normal-shutdown order

1. Atomically mark readiness workers-stopped/not-ready, reject new run-once/work admissions, and initiate Fastify close immediately so no new HTTP connection/request is admitted during SSE/probe cleanup. Retain its close Promise while existing requests begin draining.
2. Abort and close every debug iterator; remove its listeners and heartbeat.
3. Abort background probes, await their cooperative settlement, and persist any already-returned LLM audit while the store remains open. Probe cancellation does not change integration health or cancel request/job work.
4. Await `scheduler.stop()` from outside any cron callback. This stops future triggers and drains admitted enqueue callbacks before their store/queue dependencies close.
5. Stop worker claims and idle polling. Keep active-job renewal during the remaining grace, then cancel at the boundary and await final handler/queue settlement.
6. Await the Fastify close Promise after request-linked application operations and SSE writes have settled. No new request can appear after this point.
7. If configured, await the dedicated account HTTP client's `close()`. It admits no new account request and closes its transport after active requests settle.
8. Await the general HTTP client's `close()` after public-HN/article requests settle.
9. Discard adapter/application/diagnostics references. The pinned OpenAI `7.45.1` client exposes no per-client close and this adapter creates no private dispatcher; its SDK/global-fetch transport pool is process-wide. All admitted LLM operations and per-attempt timers/signals have already settled, so no adapter work remains. Do not claim per-client socket closure: process exit is the explicit final cleanup boundary for the process-wide dispatcher.
10. Close the one SQLite database after every store/queue user has drained.
11. Emit the final safe shutdown log if possible. Logging is synchronous and has no buffered flush or close. Stdout remains process-owned.

Fastify admission closes first; SSE/probes, scheduler, and worker then drain; the already-initiated Fastify close completes before the account client, general client, and database close. This preserves reverse resource-use dependencies without admitting HTTP work during the earlier cleanup stages. Any error is remembered while later safe cleanup continues. The process exits nonzero if required cleanup fails or the grace expires without cooperative settlement; it never prints a clean-shutdown result in that case. After the final safe log, the redaction registry is discarded and process exit releases process-wide fetch resources.

### 12.3 Partial startup failure

Before listener start, omit absent stages but preserve the same dependency order: close every successfully constructed Fastify instance first (including after scheduler-start or bind failure), then stop a started scheduler/worker, close account/general clients that exist, then close SQLite if opened. Retain and await each Fastify close Promise while later safe cleanup continues. Configuration or secret-file read failure before root construction has no resources to close; later owning-factory secret validation cleans up every resource constructed so far. Migration/integrity failure closes only SQLite. A failed scheduler start is already stopped by that library; the service still drains any admitted service work before database close.

## 13. CLI composition variants

### 13.1 Start

Uses all 25 startup steps in section 4, including listener, cron, worker, and asynchronous probes. There is one OS-signal handler set owned by the lifecycle and removed on exit.

Before the root logger exists, CLI/start failures use a service-owned fixed-shape NDJSON stderr fallback with only level, time, service, message, and safe issue/check keys. This is the only non-root logging path; it never receives raw errors, loaded configuration, or secret values. Later failures and results use the root logger.

### 13.2 Doctor

Uses steps 1–18 for configuration/secrets/storage/adapters/application construction, but skips lease recovery, periodic recovery enqueues, scheduler, worker, Fastify, and debug streams. It runs the same ordered migration function, which may apply pending migrations, then performs the LLM/public-HN/optional-account probes synchronously. It persists LLM probe audits and reports article as not checked.

Doctor closes clients/database in reverse order even after probe failure. Its result is safe NDJSON through the existing logger; exit codes are defined in `spec.md`. No listener port is opened and no job is claimed, recovered, enqueued, or executed.

### 13.3 Jobs run-once

Uses steps 1–18 and expired-lease recovery, then constructs only the worker runner. It deliberately skips periodic recovery enqueues, cron, listener, and health probes. It invokes one `runNext`, emits the safe idle/rejected/completed/failed/lease-lost result, and closes HTTP clients/database in reverse order. Rejected poison uses CLI exit 5 and no handler-attempt description.

The operator must stop the normal service first. There is no lock or multi-process writer protocol in the current libraries, so the CLI does not claim safe concurrent operation against a live instance.

## 14. Test seams and verification design

The service composition root accepts test-only structural replacements at its own boundary, not new public library APIs:

- temporary SQLite path and real migrations/repositories;
- `createFixedClock` plus a separately scripted `Sleep` for worker, account, diagnostics, and grace waits;
- manual `SchedulerDriverFactory` for exact cron triggers;
- injected `HttpTransport`/local fake servers for request journals and failure phases;
- deterministic LLM responses and connection-check audits;
- deferred handlers to control lease, cancellation, drain, and shutdown order;
- ephemeral Fastify port and real browser/API clients.

A construction journal records factory/open/start/close order and proves store/queue connection identity and account retry policy without exposing private library state. A resource journal proves no client/database close precedes active borrower settlement. Fake server journals assert cron/probe behavior without using private module internals.

Acceptance suites are enumerated in `spec.md`. The key integration layers are:

1. **Composition/config:** root validation, secret safety, exact factory inputs/order, global migrations, and command subsets.
2. **HTTP/auth/DTO:** awaited auth, cookie/CSRF/origin, golden DTOs, independent history pagination, status/error safety, and request cancellation.
3. **Worker/schedules:** eight kinds, enqueue-only cron, recovery, heartbeat/finalization/stale leases, run-once equivalence, and drain.
4. **Health/debug:** local readiness, external degradation, audit capture/redaction, SSE framing/auth/backpressure/closure.
5. **Browser/security:** static routes/design language, sanitized article rendering/CSP, accessible workflows, and optional debug.
6. **Process/restart:** real restart durability, startup failure cleanup, signals, grace, reverse close, and CLI exit behavior.

No test uses a mock database to establish SQL/transaction behavior, a fake active-only session repository, real wall-clock waits for lease/scheduler correctness, or screenshots as a substitute for DOM/API assertions.

## 15. Resolved composition boundaries

The lookahead findings are resolved by owner contracts or an explicit verified ownership decision; no service-side replacement algorithm or new package edge remains.

### Root schema composition

`@tmtp/config` publicly re-exports `z` from its existing Zod dependency. The service constructs strict synchronous/static-path schemas with that value and still calls `parseConfig`/`assertValidConfig`; no transitive `zod` import, product registry, or second validator is introduced.

### Migration error discrimination

`DatabaseError.migrationReason` distinguishes checksum mismatch from invalid order, invalid migration definitions, and SQL failure. Readiness maps the recorded startup `migrate` outcome; no non-mutating inspector or second checksum implementation is needed.

### Runtime secret inventory

Logging and diagnostics accept the same service `secretValuesProvider`, evaluated once per emitted record/snapshot/frame. The registry holds startup secrets plus active login-issued opaque/CSRF values, removes them on successful logout, and prunes them at expiry. Raw-CSRF loss still requires login; the registry is never a recovery interface.

### Batch queue presentation

`ReaderQueueResult.storyDetails` is entry-aligned and loaded with one `stories.byStoryIds` call in the queue snapshot. The service projects safe `QueueItemDto[]`; article bodies and linked recommendations stay on story detail.

### Claim-time poison results

`JobQueue.claim` returns leased/rejected/idle. Rejection includes the fresh terminally failed job and no lease, allowing run-once HTTP/CLI results and tests to distinguish poison from an empty queue without unrelated history queries.

### LLM disposal ownership

Inspection of the pinned OpenAI `7.45.1` declarations shows no main-client close method. The adapter uses the SDK default process-wide fetch dispatcher and owns no private Agent to close. Its settled operations already clean up attempt timers/signals and start no later work. Therefore the service cancels/drains all admitted operations and discards the adapter; process exit, not a fake adapter `close()`, is the honest final transport-pool boundary. No deterministic per-client socket-close guarantee is claimed.

## 16. Deliberate non-gaps and change boundaries

- No upstream worker/run-once method is needed: job-queue's claim/renew/complete/fail/recover primitives and reader-app dispatch are sufficient.
- No `readerApp.schedulePersonalization` method is needed: personalization explicitly exports the recovery enqueue factory for service composition.
- No CSRF recovery/rotation API is needed: a fresh login is the current intentional behavior for raw-secret loss.
- No new article or activity job owner is needed: reader-app already owns those two codecs and the central eight-kind dispatch.
- No direct scheduled HN execution is needed or allowed: current scheduling methods already produce durable `ingestion.collect` and `ingestion.reconcile-account` jobs.
- No service-side SQL migration inspector, second redactor, queue join, payload codec, account parser, or fictitious LLM close method should be invented around these owner boundaries.

Any new job kind requires an owner codec, central reader-app registration/dispatch/failure mapping, worker/run-once coverage, safe DTOs, and restart tests. Any transport field addition requires an explicit allowlist review for raw content, credentials, cursors, tokens, and provider errors. Any lifecycle addition requires construction-order, cancellation, reverse-close, and partial-startup acceptance coverage.
