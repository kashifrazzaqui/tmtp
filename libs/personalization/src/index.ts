import { parseActivityBatch } from "@tmtp/activity";
import { JobSchema } from "@tmtp/domain";
import type { InterestProfile, Job, PreferenceRule } from "@tmtp/domain";
import { recordActivity as recordActivityTransaction } from "./activity-command.js";
import { persistAudits } from "./audit-writer.js";
import { cancelled, invalidInput, PersonalizationError } from "./errors.js";
import { createPersonalizationJobEnqueue, decodeRunJobPayload, isPersonalizationJobKind } from "./jobs.js";
import { createPipelineLock } from "./pipeline-lock.js";
import { buildCurrentProfile } from "./profile-builder.js";
import type { BuiltProfile } from "./profile-builder.js";
import { projectCompleteQueue } from "./projection.js";
import { cancelledScoreSummary, executeScoring } from "./scoring.js";
import { validateOptions, validateReason, validateRules, validateSignal } from "./validation.js";
import type {
  Personalization,
  PersonalizationOptions,
  ProfileRebuildJobPayload,
  ProfileScopedJobPayload,
  QueueProjectionSummary,
  RecoverySummary,
  ScorePendingSummary,
} from "./types.js";

export { PERSONALIZATION_JOB_PAYLOAD_SCHEMA_VERSION, createPersonalizationJobEnqueue, personalizationJobCodecs } from "./jobs.js";
export { PersonalizationError, personalizationJobFailure } from "./errors.js";
export type {
  RecordActivityResult,
  ScorePendingSummary,
  RecoverySummary,
  QueueProjectionSummary,
  Personalization,
  PersonalizationOptions,
  PersonalizationJobKind,
  ProfileRebuildJobPayload,
  ProfileScopedJobPayload,
  RecoverJobPayload,
  PersonalizationJobPayload,
  PersonalizationJobDescription,
  PersonalizationErrorCode,
} from "./types.js";

function retryableOutcome(summary: ScorePendingSummary, jobId?: string): void {
  if (summary.completion === "cancelled") throw cancelled(jobId);
  if (summary.retryableFailed > 0) throw new PersonalizationError("scoring-retryable", { ...(jobId === undefined ? {} : { jobId }) });
}

