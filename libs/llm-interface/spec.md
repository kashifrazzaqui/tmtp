# LLM Interface Library Spec

## Purpose and responsibility
Define a provider-neutral, transport-free port for structured language-model judgments and their usage metadata. It contains no SDK, retry policy, prompts, or storage.

## Public interface / API surface
```ts
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [keyword: string]: unknown;
}

export interface LlmRequest<T> {
  purpose: "recommendation" | "connection-check";
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

export interface LlmCallAudit {
  callId: string;
  purpose: string;
  model: string;
  requestHash: string;
  status: "success" | "invalid-output" | "provider-error" | "timeout" | "cancelled";
  usage: LlmUsage;
  errorCode?: string;
  requestPayload?: unknown;
  requestPayloadSchemaVersion?: number;
  responsePayload?: unknown;
  responsePayloadSchemaVersion?: number;
}

export interface LlmError extends Error {
  category: "timeout" | "rate-limit" | "provider" | "invalid-output" | "cancelled";
  attempts?: LlmCallAudit[];
  retryable: boolean;
}

export interface LlmPort {
  generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}
```

The adapter passes parsed JSON to `parseOutput`, normally a caller-owned Zod parser. Every success or failure returns audits for all attempts, including retries, with identity, request hash, status, and usage. Payloads appear only when `capturePayload=true`; secret values are excluded by construction. Consumers may validate `value` again at their own boundary.

## Internal subcomponents
None.

## Dependencies on other libs
None and no runtime dependencies, keeping the interface safe for pure recommendation logic.

## New build or OSS wrapper
New TypeScript interface only.

## Hosted by
Implemented by `llm-openai-compatible`; consumed in process by `recommendations` and startup validation.

## Configuration
None. Provider settings belong to the concrete adapter.
