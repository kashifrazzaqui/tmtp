# Hacker News Account Library Spec

## Purpose and responsibility

Provide optional, best-effort access to authenticated Hacker News HTML. The package validates a supplied session, reads current vote/favorite state, conditionally reads flag state, discovers fresh action forms, executes user-requested actions, and verifies their resulting state where supported.

This is an unofficial HTML adapter, not a supported HN API and not a guarantee that account integration is available. Public HN ingestion and the local reader remain usable without it. The package does not read secret files, persist intents or observations, create historical activity events, schedule reconciliation, initiate actions autonomously, or expose a browser automation runtime.

## Public interface / API surface

The package root is `@tmtp/hn-account`. It has no default export or subpath exports.

```ts
export type AccountCapabilityName =
  | "upvoted"
  | "favorites"
  | "flagged"
  | "mutations";

export type AccountCapabilityState =
  | "available"
  | "unavailable"
  | "unverified";

export interface AccountCapability {
  name: AccountCapabilityName;
  state: AccountCapabilityState;
  reason?: HnAccountErrorCode;
}

export interface AccountObservation {
  storyId: number;
  kind: "upvote" | "flag" | "favorite";
  present: boolean;
  observedAt: import("@tmtp/domain").IsoDateTime;
}

export interface AccountObservationPage {
  observations: AccountObservation[];
  nextCursor?: string;
}

export interface HnActionResult {
  intentId: string;
  status: "verified" | "indeterminate" | "failed";
  observedAt: import("@tmtp/domain").IsoDateTime;
  errorCode?: HnAccountErrorCode;
}

export interface HnAccountOptions {
  baseUrl: string;
  http: import("@tmtp/http-client").HttpClient;
  clock: import("@tmtp/clock").Clock;
  sleep: import("@tmtp/clock").Sleep;
  username: string;
  sessionCookie: string;
  maxRequestsPerMinute: number;
  flagReadbackEnabled?: boolean; // defaults to false
}

export interface HnAccount {
  capabilities(signal?: AbortSignal): Promise<AccountCapability[]>;
  validateSession(signal?: AbortSignal): Promise<{ username: string }>;
  readUpvoted(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<AccountObservationPage>;
  readFavorites(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<AccountObservationPage>;
  readFlagged(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<AccountObservationPage>;
  performAction(
    intent: import("@tmtp/domain").HnActionIntent,
    signal?: AbortSignal,
  ): Promise<HnActionResult>;
}

export type HnAccountErrorCode =
  | "invalid-input"
  | "invalid-cursor"
  | "capability-disabled"
  | "capability-unverified"
  | "session-expired"
  | "username-mismatch"
  | "invalid-request"
  | "origin-policy"
  | "redirect-limit"
  | "invalid-redirect"
  | "http-status"
  | "response-too-large"
  | "timeout"
  | "transport"
  | "parse-failed"
  | "action-unavailable"
  | "action-conflict"
  | "post-outcome-unknown"
  | "verification-unavailable"
  | "cancelled-after-dispatch"
  | "client-closed";

export class HnAccountError extends Error {
  readonly name: "HnAccountError";
  readonly code: HnAccountErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly storyId?: number;
  constructor(code: HnAccountErrorCode, details?: {
    status?: number;
    storyId?: number;
  });
}

export function createHnAccount(options: HnAccountOptions): HnAccount;
```

Runtime exports are exactly `createHnAccount` and `HnAccountError`. Type exports are exactly the other names shown above. No Cheerio, Undici, Cookie, form, or response type escapes the package.

`HnActionResult.errorCode` is absent for `verified` and present for `failed` and `indeterminate`. `observedAt` is the local time at which the supplied outcome or observation was established. It is never a claim about when HN applied an action.

## Construction, credentials, and ownership

`createHnAccount` validates and snapshots options synchronously. Wrong types throw `TypeError`; invalid values throw `RangeError`. Messages name the option but never echo the cookie, a credential-bearing URL, or another supplied secret. Construction performs no network request and starts no timer.

