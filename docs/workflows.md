# User Workflows

## Personas

- **Reader:** An existing Hacker News regular who reads in bursts and wants a personal, durable queue. The Reader owns the interests, activity history, and reading decisions.
- **Operator:** The same person administering their own laptop or personal-server installation. The Operator configures infrastructure, inspects health, and recovers failures. This is not a second tenant or an administration role inside a multi-user service.

## WF-01 — Install and connect a personal instance

**User:** Operator  
**Goal:** Run one accessible instance with validated storage, LLM, and optional HN account connections.

**Steps:**
1. Provide centralized configuration and secret-file locations, then start `personal-reader`.
2. Validate configuration, open SQLite, and apply pending migrations.
3. Verify the configured OpenAI-compatible model with a minimal structured request.
4. If HN account settings are present, validate the session without performing a mutation.
5. Authenticate through the single-user access flow and open the reader.

**Serving components:** `services/personal-reader` → `config` → `database` / `reader-store` → `access-control`; `llm-openai-compatible`; optional `hn-account`; `reader-app`.

**Acceptance criteria:**
- Invalid or incomplete required configuration prevents startup and names the invalid keys without exposing secret values.
- A valid start applies migrations and reports readiness after local configuration, SQLite, and worker checks pass. External probe failures appear as degraded capabilities while stored reading remains available.
- Every deployment mode requires the single-user access token; public/non-loopback operation additionally requires HTTPS-aware cookie policy.
- The core application can become ready without optional HN account credentials; account-dependent actions remain visibly unavailable.
- Secrets and HN cookies never appear in logs, readiness responses, or the debug window.

## WF-02 — Collect stories continuously while away

**User:** Reader, with the Operator's instance running unattended  
**Goal:** Preserve new HN stories without checking the site.

**Steps:**
1. The scheduler enqueues periodic ingestion.
2. Seed configured public feeds on first run and establish a `maxitem` cursor.
3. Advance the cursor through new HN item IDs, retaining story items and ignoring non-story items for the reading queue.
4. Upsert stories idempotently, insert initial pending queue entries, record sync progress, and enqueue article extraction and recommendation work in the same batch transaction.
5. Refresh changed story metadata according to policy and recover from the durable cursor after restart.

**Serving components:** `scheduler` → `job-queue` → `reader-app` → `hn-ingestion` → `hn-public-api` → `reader-store`; then `article-reader` and `personalization` jobs.

**Acceptance criteria:**
- Reprocessing an item or restarting a sync does not duplicate stories, activity, recommendations, or queue entries.
- The cursor and story upserts commit atomically per ingestion batch.
- A failed article or LLM job leaves the story and an unscored queue entry reachable.
- A temporary HN failure uses bounded retry and does not advance past unprocessed items.
- First-run behavior does not require an unbounded historical HN backfill.

## WF-03 — Return to a complete personalized queue

**User:** Reader  
**Goal:** Find every eligible collected story in a useful order after time away.

**Steps:**
1. Open the queue and select unread, reading, read, dismissed, or all history.
2. Read strong personal matches first, with exploration entries labeled as such.
3. Continue through cursor-based pages without a silent total cap.
4. See pending and failed evaluation states rather than inferring that those stories were rejected.
5. Open an explanation to inspect the profile/content versions, evidence, and model rationale.

**Serving components:** `services/personal-reader` → `reader-app` → `queue` / `reader-store`; explanations from `recommendations` through `personalization`.

**Acceptance criteria:**
- Every non-blacklisted collected story remains reachable, including unscored and failed items.
- Pagination has a stable order and no duplicate or omitted entries while the underlying queue is unchanged.
- Exploration never overrides an explicit blacklist.
- Explanations identify the recommendation and profile versions actually used.
- Blacklisting hides queue entries without deleting story or activity history.

## WF-04 — Read inside the app and learn naturally

**User:** Reader  
**Goal:** Read a story in a consistent embedded view while normal activity improves future ranking.

**Steps:**
1. Open a story and load cached or freshly fetched extracted content.
2. If extraction is unavailable, use the original-page fallback with a clear indication of reduced observation.
3. Record impressions, opens, active dwell, scroll progress, completion, and skips through activity batches with client idempotency keys.
4. Change reading state through the queue-state command; same-state requests are idempotent and do not synthesize activity observations.
5. Reduce activity batches into reading sessions and append immutable observations.
6. Trigger asynchronous profile and recommendation updates without delaying the reading response.

**Serving components:** `services/personal-reader` → `reader-app` → `article-reader` → `article-fetcher` / `article-extractor`; `activity` → `reader-store`; `personalization` jobs.

