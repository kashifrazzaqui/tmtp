# Diagnostics Library Spec

## Purpose and responsibility
Build transport-free liveness, readiness, health, and redacted debug snapshots from durable state and job-queue status. It owns no HTTP route or UI.

## Public interface / API surface
```ts
export interface HealthSnapshot {
  status: "live" | "ready" | "degraded" | "not-ready";
  checks: { name: string; required: boolean; status: string; detail?: string }[];
}

export interface DebugSnapshot {
  generatedAt: string;
  activeProfile?: import("@tmtp/domain").InterestProfile;
  activeRecommendationVersions: import("@tmtp/domain").RecommendationVersionCount[];
  syncRuns: import("@tmtp/domain").IngestionRun[];
  jobs: import("@tmtp/domain").Job[];
  queueCounts: Record<string, number>;
  llmUsage: import("@tmtp/domain").LlmCallRecord[];
  recentErrors: import("@tmtp/domain").DiagnosticError[];
}

export interface ReadinessInput {
  databaseReady: boolean;
  migrationsCurrent: boolean;
  workersReady: boolean;
  llm: { configured: boolean; available: boolean; detail?: string };
  hnAccount?: { configured: boolean; available: boolean; detail?: string };
}

export interface DiagnosticsOptions {
  store: import("@tmtp/reader-store").ReaderStore;
  jobs: import("@tmtp/job-queue").JobQueue;
  clock: import("@tmtp/clock").Clock;
  includeLlmPayloads: boolean;
}

export interface Diagnostics {
  liveness(): HealthSnapshot;
  readiness(input: ReadinessInput): HealthSnapshot;
  debugSnapshot(): DebugSnapshot;
}

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics;
```

Optional HN account state never makes the core reader unready. Debug payloads exclude secrets by construction. LLM request/response payloads are returned only when explicitly captured under `debug.include_llm_payloads=true`.

## Internal subcomponents
- Required/optional health-check aggregation.
- Sync/job/queue/LLM debug projections.
- Redaction and payload-capture policy.

## Dependencies on other libs
- `clock`
- `domain`
- `job-queue`
- `reader-store`

## New build or OSS wrapper
New composition; no additional third-party dependency.

## Hosted by
`services/personal-reader` health routes, debug API, SSE stream, and UI debug drawer.

## Configuration
- `debug.enabled` — **optional**, default `false`; toggles all debug-window routes and UI.
- `debug.stream_interval_ms` — **optional**, default `2000`.
- `debug.include_llm_payloads` — **optional**, default `false`; requires `debug.enabled=true` and controls non-secret prompt/profile/content capture.
