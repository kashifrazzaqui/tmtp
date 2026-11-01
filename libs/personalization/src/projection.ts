import { articleContentVersion } from "@tmtp/domain";
import type { Article, EvaluationState, InterestProfile, QueueEntry, Recommendation, Story } from "@tmtp/domain";
import { isBlacklisted } from "@tmtp/interests";
import { buildQueue, RECOMMENDATION_PROMPT_VERSION } from "@tmtp/recommendations";
import type { RecommendationFailure } from "@tmtp/recommendations";
import { notBefore, wallNow } from "./time.js";
import type { PersonalizationOptions, QueueProjectionSummary } from "./types.js";

export interface ProjectionRequest {
  profile: InterestProfile;
  profileChanged: boolean;
  freshFailures?: ReadonlyMap<number, RecommendationFailure>;
  observedAt?: string;
}
export interface ProjectionResult extends QueueProjectionSummary { entries: QueueEntry[]; }

function chunks<T>(values: readonly T[], size: number, read: (chunk: T[]) => void): void {
  for (let start = 0; start < values.length; start += size) read(values.slice(start, start + size));
}

export function projectCompleteQueue(options: PersonalizationOptions, request: ProjectionRequest): ProjectionResult {
  const stories: Story[] = [];
  let afterStoryId: number | undefined;
  while (true) {
    const page = options.store.stories.forQueueProjection(afterStoryId, options.queueSyncBatchSize);
    stories.push(...page);
    if (page.length < options.queueSyncBatchSize) break;
    afterStoryId = page.at(-1)!.id;
  }
  const storyIds = stories.map((story) => story.id);
  const articles: Article[] = [];
  chunks(storyIds, options.queueSyncBatchSize, (ids) => { articles.push(...options.store.articles.byStoryIds(ids)); });
  const recommendations: Recommendation[] = [];
  chunks(storyIds, options.queueSyncBatchSize, (ids) => {
    recommendations.push(...options.store.recommendations.currentForStories({
      profileId: request.profile.id,
      promptVersion: RECOMMENDATION_PROMPT_VERSION,
      model: options.model,
      storyIds: ids,
    }));
  });
  const existingEntries: QueueEntry[] = [];
  afterStoryId = undefined;
  while (true) {
    const page = options.store.queue.forReprojection(afterStoryId, options.queueSyncBatchSize);
    existingEntries.push(...page);
    if (page.length < options.queueSyncBatchSize) break;
    afterStoryId = page.at(-1)!.storyId;
  }

  const articlesByStory = new Map(articles.map((article) => [article.storyId, article]));
  const storiesById = new Map(stories.map((story) => [story.id, story]));
  const active = new Map<number, Recommendation>();
  for (const recommendation of recommendations) {
    const story = storiesById.get(recommendation.storyId)!;
    if (recommendation.profileId === request.profile.id && recommendation.promptVersion === RECOMMENDATION_PROMPT_VERSION &&
      recommendation.model === options.model && recommendation.storyContentVersion === story.contentVersion &&
      recommendation.articleContentVersion === articleContentVersion(articlesByStory.get(story.id))) {
      active.set(story.id, recommendation);
    }
  }
  const existingByStory = new Map(existingEntries.map((entry) => [entry.storyId, entry]));
  const evaluationByStory: Record<number, EvaluationState> = {};
  const blacklistedStoryIds: number[] = [];
  for (const story of stories) {
    if (isBlacklisted(story, request.profile)) blacklistedStoryIds.push(story.id);
    const hasActive = active.has(story.id);
    const freshFailure = request.freshFailures?.has(story.id) ?? false;
    const priorFailed = !request.profileChanged && existingByStory.get(story.id)?.evaluationState === "failed";
    evaluationByStory[story.id] = hasActive ? "scored" : freshFailure || priorFailed ? "failed" : "pending";
  }
  const at = notBefore(request.observedAt ?? wallNow(options.clock), existingEntries.flatMap((entry) => [entry.updatedAt, entry.queuedAt]));
  const entries = buildQueue({
    stories,
    articles,
    recommendations,
    evaluationByStory,
    profile: request.profile,
    existingEntries,
    blacklistedStoryIds,
    policy: options.recommendationPolicy,
    at,
  });
  chunks(entries, options.queueSyncBatchSize, (chunk) => { options.store.queue.upsertRankingPreservingState(chunk); });
  const rankVersion = entries[0]?.rankVersion;
  options.store.queue.setProjection({
    profileId: request.profile.id,
    ...(rankVersion === undefined ? {} : { rankVersion }),
    projectedAt: at,
  });
  return {
    projected: entries.length,
    complete: true,
    profileId: request.profile.id,
    ...(rankVersion === undefined ? {} : { rankVersion }),
    entries,
  };
}
