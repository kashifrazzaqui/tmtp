import type { Article, Story } from "@tmtp/domain";
import type { ArticleFetchErrorCode, ArticleFetcher } from "@tmtp/article-fetcher";
import type { ArticleExtractionErrorCode, extractArticle } from "@tmtp/article-extractor";
export type ArticleReaderErrorCode = "invalid-input" | "dependency-contract";
export type ArticleReadFailureCategory = "fetch" | "unsupported-content" | "extraction" | "empty-content";
export type ArticleReadFailureCode = ArticleFetchErrorCode | ArticleExtractionErrorCode | "source-too-large";
export interface ArticleReadFailure { category: ArticleReadFailureCategory; code: ArticleReadFailureCode; message: string; retryable: boolean; status?: number; }
export interface ReadyArticle extends Article { status: "ready"; contentHash: string; extractorVersion: string; }
export interface FailedArticle extends Article { status: "failed"; extractorVersion: string; errorCode: ArticleReadFailureCode; errorMessage: string; }
export interface ArticleReadyResult { outcome: "ready"; article: ReadyArticle; originalUrl: string; }
export interface ArticleFailedResult { outcome: "failed"; article: FailedArticle; failure: ArticleReadFailure; originalUrl: string; }
export type ArticleReadResult = ArticleReadyResult | ArticleFailedResult;
export interface ArticleReaderOptions { fetcher: ArticleFetcher; maxContentChars: number; maxInputBytes: number; now: () => Date; extract?: typeof extractArticle; }
export interface ArticleReader { read(story: Story, signal?: AbortSignal): Promise<ArticleReadResult>; }
export interface ArticleOriginalTarget { kind: "original-page" | "hn-discussion"; url: string; }
