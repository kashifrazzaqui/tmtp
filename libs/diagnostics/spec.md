# Diagnostics Library Spec

## Purpose and responsibility

Provide transport-free liveness, readiness, capability, and bounded debug snapshots for the personal reader. The library projects durable reader state and job state into safe DTOs. It also provides an async snapshot stream that a service can map to Server-Sent Events (SSE).

The library is read-only. It does not host HTTP or SSE, authenticate callers, render UI, open SQLite, run migrations, probe external services, start or stop workers, capture LLM requests, persist audits, or mutate diagnostics configuration. `services/personal-reader` supplies probe results and resolved configuration, and owns routes, access control, UI visibility, stream shutdown, and startup checks.

Stored reading is the core capability. Configuration, SQLite, migrations, and required workers determine readiness. LLM, HN, and fresh-article failures degrade their own capabilities; they never make stored reading unavailable and are not readiness checks.

## Public interface / API surface

The package root is `@tmtp/diagnostics`. It has no default export or subpath exports.

### Liveness, readiness, and capabilities

```ts
export interface LivenessSnapshot {
  generatedAt: import("@tmtp/domain").IsoDateTime;
  status: "live";
}

export type ReadinessReason =
  | "ok"
  | "configuration-not-loaded"
  | "configuration-invalid"
  | "database-unavailable"
  | "integrity-check-failed"
  | "migrations-pending"
  | "migration-checksum-mismatch"
  | "migration-failed"
  | "workers-starting"
  | "workers-stopped"
  | "worker-failed";

export interface ReadinessCheckInput {
  ready: boolean;
  reason: ReadinessReason;
}

export interface ReadinessInput {
  configuration: ReadinessCheckInput;
  sqlite: ReadinessCheckInput;
  migrations: ReadinessCheckInput;
  workers: ReadinessCheckInput;
}

export type IntegrationAvailability =
  | "available"
  | "degraded"
  | "unavailable"
  | "unknown";

export type CapabilityReason =
  | "ok"
  | "not-configured"
  | "not-checked"
  | "configuration-invalid"
  | "database-unavailable"
  | "integrity-check-failed"
  | "migrations-not-current"
  | "workers-not-ready"
  | "connection-failed"
  | "authentication-failed"
  | "rate-limited"
  | "timeout"
  | "invalid-response"
  | "fetch-failed"
  | "extraction-failed";

export interface IntegrationInput {
  configured: boolean;
  availability: IntegrationAvailability;
  reason: CapabilityReason;
  observedAt?: import("@tmtp/domain").IsoDateTime;
}

export interface HealthInput extends ReadinessInput {
  llm: IntegrationInput;
  hnPublic: IntegrationInput;
  hnAccount?: IntegrationInput;
  article: IntegrationInput;
}

export interface ReadinessCheck {
  name: "configuration" | "sqlite" | "migrations" | "workers";
  status: "pass" | "fail";
  reason: ReadinessReason;
}

export interface ReadinessSnapshot {
  generatedAt: import("@tmtp/domain").IsoDateTime;
  status: "ready" | "not-ready";
  checks: ReadinessCheck[]; // exactly four, in the declared order
}

export type CapabilityState =
  | "available"
  | "degraded"
  | "unavailable"
  | "disabled"
  | "unknown";

export interface CapabilityStatus {
  state: CapabilityState;
  reason: CapabilityReason;
  observedAt?: import("@tmtp/domain").IsoDateTime;
}

export interface CapabilitiesSnapshot {
  generatedAt: import("@tmtp/domain").IsoDateTime;
  storedReading: CapabilityStatus;
  backgroundWork: CapabilityStatus;
  llmPersonalization: CapabilityStatus;
  hnPublicCollection: CapabilityStatus;
  hnAccount: CapabilityStatus;
  freshArticleContent: CapabilityStatus;
}
```

`liveness()` reads only the injected clock. It performs no I/O and makes no claim that storage, workers, or integrations are healthy.

