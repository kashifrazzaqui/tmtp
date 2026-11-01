import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { validateConfig } from "../src/config.js";

const REQUIRED = {
  auth: { access_token_path: "/secrets/access-token" },
  database: { path: "/data/reader.sqlite" },
  llm: {
    base_url: "https://llm.example.test/v1",
    api_key_path: "/secrets/llm-key",
    model: "reader-model",
  },
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()!();
});

function candidate(section: "ingestion" | "personalization", cron: string): Record<string, unknown> {
  return { ...structuredClone(REQUIRED), [section]: { cron } };
}

describe("personal-reader cron review regressions", () => {
  it.each([
    ["ingestion", "5/5 * * * *"],
    ["ingestion", "30/30 * * * *"],
    ["personalization", "5/5 * * * *"],
    ["personalization", "30/30 * * * *"],
  ] as const)("should reject non-scheduler stepped value at %s.cron for %s", (section, cron) => {
    expect(validateConfig(candidate(section, cron))).toEqual({
      issues: [{ key: `${section}.cron`, code: "invalid", message: "Configuration value is invalid." }],
    });
  });

  it.each([
    ["ingestion", "*/5 * * * *"],
    ["ingestion", "1-30/5 * * * *"],
    ["ingestion", "?/5 * * * *"],
    ["personalization", "*/5 * * * *"],
    ["personalization", "1-30/5 * * * *"],
  ] as const)("should accept scheduler stepped form at %s.cron for %s", (section, cron) => {
    expect(validateConfig(candidate(section, cron)).issues).toEqual([]);
  });

  it("should reject invalid cron before opening startup resources", async () => {
    const directory = await mkdtemp(join(tmpdir(), "personal-reader-cron-review-"));
    cleanups.push(async () => { await rm(directory, { recursive: true, force: true }); });
    const accessTokenPath = join(directory, "access-token");
    const llmKeyPath = join(directory, "llm-key");
    const databasePath = join(directory, "reader.sqlite");
    const configPath = join(directory, "config.json");
    await writeFile(accessTokenPath, "test-access-token-32-characters-0001");
    await writeFile(llmKeyPath, "test-llm-key-sentinel-0001");
    await writeFile(configPath, JSON.stringify({
      auth: { access_token_path: accessTokenPath },
      database: { path: databasePath },
      http: { timeout_ms: 100, retry: { max_attempts: 1, base_delay_ms: 0, max_delay_ms: 0 } },
      llm: {
        base_url: "http://127.0.0.1:1/v1",
        api_key_path: llmKeyPath,
        model: "reader-model",
        timeout_ms: 100,
        max_retries: 0,
      },
    }));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runCli([
      "doctor",
      "--config", configPath,
      "--set", "ingestion.cron=5/5 * * * *",
    ])).resolves.toBe(1);

    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("ingestion.cron");
    await expect(access(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
