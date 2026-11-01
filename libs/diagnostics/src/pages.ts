import { createHash } from "node:crypto";
import { IsoDateTimeSchema, JobStatusSchema } from "@tmtp/domain";
import type { JobStatus } from "@tmtp/domain";
import { DiagnosticsError } from "./errors.js";
import type { Redactor } from "./redaction.js";
import type { DebugJobPageQuery, DebugPageQuery, DebugStreamQuery, DebugWindowQuery } from "./types.js";

export type DebugSectionName = "syncRuns" | "jobs" | "llmCalls" | "recentErrors" | "recommendationVersions";
export type CursorKey = [string, string] | [string, string, string, string];
export interface PagePlan {
  section: DebugSectionName;
  limit: number;
  after?: CursorKey;
  filterHash?: string;
  status?: JobStatus;
  kind?: string;
}
export type QueryPlans = Record<DebugSectionName, PagePlan>;
const NAMES: readonly DebugSectionName[] = ["syncRuns", "jobs", "llmCalls", "recentErrors", "recommendationVersions"];
function filterFingerprint(query: DebugJobPageQuery): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ kind: query.kind ?? null, status: query.status ?? null }), "utf8").digest("hex")}`;
}
function validatePage(query: DebugPageQuery | undefined, section: DebugSectionName): DebugPageQuery {
  if (query === undefined) return {};
  if (query === null || typeof query !== "object" || Array.isArray(query)) throw new DiagnosticsError("invalid-query");
  const keys = new Set(["limit", "after", ...(section === "jobs" ? ["status", "kind"] : [])]);
  if (Object.keys(query).some((key) => !keys.has(key))) throw new DiagnosticsError("invalid-query");
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50)) throw new DiagnosticsError("invalid-query");
  if (query.after !== undefined && typeof query.after !== "string") throw new DiagnosticsError("invalid-query");
  if (typeof query.after === "string" && (query.after.length === 0 || query.after.length > 16_384)) throw new DiagnosticsError("invalid-cursor");
  return query;
}
function validKey(section: DebugSectionName, key: unknown): key is CursorKey {
  if (!Array.isArray(key) || key.length !== (section === "recommendationVersions" ? 4 : 2) || key.some((value) => typeof value !== "string")) return false;
  if (section === "recommendationVersions") {
    return typeof key[0] === "string" && key[0].length >= 1 && key[0].length <= 128 &&
      key.slice(1).every((value) => typeof value === "string" && value.length >= 1 && value.length <= 256);
  }
  return IsoDateTimeSchema.safeParse(key[0]).success && typeof key[1] === "string" && key[1].length >= 1 && key[1].length <= 128;
}
function decode(after: string, plan: PagePlan): CursorKey {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(after)) throw new DiagnosticsError("invalid-cursor");
    const json = Buffer.from(after, "base64url").toString("utf8");
    const value = JSON.parse(json) as { v?: unknown; section?: unknown; filterHash?: unknown; key?: unknown };
    if (value === null || typeof value !== "object" || Array.isArray(value) || value.v !== 1 ||
      Object.keys(value).some((key) => !["v", "section", "filterHash", "key"].includes(key)) ||
      typeof value.section !== "string" || !NAMES.includes(value.section as DebugSectionName) || !validKey(plan.section, value.key)) {
      throw new DiagnosticsError("invalid-cursor");
    }
    if (value.section !== plan.section || value.filterHash !== plan.filterHash) throw new DiagnosticsError("cursor-query-mismatch");
    const canonical = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    if (canonical !== after) throw new DiagnosticsError("invalid-cursor");
    return value.key as CursorKey;
  } catch (error) {
    if (error instanceof DiagnosticsError) throw error;
    throw new DiagnosticsError("invalid-cursor");
  }
}
export function validateQuery(query: DebugWindowQuery | DebugStreamQuery | undefined, stream = false): QueryPlans {
  if (query !== undefined && (query === null || typeof query !== "object" || Array.isArray(query))) throw new DiagnosticsError("invalid-query");
  const source = query ?? {};
  if (Object.keys(source).some((key) => !NAMES.includes(key as DebugSectionName))) throw new DiagnosticsError("invalid-query");
  const plans = {} as QueryPlans;
  for (const section of NAMES) {
    const raw = source[section] as DebugPageQuery | undefined;
    if (stream && raw !== undefined && Object.prototype.hasOwnProperty.call(raw, "after")) throw new DiagnosticsError("invalid-query");
    const page = validatePage(raw, section);
    if (section === "jobs") {
      const job = page as DebugJobPageQuery;
      if (job.status !== undefined && !JobStatusSchema.safeParse(job.status).success) throw new DiagnosticsError("invalid-query");
      if (job.kind !== undefined && (typeof job.kind !== "string" || job.kind.length === 0 || job.kind.length > 64)) throw new DiagnosticsError("invalid-query");
    }
    const filterHash = section === "jobs" ? filterFingerprint(page as DebugJobPageQuery) : undefined;
    const plan: PagePlan = {
      section, limit: page.limit ?? 20,
      ...(filterHash === undefined ? {} : { filterHash }),
      ...((page as DebugJobPageQuery).status === undefined ? {} : { status: (page as DebugJobPageQuery).status }),
      ...((page as DebugJobPageQuery).kind === undefined ? {} : { kind: (page as DebugJobPageQuery).kind }),
    };
    if (page.after !== undefined) plan.after = decode(page.after, plan);
    plans[section] = plan;
  }
  return plans;
}
export function encodeCursor(plan: PagePlan, key: CursorKey, redactor: Redactor): string {
  if (!validKey(plan.section, key)) throw new TypeError("Unbounded cursor key.");
  for (const [index, value] of key.entries()) {
    const maximum = plan.section !== "recommendationVersions" && index === 1 ? 128 : index === 0 && plan.section === "recommendationVersions" ? 128 : 256;
    if (redactor.text(value, maximum) !== value) throw new TypeError("Unsafe cursor key.");
  }
  const envelope = { v: 1, section: plan.section, ...(plan.filterHash === undefined ? {} : { filterHash: plan.filterHash }), key };
  const encoded = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  if (encoded.length > 16_384) throw new TypeError("Oversized cursor.");
  return encoded;
}
export function timestampPosition(plan: PagePlan): { timestamp: string; id: string } | undefined {
  if (plan.after === undefined || plan.after.length !== 2) return undefined;
  return { timestamp: plan.after[0], id: plan.after[1] };
}
