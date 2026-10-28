# Hacker News Public API Library Spec

## Purpose and responsibility
Provide a typed, bounded client for the official public Hacker News Firebase API. It knows nothing about SQLite, cursors, jobs, or private account state.

## Public interface / API surface
```ts
export interface HnPublicApi {
  maxItemId(signal?: AbortSignal): Promise<number>;
  item(id: number, signal?: AbortSignal): Promise<import("@tmtp/domain").HnItem | undefined>;
  feed(name: "top" | "new" | "best" | "ask" | "show", signal?: AbortSignal): Promise<number[]>;
}

export function createHnPublicApi(options: {
  baseUrl: string;
  http: import("@tmtp/http-client").HttpClient;
}): HnPublicApi;
```

Responses are validated and normalized at the boundary. Missing/deleted items remain explicit values; no private votes, favorites, flags, or mutations are exposed.

## Internal subcomponents
- Endpoint construction and response decoding.
- HN item-to-domain normalization.

## Dependencies on other libs
- `domain`
- `http-client`

## New build or OSS wrapper
New client over the official HN API; no Firebase SDK required.

## Hosted by
`hn-ingestion` in `services/personal-reader`.

## Configuration
- `hn.api_base_url` — **optional**, default `https://hacker-news.firebaseio.com/v0`.