- `baseUrl` is an absolute HTTP(S) origin with no credentials, query, fragment, or path other than `/`. HTTPS is required except that HTTP is accepted for a loopback hostname so local fixtures can run. The normalized origin is the only origin to which this adapter sends the session cookie.
- `http`, `clock`, and `sleep` must satisfy their upstream contracts. The service supplies a dedicated account `HttpClient` whose retry policy has `maxAttempts=1`, making one public request equal one wire attempt even for GET. The caller retains ownership; `HnAccount` has no `close` method and never closes it.
- `username` is a non-empty, trimmed string of at most 128 UTF-16 code units with no control characters. It is compared exactly and case-sensitively with the authenticated account identity; the adapter does not infer identity from the cookie.
- `sessionCookie` is the exact value of HN's `user` cookie, not a complete `Cookie` header and not a file path. It must be non-empty and contain no CR, LF, NUL, other control characters, or semicolon. Validation does not trim or otherwise transform the value. Requests construct exactly one `Cookie: user=<sessionCookie>` header.
- `maxRequestsPerMinute` is a safe integer in `1..600`.
- `flagReadbackEnabled` must be a boolean when supplied and defaults to `false`. The service applies the configuration default before construction or relies on this same library default.

The service reads `hn.session_cookie_path` and passes only the loaded value to this factory. Secret-file newline removal, file permissions, and file errors belong to the service's secret loader. This package keeps the value only in its private request-policy closure. It never logs, hashes, persists, returns, or includes it in an error, cursor, observation, capability, or action result.

## Request, throttling, and cancellation contract

All network operations use the injected `HttpClient` with a finite deadline inherited from `http.timeout_ms`, a fixed maximum buffered response size of `5_000_000` bytes, and no request or response body logging. The size bound is an internal compatibility constant, not a new configuration key. Requests ask for HTML without opting into content encoding. Responses must decode as UTF-8 HTML; malformed encoding or unsupported content type is `parse-failed`.

- Authenticated GETs use `redirect: "manual"` and a local walker for `301`, `302`, `303`, `307`, and `308`. Each followed hop is a new throttled GET with the same cookie only after the URL policy below proves the configured origin and allowed path. Require exactly one valid `Location`, follow at most five hops per high-level read, reject a sixth as `redirect-limit`, and keep GET/bodyless semantics. A redirect without `Location` is handled as the final response. Automatic same-origin redirect mode is not used because its hops would bypass individual throttle reservations.
- Mutation POSTs use `redirect: "manual"`. A redirect is never followed and can never cause a second POST or a POST-to-GET mutation fallback.
- POST uses `application/x-www-form-urlencoded` and a body snapshot built from the freshly parsed form. The upstream client forces one attempt for POST. This package adds no retry loop around any request.
- A caller may retry a failed GET through a new public method call. A caller may repeat an indeterminate action only through the reconciliation-first action flow below.

One per-instance asynchronous lane serializes complete public operations, including all GETs, POSTs, verification reads, and throttle waits belonging to an operation. Different account instances do not share the lane. This prevents two actions on one session from interleaving discovery and verification. It does not provide cross-process serialization; the service runs one process by design.

Before every HTTP call, the lane applies a sliding 60,000 ms window using `clock.monotonicNowMs()`. If `maxRequestsPerMinute` calls have started inside the window, it awaits `sleep` until the oldest relevant start leaves the window, then rechecks. There is no background timer while idle. Because the dedicated account client disables GET retries and POST is always single-attempt, the limit counts exact wire attempts; no hidden retry bypasses it.

For read/session/capability methods, caller cancellation rejects with the exact `signal.reason`, matching `http-client`; it is not converted to `HnAccountError`. Cancellation while queued or throttled starts no request. Cancellation before invoking the action POST's `HttpClient.request` likewise rejects with the exact reason and leaves the caller's durable intent pending. That invocation is the conservative dispatch boundary: once it has been called, cancellation produces `HnActionResult(status="indeterminate", errorCode="cancelled-after-dispatch")` even if the client subsequently proves that validation/close/pre-cancellation prevented wire I/O. The adapter does not claim a physical dispatch acknowledgment that `HttpClient` does not expose; indeterminate conservatively records that the boundary was crossed without asserting that HN applied the action.

