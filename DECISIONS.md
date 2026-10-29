# Decisions

## 2026-10-28 — Public GitHub repository
**Chosen:** User decision: created `kashifrazzaqui/tmtp` as a public GitHub repository and configured it as `origin`; no push was performed.
**Alternatives:** A private repository or local-only Git repository.
**Why:** The user explicitly requested a public GitHub repository created with `gh`.
**Trade-offs:** Repository metadata and any later-pushed content are publicly visible.
**Revisit if:** The distribution or privacy requirements change.

---

## 2026-10-28 — Single-process modular monolith
**Chosen:** One `personal-reader` service hosts the web UI, HTTP API, application library, scheduler, and background workers.
**Alternatives:** Separate collector, recommendation, and web services; a hosted multi-user control plane.
**Why:** A single-user product benefits from one start command, one transactional SQLite store, and no inter-service transport. Library boundaries preserve separation without adding operational processes.
**Trade-offs:** Background work shares the web process's resources and failure domain. Horizontal scaling and independent deployment are not goals.
**Revisit if:** Multi-user operation or measured workload isolation becomes a requirement.

---

## 2026-10-28 — Public-first Hacker News integration
**Chosen:** Official public API ingestion is the core path. Authenticated HTML/session integration is optional and used for account reconciliation and explicit user actions.
**Alternatives:** Make authenticated browser automation mandatory; rely only on public HN data.
**Why:** The official API documents public items but no private activity or mutation API. The product must still collect and personalize when private-account integration is unavailable, while the original idea calls for account actions.
**Trade-offs:** HTML integration is unofficial and brittle. Account actions can fail or change with HN markup and eligibility.
**Revisit if:** HN offers a supported authenticated API or disallows the HTML integration.

---

## 2026-10-28 — Activity capture boundary
**Chosen:** In-app reads and HN actions are the authoritative activity stream. Votes, favorites, and flags made elsewhere are reconciled only when HN exposes enough state.
**Alternatives:** Promise a complete HN account history; ignore activity performed outside the app.
**Why:** HN exposes no dependable private event history with timestamps and provenance. Local intent can be recorded precisely when the app performs an action.
**Trade-offs:** Removals and some external actions may be invisible. Flag readback is unverified and cannot be promised.
**Revisit if:** Authenticated testing or a supported API establishes stronger readback guarantees.

---

## 2026-10-28 — Single SQLite hybrid persistence layout
**Chosen:** One SQLite database combines relational current state with an append-only reading-activity log and durable infrastructure records. All libraries share the store through repositories; one service owns writes.
**Alternatives:** Per-service databases; a fully event-sourced model; a document store plus a separate queue.
**Why:** Relational queries fit stories, profiles, recommendations, and queues. Append-only activity preserves evidence without event-sourcing the whole system. One store gives atomic local transactions and simple backup.
**Trade-offs:** A single-writer topology limits scale and couples schema migration across libraries. Activity projections require explicit repair logic.
**Revisit if:** Multiple writers, independent service ownership, or scale beyond one personal instance appears.

---

## 2026-10-28 — Embedded reader without iframe dependence
**Chosen:** The embedded reading experience uses fetched, extracted, sanitized article content with an original-page fallback.
**Alternatives:** Depend on third-party pages rendering in an iframe; run a remote controlled browser for article display.
**Why:** Extraction gives the reader a consistent observation surface and avoids making cross-origin framing a core dependency. A remote browser conflicts with easy self-hosting.
**Trade-offs:** Extraction can fail, paywalled or highly interactive pages may not work, and original-page reading offers weaker activity signals.
**Revisit if:** Reader-mode quality proves inadequate for the audience.

---

## 2026-10-28 — Cross-cutting primitive extraction
**Chosen:** Extract `clock`, `logging`, `config`, `retry`, `http-client`, and `scheduler` into focused libraries. Keep `llm-interface` free of runtime dependencies and put the provider SDK in `llm-openai-compatible`.
**Alternatives:** Duplicate these concerns inside feature libraries; use a generic application framework; let recommendation code import a concrete LLM SDK.
**Why:** Time, retries, scheduling, configuration, and structured logs are independent concepts. A narrow LLM port keeps provider dependencies out of personalization logic and makes deterministic testing possible.
**Trade-offs:** The workspace contains more small packages and explicit composition. The generic HTTP and scheduler libraries must stay narrow rather than becoming frameworks.
**Revisit if:** Package overhead measurably obstructs development or a primitive no longer has an independent contract.

---

## 2026-10-28 — Node runtime
**Chosen:** Node `24.22.1` LTS (`>=24.15 <25`), released 2026-10-20 and supported to 2028-04-30; MIT, very high shared issue activity (152 new issues/30d).
**Alternatives:** Node `22.23.4` LTS, supported to 2027-04-30 with the same repository activity and license; Node 26 Current.
**Why:** Node 24 is the supported production line with a longer runway than Node 22 and satisfies current jsdom and UI tooling engines.
**Trade-offs:** Strongest counter-argument: Node 26 is newer, but the official release page still labels it Current rather than LTS. Pinning 24 excludes users who only track the newest runtime.
**Revisit if:** Node 26 is established as LTS and every selected native/browser dependency supports it.

---

## 2026-10-28 — SQLite driver
**Chosen:** `better-sqlite3@13.0.3`; 10 years old, MIT, released 2026-08-05, low recent issue volume (1/30d), mature synchronous transactions.
**Alternatives:** Node 24's built-in `node:sqlite`, MIT and actively maintained, but documented as Stability 1.2 release candidate; `@libsql/client` adds a different server/client model.
**Why:** The reading memory depends on a stable database API. `better-sqlite3` has the longest production record and fits one-process synchronous transactions without a database service.
**Trade-offs:** Strongest counter-argument: it is a native addon, unlike `node:sqlite`. Prebuilt binaries cover common targets, but unsupported platforms may need a compiler toolchain. The `database` library isolates the driver.
**Revisit if:** Built-in SQLite reaches stable status with the required transaction/backup behavior, or native installation failures outweigh API stability.

