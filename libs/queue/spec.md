# Queue Library Spec

## Purpose and responsibility
Define complete-queue eligibility, stable ranking, reading-state transitions, exploration placement, and cursor pagination independently of storage and HTTP.

## Public interface / API surface
```ts
export interface QueuePage {
  entries: import("@tmtp/domain").QueueEntry[];
  nextCursor?: string;
}

export function rankQueue(input: {
  stories: import("@tmtp/domain").Story[];
  recommendations: import("@tmtp/domain").Recommendation[];
  evaluationByStory: Record<number, import("@tmtp/domain").EvaluationState>;
  profile: import("@tmtp/domain").InterestProfile;
  explorationRatio: number;
  explorationSeed: string;
}): import("@tmtp/domain").QueueEntry[];

export function transitionQueueState(
  entry: import("@tmtp/domain").QueueEntry,
  next: import("@tmtp/domain").QueueState,
): import("@tmtp/domain").QueueEntry;

export function paginateQueue(
  entries: import("@tmtp/domain").QueueEntry[],
  cursor: string | undefined,
  pageSize: number,
): QueuePage;
```

Blacklisted stories are excluded from the default queue but retained in history. Pending/failed entries have explicit stable sections. Exploration uses a deterministic hash and never overrides blacklists.

## Internal subcomponents
- Eligibility and state machine.
- Match/exploration ordering and unscored placement.
- Signed, versioned cursor codec.

## New build or OSS wrapper
New pure TypeScript implementation; no third-party runtime dependency.

## Dependencies on other libs
- `domain`

## Hosted by
`personalization` and `reader-app` in `services/personal-reader`.

## Configuration
- `queue.page_size` — **optional**, default `50`.
- `queue.max_page_size` — **optional**, default `200`.
