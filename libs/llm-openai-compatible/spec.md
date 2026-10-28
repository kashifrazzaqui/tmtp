# OpenAI-Compatible LLM Adapter Spec

## Purpose and responsibility

Implement `llm-interface` for one configured OpenAI-compatible Chat Completions endpoint and API token. The adapter owns request validation and snapshots, canonical request hashing, provider request mapping, bounded retries, per-attempt timeout and cancellation, local JSON parsing, safe error normalization, and complete per-attempt audits.

Consumers own prompts and input projections, `parseOutput`, caller-side schema validation, persistence, and the decision to capture payloads. The adapter does not construct recommendation prompts, persist audits, expose provider models or SDK types, read secret files, read centralized configuration, or provide a health method.

## Public interface / API surface

The package root is `@tmtp/llm-openai-compatible`. Its complete public runtime surface is:

```ts
export function createOpenAiCompatibleLlm(options: {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
}): import("@tmtp/llm-interface").LlmPort;
```

There is no default export, public error class, SDK re-export, provider-specific request type, `close` method, or public test hook. The returned port has exactly the `generate` behavior in `llm-interface`. Expected generation failures reject with an `Error` satisfying `LlmError`; raw SDK errors and raw `parseOutput` exceptions do not escape.

### Factory boundary

The service applies configuration defaults before calling the factory, so every option is required here. The factory validates and snapshots options synchronously. Wrong types throw `TypeError`; invalid strings or numeric ranges throw `RangeError`. Messages name the option but never echo `apiKey`, a URL containing credentials, or another supplied value.

| Option | Runtime contract and use |
|---|---|
| `baseUrl` | Absolute `http:` or `https:` URL without username, password, query, or fragment. Passed as the SDK `baseURL`; the adapter does not append a second version path. |
| `apiKey` | Non-empty string after trimming for validation only. The exact original string is passed to the SDK and is never trimmed, hashed, captured, or included in errors. |
| `timeoutMs` | Safe integer in `1..2_147_483_647`. It is the deadline for each provider attempt, not an overall operation deadline. |
| `maxRetries` | Non-negative safe integer. It counts retries after the initial attempt, so an operation starts at most `maxRetries + 1` provider calls. |
| `maxOutputTokens` | Positive safe integer. Sent as Chat Completions `max_completion_tokens` and included in the canonical request projection and hash. |

Unknown option properties are ignored. Later caller mutation of the options object cannot alter the constructed port. The adapter has no model default: the consumer supplies the configured model explicitly on every request.

## Generation boundary and immutable request snapshot

`generate` first observes an already-aborted signal and rejects with `cancelled`, code `cancelled`, `retryable=false`, and `attempts: []`. Otherwise it applies every runtime request rule in `llm-interface` before provider I/O. Invalid requests reject with category/code `invalid-request`/`invalid-request`, `retryable=false`, and no attempts.

Validation includes recursive JSON-compatible input and schema values, plain-object and acyclic checks, rejection of `undefined`, sparse arrays, non-finite numbers, `toJSON` hooks, invalid schema nodes, and the exact purpose/model/instructions/parser/capture/signal types. Unknown request properties are ignored. This adapter additionally requires `outputSchema.type === "object"` because JSON-object mode cannot represent a root array, string, number, Boolean, or null. Another root type is an adapter mapping failure: `invalid-request`, code `invalid-request`, `retryable=false`, no provider I/O, and no attempts. All other port-supported schema keywords are preserved; the adapter adds no provider-strict-schema subset validation.

After validation, the adapter takes a deep JSON snapshot of `input` and `outputSchema` and snapshots all scalar request fields. The in-flight provider body, hash, captured request, and parser input derive from this snapshot, not later caller mutation. `parseOutput` remains a callback reference: it is not serialized, hashed, captured, or invoked during validation.

## Canonical request projection and hash

Request payload schema version **1** defines this complete non-secret projection:

```ts
{
  purpose: request.purpose,
  model: request.model,
  instructions: request.instructions,
  input: request.input,
  outputSchema: request.outputSchema,
  maxOutputTokens: options.maxOutputTokens
}
```

The captured `requestPayload` is a deep snapshot with exactly these six top-level properties. `requestPayloadSchemaVersion` is `1`. The projection deliberately excludes `baseUrl`, `apiKey`, `timeoutMs`, `maxRetries`, `parseOutput`, `capturePayload`, `signal`, unknown request properties, HTTP headers, SDK options, and retry-attempt numbers.