For readiness, a ready input has reason `ok`; a non-ready input has any other reason. `sqlite` covers a working read probe and required integrity checks. `migrations` covers current versions and checksum validation. `workers` is ready only after required startup recovery is complete and every required worker loop is running. Readiness is ready only when all four checks pass, in this order: configuration, SQLite, migrations, workers. Integration inputs are not consulted.

Capabilities have these aggregation rules:

- `storedReading` is available when configuration, SQLite, and migrations are ready. Worker state and every external integration are irrelevant.
- `backgroundWork` is available only when the complete readiness input is ready.
- The four integration capabilities copy their supplied availability and reason. An absent or unconfigured HN account is `disabled`, not degraded.
- LLM failure affects new personalization only. HN public or account failure affects new collection or account actions only. Article failure affects fresh article retrieval or extraction only. Existing stories, cached articles, activity, preferences, and explanations remain readable when local storage is ready.
- An integration not yet probed is `unknown` with reason `not-checked`; it is not reported as available.

The service owns all probes and maps adapter failures to the fixed reason vocabulary. Arbitrary exception messages are not valid reasons.

For an unconfigured integration, `availability` is `unknown` and `reason` is `not-configured`; its output state is `disabled`. For a configured integration, `available` requires reason `ok`, while degraded/unavailable/unknown requires a non-`ok` reason. Any actual probe supplies `observedAt`. Local capabilities omit `observedAt`; their state is computed at the snapshot's `generatedAt`. Invalid combinations are `invalid-input`.

### Safe debug DTOs

```ts
export type SafeCode = string; // lowercase kebab-case, 1..64 chars at runtime

export interface DebugProfile {
  id: string;
  rulesVersion: string;
  activityVersion: string;
  policyVersion: string;
  builderVersion: string;
  createdAt: import("@tmtp/domain").IsoDateTime;
}

export interface DebugRecommendationVersionCount {
  profileId: string;
  promptVersion: string;
  model: string;
  rankVersion: string;
  queueEntryCount: number;
}

export interface DebugSyncRun {
  id: string;
  kind: string;
  status: import("@tmtp/domain").IngestionRunStatus;
  storiesUpserted: number;
  nonStoriesSkipped: number;
  errorCode?: SafeCode;
  startedAt: import("@tmtp/domain").IsoDateTime;
  completedAt?: import("@tmtp/domain").IsoDateTime;
}

export interface DebugJob {
  id: string;
  kind: string;
  status: import("@tmtp/domain").JobStatus;
  runAfter: import("@tmtp/domain").IsoDateTime;
  leaseExpiresAt?: import("@tmtp/domain").IsoDateTime;
  attempts: number;
  maxAttempts: number;
  createdAt: import("@tmtp/domain").IsoDateTime;
  updatedAt: import("@tmtp/domain").IsoDateTime;
  completedAt?: import("@tmtp/domain").IsoDateTime;
}

export interface QueueEvaluationCounts {
  pending: number;
  scored: number;
  failed: number;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type DebugPayloadState =
  | "not-captured"
  | "hidden-by-policy"
  | "suppressed-error-response"
  | "included"
  | "omitted-too-large"
  | "omitted-budget";

export interface DebugPayloadPreview {
  state: DebugPayloadState;
  schemaVersion?: import("@tmtp/domain").SchemaVersion;
  value?: JsonValue;
  truncated: boolean;
}

export interface DebugLlmCall {
  id: string;
  purpose: string;
  model: string;
  status: import("@tmtp/domain").LlmCallStatus;
  requestHash: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  errorCode?: SafeCode;
  createdAt: import("@tmtp/domain").IsoDateTime;
  requestPayload: DebugPayloadPreview;
  responsePayload: DebugPayloadPreview;
}

export interface DebugError {
  id: string;
  code: SafeCode;
  component: SafeCode;
  occurredAt: import("@tmtp/domain").IsoDateTime;
  runId?: string;
  jobId?: string;
  storyId?: number;
  profileId?: string;
  requestId?: string;
}

export interface DebugPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface DebugSection<T> {
  status: "ok" | "unavailable";
  value: T;
  errorCode?: "read-failed";
}
```

These DTOs are deliberately not domain-record aliases. In particular:

