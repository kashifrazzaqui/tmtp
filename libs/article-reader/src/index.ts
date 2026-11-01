import { articleContentVersion, ArticleSchema, StorySchema } from "@tmtp/domain";
import type { Article, Story } from "@tmtp/domain";
import { ArticleFetchError } from "@tmtp/article-fetcher";
import type { FetchedArticle } from "@tmtp/article-fetcher";
import { ARTICLE_EXTRACTOR_VERSION, ArticleExtractionError, extractArticle } from "@tmtp/article-extractor";
import type { ExtractedArticle } from "@tmtp/article-extractor";
import { ArticleReaderError, failure } from "./errors.js";
import { hnPermalink, resolveArticleOriginalTarget } from "./urls.js";
import type { ArticleOriginalTarget, ArticleReader, ArticleReaderOptions, ArticleReadFailure, ArticleReadResult, FailedArticle, ReadyArticle } from "./types.js";

export { ARTICLE_EXTRACTOR_VERSION } from "@tmtp/article-extractor";
export { ArticleReaderError } from "./errors.js";
export { resolveArticleOriginalTarget } from "./urls.js";
export const ARTICLE_READER_VERSION = `article-reader-v1:${ARTICLE_EXTRACTOR_VERSION}`;
export type { ArticleReaderErrorCode, ArticleReadFailureCategory, ArticleReadFailureCode, ArticleReadFailure, ReadyArticle, FailedArticle, ArticleReadyResult, ArticleFailedResult, ArticleReadResult, ArticleReaderOptions, ArticleReader, ArticleOriginalTarget } from "./types.js";

