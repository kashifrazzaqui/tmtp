import { cancelled } from "./errors.js";

export interface PipelineLock {
  run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T>;
}

export function createPipelineLock(): PipelineLock {
  let tail = Promise.resolve();
  return {
    run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
      let running = false;
      let onAbort: (() => void) | undefined;
      const cleanup = (): void => { if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort); };
      const aborted = new Promise<never>((_, reject) => {
        if (signal === undefined) return;
        onAbort = () => { if (!running) reject(cancelled()); };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      const result = tail.then(() => {
        running = true;
        cleanup();
        if (signal?.aborted) throw cancelled();
        return work();
      });
      tail = result.then(() => undefined, () => undefined);
      return Promise.race([result, aborted]).finally(cleanup);
    },
  };
}
