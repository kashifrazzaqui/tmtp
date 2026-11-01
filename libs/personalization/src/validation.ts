import { IsoDateTimeSchema, PreferenceRuleSchema } from "@tmtp/domain";
import type { PreferenceRule } from "@tmtp/domain";
import type { LlmCallAudit } from "@tmtp/llm-interface";
import { invalidInput, invalidOptions } from "./errors.js";
import type { PersonalizationOptions } from "./types.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function plainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
export function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => required.includes(key) || optional.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}
export function validReason(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && value.trim().length > 0;
}
export function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
export function validateReason(value: unknown): asserts value is string { if (!validReason(value)) invalidInput("reason"); }
export function validateSignal(signal: unknown): asserts signal is AbortSignal | undefined {
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalidInput("signal");
}
export function validateRules(value: unknown): asserts value is readonly PreferenceRule[] {
  if (!Array.isArray(value)) invalidInput("rules");
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalidInput(`rules.${index}`);
    try {
      if (!PreferenceRuleSchema.safeParse(value[index]).success) invalidInput(`rules.${index}`);
    } catch (error) {
      if (error instanceof RangeError) invalidInput(`rules.${index}`);
      throw error;
    }
  }
}

function method(value: unknown, field: string, fail: (field: string) => never): void {
  if (typeof value !== "function") fail(field);
}
function dependency(value: unknown, field: string, methods: Record<string, readonly string[]>): void {
  if (!isObject(value)) invalidOptions(field);
  for (const [key, children] of Object.entries(methods)) {
    const member = value[key];
    if (children.length === 0) { method(member, `${field}.${key}`, invalidOptions); continue; }
    if (!isObject(member)) invalidOptions(`${field}.${key}`);
    for (const child of children) method(member[child], `${field}.${key}.${child}`, invalidOptions);
  }
}
function positiveInteger(value: unknown, field: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalidOptions(field);
}
function policyObject(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (!plainObject(value) || !exactKeys(value, keys)) invalidOptions(field);
  return value;
}

const OPTION_KEYS = ["store", "jobs", "llm", "model", "clock", "activityPolicy", "interestPolicy", "recommendationPolicy", "activityBatchSize", "queueSyncBatchSize"];
export function validateOptions(options: PersonalizationOptions): void {
  if (!plainObject(options) || !exactKeys(options, OPTION_KEYS)) invalidOptions("options");
  dependency(options.store, "store", {
    transaction: [],
    activity: ["query", "appendIdempotent", "latestWindow", "latestVersion"],
    readingSessions: ["latestForStory", "upsert"],
    stories: ["byId", "needingScoring", "forQueueProjection"],
    articles: ["byStoryId", "byStoryIds"],
    preferences: ["list", "replaceAll", "currentVersion"],
    profiles: ["current", "byVersion", "insert", "setCurrent"],
    recommendations: ["byId", "insertImmutable", "currentForStories"],
    queue: ["byStoryId", "markEvaluation", "forReprojection", "upsertRankingPreservingState", "setProjection"],
    llmCalls: ["byId", "insert"],
  });
  dependency(options.jobs, "jobs", { enqueue: [] });
  dependency(options.llm, "llm", { generate: [] });
  dependency(options.clock, "clock", { now: [] });
  if (typeof options.model !== "string" || options.model.length === 0 || options.model.trim() !== options.model) invalidOptions("model");
  positiveInteger(options.activityBatchSize, "activityBatchSize", 1);
  positiveInteger(options.queueSyncBatchSize, "queueSyncBatchSize", 1);

  const activity = policyObject(options.activityPolicy, "activityPolicy", ["idleTimeoutMs", "minDwellMs", "maxSessionGapMs"]);
  positiveInteger(activity.minDwellMs, "activityPolicy.minDwellMs", 0);
  positiveInteger(activity.idleTimeoutMs, "activityPolicy.idleTimeoutMs", 1);
  positiveInteger(activity.maxSessionGapMs, "activityPolicy.maxSessionGapMs", 1);
  if ((activity.minDwellMs as number) > (activity.idleTimeoutMs as number) || (activity.idleTimeoutMs as number) > (activity.maxSessionGapMs as number)) invalidOptions("activityPolicy");

  const interest = policyObject(options.interestPolicy, "interestPolicy", ["decayHalfLifeDays", "maxInferredTopics", "maxActivityEvents"]);
  if (typeof interest.decayHalfLifeDays !== "number" || !Number.isFinite(interest.decayHalfLifeDays) || interest.decayHalfLifeDays <= 0) invalidOptions("interestPolicy.decayHalfLifeDays");
  positiveInteger(interest.maxInferredTopics, "interestPolicy.maxInferredTopics", 0);
  positiveInteger(interest.maxActivityEvents, "interestPolicy.maxActivityEvents", 0);

  const recommendation = policyObject(options.recommendationPolicy, "recommendationPolicy", ["batchSize", "maxStoriesPerRun", "maxPromptChars", "explorationRatio", "capturePayloads"]);
  positiveInteger(recommendation.batchSize, "recommendationPolicy.batchSize", 1);
  positiveInteger(recommendation.maxStoriesPerRun, "recommendationPolicy.maxStoriesPerRun", 0);
  positiveInteger(recommendation.maxPromptChars, "recommendationPolicy.maxPromptChars", 1);
  if (typeof recommendation.explorationRatio !== "number" || !Number.isFinite(recommendation.explorationRatio) || recommendation.explorationRatio < 0 || recommendation.explorationRatio > 0.5) invalidOptions("recommendationPolicy.explorationRatio");
  if (typeof recommendation.capturePayloads !== "boolean") invalidOptions("recommendationPolicy.capturePayloads");
}