- A profile omits source rules, policy JSON, interests, reason text, and other profile payloads.
- A sync run omits cursors and `errorMessage`.
- A job omits its payload, dedupe key, lease token, and `lastError`. Lease expiry, attempts, and state remain visible.
- An LLM audit omits provider response headers and raw provider errors. `providerRequestId` is not exposed. Payloads use the explicit preview policy below.
- A diagnostic error omits `message`, stack, cause, and arbitrary fields. Only a stable code, component, timestamp, and allowlisted correlation IDs remain.
- Recent errors are derived from stable-code ingestion/LLM/HN-action records and failed jobs with `lastErrorCode`; there is no separate diagnostic-error table. Source-prefixed durable IDs make the merged ordering stable. Diagnostics never parses `lastError` text to invent a code.
- No DTO contains article markup/content, raw story envelopes, access sessions, HN cookies, request headers, or URLs.

On a section read failure, its status is `unavailable`, its value is the empty page, zero counts, or `undefined` as applicable, and `errorCode` is `read-failed`. Other sections still return. No upstream error text escapes.

### Debug pages and snapshots

```ts
export interface DebugPageQuery {
  limit?: number; // default 20, integer 1..50
  after?: string; // opaque cursor returned by this same section, at most 16 KiB
}

export interface DebugJobPageQuery extends DebugPageQuery {
  status?: import("@tmtp/domain").JobStatus;
  kind?: string; // non-empty, at most 64 chars
}

export interface DebugWindowQuery {
  syncRuns?: DebugPageQuery;
  jobs?: DebugJobPageQuery;
  llmCalls?: DebugPageQuery;
  recentErrors?: DebugPageQuery;
  recommendationVersions?: DebugPageQuery;
}

export interface DebugStreamQuery {
  syncRuns?: Omit<DebugPageQuery, "after">;
  jobs?: Omit<DebugJobPageQuery, "after">;
  llmCalls?: Omit<DebugPageQuery, "after">;
  recentErrors?: Omit<DebugPageQuery, "after">;
  recommendationVersions?: Omit<DebugPageQuery, "after">;
}

export interface DebugSnapshot {
  schemaVersion: 1;
  generatedAt: import("@tmtp/domain").IsoDateTime;
  payloadPolicy: {
    llmPayloads: boolean;
  };
  partial: boolean;
  activeProfile: DebugSection<DebugProfile | undefined>;
  recommendationVersions: DebugSection<DebugPage<DebugRecommendationVersionCount>>;
  syncRuns: DebugSection<DebugPage<DebugSyncRun>>;
  jobs: DebugSection<DebugPage<DebugJob>>;
  queueCounts: DebugSection<QueueEvaluationCounts>;
  llmCalls: DebugSection<DebugPage<DebugLlmCall>>;
  recentErrors: DebugSection<DebugPage<DebugError>>;
}

export interface DebugStreamFrame {
  sequence: number; // starts at 1 for each independent stream
  snapshot: DebugSnapshot;
}
```

The default window reads the first page of every section with limit 20. A caller can request an older page with `after`, or lower a limit. Fifty is the hard maximum for each section; there is no unbounded debug export. Queue counts always contain all three evaluation states, using zero for absent rows.

Page orders and cursor keys are:

| Section | Order | Cursor key |
|---|---|---|
| Sync runs | Descending `(startedAt,id)` | Last returned pair |
| Jobs | Descending `(createdAt,id)` | Last returned pair plus status/kind filter fingerprint |
| LLM calls | Descending `(createdAt,id)` | Last returned pair |
| Recent errors | Descending `(occurredAt,id)` | Last returned pair |
| Recommendation versions | Ascending `(profileId,promptVersion,model,rankVersion)` | Last returned tuple |

Cursors are versioned, opaque to callers, and contain no record payload, URL, secret, or arbitrary message. A cursor is valid only for its original section, schema version, and filters. Invalid or malformed cursors fail before any repository read. Changing a job filter requires a new first page.

