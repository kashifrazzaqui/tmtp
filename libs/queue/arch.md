# Queue Library Architecture

## Internal structure

The package is a deterministic projection/codec library with four main modules:

- `projection`: runtime validation, complete-story indexing, active-recommendation selection, evaluation alignment, and reading-field preservation.
- `ranking`: base score order, exploration hashing/selection/merge, evaluation sections, rank positions, and rank-version derivation.
- `bootstrap`: one shared rank-version constant for initial pending ingestion rows.
- `state`: the explicit reading-state transition matrix and timestamp invariants.
- `pagination`: total-order comparison, strict cursor encoding/decoding, and in-memory keyset pages.

`rankQueue` is the write-projection seam. `paginateQueue` is useful for pure tests and already-loaded lists; the production store performs the same ordering in SQL. `decodeQueueCursor` is the transport-to-store seam. Its returned `QueueCursorPosition` has exactly the fields accepted by `reader-store` without introducing a queue ↔ reader-store dependency.

Blacklist matching stays outside this package. A composition with both `interests` and `queue` in its existing dependency set computes the IDs. This avoids duplicating preference semantics and avoids adding a queue → interests edge.

## Ranking pipeline

### 1. Validate and select current judgments

Index stories, articles, existing entries, and recommendations by story ID. A recommendation becomes active only when profile ID, story content version, and the domain-derived article content version all match. Missing articles use the shared `none` version. This is stronger than selecting the newest recommendation: creation-time latest queries can silently change explanations when several prompt/model/article versions coexist. The caller supplies one exact prompt/model selection; queue rejects ambiguity.

The evaluation map is then reconciled with the active recommendation. This check prevents two corrupt states: a scored row with no evidence, and a pending/failed row pointing at a current successful judgment. Historical recommendations for another content/profile version do not block unscored rows.

### 2. Rank matches and place exploration

The base comparator is score descending plus story ID. It is deliberately simple and inspectable; the LLM score is not blended with HN popularity or hidden heuristics in this package.

Exploration is a deterministic permutation of a bounded lower-score pool, not a random score boost:

1. Compute the visible scored base order and take its strictly lower half.
2. Derive the requested count from visible scored count and ratio using floor.
3. Order the pool by a content hash of algorithm, seed, profile, and story ID.
4. Remove selected rows and merge them at evenly spaced integer positions.

The merge formula spreads exploration without random calls or iterative collision handling. Blacklisted rows stay in the match sequence and consume rank positions but cannot consume an exploration label. Pending/failed rows remain in later evaluation sections rather than being misrepresented as explored recommendations.

A profile ID is the default seed because it is already versioned and stable. Callers can supply a non-empty seed for an explicit exploration sequence; no secret or new configuration setting is needed.

### 3. Derive a content-addressed rank version

The rank version hashes only inputs that can change ordering or explanation: algorithm, profile, story content/evaluation, active recommendation, final kind/score, exploration policy/seed, and blacklist IDs. It excludes reading state and timestamps. This provides three useful properties:

- identical rebuilds retain one rank version and cursor compatibility;
- actual ranking changes invalidate old cursors explicitly;
- reading a story does not reshuffle a reader's current pages.

Rank positions are assigned after exploration merging and cover every scored row, including hidden rows. Pending/failed use story-ID keysets and do not need synthetic positions or scores.

Before any complete ranking projection, `QUEUE_BOOTSTRAP_RANK_VERSION` provides one namespace shared by initial pending rows across profile changes. This avoids partitioning the initial queue when ingestion occurs before reprojection. Reader-app supplies the constant through a small callback, which keeps `hn-ingestion` independent of queue. A later complete projection replaces the bootstrap version with the content-addressed rank version above and recomputes every row's profile-specific visibility.

### 4. Preserve reading history

Projection treats reading fields as a patch over the prior row. `state` and `queuedAt` survive, visibility is recomputed from the supplied set, and ranking fields are replaced as one unit. A failure string survives only an unchanged failed state; the library does not invent a new error when the evaluation map supplies only a state.

The pure function accepts `at` rather than importing `clock`. This keeps exact tests simple and puts timestamp policy in the composition. Backward timestamps are rejected so a projection cannot make reading history appear older.

## Pagination and cursor design

### One comparator in two environments

The logical tuple is:

```text
scored:  (0, rankPosition, storyId)
pending: (1, 0,           storyId)
failed:  (2, 0,           storyId)
```

The TypeScript paginator sorts by this tuple and applies a strict greater-than predicate. Reader-store's documented SQL order and keyset predicate implement the same tuple after receiving the decoded fields. Contract tests at the composition boundary should run identical fixtures through both paths and compare story-ID sequences.

