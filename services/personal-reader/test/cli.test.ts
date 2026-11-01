import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createFixedClock } from "@tmtp/clock";
import { migrate, openDatabase } from "@tmtp/database";
import { createJobQueue, jobQueueMigrations } from "@tmtp/job-queue";
import { createReaderStore, readerStoreMigrations } from "@tmtp/reader-store";
import { readerAppJobCodecs } from "@tmtp/reader-app";
import { ACCESS_TOKEN, fakeProvider, LLM_KEY, login, mutationHeaders, NOW } from "./harness.js";
import type { FakeProvider } from "./harness.js";
import { queueFixture, storyFixture } from "./fixtures.js";

const CLI = resolve("dist/cli.js");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

interface Fixture {
  directory: string;
  configPath: string;
  raw: any;
  provider: FakeProvider;
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "personal-reader-cli-"));
  const provider = await fakeProvider();
  provider.feedIds = [];
  const accessPath = join(directory, "access-token");
  const llmPath = join(directory, "llm-key");
  await writeFile(accessPath, ACCESS_TOKEN);
  await writeFile(llmPath, LLM_KEY);
  const raw = {
    server: { host: "127.0.0.1", port: 0, shutdown_grace_ms: 500 },
    auth: { access_token_path: accessPath },
    database: { path: join(directory, "reader.sqlite") },
    logging: { level: "info" },
    jobs: { poll_interval_ms: 20, backoff_base_ms: 0, backoff_max_ms: 0 },
    http: { retry: { max_attempts: 1, base_delay_ms: 0, max_delay_ms: 0 } },
    hn: { api_base_url: `${provider.origin}/v0` },
    ingestion: { feeds: ["top"] },
    llm: { base_url: `${provider.origin}/v1`, api_key_path: llmPath, model: "test-model", max_retries: 0 },
  };
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(raw));
  cleanups.push(async () => {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, configPath, raw, provider };
}

interface CommandResult { code: number | null; stdout: string; stderr: string }

async function command(args: string[]): Promise<CommandResult> {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolveCode) => child.once("close", resolveCode));
  return { code, stdout, stderr };
}

interface RunningProcess {
  child: ChildProcess;
  origin: string;
  stdout(): string;
  stderr(): string;
  stop(): Promise<number | null>;
}

async function start(configPath: string): Promise<RunningProcess> {
  const child = spawn(process.execPath, [CLI, "start", "--config", configPath], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const origin = await new Promise<string>((resolveOrigin, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Service did not listen.\n${stdout}\n${stderr}`)), 10_000);
    child.stdout.on("data", () => {
      for (const line of stdout.split("\n")) {
        try {
          const record = JSON.parse(line) as { origin?: unknown };
          if (typeof record.origin === "string") {
            clearTimeout(timeout);
            resolveOrigin(record.origin);
            return;
          }
        } catch { /* wait for a structured listening record */ }
      }
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Service exited before listening (${code}).\n${stdout}\n${stderr}`));
    });
  });
  const running: RunningProcess = {
    child,
    origin,
    stdout: () => stdout,
    stderr: () => stderr,
    async stop() {
      const exited = new Promise<number | null>((resolveCode) => child.once("close", resolveCode));
      child.kill("SIGTERM");
      return exited;
    },
  };
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
    }
  });
  return running;
}

function database(raw: any) {
  return openDatabase({ path: raw.database.path, busyTimeoutMs: 5000, wal: true });
}

function enqueue(raw: any, kind: string, payload: unknown): void {
  const db = database(raw);
  try {
    migrate(db, [...readerStoreMigrations, ...jobQueueMigrations]);
    const queue = createJobQueue({
      database: db, clock: createFixedClock(NOW), codecs: readerAppJobCodecs,
      leaseMs: 1000, maxAttempts: 5, backoffBaseMs: 0, backoffMaxMs: 0, batchSize: 20,
    });
    queue.enqueue({ kind, payload, payloadSchemaVersion: 1, runAfter: NOW.toISOString() });
  } finally { db.close(); }
}

function seedReader(raw: any): void {
  const db = database(raw);
  try {
    migrate(db, [...readerStoreMigrations, ...jobQueueMigrations]);
    const store = createReaderStore(db);
    store.transaction(() => {
      store.stories.upsertBatch([storyFixture(1)]);
      store.queue.insertPendingIfMissing([queueFixture(1)]);
    });
  } finally { db.close(); }
}

