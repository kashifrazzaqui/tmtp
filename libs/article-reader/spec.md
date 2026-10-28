# Article Reader Library Spec

## Purpose and responsibility
Compose safe fetching and pure extraction into a transport-free article-reading operation. It returns cacheable article results and explicit extraction failures; persistence remains with `reader-app`.

## Public interface / API surface
```ts
export interface ArticleReadResult {
  article?: import("@tmtp/domain").Article;
  failure?: {
    category: "fetch" | "unsupported-content" | "extraction" | "empty-content";
    message: string;
    retryable: boolean;
  };
  originalUrl?: string;
}

export function createArticleReader(options: {
  fetcher: ReturnType<typeof import("@tmtp/article-fetcher").createArticleFetcher>;
  maxContentChars: number;
}): {
  read(story: import("@tmtp/domain").Story, signal?: AbortSignal): Promise<ArticleReadResult>;
};
```

URL stories use `article-fetcher` then `article-extractor`. HN self-text is extracted without network access. A failure always retains an original-page fallback when a URL exists; no markup bypasses the sanitizer.

## Internal subcomponents
- URL/self-text dispatch.
- Fetch/extract composition and result versioning.
- Failure classification and fallback metadata.

## Dependencies on other libs
- `article-extractor`
- `article-fetcher`
- `domain`

## New build or OSS wrapper
New composition; no additional third-party dependency.

## Hosted by
`reader-app` article jobs and story queries in `services/personal-reader`.

## Configuration
No new keys. Uses `article.*` settings owned by `article-fetcher` and `article-extractor`.