interface Provenance { sourceUrl?: string; finalUrl?: string; fetchedAt?: string; }
function checkpoint(signal: AbortSignal | undefined): void { if (signal?.aborted) throw signal.reason; }
function contract(): never { throw new ArticleReaderError("dependency-contract"); }
function validateStory(story: Story, signal: AbortSignal | undefined): Story {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new ArticleReaderError("invalid-input");
  try {
    const parsed = StorySchema.safeParse(story);
    if (!parsed.success) throw new ArticleReaderError("invalid-input");
    return structuredClone(parsed.data);
  } catch (error) {
    if (error instanceof RangeError) throw new ArticleReaderError("invalid-input");
    throw error;
  }
}
function validateFetched(value: FetchedArticle): void {
  if (value === null || typeof value !== "object" || typeof value.sourceUrl !== "string" || typeof value.finalUrl !== "string" ||
    typeof value.html !== "string" || typeof value.fetchedAt !== "string" || !["text/html", "application/xhtml+xml"].includes(value.contentType)) contract();
}
function validateExtracted(value: ExtractedArticle): void {
  if (value === null || typeof value !== "object" || typeof value.text !== "string" || typeof value.sanitizedHtml !== "string" ||
    typeof value.contentHash !== "string" || value.contentHash === "" || value.extractorVersion !== ARTICLE_EXTRACTOR_VERSION ||
    (value.title !== undefined && typeof value.title !== "string") || (value.byline !== undefined && typeof value.byline !== "string") ||
    (value.excerpt !== undefined && typeof value.excerpt !== "string")) contract();
}
function timestamp(now: () => Date, signal: AbortSignal | undefined): string {
  checkpoint(signal);
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) contract();
  return value.toISOString();
}
function finalize<T extends Article>(article: T): T {
  article.contentVersion = articleContentVersion(article);
  try {
    if (!ArticleSchema.safeParse(article).success || article.contentVersion !== articleContentVersion(article)) contract();
  } catch (error) {
    if (error instanceof RangeError) contract();
    throw error;
  }
  return article;
}
function ready(
  story: Story, extracted: ExtractedArticle, provenance: Provenance, target: ArticleOriginalTarget,
  now: () => Date, signal: AbortSignal | undefined,
): ArticleReadResult {
  const article = finalize({
    storyId: story.id, status: "ready", sourceContentVersion: story.contentVersion, contentVersion: "",
    ...provenance, title: extracted.title ?? story.title,
    ...(extracted.byline === undefined ? {} : { byline: extracted.byline }), ...(extracted.excerpt === undefined ? {} : { excerpt: extracted.excerpt }),
    textContent: extracted.text, sanitizedHtml: extracted.sanitizedHtml, contentHash: extracted.contentHash,
    extractorVersion: ARTICLE_READER_VERSION, updatedAt: timestamp(now, signal),
  } as ReadyArticle);
  return { outcome: "ready", article, originalUrl: target.url };
}
function failed(
  story: Story, reason: ArticleReadFailure, provenance: Provenance, target: ArticleOriginalTarget,
  now: () => Date, signal: AbortSignal | undefined,
): ArticleReadResult {
  const article = finalize({
    storyId: story.id, status: "failed", sourceContentVersion: story.contentVersion, contentVersion: "", ...provenance,
    extractorVersion: ARTICLE_READER_VERSION, updatedAt: timestamp(now, signal), errorCode: reason.code, errorMessage: reason.message,
  } as FailedArticle);
  return { outcome: "failed", article, failure: reason, originalUrl: target.url };
}
function validateOptions(options: ArticleReaderOptions): Required<ArticleReaderOptions> {
  if (options === null || typeof options !== "object" || Object.keys(options).some((key) => !["fetcher", "maxContentChars", "maxInputBytes", "now", "extract"].includes(key)) ||
    options.fetcher === null || typeof options.fetcher !== "object" || typeof options.fetcher.fetch !== "function" || typeof options.now !== "function" ||
    (options.extract !== undefined && typeof options.extract !== "function") || typeof options.maxContentChars !== "number" || typeof options.maxInputBytes !== "number") {
    throw new TypeError("Invalid article reader options.");
  }
  if (!Number.isSafeInteger(options.maxContentChars) || options.maxContentChars < 1 || !Number.isSafeInteger(options.maxInputBytes) || options.maxInputBytes < 1 || options.maxInputBytes > 2_147_483_647) {
    throw new RangeError("Invalid article reader limits.");
  }
  return {
    fetcher: options.fetcher, maxContentChars: options.maxContentChars, maxInputBytes: options.maxInputBytes,
    now: options.now, extract: options.extract ?? extractArticle,
  };
}
export function createArticleReader(input: ArticleReaderOptions): ArticleReader {
  const options = validateOptions(input);
  return {
    async read(storyInput: Story, signal?: AbortSignal): Promise<ArticleReadResult> {
      const story = validateStory(storyInput, signal);
      checkpoint(signal);
      const target = resolveArticleOriginalTarget(story);
      let stage: "fetch" | "extract" | undefined;
      let fetched: FetchedArticle | undefined;
      const selfText = story.url === undefined && story.textHtml !== undefined;
      try {
        if (story.url !== undefined) {
          checkpoint(signal);
          stage = "fetch";
          fetched = await options.fetcher.fetch(story.url, signal);
          checkpoint(signal);
          validateFetched(fetched);
          stage = "extract";
          const extracted = options.extract({ html: fetched.html, sourceUrl: fetched.finalUrl, maxContentChars: options.maxContentChars });
          checkpoint(signal);
          validateExtracted(extracted);
          stage = undefined;
          return ready(story, extracted, { sourceUrl: fetched.sourceUrl, finalUrl: fetched.finalUrl, fetchedAt: fetched.fetchedAt }, target, options.now, signal);
        }
        if (!selfText) return failed(story, failure("empty-content"), { sourceUrl: hnPermalink(story.id) }, target, options.now, signal);
        const sourceUrl = hnPermalink(story.id);
        const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><article>${story.textHtml!}</article></body></html>`;
        if (Buffer.byteLength(html, "utf8") > options.maxInputBytes) return failed(story, failure("source-too-large"), { sourceUrl }, target, options.now, signal);
        checkpoint(signal);
        stage = "extract";
        const extracted = options.extract({ html, sourceUrl, maxContentChars: options.maxContentChars });
        checkpoint(signal);
        validateExtracted(extracted);
        stage = undefined;
        return ready(story, extracted, { sourceUrl }, target, options.now, signal);
      } catch (error) {
        checkpoint(signal);
        const provenance: Provenance = fetched !== undefined
          ? { sourceUrl: fetched.sourceUrl, finalUrl: fetched.finalUrl, fetchedAt: fetched.fetchedAt }
          : selfText || story.url === undefined ? { sourceUrl: hnPermalink(story.id) }
            : target.kind === "original-page" ? { sourceUrl: target.url } : {};
        if (stage === "fetch" && error instanceof ArticleFetchError) return failed(story, failure(error.code, error.status), provenance, target, options.now, signal);
        if (stage === "extract" && error instanceof ArticleExtractionError) return failed(story, failure(error.code), provenance, target, options.now, signal);
        throw error;
      }
    },
  };
}
