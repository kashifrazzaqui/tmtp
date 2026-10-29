# Architecture

## System intent and shape

`tmtp` is a single-user, self-hosted personal reading layer for Hacker News. It continuously collects public stories, preserves a complete reading queue, learns from in-app activity and explicit preferences, and uses an OpenAI-compatible LLM for explainable judgments. A laptop and a personal server run the same artifact.

The runtime is a **single-process modular monolith** with **one SQLite database**. Library boundaries carry domain separation; only `services/personal-reader` knows HTTP, browser UI, schedules, startup, and shutdown. There is no Redis, broker, separate worker, vector database, production browser automation, or UI SSR server.

## Component tree

```text
services/personal-reader
├── reader-app
│   ├── article-reader
│   │   ├── article-fetcher
│   │   │   └── http-client → clock, logging, retry
│   │   └── article-extractor
│   ├── hn-ingestion
│   │   ├── hn-public-api → domain, http-client
│   │   ├── hn-account → clock, domain, http-client
│   │   ├── reader-store → database, domain
│   │   ├── job-queue → clock, database, domain
│   │   └── clock, domain, interests
│   ├── personalization
│   │   ├── activity → clock, domain
│   │   ├── interests → domain
│   │   ├── recommendations → domain, interests, llm-interface, queue
│   │   ├── queue → domain
│   │   ├── reader-store
│   │   └── clock, llm-interface, job-queue
│   ├── activity
│   ├── hn-account
│   ├── queue
│   ├── reader-store
│   └── job-queue
├── diagnostics → clock, domain, job-queue, reader-store
├── access-control → clock; structural session-store port implemented by reader-store
├── scheduler → clock, logging
├── llm-openai-compatible → llm-interface
├── config → Zod
├── database → better-sqlite3
└── static React/Vite/MUI reader and Fastify transport
```

Every component is a workspace package under `libs/*` or `services/*`. Each has a co-located `spec.md`.

## Dependency graph and tiers

Dependencies point downward. No dependency cycles exist. Type-only dependencies count in this graph; `retry` uses a structural sleep function to remain tier 0.

| Tier | Package | Internal dependencies | External basis |
|---|---|---|---|
| 0 | `clock` | none | Node runtime |
| 0 | `config` | none | Zod |
| 0 | `database` | none | better-sqlite3, handwritten migrations |
| 0 | `domain` | none | Zod |
| 0 | `llm-interface` | none | TypeScript only |
| 0 | `logging` | none | Pino |
| 0 | `retry` | none | p-retry |
| 0 | `article-extractor` | none | Readability, jsdom, DOMPurify |
| 1 | `access-control` | clock | Node Web Crypto |
| 1 | `activity` | clock, domain | TypeScript |
| 1 | `http-client` | clock, logging, retry | Undici |
| 1 | `interests` | domain | TypeScript |
| 1 | `job-queue` | clock, database, domain | SQLite |
| 1 | `llm-openai-compatible` | llm-interface | OpenAI Node SDK |
| 1 | `queue` | domain | TypeScript |
| 1 | `reader-store` | database, domain | handwritten SQL |
| 1 | `scheduler` | clock, logging | Croner |
| 2 | `article-fetcher` | clock, http-client | ip-address, Undici through http-client |
| 2 | `diagnostics` | clock, domain, job-queue, reader-store | composition |
| 2 | `hn-account` | clock, domain, http-client | Cheerio |
| 2 | `hn-public-api` | domain, http-client | official HN API |
| 2 | `recommendations` | domain, interests, llm-interface, queue | TypeScript/Zod boundary |
| 3 | `article-reader` | article-extractor, article-fetcher, domain | composition |
| 3 | `hn-ingestion` | clock, domain, hn-account, hn-public-api, interests, job-queue, reader-store | composition |
| 3 | `personalization` | activity, clock, domain, interests, job-queue, llm-interface, queue, reader-store, recommendations | composition |
| 4 | `reader-app` | activity, article-reader, domain, hn-account, hn-ingestion, job-queue, personalization, queue, reader-store | composition |
| 5 | `services/personal-reader` | all direct and transitive libraries | Fastify, React, Vite, MUI, TanStack Query, React Router |

