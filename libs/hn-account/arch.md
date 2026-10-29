# Hacker News Account Architecture

## Architectural role

Implement `spec.md` as a tier-2 ESM adapter over `@tmtp/http-client`, `@tmtp/clock`, `@tmtp/domain`, and `cheerio@1.2.0`. Treat authenticated HTML as an unstable external protocol. Keep transport, parsing, current-state evidence, and mutation certainty separate so a successful HTTP exchange cannot be mistaken for a verified account action.

The package has no storage or activity dependency. Its outputs are observations and attempt outcomes; `hn-ingestion`, `reader-app`, and `reader-store` own durable reconciliation and historical activity decisions.

## Internal decomposition

These are package-private modules, not additional public entry points:

| Module | Owns | Must not contain |
|---|---|---|
| `options` | Factory validation, immutable origin/account/policy snapshots | Secret-file reads, network work, logging |
| `cookie` | Exact `user` cookie-header projection | Cookie parsing, persistence, error interpolation |
| `errors` | Fixed safe messages, upstream status/error mapping | HTML, URLs, headers, form values, raw causes |
| `lane` | FIFO operation serialization, same-intent single flight, cancellation checkpoints | Parser or persistence policy |
| `throttle` | Monotonic sliding-window request starts and abortable waits | Wall-clock arithmetic, background timers |
| `transport` | Bounded GET/POST construction, redirect policy, UTF-8 HTML decoding | Direct Undici access, automatic POST retry |
| `urls` | Same-origin/path/credential checks and cursor canonicalization | Credential forwarding, arbitrary link following |
| `account-html` | Session identity and list/continuation parsing | Browser execution, subresource loading |
| `action-html` | Positive per-story state controls, fresh POST forms, hidden-field allowlists | Hard-coded CSRF values, missing-element false inference |
| `observations` | Current-state rows and local observation timestamps | Activity occurrence timestamps, historical event creation |
| `actions` | Reconcile/discover/dispatch/verify state machine and outcome classification | Durable intent claims, blind retry |
| `capabilities` | Per-instance evidence and safe availability projection | Live-support guarantees |
| `index` | Exact public exports and factory composition | Additional convenience API |

Parser-version constants stay private. Changing accepted markup, hidden-field semantics, or current-state evidence requires new fixtures and a parser-version review even though those constants do not appear in persisted domain records.

## Request policy and credential containment

The factory stores a normalized origin and the exact cookie value in a private closure. Every request is constructed from that closure immediately before calling `HttpClient.request`; no request journal, result, or error retains the header record after the upstream call needs it.

The URL module resolves only parser-produced continuation/action values against the current final page URL. It compares normalized origins, strips no meaningful query values, and checks operation-specific paths. The cookie module is called only after this check. This order prevents an attacker-controlled form from causing a credentialed request before policy rejection.

GET and POST deliberately use different transport policies:

- GET uses manual redirects and no retries: the dedicated account client is constructed with `maxAttempts=1`. A local walker applies URL/origin/path policy and the throttle before each of at most five followed hops, so every wire request gets its own reservation and the cookie remains on one normalized origin.
- POST uses manual redirects and the upstream single-attempt policy. A 301/302/303/307/308 response ends the attempt as uncertain; no code follows it or converts the action to GET.

All responses pass through the upstream byte limit and a local fatal UTF-8 decoder before Cheerio sees them. No response helper decompresses, executes, renders, or loads resources. The adapter has no logger dependency; upstream HTTP logs contain only their allowlisted origin/status metadata.

## Serialized operation lane

One account instance owns a FIFO promise lane and an in-flight intent map. A public operation enters the lane only after argument validation and pre-cancellation checks. Its complete sequence of throttle waits, HTTP calls, and verification reads remains in that lane. Pure parsing may run inside the same operation; it does not open a second network operation.

The lane provides two different guarantees:

1. Different operations cannot interleave requests on one account, so form discovery and verification have a defined local order.
2. An identical concurrent intent joins the existing execution instead of obtaining a second form and POST.

The intent map key is the intent ID. Equality includes idempotency key, story ID, action, and status. A conflicting call rejects rather than joining. The entry is deleted in `finally`; no indefinite result cache or cross-restart idempotency claim exists.

