import type { Clock, Sleep } from "@tmtp/clock";
import type { IngestionRunStatus, IsoDateTime, JobStatus, LlmCallStatus, SchemaVersion } from "@tmtp/domain";
import type { JobQueue } from "@tmtp/job-queue";
import type { ReaderStore } from "@tmtp/reader-store";
export interface LivenessSnapshot { generatedAt: IsoDateTime; status: "live"; }
export type ReadinessReason = "ok" | "configuration-not-loaded" | "configuration-invalid" | "database-unavailable" |
  "integrity-check-failed" | "migrations-pending" | "migration-checksum-mismatch" | "migration-failed" |
  "workers-starting" | "workers-stopped" | "worker-failed";
export interface ReadinessCheckInput { ready: boolean; reason: ReadinessReason; }
export interface ReadinessInput { configuration: ReadinessCheckInput; sqlite: ReadinessCheckInput; migrations: ReadinessCheckInput; workers: ReadinessCheckInput; }
export type IntegrationAvailability = "available" | "degraded" | "unavailable" | "unknown";
export type CapabilityReason = "ok" | "not-configured" | "not-checked" | "configuration-invalid" | "database-unavailable" |
  "integrity-check-failed" | "migrations-not-current" | "workers-not-ready" | "connection-failed" |
  "authentication-failed" | "rate-limited" | "timeout" | "invalid-response" | "fetch-failed" | "extraction-failed";
export interface IntegrationInput { configured: boolean; availability: IntegrationAvailability; reason: CapabilityReason; observedAt?: IsoDateTime; }
export interface HealthInput extends ReadinessInput { llm: IntegrationInput; hnPublic: IntegrationInput; hnAccount?: IntegrationInput; article: IntegrationInput; }
export interface ReadinessCheck { name: "configuration" | "sqlite" | "migrations" | "workers"; status: "pass" | "fail"; reason: ReadinessReason; }
export interface ReadinessSnapshot { generatedAt: IsoDateTime; status: "ready" | "not-ready"; checks: ReadinessCheck[]; }
export type CapabilityState = "available" | "degraded" | "unavailable" | "disabled" | "unknown";
export interface CapabilityStatus { state: CapabilityState; reason: CapabilityReason; observedAt?: IsoDateTime; }
export interface CapabilitiesSnapshot {
  generatedAt: IsoDateTime;
  storedReading: CapabilityStatus;
  backgroundWork: CapabilityStatus;
  llmPersonalization: CapabilityStatus;
  hnPublicCollection: CapabilityStatus;
  hnAccount: CapabilityStatus;
  freshArticleContent: CapabilityStatus;
}
export type SafeCode = string;
export interface DebugProfile { id: string; rulesVersion: string; activityVersion: string; policyVersion: string; builderVersion: string; createdAt: IsoDateTime; }
export interface DebugRecommendationVersionCount { profileId: string; promptVersion: string; model: string; rankVersion: string; queueEntryCount: number; }
export interface DebugSyncRun { id: string; kind: string; status: IngestionRunStatus; storiesUpserted: number; nonStoriesSkipped: number; errorCode?: SafeCode; startedAt: IsoDateTime; completedAt?: IsoDateTime; }
export interface DebugJob { id: string; kind: string; status: JobStatus; runAfter: IsoDateTime; leaseExpiresAt?: IsoDateTime; attempts: number; maxAttempts: number; createdAt: IsoDateTime; updatedAt: IsoDateTime; completedAt?: IsoDateTime; }
export interface QueueEvaluationCounts { pending: number; scored: number; failed: number; }
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type DebugPayloadState = "not-captured" | "hidden-by-policy" | "suppressed-error-response" | "included" | "omitted-too-large" | "omitted-budget";
export interface DebugPayloadPreview { state: DebugPayloadState; schemaVersion?: SchemaVersion; value?: JsonValue; truncated: boolean; }
export interface DebugLlmCall {
  id: string; purpose: string; model: string; status: LlmCallStatus; requestHash: string;
  inputTokens?: number; outputTokens?: number; latencyMs: number; errorCode?: SafeCode; createdAt: IsoDateTime;
  requestPayload: DebugPayloadPreview; responsePayload: DebugPayloadPreview;
}
export interface DebugError { id: string; code: SafeCode; component: SafeCode; occurredAt: IsoDateTime; runId?: string; jobId?: string; storyId?: number; profileId?: string; requestId?: string; }
export interface DebugPage<T> { items: T[]; nextCursor?: string; }
export interface DebugSection<T> { status: "ok" | "unavailable"; value: T; errorCode?: "read-failed"; }
export interface DebugPageQuery { limit?: number; after?: string; }
export interface DebugJobPageQuery extends DebugPageQuery { status?: JobStatus; kind?: string; }
export interface DebugWindowQuery { syncRuns?: DebugPageQuery; jobs?: DebugJobPageQuery; llmCalls?: DebugPageQuery; recentErrors?: DebugPageQuery; recommendationVersions?: DebugPageQuery; }
export interface DebugStreamQuery { syncRuns?: Omit<DebugPageQuery, "after">; jobs?: Omit<DebugJobPageQuery, "after">; llmCalls?: Omit<DebugPageQuery, "after">; recentErrors?: Omit<DebugPageQuery, "after">; recommendationVersions?: Omit<DebugPageQuery, "after">; }
export interface DebugSnapshot {
  schemaVersion: 1;
  generatedAt: IsoDateTime;
  payloadPolicy: { llmPayloads: boolean };
  partial: boolean;
  activeProfile: DebugSection<DebugProfile | undefined>;
  recommendationVersions: DebugSection<DebugPage<DebugRecommendationVersionCount>>;
  syncRuns: DebugSection<DebugPage<DebugSyncRun>>;
  jobs: DebugSection<DebugPage<DebugJob>>;
  queueCounts: DebugSection<QueueEvaluationCounts>;
  llmCalls: DebugSection<DebugPage<DebugLlmCall>>;
  recentErrors: DebugSection<DebugPage<DebugError>>;
}
export interface DebugStreamFrame { sequence: number; snapshot: DebugSnapshot; }
export interface DebugStreamOptions { query?: DebugStreamQuery; signal?: AbortSignal; }
export interface DiagnosticsOptions {
  store: ReaderStore;
  jobs: JobQueue;
  clock: Clock;
  sleep: Sleep;
  secretValues?: readonly string[];
  secretValuesProvider?: () => readonly string[];
  debug: { enabled: boolean; streamIntervalMs: number; includeLlmPayloads: boolean };
}
export interface Diagnostics {
  liveness(): LivenessSnapshot;
  readiness(input: ReadinessInput): ReadinessSnapshot;
  capabilities(input: HealthInput): CapabilitiesSnapshot;
  debugSnapshot(query?: DebugWindowQuery): DebugSnapshot;
  debugStream(options?: DebugStreamOptions): AsyncIterable<DebugStreamFrame>;
}
