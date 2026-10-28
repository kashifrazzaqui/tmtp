# Activity Library Spec

## Purpose and responsibility

Normalize client and account observations into immutable activity events and deterministic reading-session projections. The package owns observation validation, idempotent replay classification, active-dwell accounting, idle gaps, session state transitions, completion, provenance, and observation quality. It does not infer likes/dislikes, persist events, enqueue jobs, fetch HN state, or verify an account mutation.

The package root is `@tmtp/activity`. It has no default export or subpath exports.

## Public interface / API surface

```ts
export interface RawActivityBase {
  clientEventId: string;
  storyId: import("@tmtp/domain").StoryId;
}

export interface DwellActivityValue {
  activeMs: number;
}

export interface ScrollActivityValue {
  ratio: number;
}

export interface HnActionActivityValue {
  present: true;
}

export interface HnReconciliationActivityValue {
  present: boolean;
}

export type RawActivity =
  | (RawActivityBase & {
      kind: "impression" | "open" | "complete" | "skip";
      occurredAt: import("@tmtp/domain").IsoDateTime;
      source: "embedded-reader" | "original-page";
      value?: never;
    })
  | (RawActivityBase & {
      kind: "dwell";
      occurredAt: import("@tmtp/domain").IsoDateTime;
      source: "embedded-reader" | "original-page";
      value: DwellActivityValue;
    })
  | (RawActivityBase & {
      kind: "scroll";
      occurredAt: import("@tmtp/domain").IsoDateTime;
      source: "embedded-reader" | "original-page";
      value: ScrollActivityValue;
    })
  | (RawActivityBase & {
      kind: "dismiss";
      occurredAt: import("@tmtp/domain").IsoDateTime;
      source: "app-action";
      value?: never;
    })
  | (RawActivityBase & {
      kind: import("@tmtp/domain").HnActionKind;
      occurredAt: import("@tmtp/domain").IsoDateTime;
      source: "app-action";
      value: HnActionActivityValue;
    })
  | (RawActivityBase & {
      kind: import("@tmtp/domain").HnActionKind;
      occurredAt?: never;
      source: "hn-reconciliation";
      value: HnReconciliationActivityValue;
    });

export interface ActivityPolicy {
  idleTimeoutMs: number;
  minDwellMs: number;
  maxSessionGapMs: number;
}

export interface ActivityReduction {
  events: import("@tmtp/domain").ActivityEvent[];
  sessions: import("@tmtp/domain").ReadingSession[];
  observationQuality: import("@tmtp/domain").ObservationQuality;
}

export type ActivityErrorCode =
  | "invalid-policy"
  | "invalid-activity"
  | "invalid-previous-session"
  | "invalid-replay"
  | "idempotency-conflict"
  | "out-of-order-session"
  | "session-overflow";

export class ActivityError extends Error {
  readonly name: "ActivityError";
  readonly code: ActivityErrorCode;
  readonly batchIndex?: number;
  constructor(code: ActivityErrorCode, batchIndex?: number);
}

export function parseActivityBatch(batch: readonly unknown[]): RawActivity[];

export function reduceActivity(
  batch: readonly RawActivity[],
  previousSession: import("@tmtp/domain").ReadingSession | undefined,
  policy: ActivityPolicy,
  clock: import("@tmtp/clock").Clock,
  existingEvents?: readonly import("@tmtp/domain").ActivityEvent[],
): ActivityReduction;
```

Runtime exports are exactly `ActivityError`, `parseActivityBatch`, and `reduceActivity`. Type exports are exactly `ActivityErrorCode`, `ActivityPolicy`, `ActivityReduction`, `DwellActivityValue`, `HnActionActivityValue`, `HnReconciliationActivityValue`, `RawActivity`, `RawActivityBase`, and `ScrollActivityValue`.

`sessions` contains every distinct session projection created or changed by the novel observations, in reduction order. It replaces the insufficient single-`session` result: one batch can close and create several sessions when it spans multiple gaps. An empty/replay-only/non-session batch can produce no sessions.

## Raw observation validation

### Identity and common fields

