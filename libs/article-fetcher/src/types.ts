import type { Clock, Sleep } from "@tmtp/clock";
import type { HttpClient } from "@tmtp/http-client";
export type ArticleProtocol = "http" | "https";
export type ArticleContentType = "text/html" | "application/xhtml+xml";
export interface FetchedArticle {
  sourceUrl: string;
  finalUrl: string;
  contentType: ArticleContentType;
  html: string;
  fetchedAt: string;
}
export interface ArticleDnsResolver { resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>; }
export interface ArticleFetcher { fetch(url: string, signal?: AbortSignal): Promise<FetchedArticle>; }
export type { ArticleFetcherOptions } from "./options.js";
export type { Clock, Sleep, HttpClient };
