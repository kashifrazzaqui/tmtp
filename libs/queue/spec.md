# Queue Library Spec

## Purpose and responsibility

Define complete-queue projection, deterministic match/exploration ranking, reading-state transitions, evaluation sections, and keyset cursor pagination independently of storage and HTTP. Preserve reading history while ranking changes. Do not fetch stories, build interest profiles, interpret preference rules, call an LLM, open a database, or read a clock.

The package is synchronous and deterministic. It uses Node SHA-256 for rank versions, exploration ordering, and cursor checksums. It has no secret, random seed, storage, or configuration-source dependency.

## Public interface / API surface

This is the complete public runtime surface:

```ts
export const QUEUE_RANK_ALGORITHM_VERSION: "queue-rank/1";
export const QUEUE_CURSOR_VERSION: "q1";
export const QUEUE_BOOTSTRAP_RANK_VERSION: "qb1.initial";

export interface RankQueueInput {
  stories: readonly import("@tmtp/domain").Story[];
  articles: readonly import("@tmtp/domain").Article[];
  recommendations: readonly import("@tmtp/domain").Recommendation[];
  evaluationByStory: Readonly<Record<number, import("@tmtp/domain").EvaluationState>>;
  profile: import("@tmtp/domain").InterestProfile;
  existingEntries?: readonly import("@tmtp/domain").QueueEntry[];
  blacklistedStoryIds: readonly import("@tmtp/domain").StoryId[];
  explorationRatio: number; // finite, 0..0.5
  explorationSeed?: string; // non-empty; defaults to profile.id
  at: import("@tmtp/domain").IsoDateTime;
}

export interface QueuePage {
  entries: import("@tmtp/domain").QueueEntry[];
  nextCursor?: string;
}

export interface QueueCursorPosition {
  rankVersion: string;
  evaluationState: import("@tmtp/domain").EvaluationState;
  rankPosition?: number;
  storyId: number;
}

export type QueueErrorCode =
  | "invalid-input"
  | "duplicate-story"
  | "duplicate-article"
  | "duplicate-entry"
  | "unknown-story"
  | "missing-recommendation"
  | "ambiguous-recommendation"
  | "evaluation-conflict"
  | "invalid-transition"
  | "invalid-page-size"
  | "invalid-cursor"
  | "cursor-version-mismatch"
  | "cursor-section-mismatch";

export class QueueError extends Error {
  readonly name: "QueueError";
  readonly code: QueueErrorCode;
  readonly field?: string;
  readonly storyId?: import("@tmtp/domain").StoryId;
  readonly from?: import("@tmtp/domain").QueueState;
  readonly to?: import("@tmtp/domain").QueueState;
  constructor(code: QueueErrorCode, message: string, details?: {
    field?: string;
    storyId?: import("@tmtp/domain").StoryId;
    from?: import("@tmtp/domain").QueueState;
    to?: import("@tmtp/domain").QueueState;
  });
}

export function rankQueue(input: RankQueueInput): import("@tmtp/domain").QueueEntry[];

export function transitionQueueState(
  entry: import("@tmtp/domain").QueueEntry,
  next: import("@tmtp/domain").QueueState,
  at: import("@tmtp/domain").IsoDateTime,
): import("@tmtp/domain").QueueEntry;

export function encodeQueueCursor(position: QueueCursorPosition): string;
export function decodeQueueCursor(cursor: string): QueueCursorPosition;

export function paginateQueue(
  entries: readonly import("@tmtp/domain").QueueEntry[],
  cursor: string | undefined,
  pageSize: number,
): QueuePage;
```

`QueueCursorPosition` is structurally identical to `@tmtp/reader-store`'s interface of the same name. This is deliberate: `reader-app` can pass `decodeQueueCursor(cursor)` directly as `QueuePageQuery.after`, while neither package imports the other.

`QUEUE_BOOTSTRAP_RANK_VERSION` is the only version source for newly ingested pending rows before a complete ranking projection exists. It is deliberately shared across profiles: a profile change must not partition initial pending rows into incompatible rank-version pages. `reader-app` supplies the constant to `hn-ingestion` through a callback; ingestion does not import queue. Initial rows use pending/story-ID ordering until complete reprojection replaces this bootstrap version with a profile/content-addressed version and recomputes all visibility.

