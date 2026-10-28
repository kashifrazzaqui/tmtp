# Domain Library Spec

## Purpose and responsibility
Define the transport- and infrastructure-independent language of the reader: stories, articles, activity, preferences, profiles, recommendations, queue entries, actions, jobs, sync runs, and diagnostics records.

## Public interface / API surface
```ts
export type StoryId = number;
export type ActivityId = string;
export type ProfileId = string;
export type RecommendationId = string;
export type JobId = string;

export type ActivityKind =
  | "impression" | "open" | "dwell" | "scroll" | "complete"
  | "skip" | "dismiss" | "upvote" | "flag" | "favorite";

export type QueueState = "unread" | "reading" | "read" | "dismissed" | "archived";
export type EvaluationState = "pending" | "scored" | "failed";
export type RecommendationKind = "match" | "exploration";

export interface Story { /* id, HN metadata, URL/text, timestamps, content version */ }
export interface HnItem { /* official API item fields and type */ }
export interface Article { /* story ID, sanitized content, extraction status, versions */ }
export interface ActivityEvent { /* immutable kind, story, value, provenance, occurredAt */ }
export interface ReadingSession { /* story, start/end, active dwell, scroll, observation quality */ }
export interface PreferenceRule { /* include/exclude topic, keyword, author, or domain */ }
export interface InterestProfile { /* source-rule snapshot, policy/builder/activity versions, weighted interests */ }
export interface Recommendation { /* score, evidence, rationale, versions, LLM call ID */ }
export interface QueueEntry { /* story, reading/evaluation/visibility state, rank version, kind */ }
export interface HnActionIntent { /* idempotency key, action, verification state */ }
export interface HnAccountState { /* username, story, kind, current presence, observation times */ }
export interface Job { /* kind, payload, schedule, lease, attempts, status */ }
export interface IngestionRun { /* kind, cursor range, counters, status, timestamps */ }
export interface LlmCallRecord { /* call ID, request hash, status, usage, optional versioned payloads */ }
export interface AccessSessionRecord { /* hashed session/CSRF verifiers, expiry, use, revocation */ }
export interface DiagnosticError { /* safe code/message, component, correlation IDs, timestamp */ }
export interface RecommendationVersionCount { /* active profile/prompt/model versions and queue-entry count */ }

export const StorySchema: import("zod").ZodType<Story>;
export const ActivityEventSchema: import("zod").ZodType<ActivityEvent>;
export const PreferenceRuleSchema: import("zod").ZodType<PreferenceRule>;
export const QueueEntrySchema: import("zod").ZodType<QueueEntry>;
```

All externally persisted JSON has a schema version. Persisted timestamps are ISO-8601 UTC strings; HN item IDs remain integers.

## Internal subcomponents
- Shared identifiers and value objects.
- Zod schemas and inferred types.
- Versioned API/persistence envelope types.

## Dependencies on other libs
None.

## New build or OSS wrapper
New domain model using Zod `4.6.7` for boundary schemas.

## Hosted by
Shared in process by `services/personal-reader` and its libraries; no standalone runtime.

## Configuration
None.
