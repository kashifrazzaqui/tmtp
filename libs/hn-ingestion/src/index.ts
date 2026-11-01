import { commitAccount, planAccount, readAccountPages } from "./account.js";
import { HnIngestionError, mapError } from "./errors.js";
import { fetchItems } from "./fetch-pool.js";
import { normalizeOptions } from "./options.js";
import { commitPublic, planPublic } from "./public.js";
import { recordFailure, startRun } from "./runs.js";
import type { RunContext } from "./runs.js";
import { check, wallNow } from "./time.js";
import type { AccountReconciliationSummary, HnIngestion, HnIngestionOperation, HnIngestionOptions, IngestionSummary } from "./types.js";

export { HN_INGESTION_JOB_PAYLOAD_SCHEMA_VERSION, hnIngestionJobCodecs, createHnIngestionJobEnqueue, hnIngestionJobFailure } from "./jobs.js";
export { HnIngestionError } from "./errors.js";
export type { IngestionSummary, AccountReconciliationSummary, HnIngestionOptions, HnIngestion, HnIngestionJobKind, HnIngestionJobPayload,
  HnIngestionJobDescription, HnIngestionOperation, HnIngestionDependency, HnIngestionErrorCode } from "./types.js";

function validateSignal(signal: AbortSignal | undefined, operation: HnIngestionOperation): void {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new HnIngestionError("invalid-input", { operation, retryable: false });
  check(signal);
}
export function createHnIngestion(input: HnIngestionOptions): HnIngestion {
  const options = normalizeOptions(input);
  let lane = Promise.resolve();
  function enqueue<T>(signal: AbortSignal | undefined, operation: HnIngestionOperation, work: () => Promise<T>): Promise<T> {
    let running = false;
    let onAbort: (() => void) | undefined;
    const cleanup = (): void => { if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort); };
    const aborted = new Promise<never>((_, reject) => {
      if (signal === undefined) return;
      onAbort = () => { if (!running) reject(signal.reason); };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const result = lane.then(() => { running = true; cleanup(); check(signal); return work(); });
    lane = result.then(() => undefined, () => undefined);
    return Promise.race([result, aborted]).finally(cleanup);
  }
  async function failure(error: unknown, signal: AbortSignal | undefined, operation: HnIngestionOperation, context: RunContext | undefined): Promise<never> {
    if (signal?.aborted) {
      if (context !== undefined) recordFailure(options.store, options.clock, context, "cancelled", "HN ingestion run was cancelled.");
      throw signal.reason;
    }
    const mapped = mapError(error, operation, context?.id);
    if (context !== undefined) recordFailure(options.store, options.clock, context, mapped.code, mapped.message);
    throw mapped;
  }
  async function collect(signal: AbortSignal | undefined): Promise<IngestionSummary> {
    let context: RunContext | undefined;
    try {
      const startedAt = wallNow(options.clock);
      const plan = await planPublic(options, startedAt, signal, (cursorStart) => {
        context = startRun(options.store, "hn.public.collect", "collect-public", startedAt, cursorStart);
      });
      const activeContext = context;
      if (activeContext === undefined) throw new TypeError("Ingestion run was not started.");
      check(signal);
      const fetched = await fetchItems(plan.ids, options.api, options.clock, signal);
      check(signal);
      const completedAt = wallNow(options.clock);
      return commitPublic(options, activeContext, plan, fetched, completedAt);
    } catch (error) { return failure(error, signal, "collect-public", context); }
  }
  async function reconcile(signal: AbortSignal | undefined): Promise<AccountReconciliationSummary> {
    let context: RunContext | undefined;
    try {
      if (options.account === undefined) throw new HnIngestionError("account-not-configured", { operation: "reconcile-account", retryable: false });
      const startedAt = wallNow(options.clock);
      const plan = await planAccount(options, signal, (cursorStart) => {
        context = startRun(options.store, "hn.account.reconcile", "reconcile-account", startedAt, cursorStart);
      });
      const activeContext = context;
      if (activeContext === undefined) throw new TypeError("Ingestion run was not started.");
      check(signal);
      const pages = await readAccountPages(options, plan, signal);
      check(signal);
      const completedAt = wallNow(options.clock);
      return commitAccount(options, activeContext, plan, pages, completedAt);
    } catch (error) { return failure(error, signal, "reconcile-account", context); }
  }
  return {
    async collectPublic(signal?: AbortSignal): Promise<IngestionSummary> {
      validateSignal(signal, "collect-public");
      return enqueue(signal, "collect-public", () => collect(signal));
    },
    async reconcileAccount(signal?: AbortSignal): Promise<AccountReconciliationSummary> {
      validateSignal(signal, "reconcile-account");
      return enqueue(signal, "reconcile-account", () => reconcile(signal));
    },
  };
}