Settlement removes operation-local abort listeners and leaves no HN-owned sleep or queued continuation. A non-cooperative custom HTTP transport or `Sleep` retains the upstream limitation that arbitrary work cannot be forcibly stopped.

## HTML and same-origin parsing boundary

Every HTML page, action target, cursor, and form field is untrusted input. Cheerio parses a bounded string without executing scripts, loading subresources, or evaluating event handlers. Parsing is versioned private behavior; fixture compatibility does not constitute a claim that live HN currently supports a capability.

The parser accepts only structural patterns covered by authenticated fixtures. It does not use a bare missing element as proof of false state. Required story IDs must be safe positive integers. Duplicate story rows within one page, ambiguous action controls, unexpected multiple forms, unknown required fields, and inconsistent hidden story IDs are `parse-failed` or `action-conflict`, not guesses.

Every action URL and continuation URL must:

1. Resolve against the page's final URL with WHATWG URL rules.
2. Use the configured origin exactly after normalization, including protocol and effective port.
3. Contain no credentials or fragment.
4. Match the parser's allowed read/action path for the operation and the configured username where applicable.
5. Be at most 2048 UTF-16 code units.

Violations are `origin-policy` for cross-origin/credential targets and `invalid-cursor` or `parse-failed` for malformed or unexpected targets. The adapter never sends the cookie to a link merely because its text looks valid. URLs, query strings, CSRF tokens, hidden fields, HTML, and response bodies are never included in safe errors.

## Session and capability behavior

`validateSession` performs a read-only authenticated request. It succeeds only when the returned page contains positive evidence of the configured username. A login form, redirect to a login page, or anonymous page produces `session-expired`; positive evidence of a different account produces `username-mismatch`. Transport/status/parse failures use the error mapping below and do not get relabeled as an expired session.

`capabilities()` performs read-only probes, never a mutation. It returns all four capabilities in the order `upvoted`, `favorites`, `flagged`, `mutations`.

- `available` means the current instance successfully validated the session and parsed a live response for that capability. For `mutations`, every action kind must have produced a valid fresh form during this instance; this remains best-effort evidence, not eligibility for a particular future story.
- `unavailable` means a definitive response showed that the endpoint/account cannot use the capability, or flag readback is administratively disabled. Its `reason` identifies the safe cause.
- `unverified` covers disabled-by-default-but-not-live-tested behavior, missing prior mutation-form evidence, changed markup, ambiguous responses, and transient failures. In particular, `flagReadbackEnabled=true` permits a probe but does not itself establish `available`.
- When flag readback is disabled, `readFlagged` rejects `capability-disabled` before any request. When enabled, each successful authenticated page parse establishes readback only for the observations returned by that call.

No capability result asserts that HN endorses the integration or that future markup will remain unchanged.

## Current-state reads and reconciliation

`readUpvoted`, `readFavorites`, and an enabled `readFlagged` read one page. With no cursor they use the operation's canonical account-list path; with a cursor they issue only the exact validated continuation URL returned by an earlier page. Cursors are opaque to callers, unauthenticated, and contain no cookie or new secret. They are read-only URLs, not authorization tokens and not portable across accounts or operations.

A successful list page emits positive `present=true` observations in document order. All observations on one page share an `observedAt` taken after the complete page has been fetched and parsed. A page has at most one row per story. `nextCursor` is present only for one unambiguous valid continuation link; no continuation link means the end of the currently visible list.

Absence from a page is not evidence of `present=false`, because pagination, eligibility, and changing HN state can hide rows. A false observation is emitted only where a parser has positive, verified current-state evidence for that story, such as a supported per-story action-state control. Thus ordinary list reconciliation never converts an unlisted historical favorite/upvote/flag into a false state.

