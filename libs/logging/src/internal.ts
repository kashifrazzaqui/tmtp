import { writeSync } from "node:fs";
import pino from "pino";
import type { CreateLoggerOptions, LogFields, Logger, LogLevel } from "./types.js";

const LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug", "trace"];
const RESERVED_KEYS = new Set(["level", "time", "service", "msg", "serializers", "formatters", "customLevels"]);
const SENSITIVE_KEYS = new Set([
  "authorization", "proxyauthorization", "cookie", "cookies", "setcookie", "xapikey",
  "apikey", "token", "authtoken", "accesstoken", "refreshtoken", "sessiontoken", "csrftoken",
  "secret", "clientsecret", "password", "passwd", "sessioncookie", "csrfsecret",
  "sessionid", "opaquesession", "credential", "credentials", "secretvalues", "secretfilecontents",
]);
const REDACTED = "[Redacted]";
const UNSERIALIZABLE = "[Unserializable]";

interface Destination {
  write(line: string): void;
}

function stdoutDestination(): Destination {
  return {
    write(line: string): void {
      const buffer = Buffer.from(line, "utf8");
      let offset = 0;
      while (offset < buffer.length) {
        offset += writeSync(1, buffer, offset, buffer.length - offset);
      }
    },
  };
}

function normalizeSecretKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

function redactString(value: string, secrets: readonly string[]): string {
  let result = "";
  let offset = 0;
  while (offset < value.length) {
    const secret = secrets.find((candidate) => value.startsWith(candidate, offset));
    if (secret === undefined) {
      result += value[offset];
      offset += 1;
    } else {
      result += REDACTED;
      offset += secret.length;
    }
  }
  return result;
}

function dataProperty(value: object, key: PropertyKey): { found: boolean; accessor: boolean; value?: unknown } {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) return { found: true, accessor: true };
      return { found: true, accessor: false, value: descriptor.value };
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return { found: false, accessor: false };
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializeError(error: Error, secrets: readonly string[], ancestors: Set<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const name = dataProperty(error, "name");
  const message = dataProperty(error, "message");
  result.name = redactString(
    name.found && !name.accessor && typeof name.value === "string" ? name.value : "Error",
    secrets,
  );
  result.message = redactString(
    message.found && !message.accessor && typeof message.value === "string" ? message.value : "",
    secrets,
  );

  const stack = dataProperty(error, "stack");
  if (stack.found && !stack.accessor && typeof stack.value === "string") {
    result.stack = redactString(stack.value, secrets);
  }
  const code = dataProperty(error, "code");
  if (
    code.found && !code.accessor &&
    (typeof code.value === "string" || (typeof code.value === "number" && Number.isFinite(code.value)))
  ) {
    result.code = typeof code.value === "string" ? redactString(code.value, secrets) : code.value;
  }
  const cause = dataProperty(error, "cause");
  if (cause.found && !cause.accessor && cause.value !== undefined) {
    result.cause = serializeValue(cause.value, secrets, ancestors, false);
  }
  return result;
}

function serializeValue(
  value: unknown,
  secrets: readonly string[],
  ancestors: Set<object>,
  arrayElement: boolean,
): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return arrayElement ? null : undefined;
  }
  if (typeof value !== "object") return UNSERIALIZABLE;
  if (ancestors.has(value)) return "[Circular]";

  if (value instanceof Date) {
    return Number.isFinite(Date.prototype.getTime.call(value))
      ? Date.prototype.toISOString.call(value)
      : null;
  }
  if (!Array.isArray(value) && !(value instanceof Error) && !isPlainObject(value)) {
    return UNSERIALIZABLE;
  }

  ancestors.add(value);
  try {
    if (value instanceof Error) return serializeError(value, secrets, ancestors);
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) {
          result.push(null);
        } else if (!("value" in descriptor)) {
          result.push(UNSERIALIZABLE);
        } else {
          result.push(serializeValue(descriptor.value, secrets, ancestors, true));
        }
      }
      return result;
    }

    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      const sanitizedKey = redactString(key, secrets);
      if (normalizeSecretKey(key) !== "" && SENSITIVE_KEYS.has(normalizeSecretKey(key))) {
        result[sanitizedKey] = REDACTED;
        continue;
      }
      const serialized = !("value" in descriptor)
        ? UNSERIALIZABLE
        : serializeValue(descriptor.value, secrets, ancestors, false);
      if (serialized !== undefined) result[sanitizedKey] = serialized;
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function snapshotFields(fields: LogFields): LogFields {
  const snapshot: LogFields = {};
  for (const key of Object.keys(fields)) {
    const descriptor = Object.getOwnPropertyDescriptor(fields, key);
    if (descriptor !== undefined) {
      Object.defineProperty(snapshot, key, {
        value: "value" in descriptor ? descriptor.value : UNSERIALIZABLE,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return snapshot;
}

function sortedSecrets(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))].sort((left, right) =>
    right.length - left.length || (left < right ? -1 : left > right ? 1 : 0)
  );
}

function validateStaticSecrets(values: unknown): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new TypeError("Invalid secret values.");
  }
  return sortedSecrets(values);
}