---

## 2026-10-28 — SQL and migrations
**Chosen:** Parameterized handwritten SQL and ordered, transactional SQL migration files, with migration metadata in SQLite.
**Alternatives:** Drizzle ORM `0.45.4` (Apache-2.0, 5 years, high activity at 62 issues/30d) with generated migrations; Kysely `0.29.7` (MIT, 5.7 years, 19/30d) with typed queries and migrations.
**Why:** The schema is modest and queue/job invariants benefit from explicit SQL. No ORM runtime or driver adapter is needed.
**Trade-offs:** Strongest counter-argument: handwritten SQL gives less compile-time query checking and more repository code. Kysely is the preferred later step if query complexity grows.
**Revisit if:** Repositories become repetitive or query type errors appear despite schema-focused tests.

---

## 2026-10-28 — Validation
**Chosen:** Zod `4.6.7`; 6.6 years old, MIT, released 2026-10-12, high activity (47 issues/30d).
**Alternatives:** Valibot `1.5.0`; 3.3 years, MIT, released 2026-09-09, medium activity (14/30d).
**Why:** Zod provides mature TypeScript inference and runtime parsing for domain, API, configuration, and LLM output, with no dependencies.
**Trade-offs:** Strongest counter-argument: Valibot has a smaller modular browser footprint. Sharing Zod still favors one validation contract across server and UI.
**Revisit if:** Measured browser bundle cost becomes more important than ecosystem consistency.

---

## 2026-10-28 — Structured logging
**Chosen:** Pino `10.4.0`; 10.7 years, MIT, released 2026-10-02, low issue volume (3/30d).
**Alternatives:** Winston `3.19.0`; 15.8 years, MIT, released 2025-12-07, low issue volume (1/30d).
**Why:** Pino's structured JSON, child loggers, redaction, and stdout default fit one service without transport configuration.
**Trade-offs:** Strongest counter-argument: Winston has richer transport routing. Pino leaves file rotation and aggregation to the runtime environment.
**Revisit if:** Multiple in-process log destinations become a requirement.

---

## 2026-10-28 — Retry policy
**Chosen:** `p-retry@8.0.1`; 10 years, MIT, released 2026-09-01, low issue volume (1/30d).
**Alternatives:** `retry@0.13.1`; 15.5 years, MIT, last released 2021-06-21, quiet issue activity.
**Why:** `p-retry` provides a current typed Promise API, abort signals, and bounded retry controls behind our policy library.
**Trade-offs:** Strongest counter-argument: a small internal backoff loop would avoid a dependency, but would duplicate tested abort and delay behavior.
**Revisit if:** The policy needs scheduling semantics beyond this package or the dependency becomes unmaintained.

---

## 2026-10-28 — HTTP transport
**Chosen:** Undici `8.12.3`; 8.5 years, MIT, released 2026-10-19, high activity (30 issues/30d in the cited snapshot).
**Alternatives:** Axios `1.21.0`; 12.2 years, MIT, released 2026-10-27, medium activity (21/30d); global fetch for simple fixed-origin calls.
**Why:** Undici retains Web-standard request shapes while exposing dispatchers and connection controls needed for DNS-pinned article fetching and explicit redirect policy.
**Trade-offs:** Strongest counter-argument: global fetch needs no dependency and is enough for HN. The shared wrapper must keep simple calls simple and isolate advanced dispatcher behavior to `article-fetcher`.
**Revisit if:** Node's built-in fetch exposes equivalent verified connection controls or the security design changes.

---

## 2026-10-28 — Durable background jobs
**Chosen:** A project-owned SQLite job queue with transactional claims, leases, retry backoff, and idempotent handlers; SQLite is public domain and actively maintained upstream.
**Alternatives:** BullMQ `6.5.0`; 7.9 years, MIT, released 2026-10-26, medium activity (18/30d), backed by Redis.
**Why:** Jobs must survive restart without adding Redis. Atomic database claims fit the existing single-writer topology.
**Trade-offs:** Strongest counter-argument: BullMQ already provides mature priority, retry, concurrency, and flow semantics. We must implement and test lease recovery and at-least-once behavior ourselves.
**Revisit if:** Queue semantics outgrow the single-user workload or a second service requires shared work coordination.

---

## 2026-10-28 — Scheduler
**Chosen:** Croner `11.0.0`; 10.9 years, MIT, released 2026-10-26, low issue volume (4/30d), zero dependencies.
**Alternatives:** node-cron `4.6.0`; 10.7 years, ISC, released 2026-07-05, low issue volume (2/30d).
**Why:** Croner supplies typed cron/ISO schedules, time zones, lifecycle controls, and overrun protection. SQLite remains responsible for durable work and restart catch-up.
**Trade-offs:** Strongest counter-argument: node-cron is an equally credible small scheduler. Croner adds no durability, so recovery remains our responsibility.
**Revisit if:** Scheduling needs distributed coordination or its API cannot express required catch-up behavior.

---

