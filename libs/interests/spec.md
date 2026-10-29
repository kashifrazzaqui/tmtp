# Interests Library Spec

## Purpose and responsibility

Derive immutable, reproducible interest profiles from explicit include/exclude rules and bounded, ambiguous activity evidence. Own preference normalization, story matching, time decay, evidence aggregation, profile normalization, and profile/builder versions. Do not call an LLM, rank a queue, read a clock, access storage, or mutate activity.

The package is synchronous and pure apart from Node's deterministic SHA-256 primitive. The same complete input and builder version produce a byte-equivalent profile. All timestamps use the domain ISO-8601 UTC contract.

## Public interface / API surface

This is the complete public runtime surface:

```ts
export const INTERESTS_BUILDER_VERSION: "interests/1";
export const INTERESTS_POLICY_SCHEMA_VERSION: 1;

export interface ProfileBuild {
  rules: readonly import("@tmtp/domain").PreferenceRule[];
  activity: readonly import("@tmtp/domain").StoredActivityEvent[];
  stories: readonly import("@tmtp/domain").Story[];
  rulesVersion: string;
  activityVersion: string;
  builtAt: import("@tmtp/domain").IsoDateTime;
  reason: string;
}

export interface InterestPolicy {
  decayHalfLifeDays: number; // finite, > 0
  maxInferredTopics: number; // safe integer, >= 0
  maxActivityEvents: number; // safe integer, >= 0
}

export type InterestErrorCode =
  | "invalid-input"
  | "invalid-rule"
  | "duplicate-rule"
  | "missing-story"
  | "activity-version-mismatch";

export class InterestError extends Error {
  readonly name: "InterestError";
  readonly code: InterestErrorCode;
  readonly field?: string;
  readonly storyId?: import("@tmtp/domain").StoryId;
  constructor(code: InterestErrorCode, message: string, details?: {
    field?: string;
    storyId?: import("@tmtp/domain").StoryId;
  });
}

export function normalizePreferenceValue(
  kind: import("@tmtp/domain").PreferenceKind,
  value: string,
): string;

export function buildInterestProfile(
  input: ProfileBuild,
  policy: InterestPolicy,
): import("@tmtp/domain").InterestProfile;

export function isBlacklisted(
  story: import("@tmtp/domain").Story,
  profile: import("@tmtp/domain").InterestProfile,
): boolean;
```

Errors have no public `cause` and never include source titles, activity payloads, or complete rules in their messages. Callers use `code`, not message matching.

All functions validate runtime input rather than relying on TypeScript. Domain records are checked with their domain schemas. `ProfileBuild` and `InterestPolicy` reject unknown top-level keys. Public functions do not mutate their inputs and return fresh arrays/objects where applicable.

## Preference and interest-key normalization

### Preference values

`normalizePreferenceValue` applies the following kind-specific rules. It throws `invalid-rule` for an unsupported kind, a non-string value, an empty normalized result, or a normalized result longer than 128 UTF-16 code units.

- **`topic` and `keyword`:** apply Unicode NFKC, lowercase with JavaScript `toLowerCase()`, extract maximal Unicode letter/number sequences with `[\p{L}\p{N}]+` (`u` flag), and join tokens with one ASCII space. Punctuation and all whitespace therefore act as separators. Examples: `"  Machine,   LEARNING "` becomes `"machine learning"`; `"C++"` becomes `"c"`.
- **`author`:** apply Unicode NFKC, lowercase, collapse each run of Unicode whitespace to one ASCII space, and trim. Other punctuation is retained.
- **`domain`:** require a bare host, not a URL. Apply Unicode NFKC and lowercase, remove one trailing dot, and parse with `new URL("http://" + value)`. Reject credentials, ports, paths other than the parser's empty root, queries, fragments, and a missing/empty hostname. Return `URL.hostname`, including its canonical punycode/IP spelling. IPv6 literals must use URL bracket notation; the returned hostname includes the brackets.

Every rule passed to `buildInterestProfile` must satisfy `normalizePreferenceValue(rule.kind, rule.value) === rule.normalizedValue`. A mismatch, disabled rule with an invalid normalized value, or duplicate `(kind,effect,normalizedValue)` is rejected rather than silently repaired. Duplicate triplets throw `duplicate-rule`; other rule failures throw `invalid-rule`.

A **canonical interest key** is `kind + ":" + normalizedValue`. `WeightedInterest.topic` stores this complete key, so equally spelled `topic`, `keyword`, `author`, and `domain` interests cannot collide. For example, an inferred title token is `topic:sqlite`, and an explicit author rule can produce `author:alice`.

