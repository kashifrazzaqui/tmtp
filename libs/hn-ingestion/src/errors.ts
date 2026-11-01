import { HnAccountError } from "@tmtp/hn-account";
import { HnPublicApiError } from "@tmtp/hn-public-api";
import { InterestError } from "@tmtp/interests";
import { JobQueueError } from "@tmtp/job-queue";
import { ReaderStoreError } from "@tmtp/reader-store";
import type { HnIngestionDependency, HnIngestionErrorCode, HnIngestionErrorOptions, HnIngestionOperation } from "./types.js";
export const ERROR_MESSAGES: Record<HnIngestionErrorCode, string> = {
  "invalid-configuration": "HN ingestion configuration is invalid.", "invalid-input": "HN ingestion input is invalid.",
  "invalid-checkpoint": "HN ingestion checkpoint is invalid.", "account-not-configured": "HN account reconciliation is not configured.",
  "upstream-failure": "HN ingestion upstream operation failed.", "persistence-failure": "HN ingestion persistence failed.",
  "job-handoff-failure": "HN ingestion job handoff failed.", "internal-failure": "HN ingestion failed unexpectedly.",
};
const SAFE_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export class HnIngestionError extends Error {
  override readonly name = "HnIngestionError" as const;
  readonly operation: HnIngestionOperation; readonly retryable: boolean; readonly runId?: string;
  readonly dependency?: HnIngestionDependency; readonly dependencyCode?: string;
  constructor(readonly code: HnIngestionErrorCode, options: HnIngestionErrorOptions) {
    super(ERROR_MESSAGES[code]); this.operation = options.operation; this.retryable = options.retryable;
    if (options.runId !== undefined) this.runId = options.runId;
    if (options.dependency !== undefined) this.dependency = options.dependency;
    if (options.dependencyCode !== undefined && options.dependencyCode.length <= 64 && SAFE_CODE.test(options.dependencyCode)) this.dependencyCode = options.dependencyCode;
  }
}
export class InvalidCheckpoint extends Error {}
export function checkpointError(operation: HnIngestionOperation, runId?: string): HnIngestionError {
  return new HnIngestionError("invalid-checkpoint", { operation, retryable: false, ...(runId === undefined ? {} : { runId }) });
}
interface DatabaseLike { name: string; code: string; retryable: boolean; }
function databaseError(error: unknown): DatabaseLike | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const candidate = error as Partial<DatabaseLike>;
  const codes = ["connection", "constraint", "busy", "migration", "integrity", "closed", "async-transaction", "driver", "checksum-mismatch", "invalid-order", "sql-failed", "invalid-migration"];
  return candidate.name === "DatabaseError" && typeof candidate.code === "string" && codes.includes(candidate.code) && typeof candidate.retryable === "boolean"
    ? candidate as DatabaseLike : undefined;
}
function context(operation: HnIngestionOperation, runId: string | undefined, dependency: HnIngestionDependency, error: { code: string; retryable: boolean }): HnIngestionError {
  return new HnIngestionError("upstream-failure", { operation, retryable: error.retryable, dependency, dependencyCode: error.code, ...(runId === undefined ? {} : { runId }) });
}
export function persistenceError(error: unknown, operation: HnIngestionOperation, runId: string | undefined, job = false): HnIngestionError | undefined {
  const database = databaseError(error);
  if (database !== undefined) return new HnIngestionError(job ? "job-handoff-failure" : "persistence-failure", {
    operation, retryable: database.retryable, dependency: job ? "job-queue" : "reader-store", dependencyCode: database.code,
    ...(runId === undefined ? {} : { runId }),
  });
  if (error instanceof JobQueueError) return new HnIngestionError("job-handoff-failure", { operation, retryable: false, dependency: "job-queue", dependencyCode: error.code, ...(runId === undefined ? {} : { runId }) });
  if (error instanceof ReaderStoreError) {
    const cause = databaseError(error.cause);
    return new HnIngestionError("persistence-failure", { operation, retryable: cause?.retryable ?? false, dependency: "reader-store", dependencyCode: error.code, ...(runId === undefined ? {} : { runId }) });
  }
  return undefined;
}
export function mapError(error: unknown, operation: HnIngestionOperation, runId?: string): HnIngestionError {
  if (error instanceof HnIngestionError) return error;
  if (error instanceof InvalidCheckpoint) return checkpointError(operation, runId);
  if (error instanceof HnPublicApiError) return context(operation, runId, "hn-public-api", error);
  if (error instanceof HnAccountError) return context(operation, runId, "hn-account", error);
  const persistence = persistenceError(error, operation, runId);
  if (persistence !== undefined) return persistence;
  return new HnIngestionError("internal-failure", { operation, retryable: false, ...(error instanceof InterestError ? { dependency: "interests", dependencyCode: error.code } : {}), ...(runId === undefined ? {} : { runId }) });
}
