import { parseActivityBatch } from "@tmtp/activity";
import type { RawActivity } from "@tmtp/activity";
import {
  EvaluationStateSchema,
  HnActionKindSchema,
  IsoDateTimeSchema,
  JobSchema,
  PreferenceRuleSchema,
  QueueStateSchema,
  StoryIdSchema,
  VisibilityStateSchema,
} from "@tmtp/domain";
import type { Job, PreferenceRule, QueueState, StoryId } from "@tmtp/domain";
import type { ReaderStore } from "@tmtp/reader-store";
import { appError } from "./errors.js";
import type {
  ActivityHistoryQuery,
  HnActionCommand,
  HnActionHistoryQuery,
  ReaderAppOperation,
  ReaderQueueQuery,
  RecommendationHistoryQuery,
} from "./types.js";

export function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

export function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => required.includes(key) || optional.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

export function invalid(operation: ReaderAppOperation, field: string): never {
  throw appError("invalid-input", operation, { field, retryable: false });
}

export function validateSignal(signal: unknown, operation: ReaderAppOperation): asserts signal is AbortSignal | undefined {
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid(operation, "signal");
}

export function checkpoint(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

export function jobCheckpoint(signal: AbortSignal | undefined, jobId: string): void {
  if (signal?.aborted) throw appError("cancelled", "run-job", { retryable: true, jobId });
}

export function storyId(value: unknown, operation: ReaderAppOperation, field = "storyId"): StoryId {
  if (!StoryIdSchema.safeParse(value).success) invalid(operation, field);
  return value as StoryId;
}

export function opaqueId(value: unknown, operation: ReaderAppOperation, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\p{Cc}]/u.test(value)) invalid(operation, field);
  return value;
}

export function historyLimit(value: unknown, pageSize: number, maxPageSize: number, operation: ReaderAppOperation): number {
  if (value === undefined) return pageSize;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maxPageSize) invalid(operation, "limit");
  return value as number;
}

export interface NormalizedQueueQuery {
  state?: QueueState;
  evaluationState?: "pending" | "scored" | "failed";
  visibilityState: "visible" | "blacklisted";
  cursor?: string;
  limit: number;
}

export function queueQuery(value: unknown, pageSize: number, maxPageSize: number): NormalizedQueueQuery {
  const operation = "get-queue";
  if (value === undefined) return { visibilityState: "visible", limit: pageSize };
  if (!plainObject(value) || !exactKeys(value, [], ["state", "evaluationState", "visibilityState", "cursor", "limit"])) invalid(operation, "query");
  const query = value as ReaderQueueQuery;
  if (query.state !== undefined && !QueueStateSchema.safeParse(query.state).success) invalid(operation, "state");
  if (query.evaluationState !== undefined && !EvaluationStateSchema.safeParse(query.evaluationState).success) invalid(operation, "evaluationState");
  if (query.visibilityState !== undefined && !VisibilityStateSchema.safeParse(query.visibilityState).success) invalid(operation, "visibilityState");
  if (query.cursor !== undefined && (typeof query.cursor !== "string" || query.cursor.length === 0 || query.cursor.length > 4096)) {
    throw appError("invalid-cursor", operation, { field: "cursor", retryable: false });
  }
  return {
    ...(query.state === undefined ? {} : { state: query.state }),
    ...(query.evaluationState === undefined ? {} : { evaluationState: query.evaluationState }),
    visibilityState: query.visibilityState ?? "visible",
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    limit: historyLimit(query.limit, pageSize, maxPageSize, operation),
  };
}

export function recommendationHistoryQuery(value: unknown, pageSize: number, maxPageSize: number): Required<Pick<RecommendationHistoryQuery, "storyId" | "limit">> & Pick<RecommendationHistoryQuery, "afterId"> {
  const operation = "get-recommendation-history";
  if (!plainObject(value) || !exactKeys(value, ["storyId"], ["afterId", "limit"])) invalid(operation, "query");
  const query = value as unknown as RecommendationHistoryQuery;
  return {
    storyId: storyId(query.storyId, operation),
    ...(query.afterId === undefined ? {} : { afterId: opaqueId(query.afterId, operation, "afterId") }),
    limit: historyLimit(query.limit, pageSize, maxPageSize, operation),
  };
}

export function hnHistoryQuery(value: unknown, pageSize: number, maxPageSize: number): Required<Pick<HnActionHistoryQuery, "storyId" | "limit">> & Pick<HnActionHistoryQuery, "afterId"> {
  const operation = "get-hn-action-history";
  if (!plainObject(value) || !exactKeys(value, ["storyId"], ["afterId", "limit"])) invalid(operation, "query");
  const query = value as unknown as HnActionHistoryQuery;
  return {
    storyId: storyId(query.storyId, operation),
    ...(query.afterId === undefined ? {} : { afterId: opaqueId(query.afterId, operation, "afterId") }),
    limit: historyLimit(query.limit, pageSize, maxPageSize, operation),
  };
}

