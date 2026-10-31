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
