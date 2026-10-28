# Article Extractor Library Spec

## Purpose and responsibility
Transform untrusted article HTML into normalized metadata, readable text, and sanitized reader HTML. It performs no network access.

## Public interface / API surface
```ts
export interface ExtractedArticle {
  title?: string;
  byline?: string;
  excerpt?: string;
  text: string;
  sanitizedHtml: string;
  contentHash: string;
  extractorVersion: string;
}

export function extractArticle(input: {
  html: string;
  sourceUrl: string;
  maxContentChars: number;
}): ExtractedArticle;
```

The DOM disables script execution and remote resource loading. Sanitization runs after Readability with an HTML-only allowlist. Relative links resolve against `sourceUrl`; dangerous URL schemes are removed.

## Internal subcomponents
- Inert jsdom document creation.
- Mozilla Readability extraction.
- DOMPurify profile, link normalization, and content hashing.

## Dependencies on other libs
None. `article-reader` maps this independent extraction result into the domain `Article` type.

## New build or OSS wrapper
New wrapper around `@mozilla/readability` `0.6.0`, `jsdom` `30.1.3`, and DOMPurify `3.4.17`.

## Hosted by
`article-reader` jobs in `services/personal-reader`.

## Configuration
- `article.max_content_chars` — **optional**, default `500000`.
