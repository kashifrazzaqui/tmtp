# LLM Interface Library Spec

## Purpose and responsibility

Define a provider-neutral, transport-free port for structured language-model judgments and their per-attempt usage metadata. The package contains types only: no SDK, transport, retry loop, clock, ID generator, hashing implementation, prompt, schema validator, persistence, or logging policy.

A concrete `LlmPort` implementation owns provider calls, bounded retries, local structured-output parsing, cancellation, error normalization, request hashing, and audit construction. Consumers own prompts, caller-side projections, `parseOutput`, persistence, and whether captured payloads may be exposed.

## Public interface / API surface

```ts
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  [keyword: string]: unknown;
}

export type LlmPurpose = "recommendation" | "connection-check";

export interface LlmRequest<T> {
  purpose: LlmPurpose;
  model: string;
  instructions: string;
  input: unknown;
  outputSchema: JsonSchema;
  parseOutput: (value: unknown) => T;
  capturePayload: boolean;
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  providerRequestId?: string;
}

export interface LlmResult<T> {
  value: T;
  attempts: LlmCallAudit[];
}

export type LlmCallStatus =
  | "success"
  | "invalid-output"
  | "provider-error"
  | "timeout"
  | "cancelled";

export interface LlmCallAudit {
  callId: string;
  purpose: LlmPurpose;
  model: string;
  requestHash: string;
  status: LlmCallStatus;
  usage: LlmUsage;
  errorCode?: string;
  requestPayload?: unknown;
  requestPayloadSchemaVersion?: number;
  responsePayload?: unknown;
  responsePayloadSchemaVersion?: number;
}

export type LlmErrorCategory =
  | "invalid-request"
  | "timeout"
  | "rate-limit"
  | "provider"
  | "invalid-output"
  | "cancelled";

export interface LlmError extends Error {
  category: LlmErrorCategory;
  code: string;
  attempts: LlmCallAudit[];
  retryable: boolean;
}

export interface LlmPort {
  generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}
```

This is the complete public surface. All exports are TypeScript types or interfaces; the package emits no runtime values and has no runtime dependencies.

## General value and nullability rules

- An optional property (`?`) may be absent when its value is unknown or not applicable. The contract does not use `null` in any field, and explicit `null` is not a substitute for an omitted property.
- Present token counts are safe integers greater than or equal to zero. A provider that does not report a token count yields an absent property; the adapter must not estimate a value or emit `null`, `NaN`, or a negative number.
- `latencyMs` is always a safe integer greater than or equal to zero, including for provider errors and cancelled attempts.
- `providerRequestId`, when present, is a non-empty opaque provider identifier. It is not synthesized from an API key or another secret.
- Payload values, when present, must be JSON-compatible and safe to serialize without invoking application callbacks. They contain no `undefined`, functions, symbols, bigint values, class instances, cyclic references, or non-finite numbers.
- Schema version fields are positive safe integers. A producer increments the relevant version whenever the corresponding payload shape or canonical meaning changes.
- Consumers treat results, errors, attempts, usage objects, and payloads as immutable snapshots. An adapter must not mutate an audit after returning or rejecting.

## Request boundary contract

Every implementation validates the runtime request before provider I/O. Validation failures reject with `LlmError` in category `invalid-request`; they never throw synchronously from `generate` and never reach the provider.

| Field | Runtime contract |
|---|---|
| `request` | Must be a non-null object. Unknown properties are ignored and are not part of the request hash or captured projection. |
| `purpose` | Exactly `"recommendation"` or `"connection-check"`. |
| `model` | A non-empty string with no leading or trailing whitespace. The adapter sends and audits the exact value. |
| `instructions` | A string containing at least one non-whitespace character. Leading/trailing and internal whitespace are otherwise preserved. |
| `input` | A JSON-compatible value: `null`, boolean, finite number, string, array, or plain object. Reject cycles, sparse arrays, non-plain objects, `toJSON` hooks, and every non-JSON or non-finite nested value. Object properties with `undefined` values are rejected rather than silently dropped. |
| `outputSchema` | A plain, acyclic, JSON-compatible schema object with a non-empty string `type`. `properties` values are recursively schemas, `required` is a unique array of strings, `items` is a schema or schema array, and `additionalProperties` is a boolean or schema when present. Unknown JSON Schema keywords are preserved for the adapter. |
| `parseOutput` | A synchronous function. It receives parsed provider JSON, not a JSON string. It must return the caller's judgment or throw to reject that judgment. |
| `capturePayload` | Exactly a boolean. It controls audit capture only, not what is sent to the provider. |
| `signal` | Optional `AbortSignal`; `null` is not accepted. An already-aborted signal rejects as `cancelled` before validation or provider I/O. |