export interface NormalizedActivityQuery {
  storyId?: StoryId;
  clientEventId?: string;
  afterEventId?: string;
  afterSessionId?: string;
  limit: number;
}
export function activityHistoryQuery(value: unknown, pageSize: number, maxPageSize: number): NormalizedActivityQuery {
  const operation = "get-activity";
  if (value === undefined) return { limit: pageSize };
  if (!plainObject(value) || !exactKeys(value, [], ["storyId", "clientEventId", "afterEventId", "afterSessionId", "limit"])) invalid(operation, "query");
  const query = value as ActivityHistoryQuery;
  if (query.clientEventId !== undefined && (typeof query.clientEventId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(query.clientEventId))) invalid(operation, "clientEventId");
  if (query.afterEventId !== undefined && (typeof query.afterEventId !== "string" || !/^evt_[A-Za-z0-9_-]{43}$/.test(query.afterEventId))) invalid(operation, "afterEventId");
  if (query.afterSessionId !== undefined && (typeof query.afterSessionId !== "string" || !/^ses_[A-Za-z0-9_-]{43}$/.test(query.afterSessionId))) invalid(operation, "afterSessionId");
  return {
    ...(query.storyId === undefined ? {} : { storyId: storyId(query.storyId, operation) }),
    ...(query.clientEventId === undefined ? {} : { clientEventId: query.clientEventId }),
    ...(query.afterEventId === undefined ? {} : { afterEventId: query.afterEventId }),
    ...(query.afterSessionId === undefined ? {} : { afterSessionId: query.afterSessionId }),
    limit: historyLimit(query.limit, pageSize, maxPageSize, operation),
  };
}

export function queueState(value: unknown): QueueState {
  if (!QueueStateSchema.safeParse(value).success) invalid("set-queue-state", "state");
  return value as QueueState;
}

export function hnActionCommand(value: unknown): HnActionCommand {
  const operation = "perform-hn-action";
  if (!plainObject(value) || !exactKeys(value, ["storyId", "action", "idempotencyKey"])) invalid(operation, "command");
  const command = value as unknown as HnActionCommand;
  if (!HnActionKindSchema.safeParse(command.action).success) invalid(operation, "action");
  if (typeof command.idempotencyKey !== "string" || command.idempotencyKey.length < 1 || command.idempotencyKey.length > 128 ||
    command.idempotencyKey.trim().length === 0 || /[\p{Cc}]/u.test(command.idempotencyKey)) invalid(operation, "idempotencyKey");
  return {
    storyId: storyId(command.storyId, operation),
    action: command.action,
    idempotencyKey: command.idempotencyKey,
  };
}

export function activityBatch(value: unknown): readonly RawActivity[] {
  if (!Array.isArray(value)) invalid("record-activity", "batch");
  try {
    return parseActivityBatch(value);
  } catch {
    invalid("record-activity", "batch");
  }
}

export function preferenceRules(value: unknown): readonly PreferenceRule[] {
  if (!Array.isArray(value)) invalid("replace-preferences", "rules");
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid("replace-preferences", `rules.${index}`);
    try {
      if (!PreferenceRuleSchema.safeParse(value[index]).success) invalid("replace-preferences", `rules.${index}`);
    } catch (error) {
      if (error instanceof RangeError) invalid("replace-preferences", `rules.${index}`);
      throw error;
    }
  }
  return value as readonly PreferenceRule[];
}

export function rebuildReason(value: unknown): string {
  if (typeof value !== "string" || value.length > 200 || value.trim().length === 0) invalid("rebuild-personalization", "reason");
  return value;
}

export function leasedJob(value: unknown): Job {
  let valid = false;
  try { valid = JobSchema.safeParse(value).success; } catch { valid = false; }
  const id = plainObject(value) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256 ? value.id : undefined;
  if (!valid || (value as Job).status !== "leased" || (value as Job).attempts < 1 || (value as Job).attempts > (value as Job).maxAttempts) {
    throw appError("invalid-job", "run-job", { retryable: false, ...(id === undefined ? {} : { jobId: id }) });
  }
  return value as Job;
}

export function validIso(value: unknown): value is string {
  try { return IsoDateTimeSchema.safeParse(value).success; } catch { return false; }
}

export function timestamp(now: () => Date, operation: ReaderAppOperation, notBefore?: string): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw appError("internal-failure", operation, { retryable: false });
  const iso = value.toISOString();
  if (!validIso(iso)) throw appError("internal-failure", operation, { retryable: false });
  if (notBefore !== undefined && Date.parse(iso) < Date.parse(notBefore)) return notBefore;
  return iso;
}

export function newIntentId(createId: () => string): string {
  const id = createId();
  if (typeof id !== "string" || id.length === 0 || id.length > 128) throw appError("internal-failure", "perform-hn-action", { retryable: false });
  return id;
}

export function requireStory(store: ReaderStore, id: StoryId, operation: ReaderAppOperation): NonNullable<ReturnType<ReaderStore["stories"]["byId"]>> {
  const story = store.stories.byId(id);
  if (story === undefined) throw appError("not-found", operation, { storyId: id, retryable: false });
  return story;
}