## 2026-10-28 — OpenAI-compatible LLM adapter
**Chosen:** OpenAI Node SDK `7.45.1`; 4.9 years, Apache-2.0, released 2026-10-27, moderate issue activity (27 in the cited 90-day window), configured with `baseURL` and an API token.
**Alternatives:** Vercel AI SDK `ai@7.0.155` plus `@ai-sdk/openai-compatible@3.0.80` (Apache-2.0, 3.4 years, very active, very high monorepo issue volume); LangChain.js 1.x (MIT, 3.7 years, high activity).
**Why:** One configurable OpenAI-compatible endpoint needs structured judgments, not an agent framework. The SDK is the narrowest concrete adapter behind `llm-interface`; client-side Zod validation remains mandatory.
**Trade-offs:** Strongest counter-argument: AI SDK is better for multiple provider protocols. Our first adapter does not promise them, and OpenAI-compatible endpoints vary in structured-output support.
**Revisit if:** Users need providers with incompatible protocols or the SDK's compatibility helpers prove unreliable.

---

## 2026-10-28 — Authenticated HN HTML
**Chosen:** Cheerio `1.2.0` over the shared HTTP client; 15 years, MIT, released 2026-01-23 with an active repository and moderate issue volume.
**Alternatives:** Playwright `1.64.1`; 6.9 years, Apache-2.0, released 2026-10-14, very high activity; jsdom for static selector parsing.
**Why:** HN pages are server-rendered. Cheerio parses action links and account pages without installing or supervising a browser.
**Trade-offs:** Strongest counter-argument: Playwright handles browser-dependent flows and locators. It still would not remove HN markup brittleness and would add substantial runtime assets and process lifecycle.
**Revisit if:** Authenticated HN flows require JavaScript execution or interactive login cannot be separated from runtime collection.

---

## 2026-10-28 — Article extraction and DOM
**Chosen:** `@mozilla/readability@0.6.0` with `jsdom@30.1.3`; Apache-2.0/MIT, 11.7/16.8 years, low/moderate issue activity, released 2025-03-03/2026-10-15.
**Alternatives:** `@extractus/article-extractor@9.0.1` with linkedom `0.18.14` (MIT/ISC, smaller wrapper and DOM, low maintenance activity).
**Why:** Mozilla documents the jsdom integration, and the same standards-oriented DOM is supported by the sanitizer. Script execution and remote resources stay disabled.
**Trade-offs:** Strongest counter-argument: Extractus plus linkedom is lighter and requires less glue. jsdom costs more memory and has strict Node engine requirements.
**Revisit if:** Real article-corpus benchmarks show unacceptable extraction quality or resource use.

---

## 2026-10-28 — Article sanitization
**Chosen:** DOMPurify `3.4.17` with current jsdom; MPL-2.0 or Apache-2.0, 12.7 years, released 2026-10-12, low issue volume (7 in the cited window).
**Alternatives:** sanitize-html `2.18.1`; MIT, 13.7 years, released 2026-10-14, low monorepo issue volume.
**Why:** DOMPurify has a security-focused, explicitly supported jsdom pairing and built-in types. Sanitization occurs after extraction with an HTML-only allowlist and CSP defense in depth.
**Trade-offs:** Strongest counter-argument: sanitize-html avoids carrying a server DOM. We already chose jsdom for Readability, but its security updates now form part of the trusted computing base.
**Revisit if:** The DOM stack changes or a security review favors a different supported pairing.

---

## 2026-10-28 — SSRF address classification
**Chosen:** `ip-address@10.7.5`; 15.6 years, MIT, released 2026-10-25, low issue volume (4 in the cited window), zero runtime dependencies.
**Alternatives:** `ipaddr.js@2.5.0`; 15.3 years, MIT, released 2026-08-04, low issue volume (2 in the cited window).
**Why:** `isGlobal()` uses IANA special-purpose data and handles mapped/NAT64 forms, reducing hand-built address-range policy.
**Trade-offs:** Strongest counter-argument: ipaddr.js is smaller and sufficient for manual CIDR checks. Neither library alone prevents SSRF; DNS resolution, connection pinning, redirect revalidation, protocol/port limits, and tests remain required.
**Revisit if:** Security testing finds classification gaps or a platform-standard validator offers stronger guarantees.

---

## 2026-10-28 — HTTP service framework
**Chosen:** Fastify `5.12.7`; 10.1 years, MIT, released 2026-10-13, moderate issue activity (11 opened/30d).
**Alternatives:** Hono `4.13.14` (4.9 years, MIT, high activity at 42/30d) with Web Standards portability; Express `5.3.0` (17.3 years, MIT, 13/30d) with a large middleware ecosystem.
**Why:** Fastify's route validation, scoped lifecycle hooks, error handling, and shutdown model fit authenticated JSON routes and debug streams. Official static/cookie plugins preserve one service.
**Trade-offs:** Strongest counter-argument: Hono has simpler Fetch/SSE primitives and less framework-specific lifecycle. Fastify ties transport code to its plugin and hook model, but not the libraries.
**Revisit if:** Runtime portability becomes important or Fastify's validation/hook model obstructs the API.

---

## 2026-10-28 — Single-user access control
**Chosen:** A narrow project-owned opaque access-token/session library using Node Web Crypto and hashed server-side session records. It supports only a pre-provisioned high-entropy token, revocation, expiry, renewal, throttling, and CSRF defenses.
**Alternatives:** Better Auth `1.7.14` (MIT, 2.5 years, very active) with broader accounts and database sessions; Auth.js `@auth/core@0.41.3` (ISC, mature but its stewards recommend Better Auth for new projects).
**Why:** A single-user installation needs one access credential, not passwords, OAuth, signup, or account recovery. The narrow library avoids those endpoints and schemas.
**Trade-offs:** Strongest counter-argument: OWASP favors established session implementations. We own protocol security and tests; this choice is invalid if password or multi-user authentication appears.
**Revisit if:** Requirements expand beyond one pre-provisioned token; then adopt Better Auth rather than growing custom auth.