For each operation, canonicalize the projection as follows:

1. Sort object keys lexicographically by UTF-16 code units at every depth.
2. Preserve array order and all validated string, number, Boolean, and null values.
3. Serialize with ordinary JSON string/number escaping and no insignificant whitespace, Unicode normalization, key-case conversion, or numeric rounding.
4. Hash the UTF-8 bytes of that one canonical JSON string with SHA-256.
5. Format `requestHash` as `sha256:` followed by 64 lowercase hexadecimal characters.

Every attempt in one operation uses the same hash. Reordered source object keys and changes to capture, timeout, retry, endpoint, credential, or callback settings do not change it. A change to any of the six projected values, including `maxOutputTokens`, changes the canonical input and therefore the digest except for cryptographic collisions.

Any change to the projection's fields or canonical meaning requires a new request payload schema version and updated golden hash fixtures. A mapping change that changes generated content must also revise the projection so historically identical hashes cannot represent different semantic requests.

## Chat Completions request mapping

Each attempt makes one non-streaming `client.chat.completions.create` call, not a Responses API call and not the SDK's parser helper. The request body is exactly:

```ts
{
  model: request.model,
  messages: [
    { role: "system", content: request.instructions },
    {
      role: "user",
      content:
        "Input JSON:\n" + canonicalJson(request.input) +
        "\n\nReturn only one JSON object that conforms to this JSON Schema:\n" +
        canonicalJson(request.outputSchema)
    }
  ],
  response_format: { type: "json_object" },
  max_completion_tokens: options.maxOutputTokens,
  n: 1,
  stream: false
}
```

`canonicalJson` above uses the same recursive key ordering as the request hash. The two message strings preserve `request.instructions` exactly and add no other instruction, sampling option, seed, tool, identifier, or provider-specific extension. JSON mode asks a supporting provider for JSON syntax; the schema in the user message describes the required judgment. The adapter does not require or request `json_schema`, `strict: true`, tool calling, or provider-side schema enforcement.

The adapter passes `timeoutMs`, `maxRetries: 0`, and an attempt-scoped signal linking the caller's optional `signal` to the adapter's attempt-deadline controller as request options. SDK-native retries are always disabled, including when `maxRetries` is positive. SDK logging is disabled at client construction so environment settings cannot enable payload or header logging.

## Response extraction and local acceptance

The SDK decodes the outer successful HTTP response body as JSON. With payload capture enabled, that decoded provider JSON value is snapshotted before output extraction. The adapter then requires:

- a non-null response object with a `choices` array containing exactly one choice;
- a choice with `finish_reason === "stop"` and an assistant `message` object;
- no non-null `message.refusal`, tool call, or legacy function call;
- a string `message.content` containing one complete JSON object.

The adapter applies `JSON.parse` directly to `message.content`. It does not strip Markdown fences, search for a JSON substring, concatenate choices, accept truncated output, or return raw text. The parsed value must be a non-null, non-array object. The adapter then invokes the request's `parseOutput` exactly once with that object. The parser's exact return value becomes `LlmResult.value`; a thrown value becomes safe `invalid-output` with code `output-rejected`.

Failure classification has deterministic precedence: malformed outer response/choice/message shape first; `finish_reason` (`length`, `content_filter`, `tool_calls`/`function_call`, then any other non-`stop` value) second; non-null refusal third; present tool/function calls fourth; missing non-string content fifth; malformed content JSON sixth; non-object parsed content seventh; parser rejection last. This fixes the code when a response has more than one invalid feature.

The caller's parser is the local schema/judgment boundary. This package does not add a second JSON Schema validator; the object-root requirement is a transport mapping limit, not judgment validation. A successful result has at least one attempt, ends in a `success` audit, and preserves every earlier attempt.

Provider usage maps from `usage.prompt_tokens` to `inputTokens` and `usage.completion_tokens` to `outputTokens`. Only present non-negative safe integers are copied; missing or malformed usage fields are absent and are never estimated. `providerRequestId` uses a non-empty `x-request-id` observed through the SDK response metadata, a non-empty request ID on an SDK API error, or, for a successful response without that header, the non-empty completion `id`, in that precedence order. No other header is retained.

`latencyMs` is measured separately for each attempt with a monotonic clock, from immediately before SDK invocation until the provider outcome and local output parsing/parser execution finish. It is floored to a non-negative safe integer and excludes retry delays and other attempts.

