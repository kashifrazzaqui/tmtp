import type { QueueState, StoryId } from "@tmtp/domain";

export type QueueErrorCode =
  | "invalid-input"
  | "duplicate-story"
  | "duplicate-article"
  | "duplicate-entry"
  | "unknown-story"
  | "missing-recommendation"
  | "ambiguous-recommendation"
  | "evaluation-conflict"
  | "invalid-transition"
  | "invalid-page-size"
  | "invalid-cursor"
  | "cursor-version-mismatch"
  | "cursor-section-mismatch";

export class QueueError extends Error {
  override readonly name = "QueueError" as const;
  readonly field?: string;
  readonly storyId?: StoryId;
  readonly from?: QueueState;
  readonly to?: QueueState;
  constructor(readonly code: QueueErrorCode, message: string, details: { field?: string; storyId?: StoryId; from?: QueueState; to?: QueueState } = {}) {
    super(message);
    if (details.field !== undefined) this.field = details.field;
    if (details.storyId !== undefined) this.storyId = details.storyId;
    if (details.from !== undefined) this.from = details.from;
    if (details.to !== undefined) this.to = details.to;
  }
}

export function queueError(code: QueueErrorCode, field?: string, storyId?: StoryId): QueueError {
  return new QueueError(code, `Queue validation failed: ${code}.`, {
    ...(field === undefined ? {} : { field }),
    ...(storyId === undefined ? {} : { storyId }),
  });
}