---

## 2026-10-28 — UI framework and build
**Chosen:** React `19.3.1` with Vite `8.3.5`, producing a static SPA served by Fastify; MIT, 13.4/6.6 years, released 2026-10-14/2026-10-21, high issue activity.
**Alternatives:** SvelteKit `3.1.0` with Svelte 5 (MIT, integrated full-stack routing/loading, high activity); Next.js with a server rendering model.
**Why:** The private reader needs no SEO or SSR. A static bundle preserves one production service and supports the selected design-system ecosystem.
**Trade-offs:** Strongest counter-argument: SvelteKit integrates routing and data loading with less assembly. React requires separate query and router libraries.
**Revisit if:** SSR, framework actions, or a Svelte-native design system becomes advantageous.

---

## 2026-10-28 — Design system
**Chosen:** MUI Material `9.5.0` with a custom reading-focused theme; MIT, 12-year project history, released 2026-10-09, high issue activity (80/30d).
**Alternatives:** Chakra UI `3.37.0` (MIT, active, low issue volume) with Ark/Panda theming; shadcn/ui `4.23.0` CLI plus Radix/Tailwind (MIT, source-owned generated components).
**Why:** MUI is the most complete adopted component/theme system without generated component source or a second CSS build architecture.
**Trade-offs:** Strongest counter-argument: shadcn/ui offers more visual and source control. MUI's Material defaults need deliberate theming to avoid a generic admin appearance.
**Revisit if:** The product identity demands component-level designs that MUI cannot theme cleanly.

---

## 2026-10-28 — UI server state
**Chosen:** TanStack Query `5.105.0`; MIT, 7.1 years, released 2026-10-26, moderate issue activity (15/30d).
**Alternatives:** SWR `2.5.1`; MIT, 7 years, released 2026-08-12, low issue activity (7/30d).
**Why:** Queue pagination, reading mutations, optimistic updates, and invalidation benefit from Query's explicit server-state model.
**Trade-offs:** Strongest counter-argument: SWR is smaller and sufficient for read-heavy fetching. Query adds cache concepts that must be limited to server state.
**Revisit if:** The UI's mutation/cache needs remain trivial or Query usage becomes inconsistent.

---

## 2026-10-28 — UI routing
**Chosen:** React Router `8.5.1` in Declarative Mode; MIT, 12.4 years, released 2026-10-27, moderate issue activity (31/30d).
**Alternatives:** TanStack Router `1.170.46`; MIT, 7.8 years, released 2026-10-22, high issue activity (62/30d).
**Why:** Nested queue, reader, settings, and diagnostics routes need ordinary declarative routing, not a generated route tree or framework mode.
**Trade-offs:** Strongest counter-argument: TanStack Router has stronger route/search type inference and loaders. React Router leaves more query-state validation to us.
**Revisit if:** Route-level typed loaders and complex search state become central.

---

## 2026-10-28 — Unit and integration test runner
**Chosen:** Vitest `5.0.5`; MIT, 4.9 years, released 2026-10-15, very high issue activity (130/30d).
**Alternatives:** Jest `30.5.2`; MIT, 12.9 years, released 2026-09-18, medium issue activity (11/30d).
**Why:** Vitest matches the TypeScript/ESM/Vite stack with minimal transform setup and supports both pure-library and service integration tests.
**Trade-offs:** Strongest counter-argument: Jest has a longer compatibility history. Vitest shares Vite's faster-moving release cadence.
**Revisit if:** Required libraries cannot run reliably under Vitest.

---

## 2026-10-28 — Browser agent harness
**Chosen:** Playwright Test/library `1.64.1` as development tooling only; Apache-2.0, 6.9 years, released 2026-10-14, very high issue activity.
**Alternatives:** Cypress `16.2.0`; MIT, 11.6 years, released 2026-10-14, moderate issue activity (41/30d).
**Why:** Playwright offers direct asynchronous browser control, isolated contexts, three browser engines, and local traces for agent assertions.
**Trade-offs:** Strongest counter-argument: Cypress has a strong interactive runner. Playwright browser binaries remain a development installation cost; they are not part of the production HN integration.
**Revisit if:** The agent workflow is better served by Cypress's runner or browser support requirements change.

---

## 2026-10-28 — Access token required in every mode
**Chosen:** Require `auth.access_token_path` for loopback and public deployments; loopback binding never creates an authentication bypass.
**Alternatives:** Trust all loopback clients without a token; issue an implicit loopback session through a separate authentication mode.
**Why:** One authentication path removes an undefined session-issuance contract and prevents an accidental bind or proxy change from exposing reading history and HN mutations.
**Trade-offs:** Strongest counter-argument: token-free loopback is slightly easier to start. Every installation now needs one high-entropy token file in addition to the LLM credential.
**Revisit if:** A separately reviewed local authentication mechanism offers equivalent protection with less setup.

---

## 2026-10-28 — External failures degrade instead of blocking stored reading
**Chosen:** SQLite, migrations, configuration, and worker startup control readiness. LLM, HN account, and article-source failures mark degraded capabilities while the stored queue remains available; `doctor` still reports required connection failures.
**Alternatives:** Make the LLM probe a readiness requirement; make every external integration optional for both startup and diagnostics.
**Why:** The product's durable reading memory remains useful during external outages. New scoring or account actions should fail honestly without taking existing reading offline.
**Trade-offs:** Strongest counter-argument: strict LLM readiness catches misconfiguration sooner and simplifies health semantics. Operators must watch degraded status and run `doctor` after setup rather than relying only on readiness.
**Revisit if:** The product explicitly chooses fail-closed external validation over local availability.

