import type {
  LlmErrorCategory,
  LlmCallStatus,
  LlmPurpose,
  LlmRequest,
  LlmUsage,
} from "../src/index.js";

const purposes: LlmPurpose[] = ["recommendation", "connection-check"];
const statuses: LlmCallStatus[] = [
  "success",
  "invalid-output",
  "provider-error",
  "timeout",
  "cancelled",
];
const categories: LlmErrorCategory[] = [
  "invalid-request",
  "timeout",
  "rate-limit",
  "provider",
  "invalid-output",
  "cancelled",
];
void [purposes, statuses, categories];

// @ts-expect-error Unknown purposes are rejected.
const invalidPurpose: LlmPurpose = "classification";
// @ts-expect-error Unknown statuses are rejected.
const invalidStatus: LlmCallStatus = "failed";
// @ts-expect-error Unknown categories are rejected.
const invalidCategory: LlmErrorCategory = "network";
// @ts-expect-error Token counts do not accept null.
const invalidUsage: LlmUsage = { inputTokens: null, latencyMs: 1 };
// @ts-expect-error A parser is required.
const invalidRequest: LlmRequest<string> = {
  purpose: "recommendation",
  model: "model",
  instructions: "instructions",
  input: null,
  outputSchema: { type: "string" },
  capturePayload: false,
};
void [invalidPurpose, invalidStatus, invalidCategory, invalidUsage, invalidRequest];
