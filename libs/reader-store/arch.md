# Reader Store Library Architecture

## Internal modules

Repositories are grouped by aggregate, not by HTTP resource:

- `story-repository` and `article-repository`: normalized HN content and extraction state.
- `activity-repository` and `session-repository`: immutable observations plus their projection.
- `preference-repository`, `profile-repository`, and `recommendation-repository`: versioned personalization evidence.
- `queue-repository`: current reading/ranking projection and keyset pages.
- `sync-repository`, `llm-call-repository`, `diagnostic-error-repository`, `access-session-repository`, and `hn-*-repository`: operational and account records. Diagnostic errors are a union read projection over owned tables, not a new table; failed jobs join that projection in diagnostics through job-queue.
- `migrations`: ordered SQL strings for all store-owned tables and indexes.
- `rows`: explicit null/boolean/date/JSON mapping and domain-schema parsing.

A single `ReaderStore` object exposes these repositories over one `Database`; repositories do not open their own connections.

## Query design

All values are bound parameters. Queries use the indexes documented in the architecture and deterministic tie-breakers. Large operations are keyset-paged by story ID, `(receivedAt,id)`, `(createdAt,id)`, or queue position rather than using unbounded result sets or offset pagination.

Queue pagination has two layers. `queue` encodes/decodes a versioned opaque cursor; `reader-store` receives its decoded rank version, evaluation section, optional rank position, and story ID. SQL then applies the corresponding keyset predicate. The store never parses transport strings and never imports queue policy.

The active recommendation is resolved through `queue_entries.recommendation_id`. Created-time latest queries exist for history/debugging only, avoiding accidental explanation drift when several profiles coexist. Activity reduction uses the latest active-or-terminal session, not an active-only lookup. Interest building reads `latestWindow` and `latestVersion` separately so an empty zero-sized suffix still carries the actual log version.

## JSON and immutable data

JSON columns hold genuinely variable evidence, raw source envelopes, policy snapshots, and payloads. Core filtering fields remain relational. Deserialization follows `JSON.parse → domain schema → owning library parser` as applicable. Serialization is deterministic at producer boundaries so idempotent comparisons and version hashes are stable.

Immutability is enforced by repository APIs rather than database triggers: no update method exists for events, profiles, recommendations, or LLM audits. Exact duplicate inserts support at-least-once retries; conflicting duplicates fail loudly. Producers derive deterministic IDs for logical recommendation results.

## Transaction composition

The store exposes the shared synchronous transaction helper. Application compositions, not individual repository methods, define multi-aggregate boundaries. For example, activity append + session projection + profile-job enqueue is one outer transaction, with queue enqueue using a nested savepoint. External calls always happen before a result transaction or after an intent transaction.

Repository methods do not start external work, await, or silently catch a failed write. SQLite foreign keys and unique constraints back the domain invariants, while store errors translate expected conflicts.

## Migration ownership

One ordered migration array, identified `0010_reader_foundation`, creates all reader-domain, ingestion, account-action, LLM-audit, and access-session tables. `job-queue` exports its separate `0020_job_queue` migration; `database` owns the ledger. The service concatenates and migrates these arrays globally in that order. A repository never migrates lazily during a request.

## Trade-offs

- Explicit SQL and row mappers create more code than an ORM but make transaction and keyset behavior reviewable.
- Strict immutable-conflict checks require deterministic producer IDs; they prevent a retry from masking a changed logical result.
- Repository-level immutability is appropriate for one trusted writer, not a defense against arbitrary database users.
- One current queue row per story simplifies reads; complete historical explanations remain in recommendations rather than queue history.

## Testing seams

Integration tests run against real SQLite with all migrations applied. They exercise rollback across repository/job boundaries, JSON corruption, constraint conflicts, and restart persistence. Query tests build ordered fixtures across page boundaries and evaluation sections; no mock database is used for SQL behavior.
