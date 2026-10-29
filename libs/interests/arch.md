# Interests Library Architecture

## Internal structure

The package is a small deterministic pipeline, not a service or a collection of repositories:

- `validation`: runtime boundary checks, safe `InterestError` mapping, domain-schema parsing, and input indexing.
- `normalize`: Unicode text normalization, title tokenization, author normalization, URL hostname extraction, and canonical interest keys.
- `rules`: validated source snapshots, enabled-rule compilation, the explicit topic/keyword lexicon, and blacklist matching.
- `features`: per-story intrinsic features plus matches from the explicit rule lexicon.
- `evidence`: activity ordering/windowing, decay, observation-quality multipliers, and per-key/per-kind aggregation.
- `profile`: exclude/include precedence, inferred-topic selection, final weight normalization, evidence sorting, and domain-record assembly.
- `version`: fixed-order JSON serialization and SHA-256 policy/profile identities.

`buildInterestProfile` and `isBlacklisted` share the same rule compiler and story matcher. Queue code does not duplicate either algorithm: a caller that also depends on `interests` computes blacklist story IDs and passes them to `queue`, preserving the one-way dependency graph.

## Processing pipeline

A profile build has five stages:

1. **Validate and index.** Parse domain records, canonicalize rule order, index stories by ID, and reject duplicate logical records before any arithmetic.
2. **Compile and extract.** Compile enabled rules once. Extract/cache features only for stories referenced by the selected activity window. The same compiled topic/keyword rules drive features and blacklist phrase matching.
3. **Select evidence.** Sort candidates by store-assigned `sequence`, verify the canonical decimal `activityVersion` endpoint, and retain the newest policy-bounded suffix. Timestamp ties/backward clocks and random event IDs cannot change append order. Each retained event contributes a fixed, decayed weight to every feature of its story.
4. **Reduce and normalize.** Aggregate signed evidence in canonical activity order. Apply exact-key excludes, pin explicit includes, select positive inferred candidates, and normalize retained weights without letting truncation rescale them.
5. **Version and emit.** Snapshot policy/rules, calculate SHA-256 versions/identity, sort output arrays, and return a fresh immutable-by-convention domain profile.

The blacklist path is intentionally cheaper: validate the story/profile, compile enabled excludes, and stop on the first match. It does not build features for unrelated stories or aggregate activity.

## Algorithms and invariants

### Canonical ordering and numeric behavior

All sorting uses explicit comparators and story/rule/event IDs as tie-breakers. No `localeCompare`, object-key iteration, insertion order, wall clock, or random number affects a profile. Event contributions are rounded before ordered summation and totals/final weights are rounded again. This gives stable golden values and prevents tiny floating-point tails from leaking into prompts or hashes.

The profile ID hashes the repository-supplied source versions, not a JSON serialization of the complete activity log. This keeps identity computation bounded. Correctness therefore depends on the store's contract: `rulesVersion` and `activityVersion` must uniquely identify their source snapshots. A strictly increasing insertion sequence advances for every novel event even when receipt time or random ID order does not. The builder validates the activity version's endpoint but cannot prove a repository version's completeness.

### Shared lexical model

Title tokens are the only general inferred topics. Explicit topic/keyword rules act as a small phrase lexicon, while authors and URL hosts supply separate namespaced features. Namespacing prevents a person name, hostname, and title word with the same spelling from being merged accidentally.

This is deliberately deterministic lexical evidence, not topic classification. The recommendation layer may use the resulting evidence in a prompt, but `interests` never asks an LLM to invent topics or decide whether an observation is a like.

### Explicit precedence

There are two different precedence rules:

- An exclude vetoes its exact interest key and can blacklist whole stories through story matching.
- An include pins its interest's final normalized weight to `1`; activity evidence remains attached for explanation but cannot remove that explicit interest.

Inferred negative evidence can suppress an inferred key, but cannot silently override either explicit rule. `maxInferredTopics` bounds only inferred entries so a large rule set cannot be truncated by activity noise.

### Bounded work

Let `R` be the rule count, `A` the supplied activity count, `W` the retained window size, and `F` the average features per referenced story. Sorting/window validation costs `O(A log A)` over the supplied candidates. Feature extraction and aggregation cost approximately `O(R + W * F)` after per-story caching; lexical phrase checks add the rule-lexicon cost for referenced titles. Output is bounded by explicit-include count plus `maxInferredTopics`, with evidence bounded by activity-kind count per key.

`maxActivityEvents` bounds arithmetic, not the cost of sorting an unbounded caller-supplied array. Compositions should supply the documented contiguous suffix when the log is large.

## Design trade-offs

- **Lexical determinism versus semantic coverage.** Title-only extraction misses topics expressed only in article bodies and can treat ambiguous words literally. Adding HTML/NLP extraction would add dependencies, larger prompts, and new versioning concerns; it belongs to a later builder version with measured fixtures.
- **Fixed evidence weights versus tunable policy.** The three existing configuration keys remain the complete policy. Weights, stop words, and quality factors change only with `builderVersion`, keeping old profiles reproducible and avoiding unversioned configuration drift.
- **Signed evidence versus non-negative profile weights.** Negative evidence is preserved for explanation and suppression, while `WeightedInterest` honors the domain's non-negative weight contract. This loses no evidence but means final weight alone is not a complete explanation.
- **Hash-derived identity versus random IDs.** Deterministic IDs make retries safe and tests exact. The repository must still detect conflicting content for an existing four-part version key; a hash is not permission to overwrite an immutable profile.
- **Build timestamp versus version identity.** `createdAt=builtAt` records when a build happened but is outside the profile identity. Callers must return an already-persisted matching version or reuse the exact build input rather than inserting a changed timestamp under the same version key.
- **Unicode runtime rules.** NFKC, lowercase mapping, URL canonicalization, and Unicode property escapes use the pinned Node runtime. A runtime upgrade that changes these results must be covered by golden tests and treated as a builder compatibility change if output changes.
- **No hidden HTML parsing.** `textHtml` is not regex-stripped. Avoiding a fake HTML parser prevents markup and entities from becoming evidence; integrating the real extracted article later is cleaner and more explicit.

## Testing seams

The public functions are sufficient for nearly all tests; no storage, network, LLM, or clock mock is needed. Supply `builtAt` directly and use small domain-valid fixtures. Internal module boundaries keep normalization, matching, and aggregation separately reviewable without making them public API.

Test layers are:

1. **Golden unit vectors:** exact normalized values, interest keys, decay contributions, evidence totals, weights, policy versions, profile IDs, and output ordering.
2. **Table-driven boundaries:** invalid records/rules, duplicates, missing stories, version mismatches, empty/zero budgets, future events, malformed URLs, and safe error codes/messages.
3. **Property/metamorphic checks:** meaningful input permutations produce byte-equivalent output; adding older events outside the window leaves output unchanged; increasing `maxActivityEvents` never changes which newer events are selected; blacklisting never mutates history.
4. **Cross-package contract fixtures:** one fixed story/profile fixture shared by interests and queue tests verifies the exact blacklist ID set passed to ranking. Reader-store integration tests separately verify that a requested activity suffix and persisted profile satisfy these pure contracts.

Golden files must be reviewed when a builder version changes. Tests must not recalculate expected hashes with the same serialization helper used by the implementation; independent expected strings are required to catch accidental algorithm/version drift.
