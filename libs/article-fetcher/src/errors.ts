import { HttpError } from "@tmtp/http-client";

export type ArticleFetchErrorCode =
  | "invalid-url" | "invalid-request" | "url-policy" | "dns-timeout" | "dns-failed"
  | "address-policy" | "timeout" | "response-too-large" | "redirect-limit"
  | "invalid-redirect" | "http-status" | "unsupported-content-type" | "unsupported-charset"
  | "unsupported-content-encoding" | "invalid-content-encoding" | "invalid-text"
  | "transport" | "client-closed";
const MESSAGES: Record<ArticleFetchErrorCode, string> = {
  "invalid-url": "Article URL is invalid.",
  "invalid-request": "Article HTTP request is invalid.",
  "url-policy": "Article URL is not allowed by policy.",
  "dns-timeout": "Article DNS resolution timed out.",
  "dns-failed": "Article DNS resolution failed.",
  "address-policy": "Article address is not globally routable.",
  timeout: "Article fetch timed out.",
  "response-too-large": "Article response exceeded a byte limit.",
  "redirect-limit": "Article redirect limit was exceeded.",
  "invalid-redirect": "Article redirect location is invalid.",
  "http-status": "Article origin returned an unsuccessful HTTP status.",
  "unsupported-content-type": "Article response is not a supported HTML media type.",
  "unsupported-charset": "Article response charset is not supported.",
  "unsupported-content-encoding": "Article content encoding is not supported.",
  "invalid-content-encoding": "Article content encoding is invalid.",
  "invalid-text": "Article response is not valid UTF-8 text.",
  transport: "Article HTTP transport failed.",
  "client-closed": "Article HTTP client is closed.",
};
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
export class ArticleFetchError extends Error {
  override readonly name = "ArticleFetchError" as const;
  readonly retryable: boolean;
  declare readonly status?: number;
  constructor(readonly code: ArticleFetchErrorCode, options: { retryable: boolean; status?: number }) {
    super(MESSAGES[code]);
    this.retryable = options.retryable;
    if (options.status !== undefined) this.status = options.status;
  }
}
export function failure(code: ArticleFetchErrorCode, status?: number): ArticleFetchError {
  const retryable = code === "http-status"
    ? status !== undefined && RETRYABLE_STATUSES.has(status)
    : ["dns-timeout", "dns-failed", "timeout", "transport"].includes(code);
  const includeStatus = status !== undefined && (code === "http-status" || code === "response-too-large");
  return new ArticleFetchError(code, { retryable, ...(includeStatus ? { status } : {}) });
}
export function mapHttpError(error: HttpError): ArticleFetchError {
  const code = error.code === "redirect-policy" ? "url-policy" : error.code;
  return failure(code, error.status);
}