The encoded cursor limit is 16 KiB. Persisted ordering strings must fit the DTO bounds above so the complete key remains unambiguous. A record whose ordering key cannot fit a bounded cursor makes that section unavailable with `read-failed`; diagnostics never truncates a cursor key or falls back to offset pagination.

Keyset pagination prevents newer inserts from shifting an older page. It guarantees no duplicates or omissions only while the matching records and their order keys are unchanged. Job status filters can change as work runs, and records can be updated between reads. A snapshot is a bounded operational view, not a point-in-time database backup: sections are read independently, no cross-section transaction or global high-watermark is claimed, and separate pages need not represent one database instant.

For recent errors, diagnostics fetches bounded candidate pages from `reader-store.diagnostics.recentErrors` and `job-queue.listDiagnosticErrors` using the same `(occurredAt,source-prefixed ID)` position, then merges and truncates to the requested bound. Job-queue owns its failed-job projection and exact ordering; diagnostics does not translate its ordinary `(createdAt,id)` page cursor. Each source query remains bounded; no unbounded in-memory history or additional persistence exists.

`partial` is true when at least one section is unavailable. Normal pagination, disabled payloads, and budget-based payload omission do not by themselves make the snapshot partial; their states are visible in the relevant page or payload preview.

### Debug stream and SSE handoff

```ts
export interface DebugStreamOptions {
  query?: DebugStreamQuery;
  signal?: AbortSignal;
}

export interface DiagnosticsOptions {
  store: import("@tmtp/reader-store").ReaderStore;
  jobs: import("@tmtp/job-queue").JobQueue;
  clock: import("@tmtp/clock").Clock;
  sleep: import("@tmtp/clock").Sleep;
  secretValues: readonly string[];
  debug: {
    enabled: boolean;
    streamIntervalMs: number;
    includeLlmPayloads: boolean;
  };
}

export interface Diagnostics {
  liveness(): LivenessSnapshot;
  readiness(input: ReadinessInput): ReadinessSnapshot;
  capabilities(input: HealthInput): CapabilitiesSnapshot;
  debugSnapshot(query?: DebugWindowQuery): DebugSnapshot;
  debugStream(options?: DebugStreamOptions): AsyncIterable<DebugStreamFrame>;
}

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics;
```

`debugStream` is an async iterable of complete snapshots, not an SSE server and not a delta feed. Its contract is:

1. The first pull emits an immediate first-page snapshot with sequence 1.
2. Each later pull waits only the remaining part of `debug.stream_interval_ms` after the preceding snapshot was produced, using monotonic time. If the interval already elapsed, it reads immediately. It then emits a fresh first-page snapshot and increases sequence by one. There is no catch-up burst.
3. There is at most one snapshot read in flight per stream. Slow consumers create no queued frames, overlapping reads, or catch-up burst. Dropped consumer time is not replayed.
4. Every frame is self-contained and replaces the consumer's previous debug state. `generatedAt` comes from one clock read for that snapshot; `sequence` is local to that iterator.
5. An already-aborted signal takes no snapshot. An abort stops waiting and future reads. During sleep, rejection uses the exact `signal.reason`. Iterator `return()` cancels pending sleep and removes listeners. No timer or listener survives stream settlement.
6. Configuration is immutable for the instance. The service closes active streams before discarding an instance during shutdown or configuration replacement.
7. Concurrent `next()` calls on one iterator are serialized in call order and receive distinct sequence numbers. They never overlap snapshot reads.

The service may map each frame to an SSE event named `debug-snapshot`, use the decimal sequence as the per-connection event ID, and serialize the frame as JSON. It owns HTTP headers, authentication, heartbeats, connection cleanup, and any SSE `retry` hint. There is no replay buffer or resume contract: a reconnect starts a new sequence and a complete fresh snapshot. `Last-Event-ID` has no meaning to this library.

## Debug authorization and configuration boundary

The library cannot authenticate a caller. The service must apply the same access control to debug snapshots and streams as to mutations, hide debug UI when disabled, and reject disabled debug routes. Health and capability transport authentication is also a service decision; this library exposes no network surface.

Calling `debugSnapshot` or `debugStream` while `debug.enabled=false` throws `DiagnosticsError` with code `debug-disabled`. This library check is required even when the service also gates routes.

