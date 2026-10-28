# Activity Library Spec

## Purpose and responsibility
Normalize client observations into immutable activity events and reading-session updates. It defines active dwell, idle gaps, completion, provenance, and idempotency without interpreting events as explicit likes.

## Public interface / API surface
```ts
export interface RawActivity {
  clientEventId: string;
  storyId: import("@tmtp/domain").StoryId;
  kind: import("@tmtp/domain").ActivityKind;
  occurredAt: string;
  value?: Record<string, unknown>;
  source: "embedded-reader" | "original-page" | "hn-reconciliation" | "app-action";
}

export interface ActivityReduction {
  events: import("@tmtp/domain").ActivityEvent[];
  session?: import("@tmtp/domain").ReadingSession;
  observationQuality: "full" | "partial";
}

export interface ActivityPolicy {
  idleTimeoutMs: number;
  minDwellMs: number;
  maxSessionGapMs: number;
}

export function reduceActivity(
  batch: RawActivity[],
  previousSession: import("@tmtp/domain").ReadingSession | undefined,
  policy: ActivityPolicy,
  clock: import("@tmtp/clock").Clock,
): ActivityReduction;
```

Events retain client occurrence time and server receipt time. Reconciliation records current-state evidence rather than invented historical timing.

## Internal subcomponents
- Event validation and idempotency identity.
- Active-dwell/session reducer.
- Observation-quality and provenance mapping.

## Dependencies on other libs
- `clock`
- `domain`

## New build or OSS wrapper
New pure TypeScript implementation; no third-party runtime dependency.

## Hosted by
`reader-app` and `personalization` in `services/personal-reader`.

## Configuration
- `activity.idle_timeout_ms` — **optional**, default `60000`.
- `activity.min_dwell_ms` — **optional**, default `1000`.
- `activity.max_session_gap_ms` — **optional**, default `300000`.