function validJson(value: unknown, ancestors = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === "length") continue;
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length || !descriptor.enumerable || !("value" in descriptor)) { valid = false; break; }
    }
    if (valid) for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !validJson(value[index], ancestors)) { valid = false; break; }
    }
  } else {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0 || Object.hasOwn(value, "toJSON")) valid = false;
    if (valid) for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !("value" in descriptor) || !validJson(descriptor.value, ancestors)) { valid = false; break; }
    }
  }
  ancestors.delete(value);
  return valid;
}

const STATUSES = new Set(["success", "invalid-output", "provider-error", "timeout", "cancelled"]);
function optionalNumber(value: unknown): boolean { return value === undefined || Number.isSafeInteger(value) && (value as number) >= 0; }
function payloadPair(audit: Record<string, unknown>, payload: string, version: string): boolean {
  const hasPayload = Object.hasOwn(audit, payload);
  const hasVersion = Object.hasOwn(audit, version);
  return hasPayload === hasVersion && (!hasPayload || audit[payload] !== null && audit[payload] !== undefined &&
    Number.isSafeInteger(audit[version]) && (audit[version] as number) >= 1 && validJson(audit[payload]));
}
function validAudit(value: unknown): value is LlmCallAudit {
  if (!plainObject(value) ||
    typeof value.callId !== "string" || value.callId.length === 0 ||
    value.purpose !== "recommendation" && value.purpose !== "connection-check" ||
    typeof value.model !== "string" || value.model.length === 0 || value.model.trim() !== value.model ||
    typeof value.requestHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.requestHash) ||
    typeof value.status !== "string" || !STATUSES.has(value.status) || !plainObject(value.usage)) return false;
  if (value.status === "success" ? Object.hasOwn(value, "errorCode") :
    typeof value.errorCode !== "string" || value.errorCode.length === 0) return false;
  const usage = value.usage;
  if (!optionalNumber(usage.inputTokens) || !optionalNumber(usage.outputTokens) ||
    !Number.isSafeInteger(usage.latencyMs) || (usage.latencyMs as number) < 0 ||
    Object.hasOwn(usage, "providerRequestId") && (typeof usage.providerRequestId !== "string" || usage.providerRequestId.length === 0)) return false;
  return payloadPair(value, "requestPayload", "requestPayloadSchemaVersion") && payloadPair(value, "responsePayload", "responsePayloadSchemaVersion");
}

export function validateAudits(value: unknown, field = "audits"): asserts value is readonly LlmCallAudit[] {
  if (!Array.isArray(value)) invalidInput(field);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !validAudit(value[index])) invalidInput(`${field}.${index}`);
  }
}

export function validIsoDateTime(value: unknown): value is string {
  try { return IsoDateTimeSchema.safeParse(value).success; } catch { return false; }
}
