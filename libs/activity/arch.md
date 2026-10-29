# Activity Library Architecture

## Design goal and boundary

Implement `spec.md` as a deterministic, synchronous tier-1 package. Keep untrusted-input parsing, replay classification, event normalization, and session projection separate. The only workspace dependencies are `@tmtp/clock` and `@tmtp/domain`; persistence and job enqueueing remain in `personalization` through `reader-store`.

No module opens a database, generates random IDs, reads global time, performs network I/O, or keeps module-level reducer state. Deterministic IDs come from validated client identities. All policy arrives as arguments.

## Internal decomposition

Private modules can follow the data flow without becoming public subpaths:

- **Raw parser:** strict object/kind/source/value validation, single-story checks, and defensive copies.
- **Policy and projection guards:** policy ordering, previous-session invariants, and replay-record validation.
- **Replay classifier:** duplicate maps, logical-content comparison, and conflict detection.
- **Event factory:** deterministic IDs, one receipt timestamp, quality mapping, and canonical event ordering.
- **Session reducer:** ordered starter/closer transitions, dwell/scroll accumulation, gap abandonment, and result collection.
- **Public entry:** exports only the parser, reducer, error, and types.

The stages are pure. An implementation may combine files, but it should not merge replay classification with dwell accumulation; that is the easiest way to double-count a retry.

## Processing pipeline

The reducer executes these stages in order:

```text
validate policy and previous session
→ validate replay records
→ parse raw batch and detect in-batch conflicts
→ classify persisted/in-batch replays
→ read receipt time if any novel row exists
→ validate novel occurrence times and create sorted events
→ reduce novel session observations in canonical order
→ return fresh novel events and every affected session
```

No output escapes when a later stage throws. Build new arrays and clone the working session rather than mutating arguments. Validation may inspect original input, but all returned values are independent objects.

Parsing is also public so the composition can reject malformed input before using client IDs as database parameters. The reducer deliberately reuses the same parser rather than maintaining a second validation path.

## Identity and replay algorithm

### Deterministic IDs

Validate the 43-character base64url client ID, then derive:

```text
event ID       = "evt_" + clientEventId
new session ID = "ses_" + starterClientEventId
```

There is no hash or random generator in this package. A one-to-one prefix mapping avoids collisions between distinct client IDs. Browser/client producers generate 32 random bytes once and retain them for retries. A trusted server composition can instead hash a versioned, namespaced, durable logical key with SHA-256; this is appropriate for an HN intent or reconciliation observation whose retry identity must survive process restart. A session remains identifiable from its starter on a full rebuild or a retry that no longer has the prior projection.

### Logical comparison

Build a map from `clientEventId` to the supplied stored event. Validate its positive sequence as persistence metadata but never compare that sequence for logical idempotency. Build a second map while parsing the batch to detect conflicting in-batch duplicates. Compare fields explicitly by kind; do not use generic `JSON.stringify` equality, which would make object-key order, sequence, and future fields part of idempotency accidentally.

For normal events compare deterministic ID, story, kind, source, value/version, expected quality, and client occurrence. Ignore receipt. For reconciliation compare the same stable content but no occurrence/receipt timestamps; separately require the stored reconciliation event's occurrence and receipt to be equal.

Classification has three outcomes:

- **Novel:** no persisted or earlier in-batch identity exists; emit and reduce it.
- **Exact replay:** stable content matches; count it as input but emit/reduce nothing.
- **Conflict:** identity matches but stable content differs; throw before reduction.

The first occurrence of an in-batch identity is the candidate novel row. Later exact copies are replays. If a persisted record exists, every matching input row is a replay. Consequently `batch.length - novelEvents.length` exactly counts discarded duplicate rows.

This design needs only the latest session plus existing events for the incoming IDs. It does not need the full event history for ordinary incremental ingestion.

## Event normalization

Read `clock.now()` once for a nonempty novel set and convert it to the domain timestamp representation. Do not read wall time for an empty or replay-only batch. The same receipt goes on all novel events, making receipt-time ordering within a batch deterministic through event ID tie-breaking.

