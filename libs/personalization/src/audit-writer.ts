import type { IsoDateTime, LlmCallRecord } from "@tmtp/domain";
import type { LlmCallAudit } from "@tmtp/llm-interface";
import type { ReaderStore } from "@tmtp/reader-store";
import { PersonalizationError } from "./errors.js";
import { wallNow } from "./time.js";
import type { PersonalizationOptions } from "./types.js";
import { validateAudits } from "./validation.js";

function mapAudit(audit: LlmCallAudit, createdAt: IsoDateTime): LlmCallRecord {
  return {
    id: audit.callId,
    purpose: audit.purpose,
    model: audit.model,
    status: audit.status,
    requestHash: audit.requestHash,
    ...(audit.usage.inputTokens === undefined ? {} : { inputTokens: audit.usage.inputTokens }),
    ...(audit.usage.outputTokens === undefined ? {} : { outputTokens: audit.usage.outputTokens }),
    latencyMs: audit.usage.latencyMs,
    ...(audit.usage.providerRequestId === undefined ? {} : { providerRequestId: audit.usage.providerRequestId }),
    ...(audit.errorCode === undefined ? {} : { errorCode: audit.errorCode }),
    ...(audit.requestPayload === undefined ? {} : { requestPayload: audit.requestPayload, requestPayloadSchemaVersion: audit.requestPayloadSchemaVersion! }),
    ...(audit.responsePayload === undefined ? {} : { responsePayload: audit.responsePayload, responsePayloadSchemaVersion: audit.responsePayloadSchemaVersion! }),
    createdAt,
  };
}
function upstream(record: LlmCallRecord): string {
  const { createdAt: _, ...content } = record;
  return JSON.stringify(content);
}

export function writeAudits(store: ReaderStore, audits: readonly LlmCallAudit[], observedAt: IsoDateTime): void {
  const ids = new Set<string>();
  for (const audit of audits) {
    if (ids.has(audit.callId)) throw new PersonalizationError("audit-conflict");
    ids.add(audit.callId);
    const candidate = mapAudit(audit, observedAt);
    const existing = store.llmCalls.byId(audit.callId);
    if (existing !== undefined) {
      if (upstream(existing) !== upstream(candidate)) throw new PersonalizationError("audit-conflict");
      continue;
    }
    store.llmCalls.insert(candidate);
  }
}

export function persistAudits(options: PersonalizationOptions, input: readonly LlmCallAudit[]): void {
  validateAudits(input);
  if (input.length === 0) return;
  const observedAt = wallNow(options.clock);
  options.store.transaction(() => { writeAudits(options.store, input, observedAt); });
}

export function persistRecommendationErrorAudits(options: PersonalizationOptions, input: readonly LlmCallAudit[]): void {
  validateAudits(input, "attempts");
  if (input.length === 0) return;
  const observedAt = wallNow(options.clock);
  options.store.transaction(() => { writeAudits(options.store, input, observedAt); });
}