The composing `hn-ingestion`/store layer maps observations to `HnAccountState` and owns `firstObservedAt`, `lastObservedAt`, and `sourceCursor`. It must preserve an existing first-observation timestamp and advance last observation with the supplied `observedAt`. Reconciliation is a current-state upsert only:

- it does not infer when the user acted;
- it does not create an `ActivityEvent` with a fabricated `occurredAt`;
- it does not convert a list absence into a removal;
- it does not mark an intent verified without positive state evidence.

Pages are not a snapshot across requests. HN changes can duplicate or omit rows between pages; store upserts must be idempotent by `(username,storyId,kind)`, and callers must not claim a point-in-time complete account history.

## Action contract and outcome state machine

Only `reader-app` may originate the durable `HnActionIntent` after an explicit user command. This package validates the intent but cannot prove user intent or persistence itself. The caller must commit the intent before invoking `performAction` and persist the returned result afterward. `hn-account` adds no storage dependency.

Input must pass the domain schema, have a non-empty ID/idempotency key, and have status `pending` or `indeterminate`. A `verified` or `failed` intent is not silently re-executed; it produces `action-conflict`. Concurrent calls with the same intent ID, idempotency key, story ID, action, and status share one in-flight execution and result. Reusing that ID with different content rejects `invalid-input`. The single-flight entry is removed at settlement and is not a persistent idempotency cache.

For each new execution:

1. **Re-read current state.** Fetch a fresh authenticated per-story page and require positive state evidence. If the requested state is already present, return `verified` without a POST. If it is conclusively absent, continue. If state is unknown, fail before dispatch with `capability-unverified`; never assume absence.
2. **Discover a fresh form.** From that same page, select exactly one eligible form for the intent's action and story. Require `method="post"`, a same-origin allowed action, the matching hidden story ID, and the parser-versioned anti-CSRF hidden field set. CSRF/auth values are opaque, single-discovery values and are never hard-coded, logged, cached for a later intent, or supplied by the caller.
3. **Snapshot and dispatch once.** Copy the allowlisted hidden fields in document order, reject duplicates or unexpected controlling fields, and issue one manual-redirect POST. There is no GET-mutation fallback and no automatic or caller-blind POST retry.
4. **Re-read after any potentially successful dispatch.** Verification uses a newly fetched page, not the POST response text alone. Return `verified` only when positive current-state evidence shows the requested state. An unchanged, absent, unknown, or unavailable readback is not success.

Before dispatch, expected action/session/eligibility failures return `failed` with a safe code and no POST. After dispatch:

- caller cancellation, transport failure, total timeout, response-size failure, redirect, 5xx, malformed success response, or any other uncertainty about whether HN accepted the request returns `indeterminate` (`post-outcome-unknown`, or `cancelled-after-dispatch` for caller abort);
- a definitive non-redirect 4xx rejection returns `failed` with `http-status`, `session-expired`, or `action-unavailable`, after any successful positive readback still takes precedence and returns `verified`;
- a completed 2xx exchange whose fresh readback proves presence returns `verified`;
- a completed exchange without positive proof returns `indeterminate` with `verification-unavailable`.

Flag actions require the same verified-state standard. With flag readback disabled or unverified, a flag POST cannot be reported as verified; if executed at all, its outcome remains indeterminate unless separate positive per-story flag-state evidence has been verified. The package never treats an HTTP 200 alone as proof.

A retry of an indeterminate intent starts again at step 1. Positive state closes it as verified without another POST; conclusively absent state permits one fresh form and one new POST; unknown state does not permit a POST. `failed` means no successful state was established for this attempt, not proof that HN definitely made no change.

## Safe error contract

`HnAccountError.message` is a fixed short message selected by `code`. It contains no supplied value, URL, username, cookie, header, form field, CSRF token, HTML, or dependency message. There is no public `cause`. `status`, when present, is only the numeric HTTP status; `storyId` is safe public metadata. Consumers branch on `code`, not messages.

