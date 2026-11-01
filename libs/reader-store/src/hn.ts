import type { Database } from "@tmtp/database";
import { HnAccountStateSchema, HnActionIntentSchema, HnActionKindSchema } from "@tmtp/domain";
import type { HnAccountState, HnActionIntent } from "@tmtp/domain";
import type { HnAccountStateRepository, HnActionRepository } from "./types.js";
import { fail } from "./error.js";
import { ids, json, nonEmpty, parseJson, placeholders, positiveLimit, sameRecord, storyId } from "./helpers.js";

interface IntentRow {
  id: string; story_id: number; action: HnActionIntent["action"]; idempotency_key: string;
  status: HnActionIntent["status"]; result_json: string | null; result_schema_version: number | null;
  error_code: string | null; created_at: string; updated_at: string;
}
interface StateRow {
  username: string; story_id: number; kind: HnAccountState["kind"]; present: number;
  first_observed_at: string; last_observed_at: string; source_cursor: string | null;
}
const mapIntent = (row: IntentRow): HnActionIntent => HnActionIntentSchema.parse({
  id: row.id, storyId: row.story_id, action: row.action, idempotencyKey: row.idempotency_key,
  status: row.status,
  ...(row.result_json === null ? {} : { result: parseJson(row.result_json), resultSchemaVersion: row.result_schema_version }),
  ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  createdAt: row.created_at, updatedAt: row.updated_at,
});
const mapState = (row: StateRow): HnAccountState => HnAccountStateSchema.parse({
  username: row.username, storyId: row.story_id, kind: row.kind, present: row.present === 1,
  firstObservedAt: row.first_observed_at, lastObservedAt: row.last_observed_at,
  ...(row.source_cursor === null ? {} : { sourceCursor: row.source_cursor }),
});