## Redaction and explicit payload policy

### Allowlist first

Debug construction copies only the DTO fields listed above. Redaction is not a substitute for that allowlist. The following never appear in any health DTO, debug DTO, cursor, stream frame, or `DiagnosticsError` message:

- Raw request/response headers, authorization values, cookies, access tokens, session tokens, CSRF tokens/secrets, API keys, passwords, and secret-file contents.
- URLs with query strings or credentials. Fixed DTOs contain no URLs; the payload sanitizer redacts every absolute URL token, including safe-looking ones, rather than attempting to preserve part of it.
- Arbitrary error messages, error stacks, raw error causes, provider error bodies, job `lastError`, queue `lastError`, sync/article `errorMessage`, and `DiagnosticError.message`.
- Job payloads and lease tokens, raw profile payloads, access-session records, and uncaptured article or story content.

Stable codes and correlation identifiers are data fields, not messages. A code must match `[a-z0-9]+(?:-[a-z0-9]+)*` and be at most 64 characters. An invalid stored error code becomes `unknown-error`, and an invalid component becomes `unknown-component`; neither is copied as free-form text.

All returned strings are bounded and copied. Codes and kind/component names are capped at 64 characters, opaque IDs at 128, and model/version/display values at 256. Longer display values end in `[Truncated]` within the cap. Secret replacement happens before bounding so a truncated secret cannot survive.

### Secret and key redaction

`secretValues` is required. The service supplies every loaded access token, HN session cookie, LLM API key, CSRF secret, and comparable raw secret, using the same complete set given to logging. The factory copies the array and ignores empty strings. Later caller mutation does not change policy.

For captured payload values and all copied strings, diagnostics performs literal, case-sensitive, global replacement with `[Redacted]`, longest match first at a given position. Replacement output is not scanned again. This is the same value-redaction policy as logging, implemented locally because logging exports no redactor and diagnostics has no logging dependency.

Payload object keys are compared case-insensitively after removing `_` and `-`. The sensitive-key set is the complete set in `libs/logging/spec.md`, plus `headers`, `requestHeaders`, `responseHeaders`, `rawHeaders`, `url`, `uri`, `error`, `errors`, `err`, `exception`, and `stack`. A matching value is replaced wholesale with `[Redacted]` without traversal. This blocks nested credentials, raw header maps, URL fields, and embedded error objects. URL tokens inside longer strings are also replaced with `[RedactedUrl]`.

Redaction handles only registered raw secret values and recognized structures. Producers must still honor the LLM interface's no-secret projection contract; encoded, transformed, or unregistered secrets cannot be detected reliably. Payload capture is never permission to place credentials in prompts, story/profile projections, or provider calls.

### LLM payload visibility

`debug.include_llm_payloads` controls both the service's capture choice for new LLM requests and diagnostics visibility for stored captures. Diagnostics itself never calls an LLM and never persists an audit. Upper layers map every `LlmResult` and `LlmError` attempt to `LlmCallRecord` and persist it through `reader-store`; diagnostics only reads and projects those records.

The service records an auditable, secret-free configuration event when payload capture is enabled or disabled. Diagnostics owns neither that audit nor configuration reload.

For each request/response payload independently:

- No stored payload produces `not-captured`, regardless of current policy.
- Stored payload while `includeLlmPayloads=false` produces `hidden-by-policy`; no value or schema version is returned.
- Stored payload while enabled produces `included` only after sanitization and within the size budget. Its original positive schema version is returned with the sanitized value.
- A response payload on any non-success LLM audit produces `suppressed-error-response`, even when capture and visibility are enabled. This prevents decoded provider error bodies from becoming an error-message side channel.
- Enabling visibility is not retroactive capture. Previously uncaptured audits remain `not-captured`. Disabling visibility hides but does not delete stored captures.