FIFO is a fairness policy, not a real-time guarantee. A long non-cooperative transport can delay later operations, while caller cancellation removes queued/throttled work before its first request. Separate account instances have independent lanes and cookie closures; the single-process service should still avoid constructing multiple adapters for the same live account unless it accepts that their throttles are independent.

### Sliding-window throttle

Keep at most `maxRequestsPerMinute` monotonic start readings in the operation-lane state. Before each high-level `HttpClient.request`:

1. Remove readings at least 60,000 ms older than the current reading.
2. If fewer than the limit remain, append the current reading and start the call.
3. Otherwise compute the wait until the oldest reading leaves the window and call the injected `Sleep` with the operation signal.
4. Recheck time and cancellation after waking rather than assuming the delay was exact.

Wall-clock timestamps never determine eligibility or delay. Normal settlement and cancellation remove the abort listener; no periodic timer exists. The composition's no-retry account client makes this counter exact for both GET and POST; using the general retry-enabled client would violate the throttle contract.

## Parser and evidence model

### Session pages

The session parser requires positive authenticated identity evidence, not merely a 200 response or absence of a login form. It returns a small internal union such as:

```text
authenticated(configuredUsername)
authenticated(otherUsername)
anonymous
unsupported
```

Transport and status classification stays outside this union. Only the configured authenticated variant succeeds. This avoids converting a changed page into a false expired-session diagnosis.

### Account lists

Each list parser returns ordered positive observations and zero or one continuation. It validates the story ID, expected row structure, and operation-specific continuation. One page timestamp is assigned only after parsing completes.

List presence and current-state absence are intentionally asymmetric:

- a listed row proves that HN displayed the state at observation time;
- no row proves neither absence nor removal;
- a missing expected control never proves `present=false`.

A separate per-story parser can produce false state only from a positive supported control whose semantics are pinned by fixtures. That distinction flows into reconciliation and action prechecks, so neither component manufactures removal events from incomplete HTML.

### Fresh action forms

The action parser returns one internal discovery only when state and form evidence agree:

```text
{
  storyId,
  action,
  currentState: "present" | "absent",
  method: "post",
  target,
  fields: ordered allowlisted hidden fields,
  antiCsrfFieldNames: parser-versioned set
}
```

It rejects multiple matching forms, GET forms, cross-origin targets, duplicate controlling names, mismatched story IDs, missing CSRF material, and unknown fields that could change the operation. The hidden values remain opaque. The body builder uses `URLSearchParams` in document order and immediately hands the immutable string to the one-shot transport call.

No form is cached for a later intent. A new execution, including an indeterminate retry, always obtains new state evidence and a new form. A same-intent concurrent caller shares the original execution instead of reusing the form in another POST.

## Action certainty state machine

The action coordinator tracks whether dispatch has occurred. This one bit controls cancellation and error semantics.

```text
pending or indeterminate durable intent
  -> fresh state read
       present -> verified, zero POST
       unknown -> failed before POST, zero POST
       absent  -> fresh form discovery
                    invalid/unavailable -> failed before POST, zero POST
                    valid -> dispatch exactly one POST
                               |
                               +-- positive fresh readback -> verified
                               +-- definitive 4xx rejection -> failed
                               +-- timeout/transport/abort/redirect/5xx -> indeterminate
                               +-- no positive readback -> indeterminate
```

The coordinator marks dispatch immediately before invoking `HttpClient.request` for the POST. Invocation is the defined conservative uncertainty boundary, not a claim of physical socket dispatch. From that point onward, caller cancellation is converted to `cancelled-after-dispatch`; before that point it propagates the exact abort reason. Even an upstream pre-cancellation/client-closed rejection after invocation remains indeterminate unless fresh positive readback proves the state. This avoids pretending the upstream API provides a transport-started callback while still preventing shutdown or user cancellation from erasing a potentially attempted external effect.

A POST response is never the sole verification source. After any response that could represent acceptance, issue a fresh read through the same operation lane. Positive requested state wins over ambiguous transport/response interpretation. Otherwise preserve uncertainty rather than converting an HTTP status, an error page, or an unchanged page into success.