String ordering everywhere in this package is ascending JavaScript UTF-16 code-unit order using `<`/`>`, never locale-sensitive collation.

### Story features

For activity aggregation, derive a deduplicated set of canonical interest keys per referenced story:

1. Tokenize `story.title` with the topic/keyword normalization rule. Add each token as `topic:<token>` except stop words, tokens with no Unicode letter, and tokens longer than 128 UTF-16 code units.
2. The fixed stop-word set is: `a`, `an`, `and`, `are`, `as`, `at`, `be`, `been`, `but`, `by`, `for`, `from`, `has`, `have`, `how`, `i`, `in`, `into`, `is`, `it`, `its`, `me`, `my`, `new`, `not`, `of`, `on`, `or`, `our`, `show`, `so`, `ask`, `hn`, `that`, `the`, `this`, `to`, `was`, `we`, `what`, `when`, `where`, `which`, `who`, `why`, `will`, `with`, `you`, `your`.
3. If `story.author` normalizes to a non-empty author value, add its `author:` key. An invalid/overlong author contributes no author feature.
4. Parse both `canonicalUrl` and `url` independently as absolute HTTP(S) URLs. Add every distinct valid hostname as a `domain:` key. Invalid or non-HTTP(S) URLs contribute no domain feature; one bad URL does not hide a valid alternative.
5. For every enabled explicit `topic` or `keyword` rule, of either effect, test its normalized token sequence as a contiguous subsequence of the normalized title tokens. On a match, add that rule's canonical key even if its tokens are stop words. This shared rule lexicon lets activity strengthen or weaken multiword explicit interests without an NLP dependency.

`textHtml` and article bodies are deliberately not parsed. Deleted/dead stories retain their features because their historical activity remains valid evidence.

## Blacklist contract

`isBlacklisted` uses only enabled `exclude` rules in `profile.sourceRules`; it does not consult current repository rules or inferred weights. Rules are ORed. An enabled include rule never cancels an exclude.

- `topic` and `keyword`: the normalized rule token sequence must occur as a contiguous sequence in the normalized story-title tokens.
- `author`: the normalized rule must equal the complete normalized story author.
- `domain`: at least one valid HTTP(S) hostname from `canonicalUrl` or `url` must equal the rule host or end with `"." + ruleHost`. Thus `example.com` matches `www.example.com` but not `badexample.com`. There is no public-suffix/registrable-domain inference.

Malformed URLs fail only domain matching. Empty title/author fields simply do not match those kinds. Disabled rules, malformed profile rules, and unknown rule kinds are not ignored: the profile/schema validation rejects them. Blacklisting changes queue visibility only; it never deletes a story, activity, recommendation, or reading state.

## Activity window and decay

### Input and bounded window

`rulesVersion`, `activityVersion`, and `reason` must be non-empty strings. `builtAt` must be a valid domain timestamp. `rules`, `activity`, and `stories` must have unique rule/event/story IDs respectively; duplicate rule IDs/triplets are `duplicate-rule`, while duplicate story/activity IDs or activity sequences are `invalid-input`. Every stored activity sequence is a positive safe integer.

The activity candidate order is ascending store-assigned `sequence`. Before applying `maxActivityEvents`:

- an empty candidate list requires `activityVersion === "0"` for an empty log; a nonempty latest-log version is valid only when `maxActivityEvents === 0` and the caller supplies the empty suffix of a nonempty log;
- a non-empty list requires `activityVersion` to equal the canonical decimal string of its last event's `sequence`;
- otherwise throw `activity-version-mismatch`.

Select the last `maxActivityEvents` candidates; zero selects none. The caller may supply the complete log or a contiguous sequence-ordered suffix ending at `activityVersion`. Sequence numbers need not be contiguous integers because a failed/no-op insert may leave gaps; ordering and endpoint identity are contractual. A nonempty supplied suffix must contain the whole log or at least `maxActivityEvents` events, so either form selects the same window. `activityVersion` identifies the append head, not merely the last retained event or a timestamp/ID tuple; when zero events are selected from a nonempty log it remains the store's independent `latestVersion()`, not `"0"` or a fabricated ID. This package does not silently cap queue retention or discard stored activity.

Every selected event must have a story in `input.stories`; otherwise throw `missing-story` with `storyId`. Stories not referenced by selected events are allowed and do not themselves create interests. Events outside the selected window do not need story features.

### Evidence weights