## Retry, timeout, and cancellation contract

### Attempt budget and retry classification

Attempts are strictly sequential. Each started SDK call receives a fresh cryptographically random `callId`, while purpose, model, and request hash remain operation-stable. `maxRetries=0` permits exactly one attempt.

Only these failures consume another retry while budget remains:

- adapter/SDK attempt timeout;
- connection failure before a provider response;
- HTTP 408, 409, 429, or 5xx provider responses.

Malformed responses, invalid structured output, `parseOutput` failures, cancellation, HTTP 400/401/403/404/422, and unknown failures are not retried. An invalid output therefore terminates as non-retryable for the unchanged request even when retry budget remains.

Before retry `n`, where the first retry is `n=1`, calculate:

```text
baseMs = min(8000, 500 × 2^(n - 1))
delayMs = baseMs × (1 - 0.25 × random())
```

`random()` is `Math.random` in production, yielding a multiplier in `(0.75, 1]`. Tests inject a private deterministic source. If a retryable API error supplies a valid `retry-after-ms` or `retry-after` header, use the SDK-compatible header interpretation instead: milliseconds directly, seconds multiplied by 1000, or an HTTP-date delta. A missing, invalid, negative, non-finite, or greater-than-60000 ms header value falls back to the formula above. Header-directed delays have no added jitter.

The delay is abortable and owns no work after its timer/listener cleanup. There is no sleep after success, terminal failure, exhaustion, or cancellation. Retry and delay settings are operational only and never alter the request body or hash.

### Timeout

`timeoutMs` applies independently to every attempt, including successful and non-2xx response-body reading. Each attempt creates a deadline controller and timer before SDK invocation and passes the linked attempt signal to the SDK. The timer remains active through the complete SDK invocation, aborts the attempt at the deadline, and is cleaned up when the SDK settles. The adapter awaits that settlement rather than returning early from a Promise race while transport work continues. The SDK receives the same timeout as an additional native header/success-body deadline; the adapter controller is necessary because the pinned SDK does not bound every non-2xx error-body read by its own timeout.

An observed attempt deadline records `status="timeout"`, code `attempt-timeout`, and may be retried as above, even if aborting the SDK subsequently produces an API error. This relies on the pinned SDK/fetch transport cooperating with abort; a non-cooperative fake or arbitrary thenable cannot be forcibly stopped. The deadline is not a total budget across attempts and delays. Exhaustion or a later non-retryable outcome determines the returned error from that final attempt.

An HTTP 408 is a provider response, not a local deadline: it records `provider-error` with code `provider-request-timeout`. Caller cancellation and local timeout are distinguished by first checking the caller signal; an observed caller abort wins over an SDK timeout/abort error.

### Cancellation

- An already-aborted operation performs no validation, SDK call, parser call, timer, or audit creation.
- Abort during an SDK call marks that attempt `cancelled` with code `cancelled`, preserves any decoded response snapshot, and starts no retry.
- Abort is checked after provider settlement, before and after output parsing, before retry classification, during delay, and before the next call. Once observed, no later attempt or parser invocation begins. A parser that has already begun runs to synchronous completion, but an observed abort prevents a success result.
- Cancellation rejects with category/code `cancelled`/`cancelled` and `retryable=false`. The abort reason and SDK abort message are not exposed.

If abort arrives between attempts, including during retry delay, the adapter preserves the actual completed audits unchanged and creates no fabricated attempt. The returned error is still `cancelled`; consequently the last audit can retain its earlier `provider-error` or `timeout` status. This is the interface's explicit between-attempt exception; rewriting a completed audit or inventing a provider call would violate the stronger audit-preservation contract.

Once `generate` resolves or rejects, no timer, retry, parser call, provider call, or audit mutation begins for that operation. Abort after settlement has no effect.

## Typed errors and status mapping

The adapter constructs safe internal `Error` objects satisfying `LlmError`. `code` is one of the stable lowercase values below; `message` is a fixed short summary selected by code and never includes provider text. `attempts` is always present. Except for the between-attempt cancellation exception documented above, the final attempt status and `errorCode` agree with the returned category and code.