All public functions validate runtime input with domain schemas plus the rules below. `RankQueueInput` and `QueueCursorPosition` reject unknown top-level keys. Public functions do not mutate inputs. Returned pages/entries/cursor positions are fresh objects. Error messages name stable fields but do not include story titles, rationales, profile payloads, cursor payloads, or recommendation evidence. Callers use `code`, not message matching.

## Complete projection and eligibility

`rankQueue` projects every supplied story exactly once. The input `stories` must be the complete projection batch desired by the caller; the function imposes no story cap and never treats a low score, pending evaluation, failed evaluation, deletion, or death as an implicit rejection.

- Duplicate story IDs throw `duplicate-story`.
- Duplicate article story IDs throw `duplicate-article`. Articles are indexed by story; an absent article has the domain's logical content version `"none"`.
- Duplicate existing-entry story IDs throw `duplicate-entry`.
- A recommendation, article, evaluation key, or blacklist ID that names no supplied story throws `unknown-story`.
- Every output row has `visibilityState="blacklisted"` when its ID is in `blacklistedStoryIds`, otherwise `"visible"`. Duplicate blacklist IDs are deduplicated; their input order is irrelevant.
- Blacklisted rows remain in the returned projection for persistence/history. The reader-store default query hides them. Blacklisting never changes reading state, evaluation state, recommendation identity, or story/activity history.
- Deleted/dead stories remain visible unless explicitly blacklisted. Their story row and reading history are not erased; downstream story presentation may explain unavailable content.

`queue` does not import `interests`. The composition that calls `rankQueue` must compute `blacklistedStoryIds` with `interests.isBlacklisted` for the same `profile` and complete story set. An omitted set is invalid; an empty set explicitly means no blacklisted stories.

### Recommendation/evaluation alignment

An **active recommendation** for a story has `recommendation.profileId === profile.id`, `recommendation.storyContentVersion === story.contentVersion`, and `recommendation.articleContentVersion === domain.articleContentVersion(articleForStory)`. Recommendations for other profiles/story/article versions are historical inputs and are ignored for ranking. All recommendation IDs must still be unique and reference a supplied story; duplicate IDs are `invalid-input`.

There may be at most one active recommendation per story; multiple active records throw `ambiguous-recommendation`. The caller preselects the intended prompt/model version through its repository query rather than letting queue rank by creation time.

For each story:

- If `evaluationByStory` has an own property for the ID, use its value.
- Otherwise default to `"scored"` when an active recommendation exists and `"pending"` otherwise.
- `"scored"` requires an active recommendation; absence throws `missing-recommendation`.
- `"pending"` or `"failed"` with an active recommendation throws `evaluation-conflict`, because queue output may not link an unscored row to a current recommendation.
- A supplied evaluation value outside the domain union is `invalid-input`.

A scored row links the active recommendation and copies its finite `0..1` score to `rankScore`. Pending/failed rows have no `recommendationId`, `rankScore`, or `rankPosition` and have `kind="match"`. They are never fabricated as low-scoring recommendations.

## Ranking algorithm

### Base match order

Sort all scored rows by recommendation score descending, then `storyId` ascending. This is the base match order. It includes blacklisted rows so visibility changes do not make their historical recommendation identity disappear.

### Deterministic exploration selection

The effective seed is `explorationSeed ?? profile.id`; an explicitly supplied empty seed is `invalid-input`. The seed is public policy input, not a secret.

Let `V` be the number of visible scored rows in base match order.

1. The exploration pool is the strictly lower-scoring half of those visible rows: zero-based base indices `ceil(V/2)` through `V-1`. Thus `V=0` and `V=1` have an empty pool, and tied scores retain the story-ID tie-break.
2. Set `E = min(floor(V * explorationRatio), pool.length)`. A ratio of zero selects none. No rounding-up rule creates exploration above the requested ratio.
3. For each pool row compute `sha256(UTF8(JSON.stringify(["queue-exploration/1", effectiveSeed, profile.id, storyId])))` as lowercase hex. Sort by digest ascending, then story ID ascending, and select the first `E` as exploration rows.
4. Remove selected rows from the match sequence and set their `kind="exploration"`. Every other scored row has `kind="match"`; blacklisted rows can never be selected.

