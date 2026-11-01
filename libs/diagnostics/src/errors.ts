export type DiagnosticsErrorCode = "invalid-configuration" | "invalid-input" | "debug-disabled" |
  "redaction-provider-failed" | "invalid-query" | "invalid-cursor" | "cursor-query-mismatch";
const MESSAGES: Record<DiagnosticsErrorCode, string> = {
  "invalid-configuration": "Diagnostics configuration is invalid.",
  "invalid-input": "Diagnostics input is invalid.",
  "debug-disabled": "Diagnostics debug output is disabled.",
  "redaction-provider-failed": "Diagnostics redaction provider failed.",
  "invalid-query": "Diagnostics query is invalid.",
  "invalid-cursor": "Diagnostics cursor is invalid.",
  "cursor-query-mismatch": "Diagnostics cursor does not match this query.",
};
export class DiagnosticsError extends Error {
  override readonly name = "DiagnosticsError" as const;
  constructor(readonly code: DiagnosticsErrorCode) { super(MESSAGES[code]); }
}
