# Hacker News Account Library Spec

## Purpose and responsibility
Provide optional authenticated HN HTML/session capabilities: session validation, current-state vote/favorite reconciliation, explicitly enabled flag readback, and user-initiated account actions.

## Public interface / API surface
```ts
export interface AccountCapability {
  name: "upvoted" | "favorites" | "flagged" | "mutations";
  state: "available" | "unavailable" | "unverified";
}

export interface AccountObservation {
  storyId: number;
  kind: "upvote" | "flag" | "favorite";
  present: boolean;
  observedAt: string;
}

export interface AccountObservationPage {
  observations: AccountObservation[];
  nextCursor?: string;
}

export interface HnActionResult {
  intentId: string;
  status: "verified" | "indeterminate" | "failed";
  observedAt: string;
  errorCode?: string;
}

export interface HnAccountOptions {
  baseUrl: string;
  http: import("@tmtp/http-client").HttpClient;
  clock: import("@tmtp/clock").Clock;
  username: string;
  sessionCookie: string;
  maxRequestsPerMinute: number;
  flagReadbackEnabled: boolean;
}

export interface HnAccount {
  capabilities(): Promise<AccountCapability[]>;
  validateSession(): Promise<{ username: string }>;
  readUpvoted(cursor?: string): Promise<AccountObservationPage>;
  readFavorites(cursor?: string): Promise<AccountObservationPage>;
  readFlagged(cursor?: string): Promise<AccountObservationPage>;
  performAction(intent: import("@tmtp/domain").HnActionIntent): Promise<HnActionResult>;
}

export function createHnAccount(options: HnAccountOptions): HnAccount;
```

Action links are fetched fresh from authenticated pages rather than hard-coded. Mutations require an existing user intent, are throttled, and verify resulting state. Indeterminate results are never reported as successful. Flag readback defaults to disabled until verified against a real account.

## Internal subcomponents
- Cookie/session and same-origin request policy.
- Cheerio parsers for items and fresh action links.
- Action verification, throttling, and capability reporting.

## Dependencies on other libs
- `clock`
- `domain`
- `http-client`

## New build or OSS wrapper
New unofficial HTML adapter using Cheerio `1.2.0`; no runtime browser automation.

## Hosted by
`reader-app` and optional `hn-ingestion` reconciliation in `services/personal-reader`.

## Configuration
- `hn.web_base_url` — **optional**, default `https://news.ycombinator.com`.
- `hn.username` — **optional**, default `null`; required with `hn.session_cookie_path` to enable account integration.
- `hn.session_cookie_path` — **optional**, default `null`; secret-file path, required with `hn.username`.
- `hn.max_requests_per_minute` — **optional**, default `10`.
- `hn.flag_readback_enabled` — **optional**, default `false`.
