import { ActivityError } from "@tmtp/activity";
import { ArticleReaderError } from "@tmtp/article-reader";
import { StoryIdSchema } from "@tmtp/domain";
import { HnAccountError } from "@tmtp/hn-account";
import { HnIngestionError } from "@tmtp/hn-ingestion";
import { JobQueueError } from "@tmtp/job-queue";
import type { JobFailure } from "@tmtp/job-queue";
import { PersonalizationError, personalizationJobFailure } from "@tmtp/personalization";
import { QueueError } from "@tmtp/queue";
import { ReaderStoreError } from "@tmtp/reader-store";
import { hnIngestionJobFailure } from "@tmtp/hn-ingestion";
import type {
  ReaderAppDependency,
  ReaderAppErrorCode,
  ReaderAppErrorOptions,
  ReaderAppOperation,
} from "./types.js";

export const ERROR_MESSAGES: Record<ReaderAppErrorCode, string> = {
  "invalid-options": "Reader application options are invalid.",
  "invalid-input": "Reader application input is invalid.",
  "not-found": "Reader application resource was not found.",
  conflict: "Reader application command conflicts with stored state.",
  "invalid-cursor": "Reader application cursor is invalid.",
  "stale-queue-cursor": "Reader queue changed; restart pagination.",
  "invalid-transition": "Reader queue state transition is invalid.",
  "account-not-configured": "HN account integration is not configured.",
  "article-attempt-failed": "Article extraction attempt failed.",
  "invalid-job": "Reader application job is invalid.",
  "dependency-failure": "Reader application dependency operation failed.",
  cancelled: "Reader application operation was cancelled.",
  "internal-failure": "Reader application failed unexpectedly.",
};

const OPERATIONS = new Set<ReaderAppOperation>([
  "get-queue", "get-story", "get-recommendation-history", "get-hn-action-history", "get-activity",
  "set-queue-state", "refresh-article", "record-activity", "get-preferences", "replace-preferences",
  "rebuild-personalization", "run-personalization", "get-hn-capabilities", "perform-hn-action",
  "run-ingestion", "schedule-ingestion", "reconcile-hn-account", "schedule-hn-reconciliation", "run-job",
]);
const DEPENDENCIES = new Set<ReaderAppDependency>([
  "activity", "article-reader", "hn-account", "hn-ingestion", "job-queue", "personalization", "queue", "reader-store",
]);
const SAFE_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function safeDependencyCode(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && SAFE_CODE.test(value);
}

export class ReaderAppError extends Error {
  override readonly name = "ReaderAppError" as const;
  readonly code: ReaderAppErrorCode;
  readonly operation: ReaderAppOperation;
  readonly retryable: boolean;
  readonly field?: string;
  readonly storyId?: number;
  readonly jobId?: string;
  readonly dependency?: ReaderAppDependency;
  readonly dependencyCode?: string;

  constructor(code: ReaderAppErrorCode, options: ReaderAppErrorOptions) {
    if (!Object.hasOwn(ERROR_MESSAGES, code) || options === null || typeof options !== "object" ||
      !OPERATIONS.has(options.operation) || typeof options.retryable !== "boolean") {
      throw new TypeError("Invalid reader application error options.");
    }
    super(ERROR_MESSAGES[code]);
    this.code = code;
    this.operation = options.operation;
    this.retryable = options.retryable;
    if (typeof options.field === "string" && options.field.length > 0 && options.field.length <= 128) this.field = options.field;
    if (StoryIdSchema.safeParse(options.storyId).success) this.storyId = options.storyId!;
    if (typeof options.jobId === "string" && options.jobId.length > 0 && options.jobId.length <= 256) this.jobId = options.jobId;
    if (options.dependency !== undefined && DEPENDENCIES.has(options.dependency)) this.dependency = options.dependency;
    if (safeDependencyCode(options.dependencyCode)) this.dependencyCode = options.dependencyCode;
  }
}

export function appError(
  code: ReaderAppErrorCode,
  operation: ReaderAppOperation,
  details: Partial<Omit<ReaderAppErrorOptions, "operation" | "retryable">> & { retryable?: boolean } = {},
): ReaderAppError {
  return new ReaderAppError(code, {
    operation,
    retryable: details.retryable ?? code === "cancelled",
    ...(details.field === undefined ? {} : { field: details.field }),
    ...(details.storyId === undefined ? {} : { storyId: details.storyId }),
    ...(details.jobId === undefined ? {} : { jobId: details.jobId }),
    ...(details.dependency === undefined ? {} : { dependency: details.dependency }),
    ...(details.dependencyCode === undefined ? {} : { dependencyCode: details.dependencyCode }),
  });
}

interface DatabaseLike {
  name: string;
  code: string;
  retryable: boolean;
}
function databaseError(error: unknown): DatabaseLike | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const candidate = error as Partial<DatabaseLike>;
  const codes = ["connection", "constraint", "busy", "migration", "integrity", "closed", "async-transaction", "driver"];
  return candidate.name === "DatabaseError" && typeof candidate.code === "string" && codes.includes(candidate.code) &&
    typeof candidate.retryable === "boolean" ? candidate as DatabaseLike : undefined;
}

