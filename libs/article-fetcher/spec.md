# Article Fetcher Library Spec

## Purpose and responsibility
Fetch arbitrary public article HTML under an SSRF-resistant URL, DNS, connection, redirect, timeout, and size policy. It returns raw content; extraction is a separate pure operation.

## Public interface / API surface
```ts
export interface FetchedArticle {
  sourceUrl: string;
  finalUrl: string;
  contentType: string;
  html: string;
  fetchedAt: string;
}

export interface ArticleFetcherOptions {
  http: import("@tmtp/http-client").HttpClient;
  clock: import("@tmtp/clock").Clock;
  timeoutMs: number;
  dnsTimeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  allowedProtocols: string[];
  allowedPorts: number[];
}

export function createArticleFetcher(options: ArticleFetcherOptions): {
  fetch(url: string, signal?: AbortSignal): Promise<FetchedArticle>;
};
```

For every hop: reject credentials and disallowed protocols/ports; resolve every A/AAAA address; normalize mapped/NAT64 forms; require global addresses; pin a validated address while preserving TLS/SNI; and revalidate redirects. Only HTML content types are returned.

## Internal subcomponents
- URL and redirect policy.
- DNS resolution and `ip-address.isGlobal()` classification.
- Pinned Undici connection and bounded response decoder.

## Dependencies on other libs
- `clock`
- `http-client`

## New build or OSS wrapper
New build using `ip-address` `10.7.5` and the Undici controls exposed by `http-client`.

## Hosted by
`article-reader` jobs in `services/personal-reader`.

## Configuration
- `article.timeout_ms` — **optional**, default `20000`.
- `article.dns_timeout_ms` — **optional**, default `5000`.
- `article.max_response_bytes` — **optional**, default `5000000`.
- `article.max_redirects` — **optional**, default `5`.
- `article.allowed_protocols` — **optional**, default `["https", "http"]`.
- `article.allowed_ports` — **optional**, default `[80, 443]`.