The cursor points to a value, not an array index or SQL `OFFSET`. A row disappearing after the cursor does not shift later rows. Rank-version binding prevents a cursor from being applied to a newly ranked data set; evaluation-section binding supports section-filtered queries. Reading-state and visibility filters are intentionally application continuation state, so changing them requires a fresh page.

### Canonical, checksummed, unsigned transport

A cursor is `q1.payload.checksum`. The payload is canonical JSON encoded as unpadded base64url; the checksum is SHA-256 over the payload bytes, also unpadded base64url. Strict re-encoding rejects semantically valid but noncanonical alternatives. Version, shape, rank-position presence, safe-integer, length, and checksum checks all happen before returning a position.

An earlier draft called the cursor “signed.” This design does not make that claim. A signature without a key would be meaningless, and adding an HMAC key would change centralized secret configuration and key-rotation behavior. The single-user queue cursor needs structural integrity and deterministic keyset transport, not authorization. A user can deliberately edit a cursor to skip rows; they cannot use it to bypass access control, read another tenant, or alter stored state because the cursor is read-only and access control sits above it.

If a future threat model requires authenticated cursors, introduce a separately versioned codec and an explicit key-management contract rather than silently treating this checksum as a signature.

## Complexity and resource behavior

For `S` stories, `R` supplied recommendations, and `E` existing entries, indexing is `O(S+R+E)`. Sorting scored rows and the exploration pool is `O(S log S)` in the worst case. Hashing and version serialization are linear in the canonical input size. Pagination sorts the supplied list (`O(N log N)`) and then returns at most `pageSize` rows; production SQL uses indexes to avoid loading the complete queue for each page.

No queue retention limit exists in these algorithms. Bounded batches belong to the projection/repository caller, and a batch limit must not be confused with deleting or hiding the unprocessed remainder.

## Trade-offs

- **Exact active recommendation versus latest recommendation.** Requiring one profile/content-active record makes prompt/model selection explicit and prevents explanation drift. It also means callers must query the correct recommendation set instead of passing all history indiscriminately.
- **Deterministic exploration versus fresh surprise on every visit.** A fixed seed gives stable pages, reproducible tests, and no duplicates during continuation. A reader who wants a different exploration sequence needs a new explicit seed/rank version, not an unstable per-request random shuffle.
- **Lower-half pool versus arbitrary score exploration.** Restricting exploration preserves the intended surprise role and avoids relabeling top matches. Very small queues can therefore have no exploration even with a positive ratio.
- **Positions including hidden rows versus dense visible positions.** Hidden rank gaps make visibility changes cheap and keep one global rank version. The UI must not interpret position numbers as visible row counts.
- **Unsigned cursors versus new secret management.** Checksums are not tamper-proof, but they avoid false security and configuration expansion. Authorization and read-only query semantics make cursor modification low privilege.
- **One current projection row versus queue history.** Queue entries are mutable projections. Immutable recommendation records retain explanation history; the package does not create a second queue-event log.
- **Pure complete-set API versus incremental updates.** `rankQueue` is easiest to reason about with a complete story set. Bounded compositions must assemble batches without deleting omitted rows and must publish a rank version only when its canonical input is complete; otherwise independently computed batch hashes would fragment one logical queue.

## Testing seams

The package needs no runtime mocks. Fixed domain fixtures and `at` values drive all behavior; SHA-256 outputs and cursors can be checked against independent golden strings.

Recommended test layers are:

1. **Pure algorithm tests:** table-driven active-recommendation alignment, every state transition, exploration pool/count/merge boundaries, complete section ordering, and timestamp/field preservation.
2. **Golden compatibility tests:** exact rank versions and `q1` cursors. Expected values are checked in independently rather than generated by production serializers during the test.
3. **Metamorphic tests:** shuffle input arrays without changing output; read/state-only changes retain rank version; changing each versioned input invalidates cursors; concatenated unchanged pages equal the canonical full list.
4. **Codec fuzz/boundary tests:** mutate every cursor segment, alternate base64/JSON representations, unknown keys, invalid UTF-8, unsafe numbers, oversized input, and wrong section/position combinations. Assert typed safe errors and no partial decode.
5. **Reader-store contract tests in a composing package:** pass decoded positions directly into `QueuePageQuery.after`, run real SQLite pages, and compare against the pure paginator across section boundaries and hidden rows. The tier-1 queue package itself does not import reader-store for these tests.

A rank-algorithm release must update `QUEUE_RANK_ALGORITHM_VERSION` and golden fixtures together. A cursor release must use a new prefix and explicit decode behavior; unknown future cursor versions fail closed instead of being guessed.
