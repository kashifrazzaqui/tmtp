import { createHash } from "node:crypto";
import { articleContentVersion, RecommendationSchema } from "@tmtp/domain";
import type { Recommendation } from "@tmtp/domain";
import type { LlmCallAudit, LlmError, LlmErrorCategory } from "@tmtp/llm-interface";
import { llmContract, RecommendationError } from "./errors.js";
import { planBatches } from "./plan.js";
import type { PlannedBatch } from "./plan.js";
import { projectProfile, projectStory } from "./projection.js";
import type { ProjectedStory } from "./projection.js";
import { validateScoreInput, isObject } from "./validation.js";
import type { RecommendationBatch, RecommendationFailure, ScoreStoriesInput } from "./types.js";
import { INSTRUCTIONS, RECOMMENDATION_ID_VERSION, RECOMMENDATION_PROMPT_VERSION } from "./constants.js";

const CATEGORIES = new Set<LlmErrorCategory>(["invalid-request", "timeout", "rate-limit", "provider", "invalid-output", "cancelled"]);
const STATUSES = new Set(["success", "invalid-output", "provider-error", "timeout", "cancelled"]);
function isAudit(value: unknown): value is LlmCallAudit {
  if (!isObject(value) || typeof value.callId !== "string" || value.callId === "" || typeof value.purpose !== "string" ||
    !["recommendation", "connection-check"].includes(value.purpose) || typeof value.model !== "string" || typeof value.requestHash !== "string" ||
    typeof value.status !== "string" || !STATUSES.has(value.status) || !isObject(value.usage) || typeof value.usage.latencyMs !== "number" ||
    !Number.isFinite(value.usage.latencyMs) || value.usage.latencyMs < 0) return false;
  return true;
}
function isLlmError(value: unknown): value is LlmError {
  return value instanceof Error && isObject(value) && typeof value.category === "string" && CATEGORIES.has(value.category as LlmErrorCategory) &&
    typeof value.code === "string" && Array.isArray(value.attempts) && value.attempts.every(isAudit) && typeof value.retryable === "boolean";
}
function recommendationId(story: ProjectedStory, profileId: string, articleVersion: string, model: string): string {
  const canonical = JSON.stringify({
    idVersion: RECOMMENDATION_ID_VERSION, storyId: story.storyId, profileId, storyContentVersion: story.contentVersion,
    articleContentVersion: articleVersion, promptVersion: RECOMMENDATION_PROMPT_VERSION, model,
  });
  return `recommendation_${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
function assemble(
  batch: PlannedBatch, judgments: ReturnType<PlannedBatch["parseOutput"]>, callId: string,
  profileId: string, articleVersions: ReadonlyMap<number, string>, model: string, at: ScoreStoriesInput["at"], attempts: readonly LlmCallAudit[],
): Recommendation[] {
  const byId = new Map(batch.stories.map((story) => [story.storyId, story]));
  return judgments.map((judgment) => {
    const story = byId.get(judgment.storyId)!;
    const articleVersion = articleVersions.get(story.storyId)!;
    const recommendation: Recommendation = {
      id: recommendationId(story, profileId, articleVersion, model), storyId: story.storyId, profileId,
      storyContentVersion: story.contentVersion, articleContentVersion: articleVersion, promptVersion: RECOMMENDATION_PROMPT_VERSION,
      model, score: judgment.score === 0 ? 0 : judgment.score, rationale: judgment.rationale, evidence: judgment.evidence,
      evidenceSchemaVersion: 1, llmCallId: callId, createdAt: at,
    };
    if (!RecommendationSchema.safeParse(recommendation).success) llmContract(attempts);
    return recommendation;
  });
}
export async function scoreStories(options: ScoreStoriesInput): Promise<RecommendationBatch> {
  const input = validateScoreInput(options);
  if (input.signal?.aborted) return { recommendations: [], failures: [], attempts: [], completion: "cancelled" };
  const stories = [...input.stories].sort((a, b) => a.id - b.id).slice(0, input.policy.maxStoriesPerRun);
  const profileId = input.profile.id;
  const articles = new Map(input.articles.map((article) => [article.storyId, article]));
  const projected = stories.map((story) => projectStory(story, articles.get(story.id)));
  const articleVersions = new Map(projected.map((story) => [story.storyId, articleContentVersion(articles.get(story.storyId))]));
  const plan = planBatches(projectProfile(input.profile), projected, input.policy.batchSize, input.policy.maxPromptChars);
  const recommendations: Recommendation[] = [];
  const failures: RecommendationFailure[] = [];
  const attempts: LlmCallAudit[] = [];
  let completion: RecommendationBatch["completion"] = "complete";
  for (const item of plan) {
    if (input.signal?.aborted) { completion = "cancelled"; break; }
    if (item.kind === "failure") {
      failures.push({ storyId: item.storyId, category: "prompt-too-large", code: "prompt-too-large", retryable: false });
      continue;
    }
    try {
      const result = await input.llm.generate({
        purpose: "recommendation", model: input.model, instructions: INSTRUCTIONS,
        input: item.input, outputSchema: item.outputSchema, parseOutput: item.parseOutput,
        capturePayload: input.policy.capturePayloads, ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (!isObject(result) || !Array.isArray(result.attempts)) llmContract(attempts);
      for (const attempt of result.attempts) {
        if (!isAudit(attempt)) llmContract(attempts);
        attempts.push(attempt);
      }
      const final = result.attempts.at(-1);
      if (final === undefined || final.status !== "success") llmContract(attempts);
      let judgments: ReturnType<PlannedBatch["parseOutput"]>;
      try { judgments = item.parseOutput({ judgments: result.value }); }
      catch { llmContract(attempts); }
      recommendations.push(...assemble(item, judgments, final.callId, profileId, articleVersions, input.model, input.at, attempts));
      if (input.signal?.aborted) { completion = "cancelled"; break; }
    } catch (error) {
      if (isLlmError(error)) {
        attempts.push(...error.attempts);
        for (const storyId of item.storyIds) failures.push({ storyId, category: error.category, code: error.code, retryable: error.retryable });
        if (error.category === "cancelled" || input.signal?.aborted) { completion = "cancelled"; break; }
        continue;
      }
      if (error instanceof RecommendationError) throw error;
      llmContract(attempts);
    }
  }
  recommendations.sort((a, b) => a.storyId - b.storyId);
  failures.sort((a, b) => a.storyId - b.storyId);
  return { recommendations, failures, attempts, completion };
}
