import { createScheduler } from "@tmtp/scheduler";
import type { Scheduler, SchedulerDriverFactory } from "@tmtp/scheduler";
import { ServiceError } from "./errors.js";
import { enqueuePersonalizationRecovery } from "./recovery.js";
import type { ServiceGraph } from "./composition.js";

export function createServiceScheduler(graph: ServiceGraph, driverFactory?: SchedulerDriverFactory): Scheduler {
  const scheduler = createScheduler({
    clock: graph.clock,
    logger: graph.logger.child({ component: "scheduler" }),
    timezone: graph.config.scheduler.timezone,
    overrunProtection: graph.config.scheduler.overrun_protection,
    ...(driverFactory === undefined ? {} : { driverFactory }),
  });
  scheduler.register({
    name: "ingestion.cron",
    expression: graph.config.ingestion.cron,
    run: async () => {
      let failed = false;
      try {
        graph.operations.signal.throwIfAborted();
        await graph.readerApp.scheduleIngestion(graph.operations.signal);
      } catch { failed = true; }
      if (graph.account !== undefined) {
        try {
          graph.operations.signal.throwIfAborted();
          await graph.readerApp.scheduleHnReconciliation(graph.operations.signal);
        } catch { failed = true; }
      }
      if (failed) throw new ServiceError("dependency-failure", 503, true);
    },
  });
  scheduler.register({
    name: "personalization.cron",
    expression: graph.config.personalization.cron,
    run: async () => {
      graph.operations.signal.throwIfAborted();
      enqueuePersonalizationRecovery(graph);
    },
  });
  return scheduler;
}
