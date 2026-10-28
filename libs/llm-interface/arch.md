# LLM Interface Architecture

## Architectural role

`llm-interface` is a tier-0 type-only port between judgment-producing application logic and provider adapters. It defines the semantics of one structured generation, including its failure and audit behavior, while deliberately emitting no runtime implementation.

The boundary keeps recommendation logic independent of OpenAI-compatible SDKs and lets startup checks, recommendations, tests, and future providers share the same result and audit vocabulary.

## Internal module decomposition

The package has type modules only. They are organizational units, not runtime services or additional workspace packages.

| Module | Owns | Must not contain |
|---|---|---|
| `schema` | `JsonSchema` and its recursive JSON-schema shape | A JSON Schema validator or provider schema converter |
| `request` | `LlmPurpose` and generic `LlmRequest<T>` | Prompt construction, credential fields, retry/timeouts |
| `result` | `LlmUsage` and `LlmResult<T>` | SDK response classes or persistence records |
| `audit` | `LlmCallStatus` and `LlmCallAudit` | ID generation, hashing, payload-capture execution |
| `error` | `LlmErrorCategory` and `LlmError` | Error constructors, SDK normalization, stack formatting |
| `port` | Generic `LlmPort.generate` signature | A default implementation or abstract runtime class |
| `index` | Type-only barrel exports | Runtime exports or side effects |

Keeping the declarations separate makes the audit and error contracts reviewable without a provider implementation. The barrel is the only consumer-facing import path.

## Control and data flow

There is no control flow inside this package. The contract governs the following flow across its consumers and an injected implementation:

```text
Consumer projection + JsonSchema + parseOutput
  -> LlmPort.generate(request)
  -> adapter validates and snapshots the request
  -> adapter creates canonical request projection and requestHash
  -> provider attempt + timeout/cancellation observation
  -> parsed provider JSON
  -> caller-owned parseOutput
  -> LlmResult<T> with all attempt audits
```

Every provider attempt branches into exactly one audit outcome: success, invalid output, provider error, timeout, or cancellation. A bounded adapter retry loop feeds earlier audits into the eventual result or `LlmError`. Pre-I/O validation and pre-aborted calls bypass the attempt loop and return an empty audit array. Cancellation between retries or after an attempt has settled also creates no audit because no provider call exists to audit; the error is cancelled while the retained final audit describes the actual earlier attempt.

Audit persistence is a later mapping step:

```text
LlmResult / LlmError
  -> recommendations or startup composition
  -> domain LlmCallRecord mapping
  -> reader-store persistence
  -> redacted diagnostics projection
```

Neither the port nor its types import that domain mapping. This preserves the downward dependency graph and prevents database concerns from leaking into pure recommendation logic.

## Responsibility boundaries

### Consumer

The consumer owns versioned prompts, allowed story/profile projections, the output schema, and `parseOutput`. It chooses `capturePayload` from explicit diagnostics policy, supplies cancellation, persists audits, and links a successful judgment to the final successful call ID.

The consumer also guarantees that credentials never enter prompt or schema projections. The type system cannot distinguish an arbitrary secret string from article text.

### Interface

The interface owns field names, generic value flow, category/status vocabulary, attempt cardinality, nullability, and the observable semantics documented in `spec.md`. It does not choose a provider API, retry policy, error constructor, canonicalization library, or storage schema.

### Concrete adapter

The adapter owns runtime validation, defensive request snapshots, canonical JSON and SHA-256, random call IDs, provider request mapping, bounded retry/timeout behavior, monotonic latency measurement, local JSON parsing, `parseOutput` invocation, safe error normalization, and optional payload snapshots.

The adapter defines and versions its complete request projection, including content-affecting generation options. It disposes or delegates disposal of SDK resources through the service composition root, not through `LlmPort`.

### Persistence and diagnostics

Upper layers map audits to nullable database columns without changing absent optional values into captured `null` payloads. Payload schema versions travel with their payload. Diagnostics reveals stored payloads only under explicit debug policy and never adds adapter secrets.

