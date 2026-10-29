# Diagnostics Library Architecture

## Design goal and boundary

Implement `spec.md` as a tier-2, transport-free, read-only composition over `reader-store` and `job-queue`. The package turns operational records into small safe DTOs; it is not a general serialization or observability framework.

The composition root supplies a fully migrated store, a queue on the same service database, time primitives, resolved debug policy, and exactly one secret source: a static loaded-secret array or a service-owned current-value provider. The service retains every responsibility that involves a socket, process lifecycle, configuration loading, access control, migrations, probes, workers, session expiry, or LLM execution.

## Internal decomposition

A minimal implementation can use these private modules with one public barrel:

| Module | Responsibility | Must not contain |
|---|---|---|
| `health` | Liveness, required-check aggregation, local/external capability projection | Probes, network calls, SQLite access |
| `debug-dto` | Explicit record-to-DTO mappers and safe-code normalization | Domain-record pass-through or arbitrary keys |
| `pages` | Query validation, deterministic read planning, cursor codec | Offset pagination or transport encoding |
| `redaction` | Static/per-unit secret snapshots, secret replacement, sensitive-key handling, URL/error suppression, string bounds | Public logging API, session registry ownership, or configurable bypass |
| `payloads` | JSON-only preview, visibility states, per-value and per-snapshot budgets | Audit capture or persistence |
| `snapshot` | Fixed-order section reads, failure isolation, snapshot metadata | Cross-section consistency claim |
| `stream` | Async iteration, sequence numbers, delay, cancellation, cleanup | HTTP, SSE framing, replay, heartbeat |
| `errors` | `DiagnosticsError` and fixed code/message mapping | Upstream messages or public causes |
| `index` | Public type/value exports | Side effects or global registries |

These are organizational units, not extra packages or package subpaths. Pure health, cursor, mapper, and sanitizer units should remain separately testable without SQLite.

## Composition and data flow

```text
Service startup/probes/worker state
             |
             v
   ReadinessInput / HealthInput
             |
             v
     health aggregation --------> liveness/readiness/capabilities DTOs

debugSnapshot / one debugStream frame
             |
             v
    validated bounded query plan
             |
             v
 resolve/copy one static or provider inventory for the unit
             |
     provider failure? ---- yes ----> fixed safe error; no snapshot/frame
             | no
             v
ReaderStore + JobQueue read models
             |
             v
  raw domain records (private) ---> allowlisted DTO mappers
             |                             |
             |                             +--> safe codes and bounded strings
             |                             +--> payload visibility and redaction
             |                             +--> optional next keyset cursor
             v
 section failure isolation + one generatedAt + payload budget
             |
             v
        DebugSnapshot
             |
             +------------------> one-shot caller
             |
             +--> async sequence --> service SSE adapter --> authenticated client
```

Diagnostics never reverses this flow. In particular, it does not call `LlmPort`, consume `LlmResult`/`LlmError` directly, insert `LlmCallRecord`, run a connection check, or infer payload capture from an HTTP request.

## Health aggregation

### Liveness and readiness

Liveness formats one `clock.now()` value. It has no storage branch and cannot be made unready by a dependency failure.

Readiness is a pure fold over four inputs in fixed order. Each input becomes one pass/fail DTO without losing its safe reason. The aggregate status is ready only when every check passes. Keeping the checks in a fixed order makes transport rendering and tests deterministic; it does not hide failed checks after the first one.

The service computes the inputs as follows:

- **Configuration:** required values loaded and validated. Secret values are not part of the input.
- **SQLite:** the shared connection can perform its required read/integrity checks.
- **Migrations:** the global reader-store/job-queue migration sequence is current and checksums match.
- **Workers:** startup lease recovery and other required recovery are complete, and all required loops are running.

An external connection check may run during startup, but its outcome belongs only to capabilities. This separation prevents an LLM or HN outage from blocking cached reading.

### Capabilities

Capabilities use the same local readiness inputs but answer a different question. `storedReading` ignores workers and integrations; `backgroundWork` requires complete readiness. Integration values are copied from the latest service probe, including `observedAt` and `unknown`, rather than refreshed inside diagnostics.

