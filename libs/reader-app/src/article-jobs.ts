import { ARTICLE_READER_VERSION } from "@tmtp/article-reader";
import type { ArticleReadResult } from "@tmtp/article-reader";
import { ArticleSchema } from "@tmtp/domain";
import type { Article, Job, Story, StoryId } from "@tmtp/domain";
import { appError, translateError } from "./errors.js";
import type { ArticleFetchExtractJobPayload, NormalizedReaderAppOptions } from "./types.js";
import { exactKeys, plainObject, requireStory, timestamp } from "./validation.js";

function invalidResult(storyId: StoryId, jobId: string): never {
  throw appError("dependency-failure", "run-job", {
    retryable: false,
    dependency: "article-reader",
    dependencyCode: "invalid-result",
    storyId,
    jobId,
  });
}

function validateReadResult(value: ArticleReadResult, story: Story, jobId: string): ArticleReadResult {
  if (!plainObject(value) || value.outcome !== "ready" && value.outcome !== "failed" ||
    !exactKeys(value, ["outcome", "article", "originalUrl"], value.outcome === "failed" ? ["failure"] : [])) invalidResult(story.id, jobId);
  if (value.outcome === "failed" && !Object.hasOwn(value, "failure")) invalidResult(story.id, jobId);
  if (!ArticleSchema.safeParse(value.article).success || value.article.storyId !== story.id ||
    value.article.sourceContentVersion !== story.contentVersion || value.article.status !== value.outcome ||
    value.article.extractorVersion !== ARTICLE_READER_VERSION ||
    typeof value.originalUrl !== "string" || value.originalUrl.length === 0) invalidResult(story.id, jobId);
  if (value.outcome === "failed") {
    const failure = value.failure;
    if (!plainObject(failure) || !exactKeys(failure, ["category", "code", "message", "retryable"], ["status"]) ||
      !["fetch", "unsupported-content", "extraction", "empty-content"].includes(failure.category as string) ||
      typeof failure.code !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(failure.code) || failure.code.length > 64 ||
      typeof failure.message !== "string" || typeof failure.retryable !== "boolean" ||
      failure.status !== undefined && (!Number.isSafeInteger(failure.status) || (failure.status as number) < 100 || (failure.status as number) > 599)) {
      invalidResult(story.id, jobId);
    }
  }
  return value;
}

function currentReady(article: Article | undefined, sourceContentVersion: string): boolean {
  return article?.status === "ready" && article.sourceContentVersion === sourceContentVersion &&
    article.extractorVersion === ARTICLE_READER_VERSION;
}

export async function runArticleJob(
  options: NormalizedReaderAppOptions,
  job: Job,
  payload: ArticleFetchExtractJobPayload,
  signal: AbortSignal | undefined,
): Promise<void> {
  const initial = options.store.transaction((): { story: Story; article?: Article; eligible: boolean } | undefined => {
    const story = options.store.stories.byId(payload.storyId);
    if (story === undefined) {
      throw appError("not-found", "run-job", { storyId: payload.storyId, jobId: job.id, retryable: false });
    }
    if (story.contentVersion !== payload.storyContentVersion) return undefined;
    const article = options.store.articles.byStoryId(story.id);
    const needing = options.store.articles.needingContent({
      extractorVersion: ARTICLE_READER_VERSION,
      ...(story.id === 1 ? {} : { afterStoryId: story.id - 1 }),
      limit: 1,
    });
    const retryFailed = article?.status === "failed" && article.sourceContentVersion === story.contentVersion &&
      article.extractorVersion === ARTICLE_READER_VERSION;
    return {
      story,
      ...(article === undefined ? {} : { article }),
      eligible: needing[0]?.id === story.id || retryFailed,
    };
  });
  if (initial === undefined || !initial.eligible) return;
  if (signal?.aborted) throw appError("cancelled", "run-job", { retryable: true, storyId: payload.storyId, jobId: job.id });

  let result: ArticleReadResult;
  try {
    result = validateReadResult(await options.articles.read(initial.story, signal), initial.story, job.id);
  } catch (error) {
    if (signal?.aborted && error === signal.reason) {
      throw appError("cancelled", "run-job", { retryable: true, storyId: payload.storyId, jobId: job.id });
    }
    if (error instanceof Error && error.name === "ReaderAppError") throw error;
    if (error instanceof Error && error.name === "ArticleReaderError") {
      throw translateError(error, "run-job", "article-reader", { storyId: payload.storyId, jobId: job.id });
    }
    throw error;
  }

  const applied = options.store.transaction(() => {
    const current = options.store.articles.byStoryId(initial.story.id);
    if (currentReady(current, initial.story.contentVersion)) return false;
    return options.store.articles.upsert(result.article) === "applied";
  });
  if (!applied || result.outcome === "ready") {
    if (signal?.aborted) throw appError("cancelled", "run-job", { retryable: true, storyId: initial.story.id, jobId: job.id });
    return;
  }
  throw appError("article-attempt-failed", "run-job", {
    retryable: result.failure.retryable,
    storyId: initial.story.id,
    jobId: job.id,
    dependency: "article-reader",
    dependencyCode: result.failure.code,
  });
}

export function refreshArticle(options: NormalizedReaderAppOptions, storyId: StoryId): Job {
  return options.store.transaction(() => {
    const story = requireStory(options.store, storyId, "refresh-article");
    try {
      return options.jobs.enqueue({
        kind: "article.fetch-extract",
        payloadSchemaVersion: 1,
        payload: { storyId: story.id, storyContentVersion: story.contentVersion },
        dedupeKey: `${story.id}:${story.contentVersion}`,
        runAfter: timestamp(options.now, "refresh-article"),
      }).job;
    } catch (error) {
      throw translateError(error, "refresh-article", "job-queue", { storyId });
    }
  });
}
