import { parseActivityBatch } from "@tmtp/activity";
import { z } from "@tmtp/config";
import { PreferenceRuleSchema } from "@tmtp/domain";
import type { IngestionSummary } from "@tmtp/hn-ingestion";
import type { RecoverySummary } from "@tmtp/personalization";
import type { ActivityHistoryQuery, HnActionHistoryQuery, ReaderQueueQuery, RecommendationHistoryQuery } from "@tmtp/reader-app";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { createAuth, OriginPolicy } from "./auth.js";
import { clearLoginCookie, setLoginCookie } from "./auth.js";
import type { ServiceGraph } from "./composition.js";
import type { DebugConnections } from "./debug-transport.js";
import { serveDebugStream } from "./debug-transport.js";
import {
  mapAccountCapability as accountCapabilityDto,
  mapActivityEvent as activityEventDto,
  mapHnActionHistory as hnActionHistoryDto,
  mapHnActionResult as hnActionResultDto,
  mapInterestProfile as interestProfileDto,
  mapJob as jobDto,
  mapPreferenceRule as preferenceRuleDto,
  mapQueueEntry as queueEntryDto,
  mapQueuePage as queuePageDto,
  mapReadingSession as readingSessionDto,
  mapRecommendation as recommendationDto,
  mapStoryDetail as storyDetailDto,
} from "./dto.js";
import { ServiceError } from "./errors.js";
import { enqueuePersonalizationRecovery } from "./recovery.js";
import { requestSignal } from "./request-context.js";
import type { RunOnceResult, WorkerRunner } from "./worker.js";

const canonicalInteger = z.string().regex(/^(?:0|[1-9]\d*)$/).transform(Number)
  .refine((value) => Number.isSafeInteger(value));
const storyIdText = z.string().regex(/^[1-9]\d*$/).transform(Number)
  .refine((value) => Number.isSafeInteger(value));
const queueState = z.enum(["unread", "reading", "read", "dismissed", "archived"]);
const evaluationState = z.enum(["pending", "scored", "failed"]);
const visibilityState = z.enum(["visible", "blacklisted"]);
const jobStatus = z.enum(["queued", "leased", "done", "failed"]);

function parsed<T>(schema: z.ZodType<T>, input: unknown, code = "invalid-query"): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ServiceError(code, 400);
  return result.data;
}

function noBody(request: FastifyRequest): void {
  if (request.body !== undefined) throw new ServiceError("invalid-input", 400);
}

function defined<T>(value: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function historyLimit(graph: ServiceGraph) {
  return canonicalInteger.refine((value) => value >= 1 && value <= graph.config.queue.max_page_size)
    .default(graph.config.queue.page_size);
}

function runOnceDto(result: RunOnceResult): unknown {
  if (result.outcome === "idle") return { outcome: "idle" };
  if (result.outcome === "lease-lost") return result;
  return { outcome: result.outcome, job: jobDto(result.job) };
}

function ingestionDto(value: IngestionSummary): IngestionSummary {
  return {
    runId: value.runId,
    highestSeenItemId: value.highestSeenItemId,
    storiesUpserted: value.storiesUpserted,
    nonStoriesSkipped: value.nonStoriesSkipped,
    jobsEnqueued: value.jobsEnqueued,
  };
}

function recoveryDto(value: RecoverySummary): RecoverySummary {
  return {
    completion: value.completion,
    scored: value.scored,
    failed: value.failed,
    retryableFailed: value.retryableFailed,
    queued: value.queued,
    audits: value.audits,
    rebuilt: value.rebuilt,
  };
}

const debugSections = ["syncRuns", "jobs", "llmCalls", "recentErrors", "recommendationVersions"] as const;

function debugQuery(request: FastifyRequest, stream: boolean): Record<string, unknown> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const section of debugSections) {
    shape[`${section}.limit`] = canonicalInteger.refine((value) => value >= 1 && value <= 50).optional();
    if (!stream) shape[`${section}.after`] = z.string().min(1).optional();
  }
  shape["jobs.status"] = jobStatus.optional();
  shape["jobs.kind"] = z.string().min(1).max(64).optional();
  const input = parsed(z.strictObject(shape), request.query);
  const result: Record<string, Record<string, unknown>> = {};
  for (const section of debugSections) {
    const limit = input[`${section}.limit`];
    const after = stream ? undefined : input[`${section}.after`];
    const status = section === "jobs" ? input["jobs.status"] : undefined;
    const kind = section === "jobs" ? input["jobs.kind"] : undefined;
    if (limit !== undefined || after !== undefined || status !== undefined || kind !== undefined) {
      result[section] = {
        ...(limit === undefined ? {} : { limit }),
        ...(after === undefined ? {} : { after }),
        ...(status === undefined ? {} : { status }),
        ...(kind === undefined ? {} : { kind }),
      };
    }
  }
  return result;
}