The hash is stable across runs and does not depend on array order, a random generator, a secret, or the current time. The score still appears as `rankScore`; exploration changes placement/label, not the immutable judgment.

### Merge and positions

Let `N` be the total number of scored rows, including blacklisted rows. Merge the remaining match sequence and selected exploration sequence into `N` positions. Exploration row `k` in hash order occupies the one-based position:

```text
floor(k * (N + 1) / (E + 1)), for k = 1..E
```

Fill all other positions in base match order. These positions are unique and in `1..N` for `0<=E<=N`; `E=0` produces a plain base match sequence. Assign `rankPosition` sequentially `1..N` after the merge, including blacklisted rows. Hidden positions may therefore be absent from a visible page; this is expected and does not break keyset order.

The final `rankQueue` return order is the complete store/page order:

1. `scored`, by `(rankPosition,storyId)` ascending;
2. `pending`, by `storyId` ascending;
3. `failed`, by `storyId` ascending.

There is no exploration placement inside pending/failed sections and no silent queue truncation.

### Rank version

Compute one version shared by every output row:

```text
rankVersion = "qr1." + sha256(UTF8(JSON.stringify({
  algorithm: QUEUE_RANK_ALGORITHM_VERSION,
  profileId: profile.id,
  explorationRatio,
  explorationSeed: effectiveSeed,
  blacklistedStoryIds: sortedUniqueBlacklistedIds,
  stories: storiesSortedByStoryId.map(story => ({
    storyId: story.id,
    contentVersion: story.contentVersion,
    evaluationState,
    recommendationId: activeRecommendation?.id ?? null,
    kind: finalKind,
    rankScore: activeRecommendation?.score ?? null
  }))
})))
```

Object properties and story properties appear in exactly the order shown. The rank-version digest is 64 lowercase hexadecimal characters. Blacklist IDs sort numerically ascending. `explorationRatio` uses JSON number serialization after normalizing negative zero to zero. Rank positions are derived from these inputs and are not separately hashed. Reading state, timestamps, and last errors are deliberately excluded so reading a story or recording the same failure text does not invalidate pages.

Any change to eligibility, exploration selection/merge, section order, or this version payload requires a new `QUEUE_RANK_ALGORITHM_VERSION` and cursor/rank migration behavior.

### Reading fields and timestamps

For a story with an existing entry, preserve `state` and `queuedAt`; otherwise use `"unread"` and `at`. Preserve `lastError` only when both existing and new evaluation states are `"failed"`; clear it for scored/pending and for a newly failed row with no supplied failure detail. Set `updatedAt=at` on every projected row. Recompute visibility/kind/recommendation/rank fields from current inputs.

For a supplied story, `at` must not precede its existing entry's `updatedAt` or `queuedAt`; such input is `invalid-input` rather than moving reading history backward. Existing entries for stories outside the supplied complete set are ignored by this pure projection; persistence APIs likewise must not delete them merely because a bounded rebuild batch omitted them.

## Reading-state transitions

`transitionQueueState` changes only `state` and, for a real change, `updatedAt`. Evaluation, visibility, kind, recommendation, rank version/score/position, error, and `queuedAt` remain unchanged.

| Current \ requested | `unread` | `reading` | `read` | `dismissed` | `archived` |
|---|---|---|---|---|---|
| `unread` | no-op | allow | allow | allow | allow |
| `reading` | allow | no-op | allow | allow | allow |
| `read` | allow | allow | no-op | allow | allow |
| `dismissed` | allow | reject | reject | no-op | allow |
| `archived` | allow | reject | reject | reject | no-op |

Every successful call returns a fresh entry. A same-state request is an idempotent no-op and preserves `updatedAt`. A disallowed known-state pair throws `invalid-transition` with `from`/`to`; an unknown state is `invalid-input`. `at` must be a valid domain timestamp not earlier than `entry.updatedAt`, including for a no-op. A real transition sets `updatedAt=at`.

Restoring dismissed/archived history goes through `unread`; rereading a read story may go directly to `reading`. The application validates the transition before calling the store's state update.

## Keyset cursor codec

### Position and total order

A cursor identifies the last returned tuple, not an offset:

- `rankVersion`: non-empty string, at most 128 UTF-16 code units;
- `evaluationState`: `scored`, `pending`, or `failed`;
- `rankPosition`: required positive safe integer for `scored`, absent for `pending`/`failed`;
- `storyId`: positive safe integer.

For comparison, evaluation sections use `scored=0`, `pending=1`, `failed=2`. A scored tuple is `(0,rankPosition,storyId)`; pending/failed tuples are `(section,0,storyId)`. Pagination resumes strictly after this tuple in the same total order, even if the original row was subsequently removed from the filtered result.

### Encoding

Version `q1` uses:

```text
"q1." + base64url(payloadBytes) + "." + base64url(sha256(payloadBytes))
```

`payloadBytes` is the UTF-8 encoding of canonical JSON with exactly these properties in this order:

```ts
{
  rankVersion: position.rankVersion,
  evaluationState: position.evaluationState,
  // rankPosition appears here only for scored:
  rankPosition?: position.rankPosition,
  storyId: position.storyId,
}
```

Base64url uses RFC 4648 URL-safe characters with no `=` padding. The checksum segment encodes all 32 SHA-256 bytes. The checksum is unkeyed: it detects accidental corruption and makes the format self-checking, but **does not authenticate the cursor or prevent deliberate modification**. No signing secret, key file, environment variable, or configuration key is required or permitted.

### Strict decoding and errors

`decodeQueueCursor` rejects a non-string/overlong value (maximum 2048 UTF-16 code units), wrong prefix/segment count, invalid or padded base64url, invalid UTF-8/JSON, unknown/missing/reordered properties, noncanonical JSON/base64, invalid field values, and checksum mismatch. It re-encodes the parsed value and requires byte equality with the supplied cursor, preventing alternate representations. Failures throw `invalid-cursor`; no partial position is returned.

`encodeQueueCursor` applies the same position validation and throws `invalid-cursor` for an invalid position. `decodeQueueCursor` returns a fresh structurally store-compatible `QueueCursorPosition`.

The cursor carries rank version and evaluation section only. The application must use the same reading-state/visibility filters when continuing a page and must start with no cursor when those filters change. Reader-store separately enforces rank-version and explicit evaluation-filter compatibility.

## In-memory pagination

`paginateQueue` operates on the exact entries supplied; it does not apply visibility, reading-state, or evaluation filters. Callers filter first and must keep those filters unchanged across pages.

- Validate domain entries, unique story IDs, and one common non-empty `rankVersion` for a non-empty list. Pending/failed entries must not carry rank positions; scored entries must carry valid positions.
- Sort a copy into the complete section order above rather than relying on input order.
- Validate `pageSize` as a positive safe integer; otherwise throw `invalid-page-size`. `reader-app` separately enforces the configured `queue.max_page_size` before calling this function or the store.
- Decode the optional cursor. For a non-empty list, cursor rank version must equal the entries' version or throw `cursor-version-mismatch`. If every supplied entry has one evaluation state (an evaluation-filtered list), a different cursor section throws `cursor-section-mismatch`. An empty list cannot prove version/section compatibility; it returns an empty page after cursor syntax validation.
- Select the first `pageSize` entries strictly after the decoded tuple. Return `nextCursor` encoded from the last returned entry only when more entries remain. A page ending exactly at the list end has no `nextCursor`; an empty page has none.

Changing reading state alone preserves rank version/order. Re-ranking creates a new rank version and callers restart pagination without the old cursor. As with any keyset protocol, inserting rows before the current position during an unchanged rank version does not shift the cursor; rankQueue's content-addressed rank versions normally prevent such in-place ranking changes.

## Error contract

| Code | Condition |
|---|---|
| `invalid-input` | Malformed domain/policy/timestamp/seed/evaluation data, invalid rank fields, mixed entry versions, or backward timestamps |
| `duplicate-story` | Repeated story ID in ranking input |
| `duplicate-article` | Repeated article story ID in ranking input |
| `duplicate-entry` | Repeated existing-entry story ID |
| `unknown-story` | Recommendation, evaluation key, or blacklist ID outside the supplied stories |
| `missing-recommendation` | `scored` evaluation has no active recommendation |
| `ambiguous-recommendation` | More than one active recommendation exists for a story |
| `evaluation-conflict` | Pending/failed evaluation has an active recommendation |
| `invalid-transition` | A known but disallowed reading-state pair |
| `invalid-page-size` | Page size is not a positive safe integer |
| `invalid-cursor` | Cursor text or to-be-encoded position violates the codec contract |
| `cursor-version-mismatch` | Cursor rank version differs from the non-empty page's rank version |
| `cursor-section-mismatch` | Cursor section differs from an evaluation-filtered page's section |

