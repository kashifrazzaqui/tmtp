import type { Clock } from "@tmtp/clock";
import type { HnFeed, IsoDateTime } from "@tmtp/domain";
import type { AccountCapability, HnAccount } from "@tmtp/hn-account";
import type { HnPublicApi } from "@tmtp/hn-public-api";
import type { JobEnqueue, JobFailure, JobPayloadCodec, JobQueue } from "@tmtp/job-queue";
import type { ReaderStore } from "@tmtp/reader-store";
export interface IngestionSummary { runId: string; highestSeenItemId: number; storiesUpserted: number; nonStoriesSkipped: number; jobsEnqueued: number; }
export interface AccountReconciliationSummary { runId: string; observations: number; skippedUnknownStories: number; activityJobsEnqueued: number; capabilities: AccountCapability[]; }
export interface HnIngestionOptions {
  api: HnPublicApi; account?: HnAccount; store: ReaderStore; jobs: JobQueue; clock: Clock;
  bootstrapRankVersion: () => string; feeds: readonly HnFeed[]; initialLookbackItems: number;
  maxItemsPerRun: number; refreshBatchSize: number; refreshAfterHours: number;
}
export interface HnIngestion { collectPublic(signal?: AbortSignal): Promise<IngestionSummary>; reconcileAccount(signal?: AbortSignal): Promise<AccountReconciliationSummary>; }
export type HnIngestionJobKind = "ingestion.collect" | "ingestion.reconcile-account";
export interface HnIngestionJobPayload {}
export interface HnIngestionJobDescription { kind: HnIngestionJobKind; payload: HnIngestionJobPayload; runAfter: IsoDateTime; }
export type HnIngestionOperation = "collect-public" | "reconcile-account";
export type HnIngestionDependency = "hn-public-api" | "hn-account" | "interests" | "reader-store" | "job-queue";
export type HnIngestionErrorCode = "invalid-configuration" | "invalid-input" | "invalid-checkpoint" | "account-not-configured" |
  "upstream-failure" | "persistence-failure" | "job-handoff-failure" | "internal-failure";
export interface HnIngestionErrorOptions { operation: HnIngestionOperation; retryable: boolean; runId?: string; dependency?: HnIngestionDependency; dependencyCode?: string; }
export type { AccountCapability, Clock, HnAccount, HnPublicApi, IsoDateTime, JobEnqueue, JobFailure, JobPayloadCodec, JobQueue, ReaderStore };
