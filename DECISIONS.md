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