- `clientEventId` is a 43-character, unpadded base64url encoding of 32 bytes, matching `^[A-Za-z0-9_-]{43}$`. Client-originated producers generate those bytes once with a CSPRNG and retain the ID for retries. A trusted server producer may instead use SHA-256 over a versioned, namespaced, durable logical idempotency key. Every distinct logical observation needs a distinct key, and every retry of one observation reuses the same ID; timestamp-only keys and fresh random IDs on retry are invalid. The shape check cannot prove derivation or uniqueness.
- `storyId` is a safe positive integer. One batch must contain exactly one story ID across all rows, including duplicates. A mixed-story batch throws `invalid-activity`; consumers reject it rather than partitioning it into independently committed transactions. Clients send separate batches for separate stories.
- Raw objects and value objects reject unknown keys. Strings, numbers, booleans, arrays, null, and nested objects are not accepted in place of the declared shape.
- Non-reconciliation `occurredAt` must already be a domain ISO-8601 UTC timestamp with `Z` and millisecond precision. The reducer does not reinterpret offsets or local times.
- Reconciliation rows must omit `occurredAt`. Their observation time is server receipt time, so no historical action time is invented.
- `dismiss` and verified account actions use `app-action`. An `app-action` vote/flag/favorite must have `present=true`; failed and indeterminate HN attempts must not be submitted as verified activity.
- Reader observations use only `embedded-reader` or `original-page`. The original-page path can submit the same kinds but remains partially observed.

### Kind-specific values

| Kind | Required value | Validation |
|---|---|---|
| `impression`, `open`, `complete`, `skip`, `dismiss` | absent | A present `value` key is invalid, including `null`. |
| `dwell` | `{ activeMs }` | Non-negative safe integer. |
| `scroll` | `{ ratio }` | Finite number in inclusive range `0..1`. |
| `upvote`, `flag`, `favorite` from `app-action` | `{ present: true }` | Exact literal `true`. |
| `upvote`, `flag`, `favorite` from `hn-reconciliation` | `{ present: boolean }` | Either boolean; records current-state evidence only. |

### `parseActivityBatch`

`batch` must be an array; a non-array throws `invalid-activity` without a `batchIndex`. An empty array is valid and returns a fresh empty array.

`parseActivityBatch` applies all structural rules above, including the single-story rule and within-batch idempotency comparison. It returns a fresh array with fresh observation/value objects and preserves row order and identical duplicate rows. It does not read a clock, apply policy, sort rows, remove duplicates, or inspect persisted records.

Two rows in the same input with the same `clientEventId` must have identical story, kind, source, occurrence presence/value, and value content. Otherwise the later row throws `idempotency-conflict`. Exact duplicates are valid and are collapsed only during reduction.

The reducer calls the same parser even for statically typed input, so direct JavaScript callers receive the same runtime guarantees.

## Policy validation

All policy fields are safe integers and satisfy:

```text
0 <= minDwellMs <= idleTimeoutMs <= maxSessionGapMs
idleTimeoutMs >= 1
maxSessionGapMs >= 1
```

Invalid or missing policy fields throw `invalid-policy` before observation reduction. Defaults come from configuration, not hidden literals in the reducer.

## Previous-session and replay-input validation

`previousSession` is the latest stored session for the batch's story by `(updatedAt,id)`, whether `active`, `complete`, or `abandoned`; an active-only lookup is insufficient. It must satisfy the domain schema and these reducer invariants:

- its story matches the batch;
- `startedAt <= updatedAt`, and a terminal session has `startedAt <= endedAt`;
- an active session has no `endedAt`, while terminal sessions do;
- `lastClientEventId` has the same validated 43-character identity shape;
- dwell is a non-negative safe integer and scroll is finite in `0..1`.

A violation throws `invalid-previous-session`. Supplying an older session when a later projection exists violates the caller contract because it can fork the projection.

For an empty batch, `previousSession` must be `undefined`; any supplied session throws `invalid-previous-session`. `existingEvents` defaults to an empty array and supplies the persisted record for each input `clientEventId` that is already present. Every supplied record must satisfy the domain event schema, this package's kind/source/value rules, deterministic event ID rule, and reconciliation timing rule. Records must have unique client IDs and correspond to an input row. Invalid, duplicate, unrelated, or nonempty-for-an-empty-batch replay records throw `invalid-replay`.

The caller normally obtains these records and the latest session inside the same synchronous store transaction used for the writes. Omitting a record that actually exists is detectable by the store's unique constraint, but the one-writer transaction contract exists to prevent that race.

## Errors

`ActivityError` uses fixed messages:

| Code | Message |
|---|---|
| `invalid-policy` | `Activity policy is invalid.` |
| `invalid-activity` | `Activity observation is invalid.` |
| `invalid-previous-session` | `Previous reading session is invalid.` |
| `invalid-replay` | `Persisted activity replay data is invalid.` |
| `idempotency-conflict` | `Client event identity conflicts with an existing observation.` |
| `out-of-order-session` | `Reading-session observations are out of order.` |
| `session-overflow` | `Reading-session dwell exceeds the supported range.` |