For a local failure, use the first failing local check to choose the safe capability reason. For an integration, the service maps its adapter's stable error category/code to the fixed capability reason before calling diagnostics. No adapter message is accepted as input.

A failed fresh-article capability says nothing about cached article availability. Likewise, failed personalization does not erase existing recommendations, and failed collection does not erase the existing queue. These are separate read paths by design.

## Debug read and DTO pipeline

### Validate, read, map, sanitize

One snapshot follows this order:

1. Validate debug policy and every query/cursor before any read.
2. Capture `generatedAt` once, resolve and defensively copy one secret inventory for the complete snapshot, and create a fresh 32 KiB included-payload budget. Static mode reuses its construction snapshot; provider mode calls the provider exactly once here. A provider failure aborts the whole snapshot before any DTO escapes.
3. Read sections in the documented fixed order with bounded queries.
4. Map each raw record through its own explicit DTO mapper.
5. Normalize codes and bound copied strings. For LLM payloads, apply visibility, recursive sanitization, and the shared budget.
6. Build a next cursor only from the last returned record's complete ordering key and filter fingerprint.
7. Convert an expected section read failure to that section's `unavailable` value and set top-level `partial`.

No mapper returns `{...record}`. Explicit field selection is the primary security boundary. Sanitization is the second boundary for values that are allowed to remain.

### DTO mapping choices

| Source | Retained operational evidence | Deliberately dropped |
|---|---|---|
| Current profile | Identity and version linkage | Rules, policy/interests payloads, reason text |
| Version counts | Exact active recommendation dimensions and count | Recommendation/rationale/evidence records |
| Sync run | Status, counters, safe error code, times | Cursors and error message |
| Job | State, timing, lease expiry, attempts | Payload, dedupe key, lease token, last error |
| Queue projection | Fixed pending/scored/failed counts | Story rows and queue error strings |
| LLM audit | Usage, latency, hash, status, safe code, explicit payload previews | Provider request ID, raw provider errors/headers |
| Diagnostic error | Stable identity/code/component and correlation IDs | Message, stack, cause, arbitrary context |

`read-failed` describes only a section read/projection failure. It does not pretend to explain the root cause; producers and service logs retain controlled internal detail. This is preferable to copying unsafe messages into an operator response.

## Pagination and cursors

### Keyset reads

Every page uses a unique deterministic order and a bounded keyset predicate. Descending operational histories compare the last `(timestamp,id)` backwards; ascending recommendation versions compare the last tuple forwards. The repository fetches at most `limit + 1` rows so `nextCursor` does not require an unbounded count query. The extra row is never returned.

An empty first page has no cursor. A full page has no cursor when no extra row exists. An unavailable section also has no cursor.

Queue evaluation counts are a fixed aggregate, not a page. The mapper starts with `{pending:0, scored:0, failed:0}` and copies only known keys, preventing arbitrary stored keys from expanding the DTO.

### Cursor representation

Use a small versioned JSON envelope encoded with base64url:

```text
{
  v: 1,
  section: "jobs" | "syncRuns" | "llmCalls" | "recentErrors" | "recommendationVersions",
  filterHash: "sha256:..." | undefined,
  key: [complete ordering fields...]
}
```

Canonical filter JSON includes status/kind values, never arbitrary query objects. SHA-256 from Node's built-in crypto is sufficient for the filter fingerprint and adds no package dependency. Cursor authenticity is not required for a read-only authenticated debug view; strict decoding, size limits, enum checks, and exact section/filter comparison are required. Do not accept unknown envelope keys or versions.

Cursors contain only non-secret ordering metadata. They are not authorization tokens and must not be logged as record content. The cursor codec has a 16 KiB encoded-size ceiling; an overlong or malformed cursor is rejected before storage access. Persisted ordering keys must fit the public string bounds. A record that cannot produce an unambiguous bounded cursor fails that section safely instead of truncating its key and risking skipped or duplicated records.

No cursor is stored server-side. Therefore concurrent calls are independent and there is no cursor cleanup lifecycle. The trade-off is that cursors reveal non-secret metadata to anyone already authorized to decode them; base64url is encoding, not encryption.

### Consistency limits

