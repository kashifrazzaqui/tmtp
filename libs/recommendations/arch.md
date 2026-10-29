# Recommendations Architecture

## Architectural role

Implement `spec.md` as a tier-2 deterministic judgment and queue-composition library. Keep provider access behind `@tmtp/llm-interface`, keep storage above the package, and make prompt/version/audit behavior explicit enough that personalization can persist an exact explanation for every score and every failed call.

The package has two independent entry paths:

```text
scoreStories: validated records -> work plan -> sequential LlmRequests
              -> validated judgments + complete audits + safe failures

buildQueue:   complete stories/articles + selected recommendations + blacklist IDs + at
              -> queue.rankQueue -> complete queue projection
```

`scoreStories` does not call `buildQueue`, and neither path opens a transaction. Personalization composes them only after external calls have finished.

## Internal decomposition

These modules are private organizational units, not public subpaths:

| Module | Owns | Must not contain |
|---|---|---|
| `validation` | Strict option/policy/domain checks, unique indexes, safe field errors | Provider or storage I/O |
| `projection` | Version-1 enabled-rule/profile/story/article projections and deterministic ordering | Raw API envelopes, credentials, volatile score fields |
| `truncate` | Unicode code-point limits and exact versioned suffix/flags | Implicit profile/title truncation |
| `canonical-json` | Recursive UTF-16 key ordering and whitespace-free JSON for size/golden fixtures | A second request hash or provider call |
| `prompt` | Exact instructions, input/schema construction, wire-equivalent size calculation | Unversioned prompt edits |
| `plan` | Story-ID selection, prefix fitting, frozen batch requests/parsers | Random work selection, queue retention |
| `judgment-schema` | Parameterized JSON Schema and matching strict Zod parser | Markdown repair, partial batch acceptance |
| `evidence` | Exact story/rule/activity provenance checks | Invented source IDs, exploration evidence |
| `execute` | Sequential generate calls, caller-signal checkpoints, completion state | Additional retry/timeout loop |
| `audits` | Ordered result/error attempt collection and contract checks | Audit rewriting, persistence timestamps, SQL |
| `recommendations` | Deterministic SHA-256 IDs, domain records, final-success call links | Random IDs, hidden clock reads |
| `failures` | Safe category/code/retryability projections | Provider/parser/prompt text |
| `queue-composition` | One exact `rankQueue` call with all required inputs | Blacklist reimplementation, storage writes |
| `index` | Exact public constants, error class, functions, and types | Internal prompt/test helpers |

One version module owns the four public version constants and private instructions/truncation limits. Prompt changes cannot be reviewed independently of their version bump and golden fixtures.

## Work-plan design

Validation indexes every supplied story and article before provider work. Sorting stories by ID makes both the `maxStoriesPerRun` boundary and later batch composition independent of repository array order. The caller remains responsible for querying only stories that need the exact `(profile,storyContent,articleContent,prompt,model)` key; the pure library does not guess repository freshness.

A planned batch contains detached input/schema values, exact instructions, a parser closed over the expected story/profile projections, and the calculated prompt size. Building the full plan first has three benefits:

1. invalid input and oversized single-story requests are known before any external call;
2. every later execution step uses frozen values rather than caller-mutated objects;
3. cancellation between batches leaves a clear set of unattempted stories with no fabricated failures.

Prefix fitting changes only the number of stories in a request. It never drops an interest/rule, cuts a title, or alters the output contract to fit. Article/story text uses only its separately versioned code-point truncation rule. If fixed profile/schema overhead makes one story too large, that story receives an explicit local failure and zero audits.

### Prompt-size ownership

The current logical size calculation mirrors the OpenAI-compatible adapter's two-message user-content composition. This deliberately makes `max_prompt_chars` meaningful for the configured adapter rather than merely estimating article length. It is not a token estimate and makes no claim about provider tokenizer behavior.

Canonical JSON is needed for exact size and stable golden strings. The LLM adapter independently canonicalizes the same validated input/schema for its wire mapping and request hash. Keeping these implementations separate preserves tier boundaries; shared golden fixtures must detect drift instead of importing the adapter upward.

## Projection and prompt-injection containment

Projection uses explicit field lists and null-for-absence values so no `undefined` property reaches the LLM request validator. Enabled rules and interests are copied in canonical order. Disabled rules, raw policy, raw HN envelopes, queue state, HN popularity, and error strings never enter accidentally through object spread.

Only ready article content is eligible for a prompt. Pending/failed records retain status but cannot leak stale text. Article and story bodies remain JSON strings throughout planning and transport. There is no HTML execution, rendering, sanitization, link following, tool invocation, or model-directed retrieval in this package.

