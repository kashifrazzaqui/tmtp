import { rankQueue } from "@tmtp/queue";
import { invalidInput } from "./errors.js";
import { scoreStories } from "./score.js";
import { exactKeys, isObject, validatePolicy } from "./validation.js";
import type { BuildQueueInput } from "./types.js";

export { RECOMMENDATION_PROMPT_VERSION, RECOMMENDATION_INPUT_SCHEMA_VERSION, RECOMMENDATION_OUTPUT_SCHEMA_VERSION, RECOMMENDATION_ID_VERSION } from "./constants.js";
export { RecommendationError } from "./errors.js";
export { scoreStories } from "./score.js";
export type { RecommendationCompletion, RecommendationFailure, RecommendationBatch, RecommendationPolicy, ScoreStoriesInput, BuildQueueInput, RecommendationErrorCode } from "./types.js";

export function buildQueue(options: BuildQueueInput) {
  if (!isObject(options) || !exactKeys(options, ["stories", "articles", "recommendations", "evaluationByStory", "profile", "blacklistedStoryIds", "policy", "at"], ["existingEntries", "explorationSeed"])) {
    invalidInput("input");
  }
  const policy = validatePolicy(options.policy);
  return rankQueue({
    stories: options.stories, articles: options.articles, recommendations: options.recommendations,
    evaluationByStory: options.evaluationByStory, profile: options.profile,
    ...(options.existingEntries === undefined ? {} : { existingEntries: options.existingEntries }),
    blacklistedStoryIds: options.blacklistedStoryIds, explorationRatio: policy.explorationRatio,
    ...(options.explorationSeed === undefined ? {} : { explorationSeed: options.explorationSeed }), at: options.at,
  });
}
