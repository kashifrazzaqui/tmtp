#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { ConfigValidationError } from "@tmtp/config";
import { systemClock } from "@tmtp/clock";
import { createLogger } from "@tmtp/logging";
import type { Logger } from "@tmtp/logging";
import { composeService } from "./composition.js";
import type { LoadedSecrets, ServiceGraph } from "./composition.js";
import { loadConfig } from "./config.js";
import type { ResolvedConfig } from "./config.js";
import { ServiceError } from "./errors.js";
import { runCapabilityProbes } from "./probes.js";
import { createSecretRedactionRegistry, loadStartupSecrets, SecretFileError } from "./secrets.js";
import { startService } from "./service.js";
import { recoverExpiredLeases } from "./storage.js";
import { WorkerRunner } from "./worker.js";

interface CliOptions {
  configPath?: string;
  assignments: string[];
}

class CliUsageError extends Error {}

const FORBIDDEN_ASSIGNMENT_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function commandArguments(argv: readonly string[]): { mode: "start" | "doctor" | "run-once"; rest: string[] } {
  if (argv[0] === "start") return { mode: "start", rest: argv.slice(1) };
  if (argv[0] === "doctor") return { mode: "doctor", rest: argv.slice(1) };
  if (argv[0] === "jobs" && argv[1] === "run-once") return { mode: "run-once", rest: argv.slice(2) };
  throw new CliUsageError();
}

function optionsOf(args: readonly string[]): CliOptions {
  const result: CliOptions = { assignments: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--config" && value !== undefined) {
      if (result.configPath !== undefined) throw new CliUsageError();
      result.configPath = value;
      index += 1;
    } else if (argument === "--set" && value !== undefined) {
      result.assignments.push(value);
      index += 1;
    } else {
      throw new CliUsageError();
    }
  }
  return result;
}

function assign(target: Record<string, unknown>, assignment: string): void {
  const separator = assignment.indexOf("=");
  if (separator < 1) throw new CliUsageError();
  const path = assignment.slice(0, separator).split(".");
  if (path.some((key) => FORBIDDEN_ASSIGNMENT_SEGMENTS.has(key) || !/^(?:[A-Za-z_][A-Za-z0-9_]*|\d+)$/.test(key))) {
    throw new CliUsageError();
  }
  const text = assignment.slice(separator + 1);
  let value: unknown;
  try { value = JSON.parse(text); } catch { value = text; }
  let current = target;
  for (const key of path.slice(0, -1)) {
    const existing = Object.hasOwn(current, key) ? current[key] : undefined;
    if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) {
      throw new CliUsageError();
    }
    const child = existing ?? {};
    current[key] = child;
    current = child as Record<string, unknown>;
  }
  current[path.at(-1)!] = value;
}

async function rawConfiguration(options: CliOptions): Promise<unknown> {
  let root: unknown = {};
  if (options.configPath !== undefined) {
    try {
      root = JSON.parse(await readFile(options.configPath, "utf8"));
    } catch {
      throw new ConfigValidationError([{ key: "config", code: "invalid", message: "Configuration value is invalid." }]);
    }
  }
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw new ConfigValidationError([{ key: "$", code: "invalid", message: "Configuration value is invalid." }]);
  }
  const merged = { ...(root as Record<string, unknown>) };
  for (const assignment of options.assignments) assign(merged, assignment);
  return merged;
}

