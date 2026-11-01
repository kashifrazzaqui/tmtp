import type { RawActivity } from "@tmtp/activity";
import type { PreferenceRule } from "@tmtp/domain";
import { createHnIngestionJobEnqueue, hnIngestionJobCodecs } from "@tmtp/hn-ingestion";
import type { HnIngestionJobKind } from "@tmtp/hn-ingestion";
import { PersonalizationError, personalizationJobCodecs } from "@tmtp/personalization";
import { refreshArticle, runArticleJob } from "./article-jobs.js";
import { appError, boundary, failureForKinds, translateError } from "./errors.js";
import { createHnActionCoordinator } from "./hn-actions.js";
import { decodeJobPayload, readerAppJobCodecs } from "./job-codecs.js";
import { normalizeOptions } from "./options.js";
import { activityHistory, hnActionHistory, preferenceList, readStory, recommendationHistory, setReadingState } from "./queries.js";
import { readQueue } from "./queue-query.js";
import { decodeReaderCursor } from "./queue-cursor.js";
import type {
  ActivityHistoryQuery,
  ArticleFetchExtractJobPayload,
  HnActionHistoryQuery,
  NormalizedReaderAppOptions,
  ReaderApp,
  ReaderAppDependency,
  ReaderAppOperation,
  ReaderAppOptions,
  ReaderQueueQuery,
  RecommendationHistoryQuery,
  RecordActivityJobPayload,
} from "./types.js";
import {
  activityBatch,
  activityHistoryQuery,
  checkpoint,
  hnActionCommand,
  hnHistoryQuery,
  leasedJob,
  preferenceRules,
  queueQuery,
  queueState,
  rebuildReason,
  recommendationHistoryQuery,
  storyId,
  timestamp,
  validateSignal,
} from "./validation.js";

const PERSONALIZATION_KINDS = new Set(personalizationJobCodecs.map((codec) => codec.kind));
const INGESTION_KINDS = new Set(hnIngestionJobCodecs.map((codec) => codec.kind));
const SUPPORTED_KINDS = new Set(readerAppJobCodecs.map((codec) => codec.kind));

async function delegated<T>(
  operation: ReaderAppOperation,
  dependency: ReaderAppDependency,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (signal?.aborted && error === signal.reason) throw error;
    throw translateError(error, operation, dependency);
  }
}

function schedule(options: NormalizedReaderAppOptions, kind: HnIngestionJobKind) {
  const operation = kind === "ingestion.collect" ? "schedule-ingestion" : "schedule-hn-reconciliation";
  return options.store.transaction(() => {
    try {
      return options.jobs.enqueue(createHnIngestionJobEnqueue({
        kind,
        payload: {},
        runAfter: timestamp(options.now, operation),
      })).job;
    } catch (error) {
      throw translateError(error, operation, "job-queue");
    }
  });
}