The package does not open one SQLite transaction around all sections. A long transaction would stall or complicate active ingestion for little operational benefit. Each page is internally deterministic, but:

- newer rows can appear in a later first-page snapshot;
- job updates can change filter membership;
- different sections can reflect different instants;
- an older page is not a continuation of a locked database snapshot.

This is why the API exposes `generatedAt` and avoids a global revision or consistency claim.

## Snapshot stream design

`debugStream` returns a fresh async iterator. Each iterator owns a small state record: next sequence, caller signal, an internal cancellation controller, settled flag, and any current sleep/listener state. It owns no queue.

For each `next()`:

1. If settled, return done.
2. For sequence 1, take the immediate snapshot. Otherwise use `clock.monotonicNowMs()` to await only the remaining configured delay from the previous snapshot's completion. A late pull proceeds immediately rather than creating a catch-up frame.
3. Link the caller signal and iterator-return cancellation to the sleep. Do not merge unrelated streams or use a global timer.
4. Take one first-page snapshot and return `{sequence, snapshot}`. The snapshot pipeline's single provider resolution is the frame's only provider call; do not resolve again at the frame boundary.
5. Increment sequence only for an emitted frame. A provider failure rejects the pull with the fixed safe error, returns no frame, consumes no sequence number, and is not retried automatically.

An async iterator naturally applies pull backpressure: work for a later frame does not start while the consumer has not requested it. If an implementation chooses to schedule the next wait after yielding, it must still prove that a paused consumer cannot accumulate frames or overlap reads. The simplest implementation performs work only in `next()` and remembers the prior completion time.

Serialize concurrent `next()` calls with a per-iterator promise chain. The chain preserves call order and assigns one sequence to each fulfilled frame; a settlement or abort prevents later queued calls from starting storage work. Do not use a shared stream queue.

Abort and `return()` share one settlement path. It cancels pending sleep, removes the abort listener, marks the iterator done, and prevents any later repository read. An already-aborted signal does not take an initial snapshot. Abort during sleep rejects with the exact original reason; iterator-initiated return finishes cleanly. Synchronous SQLite work already running on the JavaScript thread cannot be preempted, but no new work starts after settlement.

The service owns any mapping to SSE. It should send complete frames, close the iterator on disconnect/shutdown, and avoid serializing abort reasons. Heartbeats and reconnect handling stay in Fastify. Since there is no replay buffer, a reconnect is simply a new iterator with sequence 1 and a full snapshot.

## Redaction and payload preview design

### Policy order

The order is security-relevant:

1. Select allowlisted DTO fields.
2. Drop forbidden structures wholesale, including raw headers, URL fields, and embedded error objects.
3. Copy JSON-compatible values without accessors or custom `toJSON` execution.
4. Replace sensitive-key values and registered secret substrings.
5. Replace absolute URL tokens inside retained strings.
6. Apply depth/node/entry/string bounds and record truncation.
7. Encode the sanitized JSON and enforce per-value and per-snapshot byte budgets.
8. Return only the resulting fresh value and its explicit preview state.

The sanitizer uses data-property descriptors for plain objects and arrays. It rejects class instances, functions, symbols, bigint, non-finite numbers, sparse arrays, cycles, and accessor properties rather than invoking application code. Persisted LLM payloads should already satisfy the LLM interface's JSON rules; this boundary still validates because debug output is a trust boundary.

Sensitive keys are normalized exactly once for comparison. A sensitive value is not traversed, which both avoids leaks and limits work. The additional diagnostics keys (`headers`, URL fields, error containers, and stack) close side channels that logging's general field policy does not need to cover. Non-success LLM response payloads are suppressed before recursive work.

The URL scanner recognizes absolute scheme URLs and protocol-relative URL tokens in retained strings, including surrounding punctuation without invoking a network parser. It replaces the whole token, not just its query or user-info. Fixed DTO mappers never create URL fields, so this scanner is limited to explicit payload previews.

### Registered secrets

