# Batch C Retrospective — Integration libraries

## What worked well
- All five libraries implement the finalized contracts without changing the dependency graph or adding configuration keys.
- The article fetcher keeps URL/DNS policy, redirect pinning, transfer deadlines, decoded-size limits, and content decoding behind one safe boundary.
- Diagnostics projects explicit safe DTOs over real reader-store/job-queue reads. Its tests cover per-section failure isolation, keyset pages, redaction, payload budgets, and pull-based streaming.
- HN account actions follow reconciliation, fresh-form discovery, one-shot POST, and fresh readback. Request journals prove cancellation and uncertain-outcome behavior without live HN calls.
- The public HN client separates strict raw-item envelopes from pure story normalization. Golden tests pin story content versions and sparse tombstone behavior.
- Recommendation tests pin canonical prompts, Unicode truncation, evidence provenance, deterministic IDs, complete audit forwarding, cancellation, and complete queue composition.

## What didn't work or was harder than expected
- Diagnostics composition exposed that `job-queue.list` rejects reads above its configured batch size. The integration fixture now uses a bound above the diagnostics `limit + 1` maximum; service composition must do the same.
- Cheerio correctly requires valid table structure for account-list fixtures. Fixing the fixtures avoided weakening the parser.
- The domain ISO timestamp refinement can throw `RangeError` from `safeParse` for malformed values. The public story-normalization boundary converts that known validation failure to `invalid-input` while allowing unexpected exceptions to propagate.
- `llm-interface.JsonSchema` requires `type`, but the specified evidence-value `anyOf` node has no `type`. A local type accommodation preserves the exact public JSON Schema rather than changing the contract.
- TypeScript 7.0.2 still provides no session LSP server; package and root compiler builds remained the diagnostic path.

## What we learned that changes our understanding of later batches
- Batch D must configure job-queue read batches for diagnostics and keep HN/article/LLM calls outside SQLite transactions.
- Ingestion must preserve the public normalizer's distinction between missing items, non-story items, and sparse tombstones, and supply previous stories when needed.
- Personalization must persist every recommendation audit once, link judgments to the final successful call, and persist partial cancelled work without marking the run complete.
- Reader-app must persist an HN intent before calling `performAction`, persist the returned outcome afterward, and reconcile indeterminate intents before another POST.
- Live HN HTML/account/readback behavior remains unverified. Fixture success is not a claim of live flag or mutation support.

## Concrete changes to make
- Reuse the real SQLite diagnostics fixture, scripted HN request journals, and fake LLM attempt histories in Batch D/E composition tests.
- Keep the conservative POST invocation boundary and fresh readback requirement unchanged in reader-app.
- No spec, architecture, dependency-order, or finalized decision changes were required from this batch.

## Workflow coverage at this layer
- WF-01 checks cover external-failure separation, capability projection, optional account validation, and secret-free health/debug output. Full startup remains for Batch F.
- WF-02 checks cover official endpoint shapes, raw-item preservation, deterministic first-observation/content versions, and score-only refresh stability. Durable ingestion arrives in Batch D.
- WF-03/WF-06 checks cover complete queue delegation, blacklist retention, profile/content/model explanation keys, deterministic recommendation IDs, and evidence-backed judgments.
- WF-04 checks cover arbitrary-URL SSRF policy, redirect pinning, cancellation, decoded-size limits, and safe article content boundaries. Article composition arrives in Batch D.
- WF-05 checks cover current-state reads, disabled flag readback, fresh CSRF forms, single POST dispatch, indeterminate outcomes, and reconciliation-first retries.
- WF-08 checks cover readiness/capabilities, authenticated-debug policy primitives, safe DTOs, real SQLite pages, redaction, payload suppression/budgets, and pull-based debug frames. HTTP/UI hosting remains for Batch F.
- All applicable checks were offline and deterministic; no uncontrolled external network calls were used.

## Verification
- `pnpm build`: all 22 Batch A–C package builds passed serially.
- `pnpm test`: all 22 package suites passed; 364 tests total, including 84 Batch C tests.
- Batch C totals: `article-fetcher` 19, `diagnostics` 17, `hn-account` 19, `hn-public-api` 14, and `recommendations` 15.
- LSP: unavailable for the same pinned TypeScript reason recorded in earlier batches; compiler builds passed instead.
