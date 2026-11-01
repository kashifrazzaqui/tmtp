import type { RawActivity } from "@tmtp/activity";
import type { ActivityPolicy } from "@tmtp/activity";
import type { Clock } from "@tmtp/clock";
import type { InterestProfile, IsoDateTime, Job, PreferenceRule } from "@tmtp/domain";
import type { InterestPolicy } from "@tmtp/interests";
import type { JobQueue } from "@tmtp/job-queue";
import type { LlmCallAudit, LlmPort } from "@tmtp/llm-interface";
import type { ReaderStore } from "@tmtp/reader-store";
import type { RecommendationCompletion, RecommendationPolicy } from "@tmtp/recommendations";

export interface RecordActivityResult { accepted: number; profileWorkEnqueued: boolean; }
export interface ScorePendingSummary {
  completion: RecommendationCompletion;
  scored: number;
  failed: number;
  retryableFailed: number;
  queued: number;
  audits: number;
}
export interface RecoverySummary extends ScorePendingSummary { rebuilt: boolean; }
export interface QueueProjectionSummary { projected: number; complete: true; profileId: string; rankVersion?: string; }
export interface Personalization {
  recordActivity(batch: readonly RawActivity[], signal?: AbortSignal): Promise<RecordActivityResult>;
  rebuildProfile(reason: string, signal?: AbortSignal): Promise<InterestProfile>;
  scorePending(signal?: AbortSignal): Promise<ScorePendingSummary>;
  persistLlmAudits(audits: readonly LlmCallAudit[]): Promise<void>;
  applyPreferenceChange(rules: readonly PreferenceRule[], signal?: AbortSignal): Promise<InterestProfile>;
  recover(signal?: AbortSignal): Promise<RecoverySummary>;
  projectQueue(signal?: AbortSignal): Promise<QueueProjectionSummary>;
  runJob(job: Job, signal?: AbortSignal): Promise<void>;
}
export interface PersonalizationOptions {
  store: ReaderStore;
  jobs: JobQueue;
  llm: LlmPort;
  model: string;
  clock: Clock;
  activityPolicy: ActivityPolicy;
  interestPolicy: InterestPolicy;
  recommendationPolicy: RecommendationPolicy;
  activityBatchSize: number;
  queueSyncBatchSize: number;
}
export type PersonalizationJobKind = "personalization.profile-rebuild" | "personalization.score-pending" |
  "personalization.queue-project" | "personalization.recover";
export interface ProfileRebuildJobPayload { reason: string; rulesVersion: string; activityVersion: string; }
export interface ProfileScopedJobPayload { profileId: string; }
export interface RecoverJobPayload {}
export type PersonalizationJobPayload = ProfileRebuildJobPayload | ProfileScopedJobPayload | RecoverJobPayload;
export type PersonalizationJobDescription =
  | { kind: "personalization.profile-rebuild"; payload: ProfileRebuildJobPayload; runAfter: IsoDateTime }
  | { kind: "personalization.score-pending" | "personalization.queue-project"; payload: ProfileScopedJobPayload; runAfter: IsoDateTime }
  | { kind: "personalization.recover"; payload: RecoverJobPayload; runAfter: IsoDateTime };
export type PersonalizationErrorCode = "invalid-options" | "invalid-input" | "invalid-job" | "activity-append-incomplete" |
  "audit-conflict" | "recommendation-conflict" | "cancelled" | "scoring-retryable";
