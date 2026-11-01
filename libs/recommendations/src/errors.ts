import type { LlmCallAudit } from "@tmtp/llm-interface";
import type { RecommendationErrorCode } from "./types.js";
const MESSAGES: Record<RecommendationErrorCode, string> = {
  "invalid-input": "Recommendation input is invalid.", "llm-contract": "The LLM port violated its contract.",
};
export class RecommendationError extends Error {
  override readonly name = "RecommendationError" as const;
  readonly attempts: LlmCallAudit[];
  declare readonly field?: string;
  constructor(readonly code: RecommendationErrorCode, details: { field?: string; attempts?: readonly LlmCallAudit[] } = {}) {
    super(MESSAGES[code]);
    this.attempts = [...(details.attempts ?? [])];
    if (details.field !== undefined) this.field = details.field;
  }
}
export function invalidInput(field?: string): never { throw new RecommendationError("invalid-input", { ...(field === undefined ? {} : { field }), attempts: [] }); }
export function llmContract(attempts: readonly LlmCallAudit[]): never { throw new RecommendationError("llm-contract", { attempts }); }
