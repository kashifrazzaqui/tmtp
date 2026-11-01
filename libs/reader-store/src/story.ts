import type { Database } from "@tmtp/database";
import { ArticleSchema, articleContentVersion, StorySchema } from "@tmtp/domain";
import type { Article, Story } from "@tmtp/domain";
import type { ArticleRepository, StoryRepository } from "./types.js";
import { fail } from "./error.js";
import { ids, json, nonEmpty, parseJson, placeholders, positiveLimit, storyId, timestamp } from "./helpers.js";

interface StoryRow {
  id: number; item_type: "story"; url: string | null; canonical_url: string | null;
  title: string; author: string | null; text_html: string | null; score: number | null; descendants: number | null;
  published_at: string; first_seen_at: string; last_seen_at: string; content_version: string;
  raw_json: string; raw_schema_version: number; deleted: number; dead: number;
}
interface ArticleRow {
  story_id: number; status: Article["status"]; source_content_version: string; content_version: string;
  source_url: string | null; final_url: string | null; title: string | null; byline: string | null; excerpt: string | null;
  text_content: string | null; sanitized_html: string | null; content_hash: string | null; extractor_version: string | null;
  fetched_at: string | null; updated_at: string; error_code: string | null; error_message: string | null;
}
const opt = <K extends string, V>(key: K, value: V | null): { [P in K]?: Exclude<V, null> } =>
  (value === null ? {} : { [key]: value }) as { [P in K]?: Exclude<V, null> };

export function mapStory(row: StoryRow): Story {
  return StorySchema.parse({
    id: row.id, itemType: row.item_type,
    ...opt("url", row.url), ...opt("canonicalUrl", row.canonical_url), title: row.title,
    ...opt("author", row.author), ...opt("textHtml", row.text_html),
    ...opt("score", row.score), ...opt("descendants", row.descendants),
    publishedAt: row.published_at, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
    contentVersion: row.content_version, raw: parseJson(row.raw_json), rawSchemaVersion: row.raw_schema_version,
    deleted: row.deleted === 1, dead: row.dead === 1,
  });
}
function mapArticle(row: ArticleRow): Article {
  return ArticleSchema.parse({
    storyId: row.story_id, status: row.status, sourceContentVersion: row.source_content_version,
    contentVersion: row.content_version, ...opt("sourceUrl", row.source_url), ...opt("finalUrl", row.final_url),
    ...opt("title", row.title), ...opt("byline", row.byline), ...opt("excerpt", row.excerpt),
    ...opt("textContent", row.text_content), ...opt("sanitizedHtml", row.sanitized_html),
    ...opt("contentHash", row.content_hash), ...opt("extractorVersion", row.extractor_version),
    ...opt("fetchedAt", row.fetched_at), updatedAt: row.updated_at,
    ...opt("errorCode", row.error_code), ...opt("errorMessage", row.error_message),
  });
}
function invalidateQueue(database: Database, story: number, at: string): void {
  database.execute(`UPDATE queue_entries SET
    evaluation_state = 'pending', kind = 'match', recommendation_id = NULL,
    rank_score = NULL, rank_position = NULL, last_error = NULL,
    updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
    WHERE story_id = ? AND evaluation_state IN ('scored','failed')`, [at, at, story]);
}

export function createStoryRepository(database: Database): StoryRepository {
  const byId = (id: number): Story | undefined => {
    storyId(id);
    const row = database.queryOne<StoryRow>("SELECT * FROM stories WHERE id = ?", [id]);
    return row === undefined ? undefined : mapStory(row);
  };
  return {
    upsertBatch(stories) {
      database.transaction(() => {
        for (const input of stories) {
          const story = StorySchema.parse(input);
          const previous = database.queryOne<{ content_version: string }>("SELECT content_version FROM stories WHERE id = ?", [story.id]);
          database.execute(`INSERT INTO stories (
            id, item_type, url, canonical_url, title, author, text_html, score, descendants,
            published_at, first_seen_at, last_seen_at, content_version, raw_json, raw_schema_version, deleted, dead
          ) VALUES (?, 'story', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            url=excluded.url, canonical_url=excluded.canonical_url, title=excluded.title,
            author=excluded.author, text_html=excluded.text_html, score=excluded.score,
            descendants=excluded.descendants, published_at=excluded.published_at,
            first_seen_at=stories.first_seen_at, last_seen_at=excluded.last_seen_at,
            content_version=excluded.content_version, raw_json=excluded.raw_json,
            raw_schema_version=excluded.raw_schema_version, deleted=excluded.deleted, dead=excluded.dead`, [
            story.id, story.url ?? null, story.canonicalUrl ?? null, story.title, story.author ?? null,
            story.textHtml ?? null, story.score ?? null, story.descendants ?? null, story.publishedAt,
            story.firstSeenAt, story.lastSeenAt, story.contentVersion, json(story.raw), story.rawSchemaVersion,
            story.deleted ? 1 : 0, story.dead ? 1 : 0,
          ]);
          if (previous !== undefined && previous.content_version !== story.contentVersion) {
            invalidateQueue(database, story.id, story.lastSeenAt);
          }
        }
      });
    },
    byId,
    byStoryIds(storyIds) {
      const unique = ids(storyIds);
      if (unique.length === 0) return [];
      return database.query<StoryRow>(`SELECT * FROM stories WHERE id IN (${placeholders(unique.length)}) ORDER BY id ASC`, unique).map(mapStory);
    },
    needingScoring(query) {
      nonEmpty(query.profileId); nonEmpty(query.promptVersion); nonEmpty(query.model); positiveLimit(query.limit);
      if (query.afterStoryId !== undefined) storyId(query.afterStoryId);
      return database.query<StoryRow>(`SELECT stories.* FROM stories
        JOIN queue_entries ON queue_entries.story_id = stories.id
          AND queue_entries.evaluation_state IN ('pending','failed')
        LEFT JOIN articles ON articles.story_id = stories.id
        LEFT JOIN recommendations ON recommendations.story_id = stories.id
          AND recommendations.profile_id = ?
          AND recommendations.story_content_version = stories.content_version
          AND recommendations.article_content_version = COALESCE(articles.content_version, 'none')
          AND recommendations.prompt_version = ? AND recommendations.model = ?
        WHERE recommendations.id IS NULL AND stories.id > ?
        ORDER BY stories.id ASC LIMIT ?`, [
        query.profileId, query.promptVersion, query.model, query.afterStoryId ?? 0, query.limit,
      ]).map(mapStory);
    },
    needingRefresh(olderThan, afterStoryId, limit) {
      timestamp(olderThan); positiveLimit(limit);
      if (afterStoryId !== undefined) storyId(afterStoryId);
      return database.query<StoryRow>(
        "SELECT * FROM stories WHERE last_seen_at < ? AND id > ? ORDER BY id ASC LIMIT ?",
        [olderThan, afterStoryId ?? 0, limit],
      ).map(mapStory);
    },
    forQueueProjection(afterStoryId, limit) {
      positiveLimit(limit);
      if (afterStoryId !== undefined) storyId(afterStoryId);
      return database.query<StoryRow>(
        "SELECT * FROM stories WHERE id > ? ORDER BY id ASC LIMIT ?",
        [afterStoryId ?? 0, limit],
      ).map(mapStory);
    },
  };
}

