import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixedClock } from "@tmtp/clock";
import type { FixedClock } from "@tmtp/clock";
import { noopLogger } from "@tmtp/logging";
import { composeService } from "../src/composition.js";
import type { LoadedSecrets, ServiceGraph } from "../src/composition.js";
import { loadConfig } from "../src/config.js";
import type { ResolvedConfig } from "../src/config.js";
import type { CompositionOptions } from "../src/composition.js";
import { createHttpTransport } from "../src/http.js";
import type { HttpTransport } from "../src/http.js";
import { createSecretRedactionRegistry, loadStartupSecrets } from "../src/secrets.js";
import { WorkerRunner } from "../src/worker.js";

export const ACCESS_TOKEN = "test-access-token-32-characters-0001";
export const LLM_KEY = "test-llm-key-sentinel-0001";
export const NOW = new Date("2026-01-02T03:04:05.000Z");

export interface TestGraph {
  graph: ServiceGraph;
  config: ResolvedConfig;
  clock: FixedClock;
  directory: string;
  close(): Promise<void>;
}

function mergeRaw(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const current = result[key];
    result[key] = value !== null && typeof value === "object" && !Array.isArray(value) &&
      current !== null && typeof current === "object" && !Array.isArray(current)
      ? mergeRaw(current as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return result;
}

export async function testGraph(
  overrides: Record<string, unknown> = {},
  seams: CompositionOptions["adapters"] & { accountCookie?: string } = {},
): Promise<TestGraph> {
  const directory = await mkdtemp(join(tmpdir(), "personal-reader-"));
  const accessPath = join(directory, "access-token");
  const llmPath = join(directory, "llm-key");
  await writeFile(accessPath, `${ACCESS_TOKEN}\n`, "utf8");
  await writeFile(llmPath, `${LLM_KEY}\n`, "utf8");
  const { accountCookie, ...adapters } = seams;
  if (accountCookie !== undefined) await writeFile(join(directory, "hn-cookie"), accountCookie, "utf8");
  const config = loadConfig(mergeRaw({
    server: { host: "127.0.0.1", port: 0, shutdown_grace_ms: 100 },
    auth: { access_token_path: accessPath },
    database: { path: join(directory, "reader.sqlite") },
    llm: { base_url: "http://127.0.0.1:1/v1", api_key_path: llmPath, model: "test-model" },
    logging: { level: "error" },
  }, {
    ...overrides,
    ...(accountCookie === undefined ? {} : {
      hn: {
        ...(overrides.hn as Record<string, unknown> | undefined),
        username: "reader",
        session_cookie_path: join(directory, "hn-cookie"),
      },
    }),
  }));
  const startup = await loadStartupSecrets(config);
  const clock = createFixedClock(NOW);
  const secrets: LoadedSecrets = { ...startup, registry: createSecretRedactionRegistry(startup, clock) };
  const graph = await composeService({ config, secrets, clock, logger: noopLogger, adapters });
  let closed = false;
  return {
    graph,
    config,
    clock,
    directory,
    async close() {
      if (closed) return;
      closed = true;
      graph.operations.abort();
      await graph.closeLocal();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export interface HttpHarness extends TestGraph {
  transport: HttpTransport;
  worker: WorkerRunner;
  origin: string;
  close(): Promise<void>;
}

export async function httpHarness(
  overrides: Record<string, unknown> = {},
  seams: CompositionOptions["adapters"] & { accountCookie?: string } = {},
  staticRootOverride?: string,
): Promise<HttpHarness> {
  const local = await testGraph(overrides, seams);
  const staticRoot = staticRootOverride ?? join(local.directory, "static");
  if (staticRootOverride === undefined) {
    await mkdir(join(staticRoot, "assets"), { recursive: true });
    await writeFile(join(staticRoot, "index.html"), "<!doctype html><html><body><div id=\"root\"></div></body></html>");
    await writeFile(join(staticRoot, "assets", "present.js"), "export {};\n");
  }
  const worker = new WorkerRunner({
    jobs: local.graph.jobs,
    readerApp: local.graph.readerApp,
    sleep: local.graph.sleep,
    leaseMs: local.config.jobs.lease_ms,
    pollIntervalMs: local.config.jobs.poll_interval_ms,
    logger: noopLogger,
    health: local.graph.health,
    integrations: local.graph.integrations,
    now: local.clock.now,
    operationSignal: local.graph.operations.signal,
    store: local.graph.store,
  });
  local.graph.health.workersReady();
  try {
    const transport = await createHttpTransport(local.graph, worker, staticRoot);
    await transport.app.listen({ host: "127.0.0.1", port: 0 });
    const address = transport.app.server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");
    transport.origins.bound(address.port);
    const origin = `http://127.0.0.1:${address.port}`;
    return {
      ...local,
      transport,
      worker,
      origin,
      async close() {
        const closing = transport.app.close();
        await transport.debugConnections.closeAll();
        await closing;
        await local.close();
      },
    };
  } catch (error) {
    await local.close();
    throw error;
  }
}

export interface LoginResult {
  cookie: string;
  csrf: string;
  expiresAt: string;
  setCookie: string;
}

export async function login(origin: string, accessToken = ACCESS_TOKEN): Promise<LoginResult> {
  const response = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessToken }),
  });
  if (response.status !== 200) throw new Error(`Login failed with ${response.status}.`);
  const body = await response.json() as { csrfSecret: string; expiresAt: string };
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("Missing session cookie.");
  return { cookie: setCookie.split(";", 1)[0]!, csrf: body.csrfSecret, expiresAt: body.expiresAt, setCookie };
}

