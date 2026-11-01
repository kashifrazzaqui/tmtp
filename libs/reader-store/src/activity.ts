import type { Database } from "@tmtp/database";
import { ActivityEventSchema, ReadingSessionSchema, StoredActivityEventSchema } from "@tmtp/domain";
import type { ActivityEvent, ReadingSession, StoredActivityEvent } from "@tmtp/domain";
import type { ActivityRepository, ReadingSessionRepository } from "./types.js";
import { fail } from "./error.js";
import { json, nonEmpty, nonNegativeLimit, parseJson, positiveLimit, sameRecord, storyId } from "./helpers.js";

interface EventRow {
  sequence: number; id: string; client_event_id: string; story_id: number; kind: StoredActivityEvent["kind"];
  value_json: string | null; value_schema_version: number; source: StoredActivityEvent["source"];
  observation_quality: StoredActivityEvent["observationQuality"]; occurred_at: string; received_at: string;
}
interface SessionRow {
  id: string; story_id: number; started_at: string; ended_at: string | null; updated_at: string;
  active_dwell_ms: number; max_scroll_ratio: number; state: ReadingSession["state"];
  observation_quality: ReadingSession["observationQuality"]; last_client_event_id: string;
}
export function mapEvent(row: EventRow): StoredActivityEvent {
  return StoredActivityEventSchema.parse({
    sequence: row.sequence, id: row.id, clientEventId: row.client_event_id, storyId: row.story_id,
    kind: row.kind, ...(row.value_json === null ? {} : { value: parseJson(row.value_json) }),
    valueSchemaVersion: row.value_schema_version, source: row.source,
    observationQuality: row.observation_quality, occurredAt: row.occurred_at, receivedAt: row.received_at,
  });
}
function mapSession(row: SessionRow): ReadingSession {
  return ReadingSessionSchema.parse({
    id: row.id, storyId: row.story_id, startedAt: row.started_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }), updatedAt: row.updated_at,
    activeDwellMs: row.active_dwell_ms, maxScrollRatio: row.max_scroll_ratio, state: row.state,
    observationQuality: row.observation_quality, lastClientEventId: row.last_client_event_id,
  });
}
function eventFromRow(row: EventRow): ActivityEvent {
  const { sequence: _sequence, ...event } = mapEvent(row);
  return event;
}

