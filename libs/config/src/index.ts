export { z } from "zod";

export interface ConfigIssue {
  key: string;
  code: "required" | "invalid" | "inconsistent";
  message: string;
}

export interface ConfigResult<T> {
  value?: T;
  issues: ConfigIssue[];
}

const MESSAGES = {
  required: "Required configuration value is missing.",
  invalid: "Configuration value is invalid.",
  inconsistent: "Configuration values are inconsistent.",
} as const;

function formatKey(path: readonly PropertyKey[]): string {
  let key = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      key += `[${segment}]`;
    } else if (typeof segment === "string") {
      key += key === "" ? segment : `.${segment}`;
    } else {
      throw new TypeError("Symbol configuration paths are not supported.");
    }
  }
  return key || "$";
}

export class ConfigValidationError extends Error {
  override readonly name = "ConfigValidationError" as const;
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    if (issues.length === 0) {
      throw new TypeError("ConfigValidationError requires at least one issue.");
    }
    const copied = issues.map((issue) => Object.freeze({ ...issue }));
    super(`Invalid configuration: ${copied.map((issue) => `${issue.key}: ${issue.message}`).join("; ")}`);
    this.issues = Object.freeze(copied);
  }
}

export function parseConfig<T>(
  schema: import("zod").ZodType<T>,
  loaded: unknown,
): ConfigResult<T> {
  const result = schema.safeParse(loaded, { reportInput: true });
  if (result.success) return { value: result.data, issues: [] };

  const issues = result.error.issues.map((issue): ConfigIssue => {
    const code = issue.code === "invalid_type" && issue.input === undefined
      ? "required"
      : issue.code === "custom"
        ? "inconsistent"
        : "invalid";
    return {
      key: formatKey(issue.path),
      code,
      message: MESSAGES[code],
    };
  });
  return {
    issues: issues.length > 0
      ? issues
      : [{ key: "$", code: "invalid", message: MESSAGES.invalid }],
  };
}

export function assertValidConfig<T>(result: ConfigResult<T>): T {
  if (result.issues.length > 0) throw new ConfigValidationError(result.issues);
  if (!Object.hasOwn(result, "value")) {
    throw new TypeError("Malformed ConfigResult: success must contain a value property.");
  }
  return result.value as T;
}
