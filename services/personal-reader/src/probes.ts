import type { LlmCallAudit } from "@tmtp/llm-interface";
import { PersonalizationError } from "@tmtp/personalization";
import type { ServiceGraph } from "./composition.js";

export interface ProbeResults {
  llm: boolean;
  hnPublic: boolean;
  hnAccount?: boolean;
  article: "not-checked";
}

function auditsOf(error: unknown): readonly LlmCallAudit[] | undefined {
  if (error === null || typeof error !== "object" || !("attempts" in error) || !Array.isArray(error.attempts)) return undefined;
  if (!("category" in error) || typeof error.category !== "string" || !("code" in error) || typeof error.code !== "string") return undefined;
  const validAudits = error.attempts.every((attempt) => {
    if (attempt === null || typeof attempt !== "object" || Array.isArray(attempt)) return false;
    const candidate = attempt as Partial<LlmCallAudit>;
    return typeof candidate.callId === "string" && typeof candidate.purpose === "string" && typeof candidate.model === "string" &&
      typeof candidate.requestHash === "string" && typeof candidate.status === "string" &&
      candidate.usage !== null && typeof candidate.usage === "object" && Number.isSafeInteger(candidate.usage.latencyMs);
  });
  if (!validAudits) return undefined;
  return error.attempts as readonly LlmCallAudit[];
}

function looksLikeLlmError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "category" in error && "code" in error && "attempts" in error;
}

type AuditPersistence = "persisted" | "invalid" | "failed";

async function persistAudits(graph: ServiceGraph, audits: readonly LlmCallAudit[]): Promise<AuditPersistence> {
  try {
    await graph.personalization.persistLlmAudits(audits);
    return "persisted";
  } catch (error) {
    if (error instanceof PersonalizationError && error.code === "invalid-input") return "invalid";
    graph.health.sqliteFailed();
    return "failed";
  }
}

async function probeLlm(graph: ServiceGraph, signal: AbortSignal): Promise<boolean> {
  let failure: unknown = { code: "invalid-response" };
  try {
    const result = await graph.llm.generate({
      purpose: "connection-check",
      model: graph.config.llm.model,
      instructions: "Return the smallest valid connection acknowledgment.",
      input: {},
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      parseOutput(value: unknown): { ok: true } {
        if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 ||
          (value as { ok?: unknown }).ok !== true) throw new Error("Invalid connection acknowledgment.");
        return { ok: true };
      },
      capturePayload: false,
      signal,
    });
    const persistence = await persistAudits(graph, result.attempts);
    if (persistence === "failed") return false;
    if (persistence === "persisted") {
      if (!signal.aborted) graph.integrations.available("llm", graph.clock.now().toISOString());
      return true;
    }
  } catch (error) {
    const audits = auditsOf(error);
    if (audits === undefined) {
      if (!looksLikeLlmError(error)) failure = error;
    } else {
      const persistence = await persistAudits(graph, audits);
      if (persistence === "failed") return false;
      if (persistence === "persisted") failure = error;
    }
  }
  if (!signal.aborted) graph.integrations.failed("llm", failure, graph.clock.now().toISOString());
  return false;
}

async function probePublic(graph: ServiceGraph, signal: AbortSignal): Promise<boolean> {
  try {
    await graph.hnPublic.maxItemId(signal);
    if (!signal.aborted) graph.integrations.available("hnPublic", graph.clock.now().toISOString());
    return true;
  } catch (error) {
    if (!signal.aborted) graph.integrations.failed("hnPublic", error, graph.clock.now().toISOString());
    return false;
  }
}

async function probeAccount(graph: ServiceGraph, signal: AbortSignal): Promise<boolean | undefined> {
  if (graph.account === undefined) return undefined;
  try {
    await graph.account.validateSession(signal);
    if (!signal.aborted) graph.integrations.available("hnAccount", graph.clock.now().toISOString());
    return true;
  } catch (error) {
    if (!signal.aborted) graph.integrations.failed("hnAccount", error, graph.clock.now().toISOString());
    return false;
  }
}

export async function runCapabilityProbes(graph: ServiceGraph, signal: AbortSignal): Promise<ProbeResults> {
  const [llm, hnPublic, hnAccount] = await Promise.all([
    probeLlm(graph, signal),
    probePublic(graph, signal),
    probeAccount(graph, signal),
  ]);
  return { llm, hnPublic, ...(hnAccount === undefined ? {} : { hnAccount }), article: "not-checked" };
}