---

## 2026-10-28 — Workspace manifests and dependency pinning
**Chosen:** A pnpm `10.26.2` workspace contains 26 private `@tmtp/*` libraries under `libs/*` and one private service under `services/*`. Internal edges use `workspace:*`; exact external versions use one workspace catalog. Only `better-sqlite3` may run dependency build scripts.
**Alternatives:** Repeat external versions in each manifest; use floating ranges; make packages public; allow every dependency build script or leave the native driver unbuilt.
**Why:** One catalog prevents version drift while the manifests mirror the reviewed dependency graph. Private packages match the single-deployment product. A one-package build allowlist supplies the required SQLite driver without trusting unrelated install scripts.
**Trade-offs:** Strongest counter-argument: per-package versions are more familiar and portable to other package managers. The catalog is pnpm-specific, and the SQLite native build remains a trusted installation step.
**Revisit if:** Packages are published independently, the workspace changes package managers, or additional native dependencies require a broader trust policy.

---

## 2026-10-28 — Strict domain records and synchronous database boundaries
**Chosen:** Use schema-first strict domain records, versioned variable JSON, positional SQL parameters, synchronous nested transactions, and lexically ordered migrations with SHA-256 checksum verification. Reject async transaction callbacks.
**Alternatives:** Permissive untyped records; an ORM/query builder; async transaction callbacks; unversioned or mutable applied migrations.
**Why:** The reading memory depends on explicit state invariants and atomic local commits. Strict records and checksums make drift visible, while synchronous transactions prevent an accidental early commit across an `await`.
**Trade-offs:** Repositories need explicit row/JSON mapping and producers must version payloads. Synchronous SQL can block the event loop, so queries and batches must stay short. Adding fields requires deliberate schema/migration work.
**Revisit if:** Query/mapping complexity outweighs the safety benefit or the runtime moves away from the single-writer synchronous SQLite model.

---

## 2026-10-28 — Injectable time and retry sources
**Chosen:** Separate wall and monotonic clocks; keep fixed clocks forward-only; inject sleep, random, and monotonic sources into retry. Count the first call in `maxAttempts` and use capped exponential delay with bounded symmetric jitter while preserving original errors.
**Alternatives:** Patch global timers/randomness in tests; expose raw `p-retry` behavior; use wall time for elapsed durations; wrap every terminal failure in a new retry error.
**Why:** Explicit sources make timestamps, delays, cancellation, and failure behavior deterministic without changing the tier graph. Preserving original errors keeps domain classification with callers.
**Trade-offs:** Consumers pass more dependencies and fixed clocks do not drive timers. The `p-retry` adapter needs compatibility tests and private error envelopes to suppress unwanted dependency behavior.
**Revisit if:** The dependency's native behavior matches the contract or a general virtual-time scheduler becomes necessary.

---

## 2026-10-28 — Secret-safe configuration and logging diagnostics
**Chosen:** Restrict product configuration to static schema paths and fixed safe issue messages. Require explicit secret registration for logging, redact keys and values recursively, allowlist error fields, and write NDJSON synchronously to stdout with visible write failures.
**Alternatives:** Return raw Zod messages/input; rely only on Pino path redaction; use asynchronous/default Pino destinations; allow arbitrary transports and error properties.
**Why:** Configuration and logs are high-risk secret boundaries. Static paths and allowlisted projections make non-echo guarantees testable. Synchronous stdout gives one process simple ordering and no hidden shutdown buffer.
**Trade-offs:** Operators receive less detailed validation messages and exact-value redaction cannot recognize transformed secrets. Recursive sanitation costs CPU and synchronous writes can block; dynamic configuration maps and custom transports are excluded.
**Revisit if:** Measured logging volume requires asynchronous transport or a reviewed structured diagnostic format can provide richer detail without exposing input.

---

## 2026-10-28 — Synchronous versioned article extraction
**Chosen:** Extract with fresh inert jsdom documents and Readability, truncate readable text before sanitization, apply a restrictive DOMPurify HTML profile, normalize safe absolute URLs, and version/hash the deterministic result.
**Alternatives:** A production browser; sanitizing only the source document; returning unsanitized Readability output; rejecting every over-length article; asynchronous APIs around blocking CPU work.
**Why:** The reader needs consistent content without executing or fetching untrusted page resources. A pure synchronous API matches the selected parser/sanitizer and makes provenance and resource bounds explicit.
**Trade-offs:** Extraction blocks the calling thread and cannot be cancelled mid-call. The restrictive profile loses site presentation and truncation loses later content; original-page fallback remains necessary.
**Revisit if:** Corpus benchmarks require rendered pages or measured CPU/latency requires isolated worker execution.

---

## 2026-10-28 — Type-only LLM port with complete attempt audits
**Chosen:** Keep `llm-interface` free of runtime code/dependencies. Require structured local parsing, canonical non-secret request hashes, every attempt audit on success and error, and explicit opt-in versioned payload capture.
**Alternatives:** A runtime provider base class; expose SDK responses/errors; retain only the final attempt; capture payloads by default; hash only prompt text.
**Why:** Recommendation logic needs provider independence without losing retry/usage evidence. A complete canonical projection makes requests inspectable and reproducible while capture remains off by default.
**Trade-offs:** Every adapter must implement and pass the same behavioral contract suite. TypeScript cannot type Promise rejections, and providers still vary in structured-output behavior. Payload capture requires careful non-secret projections.
**Revisit if:** Multiple adapters share enough behavior to justify a separate reviewed runtime base package without weakening provider independence.

---