The factory accepts exactly one of `secretValues` and `secretValuesProvider`. Static mode defensively snapshots `secretValues` at construction, preserving existing caller behavior. Provider mode calls the service-owned function once per complete one-shot snapshot or stream frame and defensively snapshots its plain string array for that unit. Both modes discard only empty strings. Sorting each applicable inventory by descending length provides longest-match-first replacement, with original order as a deterministic tie-breaker for equal-length values. Replacement runs on keys and string values before output truncation. It does not recursively scan `[Redacted]`.

The same per-unit inventory covers all DTO strings, cursors, keys, and payload previews. It is discarded when serialization settles; the diagnostics instance and stream retain only the provider function, never previous provider arrays. A service can maintain a bounded active-session registry behind the provider, adding values on issuance and removing them on logout, revocation, or expiry. The library owns neither that registry nor session expiry. The provider must be total and nonthrowing, and no arbitrary secret-bearing getter is invoked.

The service must construct logging and diagnostics from equivalent current secret inventories, whether static or provider-backed. The two packages enforce different output boundaries and do not share a runtime redactor: logging is tier 0 with no exported sanitizer, while diagnostics is tier 2 and must not gain a logging dependency merely to reuse private code.

A provider throw or invalid result is a programmer error and fails closed. Do not substitute a startup/static baseline, empty set, last-known inventory, or partial array. The snapshot/frame boundary throws the fixed `DiagnosticsError` code `redaction-provider-failed`, with no public cause, provider values, or provider exception text. This is a whole-unit failure, not an unavailable section, and no raw or partial DTO escapes. Provider mode leaves every allowlist, no-debug-content rule, payload visibility state, and budget unchanged.

Exact-value replacement cannot discover an unregistered or transformed secret. The producer-side no-secret rule remains mandatory, especially for prompts and provider output.

### Budgets and deterministic omission

Apply depth, node, entry, and string limits while copying. Mark `truncated` when any of them changes content. Then measure encoded UTF-8 JSON, not the original payload. If the value exceeds 8 KiB, omit the entire value rather than returning malformed JSON or a misleading partial prompt. This per-value omission consumes no snapshot budget; later values can still be considered.

The snapshot budget is 32 KiB of included payload JSON. Consume it in deterministic section/item/request-then-response order. A value that does not fit is `omitted-budget`; later values receive the same state unless they are otherwise not captured or hidden. Do not exceed the budget to fit a small later value after a larger one fails; deterministic first-fit behavior keeps frames reproducible.

The fixed page, string, cursor, and payload limits bound every emitted frame. They do not retroactively bound SQLite storage or make payload capture free. Operators should leave capture disabled unless inspecting a specific issue.

## Error normalization

Validation failures use `DiagnosticsError` with a fixed message table. No message interpolates a limit, supplied string, cursor, configuration path, SQL error, or upstream exception. There is deliberately no public `cause`; callers cannot accidentally serialize one.

Debug section failures are values, not exceptions. The section mapper catches expected repository/queue read and projection failures at the section boundary, records only `read-failed`, and continues. Validation still happens before this boundary, so an invalid caller query never becomes a partial snapshot.

Secret-provider failures occur at the whole-snapshot boundary, outside section fault isolation. They use the fixed `redaction-provider-failed` mapping and cannot become `read-failed`, a partial snapshot, or a stream frame. The original provider exception is never exposed as a public cause.

Implementation defects that violate pure internal invariants should fail tests rather than be converted into plausible health. Any catch at the section boundary must be narrow enough not to hide diagnostics programming errors; upstream `DatabaseError`, store errors, and documented decode failures are operational inputs, while an undefined internal mapper is not.

Cancellation remains separate from operational failure. The service must not turn an abort reason into a debug error DTO.

## Concurrency and ownership

- Construction copies options, static secret arrays, and query-facing policy. Do not retain caller-owned mutable static arrays. Provider arrays are copied once per snapshot/frame and released when that unit settles; old dynamic inventories are not retained.
- Each call allocates its DTOs, page objects, cursors, and payload budget. No mutable record is shared with a repository result or another caller.
- Each stream owns sequence and cancellation state. There is no global timer, async-local context, replay cache, or snapshot singleton.
- Store and queue calls are synchronous. Fixed section order and bounded row counts make event-loop cost predictable, although large stored payload parsing remains an upstream cost before output sanitization.
- Runtime secret issuance and removal can flow through a provider without changing diagnostics configuration. Other configuration reload, if added by the service, constructs a replacement diagnostics instance. The service closes old streams, stops using the old instance, and explicitly retires any provider it references; the library does not mutate live policy.
- Shutdown belongs to the service. It closes client connections, calls iterator `return()`, stops workers, and then closes SQLite in that order.