The instructions establish that input values are data, but prompt instructions are not treated as a security boundary against a hostile model. The real boundary is narrow output acceptance: one strict object, exact story IDs, bounded strings/evidence, no tools, no subsequent actions, and plain-text handling by consumers.

## Structured judgment pipeline

Each batch's schema is object-rooted for the current adapter's JSON-object mode. The parser is the semantic boundary after the adapter validates the outer provider response and parses `message.content` JSON.

The acceptance sequence is:

1. Strict Zod shape/type/range checks, including unknown-key rejection.
2. Exact batch cardinality and story-ID set checks.
3. String/finite-number and negative-zero normalization checks.
4. Evidence provenance checks against the frozen profile/story projections.
5. Return internal validated judgments without constructing persistence records.

Any rejection throws a private empty/safe sentinel. The concrete adapter converts it to `invalid-output`/`output-rejected` and preserves the attempt audit. No model text is included in that sentinel. Because the whole batch is rejected together, the consumer never mistakes a valid-looking subset for complete coverage or links a judgment to an output whose other stories were invalid.

Evidence checks constrain pointers, not truth. They prevent a rationale from citing a nonexistent rule/topic/article, but cannot prove the model's semantic reasoning. The immutable prompt hash, response audit, and concise rationale remain necessary for review.

## Execution, cancellation, and audit flow

One run owns only local state:

```text
remaining planned batches
recommendations so far
failures so far
attempts so far
completion = complete | cancelled
```

Before each `generate`, observe the caller signal. Pass the identical signal in the request; do not create an overall timer or substitute the adapter's per-attempt timeout. The adapter may perform multiple audited attempts before resolving/rejecting one batch.

### Success path

Append every result attempt before validating the final success linkage. Require a nonempty history ending in `success`. For each validated judgment, link the domain recommendation to that final attempt's `callId`. Earlier attempts remain in the same ordered batch audit stream. If cancellation is visible after this settlement, retain the already valid result and stop before another batch.

### Expected error path

A structural `LlmError` guard recognizes the interface without requiring a runtime class. Append `error.attempts` exactly once and project only its safe category/code/retryable fields to each story failure. Cancellation stops the plan; other expected failures do not trigger a local retry and do not prevent different later stories from being attempted.

Between-attempt cancellation is already represented correctly by the adapter: the error is cancelled while earlier audits retain their actual outcomes. This package must not rewrite those audits to make the final status match, and must not add a synthetic cancelled call when `attempts` is empty or ends with an earlier provider failure.

### Contract-violation path

A non-`LlmError` throw or malformed success/error shape rejects `scoreStories` with safe `RecommendationError("llm-contract")`. Its `attempts` contains every audit observed up to and including any readable result attempts. The package does not return a normal completed batch after the port contract has failed. Conforming adapters should make this path unreachable; tests still verify that already observed audits survive it.

Returned attempt arrays are new per run and per batch result concatenation. The package never annotates an audit with a story ID, timestamp, or recommendation ID because doing so would mutate the adapter's per-attempt snapshot and could incorrectly duplicate one batched call across stories. Personalization persists each audit once, then links many recommendations to the same final call when appropriate.

## Deterministic record identity

Recommendation assembly is pure once a judgment and final call ID exist. SHA-256 covers the fixed-order domain uniqueness fields plus an explicit ID-algorithm version. `createdAt=at` is deliberately outside the digest, as are score/rationale/evidence/call ID. This matches repository idempotency rules: an exact retry has one logical ID, while changed content under an existing key is an immutable conflict rather than an overwrite.

The model string is part of both request and identity. Prompt version covers all instructions/projection/output/acceptance changes. Story content version comes from the story rather than being recomputed here, avoiding a second incompatible definition of story freshness.

### Article-version boundary

`domain.articleContentVersion` is the single freshness rule shared by this package, queue, and reader-store. Recommendation identity includes that version alongside story/profile/prompt/model. Ready metadata, content hash, and extractor version therefore invalidate stale judgments together; pending/failed status changes also version the prompt's article-status input without incorporating stale text or error messages. The package calls the domain helper rather than maintaining a second hash rule.

## Queue composition boundary

`buildQueue` exists to keep ranking delegation exact, not to create a second ranking algorithm. It translates `RecommendationPolicy.explorationRatio` and forwards the complete required input set, including the previously omitted blacklist IDs and timestamp. `existingEntries` and the optional seed remain explicit so reading history and deterministic exploration retain upstream semantics.