export function createPersonalization(input: PersonalizationOptions): Personalization {
  validateOptions(input);
  const options = input;
  const pipeline = createPipelineLock();

  function existingSelection(profile: InterestProfile): BuiltProfile {
    return { profile, previous: profile, changed: false, builtAt: profile.createdAt };
  }
  function selectProfile(reason: string): BuiltProfile {
    const current = options.store.transaction(() => options.store.profiles.current());
    if (current !== undefined) return existingSelection(current);
    return options.store.transaction(() => buildCurrentProfile(options, reason));
  }
  function rebuild(reason: string): InterestProfile {
    return options.store.transaction(() => {
      const selected = buildCurrentProfile(options, reason);
      projectCompleteQueue(options, { profile: selected.profile, profileChanged: selected.changed });
      options.jobs.enqueue(createPersonalizationJobEnqueue({
        kind: "personalization.score-pending",
        payload: { profileId: selected.profile.id },
        runAfter: selected.builtAt,
      }));
      return selected.profile;
    });
  }
  function applyRules(rules: readonly PreferenceRule[]): InterestProfile {
    return options.store.transaction(() => {
      options.store.preferences.replaceAll([...rules]);
      return rebuild("preference-change");
    });
  }
  function projectSelected(selected: BuiltProfile): QueueProjectionSummary {
    return options.store.transaction(() => projectCompleteQueue(options, {
      profile: selected.profile,
      profileChanged: selected.changed,
    }));
  }
  async function scoreSelected(selected: BuiltProfile, signal: AbortSignal | undefined): Promise<ScorePendingSummary> {
    return executeScoring(options, selected, signal);
  }
  function isLockCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true && error instanceof PersonalizationError && error.code === "cancelled";
  }
  async function rebuildProfile(reason: string, signal?: AbortSignal): Promise<InterestProfile> {
    validateReason(reason);
    validateSignal(signal);
    if (signal?.aborted) throw cancelled();
    return pipeline.run(signal, async () => rebuild(reason));
  }
  async function scorePending(signal?: AbortSignal): Promise<ScorePendingSummary> {
    validateSignal(signal);
    if (signal?.aborted) return cancelledScoreSummary();
    try {
      return await pipeline.run(signal, async () => scoreSelected(selectProfile("score-pending"), signal));
    } catch (error) {
      if (isLockCancellation(error, signal)) return cancelledScoreSummary();
      throw error;
    }
  }
  async function recover(signal?: AbortSignal): Promise<RecoverySummary> {
    validateSignal(signal);
    if (signal?.aborted) return { ...cancelledScoreSummary(), rebuilt: false };
    try {
      return await pipeline.run(signal, async (): Promise<RecoverySummary> => {
        const selected = options.store.transaction(() => buildCurrentProfile(options, "recovery"));
        const summary = await scoreSelected(selected, signal);
        return { ...summary, rebuilt: selected.changed };
      });
    } catch (error) {
      if (isLockCancellation(error, signal)) return { ...cancelledScoreSummary(), rebuilt: false };
      throw error;
    }
  }
  async function projectQueue(signal?: AbortSignal): Promise<QueueProjectionSummary> {
    validateSignal(signal);
    if (signal?.aborted) throw cancelled();
    return pipeline.run(signal, async () => projectSelected(selectProfile("queue-project")));
  }

  return {
    async recordActivity(batch, signal) {
      const parsed = parseActivityBatch(batch);
      if (parsed.length > options.activityBatchSize) invalidInput("batch");
      validateSignal(signal);
      if (signal?.aborted) throw cancelled();
      return recordActivityTransaction(options, parsed);
    },
    rebuildProfile,
    scorePending,
    async persistLlmAudits(audits) { persistAudits(options, audits); },
    async applyPreferenceChange(rules, signal) {
      validateRules(rules);
      validateSignal(signal);
      if (signal?.aborted) throw cancelled();
      return pipeline.run(signal, async () => applyRules(rules));
    },
    recover,
    projectQueue,
    async runJob(job: Job, signal?: AbortSignal): Promise<void> {
      validateSignal(signal);
      const jobId = job !== null && typeof job === "object" && typeof job.id === "string" && job.id.length > 0 ? job.id : undefined;
      let validJob = false;
      try { validJob = JobSchema.safeParse(job).success && isPersonalizationJobKind(job.kind); } catch { validJob = false; }
      if (!validJob || !isPersonalizationJobKind(job.kind)) {
        throw new PersonalizationError("invalid-job", { ...(jobId === undefined ? {} : { jobId }) });
      }
      const payload = decodeRunJobPayload(job.kind, job.payload, job.payloadSchemaVersion, job.id);
      if (signal?.aborted) throw cancelled(job.id);

      if (job.kind === "personalization.profile-rebuild") {
        await rebuildProfile((payload as ProfileRebuildJobPayload).reason, signal);
        return;
      }
      if (job.kind === "personalization.score-pending") {
        const expected = (payload as ProfileScopedJobPayload).profileId;
        try {
          await pipeline.run(signal, async () => {
            const current = options.store.transaction(() => options.store.profiles.current());
            if (current?.id !== expected) return;
            const summary = await scoreSelected(existingSelection(current), signal);
            retryableOutcome(summary, job.id);
          });
        } catch (error) {
          if (isLockCancellation(error, signal)) throw cancelled(job.id);
          throw error;
        }
        return;
      }
      if (job.kind === "personalization.queue-project") {
        const expected = (payload as ProfileScopedJobPayload).profileId;
        await pipeline.run(signal, async () => {
          const current = options.store.transaction(() => options.store.profiles.current());
          if (current?.id !== expected) return;
          projectSelected(existingSelection(current));
        });
        return;
      }
      const summary = await recover(signal);
      retryableOutcome(summary, job.id);
    },
  };
}