Expected validation failures throw `QueueError`; no partial ranking, transition, decoded position, or page is returned.

## Internal subcomponents

- Runtime validation, story/recommendation/existing-entry indexing, and active-recommendation alignment.
- Match ordering, deterministic exploration selection/merge, and rank-version hashing.
- Reading-state machine and history-preserving entry projection.
- Canonical checksummed cursor codec and total-order keyset pagination.

## Dependencies on other libs

- `domain`

Node's built-in `node:crypto` and UTF-8/base64url APIs are runtime primitives, not workspace dependencies. The package does not import `interests`, `reader-store`, `clock`, `config`, or `recommendations`.

## New build or OSS wrapper

New pure TypeScript implementation with no third-party runtime dependency.

## Hosted by

`personalization` and `reader-app` in `services/personal-reader`; `recommendations` delegates complete queue construction here.

## Configuration

- `queue.page_size` — **optional**, default `50`; applied by `reader-app` when the caller omits a limit.
- `queue.max_page_size` — **optional**, default `200`; positive safe-integer upper bound applied by `reader-app`. The pure paginator does not replace this configurable boundary with a hard-coded maximum.

No exploration secret, cursor secret/key, signing key, hash key, or additional queue key exists. Exploration ratio is owned by `recommendations.exploration_ratio`; the optional programmatic seed defaults to the profile ID.

## Acceptance-focused test expectations

### Projection and ranking

- Build mixed scored/pending/failed, visible/blacklisted, deleted/dead, missing/pending/failed/ready-article, and previously read fixtures. Verify every story remains projected, default-store visibility can hide only blacklisted rows, and reading state/queued time survive ranking.
- Verify exact article-content-version activation, duplicate/orphan articles, and that article-only changes invalidate the prior active recommendation and rank version without rewriting its history.
- Cover missing evaluation defaults, missing/ambiguous recommendations, stale profile/content recommendations, pending/failed conflicts, unknown IDs, duplicates, invalid scores, and backward timestamps.
- Pin exact base tie-breaking, lower-half exploration pools for `V=0..6`, ratios `0`, `0.1`, and `0.5`, hash order, merge positions, blacklisted non-selection, and sequential scored positions. Verify pending/failed retain story-ID sections and no rank fields.
- Pin the shared bootstrap version, verify ingestion before and after a profile change remains in one initial page, and verify reader-app's callback supplies the constant without a new ingestion→queue dependency.
- Assert exact golden rank versions across input permutations and different timestamps/reading states. Change profile, content, active recommendation, evaluation, blacklist set, ratio, seed, or algorithm and assert a version change where documented.

### State and pagination

- Exercise every cell of the transition matrix, idempotent no-ops, field preservation, fresh-object results, invalid states, and timestamp monotonicity.
- Pin independent golden cursor strings for each evaluation section and Unicode rank versions. Round-trip positions and verify the decoded object is accepted structurally as reader-store `QueuePageQuery.after` without importing that package.
- Reject malformed base64url/JSON/checksums, unknown/reordered keys, padding, alternate encodings, missing/excess rank positions, unsafe IDs, invalid versions, and oversized cursors without leaking payload text in errors.
- Page mixed sections, exact/full/short/empty pages, score/position ties, deleted next rows, and cursors between sections. With unchanged entries, concatenated pages equal the canonical list with no duplicates, omissions, offset drift, or terminal cursor.
- Verify rank-version/evaluation-section mismatches, same-filter evaluation pages, invalid sizes, and unchanged visibility/state filters across continuations. Demonstrate that changing filters starts a fresh cursorless page.

### Workflow acceptance

- For WF-03, collect a queue larger than two pages with pending and failed stories, verify all non-blacklisted stories remain reachable, and inspect the exact recommendation/rank version used by scored rows.
- For WF-06, apply an updated blacklist ID set and verify exploration never labels/selects a blacklisted row and no reading/activity/recommendation history is rewritten.