The port does not require a particular root schema type or provider-specific keyword support. An implementation may reject a schema it knows it cannot map as `invalid-request`; otherwise provider rejection is a `provider` error. Such support checks still occur before network I/O when possible.

The adapter takes a stable snapshot of the validated request at invocation. Later caller mutation of `input`, `outputSchema`, or their nested values must not change an in-flight provider request, hash, or audit. `parseOutput` itself is not serialized, hashed, captured, or called during request validation.

## Success, parsing, and retry contract

`generate` resolves only with a locally accepted judgment. It never resolves an error union and never returns raw provider JSON as a successful `T` without invoking `parseOutput`.

For each provider attempt:

1. Create one audit with a fresh `callId` and the operation's `requestHash`.
2. Invoke the provider under the adapter's timeout and the caller's cancellation signal.
3. Parse the provider's structured JSON response. Malformed JSON, provider schema disagreement, or a missing structured value is `invalid-output`.
4. Pass the parsed JSON value to `parseOutput` exactly once for that syntactically and structurally available response. A thrown parser exception is also `invalid-output`.
5. Only a parser return value produces a `success` audit and a resolved `LlmResult<T>` whose `value` is exactly that returned value.

An implementation may retry according to its own bounded policy. It must not hide attempts: every provider call appears in `attempts` in start order, including invalid outputs and failed attempts before an eventual success. No attempt is cloned to represent a retry. A successful result has at least one attempt and its final attempt has status `success`.

The interface does not prescribe which failures are retried internally, retry counts, or delay algorithms. Those belong to the adapter. Caller-visible `retryable` describes whether a new operation is reasonable after the returned error; it does not request automatic retry by the consumer.

## Audit contract

### Identity and cardinality

- `callId` is a non-empty, cryptographically random, opaque string generated by the implementation. It is unique per provider attempt and is the ID a successful recommendation uses to link to its audit.
- `purpose` and `model` equal the validated request values for every attempt.
- `requestHash` is identical across attempts of one operation and has the form `"sha256:"` plus 64 lowercase hexadecimal characters.
- `attempts` is ordered from first to last provider call. Concurrent operations have independent arrays and call IDs.
- No audit exists when no provider call was started: invalid requests and already-aborted calls have `attempts: []`.

### Request hashing

The digest is SHA-256 over the UTF-8 bytes of a canonical JSON, non-secret request projection. Canonicalization is deterministic:

- object keys are sorted lexicographically by UTF-16 code units at every depth;
- array order is retained;
- strings and numbers use standard JSON serialization, with no insignificant whitespace;
- no Unicode normalization, key-case conversion, or numeric rounding is added;
- `parseOutput`, `capturePayload`, `signal`, unknown request properties, credentials, endpoint settings, headers, retry policy, and timeout policy are excluded.

The projection includes `purpose`, `model`, `instructions`, `input`, and `outputSchema`, plus any adapter-owned generation parameters that change generated content, such as maximum output tokens. Operational timeout and retry settings do not affect the hash. Each adapter documents its complete projection and versions it with `requestPayloadSchemaVersion`.

Equivalent JSON objects with different source key order have the same hash. Changing any hashed semantic value changes the canonical input and therefore the digest except for cryptographic collisions. Turning payload capture on or off never changes the hash.

### Status, errors, and usage

| Audit `status` | Meaning | `errorCode` |
|---|---|---|
| `success` | Provider response and local `parseOutput` both succeeded. | Absent. |
| `invalid-output` | Provider JSON/structure was invalid or `parseOutput` threw. | Present and non-empty. |
| `provider-error` | Provider or transport failed, including a normalized rate limit. | Present and non-empty. |
| `timeout` | The adapter's attempt deadline elapsed. | Present and non-empty. |
| `cancelled` | The caller's signal aborted an in-flight attempt. | Present and non-empty. |

