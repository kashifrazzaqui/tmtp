import { createHash, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import { decodeQueueCursor, encodeQueueCursor } from "@tmtp/queue";
import type { QueueCursorPosition } from "@tmtp/queue";
import type { EvaluationState, QueueEntry, QueueState, VisibilityState } from "@tmtp/domain";
import { appError } from "./errors.js";
import { exactKeys, plainObject } from "./validation.js";
import type { NormalizedQueueQuery } from "./validation.js";

interface CursorFilters {
  state: QueueState | null;
  evaluationState: EvaluationState | null;
  visibilityState: VisibilityState;
}
interface CursorPayload {
  filters: CursorFilters;
  manifestHash: string;
  after: string;
}
export interface DecodedReaderCursor {
  manifestHash: string;
  position: QueueCursorPosition;
}

function invalid(): never { throw appError("invalid-cursor", "get-queue", { field: "cursor", retryable: false }); }
function segment(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) invalid();
  return bytes;
}
function filters(query: NormalizedQueueQuery): CursorFilters {
  return {
    state: query.state ?? null,
    evaluationState: query.evaluationState ?? null,
    visibilityState: query.visibilityState,
  };
}
function sameFilters(left: CursorFilters, right: CursorFilters): boolean {
  return left.state === right.state && left.evaluationState === right.evaluationState && left.visibilityState === right.visibilityState;
}
function canonical(payload: CursorPayload): string { return JSON.stringify(payload); }

export function encodeReaderCursor(query: NormalizedQueueQuery, manifestHash: string, entry: QueueEntry): string {
  const after = encodeQueueCursor({
    rankVersion: entry.rankVersion,
    evaluationState: entry.evaluationState,
    ...(entry.evaluationState === "scored" ? { rankPosition: entry.rankPosition! } : {}),
    storyId: entry.storyId,
  });
  const payload: CursorPayload = { filters: filters(query), manifestHash, after };
  const bytes = Buffer.from(canonical(payload), "utf8");
  return `rqa1.${bytes.toString("base64url")}.${createHash("sha256").update(bytes).digest("base64url")}`;
}

export function decodeReaderCursor(cursor: string, query: NormalizedQueueQuery): DecodedReaderCursor {
  try {
    if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4096) invalid();
    const parts = cursor.split(".");
    if (parts.length !== 3 || parts[0] !== "rqa1") invalid();
    const bytes = segment(parts[1]!);
    const checksum = segment(parts[2]!);
    const expected = createHash("sha256").update(bytes).digest();
    if (checksum.length !== expected.length || !timingSafeEqual(checksum, expected)) invalid();
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(json) as unknown;
    if (!plainObject(parsed) || !exactKeys(parsed, ["filters", "manifestHash", "after"]) ||
      Object.keys(parsed).join(",") !== "filters,manifestHash,after") invalid();
    if (!plainObject(parsed.filters) || !exactKeys(parsed.filters, ["state", "evaluationState", "visibilityState"]) ||
      Object.keys(parsed.filters).join(",") !== "state,evaluationState,visibilityState") invalid();
    const candidate = parsed as unknown as CursorPayload;
    if (!sameFilters(candidate.filters, filters(query)) || typeof candidate.manifestHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(candidate.manifestHash) || typeof candidate.after !== "string") invalid();
    if (canonical(candidate) !== json) invalid();
    let position: QueueCursorPosition;
    try { position = decodeQueueCursor(candidate.after); } catch { invalid(); }
    if (query.evaluationState !== undefined && position.evaluationState !== query.evaluationState) invalid();
    const reencoded = `rqa1.${Buffer.from(canonical(candidate), "utf8").toString("base64url")}.${createHash("sha256").update(bytes).digest("base64url")}`;
    if (reencoded !== cursor) invalid();
    return { manifestHash: candidate.manifestHash, position };
  } catch (error) {
    if (error instanceof Error && error.name === "ReaderAppError" && (error as { code?: unknown }).code === "invalid-cursor") throw error;
    invalid();
  }
}
