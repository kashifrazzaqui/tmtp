# Personalization Library Spec

## Purpose and responsibility
Compose activity reduction, interest profiles, LLM recommendations, queue ranking, and durable projections into the personalization workflow. External calls stay outside database transactions.

## Public interface / API surface
```ts
export interface Personalization {
  recordActivity(batch: import("@tmtp/activity").RawActivity[]): Promise<{ accepted: number; profileWorkEnqueued: boolean }>;
  rebuildProfile(reason: string): Promise<import("@tmtp/domain").InterestProfile>;
  scorePending(signal?: AbortSignal): Promise<{ scored: number; failed: number; queued: number }>;
  applyPreferenceChange(rules: import("@tmtp/domain").PreferenceRule[]): Promise<import("@tmtp/domain").InterestProfile>;
  recover(signal?: AbortSignal): Promise<{ rebuilt: boolean; scored: number; failed: number }>;
  projectQueue(): Promise<{ projected: number; complete: boolean }>;
}

export interface PersonalizationOptions {
  store: import("@tmtp/reader-store").ReaderStore;
  jobs: import("@tmtp/job-queue").JobQueue;
  llm: import("@tmtp/llm-interface").LlmPort;
  model: string;
  clock: import("@tmtp/clock").Clock;
  activityPolicy: import("@tmtp/activity").ActivityPolicy;
  interestPolicy: import("@tmtp/interests").InterestPolicy;
  recommendationPolicy: import("@tmtp/recommendations").RecommendationPolicy;
  activityBatchSize: number;
  queueSyncBatchSize: number;
}

export function createPersonalization(options: PersonalizationOptions): Personalization;
```

Activity events, session updates, and profile-work enqueueing commit in one store transaction. A profile records exact source-rule, activity, policy, and builder versions. LLM calls occur before short transactions that persist judgments, per-attempt audits, evaluation states, and queue projections. Historical recommendations remain immutable. `recover` resumes missed profile/scoring work; `projectQueue` rebuilds the complete projection in resumable batches.

## Internal subcomponents
- Activity ingestion and profile-work coordination.
- Profile building and explicit-rule precedence.
- Scoring/usage persistence and complete-queue projection.
- Pending/failed recovery and preference correction flows.

## Dependencies on other libs
- `activity`
- `clock`
- `domain`
- `interests`
- `job-queue`
- `llm-interface`
- `queue`
- `reader-store`
- `recommendations`

## New build or OSS wrapper
New composition; no additional third-party dependency.

## Hosted by
`reader-app` commands and background jobs in `services/personal-reader`.

## Configuration
- `personalization.cron` — **optional**, default `7,37 * * * *`; periodic missed-work recovery.
- `personalization.activity_batch_size` — **optional**, default `500`.
- `personalization.queue_sync_batch_size` — **optional**, default `500`; projection batch size, not queue retention.