| Code | Meaning | `retryable` |
|---|---|---:|
| `invalid-input` | Invalid intent, argument, or dependency result at the public boundary | false |
| `invalid-cursor` | Cursor is malformed, noncanonical, or for the wrong operation | false |
| `capability-disabled` | Flag readback is disabled by policy | false |
| `capability-unverified` | Required current-state/readback evidence has not been established | false |
| `session-expired` | HN returned an anonymous/login response | false |
| `username-mismatch` | Authenticated identity differs from configured username | false |
| `invalid-request` | The upstream client rejected the constructed request | false |
| `origin-policy` | A redirect/form/continuation target violates the configured origin policy | false |
| `redirect-limit` | A read requires more than five manually throttled redirect hops | false |
| `invalid-redirect` | A redirect target is malformed or ambiguous | false |
| `http-status` | A definitive non-success HTTP status was returned | status-dependent |
| `response-too-large` | The bounded HTML response was exceeded | false |
| `timeout` | The upstream total request deadline elapsed before action dispatch | true |
| `transport` | Transport failed before action dispatch | true |
| `parse-failed` | HTML, encoding, or supported structure could not be parsed | false |
| `action-unavailable` | The account/story is ineligible or no supported fresh action form exists | false |
| `action-conflict` | Intent state or form controls conflict with a safe execution | false |
| `post-outcome-unknown` | A POST was dispatched and its outcome is uncertain | false |
| `verification-unavailable` | A completed action attempt lacks positive readback proof | false |
| `cancelled-after-dispatch` | Caller aborted after the POST was dispatched | false |
| `client-closed` | The service closed the borrowed HTTP client before a read could run | false |

Before action dispatch and for all reads, `HttpError` maps exhaustively: `invalid-request→invalid-request`, `timeout→timeout`, `response-too-large→response-too-large`, `redirect-policy→origin-policy`, `redirect-limit→redirect-limit`, `invalid-redirect→invalid-redirect`, `transport→transport`, and `client-closed→client-closed`. No message or cause is copied and no response body is attached. After the POST invocation boundary, any of these failures without positive fresh readback instead yields `indeterminate` with `post-outcome-unknown` (or `cancelled-after-dispatch` for caller abort); this includes `client-closed` and pre-transport client rejection because the adapter deliberately treats invocation as the uncertainty boundary.

`429` and `503` have `retryable=true`; other `http-status` values are false unless the upstream status is `408`, `425`, `500`, `502`, or `504`, which are true for reads. `retryable=true` describes a later read only. Every later action attempt requires reconciliation first, and post-dispatch outcome codes always have `retryable=false`. Parse failures require markup/parser review rather than an immediate identical retry.

## Internal subcomponents

- Immutable configuration, cookie projection, same-origin URL policy, and safe error mapping.
- Serial operation lane, monotonic sliding-window throttle, cancellation, and same-intent single flight.
- Bounded UTF-8 HTML decoding and versioned Cheerio account/list/session parsers.
- Fresh per-story state/action-form parser and CSRF-hidden-field snapshot.
- One-shot POST coordinator, verification reads, and capability evidence tracking.
- Opaque continuation cursor validation and current-state observation mapping.

These are private modules, not public package subpaths.

## Dependencies on other libs

- `clock` — wall-clock observation timestamps, monotonic throttling, and cancellation-aware sleep.
- `domain` — `HnActionIntent`, action kinds, story IDs, and timestamp shapes.
- `http-client` — bounded buffered transport, total deadlines, manual GET/POST redirect responses, no-retry account composition, and single-attempt POST.

Cheerio `1.2.0` is the only third-party runtime dependency. There is no dependency on `reader-store`, `database`, `activity`, `hn-ingestion`, `reader-app`, configuration loaders, or a browser package.

## New build or OSS wrapper

New unofficial HTML adapter using Cheerio; no runtime browser automation and no direct Undici/SDK access.

## Hosted by

`reader-app` and optional `hn-ingestion` reconciliation in `services/personal-reader`. The service constructs the account adapter only when both account settings are present and retains ownership of the dedicated no-retry account HTTP client and secret files.

## Configuration

