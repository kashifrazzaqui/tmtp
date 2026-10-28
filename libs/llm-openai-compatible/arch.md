# OpenAI-Compatible LLM Adapter Architecture

## Architectural role

`llm-openai-compatible` is a tier-1 infrastructure adapter between the type-only `LlmPort` and one OpenAI-compatible Chat Completions endpoint. It contains all provider, retry, hashing, and audit behavior needed to make the port real while exposing only `createOpenAiCompatibleLlm`.

The design gives audit truth priority over SDK convenience: one SDK invocation equals one provider attempt and one audit. SDK-native retries are disabled, raw SDK values stay behind the normalization boundary, and recommendation logic remains unaware of this package.

## Internal module decomposition

These are package-internal modules, not public entry points or new workspace libraries.

| Module | Owns | Must not contain |
|---|---|---|
| `index` | Exact factory export, option snapshot, SDK client construction, returned `LlmPort` | Public SDK types, generation policy constants duplicated from other modules |
| `options` | Factory validation and immutable scalar settings | Secret-file reads, centralized config, payload capture decisions |
| `json-value` | Recursive request JSON/schema validation and detached plain-JSON snapshots | `parseOutput`, provider response acceptance, JSON Schema judgment validation |
| `request` | Pre-abort/validation order, object-root mapping check, per-operation request snapshot | SDK calls, attempt state |
| `canonical-json` | UTF-16 key sorting and whitespace-free deterministic JSON serialization | Provider body construction, hashing, Unicode normalization |
| `projection` | Exact six-field version-1 request projection, SHA-256, captured request snapshot | Credentials, endpoint/retry/timeout settings, response payloads |
| `chat-request` | Exact two-message JSON-mode body and `max_completion_tokens` mapping | Prompt projection, recommendation policy, strict-schema conversion |
| `sdk-transport` | Narrow `chat.completions.create(...).withResponse()` seam, per-call timeout/signal/zero retries | Retry loops, parser callbacks, audit arrays |
| `attempt` | Fresh call ID, linked caller/deadline controller, monotonic latency, one provider outcome, usage/request-ID extraction | Other attempts, backoff delay, persistence |
| `response` | Successful outer decoded-body snapshot, deterministic choice/content checks, direct `JSON.parse`, single `parseOutput` call | Markdown repair, multiple-choice selection, API-error payload fabrication |
| `retry` | Sequential budget, transient classification, header/exponential delay, abortable sleep and cancellation checkpoints | Duplicate HTTP calls inside the SDK, request mutation, overall-deadline claims |
| `audit` | Per-attempt status/error/usage/payload assembly and immutable result history | SQL/domain records, diagnostics projections, timestamps for storage |
| `errors` | Internal `LlmError` construction and fixed safe code/message mapping | Raw provider/parser messages, secret-bearing causes, consumer retry loops |

`index` composes the pipeline but does not make internal seams public. `json-value`, `canonical-json`, and `projection` have one implementation each so request capture, wire content, and hashes cannot drift into separate canonicalization rules.

## Control and data flow

```text
LlmRequest<T>
  -> pre-abort check
  -> runtime validation and detached request snapshot
  -> six-field projection + canonical JSON + SHA-256
  -> Chat Completions body (built once per operation)

for each sequential attempt while budget remains:
  fresh callId + monotonic start
    -> one SDK create/withResponse call under linked caller + attempt-deadline signal
    -> decoded provider body, or normalized provider/transport failure
    -> optional version-1 response snapshot
    -> choice/content validation + direct JSON.parse
    -> caller parseOutput exactly once for available structured JSON
    -> freeze one audit outcome
  success -> return exact T and all audits
  retryable failure -> abortable delay -> next fresh callId
  terminal failure/exhaustion -> safe LlmError and all audits
```

The request body and request payload derive from the same operation snapshot. Every retry sends equivalent generation content with a new call ID and transport invocation. Response objects and parser values never become shared operation-global state.