## 2026-10-28 — Hash-only sessions with asynchronous verification
**Chosen:** Issue independent random bearer/CSRF secrets, store only SHA-256 hashes, use fixed absolute expiry, and reserve process-local login-throttle slots before Web Crypto awaits. Authentication, logout, and CSRF APIs are asynchronous while each store check/write sequence stays synchronous.
**Alternatives:** Store raw session secrets; synchronous token comparison; sliding expiration; per-token/IP throttle maps; hold a database transaction across digest operations.
**Why:** Hash-only storage limits the value of a database disclosure, independent secrets prevent cross-use, and synchronous critical sections fit the single-writer topology without holding transactions across I/O.
**Trade-offs:** Raw CSRF secrets cannot be recovered, so loss requires re-login. The throttle resets on restart and all attempts consume capacity. JavaScript fixed-work digest comparison is not a formal hardware constant-time guarantee.
**Revisit if:** The process topology changes, stronger timing guarantees are required, or a separately reviewed CSRF rotation/recovery flow is added.

---

## 2026-10-28 — Replayable activity and bounded interest evidence
**Chosen:** Use deterministic event/session IDs, logical replay comparison that ignores receipt time, one-story atomic batches, and a latest active-or-terminal session high-watermark. Orphan closers create zero-length terminal sessions. Interest building reads a newest contiguous activity suffix plus an independent latest-log version.
**Alternatives:** Generate fresh IDs per retry; byte-compare repository records before reduction; track only active sessions; drop orphaned closers; scan the full activity log for every profile build.
**Why:** At-least-once delivery must not double-count dwell or fork session projections. The terminal high-watermark makes incremental and ordered rebuilds agree. Bounded suffixes control profile-build work without deleting activity history.
**Trade-offs:** Producers must retain stable idempotency IDs and send per-story ordered observations. Delayed stale observations fail instead of merging. A zero-sized window still needs separate version lookup, and profile policy changes can rebuild projections differently.
**Revisit if:** Multi-process activity writers require atomic replay claims/session versions or corpus measurements justify a different materialized evidence window.

---

## 2026-10-28 — Leased SQLite jobs and explicit repository queries
**Chosen:** Keep jobs in the shared database with versioned payload codecs, active dedupe, token-checked leases, bounded recovery, deterministic backoff, and terminal poison-payload failure. Reader-store uses handwritten keyset repositories, globally ordered migrations, and explicit latest-session/newest-window/content-staleness queries.
**Alternatives:** An external broker; fire-and-forget jobs; handler invocation inside claim transactions; offset paging; hide stale payload/content behind indefinite retries; derive feature queries ad hoc in consumers.
**Why:** One-process deployment still needs crash recovery and atomic cross-aggregate handoffs. Explicit leases and queries make at-least-once behavior, complete queue pagination, and re-extraction/scoring eligibility inspectable.
**Trade-offs:** Every effect must be idempotent and long handlers must renew leases. SQL mappings and payload migrations require maintenance. Recovery and profile/content work take bounded passes rather than one unbounded transaction.
**Revisit if:** Multiple writers or much higher throughput requires a different coordination primitive, or query complexity justifies another reviewed storage abstraction.

---

## 2026-10-28 — Deterministic transport and scheduler lifecycles
**Chosen:** Give HTTP one total deadline, GET-only retries, bounded bodies, explicit redirects/pins, injected sleep/random/monotonic sources, and idempotent close. Give scheduler an injected Croner driver, per-task overrun policy, and stop/drain semantics; keep durability in jobs/stores.
**Alternatives:** Use global timers/randomness; retry POST automatically; let FixedClock drive Croner; persist generic scheduler last-run records; make close cancel active requests.
**Why:** Network mutation retries can duplicate HN actions, and deterministic test seams are necessary for exact timing behavior. Scheduler triggers are only hints; durable state owns missed-work recovery.
**Trade-offs:** Custom transports/sleepers must cooperate with cancellation. Total HTTP deadlines include redirects/backoff, while close can wait for existing calls. Scheduler has no built-in task timeout/catch-up and service startup must recover idempotent work explicitly.
**Revisit if:** A general virtual-time scheduler is introduced or durable wall-clock schedule history becomes a product requirement.

---

## 2026-10-28 — Versioned complete queue projections and unsigned cursors
**Chosen:** Rank complete story sets with exact profile/content-active recommendations, deterministic lower-half exploration, content-addressed rank versions, and pending/failed sections. Use checksummed but unsigned keyset cursors. Preserve reading state while recomputing blacklist visibility, and use a queue-owned bootstrap version for initial ingestion.
**Alternatives:** Offset pagination; signed cursors with a new secret; random exploration per request; treat pending/failed as low scores; preserve old visibility during preference changes; let ingestion invent a rank version.
**Why:** Every story must remain reachable and explanations must not drift across profiles/content versions. Structural cursors need no key management, and a bootstrap callback preserves the dependency graph while giving initial rows a valid version.
**Trade-offs:** Complete ranking must assemble its canonical input before publishing a version. Hidden rows create rank-position gaps, and unsigned cursors are editable but read-only/non-authorizing. Changing filters or rank versions restarts pagination.
**Revisit if:** Queue scale requires a different materialization strategy or a new threat model genuinely requires authenticated cursor transport.

---

