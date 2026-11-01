import { ActivityError } from "@tmtp/activity";
import { InterestError } from "@tmtp/interests";
import { JobQueueError } from "@tmtp/job-queue";
import type { JobFailure } from "@tmtp/job-queue";
import { QueueError } from "@tmtp/queue";
import { ReaderStoreError } from "@tmtp/reader-store";
import { RecommendationError } from "@tmtp/recommendations";
import type { PersonalizationErrorCode } from "./types.js";

export const PERSONALIZATION_ERROR_MESSAGES: Record<PersonalizationErrorCode, string> = {
  "invalid-options": "Personalization options are invalid.",
  "invalid-input": "Personalization input is invalid.",
  "invalid-job": "Personalization job is invalid.",
  "activity-append-incomplete": "Activity replay data changed during append.",
  "audit-conflict": "LLM audit identity conflicts with an existing record.",
  "recommendation-conflict": "Recommendation identity conflicts with an existing record.",
  cancelled: "Personalization work was cancelled.",
  "scoring-retryable": "Recommendation work needs a later retry.",
};
const RETRYABLE = new Set<PersonalizationErrorCode>(["activity-append-incomplete", "cancelled", "scoring-retryable"]);

export class PersonalizationError extends Error {
  override readonly name = "PersonalizationError" as const;
  readonly retryable: boolean;
  readonly field?: string;
  readonly jobId?: string;
  constructor(readonly code: PersonalizationErrorCode, details: { field?: string; jobId?: string } = {}) {
    super(PERSONALIZATION_ERROR_MESSAGES[code]);
    this.retryable = RETRYABLE.has(code);
    if (details.field !== undefined) this.field = details.field;
    if (details.jobId !== undefined) this.jobId = details.jobId;
  }
}

export function invalidInput(field?: string): never { throw new PersonalizationError("invalid-input", { ...(field === undefined ? {} : { field }) }); }
export function invalidOptions(field?: string): never { throw new PersonalizationError("invalid-options", { ...(field === undefined ? {} : { field }) }); }
export function cancelled(jobId?: string): PersonalizationError { return new PersonalizationError("cancelled", { ...(jobId === undefined ? {} : { jobId }) }); }

function known(code: string, message: string, retryable = false): JobFailure {
  return { code, message, retryable };
}

interface DatabaseFailure extends Error { code: string; retryable: boolean; }
function databaseFailure(error: unknown): DatabaseFailure | undefined {
  if (!(error instanceof Error) || error.name !== "DatabaseError") return undefined;
  const candidate = error as Partial<DatabaseFailure>;
  const codes = ["connection", "constraint", "busy", "migration", "integrity", "closed", "async-transaction", "driver"];
  return typeof candidate.code === "string" && codes.includes(candidate.code) && typeof candidate.retryable === "boolean"
    ? candidate as DatabaseFailure : undefined;
}

export function personalizationJobFailure(error: unknown): JobFailure {
  if (error instanceof PersonalizationError) return known(`personalization:${error.code}`, PERSONALIZATION_ERROR_MESSAGES[error.code], error.retryable);
  if (error instanceof ActivityError) return known(`activity:${error.code}`, "Personalization activity is invalid.");
  if (error instanceof InterestError) return known(`interests:${error.code}`, "Personalization profile build failed.");
  if (error instanceof RecommendationError) return known(`recommendation:${error.code}`, "Personalization recommendation work failed.");
  if (error instanceof QueueError) return known(`queue:${error.code}`, "Personalization queue projection failed.");
  if (error instanceof ReaderStoreError) {
    return known(`reader-store:${error.code}`, "Personalization storage failed.", databaseFailure(error.cause)?.retryable ?? false);
  }
  if (error instanceof JobQueueError) return known(`job-queue:${error.code}`, "Personalization job queue failed.", error.code === "lease-lost");
  const database = databaseFailure(error);
  if (database !== undefined) return known(`database:${database.code}`, "Personalization database work failed.", database.retryable);
  return { code: "personalization-failed", message: "Personalization job failed.", retryable: true };
}
