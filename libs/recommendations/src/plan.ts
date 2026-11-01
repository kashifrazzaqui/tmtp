import type { JsonSchema } from "@tmtp/llm-interface";
import { INSTRUCTIONS } from "./constants.js";
import { createJudgmentParser, outputSchema } from "./judgments.js";
import type { ValidatedJudgment } from "./judgments.js";
import { projectInput } from "./projection.js";
import type { ProjectedProfile, ProjectedStory, RecommendationInput } from "./projection.js";

export interface PlannedBatch {
  kind: "batch"; storyIds: number[]; stories: ProjectedStory[]; input: RecommendationInput; outputSchema: JsonSchema;
  parseOutput: (value: unknown) => ValidatedJudgment[];
}
export interface PlannedFailure { kind: "failure"; storyId: number; }
export type PlannedItem = PlannedBatch | PlannedFailure;
export function canonicalJson(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") {
      const source = input as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) output[key] = canonical(source[key]);
      return output;
    }
    return input;
  };
  return JSON.stringify(canonical(value));
}
function promptSize(input: RecommendationInput, schema: JsonSchema): number {
  const user = `Input JSON:\n${canonicalJson(input)}\n\nReturn only one JSON object that conforms to this JSON Schema:\n${canonicalJson(schema)}`;
  return INSTRUCTIONS.length + user.length;
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
export function planBatches(profile: ProjectedProfile, stories: readonly ProjectedStory[], batchSize: number, maxPromptChars: number): PlannedItem[] {
  const plan: PlannedItem[] = [];
  let offset = 0;
  while (offset < stories.length) {
    let selected: { size: number; input: RecommendationInput; schema: JsonSchema } | undefined;
    const maximum = Math.min(batchSize, stories.length - offset);
    for (let size = maximum; size >= 1; size -= 1) {
      const input = projectInput(profile, stories.slice(offset, offset + size));
      const schema = outputSchema(input.stories.map((story) => story.storyId));
      if (promptSize(input, schema) <= maxPromptChars) { selected = { size, input, schema }; break; }
    }
    if (selected === undefined) {
      plan.push({ kind: "failure", storyId: stories[offset]!.storyId });
      offset += 1;
      continue;
    }
    const batchStories = selected.input.stories;
    deepFreeze(selected.input);
    deepFreeze(selected.schema);
    const parseOutput = Object.freeze(createJudgmentParser(profile, batchStories));
    plan.push({
      kind: "batch", storyIds: batchStories.map((story) => story.storyId), stories: batchStories,
      input: selected.input, outputSchema: selected.schema, parseOutput,
    });
    offset += selected.size;
  }
  return plan;
}
