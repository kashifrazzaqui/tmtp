import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import createDOMPurify, { type WindowLike } from "dompurify";
import { JSDOM } from "jsdom";

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
  override readonly name = "ArticleExtractionError" as const;

  constructor(readonly code: ArticleExtractionErrorCode, message: string) {
    super(message);
  }
}

export const ARTICLE_EXTRACTOR_VERSION = "1" as const;

const ALLOWED_TAGS = [
  "a", "article", "b", "blockquote", "br", "caption", "cite", "code", "dd", "del", "div", "dl", "dt",
  "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "li", "mark",
  "ol", "p", "pre", "q", "s", "section", "small", "span", "strong", "sub", "sup", "table", "tbody", "td",
  "tfoot", "th", "thead", "time", "tr", "u", "ul",
];
const ATTRIBUTES_BY_TAG: Readonly<Record<string, readonly string[]>> = {
  a: ["href", "title"],
  img: ["src", "alt", "title", "width", "height"],
  blockquote: ["cite"],
  q: ["cite"],
  ol: ["start", "reversed", "type"],
  li: ["value"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  time: ["datetime"],
};
const ALLOWED_ATTR = [...new Set(Object.values(ATTRIBUTES_BY_TAG).flat())];
const DANGEROUS_TAGS = [
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "svg", "math", "template",
  "noscript", "link", "meta", "base", "form", "input", "button", "select", "textarea", "video", "audio",
  "source", "track", "canvas",
];

function createInertDom(html: string, url: string): JSDOM {
  return new JSDOM(html, {
    url,
    pretendToBeVisual: false,
  });
}

function validateInput(input: ExtractArticleInput): void {
  if (input === null || typeof input !== "object") {
    throw new ArticleExtractionError("invalid-input", "Invalid extraction input.");
  }
  if (typeof input.html !== "string") {
    throw new ArticleExtractionError("invalid-input", "Invalid html field.");
  }
  if (typeof input.sourceUrl !== "string") {
    throw new ArticleExtractionError("invalid-input", "Invalid sourceUrl field.");
  }
  let url: URL;
  try {
    url = new URL(input.sourceUrl);
  } catch {
    throw new ArticleExtractionError("invalid-input", "Invalid sourceUrl field.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ArticleExtractionError("invalid-input", "Invalid sourceUrl field.");
  }
  if (!Number.isSafeInteger(input.maxContentChars) || input.maxContentChars <= 0) {
    throw new ArticleExtractionError("invalid-input", "Invalid maxContentChars field.");
  }
}

function normalizeMetadata(value: string | null | undefined, document: Document): string | undefined {
  if (value === null || value === undefined) return undefined;
  const container = document.createElement("div");
  container.innerHTML = value;
  const normalized = (container.textContent ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  return normalized === "" ? undefined : normalized;
}

function textNodes(root: Node, document: Document): Text[] {
  const walker = document.createTreeWalker(root, 4);
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current !== null) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  return nodes;
}

function truncateDomText(root: Node, document: Document, budget: number): void {
  let remaining = budget;
  for (const node of textNodes(root, document)) {
    const value = node.data.normalize("NFC");
    if (remaining === 0) {
      node.data = "";
      continue;
    }
    if (value.length <= remaining) {
      node.data = value;
      remaining -= value.length;
      continue;
    }
    let cut = remaining;
    const previous = value.charCodeAt(cut - 1);
    const next = value.charCodeAt(cut);
    if (
      previous >= 0xd800 && previous <= 0xdbff &&
      next >= 0xdc00 && next <= 0xdfff
    ) {
      cut -= 1;
    }
    node.data = value.slice(0, cut);
    remaining = 0;
  }
}

function normalizeText(value: string): string {
  return value.normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/^ +| +$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function enforceAttributeValues(document: Document): void {
  for (const element of document.querySelectorAll("img[width], img[height], td[colspan], td[rowspan], th[colspan], th[rowspan]")) {
    for (const attribute of ["width", "height", "colspan", "rowspan"]) {
      if (!element.hasAttribute(attribute)) continue;
      const value = element.getAttribute(attribute) ?? "";
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        element.removeAttribute(attribute);
      }
    }
  }
  for (const element of document.querySelectorAll("ol[start], li[value]")) {
    const attribute = element.tagName === "OL" ? "start" : "value";
    const value = element.getAttribute(attribute) ?? "";
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      element.removeAttribute(attribute);
    }
  }
  for (const element of document.querySelectorAll("ol[type]")) {
    if (!/^[1aAiI]$/.test(element.getAttribute("type") ?? "")) element.removeAttribute("type");
  }
  for (const element of document.querySelectorAll("ol[reversed]")) {
    element.setAttribute("reversed", "");
  }
}

function enforcePerElementAttributes(document: Document): void {
  for (const element of document.querySelectorAll("*")) {
    const allowed = ATTRIBUTES_BY_TAG[element.tagName.toLowerCase()] ?? [];
    for (const attribute of [...element.attributes]) {
      if (!allowed.includes(attribute.name.toLowerCase())) element.removeAttribute(attribute.name);
    }
  }
}

function normalizeUrls(document: Document, sourceUrl: string): void {
  for (const element of document.querySelectorAll("a[href], img[src], blockquote[cite], q[cite]")) {
    const attribute = element.tagName === "A" ? "href" : element.tagName === "IMG" ? "src" : "cite";
    const reference = element.getAttribute(attribute) ?? "";
    let url: URL;
    try {
      if (reference.trim() === "") throw new TypeError("Empty URL.");
      url = new URL(reference, sourceUrl);
    } catch {
      element.removeAttribute(attribute);
      continue;
    }
    const mailto = element.tagName === "A" && attribute === "href" && url.protocol === "mailto:";
    if (
      (!mailto && url.protocol !== "http:" && url.protocol !== "https:") ||
      ((url.protocol === "http:" || url.protocol === "https:") && (url.username !== "" || url.password !== ""))
    ) {
      element.removeAttribute(attribute);
      continue;
    }
    element.setAttribute(attribute, url.href);
  }
}

export function extractArticle(input: ExtractArticleInput): ExtractedArticle {
  validateInput(input);
  let source: JSDOM | undefined;
  let fragment: JSDOM | undefined;
  try {
    source = createInertDom(input.html, input.sourceUrl);
    const article = new Readability(source.window.document).parse();
    if (article === null || typeof article.content !== "string") {
      throw new ArticleExtractionError("empty-content", "No readable article content was found.");
    }

    fragment = createInertDom("<!doctype html><html><head></head><body></body></html>", input.sourceUrl);
    const document = fragment.window.document;
    document.body.innerHTML = article.content;
    document.querySelectorAll(DANGEROUS_TAGS.join(",")).forEach((element) => element.remove());
    truncateDomText(document.body, document, input.maxContentChars);

    const purify = createDOMPurify(fragment.window as unknown as WindowLike);
    const sanitized = purify.sanitize(document.body.innerHTML, {
      USE_PROFILES: { html: true },
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOWED_NAMESPACES: ["http://www.w3.org/1999/xhtml"],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      SANITIZE_DOM: true,
      SANITIZE_NAMED_PROPS: true,
      RETURN_TRUSTED_TYPE: false,
    });
    document.body.innerHTML = sanitized;
    enforcePerElementAttributes(document);
    enforceAttributeValues(document);
    normalizeUrls(document, input.sourceUrl);

    let text = normalizeText(document.body.textContent ?? "");
    while (text.length > input.maxContentChars) {
      truncateDomText(document.body, document, input.maxContentChars - 1);
      text = normalizeText(document.body.textContent ?? "");
    }
    if (text === "") {
      throw new ArticleExtractionError("empty-content", "No readable article content remains.");
    }

    const title = normalizeMetadata(article.title, document);
    const byline = normalizeMetadata(article.byline, document);
    const excerpt = normalizeMetadata(article.excerpt, document);
    const result: ExtractedArticle = {
      ...(title === undefined ? {} : { title }),
      ...(byline === undefined ? {} : { byline }),
      ...(excerpt === undefined ? {} : { excerpt }),
      text,
      sanitizedHtml: document.body.innerHTML,
      contentHash: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
      extractorVersion: ARTICLE_EXTRACTOR_VERSION,
    };
    return result;
  } catch (error) {
    if (error instanceof ArticleExtractionError) throw error;
    throw new ArticleExtractionError("extraction-failed", "Article extraction failed.");
  } finally {
    fragment?.window.close();
    source?.window.close();
  }
}