When a failure belongs to an input row, `batchIndex` is its zero-based original index. It is absent for policy, previous-session, and replay-set failures. Direct construction validates that a supplied index is a non-negative safe integer and otherwise throws `TypeError`.

The error has no `cause`, raw observation, value payload, or client event ID. Messages never echo supplied values. Reduction is all-or-nothing: a thrown error returns no partial event or session result. Unexpected exceptions from domain schema code or a nonconforming clock propagate unchanged.

## Event normalization and deterministic identity

For each novel observation:

- `id = "evt_" + clientEventId`.
- `clientEventId`, story, kind, source, and validated value are preserved.
- `valueSchemaVersion = 1` on every event. Value-less events omit `value`; no substitute payload is invented.
- `embedded-reader` and `app-action` events have `observationQuality="full"`.
- `original-page` and `hn-reconciliation` events have `observationQuality="partial"`.
- Non-reconciliation events retain client `occurredAt`. Reconciliation events set both `occurredAt` and `receivedAt` to the same server receipt timestamp.
- `receivedAt` is one `clock.now()` reading shared by every novel event in the reduction, formatted as domain ISO UTC. The reducer calls the clock once only when at least one novel event exists.
- A novel non-reconciliation `occurredAt > receivedAt` throws `invalid-activity`. There is no implicit future-skew tolerance or clamping.

Event IDs and new session IDs are deterministic so retries do not depend on fresh random generation. A session created by a starter event uses `id = "ses_" + starterClientEventId`. Given the required CSPRNG or SHA-256 client identity, these derived IDs retain its collision resistance while remaining reproducible.

The returned `events` contains only novel observations, sorted by `(occurredAt, clientEventId)` using epoch time then ASCII/code-unit lexicographic order. `batch.length - events.length` is the duplicate count. Inputs, previous sessions, and existing events are never mutated.

## Idempotent replay contract

Replay identity is logical observation content, not a new receipt timestamp.

An input row is an exact replay of an existing event when all of these match:

- deterministic event ID and `clientEventId`;
- story, kind, source, value schema version, and kind-specific value;
- expected observation quality;
- client `occurredAt` for non-reconciliation events.

`receivedAt` is ignored for every replay comparison. For reconciliation, both timestamps are receipt-derived and are excluded from content comparison, but the stored event must already have `occurredAt === receivedAt`.

A matching row produces no new event and no session contribution. A `clientEventId` reused with any different logical content throws `idempotency-conflict`; it never silently keeps the first payload. Identical duplicates within one batch are also collapsed. Thus a full retry produces zero novel events and zero session updates, while a partial retry applies only its novel rows.

This preclassification is required before session reduction. Filtering only after adding dwell would double-count replayed observations.

## Reading-session reduction

### Ordering and session membership

Only `open`, `dwell`, `scroll`, `complete`, and `skip` are session observations. `impression`, `dismiss`, and HN action/reconciliation events never change a reading session.

Novel session observations are processed in `(occurredAt, clientEventId)` order. To keep incremental reduction identical to an ordered rebuild, the first session observation must be strictly after the previous session's `(updatedAt, lastClientEventId)` tuple, and each subsequent one strictly after the prior session observation. Equal time is valid only with a greater client ID. A stale or exactly repeated position throws `out-of-order-session`; the whole batch fails rather than dropping the event or misattributing its dwell.

`updatedAt` is the last applied session observation's occurrence time, not server receipt time. The gap is `current.occurredAt - working.updatedAt`. A gap strictly greater than `maxSessionGapMs` closes the active working session and reduces the current event in a new session; a gap exactly equal to the limit remains in the current session.

### Session creation and terminal observations

- `open`, `dwell`, and `scroll` start a session when no active working session exists.
- A new session starts with `startedAt=updatedAt=occurredAt`, zero dwell, zero scroll, `state="active"`, no `endedAt`, the event's client ID as `lastClientEventId`, and the event's observation quality. Its deterministic ID uses the starter's client ID.
- With no active working session, `complete` and `skip` also create a session from their own client ID and immediately apply their terminal transition. The result is a zero-length `complete` or `abandoned` session with `startedAt=endedAt=updatedAt=occurredAt`, zero dwell, and zero scroll. This preserves both the observation and the ordering high-watermark.
- If the latest previous session is terminal, any later session observation begins a new session; the terminal session is never reopened.
- Every novel session observation therefore advances exactly one session's `(updatedAt,lastClientEventId)` position. No session observation is left outside the projection.

### Active-session transitions

For an active working session inside the gap limit:

