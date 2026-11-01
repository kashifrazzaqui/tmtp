import { Buffer } from "node:buffer";
import type { LlmCallStatus, SchemaVersion } from "@tmtp/domain";
import type { DebugPayloadPreview } from "./types.js";
import type { Redactor } from "./redaction.js";

export interface PayloadBudget { remaining: number; exhausted: boolean; }
const SIMPLE = (state: DebugPayloadPreview["state"]): DebugPayloadPreview => ({ state, truncated: false });
export function payloadPreview(
  payload: unknown,
  schemaVersion: SchemaVersion | undefined,
  kind: "request" | "response",
  status: LlmCallStatus,
  visible: boolean,
  redactor: Redactor,
  budget: PayloadBudget,
): DebugPayloadPreview {
  if (payload === undefined || schemaVersion === undefined) return SIMPLE("not-captured");
  if (!visible) return SIMPLE("hidden-by-policy");
  if (kind === "response" && status !== "success") return SIMPLE("suppressed-error-response");
  if (budget.exhausted) return SIMPLE("omitted-budget");
  const sanitized = redactor.json(payload);
  const encoded = JSON.stringify(sanitized.value);
  if (encoded === undefined) throw new TypeError("Invalid JSON payload.");
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > 8_192) return { state: "omitted-too-large", truncated: sanitized.truncated };
  if (bytes > budget.remaining) {
    budget.remaining = 0;
    budget.exhausted = true;
    return SIMPLE("omitted-budget");
  }
  budget.remaining -= bytes;
  return { state: "included", schemaVersion, value: sanitized.value, truncated: sanitized.truncated };
}
