import { createPersonalizationJobEnqueue } from "@tmtp/personalization";
import type { Job } from "@tmtp/domain";
import type { ServiceGraph } from "./composition.js";

export function enqueuePersonalizationRecovery(graph: ServiceGraph): Job {
  return graph.jobs.enqueue(createPersonalizationJobEnqueue({
    kind: "personalization.recover",
    payload: {},
    runAfter: graph.clock.now().toISOString(),
  })).job;
}

export async function ensureStartupRecovery(graph: ServiceGraph, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await graph.readerApp.scheduleIngestion(signal);
  if (graph.account !== undefined) {
    signal?.throwIfAborted();
    await graph.readerApp.scheduleHnReconciliation(signal);
  }
  signal?.throwIfAborted();
  enqueuePersonalizationRecovery(graph);
}