- Every session observation sets `updatedAt=occurredAt` and `lastClientEventId=clientEventId`.
- `open` changes no dwell or scroll and does not reset the session.
- `dwell` adds `min(activeMs, idleTimeoutMs)` when `activeMs >= minDwellMs`; below `minDwellMs` it adds zero. The immutable event retains the original `activeMs`. If the safe-integer sum would overflow, throw `session-overflow` before changing any output.
- `scroll` sets `maxScrollRatio = max(previousRatio, ratio)`. It never decreases within a session.
- `complete` sets `state="complete"` and `endedAt=occurredAt`.
- `skip` sets `state="abandoned"` and `endedAt=occurredAt`.
- Observation quality is sticky: once any contributing observation is `partial`, the session remains `partial`; otherwise it is `full`.
- Completion never forces scroll to 1, adds dwell, or implies a preference.

The reducer does not infer active time from the distance between events. Producers measure active time excluding hidden/blurred/inactive periods; capping each contribution at `idleTimeoutMs` prevents an inactive gap from becoming unbounded dwell.

### Idle-gap abandonment

When an active working session is followed by any session observation beyond `maxSessionGapMs`:

1. Emit a clone of the old session with `state="abandoned"` and `endedAt=old.updatedAt`. Keep its old `updatedAt`, `lastClientEventId`, dwell, scroll, and quality. The end means last observed activity, not a claimed exact moment the reader left.
2. Create and reduce a new session from the current event. `open`/`dwell`/`scroll` leave it active; `complete`/`skip` immediately close the zero-length new session.

Abandonment is lazy: non-session activity and the passage of time alone do not mutate a session. A later projection rebuild applies the same rule.

### Result sessions

`sessions` contains one final clone per affected session, ordered by when that session closes or by final update for the last active session. A batch can therefore contain an abandoned old session and a new active session, several such pairs, a completed session followed by another session, or no sessions. Upserting these records in array order inside the activity transaction produces the projection.

### Ordered rebuild

To rebuild projections for one story, convert its persisted events back to raw observations, omit `occurredAt` when converting reconciliation events, and call the reducer with no previous session, an empty replay set, and the same policy. Supply a fixed clock set to the maximum original `receivedAt` in the rebuild input. Every originally accepted non-reconciliation occurrence is then at or before the rebuild receipt even if the current wall clock has moved backward. Use only the rebuilt session outputs; never reinsert the regenerated event outputs as new history.

The maximum-original-receipt clock is part of the rebuild procedure, not a new receipt policy. Rebuilding with the current clock is invalid because ingestion-time future validation is not a historical validity check. Chunked and whole-history rebuilds using this rule produce the same sessions.

Rebuilding empty event history needs no clock and returns no events or sessions.

`observationQuality` on the reduction is `"partial"` if any input row, including a replay, is from `original-page` or `hn-reconciliation`; otherwise it is `"full"`. It is `"full"` for an empty batch as a neutral value. This aggregate does not override the sticky quality computed independently for each session.

## Atomic composition and concurrency

The pure functions have no shared mutable state and are safe to interleave. Persistence requires this exact synchronous composition in `personalization`:

1. Call `parseActivityBatch` before storage so malformed values cannot reach driver parameter binding.
2. Open one `reader-store.transaction` on the shared connection.
3. Read every persisted event matching an input client ID and read the latest session for the story, active or terminal.
4. Call `reduceActivity` with that replay set and session. Perform no `await` in the transaction.
5. Append only `reduction.events` with `appendIdempotent`. Require its newly inserted count to equal `reduction.events.length`; a short insert proves an incomplete replay read and must throw before any session/job write so the transaction rolls back. Then upsert every `reduction.sessions` in order and enqueue profile work only when at least one novel event exists.
6. Commit events, all session writes, and profile-work enqueue together. Return `accepted = reduction.events.length`; exact and partial retries therefore report only newly accepted events.

On the target single-process, one-connection writer topology, this synchronous critical section linearizes concurrent activity calls. Unique `client_event_id` and `last_client_event_id` constraints are backstops, not a substitute for replay preclassification. A failure rolls back all writes. External HN/LLM calls, timers, and Promise-returning work are forbidden inside the transaction.

Multiple independent processes writing one database are outside the contract. Supporting them would require an atomic bulk replay claim and a session optimistic-concurrency/version boundary rather than relying on JavaScript turn ordering.

## Security, idempotency, and reduction invariants

