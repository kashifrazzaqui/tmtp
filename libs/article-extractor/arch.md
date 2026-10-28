# Article Extractor Architecture

## Architectural role

`article-extractor` is a tier-0, synchronous untrusted-HTML transformation library. It wraps Readability, jsdom, and DOMPurify behind one narrow function while keeping network policy, domain persistence, and fallback orchestration outside the package.

The architecture optimizes for three properties in order: no active untrusted content, reproducible output, and isolation between calls. Fidelity to the original page layout is secondary.

## Internal module decomposition

These are package-internal modules, not additional workspace libraries or public exports.

| Module | Responsibility | Important collaborators |
|---|---|---|
| `index` | Public exports and top-level extraction pipeline | All internal stages |
| `input` | Runtime checks for `ExtractArticleInput`; safe `invalid-input` errors | Platform `URL` parser |
| `errors` | `ArticleExtractionError` and exception-to-safe-error boundary | No third-party types in the public error |
| `inert-dom` | Construct and dispose source/fragment jsdom windows; prohibit resource loading | jsdom |
| `readability` | Invoke Readability and normalize its metadata | `@mozilla/readability`, inert DOM |
| `content-dom` | Parse the readable fragment, remove dangerous subtrees, and apply the readable-text budget | Inert DOM |
| `sanitize` | Apply the exact HTML element/attribute profile and DOM-clobbering defenses | DOMPurify bound to the fragment window |
| `urls` | Resolve and validate surviving URL attributes against `sourceUrl` | Platform `URL` parser |
| `text` | Derive and normalize readable text; enforce non-empty content and final budget | Sanitized fragment DOM |
| `hash` | Hash normalized UTF-8 text | `node:crypto` |

The allowlists and text/URL normalization rules have one owning module each. The pipeline must not duplicate a second sanitizer profile or a second truncation implementation.

## Data and control flow

```text
ExtractArticleInput
  -> runtime validation
  -> inert source document (sourceUrl as base)
  -> Readability article candidate + metadata
  -> inert readable-fragment document
  -> dangerous-subtree removal
  -> DOM text-node truncation
  -> DOMPurify HTML sanitization
  -> safe absolute URL normalization
  -> final readable-text derivation and normalization
  -> body-innerHTML serialization
  -> SHA-256(text)
  -> ExtractedArticle
```

The controller checks for a Readability result before fragment processing and for readable text after sanitization. Every exit passes through the safe-error boundary and per-call DOM cleanup. URL normalization runs on already sanitized attributes and creates only URL-parser-approved values; it never copies an unchecked source attribute back into the output.

Metadata and body processing are separate branches after Readability. Metadata follows inline-text normalization. Body content follows truncation, sanitization, text normalization, serialization, and hashing. The hash is computed last from exactly the returned `text`, not from an intermediate buffer.

## Dependency use and isolation

### jsdom

Each extraction uses fresh jsdom instances with scripts disabled and a resource loader that performs no loads. The source URL is parser configuration only. Fragment parsing is also inert even though its input came from Readability.

A per-call `try/finally` cleanup closes every created window. No jsdom window is installed as a Node global. This avoids cross-call base-URL state, DOM globals, and resource retention.

### Mozilla Readability

Readability alone chooses the article candidate and supplies title, byline, excerpt, and readable content. The package does not add a second site-specific selector system or fetch page data to improve extraction.

Readability sees untrusted markup only inside the inert source DOM. Its output is not trusted: the readable fragment goes through dangerous-subtree removal and the full sanitizer.

### DOMPurify

DOMPurify is created against the per-call fragment window and configured with the spec's HTML-only allowlists and DOM-clobbering protections. Its output remains inside the inert fragment until detached strings are returned.

The package uses one sanitizer pass at a defined pipeline point. URL normalization does not introduce raw HTML; it changes only validated URL attributes on the sanitized DOM.

### Node cryptography

`node:crypto` supplies SHA-256. The final normalized string is encoded once as UTF-8 and formatted as the specified lowercase hexadecimal digest. No random identifier, clock, persistence hash helper, or external crypto package is needed.

## Design tradeoffs

### Synchronous API

Readability and DOMPurify are synchronous, so the public function is synchronous rather than exposing a promise that still blocks the event loop. This keeps composition simple and deterministic. The cost is that a caller cannot cancel an active call and large documents consume the calling thread; input bounds belong at the fetch/composition boundary.

### Fresh DOM per call

Fresh windows and sanitizer state cost more than a shared worker-like DOM pool. Pooling would complicate cleanup, base-URL isolation, and use across worker threads for no established product need. Per-call state is the safer initial design.

### Restrictive reader profile

The allowlist preserves common article structure, code, quotations, tables, and simple images. It intentionally drops forms, embedded media, styles, classes, SVG, and responsive-image attributes. This loses page-specific presentation and some rich figures in exchange for a small, testable security surface.

### Text-budget truncation

Bounding DOM text nodes makes the output limit independent of markup size and avoids cutting serialized HTML through a tag. It is lossy and can drop later figures or sections. The alternative—returning an oversized article or rejecting it—would either violate resource policy or make long articles unavailable in the embedded reader. The original-page fallback remains a composition responsibility.

### Text-only content hash

Hashing normalized text avoids invalidating recommendation inputs for safe markup-only differences. The tradeoff is that the hash does not identify `sanitizedHtml` byte-for-byte. `extractorVersion` is therefore mandatory provenance, and sanitizer or serialization changes require a version change.

### Sanitize after Readability

Sanitizing only the original document could change the nodes Readability selects and still would not make Readability's newly serialized fragment automatically trustworthy. The chosen order preserves Readability behavior and places the security boundary immediately before returned markup. Inert parsing protects the earlier stage from active content.

## Testing seams

The public `extractArticle` function is the primary acceptance seam. Internal modules are small enough for focused unit tests without adding test-only exports to the package API.

| Seam | Test use |
|---|---|
| `input` | Table-driven runtime validation and safe messages |
| `inert-dom` | Script/resource-loading traps and cleanup on thrown extraction |
| `readability` wrapper | No-result and metadata-normalization fixtures |
| `content-dom` | Exact budget, multi-node truncation, Unicode boundaries, dangerous-subtree removal |
| `sanitize` and `urls` | Adversarial HTML and exact URL matrices using real DOMPurify |
| `text` and `hash` | Golden normalization and independently computed digests |
| Public pipeline | End-to-end fixture, deterministic output, concurrency isolation, and WF-04 acceptance |

Tests must use real parser and sanitizer dependencies for security and acceptance cases. Only external effects—network access, script execution, and resource loading—are instrumented or trapped. No network fixture should be implemented by letting jsdom fetch real remote content.

## Dependency and change boundaries

The package has no internal library dependencies and remains at tier 0. New behavior must not introduce imports from higher-tier article, domain, configuration, or service packages.

A future site-specific extraction layer, browser rendering fallback, network loader, or persistence cache would be a separate component decision, not an extension of this package's internal modules.
