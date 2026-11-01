import { ArticleSchema, InterestProfileSchema, IsoDateTimeSchema, StorySchema } from "@tmtp/domain";
import type { Article, Story } from "@tmtp/domain";
import { invalidInput } from "./errors.js";
import type { RecommendationPolicy, ScoreStoriesInput } from "./types.js";
export function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => required.includes(key) || optional.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}
export function validatePolicy(value: unknown): RecommendationPolicy {
  if (!isObject(value) || !exactKeys(value, ["batchSize", "maxStoriesPerRun", "maxPromptChars", "explorationRatio", "capturePayloads"])) invalidInput("policy");
  const policy = value as unknown as RecommendationPolicy;
  if (!Number.isSafeInteger(policy.batchSize) || policy.batchSize < 1) invalidInput("policy.batchSize");
  if (!Number.isSafeInteger(policy.maxStoriesPerRun) || policy.maxStoriesPerRun < 0) invalidInput("policy.maxStoriesPerRun");
  if (!Number.isSafeInteger(policy.maxPromptChars) || policy.maxPromptChars < 1) invalidInput("policy.maxPromptChars");
  if (typeof policy.explorationRatio !== "number" || !Number.isFinite(policy.explorationRatio) || policy.explorationRatio < 0 || policy.explorationRatio > 0.5) invalidInput("policy.explorationRatio");
  if (typeof policy.capturePayloads !== "boolean") invalidInput("policy.capturePayloads");
  return { ...policy, explorationRatio: policy.explorationRatio === 0 ? 0 : policy.explorationRatio };
}
function domainValid(parse: () => { success: boolean }): boolean {
  try { return parse().success; } catch (error) { if (error instanceof RangeError) return false; throw error; }
}
export interface ValidatedScoreInput extends ScoreStoriesInput { stories: readonly Story[]; articles: readonly Article[]; policy: RecommendationPolicy; }
export function validateScoreInput(input: ScoreStoriesInput): ValidatedScoreInput {
  if (!isObject(input) || !exactKeys(input, ["stories", "articles", "profile", "llm", "model", "policy", "at"], ["signal"])) invalidInput("input");
  if (!Array.isArray(input.stories) || !Array.isArray(input.articles)) invalidInput("collections");
  if (!domainValid(() => InterestProfileSchema.safeParse(input.profile))) invalidInput("profile");
  if (!domainValid(() => IsoDateTimeSchema.safeParse(input.at))) invalidInput("at");
  if (input.llm === null || typeof input.llm !== "object" || typeof input.llm.generate !== "function") invalidInput("llm");
  if (typeof input.model !== "string" || input.model.length === 0 || input.model.trim() !== input.model) invalidInput("model");
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) invalidInput("signal");
  const policy = validatePolicy(input.policy);
  const storyIds = new Set<number>();
  for (const story of input.stories) {
    if (!domainValid(() => StorySchema.safeParse(story))) invalidInput("stories");
    if (storyIds.has(story.id)) invalidInput("stories");
    storyIds.add(story.id);
  }
  const articleIds = new Set<number>();
  for (const article of input.articles) {
    if (!domainValid(() => ArticleSchema.safeParse(article))) invalidInput("articles");
    if (articleIds.has(article.storyId) || !storyIds.has(article.storyId)) invalidInput("articles");
    articleIds.add(article.storyId);
  }
  return { ...input, policy };
}
