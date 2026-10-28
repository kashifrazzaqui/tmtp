# Domain Library Spec

## Purpose and responsibility

Define the transport- and infrastructure-independent language of the reader. The package owns identifiers, state unions, persisted record shapes, boundary schemas, and cross-record invariants. It does not fetch, rank, reduce activity, construct prompts, open a database, or assign policy-specific version strings.

All persisted timestamps are ISO-8601 UTC strings with a `Z` suffix and millisecond precision. HN item IDs remain safe positive integers. Application IDs are opaque strings; generation belongs to the producing library. Optional fields below mean `undefined` in TypeScript and `NULL` in SQLite unless a field is explicitly nullable.

## Public interface / API surface

### Shared primitives

```ts
export type StoryId = number;
export type ActivityId = string;
export type ProfileId = string;
export type RecommendationId = string;
export type JobId = string;
export type IsoDateTime = string;
export type SchemaVersion = number; // integer >= 1

export type ObservationQuality = "full" | "partial";
export type ActivitySource =
  | "embedded-reader"
  | "original-page"
  | "hn-reconciliation"
  | "app-action";
export type ActivityKind =
  | "impression"
  | "open"
  | "dwell"
  | "scroll"
  | "complete"
  | "skip"
  | "dismiss"
  | "upvote"
  | "flag"
  | "favorite";
export type QueueState = "unread" | "reading" | "read" | "dismissed" | "archived";
export type EvaluationState = "pending" | "scored" | "failed";
export type VisibilityState = "visible" | "blacklisted";
export type RecommendationKind = "match" | "exploration";
export type HnFeed = "top" | "new" | "best" | "ask" | "show";
export type HnActionKind = "upvote" | "flag" | "favorite";
export type HnActionStatus = "pending" | "verified" | "indeterminate" | "failed";
export type JobStatus = "queued" | "leased" | "done" | "failed";

export interface VersionedJson<T> {
  schemaVersion: SchemaVersion;
  value: T;
}
```

### Hacker News items and stories

```ts
export type HnItemType = "story" | "comment" | "job" | "poll" | "pollopt";

export interface HnItem {
  id: StoryId;
  type: HnItemType;
  author?: string;
  time?: number; // official API Unix seconds
  title?: string;
  url?: string;
  textHtml?: string;
  score?: number;
  descendants?: number;
  deleted: boolean;
  dead: boolean;
  raw: Record<string, unknown>;
  rawSchemaVersion: 1;
}

export interface Story {
  id: StoryId;
  itemType: "story";
  url?: string;
  canonicalUrl?: string;
  title: string;
  author?: string;
  textHtml?: string;
  score?: number;
  descendants?: number;
  publishedAt: IsoDateTime;
  firstSeenAt: IsoDateTime;
  lastSeenAt: IsoDateTime;
  contentVersion: string;
  raw: HnItem;
  rawSchemaVersion: 1;
  deleted: boolean;
  dead: boolean;
}
```

`raw` preserves the validated official API envelope. `contentVersion` is an opaque producer version over the story fields used for reading and recommendation; score and descendants may change without forcing article re-extraction. A deleted/dead story remains in history and is not silently removed.

### Articles and reading observations

```ts
export type ArticleStatus = "pending" | "ready" | "failed";

export interface Article {
  storyId: StoryId;
  status: ArticleStatus;
  sourceUrl?: string;
  finalUrl?: string;
  title?: string;
  byline?: string;
  excerpt?: string;
  textContent?: string;
  sanitizedHtml?: string;
  contentHash?: string;
  extractorVersion?: string;
  fetchedAt?: IsoDateTime;
  updatedAt: IsoDateTime;
  errorCode?: string;
  errorMessage?: string;
}

export interface ActivityEvent {
  id: ActivityId;
  clientEventId: string;
  storyId: StoryId;
  kind: ActivityKind;
  value?: Record<string, unknown>;
  valueSchemaVersion: 1;
  source: ActivitySource;
  observationQuality: ObservationQuality;
  occurredAt: IsoDateTime;
  receivedAt: IsoDateTime;
}

export type ReadingSessionState = "active" | "complete" | "abandoned";

export interface ReadingSession {
  id: string;
  storyId: StoryId;
  startedAt: IsoDateTime;
  endedAt?: IsoDateTime;
  updatedAt: IsoDateTime;
  activeDwellMs: number; // integer >= 0
  maxScrollRatio: number; // finite, 0..1
  state: ReadingSessionState;
  observationQuality: ObservationQuality;
  lastClientEventId: string;
}
```

