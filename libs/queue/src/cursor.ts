import { createHash, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import { EvaluationStateSchema, StoryIdSchema } from "@tmtp/domain";
import type { EvaluationState, StoryId } from "@tmtp/domain";
import { QueueError } from "./error.js";

export const QUEUE_CURSOR_VERSION = "q1" as const;
export interface QueueCursorPosition {
  rankVersion: string;
  evaluationState: EvaluationState;
  rankPosition?: number;
  storyId: StoryId;
}

function invalid(): never {
  throw new QueueError("invalid-cursor", "Queue cursor is invalid.");
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validatePosition(position: QueueCursorPosition): QueueCursorPosition {
  if (!object(position)) invalid();
  const expected = position.evaluationState === "scored"
    ? ["rankVersion", "evaluationState", "rankPosition", "storyId"]
    : ["rankVersion", "evaluationState", "storyId"];
  const actual = Object.keys(position);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) invalid();
  if (typeof position.rankVersion !== "string" || position.rankVersion === "" || position.rankVersion.length > 128) invalid();
  if (!EvaluationStateSchema.safeParse(position.evaluationState).success || !StoryIdSchema.safeParse(position.storyId).success) invalid();
  if (position.evaluationState === "scored") {
    if (!Number.isSafeInteger(position.rankPosition) || (position.rankPosition as number) < 1) invalid();
    return { rankVersion: position.rankVersion, evaluationState: position.evaluationState, rankPosition: position.rankPosition!, storyId: position.storyId };
  }
  if (position.rankPosition !== undefined) invalid();
  return { rankVersion: position.rankVersion, evaluationState: position.evaluationState, storyId: position.storyId };
}
function payload(position: QueueCursorPosition): { json: string; bytes: Buffer; encoded: string } {
  const valid = validatePosition(position);
  const json = JSON.stringify(valid);
  const bytes = Buffer.from(json, "utf8");
  return { json, bytes, encoded: bytes.toString("base64url") };
}

export function encodeQueueCursor(position: QueueCursorPosition): string {
  const encoded = payload(position);
  const checksum = createHash("sha256").update(encoded.bytes).digest("base64url");
  return `${QUEUE_CURSOR_VERSION}.${encoded.encoded}.${checksum}`;
}

function decodeSegment(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) invalid();
  return bytes;
}

export function decodeQueueCursor(cursor: string): QueueCursorPosition {
  try {
    if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 2_048) invalid();
    const parts = cursor.split(".");
    if (parts.length !== 3 || parts[0] !== QUEUE_CURSOR_VERSION) invalid();
    const bytes = decodeSegment(parts[1]!);
    const checksum = decodeSegment(parts[2]!);
    const expected = createHash("sha256").update(bytes).digest();
    if (checksum.length !== expected.length || !timingSafeEqual(checksum, expected)) invalid();
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(json) as unknown;
    if (!object(parsed)) invalid();
    const valid = validatePosition(parsed as unknown as QueueCursorPosition);
    const keys = Object.keys(parsed);
    const expectedKeys = valid.evaluationState === "scored"
      ? ["rankVersion", "evaluationState", "rankPosition", "storyId"]
      : ["rankVersion", "evaluationState", "storyId"];
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) invalid();
    if (JSON.stringify(valid) !== json || encodeQueueCursor(valid) !== cursor) invalid();
    return { ...valid };
  } catch {
    invalid();
  }
}
