import type { Database } from "@tmtp/database";
import {
  AccessSessionRecordSchema,
  DiagnosticErrorSchema,
  IngestionRunSchema,
  LlmCallRecordSchema,
} from "@tmtp/domain";
import type { AccessSessionRecord, DiagnosticError, IngestionRun, LlmCallRecord } from "@tmtp/domain";
import type { AccessSessionRepository, DiagnosticErrorRepository, LlmCallRepository, SyncRepository, TimestampIdCursor } from "./types.js";
import { fail } from "./error.js";
import { json, nonEmpty, parseJson, positiveLimit, sameRecord, timestamp } from "./helpers.js";

interface RunRow {
  id: string; kind: string; status: IngestionRun["status"]; cursor_start: string | null; cursor_end: string | null;
  stories_upserted: number; non_stories_skipped: number; error_code: string | null; error_message: string | null;
  started_at: string; completed_at: string | null;
}
interface CallRow {
  id: string; purpose: string; model: string; status: LlmCallRecord["status"]; request_hash: string;
  input_tokens: number | null; output_tokens: number | null; latency_ms: number;
  provider_request_id: string | null; error_code: string | null;
  request_payload_json: string | null; request_payload_schema_version: number | null;
  response_payload_json: string | null; response_payload_schema_version: number | null; created_at: string;
}
interface AccessRow {
  session_hash: string; csrf_secret_hash: string; created_at: string; expires_at: string;
  last_used_at: string; revoked_at: string | null;
}
const mapRun = (row: RunRow): IngestionRun => IngestionRunSchema.parse({
  id: row.id, kind: row.kind, status: row.status,
  ...(row.cursor_start === null ? {} : { cursorStart: row.cursor_start }),
  ...(row.cursor_end === null ? {} : { cursorEnd: row.cursor_end }),
  storiesUpserted: row.stories_upserted, nonStoriesSkipped: row.non_stories_skipped,
  ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
  startedAt: row.started_at, ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
});
const mapCall = (row: CallRow): LlmCallRecord => LlmCallRecordSchema.parse({
  id: row.id, purpose: row.purpose, model: row.model, status: row.status, requestHash: row.request_hash,
  ...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
  ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
  latencyMs: row.latency_ms,
  ...(row.provider_request_id === null ? {} : { providerRequestId: row.provider_request_id }),
  ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  ...(row.request_payload_json === null ? {} : {
    requestPayload: parseJson(row.request_payload_json), requestPayloadSchemaVersion: row.request_payload_schema_version,
  }),
  ...(row.response_payload_json === null ? {} : {
    responsePayload: parseJson(row.response_payload_json), responsePayloadSchemaVersion: row.response_payload_schema_version,
  }),
  createdAt: row.created_at,
});
const mapAccess = (row: AccessRow): AccessSessionRecord => AccessSessionRecordSchema.parse({
  sessionHash: row.session_hash, csrfSecretHash: row.csrf_secret_hash,
  createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at,
  ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
});
function descendingCursor(field: string, after: TimestampIdCursor | undefined): { clause: string; parameters: Array<string | number> } {
  if (after === undefined) return { clause: "", parameters: [] };
  timestamp(after.timestamp); nonEmpty(after.id);
  return { clause: `AND (${field} < ? OR (${field} = ? AND id < ?))`, parameters: [after.timestamp, after.timestamp, after.id] };
}

export function createSyncRepository(database: Database): SyncRepository {
  return {
    cursor(name) {
      nonEmpty(name);
      return database.queryOne<{ value: string }>("SELECT value FROM ingestion_cursors WHERE name = ?", [name])?.value;
    },
    setCursor(name, value, at) {
      nonEmpty(name); nonEmpty(value); timestamp(at);
      database.execute(`INSERT INTO ingestion_cursors(name, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, [name, value, at]);
    },
    startRun(input) {
      const run = IngestionRunSchema.parse(input);
      if (run.status !== "running" || run.completedAt !== undefined) fail("invalid-query");
      database.execute(`INSERT INTO ingestion_runs (
        id, kind, status, cursor_start, cursor_end, stories_upserted, non_stories_skipped,
        error_code, error_message, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        run.id, run.kind, run.status, run.cursorStart ?? null, run.cursorEnd ?? null,
        run.storiesUpserted, run.nonStoriesSkipped, run.errorCode ?? null, run.errorMessage ?? null,
        run.startedAt, run.completedAt ?? null,
      ]);
    },
    finishRun(input) {
      const run = IngestionRunSchema.parse(input);
      if (run.status === "running" || run.completedAt === undefined) fail("invalid-query");
      const existing = database.queryOne<RunRow>("SELECT * FROM ingestion_runs WHERE id = ?", [run.id]);
      if (existing === undefined) fail("not-found");
      if (existing.kind !== run.kind || existing.started_at !== run.startedAt || existing.cursor_start !== (run.cursorStart ?? null)) fail("conflict");
      const result = database.execute(`UPDATE ingestion_runs SET
        status=?, cursor_end=?, stories_upserted=?, non_stories_skipped=?,
        error_code=?, error_message=?, completed_at=? WHERE id=?`, [
        run.status, run.cursorEnd ?? null, run.storiesUpserted, run.nonStoriesSkipped,
        run.errorCode ?? null, run.errorMessage ?? null, run.completedAt, run.id,
      ]);
      if (result.changes !== 1) fail("not-found");
    },
    latestRun(kind) {
      nonEmpty(kind);
      const row = database.queryOne<RunRow>(
        "SELECT * FROM ingestion_runs WHERE kind = ? ORDER BY started_at DESC, id DESC LIMIT 1", [kind],
      );
      return row === undefined ? undefined : mapRun(row);
    },
    recentRuns(after, limit) {
      positiveLimit(limit);
      const cursor = descendingCursor("started_at", after);
      return database.query<RunRow>(`SELECT * FROM ingestion_runs WHERE 1=1 ${cursor.clause}
        ORDER BY started_at DESC, id DESC LIMIT ?`, [...cursor.parameters, limit]).map(mapRun);
    },
  };
}