| Condition | Category | Code | Audit status | Internal retry | Final `retryable` |
|---|---|---|---|---|---|
| Request validation failure | `invalid-request` | `invalid-request` | No attempt | No | `false` |
| Caller cancellation | `cancelled` | `cancelled` | `cancelled` for an in-flight attempt | No | `false` |
| Attempt deadline | `timeout` | `attempt-timeout` | `timeout` | Yes | `true` |
| HTTP 429 | `rate-limit` | `rate-limited` | `provider-error` | Yes | `true` |
| HTTP 408 | `provider` | `provider-request-timeout` | `provider-error` | Yes | `true` |
| HTTP 409 | `provider` | `provider-conflict` | `provider-error` | Yes | `true` |
| HTTP 5xx | `provider` | `provider-server` | `provider-error` | Yes | `true` |
| Connection failure | `provider` | `provider-connection` | `provider-error` | Yes | `true` |
| HTTP 401 or 403 | `provider` | `provider-authentication` | `provider-error` | No | `false` |
| Other known non-retryable HTTP response | `provider` | `provider-request` | `provider-error` | No | `false` |
| Unknown SDK/provider failure | `provider` | `provider-error` | `provider-error` | No | `false` |
| Undecodable successful outer response JSON | `invalid-output` | `response-json-invalid` | `invalid-output` | No | `false` |
| Missing/ambiguous choice or malformed response shape | `invalid-output` | `response-shape-invalid` | `invalid-output` | No | `false` |
| Missing structured string content | `invalid-output` | `output-missing` | `invalid-output` | No | `false` |
| `finish_reason === "length"` | `invalid-output` | `output-truncated` | `invalid-output` | No | `false` |
| Provider refusal or content filter | `invalid-output` | `output-refused` | `invalid-output` | No | `false` |
| Tool/function call instead of structured text | `invalid-output` | `output-not-text` | `invalid-output` | No | `false` |
| Malformed `message.content` JSON | `invalid-output` | `output-json-invalid` | `invalid-output` | No | `false` |
| Parsed content is not a JSON object | `invalid-output` | `output-not-object` | `invalid-output` | No | `false` |
| `parseOutput` throws | `invalid-output` | `output-rejected` | `invalid-output` | No | `false` |

`retryable` on a returned error describes a new operation; it does not ask the consumer to repeat the adapter's internal loop. A later final attempt supplies the returned error, so a timeout followed by terminal invalid output returns `invalid-output`, not `timeout`.

## Per-attempt audit and payload capture

Every started provider call produces exactly one audit, in start order, including failures before eventual success. No SDK-internal retry can create an unobserved HTTP call. Invalid requests and pre-aborted calls have empty attempt arrays. Concurrent operations have independent attempt arrays, call IDs, response pairing, and cancellation state.

Payload capture follows the caller's flag independently on every operation:

- With `capturePayload=false`, all four payload/version fields are absent from every audit. Hashing, usage, status, latency, and errors are unchanged.
- With `capturePayload=true`, every started attempt includes the version-1 `requestPayload` and `requestPayloadSchemaVersion=1`, including timeout, cancellation, and transport failure.
- `responsePayload` and `responsePayloadSchemaVersion=1` appear only when the SDK successfully decoded a successful HTTP response's complete outer body as JSON. This includes successful HTTP bodies whose structured content later fails. Malformed outer JSON, HTTP error responses, timeout, cancellation before decoding, and connection failure have no response fields. The SDK's `APIError` retains only the inner `error` value, not the complete provider error envelope, so the adapter does not mislabel that partial value as a response payload.
- Response payload schema version 1 is the plain JSON Chat Completions successful response body before `parseOutput`, including provider extension fields. It excludes response headers, SDK class instances, abort reasons, and adapter configuration. The version identifies this capture convention; it does not claim that arbitrary provider extensions share one validated schema.
- Payload and version properties are paired. Snapshots are JSON-compatible, detached from SDK/caller mutation, and never converted to explicit `null` merely because capture is unavailable.

The adapter never captures its API key, authorization headers, secret-file contents, SDK options, raw request/response headers, or raw error causes. Explicit capture permits non-secret prompt, input, schema, and provider-body data; it does not permit callers to place credentials in those values. Public error messages and codes never echo prompt, payload, response-body, or parser text.

## Provider compatibility and quirks