Sort novel events by epoch occurrence and then client ID. This total order is independent of input array order. Non-reconciliation client timestamps later than receipt are rejected rather than clamped. Reconciliation timestamps are assigned only at this stage, which prevents a caller from supplying a fabricated historical action time.

Quality mapping is a total function of source. It does not infer credibility from dwell, scroll, or value content. HN `present=false` reconciliation remains evidence about current state; it is not converted into an invented `unupvote` kind.

## Session reduction algorithm

### Working state

Keep at most one active working session and an output array. The latest previous session may be active or terminal. Process only the five session kinds; all other novel events bypass this stage.

Before applying each session observation, compare its `(occurredAt, clientEventId)` tuple with the last processed tuple, initialized from `(previousSession.updatedAt, previousSession.lastClientEventId)` when a previous session exists. Require a strict increase. This gives chunked and whole-history reductions the same order and rejects an out-of-order heartbeat whose dwell cannot be inserted correctly into an already-closed/gapped projection.

### Start, update, and close

When no active working session exists:

- `open`, `dwell`, and `scroll` allocate a new deterministic session and apply themselves;
- `complete` and `skip` allocate a new deterministic session and immediately close it at the same occurrence with zero dwell/scroll;
- a terminal previous session is left unchanged, and every current session observation advances the new session's position.

For an active working session, first calculate the occurrence gap. Beyond the configured limit, clone it as abandoned with its end at its last observed update and append that clone to the output. Then treat the current event as described for no active session.

Inside the limit, apply exactly one transition:

| Event | Accumulators | State/metadata |
|---|---|---|
| `open` | unchanged | update occurrence/client position |
| `dwell` | add thresholded, capped contribution | update occurrence/client position |
| `scroll` | maximum of old/new ratio | update occurrence/client position |
| `complete` | unchanged | complete with end at occurrence |
| `skip` | unchanged | abandon with end at occurrence |

For dwell, check `oldDwell + contribution <= Number.MAX_SAFE_INTEGER` before assignment. A short dwell below the threshold still updates the session's last position because it is a real observation; only its dwell contribution is zero.

Quality is a sticky minimum, not an average. A partial contributing event makes the session partial forever. Gap abandonment preserves quality and accumulators. Terminal sessions are never reopened; any later session observation gets a new ID. Giving an orphan `complete`/`skip` its own zero-length terminal session is necessary for rebuild equivalence: otherwise that event would not advance any persisted ordering position and a delayed older dwell could be accepted in incremental mode but ordered before the closer in a rebuild.

Append a terminal working session when it closes. Append the final active working session at the end if any novel session event touched it. Deduplicate output by session ID by construction, not by a last-write-wins map that could hide a reducer bug. The output order is safe for sequential repository upserts.

### Rebuild property

A rebuild starts with no previous session and an empty replay set. Convert persisted events for one story back to raw observations, dropping the occurrence field from reconciliation rows, and supply them in canonical order with the same policy. Set the injected fixed clock to the maximum stored `receivedAt` in that input. This preserves the original occurrence/receipt invariant even when the real wall clock has moved backward; using current wall time could incorrectly reject historical events during a projection-only rebuild.

Keep only the rebuilt session outputs and never append regenerated events as new history. Chunk boundaries do not change sessions because the previous session carries the last occurrence/client position and all accumulators, and every session kind advances that position. Receipt time does not otherwise influence sessions. Changing policy or reducer versions can legitimately produce a different projection; immutable events, not sessions, are the historical evidence.

Empty event history needs no clock and produces empty event/session arrays.

## Atomic store composition

`personalization` owns the only stateful orchestration:

1. Parse outside storage.
2. In one synchronous shared-connection transaction, fetch matching replay rows and the latest story session.
3. Reduce synchronously.
4. Append novel events with store-assigned increasing sequences and require the inserted count to equal the novel count. A short insert means the replay read was incomplete; throw before session/job writes and roll back. Otherwise upsert all result sessions in order and enqueue profile work if novel events exist using the post-append sequence head.
5. Return from the transaction to commit; propagate any error to roll back.

