# Config Library Spec

## Purpose and responsibility
Validate a centralized, already-loaded configuration object and produce a complete typed view with component-owned defaults applied. It does not prescribe environment, file, or flag loading.

## Public interface / API surface
```ts
export interface ConfigIssue {
  key: string;
  code: "required" | "invalid" | "inconsistent";
  message: string;
}

export interface ConfigResult<T> {
  value?: T;
  issues: ConfigIssue[];
}

export function parseConfig<T>(
  schema: import("zod").ZodType<T>,
  loaded: unknown,
): ConfigResult<T>;

export function assertValidConfig<T>(result: ConfigResult<T>): T;
```

Cross-field checks include non-loopback access control and paired HN account settings. Error text identifies keys but never includes supplied secret values.

## Internal subcomponents
- Schema composition helper for independent component config shapes.
- Safe issue formatter for startup diagnostics.

## Dependencies on other libs
None. Component schemas are supplied by the service composition root, avoiding a dependency from primitives back to `config`.

## New build or OSS wrapper
New build wrapping Zod `4.6.7`.

## Hosted by
`services/personal-reader` during startup and controlled configuration reload checks.

## Configuration
None of its own. Every owned key and default is documented by the corresponding component and aggregated in `docs/architecture.md`.