`usage.latencyMs` measures one attempt from immediately before provider invocation until the provider outcome and any required local response parsing/validation are observed. It excludes retry delays and other attempts. Implementations use a monotonic duration source where available so wall-clock adjustments cannot produce negative durations.

Provider usage and request ID are copied when available, independently of success or failure. Missing provider usage does not make an otherwise valid result fail.

## Payload-capture and secret contract

`capturePayload=false` is the default-safe mode supplied by callers:

- every audit omits `requestPayload`, `requestPayloadSchemaVersion`, `responsePayload`, and `responsePayloadSchemaVersion`;
- hashing, usage, status, errors, and latency still occur;
- the setting does not reduce the prompt or data sent to the provider.

When `capturePayload=true`:

- every attempt includes `requestPayload` and its version, even if the provider call fails;
- `requestPayload` is the versioned non-secret canonical request projection used for `requestHash`, not provider headers or adapter credentials;
- an attempt includes `responsePayload` and its version only when a provider response was successfully decoded as JSON; no response fields are invented for malformed JSON, timeout, cancellation, or transport failure before a decoded response;
- `responsePayload` is the successfully decoded provider response JSON value before `parseOutput`, without response headers, SDK class instances, or credential material. An undecodable response has no `responsePayload`;
- payload and version properties are paired: neither version appears without its payload, and no payload appears without a positive schema version.

The request type has no API-key, cookie, authorization-header, or session-credential field. Captures must never include adapter configuration, endpoint credentials, request/response headers, or secret-file contents.

The port cannot recognize arbitrary secrets embedded in caller-authored strings. Callers must therefore keep access tokens, HN cookies, API keys, and other secrets out of `instructions`, `input`, and `outputSchema`. Explicit payload capture permits non-secret prompts, profiles, story content, and provider output; it is not permission to capture credentials.

Errors and audit error codes/messages must not echo prompts, payloads, provider response bodies, API keys, cookies, or authorization headers. Raw provider errors may remain internal causes for controlled diagnostics only if the composing service explicitly redacts them; they are not part of `LlmError`'s public contract.

## Failure contract

All expected validation, cancellation, timeout, provider, transport, and local output failures reject the `generate` promise with an `Error` object satisfying `LlmError`. Raw SDK errors and raw `parseOutput` exceptions do not escape.

| `category` | Typical meaning | `retryable` |
|---|---|---|
| `invalid-request` | Request validation or known schema-mapping failure before provider I/O. | Always `false`. |
| `timeout` | Final attempt exceeded its deadline. | `true` for a new operation, subject to caller policy. |
| `rate-limit` | Provider asked the caller to reduce request rate. | `true`, subject to caller backoff. |
| `provider` | Other provider or transport failure. | `true` for transient/server failures; `false` for permanent request/auth failures. |
| `invalid-output` | Final provider response could not be parsed and locally accepted. | `false` for an unchanged request; callers may revise the request or prompt. |
| `cancelled` | Already-aborted request or caller cancellation. | Always `false` for the cancelled operation. |

`code` is a non-empty, stable, machine-readable adapter code suitable for diagnostics. It uses lowercase kebab-case and is more specific than `category` where useful. It never contains free-form provider text.

`attempts` is always present on `LlmError`:

- it is empty for an already-aborted call or pre-I/O invalid request;
- otherwise it contains every started attempt in order;
- the final attempt status agrees with the error category: `timeout` → `timeout`, `cancelled` → `cancelled`, `invalid-output` → `invalid-output`, and `rate-limit`/`provider` → `provider-error`;
- the final attempt's `errorCode` equals the error's `code`.

`message` is a short safe summary. Consumers branch on `category`, `code`, and `retryable`, never on message text. Cancellation never starts another retry after the signal aborts.

## Concurrency and lifecycle contract

