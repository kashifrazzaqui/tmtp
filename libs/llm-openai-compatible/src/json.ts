import { createHash } from "node:crypto";
import type { JsonSchema, LlmRequest } from "@tmtp/llm-interface";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class InvalidJson extends Error {}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function snapshotJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InvalidJson();
    return value;
  }
  if (typeof value !== "object") throw new InvalidJson();
  if (ancestors.has(value)) throw new InvalidJson();
  if ("toJSON" in value) throw new InvalidJson();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new InvalidJson();
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) throw new InvalidJson();
        result.push(snapshotJson(descriptor.value, ancestors));
      }
      return result;
    }
    if (!isPlainObject(value)) throw new InvalidJson();
    const result: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) throw new InvalidJson();
      result[key] = snapshotJson(descriptor.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function schemaObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateSchema(schema: JsonValue): void {
  if (!schemaObject(schema) || typeof schema.type !== "string" || schema.type.length === 0) throw new InvalidJson();
  if (schema.properties !== undefined) {
    if (!schemaObject(schema.properties)) throw new InvalidJson();
    for (const nested of Object.values(schema.properties)) validateSchema(nested);
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string")) throw new InvalidJson();
    if (new Set(schema.required).size !== schema.required.length) throw new InvalidJson();
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      for (const nested of schema.items) validateSchema(nested);
    } else {
      validateSchema(schema.items);
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    validateSchema(schema.additionalProperties);
  }
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

export interface PreparedRequest<T> {
  purpose: LlmRequest<T>["purpose"];
  model: string;
  instructions: string;
  input: JsonValue;
  outputSchema: JsonSchema;
  parseOutput: (value: unknown) => T;
  capturePayload: boolean;
  signal?: AbortSignal;
  projection: { [key: string]: JsonValue };
  requestHash: string;
  body: { [key: string]: unknown };
}

function validSignal(value: unknown): value is AbortSignal {
  return typeof AbortSignal !== "undefined" && value instanceof AbortSignal;
}

export function alreadyAborted(request: unknown): boolean {
  if (request === null || typeof request !== "object") return false;
  const signal = (request as { signal?: unknown }).signal;
  return validSignal(signal) && signal.aborted;
}

export function prepareRequest<T>(request: LlmRequest<T>, maxOutputTokens: number): PreparedRequest<T> {
  if (request === null || typeof request !== "object" || Array.isArray(request)) throw new InvalidJson();
  if (request.purpose !== "recommendation" && request.purpose !== "connection-check") throw new InvalidJson();
  if (typeof request.model !== "string" || request.model === "" || request.model.trim() !== request.model) throw new InvalidJson();
  if (typeof request.instructions !== "string" || request.instructions.trim() === "") throw new InvalidJson();
  if (typeof request.parseOutput !== "function" || typeof request.capturePayload !== "boolean") throw new InvalidJson();
  if (request.signal !== undefined && !validSignal(request.signal)) throw new InvalidJson();
  const input = snapshotJson(request.input);
  const schemaSnapshot = snapshotJson(request.outputSchema);
  validateSchema(schemaSnapshot);
  if (!schemaObject(schemaSnapshot) || schemaSnapshot.type !== "object") throw new InvalidJson();
  const outputSchema = schemaSnapshot as unknown as JsonSchema;
  const projection: { [key: string]: JsonValue } = {
    purpose: request.purpose,
    model: request.model,
    instructions: request.instructions,
    input,
    outputSchema: schemaSnapshot,
    maxOutputTokens,
  };
  const canonical = canonicalJson(projection);
  const requestHash = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
  const body = {
    model: request.model,
    messages: [
      { role: "system", content: request.instructions },
      {
        role: "user",
        content: `Input JSON:\n${canonicalJson(input)}\n\nReturn only one JSON object that conforms to this JSON Schema:\n${canonicalJson(schemaSnapshot)}`,
      },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: maxOutputTokens,
    n: 1,
    stream: false,
  };
  return {
    purpose: request.purpose,
    model: request.model,
    instructions: request.instructions,
    input,
    outputSchema,
    parseOutput: request.parseOutput,
    capturePayload: request.capturePayload,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    projection,
    requestHash,
    body,
  };
}
