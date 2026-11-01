import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleWithinGrace } from "../src/lifecycle.js";

const mocks = vi.hoisted(() => ({
  current: {} as {
    graph: any;
    transport: any;
    scheduler: any;
    worker: any;
    probes: Promise<unknown>;
    probeController?: AbortController;
    workerOptions?: { onFatal?: () => void };
  },
}));

vi.mock("../src/composition.js", () => ({
  composeService: vi.fn(async () => mocks.current.graph),
}));
vi.mock("../src/http.js", () => ({
  createHttpTransport: vi.fn(async () => mocks.current.transport),
}));
vi.mock("../src/probes.js", () => ({
  runCapabilityProbes: vi.fn(() => mocks.current.probes),
}));
vi.mock("../src/recovery.js", () => ({
  ensureStartupRecovery: vi.fn(async () => undefined),
}));
vi.mock("../src/schedules.js", () => ({
  createServiceScheduler: vi.fn(() => mocks.current.scheduler),
}));
vi.mock("../src/storage.js", () => ({
  recoverExpiredLeases: vi.fn(),
}));
vi.mock("../src/worker.js", () => ({
  WorkerRunner: class {
    constructor(options: { onFatal?: () => void }) {
      mocks.current.workerOptions = options;
    }
    start(): void { mocks.current.worker.start(); }
    stopClaims(): void { mocks.current.worker.stopClaims(); }
    forceCancel(): void { mocks.current.worker.forceCancel(); }
    drain(): Promise<void> { return mocks.current.worker.drain(); }
  },
}));

import { startService } from "../src/service.js";

function pending<T = void>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

beforeEach(() => {
  const operationController = new AbortController();
  const logger = {
    child: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  const graph = {
    config: {
      server: { host: "127.0.0.1", port: 0, shutdown_grace_ms: 10 },
      jobs: { batch_size: 10, lease_ms: 30_000, poll_interval_ms: 10 },
    },
    jobs: {},
    readerApp: {},
    logger,
    sleep,
    health: { workersStopped: vi.fn(), workersFailed: vi.fn() },
    integrations: {},
    clock: { now: () => new Date("2026-01-02T03:04:05.000Z") },
    operations: {
      signal: operationController.signal,
      child: () => {
        mocks.current.probeController = new AbortController();
        return mocks.current.probeController;
      },
      track: (promise: Promise<unknown>) => promise,
      abort: vi.fn(() => operationController.abort()),
    },
    closeLocal: vi.fn(async () => undefined),
  };
  const transport = {
    app: {
      server: { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 1234 }) },
      listen: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
    debugConnections: { closeAll: vi.fn(async () => undefined) },
    origins: { origin: "http://127.0.0.1:1234", bound: vi.fn() },
  };
  mocks.current = {
    graph,
    transport,
    scheduler: { start: vi.fn(), stop: vi.fn(async () => undefined) },
    worker: {
      start: vi.fn(),
      stopClaims: vi.fn(),
      forceCancel: vi.fn(),
      drain: vi.fn(async () => undefined),
    },
    probes: Promise.resolve({ llm: true, hnPublic: true }),
  };
});

describe("reviewed lifecycle cleanup", () => {
  it("should cancel the grace sleep as soon as settlement wins", async () => {
    let graceSignal: AbortSignal | undefined;
    let cancelled = false;
    const graceSleep = vi.fn((_delayMs: number, signal?: AbortSignal) => {
      graceSignal = signal;
      signal?.addEventListener("abort", () => { cancelled = true; }, { once: true });
      return pending();
    });

    await expect(settleWithinGrace(Promise.resolve("settled"), 60_000, graceSleep)).resolves.toBe(true);
    expect(graceSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("should fail startup through normal cleanup when a worker fails during listen", async () => {
    mocks.current.transport.app.listen.mockImplementation(async () => {
      mocks.current.workerOptions?.onFatal?.();
    });

    await expect(startService({ installSignalHandlers: false })).rejects.toMatchObject({ code: "worker-failed" });

    expect(mocks.current.transport.app.close).toHaveBeenCalledOnce();
    expect(mocks.current.scheduler.stop).toHaveBeenCalledOnce();
    expect(mocks.current.worker.drain).toHaveBeenCalledOnce();
    expect(mocks.current.graph.closeLocal).toHaveBeenCalledOnce();
  });

  it("should include debug probe scheduler and worker drains in one grace bound", async () => {
    mocks.current.graph.config.server.shutdown_grace_ms = 5;
    mocks.current.transport.debugConnections.closeAll.mockReturnValue(pending());
    mocks.current.probes = pending();
    mocks.current.scheduler.stop.mockReturnValue(pending());
    mocks.current.worker.drain.mockReturnValue(pending());
    const running = await startService({ installSignalHandlers: false });

    await expect(running.close()).rejects.toMatchObject({ code: "shutdown-failed" });

    expect(mocks.current.transport.debugConnections.closeAll).toHaveBeenCalledOnce();
    expect(mocks.current.scheduler.stop).toHaveBeenCalledOnce();
    expect(mocks.current.worker.drain).toHaveBeenCalledOnce();
    expect(mocks.current.worker.forceCancel).toHaveBeenCalledOnce();
    expect(mocks.current.graph.closeLocal).not.toHaveBeenCalled();
  }, 1_000);

  it("should cancel probes before awaiting a non-cooperative debug close", async () => {
    mocks.current.transport.debugConnections.closeAll.mockReturnValue(pending());
    const running = await startService({ installSignalHandlers: false });

    const closing = running.close();
    const rejection = expect(closing).rejects.toMatchObject({ code: "shutdown-failed" });
    expect(mocks.current.probeController?.signal.aborted).toBe(true);
    await rejection;
  }, 1_000);

  it("should report a rejected worker drain instead of false shutdown success", async () => {
    const failure = new Error("worker-drain-failed");
    mocks.current.worker.drain.mockRejectedValue(failure);
    const running = await startService({ installSignalHandlers: false });

    await expect(running.close()).rejects.toBe(failure);
    await expect(running.closed).resolves.toBe(false);
    expect(mocks.current.graph.closeLocal).toHaveBeenCalledOnce();
  });

  it("should continue settled reverse cleanup after independent failures", async () => {
    const fastifyFailure = new Error("fastify-close-failed");
    mocks.current.transport.app.close.mockRejectedValue(fastifyFailure);
    mocks.current.scheduler.stop.mockRejectedValue(new Error("scheduler-stop-failed"));
    mocks.current.worker.drain.mockRejectedValue(new Error("worker-drain-failed"));
    mocks.current.graph.closeLocal.mockRejectedValue(new Error("local-close-failed"));
    const running = await startService({ installSignalHandlers: false });

    await expect(running.close()).rejects.toBe(fastifyFailure);

    expect(mocks.current.scheduler.stop).toHaveBeenCalledOnce();
    expect(mocks.current.worker.stopClaims).toHaveBeenCalledOnce();
    expect(mocks.current.worker.drain).toHaveBeenCalledOnce();
    expect(mocks.current.graph.closeLocal).toHaveBeenCalledOnce();
    expect(mocks.current.graph.logger.info).not.toHaveBeenCalledWith(
      "Personal reader stopped.", { code: "shutdown-complete" },
    );
  });
});