Sanitization permits JSON values only. It uses maximum depth 8, at most 200 nodes and 50 entries per array/object, and at most 2,000 characters per string. Pruned content sets `truncated=true`. A sanitized payload whose encoded JSON exceeds 8 KiB produces `omitted-too-large` with no value. Included payload JSON across one snapshot is capped at 32 KiB; later payloads produce `omitted-budget`. Payload/version pairs appear only for `included` values. These bounds are fixed safety limits, not additional configuration keys.

Only `included` has `value` and `schemaVersion`. `truncated` reports whether sanitization pruned content; it is false for `not-captured`, `hidden-by-policy`, `suppressed-error-response`, and `omitted-budget`. A per-value size omission consumes no snapshot budget. Once a value cannot fit the remaining snapshot budget, that budget is exhausted and all later otherwise-includable payloads are `omitted-budget` without sanitization work.

## Stable errors and validation

```ts
export type DiagnosticsErrorCode =
  | "invalid-configuration"
  | "invalid-input"
  | "debug-disabled"
  | "invalid-query"
  | "invalid-cursor"
  | "cursor-query-mismatch";

export class DiagnosticsError extends Error {
  readonly name: "DiagnosticsError";
  readonly code: DiagnosticsErrorCode;
}
```

Each code has one fixed, short message that contains no supplied value, upstream message, payload, path, or URL. Consumers branch on `code`, never message text. The error has no public `cause` or arbitrary details field.

- Construction rejects invalid options, copied-secret input, interval policy, and the payload-policy combination as `invalid-configuration`.
- Malformed health input is `invalid-input`.
- Debug queries are validated completely before any read. Bad limits/filters are `invalid-query`; malformed/unknown cursors are `invalid-cursor`; a cursor used with another section/filter is `cursor-query-mismatch`.
- Expected store/queue read failures become unavailable sections, not thrown raw errors. Health and capability methods do not perform storage reads and do not convert failed capabilities into exceptions.

Cancellation is not a `DiagnosticsError`; stream abort uses the original abort reason. The service must close the transport without serializing that reason.

## Concurrency, consistency, and lifecycle

- All repository and queue access is synchronous and read-only. A single snapshot performs bounded reads in a fixed section order and never calls external services.
- Calls and streams on one instance are independent. Options and secret values are copied at construction; returned DTOs and pages are fresh values, so caller mutation cannot alter later snapshots or cursors.
- Cursors are self-contained. The library keeps no server-side cursor table, replay cache, snapshot cache, mutable correlation context, or global stream registry.
- Independent streams have independent sequence numbers, cancellation, and payload budgets. One stream's slow consumer or abort does not block another.
- There is no cross-section SQLite snapshot guarantee. This avoids holding a long read transaction while jobs and ingestion continue. Consumers use timestamps and correlation IDs, not arrival order alone, to follow an operation.
- The library owns no worker or shutdown method. The service owns active iterator references, transport closure, and replacement of the composed instance.

## Internal subcomponents

- Required readiness and local/external capability aggregation.
- Safe DTO mappers and fixed-vocabulary error normalization.
- Bounded keyset-page and opaque-cursor projection.
- Secret/string/JSON sanitization and payload-budget enforcement.
- Snapshot-section fault isolation and async snapshot streaming.

## Dependencies on other libs

- `clock` — timestamps and cancellation-aware waiting.
- `domain` — persisted enums, records, and timestamp/schema primitives; raw records never escape.
- `job-queue` — bounded job read model.
- `reader-store` — reader, queue-count, sync, LLM-audit, version-count, and diagnostic-error read models.

There is no runtime dependency on `logging` or `llm-interface`. Logging policy is mirrored at this output boundary, while LLM audits arrive only as persisted domain records. No new third-party dependency is needed.

## New build or OSS wrapper

New composition over existing in-process read models; no transport, metrics backend, or observability service.

## Hosted by

`services/personal-reader` health/readiness/capability routes, authenticated debug API and SSE adapter, worker/startup composition, and UI debug drawer.

## Configuration

The service's validated configuration object supplies resolved values; the factory does not hide a second set of defaults.

