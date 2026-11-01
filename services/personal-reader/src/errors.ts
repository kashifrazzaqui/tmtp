import { AccessControlError } from "@tmtp/access-control";
import { ActivityError } from "@tmtp/activity";
import { DatabaseError } from "@tmtp/database";
import { DiagnosticsError } from "@tmtp/diagnostics";
import { HnIngestionError } from "@tmtp/hn-ingestion";
import { JobQueueError } from "@tmtp/job-queue";
import { PersonalizationError } from "@tmtp/personalization";
import { ReaderAppError } from "@tmtp/reader-app";

export interface SafeErrorDetails {
  operation?: string;
  field?: string;
  storyId?: number;
  jobId?: string;
  dependency?: string;
  dependencyCode?: string;
  retryAfterSeconds?: number;
}

export class ServiceError extends Error {
  override readonly name = "ServiceError" as const;

  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly retryable: boolean = false,
    readonly details: SafeErrorDetails = {},
  ) {
    super(code);
  }
}

export class ContractError extends Error {
  override readonly name = "ContractError" as const;
}

const MESSAGES: Record<string, string> = {
  "invalid-input": "The request input is invalid.",
  "invalid-query": "The request query is invalid.",
  "invalid-cursor": "The supplied cursor is invalid.",
  "authentication-required": "Authentication is required.",
  "invalid-token": "The access token is invalid.",
  "csrf-invalid": "The CSRF token is invalid.",
  "origin-invalid": "The request origin is invalid.",
  "not-found": "The requested resource was not found.",
  conflict: "The request conflicts with existing state.",
  "stale-queue-cursor": "The queue cursor is stale.",
  "invalid-transition": "The requested state transition is invalid.",
  "body-too-large": "The request body is too large.",
  "unsupported-media-type": "The request media type is unsupported.",
  "login-rate-limited": "Too many login attempts were made.",
  "account-not-configured": "The HN account is not configured.",
  "workers-stopped": "Background workers are stopped.",
  "dependency-failure": "A required dependency failed.",
  "internal-failure": "The service could not complete the request.",
};

export function messageForCode(code: string): string {
  return MESSAGES[code] ?? MESSAGES["internal-failure"]!;
}

export function safeCode(value: unknown, fallback = "unknown-error"): string {
  return typeof value === "string" && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
    ? value
    : fallback;
}

function detailsOf(error: {
  operation?: string;
  field?: string;
  storyId?: number;
  jobId?: string;
  dependency?: string;
  dependencyCode?: string;
  retryAfterSeconds?: number;
}): SafeErrorDetails {
  return {
    ...(typeof error.operation === "string" ? { operation: safeCode(error.operation) } : {}),
    ...(typeof error.field === "string" ? { field: safeCode(error.field) } : {}),
    ...(Number.isSafeInteger(error.storyId) ? { storyId: error.storyId } : {}),
    ...(typeof error.jobId === "string" ? { jobId: error.jobId } : {}),
    ...(typeof error.dependency === "string" ? { dependency: safeCode(error.dependency) } : {}),
    ...(error.dependencyCode === undefined ? {} : { dependencyCode: safeCode(error.dependencyCode) }),
    ...(Number.isSafeInteger(error.retryAfterSeconds) ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  };
}

export function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof AccessControlError) {
    if (error.code === "invalid-token") return new ServiceError("invalid-token", 401);
    if (error.code === "login-rate-limited") {
      return new ServiceError("login-rate-limited", 429, true, detailsOf(error));
    }
    return new ServiceError("internal-failure", 500);
  }
  if (error instanceof ReaderAppError) {
    const status = error.code === "invalid-input" || error.code === "invalid-cursor" ? 400
      : error.code === "not-found" ? 404
        : error.code === "conflict" || error.code === "stale-queue-cursor" || error.code === "invalid-transition" ? 409
          : 503;
    const code = error.code === "article-attempt-failed" || error.code === "cancelled" || error.code === "invalid-job"
      ? "dependency-failure"
      : error.code === "internal-failure" || error.code === "invalid-options" ? "internal-failure" : error.code;
    return new ServiceError(code, code === "internal-failure" ? 500 : status, error.retryable, detailsOf(error));
  }
  if (error instanceof HnIngestionError) {
    if (error.code === "invalid-input" || error.code === "invalid-checkpoint") {
      return new ServiceError("invalid-input", 400, false, detailsOf(error));
    }
    if (error.code === "account-not-configured") return new ServiceError("account-not-configured", 503);
    return new ServiceError(
      error.code === "internal-failure" || error.code === "invalid-configuration" ? "internal-failure" : "dependency-failure",
      error.code === "internal-failure" || error.code === "invalid-configuration" ? 500 : 503,
      error.retryable,
      detailsOf(error),
    );
  }
  if (error instanceof PersonalizationError) {
    return new ServiceError(error.code === "invalid-input" ? "invalid-input" : "dependency-failure",
      error.code === "invalid-input" ? 400 : 503, error.retryable, detailsOf(error));
  }
  if (error instanceof ActivityError) {
    return new ServiceError(error.code === "idempotency-conflict" ? "conflict" : "invalid-input",
      error.code === "idempotency-conflict" ? 409 : 400);
  }
  if (error instanceof DiagnosticsError) {
    if (error.code === "debug-disabled") return new ServiceError("not-found", 404);
    if (error.code === "invalid-cursor" || error.code === "cursor-query-mismatch") return new ServiceError("invalid-cursor", 400);
    if (error.code === "invalid-query" || error.code === "invalid-input") return new ServiceError("invalid-query", 400);
    return new ServiceError("internal-failure", 500);
  }
  if (error instanceof JobQueueError) {
    if (error.code === "invalid-transition") return new ServiceError("invalid-transition", 409, false, detailsOf(error));
    return new ServiceError("dependency-failure", 503, error.code === "lease-lost", detailsOf(error));
  }
  if (error instanceof DatabaseError) return new ServiceError("internal-failure", 500, error.retryable);
  return new ServiceError("internal-failure", 500);
}

export function errorEnvelope(error: unknown, requestId: string): {
  statusCode: number;
  body: { error: { code: string; message: string; retryable: boolean; requestId: string; details?: SafeErrorDetails } };
} {
  const mapped = toServiceError(error);
  const details = Object.fromEntries(Object.entries(mapped.details).filter(([, value]) => value !== undefined)) as SafeErrorDetails;
  return {
    statusCode: mapped.statusCode,
    body: {
      error: {
        code: safeCode(mapped.code, "internal-failure"),
        message: messageForCode(mapped.code),
        retryable: mapped.retryable,
        requestId,
        ...(Object.keys(details).length > 0 ? { details } : {}),
      },
    },
  };
}
