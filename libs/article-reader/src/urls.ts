import { ArticleReaderError } from "./errors.js";
import type { ArticleOriginalTarget } from "./types.js";
export function hnPermalink(id: number): string { return `https://news.ycombinator.com/item?id=${id}`; }
export function resolveArticleOriginalTarget(story: { id: number; url?: string | undefined }): ArticleOriginalTarget {
  if (story === null || typeof story !== "object" || !Number.isSafeInteger(story.id) || story.id < 1 ||
    (story.url !== undefined && typeof story.url !== "string")) throw new ArticleReaderError("invalid-input");
  if (story.url !== undefined) {
    try {
      const url = new URL(story.url);
      if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" && url.username === "" && url.password === "") {
        url.hash = "";
        return { kind: "original-page", url: url.toString() };
      }
    } catch { /* Fall back to the fixed HN discussion. */ }
  }
  return { kind: "hn-discussion", url: hnPermalink(story.id) };
}
