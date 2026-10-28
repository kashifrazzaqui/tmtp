# OpenAI-Compatible LLM Adapter Spec

## Purpose and responsibility
Implement `llm-interface` for a configured OpenAI-compatible endpoint and API token, including structured response parsing and provider usage metadata.

## Public interface / API surface
```ts
export function createOpenAiCompatibleLlm(options: {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
}): import("@tmtp/llm-interface").LlmPort;
```

The adapter uses Chat Completions structured-output parsing for broad endpoint compatibility, then invokes the request's `parseOutput` callback on returned JSON. It does not assume the Responses API or strict provider-side schema support. The result/error `attempts` array retains every `LlmCallAudit`, including retries; request hashes cover the canonical non-secret request projection, and optional payloads follow `capturePayload`.

## Internal subcomponents
- SDK client construction and request mapping.
- Structured output parsing and local validation.
- Error/usage normalization without payload logging.

## Dependencies on other libs
- `llm-interface`

## New build or OSS wrapper
New adapter wrapping OpenAI Node SDK `7.45.1`.

## Hosted by
`services/personal-reader`; injected into `recommendations` and startup checks.

## Configuration
- `llm.base_url` — **required**.
- `llm.api_key_path` — **required**; path to a secret file, never the secret value in centralized config.
- `llm.model` — **required**.
- `llm.timeout_ms` — **optional**, default `60000`.
- `llm.max_retries` — **optional**, default `2`.
- `llm.max_output_tokens` — **optional**, default `4096`.
