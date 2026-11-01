import { HnItemSchema } from "@tmtp/domain";
import type { HnItem } from "@tmtp/domain";
import { InvalidResponse } from "./errors.js";
const TYPES = new Set(["story", "comment", "job", "poll", "pollopt"]);
function own(record: Record<string, unknown>, key: string): boolean { return Object.prototype.hasOwnProperty.call(record, key); }
function integer(value: unknown, positive = false): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0);
}
export function parseItem(value: unknown, requestedId: number): HnItem | undefined {
  if (value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new InvalidResponse();
  const source = value as Record<string, unknown>;
  if (!integer(source.id, true) || source.id !== requestedId) throw new InvalidResponse();
  if (own(source, "type") && (typeof source.type !== "string" || !TYPES.has(source.type))) throw new InvalidResponse();
  for (const key of ["by", "title", "url", "text"] as const) {
    if (own(source, key) && typeof source[key] !== "string") throw new InvalidResponse();
  }
  for (const key of ["score", "descendants"] as const) {
    if (own(source, key) && !integer(source[key])) throw new InvalidResponse();
  }
  if (own(source, "time")) {
    if (!integer(source.time) || source.time * 1000 > 8_640_000_000_000_000 || !Number.isFinite(new Date(source.time * 1000).getTime())) throw new InvalidResponse();
  }
  for (const key of ["deleted", "dead"] as const) {
    if (own(source, key) && typeof source[key] !== "boolean") throw new InvalidResponse();
  }
  const deleted = source.deleted === true;
  const dead = source.dead === true;
  if (!own(source, "type") && !deleted && !dead) throw new InvalidResponse();
  const item = {
    id: source.id,
    ...(source.type === undefined ? {} : { type: source.type as HnItem["type"] }),
    ...(source.by === undefined ? {} : { author: source.by as string }),
    ...(source.time === undefined ? {} : { time: source.time as number }),
    ...(source.title === undefined ? {} : { title: source.title as string }),
    ...(source.url === undefined || source.url === "" ? {} : { url: source.url as string }),
    ...(source.text === undefined ? {} : { textHtml: source.text as string }),
    ...(source.score === undefined ? {} : { score: source.score as number }),
    ...(source.descendants === undefined ? {} : { descendants: source.descendants as number }),
    deleted, dead, raw: structuredClone(source), rawSchemaVersion: 1 as const,
  };
  const parsed = HnItemSchema.safeParse(item);
  if (!parsed.success) throw new InvalidResponse();
  return parsed.data;
}
