import type { Sleep } from "@tmtp/clock";
import type { Job } from "@tmtp/domain";
import { JobQueueError } from "@tmtp/job-queue";
import type { JobQueue } from "@tmtp/job-queue";
import type { Logger } from "@tmtp/logging";
import { readerAppJobCodecs, readerAppJobFailure } from "@tmtp/reader-app";
import type { ArticleFetchExtractJobPayload, ReaderApp } from "@tmtp/reader-app";
import type { ReaderStore } from "@tmtp/reader-store";
import { ServiceError } from "./errors.js";
import type { IntegrationName, LocalHealthState, IntegrationHealthState } from "./health.js";

export type RunOnceResult =
  | { outcome: "idle" }
  | { outcome: "rejected"; job: Job }
  | { outcome: "completed" | "failed"; job: Job }
  | { outcome: "lease-lost"; jobId: string; kind: string; handlerOutcome: "completed" | "failed" };

interface WorkerOptions {
  jobs: JobQueue;
  readerApp: ReaderApp;
  sleep: Sleep;
  leaseMs: number;
  pollIntervalMs: number;
  logger: Logger;
  health: LocalHealthState;
  integrations: IntegrationHealthState;
  now: () => Date;
  operationSignal?: AbortSignal;
  onFatal?: () => void;
  store?: Readonly<ReaderStore>;
}

const kinds = Object.freeze(readerAppJobCodecs.map((codec) => codec.kind));

function integrationForKind(kind: string): IntegrationName | undefined {
  if (kind === "ingestion.collect") return "hnPublic";
  if (kind === "ingestion.reconcile-account") return "hnAccount";
  return undefined;
}

export class WorkerRunner {
  private state: "idle" | "running" | "stopping" | "stopped" = "idle";
  private lane: Promise<unknown> = Promise.resolve();
  private pollTask: Promise<void> | undefined;
  private idleController: AbortController | undefined;
  private jobController: AbortController | undefined;
  private heartbeatController: AbortController | undefined;

  constructor(private readonly options: WorkerOptions) {}

  get supportedKinds(): readonly string[] { return kinds; }

  start(): void {
    if (this.state !== "idle") throw new ServiceError("invalid-transition", 409);
    this.state = "running";
    this.idleController = new AbortController();
    this.pollTask = this.poll(this.idleController.signal);
    this.options.health.workersReady();
  }

  runNext(callerSignal?: AbortSignal): Promise<RunOnceResult> {
    const run = this.lane.then(() => this.execute(callerSignal), () => this.execute(callerSignal))
      .catch((error: unknown) => {
        if (!callerSignal?.aborted || error !== callerSignal.reason) this.fail();
        throw error;
      });
    this.lane = run.catch(() => undefined);
    return run;
  }

  private fail(): void {
    if (this.state === "stopping" || this.state === "stopped") return;
    this.stopClaims();
    this.options.health.workersFailed();
    this.options.logger.error("The durable worker loop failed.", { code: "worker-failed" });
    this.options.onFatal?.();
  }

  stopClaims(): void {
    if (this.state === "stopping" || this.state === "stopped") return;
    this.state = "stopping";
    this.idleController?.abort();
  }

  forceCancel(): void {
    this.heartbeatController?.abort();
    this.jobController?.abort();
  }

  async drain(): Promise<void> {
    this.stopClaims();
    await this.pollTask;
    await this.lane;
    this.state = "stopped";
  }

