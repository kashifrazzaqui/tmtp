export type HnAccountErrorCode = "invalid-input" | "invalid-cursor" | "capability-disabled" | "capability-unverified" |
  "session-expired" | "username-mismatch" | "invalid-request" | "origin-policy" | "redirect-limit" | "invalid-redirect" |
  "http-status" | "response-too-large" | "timeout" | "transport" | "parse-failed" | "action-unavailable" |
  "action-conflict" | "post-outcome-unknown" | "verification-unavailable" | "cancelled-after-dispatch" | "client-closed";
const MESSAGES: Record<HnAccountErrorCode, string> = {
  "invalid-input": "HN account input is invalid.", "invalid-cursor": "HN account cursor is invalid.",
  "capability-disabled": "HN account capability is disabled.", "capability-unverified": "HN account capability is unverified.",
  "session-expired": "HN account session is expired.", "username-mismatch": "HN account username does not match.",
  "invalid-request": "HN account request is invalid.", "origin-policy": "HN account URL violates origin policy.",
  "redirect-limit": "HN account redirect limit was exceeded.", "invalid-redirect": "HN account redirect is invalid.",
  "http-status": "HN account origin returned an unsuccessful status.", "response-too-large": "HN account response exceeded the byte limit.",
  timeout: "HN account request timed out.", transport: "HN account transport failed.", "parse-failed": "HN account HTML could not be parsed.",
  "action-unavailable": "HN account action is unavailable.", "action-conflict": "HN account action conflicts with current evidence.",
  "post-outcome-unknown": "HN account action outcome is unknown.", "verification-unavailable": "HN account action could not be verified.",
  "cancelled-after-dispatch": "HN account action was cancelled after dispatch.", "client-closed": "HN account HTTP client is closed.",
};
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
export class HnAccountError extends Error {
  override readonly name = "HnAccountError" as const;
  readonly retryable: boolean;
  declare readonly status?: number;
  declare readonly storyId?: number;
  constructor(readonly code: HnAccountErrorCode, details: { status?: number; storyId?: number } = {}) {
    super(MESSAGES[code]);
    this.retryable = code === "timeout" || code === "transport" || (code === "http-status" && details.status !== undefined && RETRYABLE.has(details.status));
    if (details.status !== undefined) this.status = details.status;
    if (details.storyId !== undefined) this.storyId = details.storyId;
  }
}
export function failure(code: HnAccountErrorCode, details: { status?: number; storyId?: number } = {}): HnAccountError {
  return new HnAccountError(code, details);
}