- The endpoint must implement non-streaming `POST /chat/completions` beneath the configured SDK base URL, Bearer authentication, `response_format={"type":"json_object"}`, and `max_completion_tokens`. Providers supporting only the Responses API, only strict `json_schema`, only legacy `max_tokens`, or no JSON mode are outside this adapter's compatibility promise and surface a safe provider error; there is no silent fallback request.
- JSON mode is not schema enforcement. Local JSON parsing and `parseOutput` remain mandatory even for providers claiming structured-output support.
- Only object-root output schemas have a JSON-mode mapping. Other root types fail before I/O; a provider returning a non-object structured value fails as `output-not-object`.
- A provider may omit usage or `x-request-id`; those audit fields remain absent. Token details and total tokens are not substituted for the required prompt/completion fields.
- Multiple choices, refusal/tool responses, truncation, empty content, and prose around JSON are invalid output rather than best-effort judgments.
- Unknown response fields survive explicit response capture but do not affect parsing. Unknown request fields and provider-specific generation options are not accepted through the public API.
- The default 60-second attempt timeout is below Node fetch's typical independent header/body inactivity limits. A much larger configured timeout can still encounter an SDK/runtime transport timeout; it is normalized as `attempt-timeout`. This adapter does not add a custom Undici dispatcher or a new transport dependency.
- WF-01 and recommendation composition must pass the configured model explicitly on every request.

## Internal subcomponents

Package-private modules cover factory/options setup, JSON validation and snapshots, canonical projection/hashing, Chat Completions mapping, SDK transport, attempt/retry orchestration, response extraction, audit construction, and safe error normalization. [arch.md](arch.md) defines their boundaries, SDK containment, tradeoffs, and fake-provider seams. These are not additional public exports or workspace libraries.

## Dependencies on other libs

- `llm-interface`

The only third-party runtime dependency is OpenAI Node SDK `7.45.1`. Node built-ins supply SHA-256, random UUIDs, monotonic durations, timers, and URL validation. The adapter does not import `retry`, `clock`, `logging`, `config`, `domain`, `reader-store`, `recommendations`, or another workspace package.

## New build or OSS wrapper

New adapter wrapping OpenAI Node SDK `7.45.1`; local structured JSON parsing and caller-owned `parseOutput` remain mandatory. No agent framework, Responses API, or second provider SDK is introduced.

## Hosted by

`services/personal-reader`; injected into `recommendations` and startup connection checks. The service reads `llm.api_key_path`, passes the secret directly to the factory, and retains ownership of composition lifecycle and audit persistence.

## Configuration

Existing keys and defaults are unchanged:

- `llm.base_url` — **required**; maps to `baseUrl`.
- `llm.api_key_path` — **required**; path to a secret file, never the secret value in centralized config. The service loads it and maps the value to `apiKey`.
- `llm.model` — **required**; the service supplies it to recommendation/connection-check consumers, which explicitly set each request's `model`. It is not an adapter option.
- `llm.timeout_ms` — **optional**, default `60000`; per-attempt deadline.
- `llm.max_retries` — **optional**, default `2`; at most three provider calls per operation.
- `llm.max_output_tokens` — **optional**, default `4096`; mapped to `max_completion_tokens` and included in request hashes.

Retry backoff constants, payload schema versions, and JSON-mode mapping are adapter-owned versioned behavior, not new configuration keys. `debug.include_llm_payloads` remains a caller/diagnostics policy and is not read by this package.

## Acceptance-focused test expectations

Package-local tests and the unmodified `llm-interface` shared-contract suite are the Batch B gate. The later workflow checks below run when their owning batches exist and are not Batch B gates.

### Public API, factory, and dependency tests

- Compile the exact factory/LlmPort surface and verify emitted runtime exports contain only `createOpenAiCompatibleLlm`. Assert the manifest has only `@tmtp/llm-interface` and `openai` dependencies and no other workspace import.
- Cover every factory rule, unknown options, safe `TypeError`/`RangeError` messages, option snapshotting, and secret sentinels. Prove invalid request models fail before I/O because the adapter has no model fallback.
- Assert client construction uses configured base URL/API key, disabled SDK retries and logging, and no Responses API, streaming, tool, or SDK parser-helper call.

### Validation, projection, and golden hashes

- Run every `llm-interface` request-boundary fixture, including pre-abort precedence, recursive non-JSON values, schema nodes, unknown properties, and post-invocation caller mutation. Add every non-object root schema type. Invalid input and unsupported root mappings perform zero provider calls and have no attempts.
- Independently compute golden SHA-256 fixtures from the exact six-field version-1 projection. Include nested reordered keys, array order, Unicode, null, negative zero, `maxOutputTokens`, and changed timeout/retry/capture/endpoint/credential values.
- Assert every retry has the same hash and captured request projection, distinct random call IDs, ordered audits, and non-negative integer per-attempt latency excluding delay.