Blacklist computation stays outside `queue` and outside `buildQueue`: personalization already depends on both `interests` and `queue`, and this package's API requires the resulting ID set. This avoids silently using a different profile/story snapshot. `rankQueue` remains the sole owner of exploration hashes, active recommendation alignment, rank versions, and reading timestamps.

Failure text has a separate store path. The composition can call `markEvaluation` with safe failure detail and supply those failed existing entries to `buildQueue`; the pure scoring API does not secretly write `lastError` or add a queue input that upstream does not define.

## Concurrency and resource model

Sequential batches bound one run to one outstanding `generate` call. This makes audit order, cancellation checkpoints, and prompt-memory limits straightforward. Provider retries can extend wall time beyond one timeout because they are per attempt; the caller's signal is the overall cancellation budget.

Independent runs have no shared mutable module state. They can safely interleave parser callbacks and provider responses. Their deterministic IDs may coincide when inputs coincide, which is desirable idempotency but requires upper-layer writer deduplication or immutable conflict handling. No in-package global lock would solve multi-process/storage coordination and none is attempted.

For `S` supplied stories, planning sorts once in `O(S log S)` and serializes candidate prefixes. Naive repeated prefix serialization can add batch-planning cost; `batchSize` bounds each candidate, while `maxStoriesPerRun` bounds selected work. Queue ranking retains `queue`'s documented complexity and complete-set memory requirements. No scoring cap is reused as a queue cap.

## Design trade-offs

- **Strict whole-batch output versus partial salvage.** Rejecting a batch when one judgment is missing/invalid repeats more work later, but prevents mixed-quality output and ambiguous missing-story states. A later partial-output contract would need per-story acceptance and audit semantics in a new prompt version.
- **Sequential requests versus provider throughput.** Sequential batches reduce burst load and make cancellation/audit order exact. Explicit concurrency can be added later as policy without changing deterministic IDs, but attempt ordering and rate-limit behavior would need a new contract.
- **Exact prompt characters versus token limits.** UTF-16 length is deterministic and provider-neutral but not a tokenizer measure. It is a safety/work bound, not a cost guarantee.
- **Versioned truncation versus unlimited article input.** Bounded text controls prompt size and cost but can omit decisive late-article evidence. Content hashes and truncation flags keep that loss visible in captured requests; changing allocation requires a new prompt version.
- **Evidence pointer checks versus free-form explanations.** Provenance rules reject some plausible rationales, but stop fabricated source references from being presented as structured evidence. Semantic correctness still requires evaluation.
- **Deterministic IDs versus content-addressed entire records.** Hashing only the domain key supports exact-key retries but assumes immutable generation inputs are fully versioned. The article-version contract shows why that assumption must be audited whenever projections change.
- **Returned partial cancellation versus thrown cancellation.** A cancelled batch result lets personalization persist successful work and every audit before ending the job. The explicit `completion` flag prevents treating it as a complete recovery run.
- **No storage dependency versus durable exactly-once claims.** The package can guarantee deterministic records and complete returned audits, not transactional persistence. Personalization/store integration must prove the durable boundary separately.

## Testing seams and verification design

The public API and a scripted `LlmPort` are sufficient for consumer tests. The fake journals request object identity/content, invokes captured parsers with structured JSON, returns prepared multi-attempt results, rejects interface-shaped errors, and supports deferred settlement for abort races. It records every `generate` call so pre-abort, between-batch abort, and post-error no-retry tests can assert exact cardinality.

Golden tests independently pin:

- exact instructions and version constants;
- canonical input/schema JSON and measured prompt sizes;
- Unicode truncation boundaries, including surrogate pairs;
- deterministic recommendation IDs from fixed domain keys;
- complete request projections with volatile/secret sentinels excluded;
- successful final-call linkage after earlier failed attempts.

Table-driven parser fixtures cover every unknown key/type/range/cardinality/provenance violation. Audit fixtures cover all `LlmError` categories, empty attempts, retries before success, between-attempt cancellation, and capture on/off. Assertions compare complete returned arrays to ensure no attempt is dropped, duplicated, rewritten, or given a fabricated timestamp.

Queue tests compare `buildQueue` output with direct `rankQueue` output for the same expected input. Include blacklisted, pending, failed, deleted/dead, and existing read entries plus explicit `at` and exploration seed. Manifest/import checks prove no storage, clock, SDK, or concrete adapter dependency appears.

Later personalization integration tests must use real store transactions to persist all returned audits once, map them to domain records with composition-owned timestamps, insert judgments immutably, and mark evaluation/queue state. Those tests belong above this package; a fake repository inside `recommendations` would violate its dependency boundary and would not prove durability.
