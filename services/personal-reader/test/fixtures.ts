import { articleContentVersion } from "@tmtp/domain";
import type { Article, QueueEntry, Story } from "@tmtp/domain";
import { normalizeStory } from "@tmtp/hn-public-api";
import type { ServiceGraph } from "../src/composition.js";
import { NOW } from "./harness.js";

export function storyFixture(id: number, title = `Story ${id}`): Story {
  const story = normalizeStory({
    item: {
      id,
      type: "story",
      title,
      author: "reader",
      time: Math.floor(NOW.getTime() / 1000) - 100,
      url: `https://example.test/articles/${id}`,
      textHtml: "<script>window.bad=true</script><p>raw HN text</p>",
      score: 10,
      descendants: 2,
      deleted: false,
      dead: false,
      raw: { sentinel: "raw-envelope-must-not-escape" },
      rawSchemaVersion: 1,
    },
    observedAt: NOW.toISOString(),
  });
  if (story === undefined) throw new Error("Fixture did not normalize.");
  return story;
}

export function queueFixture(storyId: number): QueueEntry {
  return {
    storyId,
    state: "unread",
    evaluationState: "pending",
    visibilityState: "visible",
    kind: "match",
    rankVersion: "qb1.initial",
    queuedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

export function seedStory(graph: ServiceGraph, id: number, title?: string): Story {
  const story = storyFixture(id, title);
  graph.store.transaction(() => {
    graph.store.stories.upsertBatch([story]);
    graph.store.queue.insertPendingIfMissing([queueFixture(id)]);
  });
  return story;
}

export function readyArticleFixture(story: Story): Article {
  const base = {
    storyId: story.id,
    status: "ready" as const,
    sourceContentVersion: story.contentVersion,
    contentVersion: "pending",
    title: story.title,
    byline: "Article Author",
    excerpt: "A safe excerpt",
    sanitizedHtml: `<p>Safe article</p><a href="https://example.test/more">More</a>`,
    textContent: "raw text must not escape",
    sourceUrl: story.url,
    finalUrl: story.url,
    contentHash: "content-hash-1",
    extractorVersion: "1",
    fetchedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    errorMessage: "raw error must not escape",
  };
  return { ...base, contentVersion: articleContentVersion(base as Article) };
}
