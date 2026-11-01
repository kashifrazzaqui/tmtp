import { z } from "zod";
import type { JsonSchema } from "@tmtp/llm-interface";
import type { ProjectedProfile, ProjectedStory } from "./projection.js";

export class OutputRejected extends Error { constructor() { super("Output rejected."); } }
const finite = z.number().finite();
const evidenceSchema = z.strictObject({
  kind: z.enum(["explicit-rule", "activity", "story"]), label: z.string().min(1).max(120),
  value: z.union([z.string().min(1).max(200), finite]).optional(), sourceId: z.string().min(1).max(200).optional(),
}).superRefine((evidence, context) => {
  if (typeof evidence.value === "string" && (evidence.value.trim() !== evidence.value || evidence.value.trim() === "")) {
    context.addIssue({ code: "custom", message: "Invalid evidence value." });
  }
});
const judgmentSchema = z.strictObject({
  storyId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), score: finite.min(0).max(1),
  rationale: z.string().min(1).max(500), evidence: z.array(evidenceSchema).min(1).max(5),
});
export type ValidatedJudgment = z.infer<typeof judgmentSchema>;
export function outputSchema(storyIds: readonly number[]): JsonSchema {
  return {
    type: "object",
    properties: {
      judgments: {
        type: "array", minItems: storyIds.length, maxItems: storyIds.length,
        items: {
          type: "object",
          properties: {
            storyId: { type: "integer", enum: [...storyIds] }, score: { type: "number", minimum: 0, maximum: 1 },
            rationale: { type: "string", minLength: 1, maxLength: 500 },
            evidence: {
              type: "array", minItems: 1, maxItems: 5,
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["explicit-rule", "activity", "story"] },
                  label: { type: "string", minLength: 1, maxLength: 120 },
                  value: { anyOf: [{ type: "string", minLength: 1, maxLength: 200 }, { type: "number" }] } as unknown as JsonSchema,
                  sourceId: { type: "string", minLength: 1, maxLength: 200 },
                },
                required: ["kind", "label"], additionalProperties: false,
              },
            },
          },
          required: ["storyId", "score", "rationale", "evidence"], additionalProperties: false,
        },
      },
    },
    required: ["judgments"], additionalProperties: false,
  };
}
export function createJudgmentParser(profile: ProjectedProfile, stories: readonly ProjectedStory[]): (value: unknown) => ValidatedJudgment[] {
  const expected = stories.map((story) => story.storyId);
  const schema = z.strictObject({ judgments: z.array(judgmentSchema).length(expected.length) });
  const rules = new Set(profile.sourceRules.map((rule) => rule.id));
  const activityTopics = new Set(profile.interests.filter((interest) => interest.evidence.some((entry) => entry.kind !== "explicit-rule")).map((interest) => interest.topic));
  const byId = new Map(stories.map((story) => [story.storyId, story]));
  return (value: unknown): ValidatedJudgment[] => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new OutputRejected();
    const judgments = parsed.data.judgments;
    const ids = new Set<number>();
    for (const judgment of judgments) {
      if (ids.has(judgment.storyId) || !expected.includes(judgment.storyId)) throw new OutputRejected();
      ids.add(judgment.storyId);
      const story = byId.get(judgment.storyId)!;
      for (const evidence of judgment.evidence) {
        if (evidence.kind === "explicit-rule" && (evidence.sourceId === undefined || !rules.has(evidence.sourceId))) throw new OutputRejected();
        if (evidence.kind === "activity" && (evidence.sourceId === undefined || !activityTopics.has(evidence.sourceId))) throw new OutputRejected();
        if (evidence.kind === "story") {
          const storyPointer = evidence.sourceId === `story:${judgment.storyId}`;
          const articlePointer = story.article?.status === "ready" && story.article.contentHash !== null && story.article.contentHash !== "" && evidence.sourceId === `article:${story.article.contentHash}`;
          if (!storyPointer && !articlePointer) throw new OutputRejected();
        }
      }
      if (judgment.score === 0) judgment.score = 0;
    }
    if (ids.size !== expected.length) throw new OutputRejected();
    return judgments;
  };
}
