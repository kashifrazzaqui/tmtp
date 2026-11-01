import type { DebugStreamFrame } from "@tmtp/diagnostics";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServiceGraph } from "./composition.js";
import { ServiceOperations } from "./operations.js";

interface Connection {
  controller: AbortController;
  settled: Promise<void>;
}

export class DebugConnections {
  private readonly connections = new Set<Connection>();

  add(controller: AbortController, settled: Promise<void>): void {
    const connection = { controller, settled };
    this.connections.add(connection);
    void settled.finally(() => this.connections.delete(connection)).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    const current = [...this.connections];
    for (const connection of current) connection.controller.abort();
    await Promise.allSettled(current.map((connection) => connection.settled));
  }
}

function writeFrame(reply: FastifyReply, frame: DebugStreamFrame): void {
  reply.raw.write(`event: debug-snapshot\nid: ${frame.sequence}\ndata: ${JSON.stringify(frame)}\n\n`);
}

export function serveDebugStream(
  request: FastifyRequest,
  reply: FastifyReply,
  graph: ServiceGraph,
  query: Parameters<ServiceGraph["diagnostics"]["debugStream"]>[0],
  registry: DebugConnections,
): void {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  graph.operations.signal.addEventListener("abort", abort, { once: true });
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-request-id": String(request.id),
  });
  reply.raw.write("retry: 3000\n\n");

  const settled = (async () => {
    const iterator = graph.diagnostics.debugStream({ ...query, signal: controller.signal })[Symbol.asyncIterator]();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
      }, 15_000);
      heartbeat.unref();
      while (!controller.signal.aborted && !reply.raw.destroyed) {
        const next = await iterator.next();
        if (next.done) break;
        writeFrame(reply, next.value);
      }
    } catch (error) {
      if (!controller.signal.aborted && !reply.raw.destroyed) throw error;
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      graph.operations.signal.removeEventListener("abort", abort);
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abort);
      controller.abort();
      try { await iterator.return?.(); } catch { /* transport is already closed */ }
      if (!reply.raw.destroyed) reply.raw.end();
    }
  })();
  registry.add(controller, settled);
}