export function createInternalLogger(
  options: CreateLoggerOptions,
  destination: Destination = stdoutDestination(),
): Logger {
  if (!LEVELS.includes(options.level)) throw new TypeError("Invalid log level.");
  if (typeof options.service !== "string" || options.service.trim() === "") {
    throw new TypeError("Invalid service name.");
  }
  const hasStatic = options.secretValues !== undefined;
  const hasProvider = options.secretValuesProvider !== undefined;
  if (hasStatic === hasProvider || (hasProvider && typeof options.secretValuesProvider !== "function")) {
    throw new TypeError("Invalid secret values.");
  }
  const staticSecrets = hasStatic ? validateStaticSecrets(options.secretValues) : undefined;
  const provider = options.secretValuesProvider;
  const service = options.service.trim();

  const pinoLogger = pino({
    level: options.level,
    base: null,
    messageKey: "msg",
    timestamp: pino.stdTimeFunctions.epochTime,
    serializers: { err: (value: unknown) => value },
    redact: {
      paths: [
        "authorization", "cookie", "cookies", "token", "secret", "password",
        "headers.authorization", "headers.cookie", "headers['set-cookie']",
      ],
      censor: REDACTED,
    },
  }, destination);

  function resolveSecrets(): string[] {
    if (staticSecrets !== undefined) return staticSecrets;
    try {
      if (provider === undefined) throw new TypeError("Invalid secret values.");
      const supplied = provider();
      if (!Array.isArray(supplied) || Object.getPrototypeOf(supplied) !== Array.prototype) {
        throw new TypeError("Invalid secret values.");
      }
      const copied = [...supplied];
      if (copied.some((value) => typeof value !== "string")) throw new TypeError("Invalid secret values.");
      return sortedSecrets(copied);
    } catch {
      destination.write(`${JSON.stringify({ level: 50, time: Date.now(), msg: "Redaction provider failed." })}\n`);
      throw new Error("Redaction provider failed.");
    }
  }

  function create(bindings: LogFields): Logger {
    const bound = snapshotFields(bindings);
    const logger: Logger = {
      trace: (message, fields) => write("trace", message, fields),
      debug: (message, fields) => write("debug", message, fields),
      info: (message, fields) => write("info", message, fields),
      warn: (message, fields) => write("warn", message, fields),
      error: (message, fields) => write("error", message, fields),
      child: (fields) => create({ ...bound, ...snapshotFields(fields) }),
    };

    function write(level: LogLevel, message: string, fields?: LogFields): void {
      if (!pinoLogger.isLevelEnabled(level)) return;
      const secrets = resolveSecrets();
      const inherited = serializeValue(bound, secrets, new Set(), false) as Record<string, unknown>;
      const current = fields === undefined
        ? {}
        : serializeValue(fields, secrets, new Set(), false) as Record<string, unknown>;
      const record: Record<string, unknown> = {};
      for (const [key, value] of [...Object.entries(inherited), ...Object.entries(current)]) {
        if (!RESERVED_KEYS.has(key)) record[key] = value;
      }
      record.service = redactString(service, secrets);
      pinoLogger[level](record, redactString(message, secrets));
    }

    return logger;
  }

  return create({});
}