## Dependency use

- `Clock.now()` supplies all snapshot timestamps. Format it using the system ISO-8601 UTC convention.
- `Sleep` supplies stream waiting and exact-reason cancellation. Tests inject a scripted implementation.
- `domain` supplies persisted record and enum types. DTOs live in diagnostics because their safety and display bounds are not persistence concerns.
- `reader-store` supplies all reader-side reads and aggregates. It remains the only owner of reader SQL.
- `job-queue` supplies job reads. Diagnostics never renews, completes, fails, or enqueues a job.

No import from `logging` or `llm-interface` is needed. No Fastify, SSE, Pino, OpenAI SDK, Zod, database driver, or metrics dependency belongs in this package.

## Trade-offs

- **Safe DTOs versus raw records:** explicit mappers require updates when operational evidence changes, but prevent new persisted fields from leaking automatically.
- **Keyset pages versus one large dump:** callers need several requests for history, while every read and frame stays bounded and stable under newer inserts.
- **Independent sections versus one transaction:** snapshots can be slightly mixed in time, but diagnostics does not hold back active reader work.
- **Full stream snapshots versus deltas:** frames use more repeated metadata, but reconnects and client replacement are simple and no replay state is needed.
- **Local redaction versus a new shared package:** some policy vocabulary is duplicated with logging, but the dependency tiers remain intact and each output gets an allowlist designed for its risks.
- **Suppressed error responses versus maximum detail:** failed provider payloads are unavailable for inspection, but arbitrary provider error text cannot bypass the no-message rule. Stable codes, request hashes, and successful captured payloads remain available.
- **Whole-value size omission versus string slicing:** large payloads are less inspectable, but output remains valid JSON and explicit about omission.
- **Immutable configuration versus live secret inventories:** static mode retains construction-time behavior, while provider mode deliberately refreshes only the secret inventory at unit boundaries. Other policy changes still require replacement composition and closed streams, and one snapshot/frame never observes a partially changed inventory.

## Testing seams

Use the public API for behavior tests and pure private units for exhaustive edge tables.

- Health needs no database: scripted inputs cover every readiness/capability combination.
- Mapper and sanitizer tests use secret sentinels, hostile keys, URL tokens, malformed JSON values, deep/nested structures, and oversized strings. Assert serialized output, not only object inspection. Add provider cases for later-issued secrets, removed-secret non-retention, one call and one consistent snapshot per snapshot/frame, unchanged static behavior, and fixed fail-closed errors with no partial output. Use internal inventory-lifecycle assertions for non-retention because output alone cannot prove it.
- Cursor tests use golden version-1 envelopes, malformed/trailing data, wrong sections/filters, overlong keys, and records around equal timestamps.
- Repository integration tests use real SQLite and real `reader-store`/`job-queue` reads once their required page APIs exist. Mocks are sufficient for section-failure isolation, not for ordering proof.
- Stream tests combine `createFixedClock` with a scripted `Sleep`; they do not use real waits. Hold consumer pulls and sleep promises to observe late-pull timing, concurrent `next()` serialization, backpressure, abort, return, and cleanup.
- A service-level test owns SSE framing/auth/reconnect assertions. The diagnostics package tests only async frames and must not import Fastify.

## Derived recent-error integration

Recent errors use bounded keyset candidates from reader-store's ingestion/LLM/HN union and job-queue's dedicated failed-job diagnostic query. Job-queue requires persisted `lastErrorCode`, creates the stable synthetic ID `job:<jobId>`, orders by `(updatedAt,"job:"+id)`, and drops the safe-but-unstructured message. Source prefixes keep merged IDs unique. Both sources apply the identical cursor position before a deterministic merge/truncate, so no diagnostic-error table, cursor translation, offset scan, unbounded version query, or in-memory error history is needed.