export function createApplication(input: ReaderAppOptions): ReaderApp {
  const options = normalizeOptions(input);
  const performAction = createHnActionCoordinator(options);
  return {
    async getQueue(query?: ReaderQueueQuery, signal?: AbortSignal) {
      const normalized = queueQuery(query, options.queuePageSize, options.queueMaxPageSize);
      validateSignal(signal, "get-queue");
      const decoded = normalized.cursor === undefined ? undefined : decodeReaderCursor(normalized.cursor, normalized);
      checkpoint(signal);
      return boundary("get-queue", "reader-store", () => readQueue(options, normalized, decoded));
    },
    async getStory(id, signal) {
      const normalized = storyId(id, "get-story");
      validateSignal(signal, "get-story");
      checkpoint(signal);
      return boundary("get-story", "reader-store", () => readStory(options, normalized), { storyId: normalized });
    },
    async getRecommendationHistory(query: RecommendationHistoryQuery, signal) {
      const normalized = recommendationHistoryQuery(query, options.queuePageSize, options.queueMaxPageSize);
      validateSignal(signal, "get-recommendation-history");
      checkpoint(signal);
      return boundary("get-recommendation-history", "reader-store", () => recommendationHistory(options, normalized), { storyId: normalized.storyId });
    },
    async getHnActionHistory(query: HnActionHistoryQuery, signal) {
      const normalized = hnHistoryQuery(query, options.queuePageSize, options.queueMaxPageSize);
      validateSignal(signal, "get-hn-action-history");
      checkpoint(signal);
      return boundary("get-hn-action-history", "reader-store", () => hnActionHistory(options, normalized), { storyId: normalized.storyId });
    },
    async getActivity(query?: ActivityHistoryQuery, signal?: AbortSignal) {
      const normalized = activityHistoryQuery(query, options.queuePageSize, options.queueMaxPageSize);
      validateSignal(signal, "get-activity");
      checkpoint(signal);
      return boundary("get-activity", "reader-store", () => activityHistory(options, normalized), {
        ...(normalized.storyId === undefined ? {} : { storyId: normalized.storyId }),
      });
    },
    async setQueueState(id, state, signal) {
      const normalizedId = storyId(id, "set-queue-state");
      const normalizedState = queueState(state);
      validateSignal(signal, "set-queue-state");
      checkpoint(signal);
      return boundary("set-queue-state", "reader-store", () => setReadingState(options, normalizedId, normalizedState), { storyId: normalizedId });
    },
    async refreshArticle(id, signal) {
      const normalized = storyId(id, "refresh-article");
      validateSignal(signal, "refresh-article");
      checkpoint(signal);
      return boundary("refresh-article", "reader-store", () => refreshArticle(options, normalized), { storyId: normalized });
    },
    async recordActivity(batch: readonly RawActivity[], signal?: AbortSignal) {
      const normalized = activityBatch(batch);
      validateSignal(signal, "record-activity");
      checkpoint(signal);
      return delegated("record-activity", "personalization", signal, () => options.personalization.recordActivity(normalized, signal));
    },
    async getPreferences(signal) {
      validateSignal(signal, "get-preferences");
      checkpoint(signal);
      return boundary("get-preferences", "reader-store", () => preferenceList(options));
    },
    async replacePreferences(rules: readonly PreferenceRule[], signal?: AbortSignal) {
      const normalized = preferenceRules(rules);
      validateSignal(signal, "replace-preferences");
      checkpoint(signal);
      return delegated("replace-preferences", "personalization", signal, () => options.personalization.applyPreferenceChange(normalized, signal));
    },
    async rebuildPersonalization(reason, signal) {
      const normalized = rebuildReason(reason);
      validateSignal(signal, "rebuild-personalization");
      checkpoint(signal);
      return delegated("rebuild-personalization", "personalization", signal, () => options.personalization.rebuildProfile(normalized, signal));
    },
    async runPersonalization(signal) {
      validateSignal(signal, "run-personalization");
      checkpoint(signal);
      return delegated("run-personalization", "personalization", signal, () => options.personalization.recover(signal));
    },
    async getHnCapabilities(signal) {
      validateSignal(signal, "get-hn-capabilities");
      checkpoint(signal);
      if (options.account === undefined) {
        return [
          { name: "upvoted", state: "unavailable", reason: "capability-disabled" },
          { name: "favorites", state: "unavailable", reason: "capability-disabled" },
          { name: "flagged", state: "unavailable", reason: "capability-disabled" },
          { name: "mutations", state: "unavailable", reason: "capability-disabled" },
        ];
      }
      return delegated("get-hn-capabilities", "hn-account", signal, () => options.account!.capabilities(signal));
    },
    async performHnAction(command, signal) {
      const normalized = hnActionCommand(command);
      validateSignal(signal, "perform-hn-action");
      return performAction(normalized, signal);
    },
    async runIngestion(signal) {
      validateSignal(signal, "run-ingestion");
      checkpoint(signal);
      return delegated("run-ingestion", "hn-ingestion", signal, () => options.ingestion.collectPublic(signal));
    },
    async scheduleIngestion(signal) {
      validateSignal(signal, "schedule-ingestion");
      checkpoint(signal);
      return boundary("schedule-ingestion", "reader-store", () => schedule(options, "ingestion.collect"));
    },
    async reconcileHnAccount(signal) {
      validateSignal(signal, "reconcile-hn-account");
      checkpoint(signal);
      return delegated("reconcile-hn-account", "hn-ingestion", signal, () => options.ingestion.reconcileAccount(signal));
    },
    async scheduleHnReconciliation(signal) {
      validateSignal(signal, "schedule-hn-reconciliation");
      checkpoint(signal);
      if (options.account === undefined) throw appError("account-not-configured", "schedule-hn-reconciliation", { retryable: false });
      return boundary("schedule-hn-reconciliation", "reader-store", () => schedule(options, "ingestion.reconcile-account"));
    },
    async runJob(job, signal) {
      const claimed = leasedJob(job);
      validateSignal(signal, "run-job");
      if (!SUPPORTED_KINDS.has(claimed.kind)) throw appError("invalid-job", "run-job", { retryable: false, jobId: claimed.id });
      let payload: unknown;
      try {
        payload = decodeJobPayload(claimed.kind, claimed.payload, claimed.payloadSchemaVersion);
      } catch {
        throw appError("invalid-job", "run-job", { retryable: false, jobId: claimed.id });
      }
      if (signal?.aborted) throw appError("cancelled", "run-job", { retryable: true, jobId: claimed.id });
      try {
        if (claimed.kind === "article.fetch-extract") {
          await boundary("run-job", "reader-store", () => runArticleJob(options, claimed, payload as ArticleFetchExtractJobPayload, signal), {
            storyId: (payload as ArticleFetchExtractJobPayload).storyId,
            jobId: claimed.id,
          });
          return;
        }
        if (claimed.kind === "personalization.record-activity") {
          await options.personalization.recordActivity((payload as RecordActivityJobPayload).batch, signal);
          if (signal?.aborted) throw appError("cancelled", "run-job", { retryable: true, jobId: claimed.id });
          return;
        }
        if (claimed.kind === "ingestion.collect") {
          await options.ingestion.collectPublic(signal);
          if (signal?.aborted) throw appError("cancelled", "run-job", { retryable: true, jobId: claimed.id });
          return;
        }
        if (claimed.kind === "ingestion.reconcile-account") {
          await options.ingestion.reconcileAccount(signal);
          if (signal?.aborted) throw appError("cancelled", "run-job", { retryable: true, jobId: claimed.id });
          return;
        }
        await options.personalization.runJob({ ...claimed, payload }, signal);
        if (signal?.aborted) throw appError("cancelled", "run-job", { retryable: true, jobId: claimed.id });
      } catch (error) {
        if (error instanceof Error && error.name === "ReaderAppError") throw error;
        if (signal?.aborted || error instanceof PersonalizationError && error.code === "cancelled") {
          throw appError("cancelled", "run-job", { retryable: true, jobId: claimed.id });
        }
        throw error;
      }
    },
  };
}

export function jobFailure(kind: string, error: unknown) {
  return failureForKinds(kind, error, SUPPORTED_KINDS, PERSONALIZATION_KINDS, INGESTION_KINDS);
}
