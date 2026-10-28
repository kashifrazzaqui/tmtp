# Article Extractor Library Spec

## Purpose and responsibility

Transform one untrusted HTML document into normalized article metadata, bounded readable text, and sanitized reader HTML. Extraction is synchronous, deterministic for a fixed extractor version, and has no network, storage, browser-rendering, scheduling, or retry responsibility.

`article-fetcher` owns URL fetching, response-size limits, redirects, and SSRF policy. `article-reader` maps this package's result into the domain model and supplies original-page fallback behavior. This package owns only the untrusted-HTML transformation.

## Public interface / API surface

```ts
export interface ExtractArticleInput {
  html: string;
  sourceUrl: string;
  maxContentChars: number;
}

export interface ExtractedArticle {
  title?: string;
  byline?: string;
  excerpt?: string;
  text: string;
  sanitizedHtml: string;
  contentHash: string;
  extractorVersion: typeof ARTICLE_EXTRACTOR_VERSION;
}

export type ArticleExtractionErrorCode =
  | "invalid-input"
  | "empty-content"
  | "extraction-failed";

export class ArticleExtractionError extends Error {
  readonly name: "ArticleExtractionError";
  readonly code: ArticleExtractionErrorCode;
  constructor(code: ArticleExtractionErrorCode, message: string);
}

export const ARTICLE_EXTRACTOR_VERSION: "1";

export function extractArticle(input: ExtractArticleInput): ExtractedArticle;
```

This is the complete public runtime surface. Internal DOM helpers, sanitizer profiles, normalization functions, and allowlists are not exported.

### Optional fields and nullability

- `title`, `byline`, and `excerpt` are optional properties. A missing or whitespace-only source value means the property is absent, not `null`, an empty string, or an explicitly present `undefined` value.
- Present metadata values are plain text, never HTML. Normalize them to Unicode NFC, collapse each run of Unicode whitespace to one ASCII space, and trim the result.
- `text`, `sanitizedHtml`, `contentHash`, and `extractorVersion` are always present non-empty strings on success.
- Error `cause`, raw parser errors, source HTML, and source URLs are not public error fields.

## Boundary validation

`extractArticle` validates the runtime input before invoking a third-party parser. TypeScript types alone are not a runtime boundary.

| Field | Runtime contract |
|---|---|
| `input` | Must be a non-null object. Unknown properties are ignored. |
| `html` | Must be a string. An empty or whitespace-only string proceeds to extraction and normally fails as `empty-content`. This package imposes no separate input-byte limit. |
| `sourceUrl` | Must be an absolute, syntactically valid `http:` or `https:` URL with no username or password. It is used only as a base URL and is never fetched. |
| `maxContentChars` | Must be a positive safe integer. Zero, negatives, fractions, `NaN`, infinities, and values above `Number.MAX_SAFE_INTEGER` are invalid. |

Invalid input throws `ArticleExtractionError` with code `invalid-input`. Validation failure messages name the invalid field but do not echo its value. The configured default is applied by the service configuration layer, not by this function.

The caller remains responsible for bounding input HTML before it reaches this package. For fetched articles, `article.max_response_bytes` provides that bound; `maxContentChars` bounds extracted text, not input HTML or serialized markup.

## Successful-result contract

### Readable content

1. Run Mozilla Readability against an inert document whose base URL is `sourceUrl`.
2. Remove non-content and active-content subtrees from the readable fragment.
3. Apply the text budget to readable DOM text nodes in document order.
4. Sanitize the bounded fragment and derive `text` from the sanitized DOM, so removed markup cannot contribute hidden text.
5. Serialize the sanitized fragment's body contents as `sanitizedHtml`; do not include outer `html`, `head`, or `body` tags.

Readability returning no article, or the final readable DOM containing no non-whitespace text, throws `empty-content`. Metadata alone does not make an otherwise empty article successful.

`text` is the fragment's textual content after these deterministic normalizations, in order:

- convert to Unicode NFC;
- convert CRLF and CR line endings to LF and non-breaking spaces to ASCII spaces;
- collapse runs of spaces, tabs, form feeds, and vertical tabs to one ASCII space;
- trim horizontal whitespace at each line boundary;
- collapse three or more consecutive LF characters to two;
- trim leading and trailing whitespace from the complete value.

Applying this same normalization to the sanitized fragment's text content must reproduce `text` exactly. Block-level markup may therefore affect line breaks, but tags and attributes never appear in `text`.

### Content budget and truncation

- `maxContentChars` is a budget in JavaScript UTF-16 code units for readable body text. Metadata and HTML markup do not count toward the budget.
- Normalize each readable text node to Unicode NFC before measuring it. Visit text nodes in document order and retain content until adding the next character would exceed the budget. Discard the remaining body text. Never emit an unpaired UTF-16 surrogate.
- Truncate before whole-document normalization. If final normalization would exceed the budget, reduce the retained DOM content and repeat final derivation. Successful output always satisfies `text.length <= maxContentChars` and the sanitized-DOM/text equivalence invariant.
- Truncation is successful, not an error, as long as non-empty readable text remains. Do not append an ellipsis or another marker that was not present in the source.
- The returned HTML must be well-formed after truncation and must represent only the retained content. It may exceed `maxContentChars` because tags and attributes are not part of that budget.
- If the budget ends before the first complete Unicode code point, the result is `empty-content` rather than invalid Unicode output.

