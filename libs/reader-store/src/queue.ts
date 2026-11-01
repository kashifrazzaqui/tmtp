import type { Database } from "@tmtp/database";
import {
  EvaluationStateSchema,
  QueueEntrySchema,
  QueueStateSchema,
  VisibilityStateSchema,
} from "@tmtp/domain";
import type { EvaluationState, QueueEntry } from "@tmtp/domain";
import type { QueueRepository } from "./types.js";
import { fail } from "./error.js";
import { nonEmpty, positiveLimit, storyId, timestamp } from "./helpers.js";

interface QueueRow {
  story_id: number; state: QueueEntry["state"]; evaluation_state: EvaluationState;
  visibility_state: QueueEntry["visibilityState"]; kind: QueueEntry["kind"];
  recommendation_id: string | null; rank_score: number | null; rank_position: number | null;
  rank_version: string; last_error: string | null; queued_at: string; updated_at: string;
}
const mapQueue = (row: QueueRow): QueueEntry => QueueEntrySchema.parse({
  storyId: row.story_id, state: row.state, evaluationState: row.evaluation_state,
  visibilityState: row.visibility_state, kind: row.kind,
  ...(row.recommendation_id === null ? {} : { recommendationId: row.recommendation_id }),
  ...(row.rank_score === null ? {} : { rankScore: row.rank_score }),
  ...(row.rank_position === null ? {} : { rankPosition: row.rank_position }),
  rankVersion: row.rank_version, ...(row.last_error === null ? {} : { lastError: row.last_error }),
  queuedAt: row.queued_at, updatedAt: row.updated_at,
});
const SECTION_SQL = `CASE evaluation_state WHEN 'scored' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END`;
const section = (evaluation: EvaluationState): number => evaluation === "scored" ? 0 : evaluation === "pending" ? 1 : 2;