Each selected event contributes to every feature of its story. The fixed base weights for builder `interests/1` are:

| Activity kind | Base weight | Interpretation |
|---|---:|---|
| `impression` | `0.01` | Weak exposure, not approval |
| `open` | `0.10` | Weak positive attention |
| `dwell` | `0.20` | Ambiguous positive attention |
| `scroll` | `0.10` | Ambiguous positive attention |
| `complete` | `0.50` | Stronger completion evidence |
| `skip` | `-0.15` | Weak ambiguous negative evidence |
| `dismiss` | `-0.50` | Strong local correction |
| `upvote` | `0.80` | Explicit positive action |
| `flag` | `-0.80` | Explicit negative action |
| `favorite` | `1.00` | Strong explicit positive action |

For `impression`, `open`, `dwell`, `scroll`, `complete`, `skip`, and `dismiss`, `observationQuality === "partial"` multiplies the base weight by `0.5`. `upvote`, `flag`, and `favorite` retain full weight because they record explicit actions; `source` causes no additional multiplier.

For each event and feature:

```text
ageMs = max(0, Date.parse(builtAt) - Date.parse(event.occurredAt))
decay = 2 ^ (-(ageMs / 86_400_000) / decayHalfLifeDays)
contribution = round12(baseWeight * qualityMultiplier * decay)
```

Future `occurredAt` values are clamped to zero age rather than rejected or given increasing weight. Store `sequence` is used only for window ordering/head identity; neither sequence nor `receivedAt` affects decay weight. Variable `event.value` payloads do not alter weights in builder `interests/1`; this avoids inventing dwell/scroll thresholds not present in the activity contract.

`round12(n)` is `Math.round(n * 1e12) / 1e12`, with negative zero normalized to positive zero. Sum per `(interestKey,kind)` in activity-window order and round the final sum to 12 decimal places. Each `InterestEvidence` contains the number of contributing selected events and this signed decayed sum. Evidence is retained even when its final weight is zero.

## Profile construction and normalization

1. Clone and sort `sourceRules` by `(kind,effect,normalizedValue,id)`; retain enabled and disabled rules. Set `sourceRulesSchemaVersion=1`.
2. Compile enabled rules. Each include creates its canonical interest key with evidence `{kind:"explicit-rule",count:1,weight:1}`. Each exclude removes its exact canonical key from the profile output, regardless of any include or activity evidence. Excludes also remain available to `isBlacklisted` through the source snapshot.
3. Aggregate selected activity evidence by canonical interest key and activity kind. An event with no story features contributes no interest evidence but remains part of the versioned window.
4. An **inferred candidate** is a non-explicitly-included, non-excluded key whose activity evidence sum is strictly positive. Its raw score is that sum. Negative-only and zero-total inferred keys are omitted rather than filling the topic budget with zero-weight entries.
5. Rank inferred candidates by raw score descending, then canonical key ascending. Keep at most `maxInferredTopics`. Divide each retained raw score by the largest raw score across **all** inferred candidates before truncation, so the strongest inferred interest has weight `1` and truncation does not rescale survivors. Round final weights to 12 decimals. A retained positive raw score that rounds to zero remains present with weight `0`; its raw evidence explains the inclusion.
6. Every enabled, non-excluded explicit include has final weight `1`, independent of negative or positive inferred activity. Its activity evidence remains visible alongside its explicit-rule evidence. Explicit includes do not consume `maxInferredTopics`.
7. Sort each interest's evidence by `kind` ascending. Sort final interests by weight descending, then canonical key ascending. All weights are finite and in `0..1`.

The policy snapshot is exactly:

```ts
{
  decayHalfLifeDays: policy.decayHalfLifeDays,
  maxInferredTopics: policy.maxInferredTopics,
  maxActivityEvents: policy.maxActivityEvents,
}
```

Set `policySchemaVersion=1` and `builderVersion=INTERESTS_BUILDER_VERSION`. Normalize negative zero to zero in non-negative policy fields before taking the snapshot. Compute versions and identity as SHA-256 over UTF-8 JSON, with lowercase hexadecimal digests and properties in the order shown:

```text
policyVersion = "ip1." + sha256(JSON.stringify({
  decayHalfLifeDays, maxInferredTopics, maxActivityEvents
}))

id = "profile_" + sha256(JSON.stringify({
  rulesVersion, activityVersion, policyVersion, builderVersion
}))
```

