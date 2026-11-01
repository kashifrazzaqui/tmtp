import { articleContentVersion } from "@tmtp/domain";
import type { Article, InterestProfile, Recommendation, Story } from "@tmtp/domain";
import { RecommendationError, scoreStories, RECOMMENDATION_PROMPT_VERSION } from "@tmtp/recommendations";
import type { RecommendationBatch, RecommendationFailure } from "@tmtp/recommendations";
import { persistRecommendationErrorAudits, writeAudits } from "./audit-writer.js";
import { PersonalizationError } from "./errors.js";
import type { BuiltProfile } from "./profile-builder.js";
import { projectCompleteQueue } from "./projection.js";
import { notBefore, wallNow } from "./time.js";
import type { PersonalizationOptions, ScorePendingSummary } from "./types.js";
import { validateAudits } from "./validation.js";

interface Fingerprint { storyContentVersion: string; articleContentVersion: string; }
interface ScorePlan {
  stories: Story[];
  articles: Article[];
  fingerprints: ReadonlyMap<number, Fingerprint>;
}

function planScoring(options: PersonalizationOptions, profile: InterestProfile): ScorePlan {
  return options.store.transaction((): ScorePlan => {
    const stories = options.recommendationPolicy.maxStoriesPerRun === 0 ? [] : options.store.stories.needingScoring({
      profileId: profile.id,
      promptVersion: RECOMMENDATION_PROMPT_VERSION,
      model: options.model,
      limit: options.recommendationPolicy.maxStoriesPerRun,
    });
    const articles = options.store.articles.byStoryIds(stories.map((story) => story.id));
    const articlesByStory = new Map(articles.map((article) => [article.storyId, article]));
    const fingerprints = new Map(stories.map((story) => [story.id, {
      storyContentVersion: story.contentVersion,
      articleContentVersion: articleContentVersion(articlesByStory.get(story.id)),
    }]));
    return { stories, articles, fingerprints };
  });
}

function judgmentContent(recommendation: Recommendation): string {
  return JSON.stringify({
    id: recommendation.id,
    storyId: recommendation.storyId,
    profileId: recommendation.profileId,
    storyContentVersion: recommendation.storyContentVersion,
    articleContentVersion: recommendation.articleContentVersion,
    promptVersion: recommendation.promptVersion,
    model: recommendation.model,
    score: recommendation.score,
    rationale: recommendation.rationale,
    evidence: recommendation.evidence,
    evidenceSchemaVersion: recommendation.evidenceSchemaVersion,
  });
}

function writeJudgments(options: PersonalizationOptions, recommendations: readonly Recommendation[]): void {
  const insert: Recommendation[] = [];
  const ids = new Set<string>();
  for (const recommendation of recommendations) {
    if (ids.has(recommendation.id)) throw new PersonalizationError("recommendation-conflict");
    ids.add(recommendation.id);
    const existing = options.store.recommendations.byId(recommendation.id);
    if (existing !== undefined) {
      if (judgmentContent(existing) !== judgmentContent(recommendation)) throw new PersonalizationError("recommendation-conflict");
      continue;
    }
    if (recommendation.llmCallId === undefined || options.store.llmCalls.byId(recommendation.llmCallId)?.status !== "success") {
      throw new PersonalizationError("recommendation-conflict");
    }
    insert.push(recommendation);
  }
  if (insert.length > 0) options.store.recommendations.insertImmutable(insert);
}

const SAFE_FAILURE_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function failureText(failure: RecommendationFailure): string {
  const code = failure.code.length <= 192 && SAFE_FAILURE_CODE.test(failure.code) ? failure.code : "invalid-code";
  return `recommendation:${failure.category}:${code}`;
}

function writeCurrentFailures(
  options: PersonalizationOptions,
  batch: RecommendationBatch,
  plan: ScorePlan,
  observedAt: string,
): Map<number, RecommendationFailure> {
  const current = new Map<number, RecommendationFailure>();
  for (const failure of batch.failures) {
    const fingerprint = plan.fingerprints.get(failure.storyId);
    if (fingerprint === undefined) continue;
    const story = options.store.stories.byId(failure.storyId);
    const article = options.store.articles.byStoryId(failure.storyId);
    if (story?.contentVersion !== fingerprint.storyContentVersion || articleContentVersion(article) !== fingerprint.articleContentVersion) continue;
    current.set(failure.storyId, failure);
  }
  for (const [storyId, failure] of current) {
    const entry = options.store.queue.byStoryId(storyId);
    if (entry === undefined) continue;
    const at = notBefore(observedAt, [entry.updatedAt, entry.queuedAt]);
    options.store.queue.markEvaluation({
      storyId,
      evaluationState: "failed",
      rankVersion: entry.rankVersion,
      lastError: failureText(failure),
      at,
    });
  }
  return current;
}

export async function executeScoring(
  options: PersonalizationOptions,
  selected: BuiltProfile,
  signal: AbortSignal | undefined,
): Promise<ScorePendingSummary> {
  const plan = planScoring(options, selected.profile);
  const scoreAt = wallNow(options.clock);
  let batch: RecommendationBatch;
  try {
    batch = await scoreStories({
      stories: plan.stories,
      articles: plan.articles,
      profile: selected.profile,
      llm: options.llm,
      model: options.model,
      policy: options.recommendationPolicy,
      at: scoreAt,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof RecommendationError) persistRecommendationErrorAudits(options, error.attempts);
    throw error;
  }
  validateAudits(batch.attempts, "attempts");
  const observedAt = wallNow(options.clock);
  return options.store.transaction((): ScorePendingSummary => {
    writeAudits(options.store, batch.attempts, observedAt);
    writeJudgments(options, batch.recommendations);
    const freshFailures = writeCurrentFailures(options, batch, plan, observedAt);
    const projection = projectCompleteQueue(options, {
      profile: selected.profile,
      profileChanged: selected.changed,
      freshFailures,
      observedAt,
    });
    const activeReturnedIds = new Set(projection.entries.filter((entry) => entry.evaluationState === "scored")
      .map((entry) => entry.recommendationId));
    const scored = batch.recommendations.filter((recommendation) => activeReturnedIds.has(recommendation.id)).length;
    const retryableFailed = [...freshFailures.values()].filter((failure) => failure.retryable).length;
    return {
      completion: batch.completion,
      scored,
      failed: freshFailures.size,
      retryableFailed,
      queued: projection.projected,
      audits: batch.attempts.length,
    };
  });
}

export function cancelledScoreSummary(): ScorePendingSummary {
  return { completion: "cancelled", scored: 0, failed: 0, retryableFailed: 0, queued: 0, audits: 0 };
}
