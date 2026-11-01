import { resolveArticleOriginalTarget } from "@tmtp/article-reader";
import { transitionQueueState } from "@tmtp/queue";
import type { QueueState, StoryId } from "@tmtp/domain";
import { ReaderStoreError } from "@tmtp/reader-store";
import { appError } from "./errors.js";
import type {
  ActivityHistory,
  NormalizedReaderAppOptions,
  StoryDetail,
} from "./types.js";
import type { NormalizedActivityQuery } from "./validation.js";
import { requireStory, timestamp } from "./validation.js";

function missingProjection(operation: "get-story", storyId: StoryId, code: string): never {
  throw appError("dependency-failure", operation, {
    retryable: false,
    dependency: "reader-store",
    dependencyCode: code,
    storyId,
  });
}

export function readStory(options: NormalizedReaderAppOptions, storyId: StoryId): StoryDetail {
  return options.store.transaction(() => {
    const story = requireStory(options.store, storyId, "get-story");
    const article = options.store.articles.byStoryId(storyId);
    const queueEntry = options.store.queue.byStoryId(storyId);
    if (queueEntry === undefined) missingProjection("get-story", storyId, "missing-queue-entry");
    const recommendation = queueEntry.recommendationId === undefined
      ? undefined
      : options.store.recommendations.byId(queueEntry.recommendationId);
    if (queueEntry.recommendationId !== undefined && (recommendation === undefined || recommendation.storyId !== storyId)) {
      missingProjection("get-story", storyId, "missing-recommendation");
    }
    const target = resolveArticleOriginalTarget(story);
    return {
      story,
      ...(article === undefined ? {} : { article }),
      ...(recommendation === undefined ? {} : { recommendation }),
      queueEntry,
      originalUrl: target.url,
      fallback: { kind: target.kind, observationQuality: "partial" },
    };
  });
}

function invalidContinuation(operation: "get-recommendation-history" | "get-hn-action-history" | "get-activity", field: string, error: unknown): never {
  if (error instanceof ReaderStoreError && error.code === "invalid-query") {
    throw appError("invalid-input", operation, { field, retryable: false });
  }
  throw error;
}

export function recommendationHistory(
  options: NormalizedReaderAppOptions,
  query: { storyId: StoryId; afterId?: string; limit: number },
) {
  return options.store.transaction(() => {
    requireStory(options.store, query.storyId, "get-recommendation-history");
    try {
      return options.store.recommendations.historyForStory(query.storyId, query.afterId, query.limit);
    } catch (error) {
      invalidContinuation("get-recommendation-history", "afterId", error);
    }
  });
}

export function hnActionHistory(
  options: NormalizedReaderAppOptions,
  query: { storyId: StoryId; afterId?: string; limit: number },
) {
  return options.store.transaction(() => {
    requireStory(options.store, query.storyId, "get-hn-action-history");
    try {
      return options.store.hnActions.historyForStory(query.storyId, query.afterId, query.limit);
    } catch (error) {
      invalidContinuation("get-hn-action-history", "afterId", error);
    }
  });
}

export function activityHistory(options: NormalizedReaderAppOptions, query: NormalizedActivityQuery): ActivityHistory {
  return options.store.transaction(() => {
    if (query.storyId !== undefined) requireStory(options.store, query.storyId, "get-activity");
    const filter = {
      ...(query.storyId === undefined ? {} : { storyId: query.storyId }),
      ...(query.clientEventId === undefined ? {} : { clientEventId: query.clientEventId }),
      limit: query.limit,
    };
    let events: ActivityHistory["events"];
    try {
      events = options.store.activity.query({
        ...filter,
        ...(query.afterEventId === undefined ? {} : { afterId: query.afterEventId }),
      });
    } catch (error) {
      invalidContinuation("get-activity", "afterEventId", error);
    }
    let sessions: ActivityHistory["sessions"];
    try {
      sessions = options.store.readingSessions.query({
        ...filter,
        ...(query.afterSessionId === undefined ? {} : { afterId: query.afterSessionId }),
      });
    } catch (error) {
      invalidContinuation("get-activity", "afterSessionId", error);
    }
    return { events, sessions };
  });
}

export function setReadingState(options: NormalizedReaderAppOptions, storyId: StoryId, state: QueueState) {
  return options.store.transaction(() => {
    const current = options.store.queue.byStoryId(storyId);
    if (current === undefined) throw appError("not-found", "set-queue-state", { storyId, retryable: false });
    const at = timestamp(options.now, "set-queue-state", current.updatedAt);
    const transitioned = transitionQueueState(current, state, at);
    return options.store.queue.updateState(storyId, transitioned.state, transitioned.updatedAt);
  });
}

export function preferenceList(options: NormalizedReaderAppOptions) {
  return options.store.transaction(() => options.store.preferences.list().map((rule) => ({ ...rule })));
}