describe("headless CLI", () => {
  it("should distinguish usage errors from safe configuration failures", async () => {
    expect((await command([])).code).toBe(2);
    const local = await fixture();
    const raw = JSON.parse(await readFile(local.configPath, "utf8")) as { auth: Record<string, unknown> };
    delete raw.auth.access_token_path;
    await writeFile(local.configPath, JSON.stringify(raw));
    const result = await command(["doctor", "--config", local.configPath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("personal-reader.startup.failed");
    expect(result.stderr).toContain("auth.access_token_path");
    expect(result.stderr).not.toContain(ACCESS_TOKEN);
    expect(result.stderr).not.toContain(LLM_KEY);
  });

  it("should run doctor probes without recovering or enqueueing jobs and report provider failure", async () => {
    const local = await fixture();
    const success = await command(["doctor", "--config", local.configPath]);
    expect(success.code).toBe(0);
    expect(success.stdout).toContain("Doctor checks completed.");
    expect(success.stdout).not.toContain("Personal reader listening.");
    const db = database(local.raw);
    try { expect(db.queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM jobs")?.count).toBe(0); } finally { db.close(); }

    local.provider.llmStatus = 500;
    local.provider.hnStatus = 503;
    const failed = await command(["doctor", "--config", local.configPath]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).not.toContain("safe local failure");
    expect(failed.stdout).not.toContain(ACCESS_TOKEN);
    expect(failed.stdout).not.toContain(LLM_KEY);
  });

  it("should map idle, completed, handler-failed and poison run-once outcomes to exact exits", async () => {
    const local = await fixture();
    expect((await command(["jobs", "run-once", "--config", local.configPath])).code).toBe(0);
    enqueue(local.raw, "personalization.recover", {});
    expect((await command(["jobs", "run-once", "--config", local.configPath])).code).toBe(0);
    enqueue(local.raw, "article.fetch-extract", { storyId: 999, storyContentVersion: "missing" });
    expect((await command(["jobs", "run-once", "--config", local.configPath])).code).toBe(3);
    const db = database(local.raw);
    try {
      db.execute(`INSERT INTO jobs (
        id, kind, payload, payload_schema_version, status, run_after, attempts, max_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, 1, 'queued', ?, 0, 5, ?, ?)`, [
        "poison-cli", "ingestion.collect", JSON.stringify({ bad: true }), NOW.toISOString(), NOW.toISOString(), NOW.toISOString(),
      ]);
    } finally { db.close(); }
    const poison = await command(["jobs", "run-once", "--config", local.configPath]);
    expect(poison.code).toBe(5);
    expect(poison.stdout).toContain('"outcome":"rejected"');
  });
});

describe("WF-07 real process restart", () => {
  it("should preserve queue, activity, preferences and migrations across a clean restart", async () => {
    const local = await fixture();
    seedReader(local.raw);
    const first = await start(local.configPath);
    const session = await login(first.origin);
    const activity = {
      batch: [{ clientEventId: "r".repeat(43), storyId: 1, kind: "open", occurredAt: NOW.toISOString(), source: "embedded-reader" }],
    };
    expect((await fetch(`${first.origin}/api/v1/activity/batches`, {
      method: "POST", headers: { ...mutationHeaders(session, first.origin), "content-type": "application/json" }, body: JSON.stringify(activity),
    })).status).toBe(200);
    const rule = {
      id: "restart-rule", kind: "topic", effect: "include", value: "SQLite", normalizedValue: "sqlite",
      enabled: true, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    };
    expect((await fetch(`${first.origin}/api/v1/preferences`, {
      method: "PUT", headers: { ...mutationHeaders(session, first.origin), "content-type": "application/json" }, body: JSON.stringify({ rules: [rule] }),
    })).status).toBe(200);
    expect(await first.stop()).toBe(0);

    const second = await start(local.configPath);
    const returning = await login(second.origin);
    const queue = await (await fetch(`${second.origin}/api/v1/queue`, { headers: { cookie: returning.cookie } })).json() as { items: unknown[] };
    expect(queue.items).toHaveLength(1);
    const history = await (await fetch(`${second.origin}/api/v1/activity?clientEventId=${"r".repeat(43)}`, { headers: { cookie: returning.cookie } })).json() as { events: unknown[] };
    expect(history.events).toHaveLength(1);
    const preferences = await (await fetch(`${second.origin}/api/v1/preferences`, { headers: { cookie: returning.cookie } })).json() as unknown[];
    expect(preferences).toEqual([rule]);
    const ready = await fetch(`${second.origin}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await second.stop()).toBe(0);
  });
});
