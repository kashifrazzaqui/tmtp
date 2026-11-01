import { DiagnosticsError } from "./errors.js";
import type { JsonValue } from "./types.js";

const SENSITIVE = new Set([
  "authorization", "proxyauthorization", "cookie", "cookies", "setcookie", "xapikey", "apikey", "token", "authtoken",
  "accesstoken", "refreshtoken", "sessiontoken", "csrftoken", "secret", "clientsecret", "password", "passwd",
  "sessioncookie", "csrfsecret", "sessionid", "opaquesession", "credential", "credentials", "secretvalues",
  "secretfilecontents", "headers", "requestheaders", "responseheaders", "rawheaders", "url", "uri", "error",
  "errors", "err", "exception", "stack",
]);
const TRUNCATED = "[Truncated]";
const PRUNE = Symbol("prune");
function sensitiveKey(key: string): boolean { return SENSITIVE.has(key.replace(/[_-]/g, "").toLowerCase()); }
function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum - TRUNCATED.length) + TRUNCATED;
}
export class Redactor {
  private readonly secrets: readonly string[];
  constructor(secrets: readonly string[]) {
    this.secrets = secrets.filter((value) => value.length > 0).map((value, index) => ({ value, index }))
      .sort((a, b) => b.value.length - a.value.length || a.index - b.index).map((entry) => entry.value);
  }
  replace(value: string): string {
    let result = "";
    let offset = 0;
    while (offset < value.length) {
      const secret = this.secrets.find((candidate) => value.startsWith(candidate, offset));
      if (secret === undefined) { result += value[offset]; offset += 1; }
      else { result += "[Redacted]"; offset += secret.length; }
    }
    return result;
  }
  text(value: string, maximum: number, urls = true): string {
    const replaced = this.replace(value);
    return truncate(urls ? replaced.replace(/(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\/\/)[^\s<>"']+/g, "[RedactedUrl]") : replaced, maximum);
  }
  code(value: string, fallback: "unknown-error" | "unknown-component"): string {
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64 ? this.text(value, 64, false) : fallback;
  }
  json(value: unknown): { value: JsonValue; truncated: boolean } {
    let nodes = 0;
    let truncated = false;
    const ancestors = new Set<object>();
    const visit = (input: unknown, depth: number): JsonValue | typeof PRUNE => {
      nodes += 1;
      if (nodes > 200 || depth > 8) { truncated = true; return PRUNE; }
      if (input === null || typeof input === "boolean") return input;
      if (typeof input === "number") {
        if (!Number.isFinite(input)) throw new TypeError("Invalid JSON number.");
        return input;
      }
      if (typeof input === "string") {
        const replaced = this.replace(input).replace(/(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\/\/)[^\s<>"']+/g, "[RedactedUrl]");
        if (replaced.length > 2000) truncated = true;
        return truncate(replaced, 2000);
      }
      if (typeof input !== "object" || input === null) throw new TypeError("Invalid JSON value.");
      const object = input as object;
      if (ancestors.has(object)) throw new TypeError("Cyclic JSON value.");
      const prototype = Object.getPrototypeOf(object);
      if (!Array.isArray(object) && prototype !== Object.prototype && prototype !== null) throw new TypeError("Invalid JSON object.");
      if (Object.getOwnPropertySymbols(object).some((key) => Object.getOwnPropertyDescriptor(object, key)?.enumerable)) {
        throw new TypeError("Invalid JSON key.");
      }
      ancestors.add(object);
      try {
        if (Array.isArray(object)) {
          if (object.length > 50) truncated = true;
          const output: JsonValue[] = [];
          for (let index = 0; index < Math.min(object.length, 50); index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(object, index);
            if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("Invalid JSON array.");
            const child = visit(descriptor.value, depth + 1);
            if (child === PRUNE) { truncated = true; break; }
            output.push(child);
          }
          return output;
        }
        const output: { [key: string]: JsonValue } = {};
        const keys = Object.keys(object);
        if (keys.length > 50) truncated = true;
        for (const key of keys.slice(0, 50)) {
          const descriptor = Object.getOwnPropertyDescriptor(object, key);
          if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("Invalid JSON property.");
          if (sensitiveKey(key)) { output[this.text(key, 2000)] = "[Redacted]"; continue; }
          const child = visit(descriptor.value, depth + 1);
          if (child === PRUNE) { truncated = true; break; }
          const safeKey = this.text(key, 2000);
          if (Object.prototype.hasOwnProperty.call(output, safeKey)) throw new TypeError("Ambiguous redacted JSON key.");
          output[safeKey] = child;
        }
        return output;
      } finally {
        ancestors.delete(object);
      }
    };
    const result = visit(value, 0);
    if (result === PRUNE) return { value: null, truncated: true };
    return { value: result, truncated };
  }
}
export function providerInventory(provider: () => readonly string[]): readonly string[] {
  try {
    const values = provider();
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) throw new TypeError("Invalid secrets.");
    return [...values].filter((value) => value.length > 0);
  } catch {
    throw new DiagnosticsError("redaction-provider-failed");
  }
}