Activity is immutable after insertion. `clientEventId` is globally unique for idempotency. A session is a mutable projection and may be rebuilt from events. `original-page` and `hn-reconciliation` observations are always `partial`.

### Preferences and interest profiles

```ts
export type PreferenceKind = "topic" | "keyword" | "author" | "domain";
export type PreferenceEffect = "include" | "exclude";

export interface PreferenceRule {
  id: string;
  kind: PreferenceKind;
  effect: PreferenceEffect;
  value: string;
  normalizedValue: string;
  enabled: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface InterestEvidence {
  kind: ActivityKind | "explicit-rule";
  count: number;
  weight: number;
}

export interface WeightedInterest {
  topic: string;
  weight: number; // finite, >= 0
  evidence: InterestEvidence[];
}

export interface InterestProfile {
  id: ProfileId;
  rulesVersion: string;
  activityVersion: string;
  sourceRules: PreferenceRule[];
  sourceRulesSchemaVersion: 1;
  policy: Record<string, unknown>;
  policySchemaVersion: 1;
  policyVersion: string;
  builderVersion: string;
  interests: WeightedInterest[];
  reason: string;
  createdAt: IsoDateTime;
}
```

The profile is immutable and reproducible from its source-rule snapshot, activity version, policy snapshot/version, and builder version. `policy` and `interests` are parsed by `interests`; the domain schema validates their envelope and primitive shapes without importing that library.

### Recommendations and queue entries

```ts
export interface RecommendationEvidence {
  kind: "explicit-rule" | "activity" | "story" | "exploration";
  label: string;
  value?: string | number;
  sourceId?: string;
}

export interface Recommendation {
  id: RecommendationId;
  storyId: StoryId;
  profileId: ProfileId;
  storyContentVersion: string;
  promptVersion: string;
  model: string;
  score: number; // finite, 0..1
  rationale: string;
  evidence: RecommendationEvidence[];
  evidenceSchemaVersion: 1;
  llmCallId?: string;
  createdAt: IsoDateTime;
}

export interface QueueEntry {
  storyId: StoryId;
  state: QueueState;
  evaluationState: EvaluationState;
  visibilityState: VisibilityState;
  kind: RecommendationKind;
  recommendationId?: RecommendationId;
  rankScore?: number;
  rankPosition?: number; // integer >= 1 within rankVersion
  rankVersion: string;
  lastError?: string;
  queuedAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
```

Recommendations are immutable. Queue entries are projections: ranking updates preserve reading state and timestamps that belong to reading history. `scored` requires a recommendation and finite rank score; `pending` and `failed` may not have a recommendation for the current rank version. Blacklisting changes visibility only.

### HN action intent and current state

```ts
export interface HnActionIntent {
  id: string;
  storyId: StoryId;
  action: HnActionKind;
  idempotencyKey: string;
  status: HnActionStatus;
  result?: Record<string, unknown>;
  resultSchemaVersion?: 1;
  errorCode?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface HnAccountState {
  username: string;
  storyId: StoryId;
  kind: HnActionKind;
  present: boolean;
  firstObservedAt: IsoDateTime;
  lastObservedAt: IsoDateTime;
  sourceCursor?: string;
}
```

An intent is durable before an external mutation. `verified` requires result evidence and no error code. `indeterminate` is terminal for that attempt but never means success. Reconciliation updates current state and does not create historical activity timestamps.

### Jobs, ingestion, LLM audits, access, and diagnostics