function fallback(error: unknown, usage = false): void {
  const issues = error instanceof ConfigValidationError
    ? error.issues.map((issue) => ({ key: issue.key, code: issue.code }))
    : error instanceof SecretFileError ? [{ key: error.key, code: "invalid" }] : [];
  const record = {
    level: "error",
    time: systemClock.now().toISOString(),
    service: "personal-reader",
    message: "personal-reader.startup.failed",
    check: usage ? "usage" : "startup",
    ...(issues.length > 0 ? { issues } : {}),
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

async function loadLocal(options: CliOptions): Promise<{ config: ResolvedConfig; secrets: LoadedSecrets; logger: Logger }> {
  const config = loadConfig(await rawConfiguration(options));
  const startup = await loadStartupSecrets(config);
  const registry = createSecretRedactionRegistry(startup);
  const secrets: LoadedSecrets = { ...startup, registry };
  const logger = createLogger({
    level: config.logging.level,
    service: "personal-reader",
    secretValuesProvider: registry.secretValuesProvider,
  });
  return { config, secrets, logger };
}

function safeCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(error.code) && error.code.length <= 64 ? error.code : "startup-failed";
}

async function doctor(options: CliOptions): Promise<number> {
  const local = await loadLocal(options);
  let graph: ServiceGraph | undefined;
  let failed = false;
  try {
    graph = await composeService(local);
    const results = await runCapabilityProbes(graph, graph.operations.signal);
    failed = !results.llm || !results.hnPublic || results.hnAccount === false;
    graph.logger.info("Doctor checks completed.", {
      check: "doctor",
      llm: results.llm ? "ok" : "failed",
      hnPublic: results.hnPublic ? "ok" : "failed",
      hnAccount: results.hnAccount === undefined ? "not-configured" : results.hnAccount ? "ok" : "failed",
      article: results.article,
    });
  } catch (error) {
    failed = true;
    local.logger.error("Doctor checks failed.", { check: "doctor", code: safeCode(error) });
  } finally {
    try { await graph?.closeLocal(); } catch { failed = true; }
  }
  return failed ? 1 : 0;
}

async function runOnce(options: CliOptions): Promise<number> {
  const local = await loadLocal(options);
  let graph: ServiceGraph | undefined;
  let resultCode = 1;
  try {
    graph = await composeService(local);
    recoverExpiredLeases(graph.jobs, graph.config.jobs.batch_size);
    const worker = new WorkerRunner({
      jobs: graph.jobs,
      readerApp: graph.readerApp,
      sleep: graph.sleep,
      leaseMs: graph.config.jobs.lease_ms,
      pollIntervalMs: graph.config.jobs.poll_interval_ms,
      logger: graph.logger.child({ component: "worker" }),
      health: graph.health,
      integrations: graph.integrations,
      now: graph.clock.now,
      operationSignal: graph.operations.signal,
      store: graph.store,
    });
    const result = await worker.runNext();
    resultCode = result.outcome === "idle" || result.outcome === "completed" ? 0
      : result.outcome === "failed" ? 3 : result.outcome === "lease-lost" ? 4 : 5;
    graph.logger.info("Durable job run finished.", {
      check: "run-once",
      outcome: result.outcome,
      ...("job" in result ? { jobId: result.job.id, kind: result.job.kind, status: result.job.status } : {}),
      ...(result.outcome === "lease-lost" ? { jobId: result.jobId, kind: result.kind } : {}),
    });
  } catch (error) {
    local.logger.error("Durable job run failed.", { check: "run-once", code: safeCode(error) });
  } finally {
    graph?.operations.abort();
    try { await graph?.closeLocal(); } catch { resultCode = 1; }
  }
  return resultCode;
}

async function start(options: CliOptions): Promise<number> {
  const local = await loadLocal(options);
  let running;
  try {
    running = await startService({ ...local, installSignalHandlers: false });
  } catch (error) {
    local.logger.error("Personal reader startup failed.", { check: "startup", code: safeCode(error) });
    return 1;
  }
  running.graph.logger.info("Personal reader listening.", { check: "listening", origin: running.origin });
  const shutdown = (): void => { void running.close().catch(() => undefined); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const clean = await running.closed;
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
  return clean ? 0 : 1;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  let mode: ReturnType<typeof commandArguments>;
  try { mode = commandArguments(argv); } catch {
    fallback(new CliUsageError(), true);
    return 2;
  }
  let options: CliOptions;
  try { options = optionsOf(mode.rest); } catch {
    fallback(new CliUsageError(), true);
    return 2;
  }
  try {
    if (mode.mode === "doctor") return await doctor(options);
    if (mode.mode === "run-once") return await runOnce(options);
    return await start(options);
  } catch (error) {
    if (error instanceof ServiceError || error instanceof ConfigValidationError || error instanceof SecretFileError) {
      fallback(error);
    } else {
      fallback(new Error("Startup failed."));
    }
    return 1;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