After the adapter returns, upper layers map each audit separately to `LlmCallRecord` and persist the complete array. A recommendation references only the final successful call ID. This package neither adds timestamps required by persistence nor imports the domain mapping.

## SDK containment and behavior

### Construction

Create one SDK client per returned port with explicit `baseURL`, exact `apiKey`, `timeout: timeoutMs`, `maxRetries: 0`, and `logLevel: "off"`. Explicit logging matters because the SDK otherwise reads its own logging environment and its debug details can contain request/response information. The adapter does not hand the SDK a logger or forward raw SDK logs into application logging.

The client is safe to reuse for concurrent independent `generate` calls. All operation state lives in local execution contexts, not on the client. The factory retains no file path or environment lookup: the service has already loaded the secret and applied defaults.

### Request invocation

Use the ordinary non-streaming `create` method and await `withResponse()` on its `APIPromise`. In SDK `7.45.1`, this provides the parsed body, raw `Response`, and `x-request-id` value after response parsing. The transport seam extracts only the plain decoded body and non-empty request ID. It does not place the `Response`, headers, SDK completion class, or request options in an audit.

The request also passes `maxRetries: 0`, `timeout: timeoutMs`, and the attempt-scoped signal linking caller cancellation and the adapter deadline per invocation. Setting zero at both client and call boundaries makes the no-hidden-retry invariant explicit if construction later changes.

Do not use `chat.completions.parse`. The port accepts an arbitrary synchronous `parseOutput` rather than an SDK parser-helper schema, and the adapter must control response capture, finish-reason handling, parser cardinality, and safe parser-error normalization. Ordinary `create` plus local `JSON.parse` provides those controls without a Zod/provider-helper dependency.

### Native retries versus visible attempts

The SDK's own loop retries connection/timeouts and HTTP 408/409/429/5xx, honors retry headers, and applies exponential delay inside one awaited API call. Those extra HTTP calls do not each produce an `LlmCallAudit`. Native retries are therefore unsuitable even though their broad classification is useful.

The adapter owns the small retry policy in `spec.md`. Its retryable HTTP classes and header interpretation intentionally track the pinned SDK behavior, while its audit loop remains outside the SDK. An SDK upgrade requires rerunning classification, timeout, abort, and fake-server compatibility tests rather than assuming this containment still holds.

### Timeout and cancellation

In the pinned SDK, the native request timeout covers waiting for headers and subsequent successful-response body parsing, and the body parser observes the caller signal. Its ordinary non-2xx path reads `response.text()` before that parser, so the native timeout does not cover every error-body read. The attempt module therefore owns a deadline controller and timer spanning the entire SDK invocation and links that signal with the caller's signal.

The adapter awaits actual SDK settlement after deadline abort rather than racing a second Promise and settling while transport work continues. It classifies an observed adapter deadline before the resulting SDK error. `timeoutMs` remains per invocation, with no overall deadline and no timeout around synchronous `parseOutput`. The SDK/runtime may also expose a transport inactivity timeout as `APIConnectionTimeoutError`; normalize it to the same attempt-timeout outcome. Long configured timeouts do not imply that Node's default header/body inactivity limits were changed.

Normalization checks the caller signal before interpreting an SDK abort/timeout class. This distinguishes caller cancellation from the SDK's internal timeout controller. The retry sleeper has its own abort listener and always removes it with its timer. No module-level abort listener exists.

### Error and metadata normalization

The SDK exposes status, an inner API-error value, and request ID on `APIError`, plus separate connection, timeout, and user-abort classes. The transport converts those values into a small internal outcome containing only:

- safe classification inputs such as status and SDK error kind;
- an optional non-empty provider request ID;
- an optional complete decoded plain-JSON successful response body for explicit capture;
- optional retry-header values needed by the retry policy.

Raw SDK messages, error causes, request/response headers, inner API-error values, and parser exceptions do not cross into public `LlmError`. SDK `APIError.generate` unwraps the provider envelope's top-level `error` property, so the complete outer error body is unavailable at this seam. Provider-error audits therefore omit response payload/version rather than capturing a partial inner value as though it were the provider response.

