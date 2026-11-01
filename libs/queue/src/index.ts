import { createHash } from "node:crypto";
import {
  ArticleSchema,
  articleContentVersion,
  EvaluationStateSchema,
  InterestProfileSchema,
  IsoDateTimeSchema,
  QueueEntrySchema,
  QueueStateSchema,
  RecommendationSchema,
  StoryIdSchema,
  StorySchema,
} from "@tmtp/domain";
import type {
  Article,
  EvaluationState,
  InterestProfile,
  IsoDateTime,
  QueueEntry,
  QueueState,
  Recommendation,
  Story,
  StoryId,
} from "@tmtp/domain";
import { QueueError, queueError } from "./error.js";
import { decodeQueueCursor, encodeQueueCursor } from "./cursor.js";
import type { QueueCursorPosition } from "./cursor.js";

export const QUEUE_RANK_ALGORITHM_VERSION = "queue-rank/1" as const;
export const QUEUE_BOOTSTRAP_RANK_VERSION = "qb1.initial" as const;
export { QUEUE_CURSOR_VERSION, decodeQueueCursor, encodeQueueCursor } from "./cursor.js";
export type { QueueCursorPosition } from "./cursor.js";
export { QueueError } from "./error.js";
export type { QueueErrorCode } from "./error.js";

export interface RankQueueInput {
  stories: readonly Story[];
  articles: readonly Article[];
  recommendations: readonly Recommendation[];
  evaluationByStory: Readonly<Record<number, EvaluationState>>;
  profile: InterestProfile;
  existingEntries?: readonly QueueEntry[];
  blacklistedStoryIds: readonly StoryId[];
  explorationRatio: number;
  explorationSeed?: string;
  at: IsoDateTime;
}
export interface QueuePage {
  entries: QueueEntry[];
  nextCursor?: string;
}

const SECTION: Record<EvaluationState, number> = { scored: 0, pending: 1, failed: 2 };
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []): boolean => {
  const keys = Object.keys(value);
  return keys.every((key) => required.includes(key) || optional.includes(key)) && required.every((key) => Object.hasOwn(value, key));
};
function invalid(field?: string): never {
  throw queueError("invalid-input", field);
}
function domainEntry(value: QueueEntry): QueueEntry {
  if (!QueueEntrySchema.safeParse(value).success) invalid("entries");
  return value;
}

interface ProjectedStory {
  story: Story;
  active?: Recommendation;
  evaluationState: EvaluationState;
  visibilityState: "visible" | "blacklisted";
  kind: "match" | "exploration";
  rankPosition?: number;
}