```ts
export interface Job {
  id: JobId;
  kind: string;
  payload: unknown;
  payloadSchemaVersion: SchemaVersion;
  dedupeKey?: string;
  status: JobStatus;
  runAfter: IsoDateTime;
  leaseToken?: string;
  leaseExpiresAt?: IsoDateTime;
  attempts: number; // integer >= 0
  maxAttempts: number; // integer >= 1
  lastError?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  completedAt?: IsoDateTime;
}

export type IngestionRunStatus = "running" | "complete" | "failed";

export interface IngestionRun {
  id: string;
  kind: string;
  status: IngestionRunStatus;
  cursorStart?: string;
  cursorEnd?: string;
  storiesUpserted: number;
  nonStoriesSkipped: number;
  errorCode?: string;
  errorMessage?: string;
  startedAt: IsoDateTime;
  completedAt?: IsoDateTime;
}

export type LlmCallStatus =
  | "success"
  | "invalid-output"
  | "provider-error"
  | "timeout"
  | "cancelled";

export interface LlmCallRecord {
  id: string;
  purpose: string;
  model: string;
  status: LlmCallStatus;
  requestHash: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number; // integer >= 0
  providerRequestId?: string;
  errorCode?: string;
  requestPayload?: unknown;
  requestPayloadSchemaVersion?: SchemaVersion;
  responsePayload?: unknown;
  responsePayloadSchemaVersion?: SchemaVersion;
  createdAt: IsoDateTime;
}

export interface AccessSessionRecord {
  sessionHash: string;
  csrfSecretHash: string;
  createdAt: IsoDateTime;
  expiresAt: IsoDateTime;
  lastUsedAt: IsoDateTime;
  revokedAt?: IsoDateTime;
}

export interface DiagnosticError {
  code: string;
  message: string;
  component: string;
  occurredAt: IsoDateTime;
  runId?: string;
  jobId?: string;
  storyId?: StoryId;
  profileId?: ProfileId;
  requestId?: string;
}

export interface RecommendationVersionCount {
  profileId: ProfileId;
  promptVersion: string;
  model: string;
  rankVersion: string;
  queueEntryCount: number; // integer >= 0
}
```

Leased jobs require a lease token and expiry; queued/done/failed jobs do not. Payload capture fields and their schema versions appear in pairs. `AccessSessionRecord` is structurally compatible with the access-control session port; neither package imports the other.

## Boundary schemas

Every record above has a same-named Zod companion with `Schema` appended, except primitives, which use the names shown below. Schemas infer the exported TypeScript types and reject unknown object keys at external/persisted boundaries.

```ts
export const IsoDateTimeSchema: import("zod").ZodType<IsoDateTime>;
export const StoryIdSchema: import("zod").ZodType<StoryId>;
export const HnItemSchema: import("zod").ZodType<HnItem>;
export const StorySchema: import("zod").ZodType<Story>;
export const ArticleSchema: import("zod").ZodType<Article>;
export const ActivityEventSchema: import("zod").ZodType<ActivityEvent>;
export const ReadingSessionSchema: import("zod").ZodType<ReadingSession>;
export const PreferenceRuleSchema: import("zod").ZodType<PreferenceRule>;
export const InterestProfileSchema: import("zod").ZodType<InterestProfile>;
export const RecommendationSchema: import("zod").ZodType<Recommendation>;
export const QueueEntrySchema: import("zod").ZodType<QueueEntry>;
export const HnActionIntentSchema: import("zod").ZodType<HnActionIntent>;
export const HnAccountStateSchema: import("zod").ZodType<HnAccountState>;
export const JobSchema: import("zod").ZodType<Job>;
export const IngestionRunSchema: import("zod").ZodType<IngestionRun>;
export const LlmCallRecordSchema: import("zod").ZodType<LlmCallRecord>;
export const AccessSessionRecordSchema: import("zod").ZodType<AccessSessionRecord>;
export const RecommendationVersionCountSchema: import("zod").ZodType<RecommendationVersionCount>;
```

All unions and numeric ranges also have exported schemas named after their types. Schema validation checks field shape and cross-field state invariants. Repositories and external adapters must parse persisted or decoded data with these schemas; callers may parse again at a trust boundary.

## Internal subcomponents

- Primitive identifiers, timestamps, state unions, and versioned envelopes.
- Story/article and activity/session records.
- Preference/profile, recommendation, and queue records.
- HN action/current-state, job, sync, audit, access, and diagnostic records.
- Strict Zod schemas and cross-field refinements.

## Dependencies on other libs

None. Zod is the only runtime dependency.

## New build or OSS wrapper

New domain model using Zod `4.6.7` for boundary schemas.

## Hosted by

Shared in process by `services/personal-reader` and its libraries; no standalone runtime.

## Configuration

None.

## Acceptance-focused test expectations

- Parse every valid record and reject invalid timestamps, unsafe IDs, unknown keys, invalid unions, NaN/infinite numbers, and broken state-field invariants.
- Verify optional payload/version pairs and leased-job fields as paired values.
- Verify blacklist/read history and immutable-record types remain distinct.
- Round-trip every persisted record through its schema without changing meaning.