  private async poll(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted && this.state === "running") {
        const result = await this.runNext();
        if (result.outcome === "rejected") {
          this.options.logger.warn("Rejected a durable job with an invalid payload.", {
            jobId: result.job.id,
            kind: result.job.kind,
            code: result.job.lastErrorCode ?? "invalid-payload",
          });
        }
        if (result.outcome === "idle" && !signal.aborted && this.state === "running") {
          await this.options.sleep(this.options.pollIntervalMs, signal);
        }
      }
    } catch (error) {
      if (!signal.aborted) this.fail();
    }
  }

  private async execute(callerSignal?: AbortSignal): Promise<RunOnceResult> {
    if (this.state === "stopping" || this.state === "stopped") {
      throw new ServiceError("workers-stopped", 503);
    }
    callerSignal?.throwIfAborted();
    const claim = this.options.jobs.claim(kinds);
    if (claim.status === "idle") return { outcome: "idle" };
    if (claim.status === "rejected") return { outcome: "rejected", job: claim.job };
    const leased = claim.job;
    const token = leased.leaseToken;
    if (token === undefined) throw new ServiceError("internal-failure", 500);

    const jobController = new AbortController();
    const heartbeatController = new AbortController();
    this.jobController = jobController;
    this.heartbeatController = heartbeatController;
    const abortFromOperation = (): void => jobController.abort();
    const abortFromCaller = (): void => jobController.abort();
    this.options.operationSignal?.addEventListener("abort", abortFromOperation, { once: true });
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    if (this.options.operationSignal?.aborted) jobController.abort();
    if (callerSignal?.aborted) jobController.abort();

    let renewalFailure: unknown;
    let lostLease = false;
    const heartbeat = this.heartbeat(leased.id, token, heartbeatController.signal, (error) => {
      if (error instanceof JobQueueError && error.code === "lease-lost") lostLease = true;
      else renewalFailure = error;
      jobController.abort();
    });
    let handlerOutcome: "completed" | "failed" = "completed";
    let handlerError: unknown;
    try {
      await this.options.readerApp.runJob(leased, jobController.signal);
    } catch (error) {
      handlerOutcome = "failed";
      handlerError = error;
    } finally {
      heartbeatController.abort();
      await heartbeat;
      this.options.operationSignal?.removeEventListener("abort", abortFromOperation);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }

    if (renewalFailure !== undefined) throw renewalFailure;
    this.observeIntegration(leased, handlerOutcome, handlerError);
    try {
      if (handlerOutcome === "completed") this.options.jobs.complete(leased.id, token);
      else this.options.jobs.fail(leased.id, token, readerAppJobFailure(leased.kind, handlerError));
    } catch (error) {
      if (error instanceof JobQueueError && error.code === "lease-lost") lostLease = true;
      else throw error;
    } finally {
      this.jobController = undefined;
      this.heartbeatController = undefined;
    }
    if (lostLease) {
      return { outcome: "lease-lost", jobId: leased.id, kind: leased.kind, handlerOutcome };
    }
    const fresh = this.options.jobs.get(leased.id);
    if (fresh === undefined) throw new ServiceError("internal-failure", 500);
    return { outcome: handlerOutcome, job: fresh };
  }

  private observeIntegration(job: Job, handlerOutcome: "completed" | "failed", handlerError: unknown): void {
    const observedAt = this.options.now().toISOString();
    if (job.kind === "article.fetch-extract") {
      if (this.options.store === undefined) {
        if (handlerOutcome === "completed") this.options.integrations.available("article", observedAt);
        else this.options.integrations.failed("article", handlerError, observedAt);
        return;
      }
      const payload = job.payload as ArticleFetchExtractJobPayload;
      const article = this.options.store.articles.byStoryId(payload.storyId);
      if (article?.sourceContentVersion !== payload.storyContentVersion) return;
      if (article.status === "ready") this.options.integrations.available("article", observedAt);
      else if (article.status === "failed") {
        this.options.integrations.failed("article", article.errorCode === undefined ? handlerError : { code: article.errorCode }, observedAt);
      }
      return;
    }
    const integration = integrationForKind(job.kind);
    if (integration === undefined) return;
    if (handlerOutcome === "completed") this.options.integrations.available(integration, observedAt);
    else this.options.integrations.failed(integration, handlerError, observedAt);
  }

  private async heartbeat(
    jobId: string,
    token: string,
    signal: AbortSignal,
    onFailure: (error: unknown) => void,
  ): Promise<void> {
    const delay = Math.max(1, Math.floor(this.options.leaseMs / 3));
    try {
      while (!signal.aborted) {
        await this.options.sleep(delay, signal);
        if (signal.aborted) return;
        this.options.jobs.renew(jobId, token);
      }
    } catch (error) {
      if (!signal.aborted) onFailure(error);
    }
  }
}
