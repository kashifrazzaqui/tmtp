import type { Clock } from "@tmtp/clock";
import type { IsoDateTime } from "@tmtp/domain";
import { HnIngestionError } from "./errors.js";
import type { HnIngestionOperation } from "./types.js";
export function wallNow(clock: Clock): IsoDateTime {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("Invalid ingestion clock result.");
  return value.toISOString();
}
export function refreshCutoff(startedAt: IsoDateTime, refreshAfterMs: number, operation: HnIngestionOperation, runId?: string): IsoDateTime {
  const value = new Date(Date.parse(startedAt) - refreshAfterMs);
  if (!Number.isFinite(value.getTime())) throw new HnIngestionError("invalid-configuration", { operation, retryable: false, ...(runId === undefined ? {} : { runId }) });
  return value.toISOString();
}
export function check(signal: AbortSignal | undefined): void { if (signal?.aborted) throw signal.reason; }
