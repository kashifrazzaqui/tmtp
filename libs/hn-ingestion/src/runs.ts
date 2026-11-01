import { randomUUID } from "node:crypto";
import type { IngestionRun, IsoDateTime } from "@tmtp/domain";
import type { ReaderStore } from "@tmtp/reader-store";
import type { Clock } from "@tmtp/clock";
import { wallNow } from "./time.js";
import type { HnIngestionOperation } from "./types.js";
export interface RunContext { id: string; kind: string; operation: HnIngestionOperation; startedAt: IsoDateTime; cursorStart: string; }
export function startRun(store: ReaderStore, kind: string, operation: HnIngestionOperation, startedAt: IsoDateTime, cursorStart: string): RunContext {
  const context = { id: `run_${randomUUID()}`, kind, operation, startedAt, cursorStart };
  store.sync.startRun({ id: context.id, kind, status: "running", cursorStart, storiesUpserted: 0, nonStoriesSkipped: 0, startedAt });
  return context;
}
export function completeRun(context: RunContext, cursorEnd: string, completedAt: IsoDateTime, storiesUpserted: number, nonStoriesSkipped: number): IngestionRun {
  return { id: context.id, kind: context.kind, status: "complete", cursorStart: context.cursorStart, cursorEnd,
    storiesUpserted, nonStoriesSkipped, startedAt: context.startedAt, completedAt };
}
export function recordFailure(store: ReaderStore, clock: Clock, context: RunContext, code: string, message: string): void {
  try {
    const completedAt = wallNow(clock);
    store.sync.finishRun({ id: context.id, kind: context.kind, status: "failed", cursorStart: context.cursorStart, cursorEnd: context.cursorStart,
      storiesUpserted: 0, nonStoriesSkipped: 0, errorCode: code, errorMessage: message, startedAt: context.startedAt, completedAt });
  } catch { /* The original operation failure remains authoritative. */ }
}