export function rankQueue(input: RankQueueInput): QueueEntry[] {
  if (!isObject(input) || !exactKeys(input, [
    "stories", "articles", "recommendations", "evaluationByStory", "profile",
    "blacklistedStoryIds", "explorationRatio", "at",
  ], ["existingEntries", "explorationSeed"])) invalid("input");
  if (!Array.isArray(input.stories) || !Array.isArray(input.articles) || !Array.isArray(input.recommendations)) invalid("collections");
  if (!Array.isArray(input.blacklistedStoryIds) || (input.existingEntries !== undefined && !Array.isArray(input.existingEntries))) invalid("collections");
  if (!InterestProfileSchema.safeParse(input.profile).success || !IsoDateTimeSchema.safeParse(input.at).success) invalid("profile");
  if (typeof input.explorationRatio !== "number" || !Number.isFinite(input.explorationRatio) || input.explorationRatio < 0 || input.explorationRatio > 0.5) invalid("explorationRatio");
  if (input.explorationSeed !== undefined && (typeof input.explorationSeed !== "string" || input.explorationSeed === "")) invalid("explorationSeed");
  if (!isObject(input.evaluationByStory)) invalid("evaluationByStory");
  const ratio = input.explorationRatio === 0 ? 0 : input.explorationRatio;
  const seed = input.explorationSeed ?? input.profile.id;

  const stories = new Map<number, Story>();
  for (const story of input.stories) {
    if (!StorySchema.safeParse(story).success) invalid("stories");
    if (stories.has(story.id)) throw queueError("duplicate-story", "stories", story.id);
    stories.set(story.id, story);
  }
  const articles = new Map<number, Article>();
  for (const article of input.articles) {
    if (!ArticleSchema.safeParse(article).success) invalid("articles");
    if (articles.has(article.storyId)) throw queueError("duplicate-article", "articles", article.storyId);
    if (!stories.has(article.storyId)) throw queueError("unknown-story", "articles", article.storyId);
    articles.set(article.storyId, article);
  }
  const existing = new Map<number, QueueEntry>();
  for (const entry of input.existingEntries ?? []) {
    domainEntry(entry);
    if (existing.has(entry.storyId)) throw queueError("duplicate-entry", "existingEntries", entry.storyId);
    existing.set(entry.storyId, entry);
  }
  const blacklisted = new Set<number>();
  for (const storyId of input.blacklistedStoryIds) {
    if (!StoryIdSchema.safeParse(storyId).success) invalid("blacklistedStoryIds");
    if (!stories.has(storyId)) throw queueError("unknown-story", "blacklistedStoryIds", storyId);
    blacklisted.add(storyId);
  }

  const activeByStory = new Map<number, Recommendation[]>();
  const recommendationIds = new Set<string>();
  for (const recommendation of input.recommendations) {
    if (!RecommendationSchema.safeParse(recommendation).success) invalid("recommendations");
    if (recommendationIds.has(recommendation.id)) invalid("recommendations");
    recommendationIds.add(recommendation.id);
    if (!stories.has(recommendation.storyId)) throw queueError("unknown-story", "recommendations", recommendation.storyId);
    const story = stories.get(recommendation.storyId)!;
    if (
      recommendation.profileId === input.profile.id &&
      recommendation.storyContentVersion === story.contentVersion &&
      recommendation.articleContentVersion === articleContentVersion(articles.get(story.id))
    ) {
      const active = activeByStory.get(story.id) ?? [];
      active.push(recommendation);
      activeByStory.set(story.id, active);
    }
  }
  const evaluations = new Map<number, EvaluationState>();
  for (const key of Object.keys(input.evaluationByStory)) {
    if (!/^[1-9]\d*$/.test(key)) invalid("evaluationByStory");
    const storyId = Number(key);
    if (!StoryIdSchema.safeParse(storyId).success) invalid("evaluationByStory");
    if (!stories.has(storyId)) throw queueError("unknown-story", "evaluationByStory", storyId);
    const state = input.evaluationByStory[storyId];
    if (state === undefined || !EvaluationStateSchema.safeParse(state).success) invalid("evaluationByStory");
    evaluations.set(storyId, state);
  }

  const projected: ProjectedStory[] = [];
  for (const story of stories.values()) {
    const active = activeByStory.get(story.id) ?? [];
    if (active.length > 1) throw queueError("ambiguous-recommendation", "recommendations", story.id);
    const recommendation = active[0];
    const evaluationState = evaluations.get(story.id) ?? (recommendation === undefined ? "pending" : "scored");
    if (evaluationState === "scored" && recommendation === undefined) throw queueError("missing-recommendation", "evaluationByStory", story.id);
    if (evaluationState !== "scored" && recommendation !== undefined) throw queueError("evaluation-conflict", "evaluationByStory", story.id);
    const prior = existing.get(story.id);
    if (prior !== undefined && (Date.parse(input.at) < Date.parse(prior.updatedAt) || Date.parse(input.at) < Date.parse(prior.queuedAt))) invalid("at");
    projected.push({
      story,
      ...(recommendation === undefined ? {} : { active: recommendation }),
      evaluationState,
      visibilityState: blacklisted.has(story.id) ? "blacklisted" : "visible",
      kind: "match",
    });
  }

  const scored = projected.filter((entry) => entry.evaluationState === "scored");
  scored.sort((left, right) => right.active!.score - left.active!.score || left.story.id - right.story.id);
  const visible = scored.filter((entry) => entry.visibilityState === "visible");
  const pool = visible.slice(Math.ceil(visible.length / 2));
  const explorationCount = Math.min(Math.floor(visible.length * ratio), pool.length);
  const exploration = pool.map((entry) => ({
    entry,
    digest: hash(JSON.stringify(["queue-exploration/1", seed, input.profile.id, entry.story.id])),
  })).sort((left, right) => left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : left.entry.story.id - right.entry.story.id)
    .slice(0, explorationCount);
  for (const selected of exploration) selected.entry.kind = "exploration";
  const selectedIds = new Set(exploration.map((selected) => selected.entry.story.id));
  const matches = scored.filter((entry) => !selectedIds.has(entry.story.id));
  const explorationPositions = new Map(exploration.map((selected, index) => [
    Math.floor((index + 1) * (scored.length + 1) / (exploration.length + 1)), selected.entry,
  ]));
  const merged: ProjectedStory[] = [];
  let matchIndex = 0;
  for (let position = 1; position <= scored.length; position += 1) {
    const selected = explorationPositions.get(position);
    merged.push(selected ?? matches[matchIndex++]!);
    merged[position - 1]!.rankPosition = position;
  }
  const ordered = [
    ...merged,
    ...projected.filter((entry) => entry.evaluationState === "pending").sort((left, right) => left.story.id - right.story.id),
    ...projected.filter((entry) => entry.evaluationState === "failed").sort((left, right) => left.story.id - right.story.id),
  ];
  const byId = new Map(projected.map((entry) => [entry.story.id, entry]));
  const rankVersion = `qr1.${hash(JSON.stringify({
    algorithm: QUEUE_RANK_ALGORITHM_VERSION,
    profileId: input.profile.id,
    explorationRatio: ratio,
    explorationSeed: seed,
    blacklistedStoryIds: [...blacklisted].sort((left, right) => left - right),
    stories: [...stories.values()].sort((left, right) => left.id - right.id).map((story) => {
      const entry = byId.get(story.id)!;
      return {
        storyId: story.id,
        contentVersion: story.contentVersion,
        evaluationState: entry.evaluationState,
        recommendationId: entry.active?.id ?? null,
        kind: entry.kind,
        rankScore: entry.active?.score ?? null,
      };
    }),
  }))}`;

  return ordered.map((entry) => {
    const prior = existing.get(entry.story.id);
    const scoredEntry = entry.evaluationState === "scored";
    return {
      storyId: entry.story.id,
      state: prior?.state ?? "unread",
      evaluationState: entry.evaluationState,
      visibilityState: entry.visibilityState,
      kind: entry.kind,
      ...(scoredEntry ? {
        recommendationId: entry.active!.id,
        rankScore: entry.active!.score,
        rankPosition: entry.rankPosition!,
      } : {}),
      rankVersion,
      ...(prior?.evaluationState === "failed" && entry.evaluationState === "failed" && prior.lastError !== undefined
        ? { lastError: prior.lastError }
        : {}),
      queuedAt: prior?.queuedAt ?? input.at,
      updatedAt: input.at,
    };
  });
}

