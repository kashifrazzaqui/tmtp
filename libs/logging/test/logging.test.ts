import { describe, expect, it, vi } from "vitest";
import { createInternalLogger } from "../src/internal.js";
import { createLogger, noopLogger } from "../src/index.js";
import * as publicModule from "../src/index.js";
import type { CreateLoggerOptions, LogLevel } from "../src/index.js";

function capture(options: CreateLoggerOptions) {
  const lines: string[] = [];
  const logger = createInternalLogger(options, { write: (line) => lines.push(line) });
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lines, logger, records };
}

const options = (level: LogLevel = "trace", extra: Partial<CreateLoggerOptions> = {}): CreateLoggerOptions => ({
  level,
  service: " reader ",
  secretValues: [],
  ...extra,
});

describe("log records and levels", () => {
  it("should apply the complete numeric level matrix", () => {
    const expected: Record<LogLevel, number[]> = {
      error: [50],
      warn: [40, 50],
      info: [30, 40, 50],
      debug: [20, 30, 40, 50],
      trace: [10, 20, 30, 40, 50],
    };
    for (const level of Object.keys(expected) as LogLevel[]) {
      const { logger, records } = capture(options(level));
      logger.trace("trace"); logger.debug("debug"); logger.info("info"); logger.warn("warn"); logger.error("error");
      expect(records().map((record) => record.level)).toEqual(expected[level]);
      for (const record of records()) {
        expect(record.service).toBe("reader");
        expect(Number.isInteger(record.time)).toBe(true);
        expect(record).not.toHaveProperty("pid");
        expect(record).not.toHaveProperty("hostname");
      }
    }
  });

  it("should suppress provider and field work below the configured level", () => {
    const provider = vi.fn(() => []);
    const { logger, lines } = capture(options("error", { secretValues: undefined, secretValuesProvider: provider }));
    const fields = {};
    Object.defineProperty(fields, "danger", { enumerable: true, get: () => { throw new Error("must not run"); } });
    expect(() => logger.debug("suppressed", fields)).not.toThrow();
    expect(lines).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
  });

  it("should omit reserved keys retain literal percent signs and apply context precedence", () => {
    const { logger, records } = capture(options());
    const child = logger.child({ runId: "run", shared: "child", service: "forged" });
    child.info("100% literal", {
      shared: "call",
      level: 1,
      time: 2,
      msg: "forged",
      serializers: {},
      formatters: {},
      customLevels: {},
      requestId: "request",
    });
    const [record] = records();
    expect(record.msg).toBe("100% literal");
    expect(record.runId).toBe("run");
    expect(record.shared).toBe("call");
    expect(record.service).toBe("reader");
    expect(record.level).toBe(30);
    expect(record.requestId).toBe("request");
    expect(record).not.toHaveProperty("serializers");
    expect(record).not.toHaveProperty("formatters");
    expect(record).not.toHaveProperty("customLevels");
  });
});

