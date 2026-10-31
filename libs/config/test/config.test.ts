import { describe, expect, it, vi } from "vitest";
import {
  assertValidConfig,
  ConfigValidationError,
  parseConfig,
  z,
} from "../src/index.js";

describe("parseConfig", () => {
  it("should apply defaults and transforms without mutating the loaded value", () => {
    const schema = z.strictObject({
      http: z.strictObject({
        retry: z.strictObject({ max_attempts: z.number().int().default(3) }),
      }),
      name: z.string().transform((value) => value.toUpperCase()),
    });
    const loaded = { http: { retry: {} }, name: "reader" };
    const result = parseConfig(schema, loaded);
    expect(result).toEqual({
      value: { http: { retry: { max_attempts: 3 } }, name: "READER" },
      issues: [],
    });
    expect(loaded).toEqual({ http: { retry: {} }, name: "reader" });
    expect(Object.hasOwn(result, "value")).toBe(true);
  });

  it("should preserve a legitimate undefined schema output", () => {
    const result = parseConfig(z.undefined(), undefined);
    expect(result.issues).toEqual([]);
    expect(Object.hasOwn(result, "value")).toBe(true);
    expect(assertValidConfig(result)).toBeUndefined();
  });

  it("should map required invalid and inconsistent issues with stable nested paths", () => {
    const schema = z.strictObject({
      http: z.strictObject({
        retry: z.strictObject({ max_attempts: z.number().int().min(1) }),
      }),
      ingestion: z.strictObject({ feeds: z.array(z.string()) }),
      hn: z.strictObject({ username: z.string().nullable(), cookie: z.string().nullable() }),
    }).superRefine((value, context) => {
      if ((value.hn.username === null) !== (value.hn.cookie === null)) {
        context.addIssue({ code: "custom", path: ["hn", "cookie"], message: "unsafe custom text" });
      }
    });
    const result = parseConfig(schema, {
      http: { retry: { max_attempts: 0 } },
      ingestion: { feeds: ["top", 4] },
      hn: { username: "reader", cookie: null },
    });
    expect(result.value).toBeUndefined();
    expect(Object.hasOwn(result, "value")).toBe(false);
    expect(result.issues).toEqual([
      { key: "http.retry.max_attempts", code: "invalid", message: "Configuration value is invalid." },
      { key: "ingestion.feeds[1]", code: "invalid", message: "Configuration value is invalid." },
    ]);

    const inconsistent = parseConfig(schema, {
      http: { retry: { max_attempts: 3 } },
      ingestion: { feeds: ["top"] },
      hn: { username: "reader", cookie: null },
    });
    expect(inconsistent.issues).toEqual([
      { key: "hn.cookie", code: "inconsistent", message: "Configuration values are inconsistent." },
    ]);

    const missing = parseConfig(z.strictObject({ token: z.string() }), {});
    expect(missing.issues).toEqual([{
      key: "token",
      code: "required",
      message: "Required configuration value is missing.",
    }]);
    const root = parseConfig(z.string(), 3);
    expect(root.issues[0]?.key).toBe("$");
  });

  it("should not echo values unknown keys custom messages or raw Zod errors", () => {
    const secret = "secret-sentinel-7f6b";
    const schema = z.strictObject({ password: z.string().min(20, secret) });
    const result = parseConfig(schema, { password: secret, [secret]: true });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(result.issues[0]?.key).toBe("$");
    const error = (() => {
      try {
        assertValidConfig(result);
        throw new Error("unreachable");
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect((error as Error).message).not.toContain(secret);
    expect((error as ConfigValidationError).cause).toBeUndefined();
  });

  it("should call safeParse exactly once and preserve issue order", () => {
    const schema = z.strictObject({ first: z.string(), second: z.number() });
    const spy = vi.spyOn(schema, "safeParse");
    const result = parseConfig(schema, { first: 1, second: "two" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.issues.map((issue) => issue.key)).toEqual(["first", "second"]);
  });

  it("should propagate application and asynchronous schema exceptions", () => {
    const thrown = new Error("programmer failure");
    const throwing = z.string().transform(() => { throw thrown; });
    expect(() => parseConfig(throwing, "value")).toThrow(thrown);

    const asynchronous = z.string().refine(async () => true);
    expect(() => parseConfig(asynchronous, "value")).toThrow();
  });

  it("should keep independent parses free of stale state", () => {
    const schema = z.strictObject({ count: z.number().default(1) });
    expect(parseConfig(schema, { count: "bad" }).issues).toHaveLength(1);
    expect(parseConfig(schema, {})).toEqual({ value: { count: 1 }, issues: [] });
    expect(parseConfig(schema, { count: 2 })).toEqual({ value: { count: 2 }, issues: [] });
  });
});

describe("assertValidConfig and ConfigValidationError", () => {
  it("should reject malformed success results", () => {
    expect(() => assertValidConfig({ issues: [] })).toThrow(
      "Malformed ConfigResult: success must contain a value property.",
    );
  });

  it("should prefer issues over a malformed value and defensively copy them", () => {
    const issues = [{ key: "token", code: "required" as const, message: "Required configuration value is missing." }];
    const error = new ConfigValidationError(issues);
    issues[0]!.key = "changed";
    issues.push({ key: "other", code: "invalid", message: "invalid" });
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.key).toBe("token");
    expect(error.name).toBe("ConfigValidationError");
    expect(error.message).toBe("Invalid configuration: token: Required configuration value is missing.");
    expect(() => assertValidConfig({ value: 1, issues: [...error.issues] })).toThrow(ConfigValidationError);
  });

  it("should reject an empty direct error issue list", () => {
    expect(() => new ConfigValidationError([])).toThrow(
      "ConfigValidationError requires at least one issue.",
    );
  });
});
