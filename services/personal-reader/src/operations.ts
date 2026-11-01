export class ServiceOperations {
  readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly listeners = new Map<AbortController, () => void>();

  get signal(): AbortSignal { return this.controller.signal; }

  child(): AbortController {
    const controller = new AbortController();
    const abort = (): void => controller.abort(this.controller.signal.reason);
    if (this.controller.signal.aborted) abort();
    else {
      this.controller.signal.addEventListener("abort", abort, { once: true });
      this.listeners.set(controller, abort);
    }
    return controller;
  }

  releaseChild(controller: AbortController): void {
    const listener = this.listeners.get(controller);
    if (listener !== undefined) this.controller.signal.removeEventListener("abort", listener);
    this.listeners.delete(controller);
  }

  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
    return promise;
  }

  abort(reason?: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  async drain(): Promise<boolean> {
    const results = await Promise.allSettled([...this.pending]);
    for (const [controller, listener] of this.listeners) {
      this.controller.signal.removeEventListener("abort", listener);
      controller.abort(this.controller.signal.reason);
    }
    this.listeners.clear();
    return results.every((result) => result.status === "fulfilled");
  }
}