export async function registerRoutes(
  app: FastifyInstance,
  graph: ServiceGraph,
  worker: WorkerRunner,
  auth: ReturnType<typeof createAuth>,
  origins: OriginPolicy,
  debugConnections: DebugConnections,
): Promise<void> {
  const protectedGet = { preHandler: auth.authenticate };
  const mutation = { preHandler: auth.mutationGuard };
  const debugMutation = { preHandler: auth.debugGuard };

  app.get("/health/live", async () => graph.diagnostics.liveness());
  app.get("/health/ready", async (_request, reply) => {
    const snapshot = graph.diagnostics.readiness(graph.health.readiness(graph.database));
    return reply.code(snapshot.status === "ready" ? 200 : 503).send(snapshot);
  });
  app.get("/health/capabilities", async () => graph.diagnostics.capabilities(
    graph.integrations.input(graph.health.readiness(graph.database)),
  ));

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = parsed(z.strictObject({ accessToken: z.string() }), request.body, "invalid-input");
    const issued = await auth.login(body.accessToken);
    setLoginCookie(reply, graph, origins, issued.opaqueSession);
    return { expiresAt: issued.expiresAt, csrfSecret: issued.csrfSecret };
  });
  app.post("/api/v1/auth/logout", mutation, async (request, reply) => {
    noBody(request);
    await auth.logout(request);
    clearLoginCookie(reply, graph, origins);
    return reply.code(204).send();
  });
  app.get("/api/v1/auth/session", async (request) => {
    const session = await auth.optionalSession(request);
    return session === undefined
      ? { authenticated: false }
      : { authenticated: true, expiresAt: session.expiresAt, csrfState: "stored" };
  });

  app.get("/api/v1/queue", protectedGet, async (request) => {
    const schema = z.strictObject({
      state: queueState.optional(),
      evaluationState: evaluationState.optional(),
      visibilityState: visibilityState.default("visible"),
      cursor: z.string().min(1).optional(),
      limit: historyLimit(graph),
    });
    const query = parsed(schema, request.query);
    const result = await graph.readerApp.getQueue(defined<ReaderQueueQuery>(query), requestSignal(request));
    return queuePageDto(result);
  });
  app.patch("/api/v1/queue/:storyId", mutation, async (request) => {
    const params = parsed(z.strictObject({ storyId: storyIdText }), request.params, "invalid-input");
    const body = parsed(z.strictObject({ state: queueState }), request.body, "invalid-input");
    return queueEntryDto(await graph.readerApp.setQueueState(params.storyId, body.state, requestSignal(request)));
  });
  app.get("/api/v1/stories/:storyId", protectedGet, async (request) => {
    const params = parsed(z.strictObject({ storyId: storyIdText }), request.params, "invalid-input");
    return storyDetailDto(await graph.readerApp.getStory(params.storyId, requestSignal(request)));
  });
  app.get("/api/v1/stories/:storyId/recommendations", protectedGet, async (request) => {
    const params = parsed(z.strictObject({ storyId: storyIdText }), request.params, "invalid-input");
    const query = parsed(z.strictObject({ afterId: z.string().min(1).optional(), limit: historyLimit(graph) }), request.query);
    const result = await graph.readerApp.getRecommendationHistory(
      defined<RecommendationHistoryQuery>({ storyId: params.storyId, ...query }), requestSignal(request),
    );
    return result.map(recommendationDto);
  });
  app.get("/api/v1/stories/:storyId/hn-actions", protectedGet, async (request) => {
    const params = parsed(z.strictObject({ storyId: storyIdText }), request.params, "invalid-input");
    const query = parsed(z.strictObject({ afterId: z.string().min(1).optional(), limit: historyLimit(graph) }), request.query);
    const result = await graph.readerApp.getHnActionHistory(
      defined<HnActionHistoryQuery>({ storyId: params.storyId, ...query }), requestSignal(request),
    );
    return result.map(hnActionHistoryDto);
  });
  app.post("/api/v1/stories/:storyId/article-refresh", mutation, async (request, reply) => {
    noBody(request);
    const params = parsed(z.strictObject({ storyId: storyIdText }), request.params, "invalid-input");
    const job = await graph.readerApp.refreshArticle(params.storyId, requestSignal(request));
    return reply.code(202).send(jobDto(job));
  });

  app.post("/api/v1/activity/batches", mutation, async (request) => {
    const body = parsed(z.strictObject({ batch: z.array(z.unknown()) }), request.body, "invalid-input");
    const batch = parseActivityBatch(body.batch);
    const result = await graph.readerApp.recordActivity(batch, requestSignal(request));
    return { accepted: result.accepted, profileWorkEnqueued: result.profileWorkEnqueued };
  });
  app.get("/api/v1/activity", protectedGet, async (request) => {
    const query = parsed(z.strictObject({
      storyId: storyIdText.optional(),
      clientEventId: z.string().min(1).optional(),
      afterEventId: z.string().min(1).optional(),
      afterSessionId: z.string().min(1).optional(),
      limit: historyLimit(graph),
    }), request.query);
    const result = await graph.readerApp.getActivity(defined<ActivityHistoryQuery>(query), requestSignal(request));
    return { events: result.events.map(activityEventDto), sessions: result.sessions.map(readingSessionDto) };
  });
  app.get("/api/v1/preferences", protectedGet, async (request) => {
    const result = await graph.readerApp.getPreferences(requestSignal(request));
    return result.map(preferenceRuleDto);
  });
  app.put("/api/v1/preferences", mutation, async (request) => {
    const body = parsed(z.strictObject({ rules: z.array(PreferenceRuleSchema) }), request.body, "invalid-input");
    return interestProfileDto(await graph.readerApp.replacePreferences(body.rules, requestSignal(request)));
  });
  app.post("/api/v1/personalization/rebuild", mutation, async (request) => {
    const body = parsed(z.strictObject({ reason: z.string().min(1) }), request.body, "invalid-input");
    return interestProfileDto(await graph.readerApp.rebuildPersonalization(body.reason, requestSignal(request)));
  });

  app.get("/api/v1/hn/capabilities", protectedGet, async (request) => {
    const result = await graph.readerApp.getHnCapabilities(requestSignal(request));
    return result.map(accountCapabilityDto);
  });
  app.post("/api/v1/hn/actions", mutation, async (request) => {
    const body = parsed(z.strictObject({
      storyId: z.number().int().positive().safe(),
      action: z.enum(["upvote", "flag", "favorite"]),
      idempotencyKey: z.string().min(1),
    }), request.body, "invalid-input");
    return hnActionResultDto(await graph.readerApp.performHnAction(body, requestSignal(request)));
  });
  app.post("/api/v1/hn/reconcile", mutation, async (request, reply) => {
    noBody(request);
    return reply.code(202).send(jobDto(await graph.readerApp.scheduleHnReconciliation(requestSignal(request))));
  });

  app.post("/api/v1/operations/ingestion", mutation, async (request, reply) => {
    noBody(request);
    const query = parsed(z.strictObject({ mode: z.enum(["enqueue", "run"]).default("enqueue") }), request.query);
    if (query.mode === "run") {
      try {
        const result = await graph.readerApp.runIngestion(requestSignal(request));
        graph.integrations.available("hnPublic", graph.clock.now().toISOString());
        return ingestionDto(result);
      } catch (error) {
        graph.integrations.failed("hnPublic", error, graph.clock.now().toISOString());
        throw error;
      }
    }
    return reply.code(202).send(jobDto(await graph.readerApp.scheduleIngestion(requestSignal(request))));
  });
  app.post("/api/v1/operations/personalization", mutation, async (request, reply) => {
    noBody(request);
    const query = parsed(z.strictObject({ mode: z.enum(["enqueue", "run"]).default("enqueue") }), request.query);
    if (query.mode === "run") return recoveryDto(await graph.readerApp.runPersonalization(requestSignal(request)));
    requestSignal(request).throwIfAborted();
    return reply.code(202).send(jobDto(enqueuePersonalizationRecovery(graph)));
  });
  app.post("/api/v1/operations/jobs/run-once", mutation, async (request) => {
    noBody(request);
    requestSignal(request).throwIfAborted();
    return runOnceDto(await worker.runNext(requestSignal(request)));
  });

  if (graph.config.debug.enabled) {
    app.get("/api/v1/debug/state", debugMutation, async (request) => {
      return graph.diagnostics.debugSnapshot(debugQuery(request, false));
    });
    app.get("/api/v1/debug/stream", debugMutation, async (request, reply) => {
      serveDebugStream(request, reply, graph, { query: debugQuery(request, true) }, debugConnections);
      return reply;
    });
  }
}
