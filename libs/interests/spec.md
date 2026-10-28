# Interests Library Spec

## Purpose and responsibility
Derive versioned interest profiles from explicit include/exclude rules and ambiguous weighted activity. It owns decay, evidence aggregation, and profile reproducibility, not LLM ranking.

## Public interface / API surface
```ts
export interface ProfileBuild {
  rules: import("@tmtp/domain").PreferenceRule[];
  activity: import("@tmtp/domain").ActivityEvent[];
  rulesVersion: string;
  activityVersion: string;
  builtAt: string;
}

export interface InterestPolicy {
  decayHalfLifeDays: number;
  maxInferredTopics: number;
  maxActivityEvents: number;
}

export function buildInterestProfile(
  input: ProfileBuild,
  policy: InterestPolicy,
): import("@tmtp/domain").InterestProfile;

export function isBlacklisted(
  story: import("@tmtp/domain").Story,
  profile: import("@tmtp/domain").InterestProfile,
): boolean;
```

Explicit rules take precedence over inferred weights. Dwell, skips, votes, and flags have distinct evidence weights; none is treated as a complete preference statement.

## Internal subcomponents
- Rule compiler and blacklist matcher.
- Time-decayed activity aggregation.
- Profile versioning and bounded topic normalization.

## Dependencies on other libs
- `domain`

## New build or OSS wrapper
New pure TypeScript implementation; no third-party runtime dependency.

## Hosted by
`personalization` and `recommendations` in `services/personal-reader`.

## Configuration
- `interests.decay_half_life_days` — **optional**, default `45`.
- `interests.max_inferred_topics` — **optional**, default `50`.
- `interests.max_activity_events` — **optional**, default `5000`; processing window, never queue retention.