describe("redaction", () => {
  it("should redact sensitive keys at arbitrary nesting while retaining paths and correlation IDs", () => {
    const { logger, records } = capture(options());
    logger.info("safe", {
      Authorization: { bearer: true },
      nested: [{ "proxy-authorization": "secret", "X_API_KEY": "secret", sessionCookie: "secret" }],
      "set-cookie": "secret",
      csrfToken: "secret",
      password: "secret",
      secret_file_contents: "secret",
      auth_access_token_path: "/safe/path",
      llm_api_key_path: "/safe/key",
      hn_session_cookie_path: "/safe/cookie",
      requestId: "request",
    });
    const [record] = records();
    expect(record.Authorization).toBe("[Redacted]");
    expect(record.nested).toEqual([{ "proxy-authorization": "[Redacted]", X_API_KEY: "[Redacted]", sessionCookie: "[Redacted]" }]);
    expect(record["set-cookie"]).toBe("[Redacted]");
    expect(record.csrfToken).toBe("[Redacted]");
    expect(record.password).toBe("[Redacted]");
    expect(record.secret_file_contents).toBe("[Redacted]");
    expect(record.auth_access_token_path).toBe("/safe/path");
    expect(record.llm_api_key_path).toBe("/safe/key");
    expect(record.hn_session_cookie_path).toBe("/safe/cookie");
    expect(record.requestId).toBe("request");
  });

  it("should redact registered values everywhere with longest-match single-pass behavior", () => {
    const short = "abc\"\\\n";
    const long = `${short}-long`;
    const { logger, lines, records } = capture(options("trace", {
      service: `service-${long}`,
      secretValues: [short, long, "", "s3cr3t"],
    }));
    logger.child({ [`key-${long}`]: `${short}/${long}` }).error(`message-${long}-s3cr3t`, {
      err: Object.assign(new Error(`error-${short}`), {
        code: `code-${long}`,
        cause: new Error(`cause-s3cr3t`),
        ignoredSecretField: "s3cr3t",
      }),
    });
    expect(lines.join("")).not.toContain(short);
    expect(lines.join("")).not.toContain("s3cr3t");
    const [record] = records();
    expect(record.service).toBe("service-[Redacted]");
    expect(record.msg).toBe("message-[Redacted]-[Redacted]");
    expect(record["key-[Redacted]"]).toBe("[Redacted]/[Redacted]");
    expect(record.err).toMatchObject({
      name: "Error",
      message: "error-[Redacted]",
      code: "code-[Redacted]",
      cause: { message: "cause-[Redacted]" },
    });
    expect(record.err).not.toHaveProperty("ignoredSecretField");
  });

  it("should snapshot static secret options and resolve sanitized-key collisions deterministically", () => {
    const secrets = ["old-secret"];
    const { logger, records } = capture(options("trace", { secretValues: secrets }));
    secrets[0] = "changed";
    logger.info("first", { "key-old-secret": "first", "key-[Redacted]": "second" });
    expect(records()[0]).toMatchObject({ msg: "first", "key-[Redacted]": "second" });
    logger.info("old-secret changed");
    expect(records()[1]?.msg).toBe("[Redacted] changed");
  });

  it("should use one current provider snapshot per enabled record without provider work at child creation", () => {
    let secrets = ["initial"];
    const provider = vi.fn(() => secrets);
    const { logger, records } = capture(options("info", { secretValues: undefined, secretValuesProvider: provider }));
    const child = logger.child({ value: "initial later" });
    expect(provider).not.toHaveBeenCalled();
    child.info("initial");
    expect(provider).toHaveBeenCalledTimes(1);
    secrets = ["later"];
    child.info("initial later");
    expect(provider).toHaveBeenCalledTimes(2);
    expect(records()[0]).toMatchObject({ msg: "[Redacted]", value: "[Redacted] later" });
    expect(records()[1]).toMatchObject({ msg: "initial [Redacted]", value: "initial [Redacted]" });
    logger.debug("ignored");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it.each([
    () => { throw new Error("unsafe provider detail"); },
    () => null,
    () => [4],
    () => new (class SecretArray extends Array<string> {})("secret"),
  ])("should fail closed with one fixed fallback for an invalid provider", (provider) => {
    const { logger, lines, records } = capture(options("trace", {
      secretValues: undefined,
      secretValuesProvider: provider as () => readonly string[],
    }));
    expect(() => logger.error("original-secret", { binding: "unsafe" })).toThrow("Redaction provider failed.");
    expect(lines).toHaveLength(1);
    expect(records()[0]).toEqual({
      level: 50,
      time: expect.any(Number),
      msg: "Redaction provider failed.",
    });
    expect(lines[0]).not.toContain("original-secret");
    expect(lines[0]).not.toContain("unsafe");
  });

  it("should propagate fallback destination failures", () => {
    const failure = new Error("write failed");
    const logger = createInternalLogger(options("trace", {
      secretValues: undefined,
      secretValuesProvider: () => { throw new Error("provider"); },
    }), { write: () => { throw failure; } });
    expect(() => logger.info("message")).toThrow(failure);
  });
});

describe("safe serialization", () => {
  it("should copy supported values and omit unsafe error properties without invoking application code", () => {
    const { logger, records } = capture(options());
    const repeated = { value: 1n, invalid: Number.NaN };
    const circular: Record<string, unknown> = { name: "cycle" };
    circular.self = circular;
    class Unsupported { secret = "hidden"; }
    const toJSON = vi.fn(() => ({ leaked: true }));
    const object: Record<string, unknown> = {
      date: new Date("2026-01-01T00:00:00.000Z"),
      invalidDate: new Date(Number.NaN),
      infinity: Number.POSITIVE_INFINITY,
      bigint: 42n,
      missing: undefined,
      fn: () => "hidden",
      symbol: Symbol("hidden"),
      array: [undefined, 1n, Number.NaN],
      repeatedA: repeated,
      repeatedB: repeated,
      circular,
      unsupported: new Unsupported(),
      toJSON,
    };
    Object.defineProperty(object, "accessor", { enumerable: true, get: () => { throw new Error("must not run"); } });
    const error = new Error("failure") as Error & { code: string; custom: string };
    error.code = "safe-code";
    error.custom = "must-not-escape";
    error.cause = new Error("cause");
    object.err = error;
    logger.info("serialize", object);
    const [record] = records();
    expect(record.err).toMatchObject({ name: "Error", message: "failure", code: "safe-code", cause: { message: "cause" } });
    expect(record.err).not.toHaveProperty("custom");
    expect(record.date).toBe("2026-01-01T00:00:00.000Z");
    expect(record.invalidDate).toBeNull();
    expect(record.infinity).toBeNull();
    expect(record.bigint).toBe("42");
    expect(record).not.toHaveProperty("missing");
    expect(record).not.toHaveProperty("fn");
    expect(record).not.toHaveProperty("symbol");
    expect(record.array).toEqual([null, "1", null]);
    expect(record.repeatedA).toEqual({ value: "1", invalid: null });
    expect(record.repeatedB).toEqual({ value: "1", invalid: null });
    expect(record.circular).toEqual({ name: "cycle", self: "[Circular]" });
    expect(record.unsupported).toBe("[Unserializable]");
    expect(record.accessor).toBe("[Unserializable]");
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("should use safe fallbacks for accessor-valued error fields", () => {
    const error = new Error("original");
    Object.defineProperty(error, "message", { get: () => { throw new Error("must not run"); } });
    Object.defineProperty(error, "cause", { get: () => { throw new Error("must not run"); } });
    const { logger, records } = capture(options());
    logger.error("safe", { err: error });
    expect(records()[0]?.err).toMatchObject({ name: "Error", message: "" });
    expect(records()[0]?.err).not.toHaveProperty("cause");
  });

  it("should propagate ordinary destination failures", () => {
    const failure = new Error("EPIPE");
    const logger = createInternalLogger(options(), { write: () => { throw failure; } });
    expect(() => logger.info("message")).toThrow(failure);
  });
});

describe("construction and noop", () => {
  it("should validate fixed construction options without echoing secrets", () => {
    expect(() => createLogger({ level: "fatal" as LogLevel, service: "reader", secretValues: [] })).toThrow("Invalid log level.");
    expect(() => createLogger({ level: "info", service: " ", secretValues: [] })).toThrow("Invalid service name.");
    expect(() => createLogger({ level: "info", service: "reader" })).toThrow("Invalid secret values.");
    expect(() => createLogger({ level: "info", service: "reader", secretValues: [], secretValuesProvider: () => [] })).toThrow("Invalid secret values.");
    expect(() => createLogger({ level: "info", service: "reader", secretValues: ["secret", 4] as unknown as string[] })).toThrow("Invalid secret values.");
  });

  it("should expose only the public runtime surface and a silent singleton noop", () => {
    expect(Object.keys(publicModule).sort()).toEqual(["createLogger", "noopLogger"]);
    expect(() => noopLogger.trace("silent", { secret: true })).not.toThrow();
    expect(noopLogger.child({ any: "value" })).toBe(noopLogger);
  });
});