### Interface and composition boundaries

- `llm-interface` contains no runtime dependencies. The OpenAI-compatible adapter is replaceable without changing recommendation logic.
- `access-control` declares a structural session-store port. `reader-store` satisfies it without either package importing the other.
- `article-fetcher` performs network policy; `article-extractor` is pure untrusted-HTML transformation; `article-reader` composes them.
- `reader-app` is the only application façade used by HTTP and job handlers. Lower libraries do not call upward.
- `scheduler` is in-memory scheduling only. `job-queue` provides durability and restart recovery.

## Workflow map

| Workflow | Serving chain |
|---|---|
| WF-01 install/connect | service → config/database/reader-store → access-control; LLM adapter; optional HN account |
| WF-02 continuous collection | scheduler → job-queue → reader-app → hn-ingestion → hn-public-api → reader-store; article/personalization jobs |
| WF-03 complete queue | service → reader-app → queue/reader-store; recommendation records from personalization |
| WF-04 embedded reading/activity | service → reader-app → article-reader → article-fetcher/article-extractor; activity → reader-store → personalization |
| WF-05 HN account action | service → reader-app → hn-account + activity → reader-store → personalization |
| WF-06 personalization control | service → reader-app → interests/personalization → recommendations/llm-interface → queue/reader-store |
| WF-07 restart/recovery | service → database/reader-store → job-queue → reader-app → ingestion/article/personalization |
| WF-08 health/debug | service → diagnostics → reader-store/job-queue; logging; authenticated debug API/SSE/UI |

No component lacks a serving workflow. `clock`, `config`, `database`, `domain`, `http-client`, `llm-interface`, `logging`, and `retry` are foundational primitives used by those chains rather than user features on their own.

## Dependency-aware implementation order

The canonical build order is [implementation-order.yaml](implementation-order.yaml). In prose:

1. **A / tier 0:** time, config, SQLite, domain schemas, article extraction, LLM port, logs, retry.
2. **B / tier 1:** access, activity, HTTP, interests, durable jobs, LLM adapter, queue, repositories, scheduler.
3. **C / tier 2:** safe article fetch, diagnostics, public/account HN clients, recommendations.
4. **D / tier 3:** article-reading, ingestion, and personalization compositions.
5. **E / tier 4:** transport-free application façade.
6. **F / tier 5:** Fastify/React service, lifecycle, health/debug surfaces, and end-to-end harnesses.

Each phase must pass its own library tests and the workflow acceptance flows available at that layer before the next phase begins.

## Persistence layout

### Model and topology

One SQLite file holds relational current state, append-only reading observations, durable jobs, and audit/debug records. It is not fully event-sourced. One service owns writes; WAL and a busy timeout permit concurrent readers. JSON is used for versioned evidence/payload fields where the shape is genuinely variable; core query fields remain relational.

All timestamps are ISO-8601 UTC text. IDs generated by the application are cryptographically random strings. HN item IDs are integers. `ON DELETE` is restrictive by default: historical activity and recommendations are not cascade-deleted by story cleanup.

### Full schema

#### `schema_migrations`
- `id TEXT PRIMARY KEY`
- `checksum TEXT NOT NULL`
- `applied_at TEXT NOT NULL`