- `debug.enabled` — **optional**, default `false`; gates debug snapshot/stream methods and the service's debug routes/UI. It does not gate liveness, readiness, or capabilities.
- `debug.stream_interval_ms` — **optional**, default `2000`; integer from `250` through `60000`. It is the delay between snapshots, not a promise of exact wall-clock cadence.
- `debug.include_llm_payloads` — **optional**, default `false`; requires `debug.enabled=true`. It enables non-secret stored payload previews subject to all redaction and size rules. `true` with debug disabled is invalid configuration rather than silently ignored.

Page sizes, string/depth/node limits, and payload budgets are fixed public contract bounds, not operator-tunable configuration. Secret values come from loaded secrets, never from debug query input.

## Acceptance-focused test expectations

### Health and capability behavior

- `should return live without touching storage or integrations when liveness is called`.
- `should fail readiness for each configuration SQLite migration and worker check independently`, assert exact check order/reasons, and prove all LLM/HN/article states are ignored.
- `should keep stored reading available when workers or external integrations fail` while marking background work or only the corresponding integration unavailable/degraded.
- `should keep fresh article failure separate from cached stored reading` and `should report an unconfigured HN account as disabled rather than degraded`.
- `should report unprobed integrations as unknown` and reject malformed ready/reason combinations with fixed safe errors.

### DTO safety and payload policy

- Assert exact DTO keys for every record family. Fixtures include payloads, dedupe keys, lease tokens, raw profile fields, provider IDs, URLs, and arbitrary error messages; none may leak into JSON output.
- Use unique secret sentinels for access, session, CSRF, HN, and LLM credentials in nested objects, arrays, keys, strings, and URL user-info/query positions. Assert none occurs in snapshots, cursors, stream frames, or thrown diagnostics errors.
- Cover the logging sensitive-key spelling families plus raw headers, URL fields, and embedded error objects at arbitrary supported depths. Assert URL tokens inside prompt text are redacted.
- With capture disabled, prove stored payload/version values never escape and state is `not-captured` or `hidden-by-policy` as appropriate. With capture enabled, prove only sanitized versioned JSON is returned and old uncaptured records remain uncaptured.
- For failed, timed-out, cancelled, and invalid-output LLM audits, assert stored response payloads are `suppressed-error-response`. Persist audits from both result and error fixtures in upstream composition tests, then verify diagnostics adds no audit and performs no write.
- Exercise depth/node/entry/string limits, oversized sanitized payloads, and the 32 KiB snapshot payload budget. Assert explicit states/truncation flags and deterministic bounds across repeated calls.

### Pages, snapshots, and streams

- For every section, test empty/exact/over-limit windows, stable tie-breakers, first/older pages, and no duplicates or omissions while matching data is unchanged. Test newer inserts during keyset traversal and changing job filter membership without claiming a global snapshot.
- Assert default limit 20, maximum 50, all-zero queue-count keys, complete filter/cursor matching, and validation before any repository call for bad input.
- Inject a failure into each section in turn. Assert other sections remain available, `partial=true`, and only `read-failed` appears; no upstream message or stack escapes.
- Use a fixed clock and scripted sleep to prove immediate first emission, only the remaining delay after a late pull, increasing per-stream sequences, fresh full snapshots, serialized concurrent `next()` calls, no overlap, no catch-up burst, and no queued frames for a slow consumer.
- Abort before and during sleep and call iterator `return()`; assert the identical abort reason, no later frame/read, and complete timer/listener cleanup. Prove independent streams maintain independent sequences and cancellation.
- Assert `debug.enabled=false` rejects both snapshot and stream calls with `debug-disabled`. Service tests separately verify authentication, route/UI removal, SSE framing, reconnect-with-full-snapshot behavior, and shutdown closure.

### Concurrency and workflow acceptance

- Mutate constructor arrays and returned DTOs after calls; later snapshots must remain unchanged. Run interleaved snapshots/streams while jobs update and verify independent cursors, fresh outputs, bounded reads, and no shared payload budget.
- WF-01/WF-07: local readiness succeeds independently of external probe failure, while missing local requirements remain not ready.
- WF-08: an operator can inspect sync runs, lease/attempt metadata, queue evaluation counts, safe recent errors, and LLM usage without reading the database or exposing secrets/messages.