Truncation is deliberately lossy. `article-reader` remains responsible for exposing the original-page fallback.

### Hash and version

- `contentHash` is `"sha256:"` followed by 64 lowercase hexadecimal characters: SHA-256 over the UTF-8 bytes of final normalized `text`, with no prefix, suffix, or trailing newline added.
- The hash covers text only. Equivalent readable text with different safe markup has the same hash; different text has a different hash except for cryptographic collisions.
- `extractorVersion` is exactly `ARTICLE_EXTRACTOR_VERSION`, currently `"1"`.
- Any release that changes extraction, allowlists, URL handling, truncation, text normalization, or serialization for the same input must change the extractor version. Callers must treat `(extractorVersion, contentHash)` as extraction provenance, not assume that a hash alone identifies every representation.

## Sanitization and URL security contract

### Inert parsing

Every source and readable-fragment DOM must be inert:

- inline and external scripts do not execute;
- event handlers do not execute;
- external resources, including images, stylesheets, fonts, frames, media, and prefetch-like resources, are never requested;
- no browser global, cookie jar, storage, credential, or network client is shared with the host application;
- `sourceUrl` supplies URL resolution only and never opts into navigation or loading.

Disabling script execution is not a substitute for sanitization. Sanitization always runs after Readability, including for HN self-text supplied by `article-reader`.

### HTML profile

Use DOMPurify's HTML-only profile. SVG, MathML, custom elements, and XML vocabularies are outside the profile.

The complete allowed element set is:

```text
a, article, b, blockquote, br, caption, cite, code, dd, del, div, dl, dt,
em, figcaption, figure, h1, h2, h3, h4, h5, h6, hr, i, img, ins, li, mark,
ol, p, pre, q, s, section, small, span, strong, sub, sup, table, tbody, td,
tfoot, th, thead, time, tr, u, ul
```

Allowed attributes are limited to:

| Element | Allowed attributes |
|---|---|
| `a` | `href`, `title` |
| `img` | `src`, `alt`, `title`, `width`, `height` |
| `blockquote`, `q` | `cite` |
| `ol` | `start`, `reversed`, `type` |
| `li` | `value` |
| `td`, `th` | `colspan`, `rowspan` |
| `time` | `datetime` |

No global `id`, `name`, `class`, `style`, `srcset`, `srcdoc`, `target`, `rel`, `data-*`, `aria-*`, event-handler, or other attribute is allowed. Apply these attribute value checks before serialization:

- `img[width]` and `img[height]` contain only ASCII digits and parse to a non-negative safe integer;
- `ol[start]` and `li[value]` contain ASCII digits with one optional leading `-` and parse to a safe integer;
- `td[colspan]`, `th[colspan]`, `td[rowspan]`, and `th[rowspan]` contain only ASCII digits and parse to a non-negative safe integer;
- `ol[type]` is exactly one of `1`, `a`, `A`, `i`, or `I`;
- `reversed` is present only as a boolean attribute, with no value required.

Remove attributes that fail these checks. DOMPurify DOM-clobbering protection must remain enabled even though `id` and `name` are already excluded.

Remove `script`, `style`, `iframe`, `frame`, `frameset`, `object`, `embed`, `applet`, `svg`, `math`, `template`, `noscript`, `link`, `meta`, `base`, `form`, `input`, `button`, `select`, `textarea`, `video`, `audio`, `source`, `track`, and `canvas` elements together with their complete subtrees. For other disallowed elements, unwrap the element and retain allowed descendants and text. Comments, processing instructions, and document-type nodes are omitted.

### URL attributes