No random ID, secret, environment value, or clock read is involved. `rulesVersion` and `activityVersion` are opaque non-empty producer versions; this package does not recompute repository-owned versions. `createdAt` equals `builtAt`, and `reason` equals the supplied reason. Retry logic must query/reuse an existing profile for the four-part version key or reuse the exact build input; creating a different `createdAt`/`reason` for an already-persisted version key is an immutable conflict at the store boundary.

Any change to normalization, stop words, feature extraction, weights, decay, rounding, topic selection, or profile serialization requires a new builder version. Any policy-shape change requires a new policy schema/version.

## Error contract

| Code | Condition |
|---|---|
| `invalid-input` | Malformed policy/build fields or domain records, duplicate story/activity IDs, invalid timestamps/versions, or an invalid reason |
| `invalid-rule` | Invalid kind/value/normalized value, overlong normalization, or `normalizedValue` not equal to the canonical normalization |
| `duplicate-rule` | Repeated rule ID or `(kind,effect,normalizedValue)` in the source snapshot |
| `missing-story` | A selected activity event references no supplied story |
| `activity-version-mismatch` | Empty candidates pair a nonempty version with a nonzero activity budget, an empty log does not use `"0"`, or nonempty candidates do not end at the canonical decimal sequence `activityVersion` |

Validation stops at the first error in deterministic input order. Expected validation failures throw `InterestError`; there is no partial profile result.

## Internal subcomponents

- Preference/domain/text normalization and canonical interest keys.
- Explicit-rule compiler, story feature extractor, and blacklist matcher.
- Activity-window selection, decay, and signed evidence aggregation.
- Inferred-topic selection/weight normalization and immutable profile assembly.
- Canonical JSON/SHA-256 policy, builder, and profile versioning.

## Dependencies on other libs

- `domain`

Node's built-in `node:crypto` and URL/Text APIs are runtime primitives, not workspace dependencies. The package does not import `queue`, `recommendations`, `reader-store`, `clock`, or `config`.

## New build or OSS wrapper

New pure TypeScript implementation with no third-party runtime dependency.

## Hosted by

`personalization` and `recommendations` in `services/personal-reader`; `hn-ingestion` also uses the blacklist matcher for initial visibility.

## Configuration

- `interests.decay_half_life_days` — **optional**, default `45`; finite and greater than zero.
- `interests.max_inferred_topics` — **optional**, default `50`; non-negative safe integer. Explicit includes are additional.
- `interests.max_activity_events` — **optional**, default `5000`; non-negative safe integer. Processing window, never queue/activity retention.

No evidence-weight, stop-word, seed, secret, or version key is configurable. Those changes belong to a new builder version.

## Acceptance-focused test expectations

### Normalization and blacklists

- Pin golden normalization cases for Unicode NFKC, case, punctuation, whitespace, multiword phrases, punycode, trailing dots, IPv4/IPv6, invalid hosts, empty values, and overlong values. Verify every rule's `normalizedValue` is enforced.
- Verify title phrase boundaries, stop-word-only explicit rules, exact authors, canonical/alternate URLs, domain/subdomain matching, `badexample.com` rejection, malformed URLs, disabled rules, and include/exclude overlap.
- Verify excludes remove matching profile keys and blacklist stories without mutating story, activity, or profile inputs.

### Activity and profiles

- Use fixed timestamps to verify the exact decay formula at zero, one half-life, multiple half-lives, and future occurrence times. Cover every base weight and partial-observation multiplier.
- Verify candidate ordering by sequence including timestamp ties/backward clocks and ID inversions, exact decimal activity-version checks, newest-N selection, zero event/topic budgets, suffix equivalence across sequence gaps, missing stories, duplicate IDs/sequences, and events with no features.
- Verify signed evidence counts/sums, negative-only omission, explicit-include weight pinning, exclude precedence, deterministic tie-breaking, raw-score normalization before truncation, 12-decimal rounding, and no negative zero.
- Assert byte-equivalent profiles across input permutations that have the same canonical rule/activity/story meaning, and assert exact golden policy versions and profile IDs. Verify different policy or builder versions produce different identities.
- Verify the complete profile satisfies the domain schema and retains the exact source-rule snapshot, policy snapshot, versions, reason, and `builtAt`.

### Workflow acceptance

- For WF-06, demonstrate that include/exclude changes are reproducible, blacklist changes do not rewrite history, and dwell/skip evidence remains weighted and ambiguous rather than becoming an absolute preference statement.
- For downstream queue tests, supply blacklist results for ordinary, blacklisted, deleted/dead, and malformed-URL stories and verify no blacklist decision depends on exploration or LLM output.
