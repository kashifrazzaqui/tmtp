import type { HnPublicApiErrorCode, HnPublicApiOperation } from "./types.js";
const MESSAGES: Record<HnPublicApiErrorCode, string> = {
  "invalid-input": "HN public API input is invalid.", "invalid-response": "HN public API returned an invalid response.",
  "http-status": "HN public API returned an unsuccessful HTTP status.", timeout: "HN public API request timed out.",
  "response-too-large": "HN public API response exceeded the byte limit.", "redirect-policy": "HN public API redirect is not allowed by origin policy.",
  "redirect-limit": "HN public API redirect limit was exceeded.", "invalid-redirect": "HN public API redirect location is invalid.",
  transport: "HN public API transport failed.", "client-closed": "HN public API HTTP client is closed.",
};
export class HnPublicApiError extends Error {
  override readonly name = "HnPublicApiError" as const;
  declare readonly status?: number;
  readonly operation: HnPublicApiOperation;
  readonly retryable: boolean;
  constructor(readonly code: HnPublicApiErrorCode, options: { operation: HnPublicApiOperation; retryable: boolean; status?: number }) {
    super(MESSAGES[code]);
    this.operation = options.operation;
    this.retryable = options.retryable;
    if (options.status !== undefined) this.status = options.status;
  }
}
export function apiError(code: HnPublicApiErrorCode, operation: HnPublicApiOperation, retryable = false, status?: number): HnPublicApiError {
  return new HnPublicApiError(code, { operation, retryable, ...(status === undefined ? {} : { status }) });
}
export class InvalidResponse extends Error {}