There is no reason for this package to import a store interface for that sequence. Keeping it in the higher composition also avoids a dependency from activity to database or job-queue. The store's unique constraints remain defense in depth.

On one Node process and one synchronous SQLite writer, the transaction body cannot interleave with another activity body. This is the concurrency mechanism. An active-only session lookup cannot implement `reader-store.latestForStory`: after completion or abandonment, the latest terminal session by `(updatedAt,id)` is still needed for ordering and new-session behavior. A bulk replay lookup is an optimization; one indexed query per distinct incoming ID is correct within the bounded request batch.

## Trade-offs

- **Strict client identity shape:** deterministic IDs and bounded inputs are simple, but producers must use retained CSPRNG bytes or stable namespaced SHA-256 keys rather than arbitrary strings, counters, or fresh randomness on retry.
- **Derived rather than freshly random internal IDs:** retries and rebuilds are deterministic, while collision resistance depends on the producer's CSPRNG or hash derivation. The parser checks shape, not provenance.
- **Replay set supplied by caller:** the reducer stays storage-independent, but composition must perform complete lookups in the write transaction. Omitting an existing row is caught only at the storage backstop.
- **Logical replay excludes receipt:** a retry can receive a new server timestamp without becoming a conflict. Direct repository byte-for-byte comparisons must not be substituted for this owning-library comparison.
- **One story per batch:** a single latest-session input and one transaction are unambiguous. Consumers reject mixed-story requests rather than committing per-story partitions independently; clients send separate batches.
- **Strict session ordering:** projection math stays rebuildable, but delayed older heartbeats are rejected rather than silently merged. Clients should send per-story observations in order and retry only unresolved batches.
- **No future-skew allowance:** server time remains authoritative and validation is simple, but a client with a fast clock can have observations rejected. Adding tolerance would require an explicit policy key and is not hidden here.
- **Client-measured active time with server caps:** the reducer cannot observe browser visibility itself. Capping bounds damage from inactive spans but cannot prove that reported active time is truthful.
- **Lazy abandonment:** no timer or sweeper is needed, but an old active row remains active until a later session observation or rebuild classifies it.
- **Multiple result sessions:** the API is slightly more complex than one optional session, but arbitrary gap-rich batches no longer lose intermediate projections.
- **Zero-length terminal sessions:** an orphan completion/skip creates a projection even without a preceding open. This records a real observation and preserves the ordering high-watermark, at the cost of sessions whose start and end are identical.
- **Policy-version-free session rows:** current policy can rebuild projections differently after an operator change. Events retain the immutable evidence; profiles version their activity input separately.
- **Single-writer concurrency:** synchronous transactions are small and reliable in the target topology. Multi-process support would need stored session versions and atomic replay claims.

## Testing seams and verification design

### Pure public suites

- Table-drive raw fixtures by kind/source/value and include unknown keys, non-finite numbers, unsafe integers, malformed timestamps, and duplicate conflicts.
- Use fixed valid client IDs with controlled lexicographic order to test equal-time ordering without relying on random generation.
- Use `createFixedClock` to pin receipt and future validation. A counting clock wrapper proves replay-only calls do not read time.
- Build previous sessions and stored replay events with positive sequences as domain-shaped fixtures; mutate returned objects afterward to prove inputs and outputs do not alias and sequence does not affect replay identity.
- Compare chunked reduction with whole-history reduction across starts, completion, skips, multiple gaps, partial quality, and equal-time events.
- Test safe-integer dwell overflow at the exact boundary and assert no partial result.
- Assert `batchIndex` and fixed messages for expected errors, and scan serialized errors for value/client-ID sentinels.

No private reducer hooks, random source, global fake timer, or mock database is needed for the pure suites.

### Composition suites

The activity package must not import `reader-store` just to test itself. In the later personalization/store suite, use real SQLite and a fixed clock to test full and partial retries, terminal-session continuation, rollback across events/sessions/jobs, and two same-batch commands invoked concurrently. Assert public activity/session projections and job state, not private SQL helpers. Include a terminal latest session to prevent an active-only repository fake from masking the lookup mismatch.
