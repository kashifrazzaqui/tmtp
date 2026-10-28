# Reader Application Library Spec

## Purpose and responsibility
Provide the transport-free commands and queries for the complete reader product. Compose ingestion, article reading, personalization, account actions, preferences, queue state, and durable jobs without knowing HTTP, cookies, React, or process lifecycle.

## Public interface / API surface
```ts
export interface ReaderApp {
  getQueue(query: import("@tmtp/reader-store").QueueQuery): Promise<QueueResult>;
  getStory(storyId: number): Promise<StoryDetail>;
  getRecommendationHistory(storyId: number, afterId?: string, limit?: number): Promise<import("@tmtp/domain").Recommendation[]>;
  getHnActionHistory(storyId: number, limit?: number): Promise<import("@tmtp/domain").HnActionIntent[]>;
  getActivity(query: import("@tmtp/reader-store").ActivityQuery): Promise<{ events: import("@tmtp/domain").ActivityEvent[]; sessions: import("@tmtp/domain").ReadingSession[] }>;
  setQueueState(storyId: number, state: import("@tmtp/domain").QueueState): Promise<void>;
  refreshArticle(storyId: number): Promise<import("@tmtp/domain").Job>;

  recordActivity(batch: import("@tmtp/activity").RawActivity[]): Promise<{ accepted: number }>;
  getPreferences(): Promise<import("@tmtp/domain").PreferenceRule[]>;
  replacePreferences(rules: import("@tmtp/domain").PreferenceRule[]): Promise<import("@tmtp/domain").InterestProfile>;
  rebuildPersonalization(reason: string): Promise<import("@tmtp/domain").InterestProfile>;

  getHnCapabilities(): Promise<import("@tmtp/hn-account").AccountCapability[]>;
  performHnAction(intent: import("@tmtp/domain").HnActionIntent): Promise<import("@tmtp/hn-account").HnActionResult>;

  runIngestion(signal?: AbortSignal): Promise<import("@tmtp/hn-ingestion").IngestionSummary>;
  runPersonalization(signal?: AbortSignal): Promise<{ rebuilt: boolean; scored: number; failed: number }>;
  runArticleJob(job: import("@tmtp/domain").Job): Promise<void>;
  runPersonalizationJob(job: import("@tmtp/domain").Job): Promise<void>;
  reconcileHnAccount(): Promise<{ observations: number }>;
}

export interface QueueResult extends import("@tmtp/queue").QueuePage {
  evaluationCounts: Record<string, number>;
}

export interface StoryDetail {
  story: import("@tmtp/domain").Story;
  article?: import("@tmtp/domain").Article;
  recommendation?: import("@tmtp/domain").Recommendation;
  queueEntry: import("@tmtp/domain").QueueEntry;
  originalUrl?: string;
}

export interface ReaderAppOptions {
  store: import("@tmtp/reader-store").ReaderStore;
  jobs: import("@tmtp/job-queue").JobQueue;
  articles: ReturnType<typeof import("@tmtp/article-reader").createArticleReader>;
  ingestion: import("@tmtp/hn-ingestion").HnIngestion;
  personalization: import("@tmtp/personalization").Personalization;
  account?: import("@tmtp/hn-account").HnAccount;
  queuePageSize: number;
  queueMaxPageSize: number;
}

export function createReaderApp(options: ReaderAppOptions): ReaderApp;
```

Background handlers are idempotent. Article and recommendation network calls happen outside store transactions. HN actions persist intent, re-read state before retry, and preserve indeterminate outcomes. No application method initiates an HN mutation without an intent supplied by a user-facing command.

## Internal subcomponents
- Queue/story query and reading-state application service.
- Activity and preference command handlers.
- Article, ingestion, and personalization job handlers.
- HN action intent/verification coordinator.

## Dependencies on other libs
- `activity`
- `article-reader`
- `domain`
- `hn-account`
- `hn-ingestion`
- `job-queue`
- `personalization`
- `queue`
- `reader-store`

`llm-interface`, `recommendations`, `activity`, and lower-tier clients are reached through those compositions rather than duplicated here.

## New build or OSS wrapper
New composition; no third-party dependency.

## Hosted by
`services/personal-reader`, which adds HTTP, authentication, static UI, scheduling, and lifecycle.

## Configuration
No new keys. All policy is supplied through the component options aggregated by the service.