- Resolve non-empty relative and root-relative references against `sourceUrl` with the platform URL parser, then serialize the resulting absolute URL.
- Protocol-relative references inherit the protocol from `sourceUrl`.
- Permit `http:` and `https:` for `a[href]`, `img[src]`, `blockquote[cite]`, and `q[cite]`. Additionally permit `mailto:` only for `a[href]`.
- Reject every other scheme, including `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, `ftp:`, and scheme-obfuscation variants that parse to a disallowed protocol.
- Reject HTTP(S) URLs containing embedded credentials and reject any reference that cannot be parsed.
- On rejection, remove only the unsafe attribute. Preserve the element and its readable text unless the element itself is disallowed.
- Do not add source-supplied link targets or relationships. No `target`, `rel`, `ping`, `download`, `referrerpolicy`, or `srcset` attribute survives.

`sanitizedHtml` is safe only as body markup under this contract. The service must still apply its reader CSP as defense in depth; this package does not emit or enforce CSP.

## Error and diagnostic contract

`extractArticle` returns a result or throws; it has no partial-success result.

| Code | Meaning |
|---|---|
| `invalid-input` | Runtime input violates the boundary contract. No parsing is attempted. |
| `empty-content` | Readability found no article, or no readable text remains after removal, sanitization, or truncation. |
| `extraction-failed` | Readability, DOM processing, sanitization, normalization, or hashing failed after valid input was accepted. |

All expected third-party exceptions are wrapped in `ArticleExtractionError` with `extraction-failed`; raw third-party exceptions do not escape. Error messages are stable, human-readable summaries and must not contain source HTML, extracted content, full URLs, URL credentials, or serialized DOM. Callers use `code`, not message matching, for control flow.

There is no `retryable` flag because extraction has no independent transient operation. The composition layer decides whether refetching or retrying a job is useful.

## Invariants, concurrency, and lifecycle

- The function has no network, filesystem, environment-variable, clock, random-number, or storage effects.
- Each call owns its DOM and sanitizer state. No mutable document, window, parser result, or output buffer is shared between calls.
- Calls in different worker threads, and reentrant calls made by host instrumentation, have no cross-call output or URL-base contamination. On any one JavaScript thread, a call's CPU work blocks that thread until it returns or throws.
- The synchronous API takes no `AbortSignal`. Callers cannot interrupt work already executing on that thread; they must bound input and isolate expensive work if their latency policy requires it.
- Per-call DOM resources are released on both success and failure. The package creates no timers, handles, subscriptions, or background tasks and needs no `close` method.
- A successful output is detached from all intermediate DOM objects. Mutating a caller-owned object after the call cannot change an already returned string.
- The same input and extractor version produce byte-for-byte identical `text`, `sanitizedHtml`, metadata, and hash.

## Internal subcomponents

- Runtime input validation and safe error normalization.
- Per-call inert jsdom document and readable-fragment creation.
- Mozilla Readability extraction and metadata normalization.
- Dangerous-subtree removal, readable-text budgeting, and text normalization.
- DOMPurify HTML profile, URL normalization, serialization, and content hashing.

The module design and dependency flow are specified in [arch.md](arch.md).

## Dependencies on other libs

None. `article-reader` maps this independent result into the domain `Article` type. This package must not import `article-fetcher`, `article-reader`, `domain`, `config`, or service code.

## New build or OSS wrapper

New wrapper around `@mozilla/readability` `0.6.0`, `jsdom` `30.1.3`, DOMPurify `3.4.17`, and Node's built-in SHA-256 support. No additional third-party policy or network library is required.

## Hosted by

`article-reader` jobs in `services/personal-reader`.

## Configuration

- `article.max_content_chars` — **optional**, default `500000`; positive safe integer supplied as `maxContentChars`. This package owns no other configuration key and reads no configuration source directly.

## Acceptance-focused test expectations

### Public behavior and boundaries

- A representative article returns normalized metadata, readable text, sanitized body HTML, the current version, and the documented hash; compare against a small checked-in fixture rather than only asserting non-emptiness.
- Missing and whitespace-only metadata properties are absent and never `null`. Metadata containing markup is returned only as plain text.
- Empty input, no Readability result, markup-only content, active-content-only content, and content fully removed by sanitization produce `empty-content`.
- Every invalid `sourceUrl` and `maxContentChars` case in the boundary table produces `invalid-input` before parser invocation. Non-string HTML and a null/non-object input are also rejected.
- Errors are instances of `ArticleExtractionError`, expose the expected code, and do not contain unique source-text or URL marker strings.

### Truncation, determinism, and hashing

- Test exact, over, and under budget boundaries, multi-node truncation, astral Unicode at the cut, and a budget smaller than the first code point. Output never contains an unpaired surrogate or exceeds the text budget.
- Truncated HTML reparses as well-formed markup and its normalized text equals the returned text.
- Independently compute SHA-256 for ASCII, non-ASCII, multiline, and truncated outputs and assert the exact `sha256:` value.
- Repeating the same call yields byte-identical output. Alternating calls with different base URLs and content remain isolated.

### Security

- Use a fixture containing scripts, external scripts, inline handlers, `javascript:` and mixed-case/encoded scheme variants, `data:` and `srcdoc` content, SVG/MathML, forms, frames, DOM-clobbering names/IDs, unsafe CSS, and disallowed attributes. Assert active subtrees and attributes are absent and inert readable text remains.
- Verify relative, root-relative, protocol-relative, absolute, malformed, credential-bearing, and disallowed-scheme references for every URL attribute. Only the documented absolute safe URLs survive; `mailto:` survives only on links.
- Instrument or stub all jsdom resource-loading entry points and use a loopback HTTP server as a network trap. Extraction performs zero requests and executes zero source scripts even when markup contains images, media, frames, stylesheets, and scripts.
- Reparse `sanitizedHtml` and assert it contains no disallowed element or attribute, no non-HTML namespace, and no unsafe URL. Do not rely solely on string matching for XSS tests.

### Workflow acceptance

- For WF-04, extraction of fetched HTML and HN self-text follows the identical sanitizer path, performs no network access, and produces content suitable for the reader CSP.
- A failed or empty extraction throws a typed error that `article-reader` can map to an extraction/empty-content failure without weakening the original-page fallback.

Behavioral tests use the real Readability, jsdom, and DOMPurify dependencies. Tests must not replace the sanitizer with a mock; that would remove the package's principal security evidence.