export function createHnActionRepository(database: Database): HnActionRepository {
  const byId = (id: string): HnActionIntent | undefined => {
    const row = database.queryOne<IntentRow>("SELECT * FROM hn_action_intents WHERE id = ?", [id]);
    return row === undefined ? undefined : mapIntent(row);
  };
  return {
    createIntent(input) {
      const intent = HnActionIntentSchema.parse(input);
      const existing = database.queryOne<IntentRow>(
        "SELECT * FROM hn_action_intents WHERE id = ? OR idempotency_key = ?", [intent.id, intent.idempotencyKey],
      );
      if (existing !== undefined) {
        if (!sameRecord(mapIntent(existing), intent)) fail("conflict");
        return;
      }
      database.execute(`INSERT INTO hn_action_intents (
        id, story_id, action, idempotency_key, status, result_json, result_schema_version,
        error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        intent.id, intent.storyId, intent.action, intent.idempotencyKey, intent.status,
        intent.result === undefined ? null : json(intent.result), intent.resultSchemaVersion ?? null,
        intent.errorCode ?? null, intent.createdAt, intent.updatedAt,
      ]);
    },
    byId,
    byIdempotencyKey(key) {
      nonEmpty(key);
      const row = database.queryOne<IntentRow>("SELECT * FROM hn_action_intents WHERE idempotency_key = ?", [key]);
      return row === undefined ? undefined : mapIntent(row);
    },
    updateOutcome(input) {
      const intent = HnActionIntentSchema.parse(input);
      database.transaction(() => {
        const row = database.queryOne<IntentRow>("SELECT * FROM hn_action_intents WHERE id = ?", [intent.id]);
        if (row === undefined) fail("not-found");
        const existing = mapIntent(row);
        if (existing.storyId !== intent.storyId || existing.action !== intent.action || existing.idempotencyKey !== intent.idempotencyKey || existing.createdAt !== intent.createdAt) fail("immutable-conflict");
        if ((existing.status === "verified" || existing.status === "failed") && !sameRecord(existing, intent)) fail("conflict");
        database.execute(`UPDATE hn_action_intents SET
          status=?, result_json=?, result_schema_version=?, error_code=?, updated_at=? WHERE id=?`, [
          intent.status, intent.result === undefined ? null : json(intent.result),
          intent.resultSchemaVersion ?? null, intent.errorCode ?? null, intent.updatedAt, intent.id,
        ]);
      });
    },
    historyForStory(id, afterId, limit) {
      storyId(id); positiveLimit(limit);
      const parameters: Array<string | number> = [id];
      let cursor = "";
      if (afterId !== undefined) {
        const row = database.queryOne<IntentRow>("SELECT * FROM hn_action_intents WHERE id = ? AND story_id = ?", [afterId, id]);
        if (row === undefined) fail("invalid-query");
        cursor = "AND (created_at > ? OR (created_at = ? AND id > ?))";
        parameters.push(row.created_at, row.created_at, row.id);
      }
      return database.query<IntentRow>(
        `SELECT * FROM hn_action_intents WHERE story_id = ? ${cursor} ORDER BY created_at ASC, id ASC LIMIT ?`,
        [...parameters, limit],
      ).map(mapIntent);
    },
    pendingOrIndeterminate(query) {
      positiveLimit(query.limit);
      if (query.storyId !== undefined) storyId(query.storyId);
      if (query.action !== undefined && !HnActionKindSchema.safeParse(query.action).success) fail("invalid-query");
      if (query.status !== undefined && query.status !== "pending" && query.status !== "indeterminate") fail("invalid-query");
      const conditions: string[] = [];
      const parameters: Array<string | number> = [];
      if (query.status === undefined) conditions.push("status IN ('pending','indeterminate')");
      else { conditions.push("status = ?"); parameters.push(query.status); }
      if (query.storyId !== undefined) { conditions.push("story_id = ?"); parameters.push(query.storyId); }
      if (query.action !== undefined) { conditions.push("action = ?"); parameters.push(query.action); }
      if (query.afterId !== undefined) {
        const row = database.queryOne<IntentRow>(
          `SELECT * FROM hn_action_intents WHERE ${conditions.join(" AND ")} AND id = ?`,
          [...parameters, query.afterId],
        );
        if (row === undefined) fail("invalid-query");
        conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
        parameters.push(row.created_at, row.created_at, row.id);
      }
      return database.query<IntentRow>(
        `SELECT * FROM hn_action_intents WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC, id ASC LIMIT ?`,
        [...parameters, query.limit],
      ).map(mapIntent);
    },
  };
}

export function createHnAccountStateRepository(database: Database): HnAccountStateRepository {
  return {
    upsertObservations(states) {
      database.transaction(() => {
        for (const input of states) {
          const state = HnAccountStateSchema.parse(input);
          database.execute(`INSERT INTO hn_account_states (
            username, story_id, kind, present, first_observed_at, last_observed_at, source_cursor
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(username, story_id, kind) DO UPDATE SET
            present=excluded.present,
            first_observed_at=MIN(hn_account_states.first_observed_at, excluded.first_observed_at),
            last_observed_at=MAX(hn_account_states.last_observed_at, excluded.last_observed_at),
            source_cursor=excluded.source_cursor`, [
            state.username, state.storyId, state.kind, state.present ? 1 : 0,
            state.firstObservedAt, state.lastObservedAt, state.sourceCursor ?? null,
          ]);
        }
      });
    },
    current(username, kind) {
      nonEmpty(username);
      if (kind !== undefined && !HnActionKindSchema.safeParse(kind).success) fail("invalid-query");
      return database.query<StateRow>(`SELECT * FROM hn_account_states
        WHERE username = ? ${kind === undefined ? "" : "AND kind = ?"} ORDER BY story_id ASC, kind ASC`,
      kind === undefined ? [username] : [username, kind]).map(mapState);
    },
    byStoryIds(username, kind, storyIds) {
      nonEmpty(username);
      if (!HnActionKindSchema.safeParse(kind).success) fail("invalid-query");
      const unique = ids(storyIds);
      if (unique.length === 0) return [];
      return database.query<StateRow>(`SELECT * FROM hn_account_states
        WHERE username = ? AND kind = ? AND story_id IN (${placeholders(unique.length)}) ORDER BY story_id ASC`,
      [username, kind, ...unique]).map(mapState);
    },
  };
}
