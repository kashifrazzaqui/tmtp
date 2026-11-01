import type { Server } from "node:http";
import { composeService } from "./composition.js";
import type { CompositionOptions, ServiceGraph } from "./composition.js";
import { createHttpTransport } from "./http.js";
import type { HttpTransport } from "./http.js";
import { settleWithinGrace, yieldToCooperativeCancellation } from "./lifecycle.js";
import { runCapabilityProbes } from "./probes.js";
import type { ProbeResults } from "./probes.js";
import { ensureStartupRecovery } from "./recovery.js";
import { createServiceScheduler } from "./schedules.js";
import { recoverExpiredLeases } from "./storage.js";
import { ServiceError } from "./errors.js";
import { WorkerRunner } from "./worker.js";
import type { Scheduler } from "@tmtp/scheduler";

export interface StartOptions extends CompositionOptions {
  staticRoot?: string;
  installSignalHandlers?: boolean;
}

export interface RunningService {
  graph: ServiceGraph;
  worker: WorkerRunner;
  scheduler: Scheduler;
  transport: HttpTransport;
  origin: string;
  port: number;
  probes: Promise<ProbeResults>;
  closed: Promise<boolean>;
  close(): Promise<void>;
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new ServiceError("internal-failure", 500);
  return address.port;
}

export async function startService(options: StartOptions): Promise<RunningService> {
  const graph = await composeService(options);
  let worker: WorkerRunner | undefined;
  let scheduler: Scheduler | undefined;
  let transport: HttpTransport | undefined;
  let probeController: AbortController | undefined;
  let probes: Promise<ProbeResults> | undefined;
  let startedWorker = false;
  let startedScheduler = false;
  let fatalError: unknown;
  let close: (() => Promise<void>) | undefined;
  let fatalClosePending = false;
  const cleanupResources = async (startupFailure: boolean): Promise<{ clean: boolean; failures: unknown[] }> => {
    const failures: unknown[] = [];
    const observe = async (operation: () => unknown): Promise<void> => {
      try { await operation(); } catch (error) { failures.push(error); }
    };
    const graceful = (async (): Promise<void> => {
      let fastifyClose: Promise<void> | undefined;
      let debugClose: Promise<void> | undefined;
      if (transport !== undefined) {
        fastifyClose = observe(() => transport!.app.close());
        debugClose = observe(() => transport!.debugConnections.closeAll());
      }
      probeController?.abort();
      const probeDrain = probes?.catch(() => undefined);
      if (debugClose !== undefined) await debugClose;
      if (probeDrain !== undefined) await probeDrain;
      if (startedScheduler && scheduler !== undefined) await observe(() => scheduler!.stop());
      if (worker !== undefined) {
        worker.stopClaims();
        if (startupFailure) worker.forceCancel();
      }
      const drains: Promise<unknown>[] = [];
      if (fastifyClose !== undefined) drains.push(fastifyClose);
      if (worker !== undefined && (!startupFailure || startedWorker)) drains.push(observe(() => worker!.drain()));
      await Promise.all(drains);
    })();
    const settlement = Promise.allSettled([graceful]);
    const clean = await settleWithinGrace(settlement, graph.config.server.shutdown_grace_ms, graph.sleep);
    if (!clean) {
      if (startedScheduler && scheduler !== undefined) void scheduler.stop().catch(() => undefined);
      worker?.stopClaims();
      worker?.forceCancel();
      if (worker !== undefined) void worker.drain().catch(() => undefined);
      graph.operations.abort();
      await yieldToCooperativeCancellation();
      return { clean, failures };
    }
    graph.operations.abort();
    try { await graph.closeLocal(); } catch (error) { failures.push(error); }
    return { clean, failures };
  };
  try {
    recoverExpiredLeases(graph.jobs, graph.config.jobs.batch_size);
    await ensureStartupRecovery(graph, graph.operations.signal);
    worker = new WorkerRunner({
      jobs: graph.jobs,
      readerApp: graph.readerApp,
      sleep: graph.sleep,
      leaseMs: graph.config.jobs.lease_ms,
      pollIntervalMs: graph.config.jobs.poll_interval_ms,
      logger: graph.logger.child({ component: "worker" }),
      health: graph.health,
      integrations: graph.integrations,
      now: graph.clock.now,
      operationSignal: graph.operations.signal,
      store: graph.store,
      onFatal: () => {
        fatalError ??= new ServiceError("worker-failed", 503);
        if (close === undefined) fatalClosePending = true;
        else void close();
      },
    });
    scheduler = createServiceScheduler(graph);
    transport = await createHttpTransport(graph, worker, options.staticRoot);
    worker.start();
    startedWorker = true;
    scheduler.start();
    startedScheduler = true;
    await transport.app.listen({ host: graph.config.server.host, port: graph.config.server.port });
    if (fatalError !== undefined) throw fatalError;
    const port = boundPort(transport.app.server);
    transport.origins.bound(port);
    probeController = graph.operations.child();
    probes = graph.operations.track(runCapabilityProbes(graph, probeController.signal));

    let closing: Promise<void> | undefined;
    let settleClosed!: (clean: boolean) => void;
    const closed = new Promise<boolean>((resolve) => { settleClosed = resolve; });
    const closeService = (): Promise<void> => {
      if (closing !== undefined) return closing;
      closing = (async () => {
        graph.health.workersStopped();
        const cleanup = await cleanupResources(false);
        if (!cleanup.clean) throw new ServiceError("shutdown-failed", 500);
        const firstError = cleanup.failures[0] ?? fatalError;
        if (firstError !== undefined) {
          graph.logger.error("Personal reader shutdown failed.", { code: "shutdown-failed" });
          throw firstError;
        }
        graph.logger.info("Personal reader stopped.", { code: "shutdown-complete" });
      })();
      void closing.then(() => settleClosed(true), () => settleClosed(false));
      return closing;
    };
    close = closeService;
    if (fatalClosePending) void closeService();
    const running: RunningService = {
      graph,
      worker,
      scheduler,
      transport,
      origin: transport.origins.origin,
      port,
      probes,
      closed,
      close: closeService,
    };
    if (options.installSignalHandlers !== false) {
      const remove = (): void => {
        process.removeListener("SIGINT", shutdown);
        process.removeListener("SIGTERM", shutdown);
      };
      const shutdown = (): void => { void closeService().finally(remove).catch(() => undefined); };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    }
    return running;
  } catch (error) {
    graph.health.workersStopped();
    graph.operations.abort();
    const cleanup = await cleanupResources(true);
    if (!cleanup.clean || cleanup.failures.length > 0) throw new ServiceError("shutdown-failed", 500);
    throw error;
  }
}

export { composeService } from "./composition.js";
export { createHttpTransport } from "./http.js";
export { WorkerRunner } from "./worker.js";
export { recoverExpiredLeases } from "./storage.js";
export { runCapabilityProbes } from "./probes.js";