Existing keys and owners are unchanged:

- `hn.web_base_url` — **optional**, default `https://news.ycombinator.com`; normalized to the only permitted credential origin.
- `hn.username` — **optional**, default `null`; required with `hn.session_cookie_path` to enable account integration.
- `hn.session_cookie_path` — **optional**, default `null`; secret-file path, required with `hn.username`. The path is not passed to this package.
- `hn.max_requests_per_minute` — **optional**, default `10`; sliding-window limit on exact wire attempts per account instance.
- `hn.flag_readback_enabled` — **optional**, default `false`; permits best-effort flag probing but is not proof of capability.
- `http.timeout_ms`, backoff, jitter, and user-agent settings — inherited transport behavior for the dedicated account client. The service clones the general retry policy and overrides only `maxAttempts=1` for this composition; there is no separate operator key and the general client may still retry GETs.

No HN cookie value, CSRF token, HTML fixture path, action URL, response-size setting, or additional secret is centralized configuration.

## Acceptance-focused test expectations

### Public boundary, secrets, and transport

- `should validate and snapshot options without network work or echoing secret values`.
- `should send exactly the supplied user cookie only to the configured origin`.
- `should reject cross-origin credential-bearing and unexpected action or continuation targets before another request`.
- `should walk GET redirects manually with one throttle reservation per hop and reject a sixth hop as redirect-limit`.
- `should bound every HTML response and map safe fixed errors without HTML headers URLs cookies forms or dependency messages`.
- `should never log or return cookie CSRF hidden-field or response-body sentinels`.
- `should enforce the sliding request window with fake monotonic time and cancellation-aware sleeps`.
- `should use a dedicated no-retry client in service composition so throttled request counts equal exact wire attempts`.
- `should preserve exact caller abort reasons before dispatch and remove queued listeners and sleeps`.

### Parsers, capabilities, and reconciliation

- `should validate only positive authenticated username evidence and distinguish expired mismatched and transient sessions`.
- `should parse upvoted favorite and flagged fixtures with pagination and one observation timestamp per page`.
- `should reject duplicate ambiguous malformed and wrong-story controls instead of guessing`.
- `should never infer false current state from a missing list row or missing HTML element`.
- `should keep flag readback disabled by default and report it available only after an enabled successful authenticated parse`.
- `should report mutation capability from observed form evidence without claiming per-story eligibility`.
- `should reconcile repeated pages as current observations without inventing activity occurrence timestamps`.

Use versioned authenticated HTML fixtures for upvoted/favorites/flagged lists, anonymous/login responses, wrong-user pages, story action forms, CSRF fields, and current-state controls. Fixtures prove parser behavior only; an explicitly run non-CI live-account smoke check is required before reporting live flag or mutation support.

### Action safety and concurrency

- `should return verified without POST when reconciliation proves the requested state already present`.
- `should fetch a fresh CSRF form and issue exactly one form-encoded POST when state is conclusively absent`.
- `should never use a GET mutation fallback reuse a stale form or follow a POST redirect`.
- `should map POST timeout transport cancellation overflow redirect and 5xx outcomes to indeterminate`.
- `should require fresh positive readback before reporting any action verified`.
- `should re-read an indeterminate intent before any later POST and suppress the POST when state is now present`.
- `should refuse to POST when pre-action or retry state is unknown`.
- `should share identical concurrent intents reject conflicting reuse and serialize different operations`.
- `should return cancelled-after-dispatch when abort occurs after the one POST has started`.
- `should use POST request invocation as the conservative uncertainty boundary and map every HttpError code explicitly before dispatch and to indeterminate afterward`.
- `should keep separate account instances cookies throttles capabilities and in-flight intents isolated`.

### Workflow acceptance

For WF-01, startup can omit the adapter or degrade it without blocking stored reading, and no readiness/debug result contains the cookie. For WF-05, persist intent before the fake transport and outcome afterward; crash/timeout fixtures leave an explicit indeterminate outcome, later reconciliation closes it only from positive state, and no current-state observation creates a fabricated historical event.