### Wire mapping and successful responses

- Through a request journal, assert the exact two messages and separators, canonical input/schema JSON, exact model, JSON-object response format, `max_completion_tokens`, `n=1`, and `stream=false`. Verify changing `maxOutputTokens` changes both wire body and hash while capture does not change either.
- Return a structured completion with `x-request-id` and usage. Assert direct content JSON parsing, exactly one parser call with the parsed value, exact typed result identity, final success audit, usage/request-ID mapping, and no SDK instances in results.
- Cover absent/malformed usage and request IDs, header-to-completion-ID fallback, unknown provider fields, and concurrent interleaved responses without cross-operation pairing or mutation.

### Output and provider failure matrices

- Exercise undecodable outer JSON, missing/multiple choices, non-stop finish reasons, refusal, tool/function calls, missing/null content, malformed content JSON, non-object content, fenced/prose content, and throwing parsers. Include combined-invalidity fixtures to prove classification precedence. Assert exact category/code/status/retryable behavior, no retry, no raw message leakage, and correct response-capture presence.
- Exercise HTTP 400/401/403/404/408/409/422/429/500/503, connection failure, SDK timeout, and unknown SDK failure. Assert the complete error table, provider request IDs where available, no raw SDK error/cause escape, and no provider body in public error messages.

### Retry, timeout, and cancellation

- Script 429 then 500 then success with two retries: assert three real provider calls and preserved audits, final success, exact delay sequence under injected randomness, and no hidden SDK retry. Cover exhaustion, `maxRetries=0`, retry-after milliseconds/seconds/HTTP date, invalid/negative/over-60000 header fallback, and no final sleep.
- Prove invalid output, parser failure, permanent HTTP errors, and unknown failures never retry. Prove each timeout has its own deadline, stalls in both successful and non-2xx response bodies use the adapter deadline, and total elapsed operation may exceed one `timeoutMs` because of later attempts and delays.
- Cover pre-abort, abort during headers/body wait, abort after a decoded response before parsing, parser-initiated abort, abort during delay, and abort between attempts. Assert no later provider/parser/timer work, listener/timer cleanup, safe cancelled errors, and unchanged completed audits. The between-attempt test must exercise the shared contract's explicit final-status exception rather than fabricate or rewrite an audit.
- Run concurrent operations with independent and deliberately shared abort signals; settlement must freeze audit history and prevent late retries.

### Capture safety and payload versions

- For every status and multi-attempt sequence, compare capture-off and capture-on results. Capture-off omits all four fields everywhere; capture-on includes request payload/version on every attempt and response payload/version only after decoded successful outer JSON, with identical hashes and judgments.
- Include invalid structured content, malformed outer JSON, JSON/text HTTP error bodies, transport failure, timeout, and cancellation before/after decoding. Assert exact payload/version pairing, no partial API-error payload, provider extension preservation on successful bodies, detached snapshots, and response schema version `1` semantics.
- Put unique secret sentinels in API key, URL credential rejection cases, authorization headers, raw SDK error messages/causes, and parser exceptions. Assert none occur in serialized results, errors, audits, captured payloads, or SDK log output. Composition tests separately ensure callers do not put secrets in prompt/input/schema values.

### SDK integration acceptance

- Use a local fake OpenAI-compatible HTTP server to verify actual SDK `7.45.1` URL joining, Bearer authorization, content type, non-streaming request JSON, response/request-ID handling, native-retry suppression, timeout/body decoding, and disabled logging. No acceptance test requires a public provider.

### Later workflow contract checks

These checks run with the service and consumer packages in their later batches; they are not required to finish this Batch B package.

- WF-01 issues a minimal `connection-check`, proves the configured model is sent explicitly, persists a redacted audit through upper layers, and exposes safe degraded-capability errors.
- WF-06 recommendation success links to the final successful `callId`; failed scoring exposes every attempt for separate immutable persistence and never converts failure into a negative judgment.
- WF-08 with capture disabled exposes usage and safe errors only. Explicit capture adds the documented version-1 request/response payloads without changing judgment behavior, provider requests, or hashes.
