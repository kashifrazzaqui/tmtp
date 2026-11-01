import type { Clock, Sleep } from "@tmtp/clock";
import { DiagnosticsError } from "./errors.js";
import type { DebugSnapshot, DebugStreamFrame } from "./types.js";
import type { QueryPlans } from "./pages.js";

const RETURNED = Symbol("stream-returned");
interface StreamDependencies {
  clock: Clock;
  sleep: Sleep;
  intervalMs: number;
  plans: QueryPlans;
  snapshot: (plans: QueryPlans) => DebugSnapshot;
  signal?: AbortSignal;
}
export function debugStream(dependencies: StreamDependencies): AsyncIterable<DebugStreamFrame> {
  const { clock, sleep, intervalMs, plans, snapshot, signal } = dependencies;
  const controller = new AbortController();
  let settled = false;
  let callerAborted = false;
  let sequence = 1;
  let previousCompletion = 0;
  const onAbort = (): void => {
    if (settled) return;
    callerAborted = true;
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    controller.abort(signal?.reason);
  };
  signal?.addEventListener("abort", onAbort);
  const finishReturn = (): void => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    controller.abort(RETURNED);
  };
  const runNext = async (): Promise<IteratorResult<DebugStreamFrame>> => {
    if (callerAborted || (signal?.aborted && !settled)) {
      if (!callerAborted) onAbort();
      throw signal?.reason;
    }
    if (settled) return { done: true, value: undefined };
    if (sequence > 1) {
      const elapsed = Math.max(0, clock.monotonicNowMs() - previousCompletion);
      const wait = Math.max(0, Math.ceil(intervalMs - elapsed));
      if (wait > 0) {
        try { await sleep(wait, controller.signal); }
        catch (error) {
          if (callerAborted || signal?.aborted) throw signal?.reason;
          if (error === RETURNED || controller.signal.reason === RETURNED) return { done: true, value: undefined };
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          throw error;
        }
      }
      if (callerAborted || signal?.aborted) throw signal?.reason;
      if (settled) return { done: true, value: undefined };
    }
    const value = snapshot(plans);
    previousCompletion = clock.monotonicNowMs();
    if (callerAborted || signal?.aborted) throw signal?.reason;
    if (settled) return { done: true, value: undefined };
    const frame = { sequence, snapshot: value };
    sequence += 1;
    return { done: false, value: frame };
  };
  let chain = Promise.resolve();
  const iterator: AsyncIterator<DebugStreamFrame> & AsyncIterable<DebugStreamFrame> = {
    next(): Promise<IteratorResult<DebugStreamFrame>> {
      const result = chain.then(runNext);
      chain = result.then(() => undefined, () => undefined);
      return result;
    },
    return(): Promise<IteratorResult<DebugStreamFrame>> {
      finishReturn();
      return Promise.resolve({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() { return this; },
  };
  return iterator;
}
export function validateStreamSignal(signal: AbortSignal | undefined): void {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new DiagnosticsError("invalid-input");
}