A later invocation with the durable indeterminate intent runs the same state machine from its first read. It does not carry forward a form, CSRF token, response body, or assumption that the previous request failed. Positive current state is both reconciliation and idempotent completion.

## Capability evidence

Keep per-instance evidence for successful list parsing and each action kind's fresh-form discovery. `capabilities()` revalidates the session and performs only read probes; it combines those results with existing form evidence. It never submits a form to learn availability.

The three states answer different questions:

- `available`: a concrete live response was parsed successfully;
- `unavailable`: policy or a definitive endpoint/account response says no;
- `unverified`: evidence is absent, stale, ambiguous, or transiently unavailable.

Flag enablement is only permission to probe. It is not evidence. Fixture suites likewise cannot set live capability. Any live verification tool must report observations back through the same capability model rather than flipping a persistent "supported" flag based on HN documentation.

## Reconciliation and timestamp ownership

The adapter calls `clock.now()` only after an observation/outcome has been established and converts that fresh date to the domain's UTC ISO representation. Monotonic readings never enter these records.

`observedAt` means "this adapter observed the state now." It is not `occurredAt`. Upper layers preserve `firstObservedAt` where a current-state row already exists, replace `lastObservedAt` with the new observation, and retain the source cursor. No HTML row supplies enough evidence to reconstruct historical activity time, so the adapter emits no `ActivityEvent` and no synthetic timestamp derived from story publication, intent creation, or page pagination.

## Design trade-offs

- **Serial account operations versus throughput.** One lane sacrifices parallel reads for deterministic throttling and safe action sequencing. The configured low request rate and optional integration make this acceptable. Parallel independent accounts would require separate service instances and a broader multi-tenant design.
- **Conservative absence versus automatic actions.** Requiring positive absent evidence before POST can block actions under changed markup. That is preferable to repeating an action whose earlier timeout already applied it.
- **Indeterminate after dispatch versus optimistic success.** More outcomes remain unresolved, but durable reconciliation can close them truthfully. Treating 200 as success would create false activity and false user feedback.
- **Manual POST redirects versus convenience.** A redirect could often be followed safely on one origin, but replaying a mutation adds ambiguity without improving the protocol. A fresh same-origin form should already name the correct target.
- **Parser allowlists versus permissive HTML extraction.** Allowlists need maintenance when HN changes. They also prevent hidden-field injection, wrong-story actions, and accidental mutation fallbacks.
- **Per-instance capability evidence versus persistent support flags.** Evidence is not shared across restarts, so probes repeat. In exchange, restart does not turn an old parser success into a permanent support claim.
- **Dedicated no-retry account transport versus shared general retry policy.** A second client configuration disables GET retries so the HN limiter counts exact wire attempts. The service owns and closes that client; general public/article transport can retain independent retry policy.

## Testing seams and verification design

Test through `createHnAccount` with a scripted `HttpClient`, fixed clock, and multi-pending fake `Sleep`. The HTTP fake records methods, normalized URLs, redirect modes, body snapshots, signals, and cookie presence while returning bounded byte responses. It supports deferred settlement to test aborts before/after dispatch and concurrent intent joining.

Use independent HTML fixtures rather than generating expected parse results with production selectors. Include current supported forms plus malformed, duplicated, cross-origin, wrong-user, wrong-story, missing-CSRF, unexpected-field, and missing-control variants. Assert exact request counts so a regression that adds a POST retry fails even if the final state looks correct.

The action suite uses a request journal with explicit phases:

1. initial state/form GET;
2. optional single POST with a deferred outcome;
3. optional fresh verification GET.

This makes timeout, cancellation, redirect, 4xx/5xx, invalid HTML, and reconciliation outcomes deterministic. Tests assert both the returned result and whether the POST journal is empty or contains exactly one request. Fake monotonic readings control throttling independently of wall-clock observation timestamps.

Loopback integration tests can use the real `http-client` to prove cookie origin containment, manual POST redirects, one-attempt timeout behavior, and response limits. Public HN is not a test dependency. Live-account smoke verification is explicit, read-only except for separately approved action tests, and never required for the ordinary suite; fixture success alone must not be reported as live flag support.