function dependencyFailure(
  operation: ReaderAppOperation,
  dependency: ReaderAppDependency,
  code: string,
  retryable: boolean,
  details: { field?: string; storyId?: number; jobId?: string } = {},
): ReaderAppError {
  return appError("dependency-failure", operation, {
    retryable,
    dependency,
    dependencyCode: safeDependencyCode(code) ? code : "dependency-error",
    ...details,
  });
}

export function translateError(
  error: unknown,
  operation: ReaderAppOperation,
  defaultDependency: ReaderAppDependency,
  context: { field?: string; storyId?: number; jobId?: string } = {},
): unknown {
  if (error instanceof ReaderAppError) return error;
  if (error instanceof QueueError && error.code === "invalid-transition") {
    return appError("invalid-transition", operation, {
      ...(error.storyId ?? context.storyId) === undefined ? {} : { storyId: (error.storyId ?? context.storyId)! },
    });
  }
  if (error instanceof ReaderStoreError && error.code === "not-found") {
    return appError("not-found", operation, context);
  }
  if (error instanceof HnIngestionError && error.code === "account-not-configured") {
    return appError("account-not-configured", operation, { retryable: false });
  }
  if (error instanceof PersonalizationError && error.code === "cancelled") return error;
  if (error instanceof ReaderStoreError) {
    return dependencyFailure(operation, "reader-store", error.code, databaseError(error.cause)?.retryable ?? false, context);
  }
  if (error instanceof JobQueueError) {
    return dependencyFailure(operation, "job-queue", error.code, error.code === "lease-lost", {
      ...context,
      ...(error.jobId === undefined ? {} : { jobId: error.jobId }),
    });
  }
  if (error instanceof HnIngestionError) {
    return dependencyFailure(operation, "hn-ingestion", error.code, error.retryable, context);
  }
  if (error instanceof PersonalizationError) {
    return dependencyFailure(operation, "personalization", error.code, error.retryable, {
      ...context,
      ...(error.field === undefined ? {} : { field: error.field }),
      ...(error.jobId === undefined ? {} : { jobId: error.jobId }),
    });
  }
  if (error instanceof ActivityError) return dependencyFailure(operation, "activity", error.code, false, context);
  if (error instanceof HnAccountError) {
    return dependencyFailure(operation, "hn-account", error.code, error.retryable, {
      ...context,
      ...(error.storyId === undefined ? {} : { storyId: error.storyId }),
    });
  }
  if (error instanceof ArticleReaderError) return dependencyFailure(operation, "article-reader", error.code, false, context);
  if (error instanceof QueueError) return dependencyFailure(operation, "queue", error.code, false, context);
  const database = databaseError(error);
  if (database !== undefined) return dependencyFailure(operation, defaultDependency, database.code, database.retryable, context);
  return appError("internal-failure", operation, { retryable: false, ...context });
}

export async function boundary<T>(
  operation: ReaderAppOperation,
  dependency: ReaderAppDependency,
  work: () => T | Promise<T>,
  context: { field?: string; storyId?: number; jobId?: string } = {},
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw translateError(error, operation, dependency, context);
  }
}

export function mapKnownFailure(error: ReaderAppError): JobFailure {
  const base = { message: ERROR_MESSAGES[error.code], retryable: error.retryable };
  switch (error.code) {
    case "invalid-job": return { ...base, code: "invalid-job", retryable: false };
    case "not-found": return { ...base, code: "not-found", retryable: false };
    case "cancelled": return { ...base, code: "cancelled", retryable: true };
    case "dependency-failure": return { ...base, code: "reader-app:dependency-failure" };
    case "internal-failure": return { code: "reader-app-failed", message: "Reader application job failed.", retryable: true };
    default: return { ...base, code: `reader-app:${error.code}` };
  }
}

export function failureForKinds(
  kind: string,
  error: unknown,
  supported: ReadonlySet<string>,
  personalizationKinds: ReadonlySet<string>,
  ingestionKinds: ReadonlySet<string>,
): JobFailure {
  if (!supported.has(kind)) return { code: "invalid-job", message: ERROR_MESSAGES["invalid-job"], retryable: false };
  if (kind === "article.fetch-extract" && error instanceof ReaderAppError && error.code === "article-attempt-failed") {
    return {
      code: safeDependencyCode(error.dependencyCode) ? `article:${error.dependencyCode}` : "article-attempt-failed",
      message: ERROR_MESSAGES["article-attempt-failed"],
      retryable: error.retryable,
    };
  }
  if (error instanceof ReaderAppError) return mapKnownFailure(error);
  if (kind === "personalization.record-activity" || personalizationKinds.has(kind)) return personalizationJobFailure(error);
  if (ingestionKinds.has(kind)) return hnIngestionJobFailure(error);
  return { code: "reader-app-failed", message: "Reader application job failed.", retryable: true };
}
