import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { HttpResponse } from "@tmtp/http-client";
import type { ArticleContentType } from "./types.js";
import { failure } from "./errors.js";

function headerValues(response: HttpResponse, name: string): readonly string[] | undefined {
  for (const [key, value] of Object.entries(response.headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}
function splitParameters(value: string): string[] | undefined {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) { escaped = false; continue; }
    if (quoted && character === "\\") { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && character === ";") { parts.push(value.slice(start, index)); start = index + 1; }
  }
  if (quoted || escaped) return undefined;
  parts.push(value.slice(start));
  return parts;
}
function unquote(value: string): string | undefined {
  if (!value.startsWith('"')) return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value) ? value : undefined;
  if (value.length < 2 || !value.endsWith('"')) return undefined;
  let result = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index]!;
    if (character === "\\") {
      index += 1;
      if (index >= value.length - 1) return undefined;
      result += value[index]!;
    } else {
      if (character === '"' || /[\r\n\0]/.test(character)) return undefined;
      result += character;
    }
  }
  return result;
}
export function validateContentType(response: HttpResponse): ArticleContentType {
  const values = headerValues(response, "content-type");
  if (values?.length !== 1) throw failure("unsupported-content-type", response.status);
  const parts = splitParameters(values[0]!);
  const media = parts?.[0]?.trim().toLowerCase();
  if (parts === undefined || (media !== "text/html" && media !== "application/xhtml+xml")) {
    throw failure("unsupported-content-type", response.status);
  }
  let charset: string | undefined;
  for (const parameter of parts.slice(1)) {
    const match = /^\s*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(parameter);
    if (match === null) throw failure("unsupported-content-type", response.status);
    const name = match[1]!.toLowerCase();
    const value = unquote(match[2]!);
    if (value === undefined) throw failure("unsupported-content-type", response.status);
    if (name === "charset") {
      if (charset !== undefined) throw failure("unsupported-charset", response.status);
      charset = value;
    }
  }
  if (charset !== undefined && !["utf-8", "utf8"].includes(charset.toLowerCase())) {
    throw failure("unsupported-charset", response.status);
  }
  return media;
}
function encodings(response: HttpResponse): string[] {
  const values = headerValues(response, "content-encoding") ?? [];
  if (values.length === 0) return [];
  const tokens = values.flatMap((value) => value.split(",").map((token) => token.trim().toLowerCase()));
  if (tokens.length === 0 || tokens.some((token) => token === "") ||
    tokens.some((token) => !["identity", "gzip", "deflate", "br"].includes(token)) ||
    (tokens.includes("identity") && tokens.length !== 1)) {
    throw failure("unsupported-content-encoding", response.status);
  }
  return tokens[0] === "identity" ? [] : tokens;
}

export async function decodeContent(
  response: HttpResponse,
  maxBytes: number,
  signal: AbortSignal,
  race: <T>(promise: Promise<T>, signal: AbortSignal) => Promise<T>,
): Promise<{ contentType: ArticleContentType; bytes: Uint8Array }> {
  const contentType = validateContentType(response);
  const codings = encodings(response);
  const body = response.body;
  if (body.length > maxBytes) throw failure("response-too-large", response.status);
  if (codings.length === 0) return { contentType, bytes: new Uint8Array(body) };
  const stages: Readable[] = [];
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    const input = Readable.from([Buffer.from(body)]);
    stages.push(input);
    let output: Readable = input;
    for (const coding of [...codings].reverse()) {
      const decoder = coding === "gzip" ? createGunzip() : coding === "deflate" ? createInflate() : createBrotliDecompress();
      stages.push(decoder);
      output = output.pipe(decoder);
    }
    const iterator = output[Symbol.asyncIterator]();
    while (true) {
      const result = await race(Promise.resolve(iterator.next()), signal);
      if (signal.aborted) throw signal.reason;
      if (result.done) break;
      const chunk = result.value as Uint8Array;
      if (received + chunk.length > maxBytes) throw failure("response-too-large", response.status);
      chunks.push(new Uint8Array(chunk));
      received += chunk.length;
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { contentType, bytes };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof Error && error.name === "ArticleFetchError") throw error;
    throw failure("invalid-content-encoding", response.status);
  } finally {
    for (const stage of stages) stage.destroy();
  }
}
