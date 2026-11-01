import type { IsoDateTime } from "@tmtp/domain";
import { InvalidCheckpoint } from "./errors.js";
export const COLLECTION_CURSOR = "hn.public.collection";
export const REFRESH_CURSOR = "hn.public.refresh";
export const ACCOUNT_CURSORS = { upvote: "hn.account.upvote", favorite: "hn.account.favorite", flag: "hn.account.flag" } as const;
export type AccountKind = keyof typeof ACCOUNT_CURSORS;
export type CollectionCheckpoint = { schemaVersion: 1; state: "bootstrap"; targetMaxItemId: number; feedIds: number[]; nextFeedIndex: number; nextLookbackId?: number } |
  { schemaVersion: 1; state: "advance"; lastProcessedItemId: number };
export interface RefreshCheckpoint { schemaVersion: 1; afterStoryId?: number; }
export interface AccountCheckpoint { schemaVersion: 1; username: string; continuation?: string; }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function keys(value: Record<string, unknown>, allowed: string[], required: string[]): boolean {
  const actual = Object.keys(value);
  return actual.every((key) => allowed.includes(key)) && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function parse(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value) !== raw) throw new InvalidCheckpoint();
    return value as Record<string, unknown>;
  } catch (error) { if (error instanceof InvalidCheckpoint) throw error; throw new InvalidCheckpoint(); }
}
export function decodeCollection(raw: string | undefined): CollectionCheckpoint | undefined {
  const value = parse(raw); if (value === undefined) return undefined;
  if (value.schemaVersion !== 1) throw new InvalidCheckpoint();
  if (value.state === "advance") {
    if (!keys(value, ["schemaVersion", "state", "lastProcessedItemId"], ["schemaVersion", "state", "lastProcessedItemId"]) || !positive(value.lastProcessedItemId)) throw new InvalidCheckpoint();
    return value as unknown as CollectionCheckpoint;
  }
  if (value.state !== "bootstrap" || !keys(value, ["schemaVersion", "state", "targetMaxItemId", "feedIds", "nextFeedIndex", "nextLookbackId"], ["schemaVersion", "state", "targetMaxItemId", "feedIds", "nextFeedIndex"]) ||
    !positive(value.targetMaxItemId) || !Array.isArray(value.feedIds) || value.feedIds.length > 1900 || !Number.isSafeInteger(value.nextFeedIndex) || (value.nextFeedIndex as number) < 0 ||
    (value.nextLookbackId !== undefined && (!positive(value.nextLookbackId) || value.nextLookbackId > value.targetMaxItemId))) throw new InvalidCheckpoint();
  const feeds = value.feedIds as unknown[];
  if (feeds.some((id, index) => !positive(id) || (index > 0 && (feeds[index - 1] as number) >= (id as number))) || (value.nextFeedIndex as number) > feeds.length ||
    ((value.nextFeedIndex as number) === feeds.length && value.nextLookbackId === undefined)) throw new InvalidCheckpoint();
  return structuredClone(value) as unknown as CollectionCheckpoint;
}
export function decodeRefresh(raw: string | undefined): RefreshCheckpoint {
  const value = parse(raw); if (value === undefined) return { schemaVersion: 1 };
  if (value.schemaVersion !== 1 || !keys(value, ["schemaVersion", "afterStoryId"], ["schemaVersion"]) || (value.afterStoryId !== undefined && !positive(value.afterStoryId))) throw new InvalidCheckpoint();
  return structuredClone(value) as unknown as RefreshCheckpoint;
}
export function decodeAccount(raw: string | undefined, username: string): AccountCheckpoint {
  const value = parse(raw); if (value === undefined) return { schemaVersion: 1, username };
  if (value.schemaVersion !== 1 || !keys(value, ["schemaVersion", "username", "continuation"], ["schemaVersion", "username"]) || typeof value.username !== "string" || value.username === "" ||
    (value.continuation !== undefined && (typeof value.continuation !== "string" || value.continuation === ""))) throw new InvalidCheckpoint();
  return value.username === username ? structuredClone(value) as unknown as AccountCheckpoint : { schemaVersion: 1, username };
}
export const encodeCollection = (value: CollectionCheckpoint): string => JSON.stringify(value);
export const encodeRefresh = (value: RefreshCheckpoint): string => JSON.stringify(value);
export const encodeAccount = (value: AccountCheckpoint): string => JSON.stringify(value);
export function cursorSnapshot(values: Record<string, string | null>): string { return JSON.stringify(values); }
export function runTimestamp(value: IsoDateTime): IsoDateTime { return value; }
