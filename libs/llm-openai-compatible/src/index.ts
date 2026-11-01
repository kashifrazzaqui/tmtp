import type { LlmPort } from "@tmtp/llm-interface";
import { createLlmWithTransport } from "./internal.js";
import { snapshotOptions } from "./options.js";
import { createOpenAiClient, createSdkTransport } from "./transport.js";

export function createOpenAiCompatibleLlm(options: {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
}): LlmPort {
  const snapshot = snapshotOptions(options);
  const client = createOpenAiClient(snapshot);
  return createLlmWithTransport(snapshot, createSdkTransport(client));
}
