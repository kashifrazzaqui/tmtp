import { articleContentVersion, ArticleSchema } from "@tmtp/domain";
import type { Story } from "@tmtp/domain";
import { ArticleFetchError } from "@tmtp/article-fetcher";
import type { ArticleFetchErrorCode, FetchedArticle } from "@tmtp/article-fetcher";
import { ARTICLE_EXTRACTOR_VERSION, ArticleExtractionError } from "@tmtp/article-extractor";
import type { ExtractedArticle } from "@tmtp/article-extractor";
import { describe, expect, it, vi } from "vitest";
import { ARTICLE_READER_VERSION, ArticleReaderError, createArticleReader, resolveArticleOriginalTarget } from "../src/index.js";

const NOW = new Date("2026-07-01T00:00:00.000Z");
const UPDATED = NOW.toISOString();
function story(id = 1, changes: Partial<Story> = {}): Story {
  return {
    id, itemType: "story", url: "https://Example.com:443/article#intro", canonicalUrl: "https://example.com/article",
    title: "HN title", author: "hn-user", textHtml: "<p>HN self text</p>", publishedAt: "2026-01-01T00:00:00.000Z",
    firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: UPDATED, contentVersion: `story-v${id}`,
    raw: { id, type: "story", deleted: false, dead: false, raw: { id, type: "story" }, rawSchemaVersion: 1 },
    rawSchemaVersion: 1, deleted: false, dead: false, ...changes,
  };
}
function fetched(changes: Partial<FetchedArticle> = {}): FetchedArticle {
  return { sourceUrl: "https://example.com/article", finalUrl: "https://example.com/final", contentType: "text/html", html: "<article>external</article>", fetchedAt: "2026-06-30T00:00:00.000Z", ...changes };
}
function extracted(changes: Partial<ExtractedArticle> = {}): ExtractedArticle {
  return { title: "Extracted title", byline: "External author", excerpt: "Extract", text: "Readable text", sanitizedHtml: "<p>Readable text</p>", contentHash: "sha256:hash", extractorVersion: ARTICLE_EXTRACTOR_VERSION, ...changes };
}
function harness(extract = vi.fn(() => extracted())) {
  const fetcher = { fetch: vi.fn(async () => fetched()) };
  const now = vi.fn(() => NOW);
  const reader = createArticleReader({ fetcher, maxContentChars: 1234, maxInputBytes: 100_000, now, extract });
  return { reader, fetcher, now, extract };
}