## 2026-10-28 — Audited OpenAI JSON-mode adapter
**Chosen:** Use non-streaming Chat Completions JSON-object mode with object-root schemas, local parsing, adapter-owned retries/deadlines, and a six-field canonical request hash including `maxOutputTokens`. Require an explicit model per request. Capture complete successful response bodies only; omit unavailable complete error envelopes.
**Alternatives:** SDK-native retries/parsers; strict provider-side `json_schema`; arbitrary root schemas; a redundant default-model option; partial API-error-body capture; raw provider errors.
**Why:** One SDK call must equal one visible attempt. The pinned SDK does not bound every error-body read with its native timeout and unwraps API-error envelopes, so the adapter needs its own deadline and must not claim unavailable capture fidelity.
**Trade-offs:** JSON mode is not schema enforcement and excludes non-object roots. Owning retries duplicates some SDK policy. Provider errors have less captured evidence, and full error-body capture would require a redesigned raw-transport seam.
**Revisit if:** The SDK changes its timeout/error behavior or a provider capability review justifies strict structured outputs or a new capture contract.

---

## 2026-10-28 — Shared bootstrap rank namespace
**Chosen:** Use one `QUEUE_BOOTSTRAP_RANK_VERSION` for all initial pending rows, independent of profile. This supersedes the profile-scoped bootstrap aspect of the preceding queue decision; complete reprojection still owns profile-specific ranking and visibility.
**Alternatives:** Include the current profile ID in bootstrap versions; atomically migrate every initial row on every profile change.
**Why:** Lookahead showed that ingestion under a new profile before complete reprojection could split existing and new pending rows across incompatible rank-version pages. A shared namespace keeps the initial queue complete without a fragile migration requirement.
**Trade-offs:** The bootstrap version does not describe profile visibility, so mixed initial rows rely on stored visibility until complete reprojection recomputes the full set. Pending order remains story-ID based and profile-independent.
**Revisit if:** Initial rows gain profile-specific ordering rather than only visibility/state.

---

## 2026-10-28 — Article-aware immutable recommendation identity
**Chosen:** Add a domain-owned derived `Article.contentVersion` and include it in every recommendation's immutable key, ID, store eligibility check, and queue activation rule. Missing/pending/failed/ready states are versioned by their actual prompt input; ready versions cover metadata, content hash, and extractor version.
**Alternatives:** Keep recommendations keyed only by HN story content; hash article text only inside recommendation IDs; include full article text/URLs/errors/timestamps in the key; overwrite same-key judgments after extraction changes.
**Why:** Article content affects generation, so an article-only change must create a new historical judgment rather than an immutable conflict. One domain helper prevents store, queue, and producer hash drift while SQL compares the stored derived version.
**Trade-offs:** Article and recommendation schemas gain required version fields and producers must validate the derived value. Status-only article changes can trigger a new judgment, and ready metadata changes invalidate even when text is unchanged. Raw article text remains out of the key through its content hash.
**Revisit if:** The prompt stops using article state/content or a single stored projection can no longer represent all article-derived prompt inputs.

---

## 2026-10-28 — Derived bounded diagnostic history
**Chosen:** Project recent errors from existing ingestion, LLM, HN-action, and failed-job records with stable source-prefixed IDs and codes. Merge bounded keyset candidates in diagnostics; paginate sync runs, LLM calls, jobs, and version counts explicitly. Persist `Job.lastErrorCode` separately from its safe message. Add no diagnostic-error table.
**Alternatives:** Add a seventeenth diagnostic table; parse unstructured error messages at read time; return unbounded recent/version lists; use offset pagination or an in-memory error history.
**Why:** Existing operational records already own the evidence. Derived views avoid duplicate persistence and preserve the reviewed schema scope while stable codes/cursors make debug output bounded and inspectable.
**Trade-offs:** Recent-error reads merge candidates from two owners and job failures need a new code column. Messages remain unavailable to diagnostics, and sections/pages are operational views rather than one database snapshot.
**Revisit if:** Required error evidence cannot be represented by the owning records or query measurements justify a separately maintained diagnostic projection.

---

## 2026-10-28 — Fail-closed article transport and decoding
**Chosen:** Resolve and classify every address for every manual redirect, reject mixed public/private answers, pin each hop, and apply one overall DNS/HTTP/decode budget. Bound transfer and decoded bytes independently; support only identity/gzip/deflate/Brotli and UTF-8 HTML.
**Alternatives:** Resolve only the initial URL; select a public address from a mixed answer; rely on Content-Length or compressed size; restart the timeout per hop; use platform fetch defaults.
**Why:** Redirect/DNS changes and compressed expansion are the main arbitrary-URL risks. Explicit policies make SSRF, resource exhaustion, and timeout behavior testable at the owning boundary.
**Trade-offs:** Fail-closed DNS rejects some valid sites and selecting one address gives no Happy Eyeballs fallback. Multiple codings add decode complexity, and non-cooperative custom dependencies still cannot be forcibly stopped.
**Revisit if:** Measured compatibility requires a reviewed address-fallback/charset/encoding policy or the transport gains equivalent enforceable guarantees.

---

## 2026-10-28 — Sparse official HN items with preserved tombstones
**Chosen:** Permit type-less deleted/dead raw items, reject type-less live items, and merge tombstones with previous story metadata only during normalization. Preserve additive raw fields and hash reader-facing story content while excluding volatile score/comment/observation fields.
**Alternatives:** Require `type` on every item; invent `type=story`; discard sparse tombstones; overlay previous fields onto live stories; include HN popularity in recommendation content identity.
**Why:** The official API guarantees only `id`, but deletion evidence must remain durable without fabricating story data. Previous metadata is historical display context, not proof about a live refresh.
**Trade-offs:** A type-less tombstone without a previous story cannot become a domain Story. Ingestion must read prior state for refresh, and raw/type-less distinctions require explicit fixtures.
**Revisit if:** The official API strengthens its item schema or tombstone semantics change.

---