export function createLlmCallRepository(database: Database): LlmCallRepository {
  const byId = (id: string): LlmCallRecord | undefined => {
    const row = database.queryOne<CallRow>("SELECT * FROM llm_calls WHERE id = ?", [id]);
    return row === undefined ? undefined : mapCall(row);
  };
  return {
    insert(input) {
      const call = LlmCallRecordSchema.parse(input);
      const existing = database.queryOne<CallRow>("SELECT * FROM llm_calls WHERE id = ?", [call.id]);
      if (existing !== undefined) {
        if (!sameRecord(mapCall(existing), call)) fail("immutable-conflict");
        return;
      }
      database.execute(`INSERT INTO llm_calls (
        id, purpose, model, status, request_hash, input_tokens, output_tokens, latency_ms,
        provider_request_id, error_code, request_payload_json, request_payload_schema_version,
        response_payload_json, response_payload_schema_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        call.id, call.purpose, call.model, call.status, call.requestHash,
        call.inputTokens ?? null, call.outputTokens ?? null, call.latencyMs,
        call.providerRequestId ?? null, call.errorCode ?? null,
        call.requestPayload === undefined ? null : json(call.requestPayload), call.requestPayloadSchemaVersion ?? null,
        call.responsePayload === undefined ? null : json(call.responsePayload), call.responsePayloadSchemaVersion ?? null,
        call.createdAt,
      ]);
    },
    byId,
    recent(after, limit) {
      positiveLimit(limit);
      const cursor = descendingCursor("created_at", after);
      return database.query<CallRow>(`SELECT * FROM llm_calls WHERE 1=1 ${cursor.clause}
        ORDER BY created_at DESC, id DESC LIMIT ?`, [...cursor.parameters, limit]).map(mapCall);
    },
  };
}

export function createDiagnosticErrorRepository(database: Database): DiagnosticErrorRepository {
  return {
    recentErrors(after, limit) {
      positiveLimit(limit);
      if (after !== undefined) { timestamp(after.timestamp); nonEmpty(after.id); }
      const parameters: Array<string | number> = [];
      let cursor = "";
      if (after !== undefined) {
        cursor = "WHERE occurred_at < ? OR (occurred_at = ? AND id < ?)";
        parameters.push(after.timestamp, after.timestamp, after.id);
      }
      return database.query<{
        id: string; code: string; component: string; occurred_at: string;
        run_id: string | null; story_id: number | null; request_id: string | null;
      }>(`SELECT * FROM (
          SELECT 'ingestion:' || id AS id, error_code AS code, 'ingestion' AS component,
            COALESCE(completed_at, started_at) AS occurred_at, id AS run_id,
            NULL AS story_id, NULL AS request_id
          FROM ingestion_runs WHERE status = 'failed' AND error_code IS NOT NULL
          UNION ALL
          SELECT 'llm:' || id, error_code, 'llm', created_at, NULL, NULL, provider_request_id
          FROM llm_calls WHERE error_code IS NOT NULL
          UNION ALL
          SELECT 'hn-action:' || id, error_code, 'hn-actions', updated_at, NULL, story_id, NULL
          FROM hn_action_intents WHERE error_code IS NOT NULL
        ) ${cursor} ORDER BY occurred_at DESC, id DESC LIMIT ?`, [...parameters, limit]).map((row) =>
        DiagnosticErrorSchema.parse({
          id: row.id, code: row.code, component: row.component, occurredAt: row.occurred_at,
          ...(row.run_id === null ? {} : { runId: row.run_id }),
          ...(row.story_id === null ? {} : { storyId: row.story_id }),
          ...(row.request_id === null ? {} : { requestId: row.request_id }),
        }));
    },
  };
}

export function createAccessSessionRepository(database: Database): AccessSessionRepository {
  return {
    insert(input) {
      const session = AccessSessionRecordSchema.parse(input);
      const existing = database.queryOne<AccessRow>("SELECT * FROM access_sessions WHERE session_hash = ?", [session.sessionHash]);
      if (existing !== undefined) {
        if (!sameRecord(mapAccess(existing), session)) fail("conflict");
        return;
      }
      database.execute(`INSERT INTO access_sessions (
        session_hash, csrf_secret_hash, created_at, expires_at, last_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?)`, [
        session.sessionHash, session.csrfSecretHash, session.createdAt,
        session.expiresAt, session.lastUsedAt, session.revokedAt ?? null,
      ]);
    },
    find(sessionHash) {
      nonEmpty(sessionHash);
      const row = database.queryOne<AccessRow>("SELECT * FROM access_sessions WHERE session_hash = ?", [sessionHash]);
      return row === undefined ? undefined : mapAccess(row);
    },
    touch(sessionHash, at) {
      nonEmpty(sessionHash); timestamp(at);
      database.execute("UPDATE access_sessions SET last_used_at = ? WHERE session_hash = ?", [at, sessionHash]);
    },
    revoke(sessionHash, at) {
      nonEmpty(sessionHash); timestamp(at);
      database.execute("UPDATE access_sessions SET revoked_at = ? WHERE session_hash = ?", [at, sessionHash]);
    },
  };
}
