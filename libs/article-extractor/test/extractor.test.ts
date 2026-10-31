import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  ARTICLE_EXTRACTOR_VERSION,
  ArticleExtractionError,
  extractArticle,
} from "../src/index.js";

const filler = " This readable sentence provides enough article content for deterministic extraction.".repeat(8);
const documentWith = (body: string, title = "Example title") =>
  `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${body}</article></body></html>`;
const extract = (body: string, maxContentChars = 500_000, sourceUrl = "https://example.com/path/article") =>
  extractArticle({ html: documentWith(body), sourceUrl, maxContentChars });

describe("extractArticle", () => {
  it("should return normalized metadata readable text sanitized body HTML version and exact hash", () => {
    const result = extract(`<p>Hello <strong>world</strong>.${filler}</p><p>Second&nbsp;paragraph.</p>`, 500_000);
    expect(result.title).toBe("Example title");
    expect(result.text).toContain("Hello world.");
    expect(result.text).toContain("Second paragraph.");
    expect(result.sanitizedHtml).toContain("<strong>world</strong>");
    expect(result.sanitizedHtml).not.toContain("<html");
    expect(result.sanitizedHtml).not.toContain("class=");
    expect(result.extractorVersion).toBe(ARTICLE_EXTRACTOR_VERSION);
    expect(result.contentHash).toBe(`sha256:${createHash("sha256").update(result.text, "utf8").digest("hex")}`);
    expect(Object.keys(result)).not.toContain("byline");
    expect(result.byline).toBeUndefined();
  });

  it("should produce byte-identical output and isolate alternating base URLs", () => {
    const html = documentWith(`<p><a href="/one">One</a>${filler}</p>`);
    const first = extractArticle({ html, sourceUrl: "https://one.example/a", maxContentChars: 500_000 });
    const second = extractArticle({ html, sourceUrl: "https://two.example/b", maxContentChars: 500_000 });
    const repeated = extractArticle({ html, sourceUrl: "https://one.example/a", maxContentChars: 500_000 });
    expect(repeated).toEqual(first);
    expect(second.sanitizedHtml).toContain("https://two.example/one");
    expect(second.sanitizedHtml).not.toContain("one.example");
    expect(repeated).toEqual(first);
  });

  it.each([null, 4, "html"])("should reject non-object input %s", (input) => {
    expect(() => extractArticle(input as never)).toThrowError(expect.objectContaining({ code: "invalid-input" }));
  });

  it.each([
    "relative/path",
    "ftp://example.com/a",
    "https://user:password@example.com/a",
    "not a url",
  ])("should reject invalid sourceUrl %s without echoing it", (sourceUrl) => {
    try {
      extractArticle({ html: "<p>content</p>", sourceUrl, maxContentChars: 100 });
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(ArticleExtractionError);
      expect((error as ArticleExtractionError).code).toBe("invalid-input");
      expect((error as Error).message).toContain("sourceUrl");
      expect((error as Error).message).not.toContain(sourceUrl);
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "should reject invalid maxContentChars %s",
    (maxContentChars) => {
      expect(() => extractArticle({ html: "<p>content</p>", sourceUrl: "https://example.com", maxContentChars }))
        .toThrowError(expect.objectContaining({ code: "invalid-input" }));
    },
  );

  it("should reject non-string HTML and return empty-content for empty input", () => {
    expect(() => extractArticle({ html: 4 as unknown as string, sourceUrl: "https://example.com", maxContentChars: 100 }))
      .toThrowError(expect.objectContaining({ code: "invalid-input" }));
    expect(() => extractArticle({ html: "  ", sourceUrl: "https://example.com", maxContentChars: 100 }))
      .toThrowError(expect.objectContaining({ code: "empty-content" }));
  });

  it("should enforce the exact UTF-16 budget without splitting astral code points", () => {
    const exact = extract(`<p>AB${filler}</p>`, 2);
    expect(exact.text).toBe("AB");
    const beforeAstral = extract(`<p>A😀B${filler}</p>`, 2);
    expect(beforeAstral.text).toBe("A");
    expect(beforeAstral.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(() => extract(`<p>😀B${filler}</p>`, 1)).toThrowError(expect.objectContaining({ code: "empty-content" }));
  });

  it("should truncate across multiple nodes and preserve well-formed equivalent HTML", () => {
    const result = extract(`<p>First <strong>bold</strong> tail.</p><p>Later${filler}</p>`, 11);
    expect(result.text.length).toBeLessThanOrEqual(11);
    expect(result.text).toBe("First bold");
    const reparsed = new JSDOM(`<body>${result.sanitizedHtml}</body>`);
    expect(reparsed.window.document.body.textContent?.trim()).toBe(result.text);
    expect(result.sanitizedHtml).toContain("<strong>bold</strong>");
  });

  it("should remove active subtrees dangerous attributes and unsafe URLs while retaining readable text", () => {
    const result = extract(`
      <p id="clobber" class="style" style="color:red" onclick="globalThis.compromised=true">
        Safe <a href="jav&#x61;script:alert(1)" target="_blank" rel="opener">bad link</a>
        <a href="/safe" title="Safe title" data-x="drop">safe link</a>${filler}
      </p>
      <script>globalThis.compromised=true</script><style>body{display:none}</style>
      <svg><text>svg hidden</text></svg><math><mi>math hidden</mi></math>
      <form><input value="secret"><button>Do not keep</button></form>
      <iframe src="https://tracker.example"></iframe><img src="data:text/html;base64,PGI+" srcdoc="<script>alert(1)</script>">
    `);
    expect(result.text).toContain("Safe bad link");
    expect(result.text).toContain("safe link");
    expect(result.text).not.toContain("svg hidden");
    expect(result.text).not.toContain("Do not keep");
    const dom = new JSDOM(`<body>${result.sanitizedHtml}</body>`);
    expect(dom.window.document.querySelector("script,style,svg,math,form,input,button,iframe")).toBeNull();
    expect(dom.window.document.querySelector("[id],[class],[style],[onclick],[target],[rel],[data-x],[srcdoc]")).toBeNull();
    expect(dom.window.document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(dom.window.document.querySelector('a[href="https://example.com/safe"]')).not.toBeNull();
  });

  it("should resolve only safe absolute URLs and enforce per-element attributes", () => {
    const result = extract(`
      <p title="drop"><a href="../relative">Relative</a>
      <a href="//cdn.example/root">Protocol</a>
      <a href="mailto:reader@example.com">Mail</a>
      <a href="https://user:pass@example.com/private">Credentials</a>
      <a href="file:///etc/passwd">File</a>${filler}</p>
      <blockquote cite="/quote">Quote</blockquote><q cite="mailto:no@example.com">Inline</q>
      <ol start="-2" reversed="anything" type="A"><li value="3">Item</li></ol>
    `, 500_000, "https://example.com/a/b/page");
    const dom = new JSDOM(`<body>${result.sanitizedHtml}</body>`);
    const hrefs = [...dom.window.document.querySelectorAll("a")].map((element) => element.getAttribute("href"));
    expect(hrefs).toEqual([
      "https://example.com/a/relative",
      "https://cdn.example/root",
      "mailto:reader@example.com",
      null,
      null,
    ]);
    expect(dom.window.document.querySelector("p")?.hasAttribute("title")).toBe(false);
    expect(dom.window.document.querySelector("blockquote")?.getAttribute("cite")).toBe("https://example.com/quote");
    expect(dom.window.document.querySelector("q")?.hasAttribute("cite")).toBe(false);
    expect(dom.window.document.querySelector("ol")?.getAttribute("start")).toBe("-2");
    expect(dom.window.document.querySelector("ol")?.getAttribute("reversed")).toBe("");
    expect(dom.window.document.querySelector("ol")?.getAttribute("type")).toBe("A");
  });

  it("should remove invalid numeric attribute values", () => {
    const result = extract(`
      <p>${filler}</p><img src="/image" width="20" height="1.5" alt="Figure">
      <table><thead><tr><th>Heading</th><th>Second</th></tr></thead><tbody><tr><td colspan="2" rowspan="999999999999999999999">Cell</td><td>Other</td></tr></tbody></table>
      <ol start="1.2" type="x"><li value="+2">Item</li></ol>
    `);
    const dom = new JSDOM(`<body>${result.sanitizedHtml}</body>`);
    expect(dom.window.document.querySelector("img")?.getAttribute("width")).toBe("20");
    expect(dom.window.document.querySelector("img")?.hasAttribute("height")).toBe(false);
    expect(dom.window.document.querySelector("td")?.getAttribute("colspan")).toBe("2");
    expect(dom.window.document.querySelector("td")?.hasAttribute("rowspan")).toBe(false);
    expect(dom.window.document.querySelector("ol")?.hasAttribute("start")).toBe(false);
    expect(dom.window.document.querySelector("ol")?.hasAttribute("type")).toBe(false);
    expect(dom.window.document.querySelector("li")?.hasAttribute("value")).toBe(false);
  });

  it("should execute no scripts and perform no network requests", async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      response.end("unexpected");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test address.");
    try {
      const result = extract(`
        <p>Safe text${filler}</p><script src="/script.js"></script>
        <img src="/image.png"><link rel="stylesheet" href="/style.css">
        <iframe src="/frame.html"></iframe><video src="/movie.mp4"></video>
      `, 500_000, `http://127.0.0.1:${address.port}/article`);
      expect(result.text).toContain("Safe text");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(requests).toBe(0);
      expect((globalThis as { compromised?: boolean }).compromised).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