export function createQueueRepository(database: Database): QueueRepository {
  const byStoryId = (id: number): QueueEntry | undefined => {
    storyId(id);
    const row = database.queryOne<QueueRow>("SELECT * FROM queue_entries WHERE story_id = ?", [id]);
    return row === undefined ? undefined : mapQueue(row);
  };
  return {
    insertPendingIfMissing(entries) {
      return database.transaction(() => {
        const active = database.queryOne<{ rank_version: string | null }>("SELECT rank_version FROM queue_projection WHERE id = 1");
        let inserted = 0;
        for (const input of entries) {
          const entry = QueueEntrySchema.parse(input);
          if (entry.evaluationState !== "pending" || entry.recommendationId !== undefined || entry.rankScore !== undefined || entry.rankPosition !== undefined) fail("invalid-query");
          const rankVersion = active?.rank_version ?? entry.rankVersion;
          const result = database.execute(`INSERT INTO queue_entries (
            story_id, state, evaluation_state, visibility_state, kind, recommendation_id,
            rank_score, rank_position, rank_version, last_error, queued_at, updated_at
          ) VALUES (?, ?, 'pending', ?, 'match', NULL, NULL, NULL, ?, ?, ?, ?)
          ON CONFLICT(story_id) DO NOTHING`, [
            entry.storyId, entry.state, entry.visibilityState, rankVersion,
            entry.lastError ?? null, entry.queuedAt, entry.updatedAt,
          ]);
          inserted += result.changes;
        }
        return inserted;
      });
    },
    upsertRankingPreservingState(entries) {
      database.transaction(() => {
        for (const input of entries) {
          const entry = QueueEntrySchema.parse(input);
          database.execute(`INSERT INTO queue_entries (
            story_id, state, evaluation_state, visibility_state, kind, recommendation_id,
            rank_score, rank_position, rank_version, last_error, queued_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(story_id) DO UPDATE SET
            state=queue_entries.state, queued_at=queue_entries.queued_at,
            evaluation_state=excluded.evaluation_state, visibility_state=excluded.visibility_state,
            kind=excluded.kind, recommendation_id=excluded.recommendation_id,
            rank_score=excluded.rank_score, rank_position=excluded.rank_position,
            rank_version=excluded.rank_version, last_error=excluded.last_error, updated_at=excluded.updated_at`, [
            entry.storyId, entry.state, entry.evaluationState, entry.visibilityState, entry.kind,
            entry.recommendationId ?? null, entry.rankScore ?? null, entry.rankPosition ?? null,
            entry.rankVersion, entry.lastError ?? null, entry.queuedAt, entry.updatedAt,
          ]);
        }
      });
    },
    byStoryId,
    updateState(id, state, at) {
      storyId(id); timestamp(at);
      if (!QueueStateSchema.safeParse(state).success) fail("invalid-query");
      const result = database.execute("UPDATE queue_entries SET state = ?, updated_at = ? WHERE story_id = ?", [state, at, id]);
      if (result.changes !== 1) fail("not-found");
      return byStoryId(id)!;
    },
    markEvaluation(input) {
      storyId(input.storyId); timestamp(input.at); nonEmpty(input.rankVersion);
      if (input.evaluationState !== "pending" && input.evaluationState !== "failed") fail("invalid-query");
      database.execute(`UPDATE queue_entries SET
        evaluation_state = ?, kind = 'match', recommendation_id = NULL,
        rank_score = NULL, rank_position = NULL, rank_version = ?, last_error = ?, updated_at = ?
        WHERE story_id = ?`, [
        input.evaluationState, input.rankVersion, input.lastError ?? null, input.at, input.storyId,
      ]);
    },
    page(query) {
      positiveLimit(query.limit); nonEmpty(query.rankVersion);
      const visibility = query.visibilityState ?? "visible";
      if (!VisibilityStateSchema.safeParse(visibility).success) fail("invalid-query");
      if (query.state !== undefined && !QueueStateSchema.safeParse(query.state).success) fail("invalid-query");
      if (query.evaluationState !== undefined && !EvaluationStateSchema.safeParse(query.evaluationState).success) fail("invalid-query");
      const conditions = ["rank_version = ?", "visibility_state = ?"];
      const parameters: Array<string | number> = [query.rankVersion, visibility];
      if (query.state !== undefined) { conditions.push("state = ?"); parameters.push(query.state); }
      if (query.evaluationState !== undefined) { conditions.push("evaluation_state = ?"); parameters.push(query.evaluationState); }
      if (query.after !== undefined) {
        const after = query.after;
        if (after.rankVersion !== query.rankVersion || (query.evaluationState !== undefined && after.evaluationState !== query.evaluationState)) fail("invalid-query");
        if (!EvaluationStateSchema.safeParse(after.evaluationState).success) fail("invalid-query");
        storyId(after.storyId);
        if (after.evaluationState === "scored") {
          if (!Number.isSafeInteger(after.rankPosition) || (after.rankPosition ?? 0) < 1) fail("invalid-query");
        } else if (after.rankPosition !== undefined) fail("invalid-query");
        const rankPosition = after.rankPosition ?? 0;
        conditions.push(`(${SECTION_SQL} > ? OR (${SECTION_SQL} = ? AND (
          (evaluation_state = 'scored' AND (rank_position > ? OR (rank_position = ? AND story_id > ?)))
          OR (evaluation_state != 'scored' AND story_id > ?)
        )))`);
        parameters.push(section(after.evaluationState), section(after.evaluationState), rankPosition, rankPosition, after.storyId, after.storyId);
      }
      return database.query<QueueRow>(`SELECT * FROM queue_entries WHERE ${conditions.join(" AND ")}
        ORDER BY ${SECTION_SQL} ASC,
          CASE WHEN evaluation_state = 'scored' THEN rank_position ELSE 0 END ASC,
          story_id ASC LIMIT ?`, [...parameters, query.limit]).map(mapQueue);
    },
    countsByEvaluationState(input = {}) {
      const conditions: string[] = [];
      const parameters: Array<string | number> = [];
      if (input.visibilityState !== undefined) {
        if (!VisibilityStateSchema.safeParse(input.visibilityState).success) fail("invalid-query");
        conditions.push("visibility_state = ?"); parameters.push(input.visibilityState);
      }
      if (input.rankVersion !== undefined) { nonEmpty(input.rankVersion); conditions.push("rank_version = ?"); parameters.push(input.rankVersion); }
      const rows = database.query<{ evaluation_state: EvaluationState; count: number }>(
        `SELECT evaluation_state, COUNT(*) AS count FROM queue_entries ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`} GROUP BY evaluation_state`,
        parameters,
      );
      const counts: Record<string, number> = { pending: 0, scored: 0, failed: 0 };
      for (const row of rows) counts[row.evaluation_state] = row.count;
      return counts;
    },
    forReprojection(afterStoryId, limit) {
      positiveLimit(limit);
      if (afterStoryId !== undefined) storyId(afterStoryId);
      return database.query<QueueRow>(
        "SELECT * FROM queue_entries WHERE story_id > ? ORDER BY story_id ASC LIMIT ?",
        [afterStoryId ?? 0, limit],
      ).map(mapQueue);
    },
    projection() {
      const row = database.queryOne<{ profile_id: string; rank_version: string | null; projected_at: string }>(
        "SELECT * FROM queue_projection WHERE id = 1",
      );
      return row === undefined ? undefined : {
        profileId: row.profile_id,
        ...(row.rank_version === null ? {} : { rankVersion: row.rank_version }),
        projectedAt: row.projected_at,
      };
    },
    setProjection(state) {
      nonEmpty(state.profileId); timestamp(state.projectedAt);
      if (state.rankVersion !== undefined) nonEmpty(state.rankVersion);
      database.execute(`INSERT INTO queue_projection(id, profile_id, rank_version, projected_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id,
          rank_version=excluded.rank_version, projected_at=excluded.projected_at`, [
        state.profileId, state.rankVersion ?? null, state.projectedAt,
      ]);
    },
  };
}
