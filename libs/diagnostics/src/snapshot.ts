import type { Clock } from "@tmtp/clock";
import type { DiagnosticError, IngestionRun, InterestProfile, Job, LlmCallRecord, RecommendationVersionCount } from "@tmtp/domain";
import type { JobQueue } from "@tmtp/job-queue";
import type { ReaderStore } from "@tmtp/reader-store";
import type { DebugError, DebugJob, DebugLlmCall, DebugPage, DebugProfile, DebugRecommendationVersionCount, DebugSection, DebugSnapshot, DebugSyncRun, QueueEvaluationCounts } from "./types.js";
import { Redactor, providerInventory } from "./redaction.js";
import { payloadPreview } from "./payloads.js";
import type { PayloadBudget } from "./payloads.js";
import { encodeCursor, timestampPosition } from "./pages.js";
import type { CursorKey, PagePlan, QueryPlans } from "./pages.js";

interface SnapshotDependencies {
  store: ReaderStore;
  jobs: JobQueue;
  clock: Clock;
  includeLlmPayloads: boolean;
  secretValues: readonly string[];
  secretValuesProvider?: () => readonly string[];
}
function optional<T extends object>(condition: boolean, value: T): T | Record<string, never> { return condition ? value : {}; }
function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid stored count.");
  return value;
}
function profile(record: InterestProfile, redactor: Redactor): DebugProfile {
  return {
    id: redactor.text(record.id, 128), rulesVersion: redactor.text(record.rulesVersion, 256),
    activityVersion: redactor.text(record.activityVersion, 256), policyVersion: redactor.text(record.policyVersion, 256),
    builderVersion: redactor.text(record.builderVersion, 256), createdAt: record.createdAt,
  };
}
function versionCount(record: RecommendationVersionCount, redactor: Redactor): DebugRecommendationVersionCount {
  return {
    profileId: redactor.text(record.profileId, 128), promptVersion: redactor.text(record.promptVersion, 256),
    model: redactor.text(record.model, 256), rankVersion: redactor.text(record.rankVersion, 256), queueEntryCount: count(record.queueEntryCount),
  };
}
function syncRun(record: IngestionRun, redactor: Redactor): DebugSyncRun {
  return {
    id: redactor.text(record.id, 128), kind: redactor.text(record.kind, 64), status: record.status,
    storiesUpserted: count(record.storiesUpserted), nonStoriesSkipped: count(record.nonStoriesSkipped),
    ...optional(record.errorCode !== undefined, { errorCode: redactor.code(record.errorCode ?? "", "unknown-error") }),
    startedAt: record.startedAt, ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
  };
}
function job(record: Job, redactor: Redactor): DebugJob {
  return {
    id: redactor.text(record.id, 128), kind: redactor.text(record.kind, 64), status: record.status,
    runAfter: record.runAfter, ...(record.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: record.leaseExpiresAt }),
    attempts: count(record.attempts), maxAttempts: count(record.maxAttempts), createdAt: record.createdAt, updatedAt: record.updatedAt,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
  };
}
function llmCall(record: LlmCallRecord, redactor: Redactor, visible: boolean, budget: PayloadBudget): DebugLlmCall {
  return {
    id: redactor.text(record.id, 128), purpose: redactor.text(record.purpose, 64), model: redactor.text(record.model, 256),
    status: record.status, requestHash: redactor.text(record.requestHash, 256),
    ...optional(record.inputTokens !== undefined, { inputTokens: count(record.inputTokens ?? 0) }),
    ...optional(record.outputTokens !== undefined, { outputTokens: count(record.outputTokens ?? 0) }),
    latencyMs: count(record.latencyMs),
    ...optional(record.errorCode !== undefined, { errorCode: redactor.code(record.errorCode ?? "", "unknown-error") }),
    createdAt: record.createdAt,
    requestPayload: payloadPreview(record.requestPayload, record.requestPayloadSchemaVersion, "request", record.status, visible, redactor, budget),
    responsePayload: payloadPreview(record.responsePayload, record.responsePayloadSchemaVersion, "response", record.status, visible, redactor, budget),
  };
}
function diagnosticError(record: DiagnosticError, redactor: Redactor): DebugError {
  return {
    id: redactor.text(record.id, 128), code: redactor.code(record.code, "unknown-error"),
    component: redactor.code(record.component, "unknown-component"), occurredAt: record.occurredAt,
    ...optional(record.runId !== undefined, { runId: redactor.text(record.runId ?? "", 128) }),
    ...optional(record.jobId !== undefined, { jobId: redactor.text(record.jobId ?? "", 128) }),
    ...optional(record.storyId !== undefined, { storyId: count(record.storyId ?? 0) }),
    ...optional(record.profileId !== undefined, { profileId: redactor.text(record.profileId ?? "", 128) }),
    ...optional(record.requestId !== undefined, { requestId: redactor.text(record.requestId ?? "", 128) }),
  };
}
function unavailable<T>(value: T): DebugSection<T> { return { status: "unavailable", value, errorCode: "read-failed" }; }
function emptyPage<T>(): DebugPage<T> { return { items: [] }; }
function page<T, R>(
  plan: PagePlan,
  read: (limit: number) => R[],
  map: (record: R) => T,
  key: (record: R) => CursorKey,
  redactor: Redactor,
): DebugPage<T> {
  const rows = read(plan.limit + 1);
  if (!Array.isArray(rows)) throw new TypeError("Invalid repository page.");
  const selected = rows.slice(0, plan.limit);
  const items = selected.map(map);
  if (rows.length <= plan.limit || selected.length === 0) return { items };
  const last = selected[selected.length - 1]!;
  return { items, nextCursor: encodeCursor(plan, key(last), redactor) };
}
export function produceSnapshot(dependencies: SnapshotDependencies, plans: QueryPlans): DebugSnapshot {
  const { store, jobs, clock } = dependencies;
  const generatedAt = clock.now().toISOString();
  const secrets = dependencies.secretValuesProvider === undefined
    ? dependencies.secretValues
    : providerInventory(dependencies.secretValuesProvider);
  const redactor = new Redactor(secrets);
  const budget: PayloadBudget = { remaining: 32_768, exhausted: false };
  const sections = {} as Pick<DebugSnapshot, "activeProfile" | "recommendationVersions" | "syncRuns" | "jobs" | "queueCounts" | "llmCalls" | "recentErrors">;
  try { sections.activeProfile = { status: "ok", value: optionalProfile(store.profiles.current(), redactor) }; }
  catch { sections.activeProfile = unavailable(undefined); }
  try {
    const plan = plans.recommendationVersions;
    const after = plan.after;
    sections.recommendationVersions = { status: "ok", value: page(plan,
      (limit) => store.recommendations.activeVersionCounts(after === undefined ? undefined : {
        profileId: after[0], promptVersion: after[1]!, model: after[2]!, rankVersion: after[3]!,
      }, limit),
      (record) => versionCount(record, redactor),
      (record) => [record.profileId, record.promptVersion, record.model, record.rankVersion], redactor) };
  } catch { sections.recommendationVersions = unavailable(emptyPage()); }
  try {
    const plan = plans.syncRuns;
    sections.syncRuns = { status: "ok", value: page(plan, (limit) => store.sync.recentRuns(timestampPosition(plan), limit),
      (record) => syncRun(record, redactor), (record) => [record.startedAt, record.id], redactor) };
  } catch { sections.syncRuns = unavailable(emptyPage()); }
  try {
    const plan = plans.jobs;
    const after = timestampPosition(plan);
    sections.jobs = { status: "ok", value: page(plan, (limit) => jobs.list({
      limit, ...(after === undefined ? {} : { after: { createdAt: after.timestamp, id: after.id } }),
      ...(plan.status === undefined ? {} : { status: plan.status }), ...(plan.kind === undefined ? {} : { kind: plan.kind }),
    }), (record) => job(record, redactor), (record) => [record.createdAt, record.id], redactor) };
  } catch { sections.jobs = unavailable(emptyPage()); }
  try {
    const stored = store.queue.countsByEvaluationState({});
    const value: QueueEvaluationCounts = { pending: count(stored.pending ?? 0), scored: count(stored.scored ?? 0), failed: count(stored.failed ?? 0) };
    sections.queueCounts = { status: "ok", value };
  } catch { sections.queueCounts = unavailable({ pending: 0, scored: 0, failed: 0 }); }
  try {
    const plan = plans.llmCalls;
    sections.llmCalls = { status: "ok", value: page(plan, (limit) => store.llmCalls.recent(timestampPosition(plan), limit),
      (record) => llmCall(record, redactor, dependencies.includeLlmPayloads, budget),
      (record) => [record.createdAt, record.id], redactor) };
  } catch { sections.llmCalls = unavailable(emptyPage()); }
  try {
    const plan = plans.recentErrors;
    const after = timestampPosition(plan);
    const candidates = [
      ...store.diagnostics.recentErrors(after, plan.limit + 1),
      ...jobs.listDiagnosticErrors(after === undefined ? undefined : { occurredAt: after.timestamp, id: after.id }, plan.limit + 1),
    ].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
    sections.recentErrors = { status: "ok", value: page(plan, (limit) => candidates.slice(0, limit),
      (record) => diagnosticError(record, redactor), (record) => [record.occurredAt, record.id], redactor) };
  } catch { sections.recentErrors = unavailable(emptyPage()); }
  return {
    schemaVersion: 1, generatedAt, payloadPolicy: { llmPayloads: dependencies.includeLlmPayloads },
    partial: Object.values(sections).some((section) => section.status === "unavailable"), ...sections,
  };
}
function optionalProfile(record: InterestProfile | undefined, redactor: Redactor): DebugProfile | undefined {
  return record === undefined ? undefined : profile(record, redactor);
}
