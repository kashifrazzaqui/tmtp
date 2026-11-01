import { createHash } from "node:crypto";
import { HnItemSchema, IsoDateTimeSchema, StorySchema } from "@tmtp/domain";
import type { HnItem, Story } from "@tmtp/domain";
import { apiError } from "./errors.js";
import type { NormalizeStoryInput } from "./types.js";

function canonicalUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") return undefined;
    url.hash = "";
    return url.toString();
  } catch { return undefined; }
}
function invalidInput(): never { throw apiError("invalid-input", "normalize-story"); }
function optional<K extends "url" | "author" | "textHtml" | "score" | "descendants">(
  item: HnItem, previous: Story | undefined, tombstone: boolean, key: K,
): HnItem[K] | Story[K] | undefined {
  return item[key] ?? (tombstone ? previous?.[key] : undefined);
}
export function normalizeStory(input: NormalizeStoryInput): Story | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).some((key) => !["item", "observedAt", "previous"].includes(key))) invalidInput();
  let itemResult: ReturnType<typeof HnItemSchema.safeParse>;
  let observedResult: ReturnType<typeof IsoDateTimeSchema.safeParse>;
  let previousResult: ReturnType<typeof StorySchema.safeParse> | undefined;
  try {
    itemResult = HnItemSchema.safeParse(input.item);
    observedResult = IsoDateTimeSchema.safeParse(input.observedAt);
    previousResult = input.previous === undefined ? undefined : StorySchema.safeParse(input.previous);
  } catch (error) {
    if (error instanceof RangeError) invalidInput();
    throw error;
  }
  if (!itemResult.success || !observedResult.success || (previousResult !== undefined && !previousResult.success)) invalidInput();
  const item = structuredClone(itemResult.data);
  const observedAt = observedResult.data;
  const previous = previousResult?.success ? structuredClone(previousResult.data) : undefined;
  if (previous !== undefined && previous.id !== item.id) invalidInput();
  if (item.type !== "story" && item.type !== undefined) return undefined;
  const tombstone = item.deleted || item.dead;
  if (item.type === undefined && (previous === undefined || !tombstone)) return undefined;
  const title = item.title ?? (tombstone ? previous?.title : undefined);
  if (item.time !== undefined && (item.time * 1000 > 8_640_000_000_000_000 || !Number.isFinite(new Date(item.time * 1000).getTime()))) invalidInput();
  const publishedAt = item.time === undefined
    ? (tombstone ? previous?.publishedAt : undefined)
    : new Date(item.time * 1000).toISOString();
  if (title === undefined || publishedAt === undefined) return undefined;
  const url = optional(item, previous, tombstone, "url");
  const author = optional(item, previous, tombstone, "author");
  const textHtml = optional(item, previous, tombstone, "textHtml");
  const score = optional(item, previous, tombstone, "score");
  const descendants = optional(item, previous, tombstone, "descendants");
  const canonical = canonicalUrl(url);
  const contentVersion = `sha256:${createHash("sha256").update(JSON.stringify([
    "hn-story-content-v1", item.id, url ?? null, canonical ?? null, title, author ?? null, textHtml ?? null,
    publishedAt, item.deleted, item.dead,
  ]), "utf8").digest("hex")}`;
  const story: Story = {
    id: item.id, itemType: "story", ...(url === undefined ? {} : { url }), ...(canonical === undefined ? {} : { canonicalUrl: canonical }),
    title, ...(author === undefined ? {} : { author }), ...(textHtml === undefined ? {} : { textHtml }),
    ...(score === undefined ? {} : { score }), ...(descendants === undefined ? {} : { descendants }), publishedAt,
    firstSeenAt: previous?.firstSeenAt ?? observedAt, lastSeenAt: observedAt, contentVersion,
    raw: item, rawSchemaVersion: 1, deleted: item.deleted, dead: item.dead,
  };
  const parsed = StorySchema.safeParse(story);
  if (!parsed.success) invalidInput();
  return structuredClone(parsed.data);
}
