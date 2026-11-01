import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixedClock } from "@tmtp/clock";
import { loadConfig } from "../src/config.js";
import {
  createSecretRedactionRegistry,
  loadStartupSecrets,
  readSecretFile,
  SecretFileError,
} from "../src/secrets.js";
import type { SecretConfigKey } from "../src/secrets.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "personal-reader-secrets-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function secretFile(name: string, contents: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, contents, "utf8");
  return path;
}

async function captureFailure(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectSafeSecretError(caught: unknown, key: SecretConfigKey): void {
  expect(caught).toBeInstanceOf(SecretFileError);
  const error = caught as SecretFileError;
  expect(error.name).toBe("SecretFileError");
  expect(error.key).toBe(key);
  expect(error.message).toBe("Secret file could not be loaded.");
  expect(error.cause).toBeUndefined();
}

describe("secret files", () => {
  it.each([
    ["value", "value"],
    ["value\n", "value"],
    ["value\r\n", "value"],
    ["value\n\n", "value\n"],
    ["value\r\n\r\n", "value\r\n"],
    ["value\r", "value\r"],
    [" value \n", " value "],
    ["\n", ""],
    ["\r\n", ""],
    ["", ""],
  ])("should remove at most one terminal newline from %j", async (contents, expected) => {
    const path = await secretFile("token", contents);
    await expect(readSecretFile(path, "auth.access_token_path")).resolves.toBe(expected);
  });

  it("should preserve Unicode and all non-terminal whitespace", async () => {
    const path = await secretFile("unicode", "  κλειδί\t\r\n");
    await expect(readSecretFile(path, "llm.api_key_path")).resolves.toBe("  κλειδί\t");
  });

  it("should report only the configuration key and fixed safe message on file failure", async () => {
    const path = join(directory, "missing-secret-sentinel-91c4");
    const caught = await captureFailure(readSecretFile(path, "auth.access_token_path"));
    expectSafeSecretError(caught, "auth.access_token_path");
    expect(JSON.stringify(caught)).not.toContain("missing-secret-sentinel-91c4");
    expect((caught as Error).message).not.toContain(directory);
  });

  it("should load required startup secrets and the optional paired HN cookie", async () => {
    const accessToken = await secretFile("access", " access-token \n");
    const apiKey = await secretFile("api-key", "llm-key\r\n");
    const hnCookie = await secretFile("hn-cookie", "hn-cookie\n\n");
    const config = loadConfig({
      auth: { access_token_path: accessToken },
      database: { path: join(directory, "reader.sqlite") },
      llm: { base_url: "https://llm.example.test/v1", api_key_path: apiKey, model: "reader" },
      hn: { username: "reader", session_cookie_path: hnCookie },
    });

    await expect(loadStartupSecrets(config)).resolves.toEqual({
      accessToken: " access-token ",
      llmApiKey: "llm-key",
      hnSessionCookie: "hn-cookie\n",
    });
  });

  it("should not read an HN cookie when the account is unconfigured", async () => {
    const accessToken = await secretFile("access", "access-token");
    const apiKey = await secretFile("api-key", "llm-key");
    const config = loadConfig({
      auth: { access_token_path: accessToken },
      database: { path: join(directory, "reader.sqlite") },
      llm: { base_url: "https://llm.example.test/v1", api_key_path: apiKey, model: "reader" },
    });
    await expect(loadStartupSecrets(config)).resolves.toEqual({
      accessToken: "access-token",
      llmApiKey: "llm-key",
    });
  });

  it("should identify the failing startup secret key without a driver cause", async () => {
    const accessToken = await secretFile("access", "access-token");
    const config = loadConfig({
      auth: { access_token_path: accessToken },
      database: { path: join(directory, "reader.sqlite") },
      llm: {
        base_url: "https://llm.example.test/v1",
        api_key_path: join(directory, "missing-driver-secret-sentinel"),
        model: "reader",
      },
    });
    expectSafeSecretError(await captureFailure(loadStartupSecrets(config)), "llm.api_key_path");
  });
});

describe("secret redaction registry", () => {
  it("should begin with startup values and return an independent snapshot", () => {
    const registry = createSecretRedactionRegistry({
      accessToken: " access ",
      llmApiKey: "llm-key",
      hnSessionCookie: " hn-cookie ",
    });
    const first = registry.secretValuesProvider();
    expect(first).toEqual([" access ", "llm-key", " hn-cookie "]);
    first.splice(0, first.length, "changed");
    expect(registry.secretValuesProvider()).toEqual([" access ", "llm-key", " hn-cookie "]);
  });

  it("should omit an absent HN cookie", () => {
    const registry = createSecretRedactionRegistry({ accessToken: "access", llmApiKey: "llm-key" });
    expect(registry.secretValuesProvider()).toEqual(["access", "llm-key"]);
  });

  it("should register both session values and unregister only the requested session", () => {
    const clock = createFixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const registry = createSecretRedactionRegistry({ accessToken: "access", llmApiKey: "llm-key" }, clock);
    registry.registerSession({
      opaqueSession: "session-one",
      csrfSecret: "csrf-one",
      expiresAt: "2026-01-01T00:10:00.000Z",
    });
    registry.registerSession({
      opaqueSession: "session-two",
      csrfSecret: "csrf-two",
      expiresAt: "2026-01-01T00:20:00.000Z",
    });
    expect(registry.secretValuesProvider()).toEqual([
      "access",
      "llm-key",
      "session-one",
      "csrf-one",
      "session-two",
      "csrf-two",
    ]);

    registry.unregisterSession("session-one");
    expect(registry.secretValuesProvider()).toEqual(["access", "llm-key", "session-two", "csrf-two"]);
    registry.unregisterSession("not-registered");
    expect(registry.secretValuesProvider()).toEqual(["access", "llm-key", "session-two", "csrf-two"]);
  });

  it("should prune both session values at expiry on the next snapshot", () => {
    const clock = createFixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const registry = createSecretRedactionRegistry({ accessToken: "access", llmApiKey: "llm-key" }, clock);
    registry.registerSession({
      opaqueSession: "session",
      csrfSecret: "csrf",
      expiresAt: "2026-01-01T00:00:01.000Z",
    });
    clock.advance(999);
    expect(registry.secretValuesProvider()).toEqual(["access", "llm-key", "session", "csrf"]);
    clock.advance(1);
    expect(registry.secretValuesProvider()).toEqual(["access", "llm-key"]);
  });

  it("should replace a repeated opaque-session registration without retaining its old CSRF value", () => {
    const registry = createSecretRedactionRegistry({ accessToken: "access", llmApiKey: "llm-key" });
    registry.registerSession({
      opaqueSession: "session",
      csrfSecret: "old-csrf",
      expiresAt: "2026-01-01T00:10:00.000Z",
    });
    registry.registerSession({
      opaqueSession: "session",
      csrfSecret: "new-csrf",
      expiresAt: "2027-01-01T00:10:00.000Z",
    });
    expect(registry.secretValuesProvider()).toEqual(["access", "llm-key", "session", "new-csrf"]);
  });

  it("should reject an invalid expiry without echoing session values", () => {
    const registry = createSecretRedactionRegistry({ accessToken: "access", llmApiKey: "llm-key" });
    expect(() => registry.registerSession({
      opaqueSession: "session-secret-sentinel",
      csrfSecret: "csrf-secret-sentinel",
      expiresAt: "invalid",
    })).toThrow("Invalid session secret registration.");
    expect(registry.secretValuesProvider()).toEqual(["access", "llm-key"]);
  });
});