#### `stories`
- `id INTEGER PRIMARY KEY` — HN item ID.
- `item_type TEXT NOT NULL CHECK (item_type = 'story')`
- `url TEXT NULL`, `canonical_url TEXT NULL`
- `title TEXT NOT NULL`, `author TEXT NULL`, `text_html TEXT NULL`
- `score INTEGER NULL`, `descendants INTEGER NULL`
- `published_at TEXT NOT NULL`, `first_seen_at TEXT NOT NULL`, `last_seen_at TEXT NOT NULL`
- `content_version TEXT NOT NULL`
- `raw_json TEXT NOT NULL`, `raw_schema_version INTEGER NOT NULL` — versioned public API source envelope.
- `deleted INTEGER NOT NULL DEFAULT 0`, `dead INTEGER NOT NULL DEFAULT 0`
- Indexes: `(published_at, id)`, `(canonical_url)`, `(last_seen_at)`.

#### `articles`
- `story_id INTEGER PRIMARY KEY REFERENCES stories(id)`
- `status TEXT NOT NULL CHECK (status IN ('pending','ready','failed'))`
- `source_content_version TEXT NOT NULL` — story version used for this extraction attempt.
- `content_version TEXT NOT NULL` — domain-derived scoring-input version; missing articles use the logical version `none`.
- `source_url TEXT NULL`, `final_url TEXT NULL`
- `title TEXT NULL`, `byline TEXT NULL`, `excerpt TEXT NULL`
- `text_content TEXT NULL`, `sanitized_html TEXT NULL`
- `content_hash TEXT NULL`, `extractor_version TEXT NULL`
- `fetched_at TEXT NULL`, `updated_at TEXT NOT NULL`
- `error_code TEXT NULL`, `error_message TEXT NULL`
- Indexes: `(status, updated_at)`, `(content_hash)`.

