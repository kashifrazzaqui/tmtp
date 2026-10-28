# Logging Library Spec

## Purpose and responsibility
Provide structured, leveled logs with correlation fields and mandatory secret redaction, without exposing a third-party logger to feature libraries.

## Public interface / API surface
```ts
export interface LogFields { [key: string]: unknown }

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function createLogger(options: { level: string; service: string }): Logger;
export const noopLogger: Logger;
```

Correlation keys include `runId`, `jobId`, `storyId`, `profileId`, and `requestId`. Redaction covers access tokens, cookies, authorization headers, API keys, and secret-file contents.

## Internal subcomponents
- Pino-backed logger and child-context propagation.
- Fixed redaction policy and safe error serializer.

## Dependencies on other libs
None.

## New build or OSS wrapper
New narrow wrapper around Pino `10.4.0`.

## Hosted by
`services/personal-reader` and all in-process compositions.

## Configuration
- `logging.level` — **optional**, default `info`; one of `error`, `warn`, `info`, `debug`, `trace`.
