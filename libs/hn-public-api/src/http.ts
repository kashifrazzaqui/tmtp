import { HttpError } from "@tmtp/http-client";
import type { HttpClient, HttpResponse } from "@tmtp/http-client";
import { apiError, InvalidResponse } from "./errors.js";
import type { HnPublicApiError } from "./errors.js";
import type { HnPublicApiOperation } from "./types.js";

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
function header(response: HttpResponse, name: string): readonly string[] | undefined {
  return Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
}
function unquote(value: string): string | undefined {
  if (!value.startsWith('"')) return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value) ? value : undefined;
  if (value.length < 2 || !value.endsWith('"')) return undefined;
  let output = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      if (index >= value.length - 1) return undefined;
    }
    output += value[index];
  }
  return output;
}
function parameters(value: string): string[] | undefined {
  const parts: string[] = [];
  let quoted = false;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) { escaped = false; continue; }
    if (quoted && character === "\\") { escaped = true; continue; }
    if (character === '"') quoted = !quoted;
    if (!quoted && character === ";") { parts.push(value.slice(start, index)); start = index + 1; }
  }
  if (quoted || escaped) return undefined;
  parts.push(value.slice(start));
  return parts;
}
function validateHeaders(response: HttpResponse): void {
  const contentType = header(response, "content-type");
  if (contentType?.length !== 1) throw new InvalidResponse();
  const parts = parameters(contentType[0]!);
  if (parts === undefined || parts[0]?.trim().toLowerCase() !== "application/json") throw new InvalidResponse();
  let charset: string | undefined;
  for (const parameter of parts.slice(1)) {
    const match = /^\s*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(parameter);
    if (match === null) throw new InvalidResponse();
    const value = unquote(match[2]!);
    if (value === undefined) throw new InvalidResponse();
    if (match[1]!.toLowerCase() === "charset") {
      if (charset !== undefined) throw new InvalidResponse();
      charset = value;
    }
  }
  if (charset !== undefined && !["utf-8", "utf8"].includes(charset.toLowerCase())) throw new InvalidResponse();
  const encoding = header(response, "content-encoding");
  if (encoding !== undefined && (encoding.length !== 1 || encoding[0]!.trim().toLowerCase() !== "identity")) throw new InvalidResponse();
}
export function decodeJson(response: HttpResponse, operation: HnPublicApiOperation): unknown {
  if (response.status !== 200) throw apiError("http-status", operation, RETRYABLE_STATUSES.has(response.status), response.status);
  validateHeaders(response);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    if (text.trim() === "") throw new InvalidResponse();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof InvalidResponse) throw error;
    throw new InvalidResponse();
  }
}
export function mapHttpError(error: HttpError, operation: HnPublicApiOperation): HnPublicApiError {
  const mapping = {
    "invalid-request": "invalid-input", timeout: "timeout", "response-too-large": "response-too-large",
    "redirect-policy": "redirect-policy", "redirect-limit": "redirect-limit", "invalid-redirect": "invalid-redirect",
    transport: "transport", "client-closed": "client-closed",
  } as const;
  const code = mapping[error.code];
  return apiError(code, operation, code === "transport", error.status);
}
export async function getJson(http: HttpClient, url: string, operation: HnPublicApiOperation, signal: AbortSignal | undefined): Promise<unknown> {
  try {
    const response = await http.request({
      method: "GET", url, headers: { accept: "application/json" }, redirect: "same-origin", maxResponseBytes: 5_000_000,
      ...(signal === undefined ? {} : { signal }),
    });
    if (signal?.aborted) throw signal.reason;
    return decodeJson(response, operation);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof HttpError) throw mapHttpError(error, operation);
    throw error;
  }
}
