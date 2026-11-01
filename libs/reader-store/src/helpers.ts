import { IsoDateTimeSchema, StoryIdSchema } from "@tmtp/domain";
import type { SqlParameters } from "@tmtp/database";
import { fail } from "./error.js";

export function positiveLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) fail("invalid-query");
}
export function nonNegativeLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid-query");
}
export function storyId(value: number): void {
  if (!StoryIdSchema.safeParse(value).success) fail("invalid-query");
}
export function timestamp(value: string): void {
  if (!IsoDateTimeSchema.safeParse(value).success) fail("invalid-query");
}
export function nonEmpty(value: string): void {
  if (typeof value !== "string" || value.length === 0) fail("invalid-query");
}
export function ids(values: number[]): number[] {
  if (!Array.isArray(values)) fail("invalid-query");
  const unique = [...new Set(values)];
  for (const value of unique) storyId(value);
  return unique;
}
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}
export function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Value is not JSON serializable.");
  return encoded;
}
export function parseJson(value: string): unknown {
  return JSON.parse(value);
}
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
export function sameRecord(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
export function ascendingCursor(after: { timestamp: string; id: string } | undefined): { sql: string; parameters: SqlParameters } {
  if (after === undefined) return { sql: "", parameters: [] };
  timestamp(after.timestamp);
  nonEmpty(after.id);
  return { sql: "", parameters: [] };
}