#### `ingestion_cursors`
- `name TEXT PRIMARY KEY`
- `value TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

#### `ingestion_runs`
- `id TEXT PRIMARY KEY`
- `kind TEXT NOT NULL`, `status TEXT NOT NULL CHECK (status IN ('running','complete','failed'))`
- `cursor_start TEXT NULL`, `cursor_end TEXT NULL`
- `stories_upserted INTEGER NOT NULL`, `non_stories_skipped INTEGER NOT NULL`
- `error_code TEXT NULL`, `error_message TEXT NULL`
- `started_at TEXT NOT NULL`, `completed_at TEXT NULL`
- Index: `(kind, started_at)`.

#### `reading_events`
- `sequence INTEGER PRIMARY KEY AUTOINCREMENT` — durable append order and canonical activity-head version; gaps are permitted.
- `id TEXT NOT NULL UNIQUE`
- `client_event_id TEXT NOT NULL UNIQUE`
- `story_id INTEGER NOT NULL REFERENCES stories(id)`
- `kind TEXT NOT NULL`
- `value_json TEXT NULL`, `value_schema_version INTEGER NOT NULL`
- `source TEXT NOT NULL CHECK (source IN ('embedded-reader','original-page','hn-reconciliation','app-action'))`
- `observation_quality TEXT NOT NULL CHECK (observation_quality IN ('full','partial'))`
- `occurred_at TEXT NOT NULL`, `received_at TEXT NOT NULL`
- Indexes: `(story_id, occurred_at)`, `(kind, occurred_at)`; primary-key order supplies activity heads/windows/keysets.

#### `reading_sessions`
- `id TEXT PRIMARY KEY`
- `story_id INTEGER NOT NULL REFERENCES stories(id)`
- `started_at TEXT NOT NULL`, `ended_at TEXT NULL`, `updated_at TEXT NOT NULL`
- `active_dwell_ms INTEGER NOT NULL`, `max_scroll_ratio REAL NOT NULL`
- `state TEXT NOT NULL CHECK (state IN ('active','complete','abandoned'))`
- `observation_quality TEXT NOT NULL CHECK (observation_quality IN ('full','partial'))`
- `last_client_event_id TEXT NOT NULL UNIQUE`
- Indexes: `(story_id, updated_at)`, `(state, updated_at)`.

#### `preference_rules`
- `id TEXT PRIMARY KEY`
- `kind TEXT NOT NULL CHECK (kind IN ('topic','keyword','author','domain'))`
- `effect TEXT NOT NULL CHECK (effect IN ('include','exclude'))`
- `value TEXT NOT NULL`, `normalized_value TEXT NOT NULL`
- `enabled INTEGER NOT NULL`
- `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`
- Unique: `(kind, effect, normalized_value)`; index `(enabled, effect)`.

#### `interest_profiles`
- `id TEXT PRIMARY KEY`
- `rules_version TEXT NOT NULL`, `activity_version TEXT NOT NULL`
- `source_rules_json TEXT NOT NULL`, `source_rules_schema_version INTEGER NOT NULL`
- `policy_json TEXT NOT NULL`, `policy_schema_version INTEGER NOT NULL`, `policy_version TEXT NOT NULL`, `builder_version TEXT NOT NULL`
- `profile_json TEXT NOT NULL`, `profile_schema_version INTEGER NOT NULL`
- `reason TEXT NOT NULL`, `created_at TEXT NOT NULL`
- Unique: `(rules_version, activity_version, policy_version, builder_version)`; index `(created_at, id)`.

#### `current_profile`
- `id INTEGER PRIMARY KEY CHECK (id = 1)` — singleton mutable selection, separate from immutable profile history.
- `profile_id TEXT NOT NULL REFERENCES interest_profiles(id)`
- `selected_at TEXT NOT NULL`

#### `recommendations`
- `id TEXT PRIMARY KEY`
- `story_id INTEGER NOT NULL REFERENCES stories(id)`
- `profile_id TEXT NOT NULL REFERENCES interest_profiles(id)`
- `story_content_version TEXT NOT NULL`, `article_content_version TEXT NOT NULL`, `prompt_version TEXT NOT NULL`, `model TEXT NOT NULL`
- `score REAL NOT NULL`, `rationale TEXT NOT NULL`
- `evidence_json TEXT NOT NULL`, `evidence_schema_version INTEGER NOT NULL`
- `llm_call_id TEXT NULL REFERENCES llm_calls(id)`
- `created_at TEXT NOT NULL`
- Unique: `(story_id, profile_id, story_content_version, article_content_version, prompt_version, model)`.
- Index: `(profile_id, story_id)`.

#### `queue_entries`
- `story_id INTEGER PRIMARY KEY REFERENCES stories(id)`
- `state TEXT NOT NULL CHECK (state IN ('unread','reading','read','dismissed','archived'))`
- `evaluation_state TEXT NOT NULL CHECK (evaluation_state IN ('pending','scored','failed'))`
- `visibility_state TEXT NOT NULL CHECK (visibility_state IN ('visible','blacklisted'))`
- `kind TEXT NOT NULL CHECK (kind IN ('match','exploration'))`
- `recommendation_id TEXT NULL REFERENCES recommendations(id)`
- `rank_score REAL NULL`, `rank_position INTEGER NULL`, `rank_version TEXT NOT NULL`
- `last_error TEXT NULL`
- `queued_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`
- Indexes: `(visibility_state, state, rank_version, rank_position, story_id)`, `(evaluation_state, updated_at)`.

#### `queue_projection`
- `id INTEGER PRIMARY KEY CHECK (id = 1)` — singleton active queue-projection pointer.
- `profile_id TEXT NOT NULL REFERENCES interest_profiles(id)`
- `rank_version TEXT NULL` — null only after a complete empty projection; readers then use the bootstrap namespace.
- `projected_at TEXT NOT NULL`
- Updated atomically with complete queue writes so new pending rows join the active namespace instead of disappearing into a separate bootstrap page.

#### `hn_action_intents`
- `id TEXT PRIMARY KEY`
- `story_id INTEGER NOT NULL REFERENCES stories(id)`
- `action TEXT NOT NULL CHECK (action IN ('upvote','flag','favorite'))`
- `idempotency_key TEXT NOT NULL UNIQUE`
- `status TEXT NOT NULL CHECK (status IN ('pending','verified','indeterminate','failed'))`
- `result_json TEXT NULL`, `result_schema_version INTEGER NULL`, `error_code TEXT NULL`
- `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`
- Indexes: `(story_id, action, created_at)`, `(status, story_id, action, created_at, id)` for filtered reconciliation.

#### `hn_account_states`
- `username TEXT NOT NULL`
- `story_id INTEGER NOT NULL REFERENCES stories(id)`
- `kind TEXT NOT NULL CHECK (kind IN ('upvote','flag','favorite'))`
- `present INTEGER NOT NULL`
- `first_observed_at TEXT NOT NULL`, `last_observed_at TEXT NOT NULL`
- `source_cursor TEXT NULL`
- Primary key: `(username, story_id, kind)`; indexes `(username, kind, present)` and `(username, kind, story_id)` for observation-bounded reads.

#### `jobs`
- `id TEXT PRIMARY KEY`
- `kind TEXT NOT NULL`, `payload_json TEXT NOT NULL`, `payload_schema_version INTEGER NOT NULL`
- `dedupe_key TEXT NULL`
- `status TEXT NOT NULL CHECK (status IN ('queued','leased','done','failed'))`
- `run_after TEXT NOT NULL`
- `lease_token TEXT NULL`, `lease_expires_at TEXT NULL`
- `attempts INTEGER NOT NULL`, `max_attempts INTEGER NOT NULL`
- `last_error_code TEXT NULL`, `last_error TEXT NULL`
- `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`, `completed_at TEXT NULL`
- Unique active dedupe index: `(kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','leased')`.
- Claim index: `(status, run_after, created_at)`; lease index `(lease_expires_at)`.

#### `llm_calls`
- `id TEXT PRIMARY KEY`
- `purpose TEXT NOT NULL`, `model TEXT NOT NULL`, `status TEXT NOT NULL`
- `request_hash TEXT NOT NULL`
- `input_tokens INTEGER NULL`, `output_tokens INTEGER NULL`, `latency_ms INTEGER NOT NULL`
- `provider_request_id TEXT NULL`, `error_code TEXT NULL`
- `request_payload_json TEXT NULL`, `request_payload_schema_version INTEGER NULL`
- `response_payload_json TEXT NULL`, `response_payload_schema_version INTEGER NULL` — payload fields are null unless explicit debug capture is enabled.
- `created_at TEXT NOT NULL`
- Indexes: `(created_at, id)`, `(request_hash)`, `(purpose, status)`.

#### `access_sessions`
- `session_hash TEXT PRIMARY KEY`
- `csrf_secret_hash TEXT NOT NULL`
- `created_at TEXT NOT NULL`, `expires_at TEXT NOT NULL`, `last_used_at TEXT NOT NULL`
- `revoked_at TEXT NULL`
- Indexes: `(expires_at)`, `(revoked_at)`.

### Transactional boundaries

- **Migration:** one migration and its ledger row commit atomically.
- **Ingestion batch:** story upserts, initial pending queue entries, cursor advance, run counters, and job dedupe inserts commit atomically. Existing reading/ranking state is preserved. HN calls happen before the transaction.
- **Activity batch:** immutable events, reading-session projection, and profile-work job commit atomically.
- **Preference change:** validated rules, inserted/reused immutable profile, current-profile pointer, visibility updates, and scoring jobs commit after pure profile computation; reverting to an older profile moves the pointer without rewriting history. LLM work follows later.
- **Recommendation result:** judgments, LLM usage, evaluation states, and queue projection commit after external calls complete.
- **HN action:** intent commits before the external request; outcome commits afterward. These are separate transactions so indeterminate outcomes survive crashes.
- **Job claim/finish/recovery:** state transitions compare lease tokens and commit atomically. External effects are at-least-once and need idempotency/reconciliation.

## Configuration overview

The plan does not prescribe how values are loaded. All values converge on one validated object. Secret files contain only secret values; paths and non-secret policy live in configuration. Required keys have no default. Defaults below are part of the component contract, not inline implementation literals.

| Key | Owner | Required / optional default |
|---|---|---|
| `server.host` | service | optional `127.0.0.1` |
| `server.port` | service | optional `3000` |
| `server.public_base_url` | service | optional `null` |
| `server.trust_proxy` | service | optional `false` |
| `server.shutdown_grace_ms` | service | optional `10000` |
| `auth.access_token_path` | access-control | **required** |
| `auth.session_ttl_seconds` | access-control | optional `604800` |
| `auth.login_max_attempts` | access-control | optional `10` |
| `auth.login_window_seconds` | access-control | optional `300` |
| `database.path` | database | **required** |
| `database.busy_timeout_ms` | database | optional `5000` |
| `database.wal` | database | optional `true` |
| `logging.level` | logging | optional `info` |
| `scheduler.timezone` | scheduler | optional `UTC` |
| `scheduler.overrun_protection` | scheduler | optional `true` |
| `jobs.poll_interval_ms` | job-queue | optional `1000` |
| `jobs.lease_ms` | job-queue | optional `120000` |
| `jobs.max_attempts` | job-queue | optional `5` |
| `jobs.backoff_base_ms` | job-queue | optional `1000` |
| `jobs.backoff_max_ms` | job-queue | optional `300000` |
| `jobs.batch_size` | job-queue | optional `20` |
| `http.timeout_ms` | http-client | optional `20000` |
| `http.retry.max_attempts` | http-client | optional `3` |
| `http.retry.base_delay_ms` | http-client | optional `500` |
| `http.retry.max_delay_ms` | http-client | optional `8000` |
| `http.retry.jitter_ratio` | http-client | optional `0.2` |
| `http.user_agent` | http-client | optional `tmtp-personal-reader/0.1` |
| `hn.api_base_url` | hn-public-api | optional `https://hacker-news.firebaseio.com/v0` |
| `hn.web_base_url` | hn-account | optional `https://news.ycombinator.com` |
| `hn.username` | hn-account | optional `null`; paired with session cookie path |
| `hn.session_cookie_path` | hn-account | optional `null`; paired with username |
| `hn.max_requests_per_minute` | hn-account | optional `10` |
| `hn.flag_readback_enabled` | hn-account | optional `false` |
| `ingestion.cron` | hn-ingestion | optional `*/15 * * * *` |
| `ingestion.feeds` | hn-ingestion | optional `["top","new","best","ask","show"]` |
| `ingestion.initial_lookback_items` | hn-ingestion | optional `0` |
| `ingestion.max_items_per_run` | hn-ingestion | optional `2000` |
| `ingestion.refresh_batch_size` | hn-ingestion | optional `100` |
| `ingestion.refresh_after_hours` | hn-ingestion | optional `24` |
| `article.timeout_ms` | article-fetcher | optional `20000` |
| `article.dns_timeout_ms` | article-fetcher | optional `5000` |
| `article.max_response_bytes` | article-fetcher/article-reader | optional `5000000`; transfer/decoded fetch limit and complete local self-text input limit |
| `article.max_redirects` | article-fetcher | optional `5` |
| `article.allowed_protocols` | article-fetcher | optional `["https","http"]` |
| `article.allowed_ports` | article-fetcher | optional `[80,443]` |
| `article.max_content_chars` | article-extractor | optional `500000` |
| `activity.idle_timeout_ms` | activity | optional `60000` |
| `activity.min_dwell_ms` | activity | optional `1000` |
| `activity.max_session_gap_ms` | activity | optional `300000` |
| `interests.decay_half_life_days` | interests | optional `45` |
| `interests.max_inferred_topics` | interests | optional `50` |
| `interests.max_activity_events` | interests | optional `5000` |
| `llm.base_url` | llm-openai-compatible | **required** |
| `llm.api_key_path` | llm-openai-compatible | **required** |
| `llm.model` | llm-openai-compatible | **required** |
| `llm.timeout_ms` | llm-openai-compatible | optional `60000` |
| `llm.max_retries` | llm-openai-compatible | optional `2` |
| `llm.max_output_tokens` | llm-openai-compatible | optional `4096` |
| `recommendations.batch_size` | recommendations | optional `10` |
| `recommendations.max_stories_per_run` | recommendations | optional `50` |
| `recommendations.max_prompt_chars` | recommendations | optional `60000` |
| `recommendations.exploration_ratio` | recommendations | optional `0.1` |
| `queue.page_size` | queue | optional `50` |
| `queue.max_page_size` | queue | optional `200` |
| `personalization.cron` | personalization | optional `7,37 * * * *` |
| `personalization.activity_batch_size` | personalization | optional `500` |
| `personalization.queue_sync_batch_size` | personalization | optional `500` |
| `debug.enabled` | diagnostics | optional `false` |
| `debug.stream_interval_ms` | diagnostics | optional `2000` |
| `debug.include_llm_payloads` | diagnostics | optional `false` |

## Design language

### Adopted system

Use **MUI Material** as the component and accessibility foundation, themed through one central MUI theme and CSS variables. Do not build a parallel component system or copy generated components. The production UI is a static React SPA; TanStack Query handles server state and React Router handles declarative routes.

### Product character

The interface should feel like a calm personal reading room, not an analytics dashboard. Ranking and diagnostics are available without dominating the reading experience. Queue density supports scanning; the article view prioritizes sustained reading.

### Core tokens

- **Typography:** system sans for navigation and controls; `Charter`, `Iowan Old Style`, `Palatino Linotype`, serif for article content. Base body `16px`; article body `19px` with `1.65` line height; article measure `72ch`.
- **Spacing:** MUI 8px base grid; compact queue spacing 8/12px, page sections 24/32px, reader vertical rhythm 24px.
- **Light palette:** warm paper background, primary ink text, muted gray secondary text, and a restrained teal action/focus color.
- **Alternative schemes:** dark and sepia through MUI color schemes/CSS variables; explicit focus, error, pending, and exploration colors must meet contrast requirements in every scheme.
- **Shape/elevation:** modest radii and borders; minimal shadows. Cards are scanning containers, not floating dashboard tiles.
- **Motion:** short state transitions only; no animated ranking changes while a reader is scanning. Respect reduced-motion preferences.

### Shared components

- `AppShell`: queue, settings, health indicator, and optional debug navigation.
- `QueueList` / `StoryCard`: rank, title, source, evaluation state, match/exploration label, and reading state.
- `RecommendationReasonDrawer`: concise rationale, evidence, and story/profile/model versions.
- `ReaderView`: sanitized article, progress observation, original-page fallback, and reduced-observation notice.
- `PreferenceEditor`: explicit interests, exclusions, and correction feedback.
- `AuthPanel`, `HealthBanner`, and `Empty/ErrorState` with consistent recovery actions.
- `DebugDrawer`: sync, jobs, queue evaluation counts, LLM usage, and redacted errors; hidden unless enabled.

Accessibility remains an application responsibility: keyboard operation, visible focus, semantic headings/lists, contrast, reduced motion, and screen-reader labels require browser tests despite MUI's baseline behavior.

## External integration and security boundaries

- Public HN API content is the only required HN source. Account HTML is optional, throttled, unofficial, and capability-reported.
- Only user-originated commands may mutate HN. Fresh action links and post-action verification are mandatory; indeterminate outcomes remain explicit.
- LLM prompts contain only configured story/profile projections. The selected provider/model is visible, payload capture is off by default, and structured output is validated locally.
- Article fetch treats every URL and redirect as hostile. DOM script execution and subresource loading are disabled, extracted HTML is sanitized, and CSP is defense in depth.
- Public/custom-domain mode requires the single-user access flow, HTTPS-aware cookies, origin/CSRF checks, and a trusted-proxy decision. Passwords, signup, and multi-user auth are deliberately out of scope.