- Multiple `generate` calls may be in flight on one port. Request snapshots, call IDs, attempt arrays, parser invocations, and cancellation signals remain isolated by operation.
- Synchronous `parseOutput` calls do not overlap on one JavaScript thread, but they may occur in any order across in-flight operations. A shared parser function or closure must not rely on operation-global mutable state.
- One call's abort signal does not cancel unrelated calls unless the caller deliberately supplied the same shared signal.
- Once a call resolves or rejects, the implementation starts no more attempts for it and does not mutate its returned audits.
- The port owns no shutdown method, timer, stream, or persistent resource contract. SDK clients, connection pools, and their disposal belong to the concrete adapter and service composition root.
- Consumers may safely validate `value` again at their own boundary; this does not replace the mandatory adapter call to `parseOutput`.

## Internal subcomponents

None at runtime. Internally, type declarations are divided by concern into schema/request, result/usage, audit, error, and port modules with one barrel that re-exports types. These divisions emit no implementation and are described in [arch.md](arch.md).

## Dependencies on other libs

None and no runtime dependencies, keeping the interface safe for pure recommendation logic. `AbortSignal` is a TypeScript environment type, not a package import.

## New build or OSS wrapper

New TypeScript interface only.

## Hosted by

Implemented by `llm-openai-compatible`; consumed in process by `recommendations` and startup validation. Audits are mapped to domain/persistence records by upper layers.

## Configuration

None. Provider settings, retry/timeouts, and output-token limits belong to the concrete adapter. `debug.include_llm_payloads` belongs to diagnostics and influences the caller's `capturePayload` choice; this package reads neither key.

## Acceptance-focused test expectations

### Type and dependency tests

- Compile representative recommendation and connection-check requests, generic parser results, all error categories/statuses, and an `Error`-compatible `LlmError` implementation.
- Compile negative cases for unknown purposes/statuses/categories, missing error attempts/code, null usage counts, and non-function parsers.
- Verify the package manifest and emitted artifacts introduce no runtime dependency, SDK import, global DOM object, or provider type.

### Shared behavioral contract for every adapter

These tests run against concrete adapters in their owning packages with a mocked provider transport; the type-only `llm-interface` package itself has no runtime behavior to execute.

- A structured provider response calls `parseOutput` once with parsed JSON and resolves its exact typed value with one final `success` audit and copied usage.
- Missing token usage omits only those fields. Latency is a non-negative integer for every attempt.
- Invalid JSON, missing structured content, schema disagreement, and parser exceptions produce `invalid-output`; raw parser/provider messages and payload markers do not escape.
- A retry sequence returns every attempt in order with distinct call IDs and one shared request hash. Eventual success has a final success audit; terminal failure has a final status matching its error category.
- Invalid request fixtures perform zero provider calls and reject with `invalid-request`, `retryable=false`, and `attempts: []`. Cover every boundary rule, including cyclic/non-JSON input and invalid schema nodes.
- Independently compute request hashes for canonical fixtures. Reordered object keys and changed capture flags preserve the digest; semantic changes do not.
- With capture off, all four payload/version fields are absent on success and failure. With capture on, request payload/version are present for every attempt, response payload/version appear only after a successfully decoded JSON response, and hashes equal capture-off hashes.
- Place unique secret sentinels in adapter credentials and authorization headers. Assert they never occur in serialized results, errors, audits, or captured payloads. Composition tests separately verify callers do not place secrets in prompt projections.
- Timeout, rate-limit, permanent provider error, and transient provider error map to the documented category/status/code/retryable behavior without raw SDK errors.
- An already-aborted signal performs no provider I/O, does not invoke `parseOutput`, and returns `cancelled` with no attempts. Mid-attempt cancellation records one cancelled audit and starts no retry.
- Concurrent and interleaved operations preserve request/response pairing, parser values, audit order, unique call IDs, and independent cancellation.

### Workflow acceptance

- WF-01 can issue a minimal `connection-check` structured judgment and expose a safe degraded-capability error without secrets.
- WF-06 recommendation success links its recommendation to the successful `callId`; failed scoring retains all attempt audits for later persistence and never treats failure as a negative judgment.
- WF-08 with payload capture disabled exposes usage and safe errors only. Explicit capture adds versioned non-secret request/response payloads without changing judgment behavior or request hashes.