describe("input targets and URL outcomes", () => {
  it("should validate construction and project safe original targets without network", () => {
    const h = harness();
    expect(() => createArticleReader({ fetcher: h.fetcher, maxContentChars: 0, maxInputBytes: 10, now: h.now })).toThrow(RangeError);
    expect(() => createArticleReader({ fetcher: h.fetcher, maxContentChars: 1, maxInputBytes: 10, now: h.now, extra: true } as never)).toThrow(TypeError);
    expect(resolveArticleOriginalTarget({ id: 2, url: "https://Example.com:443/a#b" })).toEqual({ kind: "original-page", url: "https://example.com/a" });
    for (const url of [undefined, "javascript:alert(1)", "https://user:pass@example.com/a", "bad"]) {
      expect(resolveArticleOriginalTarget({ id: 2, url })).toEqual({ kind: "hn-discussion", url: "https://news.ycombinator.com/item?id=2" });
    }
    expect(h.fetcher.fetch).not.toHaveBeenCalled();
    expect(ARTICLE_READER_VERSION).toBe(`article-reader-v1:${ARTICLE_EXTRACTOR_VERSION}`);
  });

  it("should fetch and extract once with exact provenance and a normalized original URL", async () => {
    const h = harness();
    const controller = new AbortController();
    const result = await h.reader.read(story(), controller.signal);
    expect(h.fetcher.fetch).toHaveBeenCalledWith("https://Example.com:443/article#intro", controller.signal);
    expect(h.extract).toHaveBeenCalledWith({ html: "<article>external</article>", sourceUrl: "https://example.com/final", maxContentChars: 1234 });
    expect(result).toMatchObject({
      outcome: "ready", originalUrl: "https://example.com/article",
      article: {
        storyId: 1, status: "ready", sourceContentVersion: "story-v1", sourceUrl: "https://example.com/article",
        finalUrl: "https://example.com/final", fetchedAt: "2026-06-30T00:00:00.000Z", title: "Extracted title",
        byline: "External author", textContent: "Readable text", sanitizedHtml: "<p>Readable text</p>", contentHash: "sha256:hash",
        extractorVersion: ARTICLE_READER_VERSION, updatedAt: UPDATED,
      },
    });
    if (result.outcome !== "ready") throw new Error("Expected ready.");
    expect(result.article).not.toHaveProperty("errorCode");
    expect(ArticleSchema.safeParse(result.article).success).toBe(true);
    expect(result.article.contentVersion).toBe(articleContentVersion(result.article));
  });

  it("should use the HN title only as fallback and snapshot a story across a pending fetch", async () => {
    let release!: (value: FetchedArticle) => void;
    const h = harness(vi.fn(() => extracted({ title: undefined, byline: undefined })));
    h.fetcher.fetch.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const source = story();
    const pending = h.reader.read(source);
    source.title = "Mutated title";
    source.contentVersion = "mutated-version";
    release(fetched());
    const result = await pending;
    expect(result).toMatchObject({ outcome: "ready", article: { title: "HN title", sourceContentVersion: "story-v1" } });
    expect(result.article).not.toHaveProperty("byline");
  });

  it("should map every fetch error safely without trying self-text", async () => {
    const cases: Array<[ArticleFetchErrorCode, string, boolean]> = [
      ["invalid-url", "fetch", false], ["invalid-request", "fetch", false], ["url-policy", "fetch", false],
      ["dns-timeout", "fetch", true], ["dns-failed", "fetch", true], ["address-policy", "fetch", false],
      ["timeout", "fetch", true], ["response-too-large", "fetch", false], ["redirect-limit", "fetch", false],
      ["invalid-redirect", "fetch", false], ["http-status", "fetch", true], ["unsupported-content-type", "unsupported-content", false],
      ["unsupported-charset", "unsupported-content", false], ["unsupported-content-encoding", "unsupported-content", false],
      ["invalid-content-encoding", "unsupported-content", false], ["invalid-text", "unsupported-content", false],
      ["transport", "fetch", true], ["client-closed", "fetch", false],
    ];
    for (const [code, category, retryable] of cases) {
      const h = harness();
      const sentinel = `secret-${code}`;
      h.fetcher.fetch.mockRejectedValue(new ArticleFetchError(code, { retryable, status: 503 }));
      const result = await h.reader.read(story());
      expect(result).toMatchObject({ outcome: "failed", originalUrl: "https://example.com/article", failure: { code, category, retryable } });
      if (result.outcome !== "failed") throw new Error("Expected failure.");
      expect(result.article.errorCode).toBe(code);
      expect(result.article.sourceContentVersion).toBe("story-v1");
      expect(result.article.extractorVersion).toBe(ARTICLE_READER_VERSION);
      expect(result.article).not.toHaveProperty("textContent");
      expect(result.article).not.toHaveProperty("contentHash");
      expect(result.article).not.toHaveProperty("finalUrl");
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(h.extract).not.toHaveBeenCalled();
    }
  });

  it("should retain fetch provenance after extraction failures and map all extraction codes", async () => {
    for (const code of ["invalid-input", "empty-content", "extraction-failed"] as const) {
      const h = harness(vi.fn(() => { throw new ArticleExtractionError(code, "secret-parser-message"); }));
      const result = await h.reader.read(story());
      expect(result).toMatchObject({
        outcome: "failed", failure: { code, retryable: false },
        article: { sourceUrl: "https://example.com/article", finalUrl: "https://example.com/final", fetchedAt: "2026-06-30T00:00:00.000Z", errorCode: code },
      });
      expect(JSON.stringify(result)).not.toContain("secret-parser-message");
    }
  });

  it("should use the HN discussion fallback for unsafe URL failures without exposing the source", async () => {
    const h = harness();
    h.fetcher.fetch.mockRejectedValue(new ArticleFetchError("invalid-url", { retryable: false }));
    const result = await h.reader.read(story(1, { url: "https://user:secret@example.com/private" }));
    expect(result.originalUrl).toBe("https://news.ycombinator.com/item?id=1");
    expect(result.article).not.toHaveProperty("sourceUrl");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("self-text and local limits", () => {
  it("should wrap and extract self-text without fetching or inventing fetch provenance", async () => {
    const h = harness();
    const result = await h.reader.read(story(2, { url: undefined, textHtml: "<p>Ask HN</p>" }));
    expect(h.fetcher.fetch).not.toHaveBeenCalled();
    const input = h.extract.mock.calls[0]?.[0];
    expect(input).toMatchObject({ sourceUrl: "https://news.ycombinator.com/item?id=2", maxContentChars: 1234 });
    expect(input?.html).toBe("<!doctype html><html><head><meta charset=\"utf-8\"></head><body><article><p>Ask HN</p></article></body></html>");
    expect(input?.html).not.toContain("HN title");
    expect(input?.html).not.toContain("hn-user");
    expect(result).toMatchObject({ outcome: "ready", originalUrl: "https://news.ycombinator.com/item?id=2", article: { sourceUrl: "https://news.ycombinator.com/item?id=2" } });
    expect(result.article).not.toHaveProperty("finalUrl");
    expect(result.article).not.toHaveProperty("fetchedAt");
  });

  it("should accept exactly-at-limit wrapped bytes and reject the first excess byte", async () => {
    const initial = harness();
    await initial.reader.read(story(2, { url: undefined }));
    const html = initial.extract.mock.calls[0]?.[0].html!;
    const bytes = Buffer.byteLength(html, "utf8");
    const exact = createArticleReader({ fetcher: initial.fetcher, maxContentChars: 1234, maxInputBytes: bytes, now: initial.now, extract: initial.extract });
    expect((await exact.read(story(2, { url: undefined }))).outcome).toBe("ready");
    const calls = initial.extract.mock.calls.length;
    const small = createArticleReader({ fetcher: initial.fetcher, maxContentChars: 1234, maxInputBytes: bytes - 1, now: initial.now, extract: initial.extract });
    const result = await small.read(story(2, { url: undefined }));
    expect(result).toMatchObject({ outcome: "failed", failure: { code: "source-too-large", category: "extraction", retryable: false }, originalUrl: "https://news.ycombinator.com/item?id=2" });
    expect(initial.extract).toHaveBeenCalledTimes(calls);
  });

  it("should return empty-content without extraction when both source fields are absent", async () => {
    const h = harness();
    const result = await h.reader.read(story(3, { url: undefined, textHtml: undefined }));
    expect(result).toMatchObject({ outcome: "failed", failure: { code: "empty-content", category: "empty-content" }, article: { sourceContentVersion: "story-v3", sourceUrl: "https://news.ycombinator.com/item?id=3" } });
    expect(h.extract).not.toHaveBeenCalled();
    expect(h.fetcher.fetch).not.toHaveBeenCalled();
  });

  it("should pass raw HN markup through the real sanitizer and resolve safe links", async () => {
    const h = createArticleReader({ fetcher: { fetch: vi.fn() }, maxContentChars: 500_000, maxInputBytes: 100_000, now: () => NOW });
    const source = `<p>Hello <a href="/relative">relative</a><a href="javascript:alert(1)">unsafe</a>${" readable".repeat(60)}</p><script>alert(1)</script>`;
    const result = await h.read(story(2, { url: undefined, textHtml: source }));
    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") return;
    expect(result.article.sanitizedHtml).toContain('href="https://news.ycombinator.com/relative"');
    expect(result.article.sanitizedHtml).not.toContain("javascript:");
    expect(result.article.sanitizedHtml).not.toContain("<script");
    expect(result.article.title).toBe("HN title");
    const empty = await h.read(story(3, { url: undefined, textHtml: "   " }));
    expect(empty).toMatchObject({ outcome: "failed", failure: { code: "empty-content" }, originalUrl: "https://news.ycombinator.com/item?id=3" });
  });
});

describe("dependency contracts and cancellation", () => {
  it("should reject invalid stories and pre-abort only after validation", async () => {
    const h = harness();
    const controller = new AbortController();
    const reason = { abort: true };
    controller.abort(reason);
    await expect(h.reader.read(story(1, { title: 4 as unknown as string }), controller.signal)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(h.reader.read(story(), controller.signal)).rejects.toBe(reason);
    expect(h.fetcher.fetch).not.toHaveBeenCalled();
    expect(h.now).not.toHaveBeenCalled();
  });

  it("should prefer cancellation over fetch and extraction outcomes", async () => {
    const controller = new AbortController();
    const reason = { abort: true };
    const h = harness();
    h.fetcher.fetch.mockImplementation(async () => { controller.abort(reason); return fetched(); });
    await expect(h.reader.read(story(), controller.signal)).rejects.toBe(reason);
    expect(h.extract).not.toHaveBeenCalled();
    const after = harness(vi.fn(() => { controller.abort(reason); return extracted(); }));
    await expect(after.reader.read(story(), controller.signal)).rejects.toBe(reason);
    expect(after.now).not.toHaveBeenCalled();
  });

  it("should reject malformed dependencies and invalid clocks but propagate infrastructure exceptions", async () => {
    const malformed = harness();
    malformed.fetcher.fetch.mockResolvedValue({ ...fetched(), finalUrl: 4 } as unknown as FetchedArticle);
    await expect(malformed.reader.read(story())).rejects.toBeInstanceOf(ArticleReaderError);
    expect(malformed.extract).not.toHaveBeenCalled();
    const version = harness(vi.fn(() => extracted({ extractorVersion: "old" as typeof ARTICLE_EXTRACTOR_VERSION })));
    await expect(version.reader.read(story())).rejects.toMatchObject({ code: "dependency-contract" });
    const invalidClock = createArticleReader({ fetcher: { fetch: async () => fetched() }, maxContentChars: 10, maxInputBytes: 100, now: () => new Date("invalid") });
    await expect(invalidClock.read(story())).rejects.toMatchObject({ code: "dependency-contract" });
    const thrown = new ArticleFetchError("transport", { retryable: true });
    const clock = createArticleReader({ fetcher: { fetch: async () => fetched() }, maxContentChars: 10, maxInputBytes: 100, now: () => { throw thrown; } });
    await expect(clock.read(story())).rejects.toBe(thrown);
  });
});