export function transitionQueueState(entry: QueueEntry, next: QueueState, at: IsoDateTime): QueueEntry {
  domainEntry(entry);
  if (!QueueStateSchema.safeParse(next).success || !IsoDateTimeSchema.safeParse(at).success) invalid("at");
  if (Date.parse(at) < Date.parse(entry.updatedAt)) invalid("at");
  if (entry.state === next) return { ...entry };
  const rejected =
    (entry.state === "dismissed" && (next === "reading" || next === "read")) ||
    (entry.state === "archived" && (next === "reading" || next === "read" || next === "dismissed"));
  if (rejected) throw new QueueError("invalid-transition", "Queue reading-state transition is invalid.", { from: entry.state, to: next });
  return { ...entry, state: next, updatedAt: at };
}

function compareEntries(left: QueueEntry, right: QueueEntry): number {
  return SECTION[left.evaluationState] - SECTION[right.evaluationState] ||
    (left.rankPosition ?? 0) - (right.rankPosition ?? 0) || left.storyId - right.storyId;
}
function comparePosition(entry: QueueEntry, position: QueueCursorPosition): number {
  return SECTION[entry.evaluationState] - SECTION[position.evaluationState] ||
    (entry.rankPosition ?? 0) - (position.rankPosition ?? 0) || entry.storyId - position.storyId;
}

export function paginateQueue(entries: readonly QueueEntry[], cursor: string | undefined, pageSize: number): QueuePage {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw queueError("invalid-page-size", "pageSize");
  if (!Array.isArray(entries)) invalid("entries");
  const ids = new Set<number>();
  let rankVersion: string | undefined;
  for (const entry of entries) {
    domainEntry(entry);
    if (ids.has(entry.storyId)) throw queueError("duplicate-entry", "entries", entry.storyId);
    ids.add(entry.storyId);
    if (rankVersion === undefined) rankVersion = entry.rankVersion;
    if (entry.rankVersion !== rankVersion || (entry.evaluationState === "scored" && (!Number.isSafeInteger(entry.rankPosition) || entry.rankPosition! < 1)) || (entry.evaluationState !== "scored" && entry.rankPosition !== undefined)) {
      invalid("entries");
    }
  }
  const position = cursor === undefined ? undefined : decodeQueueCursor(cursor);
  if (entries.length === 0) return { entries: [] };
  if (position !== undefined && position.rankVersion !== rankVersion) {
    throw queueError("cursor-version-mismatch", "cursor");
  }
  const states = new Set(entries.map((entry) => entry.evaluationState));
  if (position !== undefined && states.size === 1 && !states.has(position.evaluationState)) {
    throw queueError("cursor-section-mismatch", "cursor");
  }
  const sorted = entries.map((entry) => ({ ...entry })).sort(compareEntries);
  const remaining = position === undefined ? sorted : sorted.filter((entry) => comparePosition(entry, position) > 0);
  const page = remaining.slice(0, pageSize);
  if (remaining.length <= pageSize || page.length === 0) return { entries: page };
  const last = page.at(-1)!;
  return {
    entries: page,
    nextCursor: encodeQueueCursor({
      rankVersion: last.rankVersion,
      evaluationState: last.evaluationState,
      ...(last.evaluationState === "scored" ? { rankPosition: last.rankPosition! } : {}),
      storyId: last.storyId,
    }),
  };
}
