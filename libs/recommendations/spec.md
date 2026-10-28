# Recommendations Library Spec

## Purpose and responsibility
Produce versioned, evidence-backed story judgments through `llm-interface` and turn them into complete-queue rankings with deterministic exploration. It does not persist results or contact a provider directly.

## Public interface / API surface
```ts
export interface RecommendationBatch {
  recommendations: import("@tmtp/domain").Recommendation[];
  failures: { storyId: number; error: string }[];
  attempts: import("@tmtp/llm-interface").LlmCallAudit[];
}

export interface RecommendationPolicy {
  batchSize: number;
  maxStoriesPerRun: number;
  maxPromptChars: number;
  explorationRatio: number;
  capturePayloads: boolean;
}

export function scoreStories(options: {
  stories: import("@tmtp/domain").Story[];
  articles: import("@tmtp/domain").Article[];
  profile: import("@tmtp/domain").InterestProfile;
  llm: import("@tmtp/llm-interface").LlmPort;
  model: string;
  policy: RecommendationPolicy;
}): Promise<RecommendationBatch>;

export function buildQueue(options: {
  stories: import("@tmtp/domain").Story[];
  recommendations: import("@tmtp/domain").Recommendation[];
  evaluationByStory: Record<number, import("@tmtp/domain").EvaluationState>;
  profile: import("@tmtp/domain").InterestProfile;
  policy: RecommendationPolicy;
}): import("@tmtp/domain").QueueEntry[];
```

Prompts include only configured story/profile projections. Each output records story content, profile, prompt, and model versions. All attempt audits are returned for persistence; each recommendation links to its successful call ID. Rationales are short user-facing evidence summaries, not hidden chain-of-thought. Failures remain pending/failed queue entries, never implicit rejections.

## Internal subcomponents
- Bounded story/profile projection and prompt versions.
- Batched structured judgments and Zod output validation.
- Evidence/rationale normalization and per-attempt LLM audit records.
- Queue composition through `queue`, including deterministic exploration.

## Dependencies on other libs
- `domain`
- `interests`
- `llm-interface`
- `queue`

## New build or OSS wrapper
New TypeScript implementation; provider access only through `llm-interface`.

## Hosted by
`personalization` jobs and `reader-app` explanation queries in `services/personal-reader`.

## Configuration
- `recommendations.batch_size` — **optional**, default `10`.
- `recommendations.max_stories_per_run` — **optional**, default `50`; work-batch limit, not queue retention.
- `recommendations.max_prompt_chars` — **optional**, default `60000`.
- `recommendations.exploration_ratio` — **optional**, default `0.1`, inclusive range `0`–`0.5`.