## 2026-10-28 — Conservative authenticated HN actions
**Chosen:** Use a dedicated no-retry account client for exact throttling, serialize account operations, discover fresh forms, dispatch at most one POST, require positive readback, and preserve post-dispatch uncertainty as `indeterminate`. Keep flag readback disabled by default and list absence non-evidentiary.
**Alternatives:** Share the retry-enabled general client; treat HTTP 200 as success; follow POST redirects; infer removal from missing rows/elements; enable flag support from fixtures alone.
**Why:** Authenticated HTML is unstable and mutations are not safely repeatable. Reconciliation-first retries and explicit uncertainty prevent false activity and duplicate actions while exact wire-attempt throttling remains enforceable.
**Trade-offs:** More actions remain unresolved and changed markup can block otherwise valid actions. The service owns an additional client configuration, and live capability remains unverified until separately observed.
**Revisit if:** HN offers a supported authenticated API or independently verified markup/readback contracts justify different action semantics.

---

## 2026-10-28 — Sequential whole-batch recommendation exchanges
**Chosen:** Plan story-ID-ordered bounded batches, require one complete validated judgment per requested story, execute batches sequentially, and return partial cancelled work plus every audit. Deterministic immutable IDs include all story/article/profile/prompt/model version dimensions.
**Alternatives:** Accept partial batch judgments; parallel fan-out; silently truncate prompts; retry failed operations again in recommendations; discard failed/cancelled attempts.
**Why:** Whole-batch acceptance prevents ambiguous missing-story outcomes, while sequential calls make prompt budgets, cancellation, and audit order inspectable. Complete version identity supports safe exact-key retries.
**Trade-offs:** One invalid judgment rejects the whole provider batch and sequential execution limits throughput. Cancellation returns partial work that the composing job must distinguish from complete recovery.
**Revisit if:** Per-story output acceptance or measured provider throughput justifies a new prompt/audit contract.

---

## 2026-10-28 — Atomic stale-score invalidation and extraction-source versions
**Chosen:** Store `Article.sourceContentVersion` separately from derived `Article.contentVersion`. When story or derived article input versions change, atomically move a stale scored queue row to pending and clear scored fields while retaining its prior rank version until full reprojection.
**Alternatives:** Keep stale scored rows until a later reprojection; include them in scoring without changing evaluation state; compare extraction freshness against the derived article hash; immediately compute a new rank version inside story/article upserts.
**Why:** Stale rows otherwise disappear from scoring eligibility and can make queue projection fail its active-recommendation invariant. Source and output versions answer different questions and cannot be substituted for one another.
**Trade-offs:** Repository upserts own additional transactional queue writes. Rows temporarily retain an older rank namespace as pending entries, and complete reprojection remains necessary to publish one new canonical ordering.
**Revisit if:** Queue projections become fully version-immutable or ingestion/result composition gains an equivalent atomic invalidation owner.

---

## 2026-10-28 — HN wire-attempt and dispatch boundaries
**Chosen:** Walk authenticated GET redirects manually with one throttle reservation per hop, and define POST dispatch conservatively as invocation of `HttpClient.request`. Map every upstream HTTP error explicitly; after invocation, unresolved failures remain indeterminate even if the client later proves no wire I/O occurred.
**Alternatives:** Use automatic same-origin redirects; claim a physical transport-started boundary without an upstream callback; propagate raw client-closed errors after POST invocation.
**Why:** No-retry alone does not make throttling exact because redirects add wire requests. The HTTP client exposes no dispatch acknowledgment, so a conservative invocation boundary is truthful about uncertainty without inventing transport evidence.
**Trade-offs:** The account adapter owns a bounded redirect walker and can record indeterminate for a POST that never reached the socket. This is intentionally cautious and requires reconciliation rather than optimistic success.
**Revisit if:** The transport exposes a reliable dispatch acknowledgment or account throttling is redefined in high-level rather than wire-attempt units.

---

## 2026-10-29 — Explicit current-profile selection
**Chosen:** Store one mutable `current_profile` pointer to immutable profile history and set it whenever personalization selects a new or reused version. `profiles.current()` reads only that pointer.
**Alternatives:** Select the latest `(createdAt,id)`; rewrite an older profile's timestamp on reuse; keep an in-memory override; fail every historical reversion with `profile-current-conflict`.
**Why:** Reverting rules/activity/policy/builder inputs can select an existing older profile. Creation order cannot represent that choice, and rewriting immutable history would break provenance and deterministic identity.
**Trade-offs:** The store gains a fifteenth reader-owned table and every profile-selection transaction must move the pointer. Selection time is operational metadata rather than part of profile identity.
**Revisit if:** Multiple independently active profiles become a supported product feature rather than one current profile per installation.

---

## 2026-10-29 — Composite reader versions and conditional article writes
**Chosen:** Store `ARTICLE_READER_VERSION = article-reader-v1:<upstream extractor version>` on ready articles and use it for re-extraction selection. Make article upsert compare its source story version atomically and return `applied` or `stale-source`. Source/article changes invalidate stale scored or failed evaluations; terminal failed articles are not retried merely for lacking an extractor version.
**Alternatives:** Store only the upstream extractor version; re-read then unconditionally overwrite; add a separate reader-version column; retry every failed article during routine work selection.
**Why:** Reader-owned wrapping/mapping also affects output, and a pre-write re-read does not close the race with story refresh. The active durable job already owns retryability/backoff, so a missing successful extractor version is not itself new work.
**Trade-offs:** Reader policy changes require an explicit version-marker bump. Store upserts own source comparison and queue effects, and callers must handle stale-source as discarded work rather than a persisted failure.
**Revisit if:** Reader/extractor versions are split into independently migrated persisted fields or retry scheduling moves outside the active job contract.

---