## Request, response, and audit invariants

### One canonicalization path

Validation first proves that request input/schema values can be snapshotted without invoking application serialization hooks. The detached values feed both the six-field projection and canonical input/schema message strings. This prevents a `toJSON` callback or later mutation from changing a hash after validation or sending content different from the audited projection.

`maxOutputTokens` is adapter-owned but generation-affecting, so it belongs in the projection even though it is absent from `LlmRequest`. Timeout, retry, endpoint, and capture settings cannot change generated content and stay outside it.

### Decoded body versus structured judgment

There are two JSON boundaries:

1. The SDK decodes the outer successful Chat Completions HTTP body. If this succeeds, version-1 response capture is available even when later judgment extraction fails. HTTP error bodies are outside this capture envelope.
2. The adapter decodes `choices[0].message.content` as the structured judgment. Only that second value reaches `parseOutput`.

Keeping these boundaries separate avoids two common audit errors: dropping a decoded response merely because its content is invalid, and capturing the parser's typed `T` as though it were the provider response. The response payload remains the provider body; the result value remains exactly the caller parser's return value.

### Attempt history

An attempt context starts immediately before SDK invocation and finishes after local output/parser observation. It owns its call ID, start reading, usage, request ID, decoded response snapshot, and terminal status. The operation owns only the ordered list of completed contexts and remaining retry budget.

Audits are appended once and never rewritten to fit a later result. The final error normally derives from the final audit. The interface's explicit exception is cancellation between attempts: no provider call exists to audit, so the adapter returns `cancelled` with the completed history unchanged. Inventing a cancelled attempt would make persistence less truthful.

No result shares a mutable attempt array with another operation. Returned snapshots are not subsequently changed by cleanup, a late abort, or another retry.

## Design tradeoffs

### JSON mode plus local parsing versus strict Structured Outputs

JSON-object mode has broader Chat Completions compatibility and avoids requiring provider support for a strict JSON Schema subset. The cost is weaker generation guidance and an object-root schema restriction; other roots fail before I/O. Schema conformance depends on the prompt and the caller's parser, and malformed output is an expected local failure. Strict `json_schema` or another mapping for non-object roots can be a later explicit adapter capability, not a silent fallback that changes wire semantics under the same request hash.

### Adapter-owned retry versus SDK-native retry

Owning the loop duplicates a small amount of backoff/header logic and needs deterministic tests. It is necessary to make every HTTP attempt visible with its own call ID, latency, status, usage, and payload. Native retry would be shorter but cannot satisfy the audit contract.

### Per-attempt deadline versus overall deadline

Per-attempt timeout lets a transiently slow provider succeed within bounded individual calls and matches the existing single `llm.timeout_ms` key. The tradeoff is that `maxRetries + 1` attempts plus delays can take much longer. Callers that need an overall budget supply an abort signal; no new hidden deadline or configuration key is introduced.

### Abort cooperation versus forced settlement

Passing the signal into the SDK and sleeper allows transport/timer cleanup and prevents background retries. A synchronous parser or a non-cooperative fake transport cannot be forcibly interrupted. The adapter observes cancellation at documented checkpoints instead of claiming instantaneous termination of arbitrary JavaScript.

### Successful-response capture versus error-body fidelity

Capturing the complete decoded successful provider body preserves evidence and provider extensions for debugging. It also retains more potentially sensitive model output and makes the version a capture convention rather than a validated provider schema. Capture is therefore per-request, off by default, detached from headers/SDK objects, and never enabled by this adapter itself.

The ordinary SDK error seam does not retain the complete outer error envelope. Omitting response payloads on provider errors avoids storing a misleading partial projection and limits sensitive error-body retention. The cost is less provider-error evidence; adding full error-body capture would require a deliberately redesigned raw-transport seam and a new response-capture contract.

### Caller parser versus adapter-owned schema validator