export function mutationHeaders(session: LoginResult, origin: string): Record<string, string> {
  return { cookie: session.cookie, "x-tmtp-csrf": session.csrf, origin };
}

export async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

export interface FakeProvider {
  server: Server;
  origin: string;
  journal: Array<{ method?: string; url?: string; authorization?: string }>;
  llmStatus: number;
  hnStatus: number;
  feedIds: number[];
  close(): Promise<void>;
}

export async function fakeProvider(): Promise<FakeProvider> {
  const journal: FakeProvider["journal"] = [];
  const provider: FakeProvider = {
    server: undefined as unknown as Server,
    origin: "",
    journal,
    llmStatus: 200,
    hnStatus: 200,
    feedIds: [100],
    async close() {
      if (provider.server.listening) await new Promise<void>((resolve, reject) => provider.server.close((error) => error ? reject(error) : resolve()));
    },
  };
  provider.server = createServer((request, response) => {
    journal.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    if (request.url === "/v0/maxitem.json") {
      response.writeHead(provider.hnStatus, { "content-type": "application/json" });
      response.end(provider.hnStatus === 200 ? "100" : "{}");
      return;
    }
    if (request.url?.startsWith("/v0/") && request.url.endsWith("stories.json")) {
      response.writeHead(provider.hnStatus, { "content-type": "application/json" });
      response.end(provider.hnStatus === 200 ? JSON.stringify(provider.feedIds) : "{}");
      return;
    }
    if (request.url === "/v0/item/100.json") {
      response.writeHead(provider.hnStatus, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: 100, type: "story", by: "reader", time: 1_767_000_000, title: "Locally collected story",
        url: "https://example.test/articles/100", score: 5, descendants: 0,
      }));
      return;
    }
    if (request.url === "/v1/chat/completions") {
      response.writeHead(provider.llmStatus, { "content-type": "application/json", "x-request-id": "local-request" });
      response.end(JSON.stringify(provider.llmStatus === 200 ? {
        id: "local-completion",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{\"ok\":true}", refusal: null } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      } : { error: { message: "safe local failure" } }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => provider.server.listen(0, "127.0.0.1", resolve));
  const address = provider.server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fake provider port.");
  provider.origin = `http://127.0.0.1:${address.port}`;
  return provider;
}
