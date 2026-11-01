import type { Article, EvaluationState, InterestProfile, IsoDateTime, QueueEntry, Recommendation, Story, StoryId } from "@tmtp/domain";
import type { LlmCallAudit, LlmErrorCategory, LlmPort } from "@tmtp/llm-interface";
export type RecommendationCompletion = "complete" | "cancelled";
export interface RecommendationFailure { storyId: StoryId; category: LlmErrorCategory | "prompt-too-large"; code: string; retryable: boolean; }
export interface RecommendationBatch { recommendations: Recommendation[]; failures: RecommendationFailure[]; attempts: LlmCallAudit[]; completion: RecommendationCompletion; }
export interface RecommendationPolicy { batchSize: number; maxStoriesPerRun: number; maxPromptChars: number; explorationRatio: number; capturePayloads: boolean; }
export interface ScoreStoriesInput { stories: readonly Story[]; articles: readonly Article[]; profile: InterestProfile; llm: LlmPort; model: string; policy: RecommendationPolicy; at: IsoDateTime; signal?: AbortSignal; }
export interface BuildQueueInput {
  stories: readonly Story[]; articles: readonly Article[]; recommendations: readonly Recommendation[];
  evaluationByStory: Readonly<Record<number, EvaluationState>>; profile: InterestProfile; existingEntries?: readonly QueueEntry[];
  blacklistedStoryIds: readonly StoryId[]; explorationSeed?: string; policy: RecommendationPolicy; at: IsoDateTime;
}
export type RecommendationErrorCode = "invalid-input" | "llm-contract";
