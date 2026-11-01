import { ArticleFetchError } from "@tmtp/article-fetcher";
import { ArticleExtractionError } from "@tmtp/article-extractor";
import type { ArticleReadFailure, ArticleReadFailureCategory, ArticleReadFailureCode, ArticleReaderErrorCode } from "./types.js";
export class ArticleReaderError extends Error {
  override readonly name = "ArticleReaderError" as const;
  constructor(readonly code: ArticleReaderErrorCode) { super(code === "invalid-input" ? "Article reader input is invalid." : "Article reader dependency violated its contract."); }
}
const TABLE: Record<ArticleReadFailureCode, { category: ArticleReadFailureCategory; message: string; retryable: boolean }> = {
  "invalid-url": { category: "fetch", message: "Article URL is invalid.", retryable: false },
  "invalid-request": { category: "fetch", message: "Article HTTP request is invalid.", retryable: false },
  "url-policy": { category: "fetch", message: "Article URL is not allowed by policy.", retryable: false },
  "dns-timeout": { category: "fetch", message: "Article DNS resolution timed out.", retryable: true },
  "dns-failed": { category: "fetch", message: "Article DNS resolution failed.", retryable: true },
  "address-policy": { category: "fetch", message: "Article address is not globally routable.", retryable: false },
  timeout: { category: "fetch", message: "Article fetch timed out.", retryable: true },
  "response-too-large": { category: "fetch", message: "Article response exceeded a byte limit.", retryable: false },
  "redirect-limit": { category: "fetch", message: "Article redirect limit was exceeded.", retryable: false },
  "invalid-redirect": { category: "fetch", message: "Article redirect location is invalid.", retryable: false },
  "http-status": { category: "fetch", message: "Article origin returned an unsuccessful HTTP status.", retryable: false },
  "unsupported-content-type": { category: "unsupported-content", message: "Article response is not a supported HTML media type.", retryable: false },
  "unsupported-charset": { category: "unsupported-content", message: "Article response charset is not supported.", retryable: false },
  "unsupported-content-encoding": { category: "unsupported-content", message: "Article content encoding is not supported.", retryable: false },
  "invalid-content-encoding": { category: "unsupported-content", message: "Article content encoding is invalid.", retryable: false },
  "invalid-text": { category: "unsupported-content", message: "Article response is not valid UTF-8 text.", retryable: false },
  transport: { category: "fetch", message: "Article HTTP transport failed.", retryable: true },
  "client-closed": { category: "fetch", message: "Article HTTP client is closed.", retryable: false },
  "invalid-input": { category: "extraction", message: "Article extraction input is invalid.", retryable: false },
  "empty-content": { category: "empty-content", message: "Article has no readable content.", retryable: false },
  "extraction-failed": { category: "extraction", message: "Article extraction failed.", retryable: false },
  "source-too-large": { category: "extraction", message: "Article source exceeded the local input limit.", retryable: false },
};
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
export function failure(code: ArticleReadFailureCode, status?: number): ArticleReadFailure {
  const base = TABLE[code];
  return { code, ...base, retryable: code === "http-status" ? status !== undefined && RETRYABLE_STATUSES.has(status) : base.retryable,
    ...(status !== undefined && (code === "http-status" || code === "response-too-large") ? { status } : {}) };
}
export function dependencyFailure(error: unknown): ArticleReadFailure | undefined {
  if (error instanceof ArticleFetchError) return failure(error.code, error.status);
  if (error instanceof ArticleExtractionError) return failure(error.code);
  return undefined;
}
