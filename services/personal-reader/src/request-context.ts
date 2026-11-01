import type { FastifyReply, FastifyRequest } from "fastify";
import { ServiceError } from "./errors.js";

interface RequestContext {
  controller: AbortController;
  abort(): void;
  cleanup(): void;
}

const contexts = new WeakMap<FastifyRequest, RequestContext>();

export function attachRequestContext(
  request: FastifyRequest,
  reply: FastifyReply,
  operationSignal: AbortSignal,
): void {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const serviceAbort = (): void => controller.abort();
  const responseClose = (): void => { if (!reply.raw.writableEnded) abort(); };
  operationSignal.addEventListener("abort", serviceAbort, { once: true });
  request.raw.once("aborted", abort);
  reply.raw.once("close", responseClose);
  contexts.set(request, {
    controller,
    abort,
    cleanup() {
      operationSignal.removeEventListener("abort", serviceAbort);
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", responseClose);
    },
  });
}

export function requestSignal(request: FastifyRequest): AbortSignal {
  const context = contexts.get(request);
  if (context === undefined) throw new ServiceError("internal-failure", 500);
  return context.controller.signal;
}

export function cleanupRequestContext(request: FastifyRequest): void {
  contexts.get(request)?.cleanup();
  contexts.delete(request);
}