## Dependency use

There are no dependencies on other workspace libraries and no third-party runtime dependencies.

- `AbortSignal` is used as an environment-supplied TypeScript type only.
- Generic `T` keeps caller judgment types independent of the interface.
- `unknown` at the parser boundary forces the caller-owned parser to establish the output type.
- The index-signature on `JsonSchema` permits standard JSON Schema keywords without coupling this package to one provider's schema subset.

Adding Zod, an SDK, a hashing package, a clock, a domain import, or a runtime error class to this package would change its architectural role and is not part of this design.

## Design tradeoffs

### Types only versus a runtime base adapter

A types-only port gives pure logic the smallest possible dependency and avoids prescribing one provider's behavior. The cost is that validation, error normalization, and audit correctness must be tested separately in every adapter. A shared behavioral contract suite in the adapter's test suite is therefore essential; this package must not grow a runtime base class merely to share tests.

### Rejected promises versus result unions

`generate` resolves only accepted judgments and rejects normalized `LlmError` objects. This keeps the generic success path simple and matches promise-based SDK composition. The tradeoff is that TypeScript cannot express rejection types, so consumers must understand and test the documented error contract rather than relying on the compiler alone.

### Required error attempts

`LlmError.attempts` is required even when empty. This removes an ambiguous “missing audits” state and makes persistence and failure handling uniform. Pre-I/O validation and cancellation are the explicit empty-array cases; every started provider call must be audited.

### Generic audits with versioned payloads

Stable operational fields live directly on `LlmCallAudit`; variable request/response payloads remain `unknown` and versioned. This supports provider differences without weakening usage queries. The tradeoff is that persistence/debug consumers need schema-version-aware handling and cannot assume one provider's payload shape.

### Capture at the audit boundary

Payload capture is per request rather than global mutable state. Concurrent recommendation and diagnostic operations can therefore make different choices without leaking payloads into one another. The tradeoff is that callers must deliberately propagate debug policy for every request.

### No lifecycle method on the port

`LlmPort` represents generation only. Adding `close`, provider health, or SDK-specific configuration would make pure consumers depend on infrastructure lifecycle. Adapter disposal remains a service responsibility. The cost is that the service must retain the concrete adapter handle when it owns resources requiring shutdown.

## Testing seams

### Type-level seams

The public barrel supports compile-time fixtures for generic parser results, every union member, optional-field nullability, and structural `LlmError` implementations. Package artifact tests verify type-only exports and the absence of runtime dependencies.

### Consumer seams

Pure recommendation and startup tests inject a fake `LlmPort`:

- return prepared typed judgments and audit arrays;
- reject structured `LlmError` values for each category;
- capture the exact request for prompt/projection assertions;
- hold promises open to test cancellation and concurrency;
- verify successful recommendations link to the final successful call ID.

These fakes test consumer behavior and do not prove adapter compliance.

### Adapter seams

`llm-openai-compatible` tests mock its SDK/transport boundary while using the real request validation, canonicalization, parsing, retry, and audit code. Controlled fake responses, transport errors, and abort signals exercise the full contract without network access.

The adapter's test clock/duration source can make latency exact where its internal design permits; public contract tests need only assert non-negative integer durations. ID assertions check uniqueness and opaque non-empty form rather than a fixed random value.

### Persistence and diagnostics seams

Upper-layer tests use audits with and without payloads, unknown usage, and all statuses to verify nullable SQL mapping and debug redaction. Secret-sentinel tests span adapter capture and diagnostics output so credentials cannot reappear at a later boundary.

## Dependency and change boundaries

The package remains at tier 0. Changes to its public types affect `llm-openai-compatible`, `recommendations`, startup validation, domain audit mapping, and diagnostics even though only the first two import it directly.

Provider-specific additions belong in the adapter unless they are genuinely portable across providers. New purposes require explicit consumer and diagnostic review rather than widening `purpose` back to an arbitrary string.
