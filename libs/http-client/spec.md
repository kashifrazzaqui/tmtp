# HTTP Client Library Spec

## Purpose and responsibility
Provide a narrow asynchronous HTTP boundary with timeouts, cancellation, bounded retry, response limits, structured error categories, and redacted logging.

## Public interface / API surface
```ts
export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxResponseBytes?: number;
  redirect: "manual" | "same-origin";
  connection?: {
    address: string;
    port: number;
    servername: string;
  };
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string[]>;
  body: Uint8Array;
  finalUrl: string;
}

export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface HttpClientOptions {
  clock: import("@tmtp/clock").Clock;
  timeoutMs: number;
  userAgent: string;
  retryPolicy: import("@tmtp/retry").RetryPolicy;
  logger: import("@tmtp/logging").Logger;
}

export function createHttpClient(options: HttpClientOptions): HttpClient;
```

Redirect behavior is explicit. Fixed-origin HN calls may allow same-origin redirects. For arbitrary article calls, `article-fetcher` supplies a validated `connection`; the dispatcher pins that address while preserving `servername` for TLS/SNI, and every redirect is revalidated.

## Internal subcomponents
- Undici request/dispatcher adapter.
- Timeout/body-limit handling and retry classification.
- Redacted request/response metadata logging.

## Dependencies on other libs
- `clock`
- `logging`
- `retry`

## New build or OSS wrapper
New wrapper around Undici `8.12.3`.

## Hosted by
HN clients and `article-fetcher` in `services/personal-reader`.

## Configuration
- `http.timeout_ms` — **optional**, default `20000`.
- `http.retry.max_attempts` — **optional**, default `3`.
- `http.retry.base_delay_ms` — **optional**, default `500`.
- `http.retry.max_delay_ms` — **optional**, default `8000`.
- `http.retry.jitter_ratio` — **optional**, default `0.2`.
- `http.user_agent` — **optional**, default `tmtp-personal-reader/0.1`.
