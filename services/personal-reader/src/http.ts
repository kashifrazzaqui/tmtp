import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import type { FastifyError, FastifyInstance } from "fastify";
import { createAuth, OriginPolicy } from "./auth.js";
import type { ServiceGraph } from "./composition.js";
import { DebugConnections } from "./debug-transport.js";
import { errorEnvelope, ServiceError } from "./errors.js";
import { attachRequestContext, cleanupRequestContext } from "./request-context.js";
import { registerRoutes } from "./routes.js";
import { registerStaticUi } from "./static.js";
import type { WorkerRunner } from "./worker.js";

export const DEFAULT_STATIC_ROOT = fileURLToPath(new URL("../dist-ui/", import.meta.url));

export interface HttpTransport {
  app: FastifyInstance;
  origins: OriginPolicy;
  debugConnections: DebugConnections;
}

function frameworkError(error: FastifyError): ServiceError | undefined {
  if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") return new ServiceError("body-too-large", 413);
  if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return new ServiceError("unsupported-media-type", 415);
  if (error.code === "FST_ERR_CTP_INVALID_JSON_BODY" || error.code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
    return new ServiceError("invalid-input", 400);
  }
  return undefined;
}

export async function createHttpTransport(
  graph: ServiceGraph,
  worker: WorkerRunner,
  staticRoot = DEFAULT_STATIC_ROOT,
): Promise<HttpTransport> {
  const app = Fastify({
    trustProxy: graph.config.server.trust_proxy,
    bodyLimit: 1_048_576,
    logger: false,
    genReqId: () => randomUUID(),
  });
  try {
    const origins = new OriginPolicy(graph);
    const debugConnections = new DebugConnections();
    await app.register(fastifyCookie);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", String(request.id));
    const contentType = request.headers["content-type"];
    if (["POST", "PUT", "PATCH"].includes(request.method) && request.url.startsWith("/api/v1/") &&
      contentType !== undefined && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
      throw new ServiceError("unsupported-media-type", 415);
    }
    attachRequestContext(request, reply, graph.operations.signal);
  });
  app.addHook("onResponse", async (request, reply) => {
    cleanupRequestContext(request);
    graph.logger.info("HTTP request completed.", {
      requestId: String(request.id),
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      statusCode: reply.statusCode,
    });
  });
  app.addHook("onError", async (request, _reply, error) => {
    const mapped = frameworkError(error as FastifyError) ?? error;
    graph.logger.error("HTTP request failed.", {
      requestId: String(request.id),
      code: mapped instanceof ServiceError ? mapped.code : "internal-failure",
    });
  });
  app.setErrorHandler((error, request, reply) => {
    const mapped = frameworkError(error as FastifyError) ?? error;
    const envelope = errorEnvelope(mapped, String(request.id));
    void reply.code(envelope.statusCode).header("x-request-id", String(request.id)).send(envelope.body);
  });
  app.setNotFoundHandler((request, reply) => {
    const envelope = errorEnvelope(new ServiceError("not-found", 404), String(request.id));
    void reply.code(404).header("x-request-id", String(request.id)).send(envelope.body);
  });

    const auth = createAuth(graph, origins);
    await registerRoutes(app, graph, worker, auth, origins, debugConnections);
    await registerStaticUi(app, { root: staticRoot, debugEnabled: graph.config.debug.enabled });
    return { app, origins, debugConnections };
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