export function createActivityRepository(database: Database): ActivityRepository {
  return {
    appendIdempotent(events) {
      return database.transaction(() => {
        let inserted = 0;
        for (const input of events) {
          const event = ActivityEventSchema.parse(input);
          const existing = database.queryOne<EventRow>("SELECT * FROM reading_events WHERE client_event_id = ?", [event.clientEventId]);
          if (existing !== undefined) {
            if (!sameRecord(eventFromRow(existing), event)) fail("conflict");
            continue;
          }
          const sameId = database.queryOne<{ id: string }>("SELECT id FROM reading_events WHERE id = ?", [event.id]);
          if (sameId !== undefined) fail("conflict");
          database.execute(`INSERT INTO reading_events (
            id, client_event_id, story_id, kind, value_json, value_schema_version,
            source, observation_quality, occurred_at, received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            event.id, event.clientEventId, event.storyId, event.kind,
            event.value === undefined ? null : json(event.value), event.valueSchemaVersion,
            event.source, event.observationQuality, event.occurredAt, event.receivedAt,
          ]);
          inserted += 1;
        }
        return inserted;
      });
    },
    afterVersion(version, limit) {
      positiveLimit(limit);
      if (typeof version !== "string" || !/^(0|[1-9]\d*)$/.test(version)) fail("unknown-version");
      const numeric = Number(version);
      if (!Number.isSafeInteger(numeric)) fail("unknown-version");
      const head = Number(database.queryOne<{ head: number }>("SELECT COALESCE(MAX(sequence), 0) AS head FROM reading_events")!.head);
      if (numeric > head) fail("unknown-version");
      return database.query<EventRow>(
        "SELECT * FROM reading_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
        [numeric, limit],
      ).map(mapEvent);
    },
    latestWindow(limit) {
      nonNegativeLimit(limit);
      if (limit === 0) return [];
      return database.query<EventRow>(`SELECT * FROM (
        SELECT * FROM reading_events ORDER BY sequence DESC LIMIT ?
      ) ORDER BY sequence ASC`, [limit]).map(mapEvent);
    },
    latestVersion() {
      return String(database.queryOne<{ head: number }>("SELECT COALESCE(MAX(sequence), 0) AS head FROM reading_events")!.head);
    },
    query(query) {
      positiveLimit(query.limit);
      if (query.storyId !== undefined) storyId(query.storyId);
      if (query.clientEventId !== undefined) nonEmpty(query.clientEventId);
      const conditions: string[] = [];
      const parameters: Array<string | number> = [];
      if (query.storyId !== undefined) { conditions.push("story_id = ?"); parameters.push(query.storyId); }
      if (query.clientEventId !== undefined) { conditions.push("client_event_id = ?"); parameters.push(query.clientEventId); }
      const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
      if (query.afterId !== undefined) {
        const cursor = database.queryOne<EventRow>(`SELECT * FROM reading_events ${where === "" ? "WHERE id = ?" : `${where} AND id = ?`}`, [...parameters, query.afterId]);
        if (cursor === undefined) fail("invalid-query");
        conditions.push("sequence > ?"); parameters.push(cursor.sequence);
      }
      return database.query<EventRow>(
        `SELECT * FROM reading_events ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`} ORDER BY sequence ASC LIMIT ?`,
        [...parameters, query.limit],
      ).map(mapEvent);
    },
  };
}

export function createReadingSessionRepository(database: Database): ReadingSessionRepository {
  return {
    latestForStory(id) {
      storyId(id);
      const row = database.queryOne<SessionRow>(
        "SELECT * FROM reading_sessions WHERE story_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1", [id],
      );
      return row === undefined ? undefined : mapSession(row);
    },
    upsert(input) {
      const session = ReadingSessionSchema.parse(input);
      database.transaction(() => {
        const replay = database.queryOne<SessionRow>("SELECT * FROM reading_sessions WHERE last_client_event_id = ?", [session.lastClientEventId]);
        if (replay !== undefined && replay.id !== session.id) fail("conflict");
        database.execute(`INSERT INTO reading_sessions (
          id, story_id, started_at, ended_at, updated_at, active_dwell_ms, max_scroll_ratio,
          state, observation_quality, last_client_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          story_id=excluded.story_id, started_at=excluded.started_at, ended_at=excluded.ended_at,
          updated_at=excluded.updated_at,
          active_dwell_ms=MAX(reading_sessions.active_dwell_ms, excluded.active_dwell_ms),
          max_scroll_ratio=MAX(reading_sessions.max_scroll_ratio, excluded.max_scroll_ratio),
          state=excluded.state, observation_quality=excluded.observation_quality,
          last_client_event_id=excluded.last_client_event_id`, [
          session.id, session.storyId, session.startedAt, session.endedAt ?? null, session.updatedAt,
          session.activeDwellMs, session.maxScrollRatio, session.state,
          session.observationQuality, session.lastClientEventId,
        ]);
      });
    },
    query(query) {
      positiveLimit(query.limit);
      if (query.storyId !== undefined) storyId(query.storyId);
      if (query.clientEventId !== undefined) nonEmpty(query.clientEventId);
      const conditions: string[] = [];
      const parameters: Array<string | number> = [];
      if (query.storyId !== undefined) { conditions.push("story_id = ?"); parameters.push(query.storyId); }
      if (query.clientEventId !== undefined) { conditions.push("last_client_event_id = ?"); parameters.push(query.clientEventId); }
      if (query.afterId !== undefined) {
        const cursor = database.queryOne<SessionRow>(
          `SELECT * FROM reading_sessions ${conditions.length === 0 ? "WHERE id = ?" : `WHERE ${conditions.join(" AND ")} AND id = ?`}`,
          [...parameters, query.afterId],
        );
        if (cursor === undefined) fail("invalid-query");
        conditions.push("(updated_at > ? OR (updated_at = ? AND id > ?))");
        parameters.push(cursor.updated_at, cursor.updated_at, cursor.id);
      }
      return database.query<SessionRow>(
        `SELECT * FROM reading_sessions ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`} ORDER BY updated_at ASC, id ASC LIMIT ?`,
        [...parameters, query.limit],
      ).map(mapSession);
    },
  };
}