export function createArticleRepository(database: Database): ArticleRepository {
  const byStoryId = (id: number): Article | undefined => {
    storyId(id);
    const row = database.queryOne<ArticleRow>("SELECT * FROM articles WHERE story_id = ?", [id]);
    return row === undefined ? undefined : mapArticle(row);
  };
  return {
    upsert(input) {
      const article = ArticleSchema.parse(input);
      if (article.sourceContentVersion.length === 0 || article.contentVersion !== articleContentVersion(article)) fail("conflict");
      return database.transaction(() => {
        const story = database.queryOne<{ content_version: string }>("SELECT content_version FROM stories WHERE id = ?", [article.storyId]);
        if (story === undefined) fail("not-found");
        if (story.content_version !== article.sourceContentVersion) return "stale-source" as const;
        const previous = database.queryOne<ArticleRow>("SELECT * FROM articles WHERE story_id = ?", [article.storyId]);
        database.execute(`INSERT INTO articles (
          story_id, status, source_content_version, content_version, source_url, final_url,
          title, byline, excerpt, text_content, sanitized_html, content_hash, extractor_version,
          fetched_at, updated_at, error_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(story_id) DO UPDATE SET
          status=excluded.status, source_content_version=excluded.source_content_version,
          content_version=excluded.content_version, source_url=excluded.source_url, final_url=excluded.final_url,
          title=excluded.title, byline=excluded.byline, excerpt=excluded.excerpt,
          text_content=excluded.text_content, sanitized_html=excluded.sanitized_html,
          content_hash=excluded.content_hash, extractor_version=excluded.extractor_version,
          fetched_at=excluded.fetched_at, updated_at=excluded.updated_at,
          error_code=excluded.error_code, error_message=excluded.error_message`, [
          article.storyId, article.status, article.sourceContentVersion, article.contentVersion,
          article.sourceUrl ?? null, article.finalUrl ?? null, article.title ?? null, article.byline ?? null,
          article.excerpt ?? null, article.textContent ?? null, article.sanitizedHtml ?? null,
          article.contentHash ?? null, article.extractorVersion ?? null, article.fetchedAt ?? null,
          article.updatedAt, article.errorCode ?? null, article.errorMessage ?? null,
        ]);
        if ((previous?.content_version ?? "none") !== article.contentVersion) {
          invalidateQueue(database, article.storyId, article.updatedAt);
        }
        return "applied" as const;
      });
    },
    byStoryId,
    byStoryIds(storyIds) {
      const unique = ids(storyIds);
      if (unique.length === 0) return [];
      return database.query<ArticleRow>(`SELECT * FROM articles WHERE story_id IN (${placeholders(unique.length)}) ORDER BY story_id ASC`, unique).map(mapArticle);
    },
    needingContent(query) {
      nonEmpty(query.extractorVersion); positiveLimit(query.limit);
      if (query.afterStoryId !== undefined) storyId(query.afterStoryId);
      return database.query<StoryRow>(`SELECT stories.* FROM stories
        LEFT JOIN articles ON articles.story_id = stories.id
        WHERE (stories.url IS NOT NULL OR stories.text_html IS NOT NULL)
          AND stories.id > ? AND (
            articles.story_id IS NULL OR articles.status = 'pending'
            OR articles.source_content_version != stories.content_version
            OR (articles.status IN ('ready','failed') AND articles.extractor_version != ?)
          )
        ORDER BY stories.id ASC LIMIT ?`, [query.afterStoryId ?? 0, query.extractorVersion, query.limit]).map(mapStory);
    },
  };
}
