import type { HnFeed, HnItem, IsoDateTime, Story } from "@tmtp/domain";
import type { HttpClient } from "@tmtp/http-client";
export interface HnPublicApi {
  maxItemId(signal?: AbortSignal): Promise<number>;
  item(id: number, signal?: AbortSignal): Promise<HnItem | undefined>;
  feed(name: HnFeed, signal?: AbortSignal): Promise<number[]>;
}
export interface HnPublicApiOptions { baseUrl: string; http: HttpClient; }
export interface NormalizeStoryInput { item: HnItem; observedAt: IsoDateTime; previous?: Story; }
export type HnPublicApiOperation = "max-item" | "item" | "feed" | "normalize-story";
export type HnPublicApiErrorCode = "invalid-input" | "invalid-response" | "http-status" | "timeout" | "response-too-large" |
  "redirect-policy" | "redirect-limit" | "invalid-redirect" | "transport" | "client-closed";