**Acceptance criteria:**
- Article markup is sanitized, scripts and remote subresources are not executed by the extraction DOM, and rendered content is protected by CSP.
- Arbitrary article fetching enforces protocol, address, redirect, timeout, and size policies.
- Repeated activity batches with the same idempotency keys do not create duplicate events.
- Inactive time is not counted as active dwell; original-page fallback is marked as partially observed.
- Story content remains available even when personalization work fails.

## WF-05 — Perform an explicit HN account action

**User:** Reader  
**Goal:** Upvote, flag, or favorite from the reader and have both local learning and HN reflect the action.

**Steps:**
1. Request an action explicitly; no agent or ranking process initiates it.
2. Persist a local action intent and obtain a fresh action link from the authenticated HN page.
3. Perform the action with throttling and verify the resulting HN state where possible.
4. Record the verified outcome and feed it into personalization.
5. If verification fails, show an indeterminate state instead of claiming success; reconcile later.

**Serving components:** `services/personal-reader` → `reader-app` → `hn-account` + `activity` → `reader-store`; `personalization`.

**Acceptance criteria:**
- Every HN mutation has a user intent and a locally auditable outcome.
- Retries first re-read state so an indeterminate earlier request is not blindly repeated.
- HN eligibility, expired sessions, and changed markup produce explicit errors without corrupting local reading state.
- Actions performed elsewhere are reconciled only as current-state observations, not fabricated timestamped events.
- Flag synchronization is not claimed until authenticated readback is verified.

## WF-06 — Inspect and correct personalization

**User:** Reader  
**Goal:** Tell the system what to include or exclude and correct unwanted recommendations.

**Steps:**
1. Add, edit, disable, or remove explicit interest and blacklist rules.
2. Dismiss a story or correct its recommendation.
3. Create a new interest-profile version from explicit rules and weighted activity.
4. Apply blacklist changes immediately and re-rank affected stories asynchronously.
5. Inspect why the new profile produced a different result.

**Serving components:** `services/personal-reader` → `reader-app` → `interests` / `activity` → `reader-store`; `personalization` → `recommendations` → `llm-interface`; `queue`.

**Acceptance criteria:**
- Explicit blacklist rules take precedence over inferred interests and exploration.
- Each profile is reproducible from its immutable source-rule snapshot, activity version, policy snapshot, and builder version.
- Corrections do not rewrite historical activity or earlier recommendation explanations.
- Profile changes do not make previously collected stories unreachable.
- Dwell and skip signals are treated as ambiguous evidence, not direct likes/dislikes.

## WF-07 — Recover after shutdown or failure

**User:** Operator  
**Goal:** Restart the instance without losing collection, queue state, or unfinished work.

**Steps:**
1. Start the service against the existing SQLite file.
2. Recover migrations and integrity status before accepting traffic.
3. Expire abandoned job leases and requeue eligible work with bounded attempts.
4. Resume ingestion from durable cursors and scoring from stored story/profile versions.
5. Continue serving the complete queue while deferred work catches up.

**Serving components:** `services/personal-reader` → `database` / `reader-store` → `job-queue` → `reader-app` → `hn-ingestion` / `personalization` / `article-reader`.

**Acceptance criteria:**
- Queue, activity, preferences, and cursors survive a real process restart.
- A job can run more than once without duplicating logical effects.
- Exhausted jobs become visibly failed and do not block unrelated work.
- Readiness distinguishes a usable reader from a temporarily unavailable external integration.
- The service shuts down within the configured grace period and closes streams, timers, workers, and SQLite.

## WF-08 — Inspect health and debug behavior

**User:** Operator  
**Goal:** Understand what the collector, recommender, LLM, and queue are doing without inspecting the database manually.

**Steps:**
1. Read liveness and readiness endpoints.
2. Enable the authenticated debug window explicitly.
3. Inspect sync runs, job leases/attempts, queue counts by evaluation state, recent errors, and redacted LLM usage.
4. Follow a correlated operation through structured logs and debug state.
5. Disable payload capture by default and disable the debug surface when finished.

**Serving components:** `services/personal-reader` → `diagnostics` → `reader-store` / `job-queue`; `logging`; authenticated debug routes and UI drawer.

**Acceptance criteria:**
- Liveness needs no external service; readiness reports required dependency state and optional HN account state separately.
- Debug endpoints and UI require the same access control as mutations.
- `debug.enabled=false` removes the debug UI and rejects debug API routes.
- Raw prompts, profile payloads, access tokens, HN cookies, and article content are not exposed unless an explicit, auditable payload option is enabled; secret values are never exposed.
- An agent can assert all workflow outcomes through HTTP/API and browser harness instrumentation.