Reusing `parseOutput` avoids adding Zod or a JSON Schema validator and keeps judgment types with consumers. The tradeoff is that the adapter cannot prove schema conformance independently; a parser that accepts the wrong value defines the caller's acceptance behavior. Prompt schema and local parsing are still mandatory, but they do not replace consumer validation.

### Consumer-owned model selection

The adapter has no `defaultModel` option or request fallback. The service gives `llm.model` to recommendation/startup consumers, and each request carries it explicitly into hashing, wire mapping, and audits. This avoids two sources of truth while preserving model-specific immutable judgments.

### Private modules versus new shared libraries

Canonical JSON, retry, and audit helpers stay private because the implementation-order graph permits only `llm-interface` here. Extracting one would change the workspace dependency graph and requires a separate design decision. Local duplication is bounded by having one owner for each rule rather than importing `retry`, `clock`, or `domain` contrary to the plan.

## Fake-provider and deterministic testing seams

### Narrow SDK seam

Unit and contract tests replace only `sdk-transport` with a scripted fake. Each invocation records the exact body/options and returns or throws one scripted outcome. The fake supports:

- decoded completions with choices, finish reasons, refusal/tool fields, usage, IDs, and extension fields;
- decoded and non-JSON API errors with statuses and request IDs;
- connection, timeout, abort, and unknown SDK errors;
- deferred settlement controlled by the test to race aborts and concurrent operations;
- a journal proving zero/one/many calls and no call after cancellation or settlement.

All real validation, projection, canonicalization, mapping, retry, response, parser, error, and audit code remains under test. A fake `LlmPort` is not a substitute because it bypasses everything this package must prove.

### Private deterministic sources

The internal composition accepts call-ID, monotonic-time, wall-clock, random, timer/deadline, and sleep sources without adding them to the public factory. Tests use sequential opaque IDs, exact fractional monotonic readings, fixed wall time for HTTP-date retry headers, queued random values, controllable deadline timers, and a fake sleeper that records delay/signal pairs and can abort or advance time. Real production defaults are `randomUUID`, `performance.now`, `Date.now`, `Math.random`, and abortable timers.

No retry test needs a real backoff wait. Latency assertions use the fake monotonic source where exact values matter and the shared public contract otherwise checks only non-negative safe integers.

### Real SDK/local fake HTTP server

A small loopback server provides the SDK compatibility seam. It journals method, URL, content type, authorization, body, and request count while returning controlled Node HTTP responses. Fixtures cover:

- successful JSON and request-ID headers;
- malformed outer JSON and malformed structured content;
- status errors with JSON/text bodies and retry headers;
- delayed headers/body and client abort observation;
- accidental second calls that would reveal native retries or post-cancellation work.

This suite exercises actual SDK `7.45.1` behavior without public network access or a real API key. Secret sentinels appear only in test configuration and are asserted absent from public results, captures, errors, and logs.

### Shared contract and upper-layer seams

Run the adapter against every compatible concrete-adapter behavior fixture listed by `llm-interface`, including between-attempt cancellation. Consumer suites continue to use fake ports for prompt/projection logic. Later-batch integration suites compose the real adapter with recommendation/startup code to prove final-call linking, complete failed-attempt persistence, capture-policy propagation, and end-to-end request-signal forwarding; they are not Batch B gates.

## Dependency and change boundaries

The package remains at tier 1 with one workspace dependency, `llm-interface`, and one external runtime dependency, `openai@7.45.1`. Node built-ins are runtime capabilities, not workspace dependencies. No logger, persistence, retry package, config loader, or recommendation type crosses this boundary.

Request projection/version `1`, response capture/version `1`, message mapping, error codes, retry classification, and golden hashes are compatibility surfaces. Changes require focused contract tests; semantic request changes require projection/hash versioning, and SDK upgrades require the real-fake-server matrix.

Provider-specific generation options, new endpoint protocols, model fallback, lifecycle methods, or additional workspace dependencies are not private implementation details. They require explicit cross-package design changes rather than quiet additions to this adapter.
