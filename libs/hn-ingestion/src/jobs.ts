import { IsoDateTimeSchema } from "@tmtp/domain";
import type { JobEnqueue, JobEnqueueResult, JobFailure, JobPayloadCodec, JobQueue } from "@tmtp/job-queue";
import { ERROR_MESSAGES, HnIngestionError, persistenceError } from "./errors.js";
import type { HnIngestionJobDescription, HnIngestionJobKind, HnIngestionOperation } from "./types.js";
export const HN_INGESTION_JOB_PAYLOAD_SCHEMA_VERSION = 1 as const;
const KINDS: readonly HnIngestionJobKind[] = ["ingestion.collect", "ingestion.reconcile-account"];
function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
function emptyPayload(payload: unknown): payload is Record<string, never> { return plainObject(payload) && Object.keys(payload).length === 0; }
function decode(payload: unknown, sourceVersion: number): Record<string, never> {
  if (sourceVersion !== 1 || !emptyPayload(payload)) throw new TypeError("Invalid HN ingestion job payload.");
  return {};
}
export const hnIngestionJobCodecs: readonly JobPayloadCodec[] = KINDS.map((kind) => ({ kind, currentVersion: 1, decode }));
export function createHnIngestionJobEnqueue(description: HnIngestionJobDescription): JobEnqueue {
  let validTime = false;
  try { validTime = IsoDateTimeSchema.safeParse(description?.runAfter).success; } catch { validTime = false; }
  if (!plainObject(description) || Object.keys(description).length !== 3 ||
    !["kind", "payload", "runAfter"].every((key) => Object.prototype.hasOwnProperty.call(description, key)) ||
    !KINDS.includes(description.kind) || !emptyPayload(description.payload) || !validTime) throw new TypeError("Invalid HN ingestion job description.");
  return { kind: description.kind, payload: {}, payloadSchemaVersion: 1, dedupeKey: description.kind, runAfter: description.runAfter };
}
export function hnIngestionJobFailure(error: unknown): JobFailure {
  if (!(error instanceof HnIngestionError) || error.code === "internal-failure") return { code: "ingestion-failed", message: "HN ingestion job failed.", retryable: true };
  const permanent = ["invalid-configuration", "invalid-input", "invalid-checkpoint", "account-not-configured"].includes(error.code);
  const suffix = error.code === "upstream-failure" ? error.dependencyCode ?? "upstream-failure" : error.code;
  return { code: `ingestion:${suffix}`, message: ERROR_MESSAGES[error.code], retryable: permanent ? false : error.retryable };
}
export function handoff(jobs: JobQueue, input: JobEnqueue, operation: HnIngestionOperation, runId: string): JobEnqueueResult {
  try { return jobs.enqueue(input); } catch (error) {
    const mapped = persistenceError(error, operation, runId, true);
    if (mapped !== undefined) throw mapped;
    throw error;
  }
}