1. Every accepted event has a unique validated client identity and deterministic ID; conflicting reuse fails loudly without echoing payloads.
2. A replay never adds dwell, scroll, completion, or quality twice. Only novel events trigger profile work.
3. Immutable events preserve client occurrence and server receipt separately, except reconciliation deliberately uses receipt time for both because no action timestamp is known.
4. `original-page` and `hn-reconciliation` evidence is always partial; reconciliation can record `present=false` and never fabricates a historical user action.
5. Active dwell is bounded per observation, never includes an implicit idle gap, and remains a non-negative safe integer.
6. Session scroll never decreases within one session; a new session starts at zero. Terminal sessions are never reopened or changed; an active session can later be classified abandoned by a newer gap observation.
7. Session processing order is deterministic and rejects stale updates, so incremental reduction equals an ordered rebuild from the same events and policy.
8. Events and all affected session projections commit atomically with profile work; story/content reads remain available if later personalization fails.
9. Activity evidence remains ambiguous. Dwell, skip, scroll, completion, and even explicit account actions are not rewritten into likes/dislikes by this package.
10. Validation errors contain no raw values, client IDs, story content, access tokens, or account cookies.

## Internal subcomponents

- Strict raw-observation parser and policy/previous-session validators.
- Logical replay classifier and deterministic event/session identity.
- Event normalizer and provenance/quality mapper.
- Ordered active-dwell and multi-session projection reducer.

These are implementation details; only the API above is public.

## Dependencies on other libs

- `clock` for server receipt time.
- `domain` for identifiers, records, and persisted-record schemas.

No storage package is imported. `reader-store` and `job-queue` are reached structurally through the `personalization` composition.

## New build or OSS wrapper

New pure TypeScript implementation; no third-party runtime dependency and no direct Node crypto, filesystem, network, or database use.

## Hosted by

`personalization` for recording and profile updates, with `reader-app` exposing the transport-free command in `services/personal-reader`.

## Configuration

- `activity.idle_timeout_ms` — **optional**, default `60000`, safe integer at least 1; maximum counted dwell per dwell observation.
- `activity.min_dwell_ms` — **optional**, default `1000`, safe integer at least 0 and at most the idle timeout; smaller observations remain events but add no dwell.
- `activity.max_session_gap_ms` — **optional**, default `300000`, safe integer at least the idle timeout; larger occurrence gaps split sessions.

No additional keys control timestamp skew, batch size, replay retention, ID generation, or session cleanup.

## Acceptance-focused test expectations

Tests use the public API and `createFixedClock`; reducer tests need no global mocks. At minimum, cover:

- `should parse every raw kind/source/value combination and return defensive clones`.
- `should reject unknown keys, invalid IDs/story IDs/timestamps, invalid values, and mixed-story batches without echoing input`.
- `should expose fixed error codes and messages with the original batch index`.
- `should accept exact policy boundaries and reject invalid policy orderings before reduction`.
- `should preserve identical in-batch duplicates and reject conflicting in-batch identities`.
- `should accept either CSPRNG-generated or SHA-256-derived 32-byte client identities and derive the same internal IDs on retry`.
- `should normalize one receipt timestamp and deterministic event IDs for every novel event`.
- `should reject future client occurrence times and omit occurrence input from reconciliation`.
- `should set reconciliation occurrence equal to receipt and always mark original-page and reconciliation partial`.
- `should return only novel events when persisted and in-batch exact replays are present`.
- `should ignore receipt time when comparing a replay and reject any changed logical content`.
- `should make a full retry produce zero events, zero session updates, and no clock read`.
- `should treat an empty batch as a no-op and reject nonempty previous-session or replay inputs`.
- `should apply only novel dwell in a partial retry so dwell is not doubled`.
- `should count dwell exactly at the minimum and cap active dwell at the idle timeout`.
- `should retain sub-minimum dwell as an immutable event with zero session contribution`.
- `should keep sessions together at exactly the maximum gap and split them only beyond it`.
- `should abandon an old session at its last observed update and return all sessions across multiple gaps`.
- `should record complete and skip without an active session as zero-length terminal sessions that advance ordering`.
- `should accumulate maximum scroll and sticky partial quality without forcing completion to full scroll`.
- `should reject stale and exactly repeated session positions, including equal-time ID inversion`.
- `should allow equal occurrence times when client IDs increase`.
- `should reject dwell overflow without returning partial events or sessions`.
- `should not mutate raw input, previous sessions, or replay records`.
- `should produce the same final projections from chunked increments and one ordered rebuild, including orphan closers and backward current wall time`.
- `should return accepted as the novel event count through the composition contract`.

A later real-SQLite composition suite must prove replay reads + latest-session read + event append + all session upserts + profile-job enqueue roll back together, and that two concurrent duplicate commands commit one logical effect. Inject a short append result and prove it prevents session/job writes and rolls back novel events. HN composition tests must prove that one logical reconciliation retains its derived client ID across retries; the activity parser cannot verify producer provenance. An active-only session lookup is not an acceptable test double for this contract.
