# Hacker News Ingestion Library Spec

## Purpose and responsibility
Coordinate checkpointed public-story collection, changed-item refresh, and optional account-state reconciliation. It owns ingestion policy but not schedules, HTTP transport, or recommendation scoring.

## Public interface / API surface
```ts
export interface IngestionSummary {
  runId: string;
  highestSeenItemId: number;
  storiesUpserted: number;
  nonStoriesSkipped: number;
  jobsEnqueued: number;
}

export interface HnIngestionOptions {
  api: import("@tmtp/hn-public-api").HnPublicApi;
  account?: import("@tmtp/hn-account").HnAccount;
  store: import("@tmtp/reader-store").ReaderStore;
  jobs: import("@tmtp/job-queue").JobQueue;
  clock: import("@tmtp/clock").Clock;
  feeds: ("top" | "new" | "best" | "ask" | "show")[];
  initialLookbackItems: number;
  maxItemsPerRun: number;
  refreshBatchSize: number;
  refreshAfterHours: number;
}

export interface HnIngestion {
  collectPublic(signal?: AbortSignal): Promise<IngestionSummary>;
  reconcileAccount(signal?: AbortSignal): Promise<{ observations: number; capabilities: import("@tmtp/hn-account").AccountCapability[] }>;
}

export function createHnIngestion(options: HnIngestionOptions): HnIngestion;
```

First run seeds configured public feeds and establishes the current `maxitem` cursor; later runs advance IDs. `initial_lookback_items=0` avoids unbounded history. Story upserts, initial pending queue entries, cursor progress, and job dedupe records commit atomically per batch. Pending insertion preserves existing reading/ranking state on reprocessing and applies the current profile's blacklist visibility when one exists.

## Internal subcomponents
- Feed seed and maxitem cursor walkers.
- Item filtering, batch upsert, and metadata refresh.
- Durable run records and article/recommendation job enqueueing.
- Optional account current-state reconciliation.

## Dependencies on other libs
- `clock`
- `domain`
- `hn-account` (optional at runtime)
- `hn-public-api`
- `interests`
- `job-queue`
- `reader-store`

## New build or OSS wrapper
New composition; no additional third-party dependency.

## Hosted by
`reader-app` ingestion jobs in `services/personal-reader`.

## Configuration
- `ingestion.cron` — **optional**, default `*/15 * * * *`.
- `ingestion.feeds` — **optional**, default `["top", "new", "best", "ask", "show"]`.
- `ingestion.initial_lookback_items` — **optional**, default `0`.
- `ingestion.max_items_per_run` — **optional**, default `2000`; checkpointed work limit, not story retention.
- `ingestion.refresh_batch_size` — **optional**, default `100`.
- `ingestion.refresh_after_hours` — **optional**, default `24`.
