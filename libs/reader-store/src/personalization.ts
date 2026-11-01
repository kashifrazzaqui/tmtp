import { createHash } from "node:crypto";
import type { Database } from "@tmtp/database";
import {
  InterestProfileSchema,
  PreferenceRuleSchema,
  RecommendationSchema,
  RecommendationVersionCountSchema,
} from "@tmtp/domain";
import type { InterestProfile, PreferenceRule, Recommendation } from "@tmtp/domain";
import type { PreferenceRepository, ProfileRepository, RecommendationRepository } from "./types.js";
import { fail } from "./error.js";
import { canonicalJson, ids, json, nonEmpty, parseJson, placeholders, positiveLimit, sameRecord, storyId, timestamp } from "./helpers.js";

interface RuleRow {
  id: string; kind: PreferenceRule["kind"]; effect: PreferenceRule["effect"]; value: string;
  normalized_value: string; enabled: number; created_at: string; updated_at: string;
}
interface ProfileRow {
  id: string; rules_version: string; activity_version: string; source_rules_json: string;
  source_rules_schema_version: number; policy_json: string; policy_schema_version: number;
  policy_version: string; builder_version: string; profile_json: string; profile_schema_version: number;
  reason: string; created_at: string;
}
interface RecommendationRow {
  id: string; story_id: number; profile_id: string; story_content_version: string;
  article_content_version: string; prompt_version: string; model: string; score: number;
  rationale: string; evidence_json: string; evidence_schema_version: number;
  llm_call_id: string | null; created_at: string;
}
const mapRule = (row: RuleRow): PreferenceRule => PreferenceRuleSchema.parse({
  id: row.id, kind: row.kind, effect: row.effect, value: row.value, normalizedValue: row.normalized_value,
  enabled: row.enabled === 1, createdAt: row.created_at, updatedAt: row.updated_at,
});
const mapProfile = (row: ProfileRow): InterestProfile => InterestProfileSchema.parse(parseJson(row.profile_json));
const mapRecommendation = (row: RecommendationRow): Recommendation => RecommendationSchema.parse({
  id: row.id, storyId: row.story_id, profileId: row.profile_id,
  storyContentVersion: row.story_content_version, articleContentVersion: row.article_content_version,
  promptVersion: row.prompt_version, model: row.model, score: row.score, rationale: row.rationale,
  evidence: parseJson(row.evidence_json), evidenceSchemaVersion: row.evidence_schema_version,
  ...(row.llm_call_id === null ? {} : { llmCallId: row.llm_call_id }), createdAt: row.created_at,
});
const rulesVersion = (rules: PreferenceRule[]): string =>
  `rules_${createHash("sha256").update(canonicalJson(rules), "utf8").digest("hex")}`;

export function createPreferenceRepository(database: Database): PreferenceRepository {
  const list = (): PreferenceRule[] => database.query<RuleRow>(
    "SELECT * FROM preference_rules ORDER BY kind ASC, effect ASC, normalized_value ASC",
  ).map(mapRule);
  return {
    list,
    replaceAll(rules) {
      return database.transaction(() => {
        database.execute("DELETE FROM preference_rules");
        for (const input of rules) {
          const rule = PreferenceRuleSchema.parse(input);
          database.execute(`INSERT INTO preference_rules (
            id, kind, effect, value, normalized_value, enabled, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
            rule.id, rule.kind, rule.effect, rule.value, rule.normalizedValue,
            rule.enabled ? 1 : 0, rule.createdAt, rule.updatedAt,
          ]);
        }
        return rulesVersion(list());
      });
    },
    currentVersion() { return rulesVersion(list()); },
  };
}

const VERSION_KEY = `rules_version = ? AND activity_version = ? AND policy_version = ? AND builder_version = ?`;
export function createProfileRepository(database: Database): ProfileRepository {
  const byId = (id: string): InterestProfile | undefined => {
    const row = database.queryOne<ProfileRow>("SELECT * FROM interest_profiles WHERE id = ?", [id]);
    return row === undefined ? undefined : mapProfile(row);
  };
  return {
    insert(input) {
      const profile = InterestProfileSchema.parse(input);
      database.transaction(() => {
        const existing = database.queryOne<ProfileRow>("SELECT * FROM interest_profiles WHERE id = ?", [profile.id]);
        if (existing !== undefined) {
          if (!sameRecord(mapProfile(existing), profile)) fail("immutable-conflict");
          return;
        }
        const sameVersion = database.queryOne<ProfileRow>(`SELECT * FROM interest_profiles WHERE ${VERSION_KEY}`, [
          profile.rulesVersion, profile.activityVersion, profile.policyVersion, profile.builderVersion,
        ]);
        if (sameVersion !== undefined) fail("immutable-conflict");
        database.execute(`INSERT INTO interest_profiles (
          id, rules_version, activity_version, source_rules_json, source_rules_schema_version,
          policy_json, policy_schema_version, policy_version, builder_version,
          profile_json, profile_schema_version, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, [
          profile.id, profile.rulesVersion, profile.activityVersion, json(profile.sourceRules),
          profile.sourceRulesSchemaVersion, json(profile.policy), profile.policySchemaVersion,
          profile.policyVersion, profile.builderVersion, json(profile), profile.reason, profile.createdAt,
        ]);
      });
    },
    setCurrent(profileId, selectedAt) {
      nonEmpty(profileId); timestamp(selectedAt);
      return database.transaction(() => {
        const profile = byId(profileId);
        if (profile === undefined) fail("not-found");
        database.execute(`INSERT INTO current_profile(id, profile_id, selected_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id, selected_at=excluded.selected_at`, [profileId, selectedAt]);
        return profile;
      });
    },
    byId,
    byVersion(key) {
      nonEmpty(key.rulesVersion); nonEmpty(key.activityVersion); nonEmpty(key.policyVersion); nonEmpty(key.builderVersion);
      const row = database.queryOne<ProfileRow>(`SELECT * FROM interest_profiles WHERE ${VERSION_KEY}`, [
        key.rulesVersion, key.activityVersion, key.policyVersion, key.builderVersion,
      ]);
      return row === undefined ? undefined : mapProfile(row);
    },
    current() {
      const row = database.queryOne<ProfileRow>(`SELECT interest_profiles.* FROM current_profile
        JOIN interest_profiles ON interest_profiles.id = current_profile.profile_id WHERE current_profile.id = 1`);
      return row === undefined ? undefined : mapProfile(row);
    },
    history(afterId, limit) {
      positiveLimit(limit);
      let clause = "";
      const parameters: Array<string | number> = [];
      if (afterId !== undefined) {
        const cursor = database.queryOne<ProfileRow>("SELECT * FROM interest_profiles WHERE id = ?", [afterId]);
        if (cursor === undefined) fail("invalid-query");
        clause = "WHERE created_at > ? OR (created_at = ? AND id > ?)";
        parameters.push(cursor.created_at, cursor.created_at, cursor.id);
      }
      return database.query<ProfileRow>(
        `SELECT * FROM interest_profiles ${clause} ORDER BY created_at ASC, id ASC LIMIT ?`,
        [...parameters, limit],
      ).map(mapProfile);
    },
  };
}

export function createRecommendationRepository(database: Database): RecommendationRepository {
  const byId = (id: string): Recommendation | undefined => {
    const row = database.queryOne<RecommendationRow>("SELECT * FROM recommendations WHERE id = ?", [id]);
    return row === undefined ? undefined : mapRecommendation(row);
  };
  return {
    insertImmutable(recommendations) {
      database.transaction(() => {
        for (const input of recommendations) {
          const recommendation = RecommendationSchema.parse(input);
          const existing = database.queryOne<RecommendationRow>("SELECT * FROM recommendations WHERE id = ?", [recommendation.id]);
          if (existing !== undefined) {
            if (!sameRecord(mapRecommendation(existing), recommendation)) fail("immutable-conflict");
            continue;
          }
          const sameKey = database.queryOne<RecommendationRow>(`SELECT * FROM recommendations WHERE
            story_id = ? AND profile_id = ? AND story_content_version = ? AND article_content_version = ?
            AND prompt_version = ? AND model = ?`, [
            recommendation.storyId, recommendation.profileId, recommendation.storyContentVersion,
            recommendation.articleContentVersion, recommendation.promptVersion, recommendation.model,
          ]);
          if (sameKey !== undefined) fail("immutable-conflict");
          database.execute(`INSERT INTO recommendations (
            id, story_id, profile_id, story_content_version, article_content_version,
            prompt_version, model, score, rationale, evidence_json, evidence_schema_version,
            llm_call_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            recommendation.id, recommendation.storyId, recommendation.profileId,
            recommendation.storyContentVersion, recommendation.articleContentVersion,
            recommendation.promptVersion, recommendation.model, recommendation.score,
            recommendation.rationale, json(recommendation.evidence), recommendation.evidenceSchemaVersion,
            recommendation.llmCallId ?? null, recommendation.createdAt,
          ]);
        }
      });
    },
    byId,
    latestForStory(id) {
      storyId(id);
      const row = database.queryOne<RecommendationRow>(
        "SELECT * FROM recommendations WHERE story_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", [id],
      );
      return row === undefined ? undefined : mapRecommendation(row);
    },
    currentForStories(input) {
      nonEmpty(input.profileId); nonEmpty(input.promptVersion); nonEmpty(input.model);
      const unique = ids(input.storyIds);
      if (unique.length === 0) return [];
      return database.query<RecommendationRow>(`SELECT * FROM recommendations
        WHERE profile_id = ? AND prompt_version = ? AND model = ? AND story_id IN (${placeholders(unique.length)})
        ORDER BY story_id ASC, id ASC`, [input.profileId, input.promptVersion, input.model, ...unique]).map(mapRecommendation);
    },
    historyForStory(id, afterId, limit) {
      storyId(id); positiveLimit(limit);
      const parameters: Array<string | number> = [id];
      let cursor = "";
      if (afterId !== undefined) {
        const row = database.queryOne<RecommendationRow>("SELECT * FROM recommendations WHERE id = ? AND story_id = ?", [afterId, id]);
        if (row === undefined) fail("invalid-query");
        cursor = "AND (created_at > ? OR (created_at = ? AND id > ?))";
        parameters.push(row.created_at, row.created_at, row.id);
      }
      return database.query<RecommendationRow>(
        `SELECT * FROM recommendations WHERE story_id = ? ${cursor} ORDER BY created_at ASC, id ASC LIMIT ?`,
        [...parameters, limit],
      ).map(mapRecommendation);
    },
    activeVersionCounts(after, limit) {
      positiveLimit(limit);
      const parameters: Array<string | number> = [];
      let cursor = "";
      if (after !== undefined) {
        nonEmpty(after.profileId); nonEmpty(after.promptVersion); nonEmpty(after.model); nonEmpty(after.rankVersion);
        cursor = `HAVING (
          recommendations.profile_id > ? OR
          (recommendations.profile_id = ? AND recommendations.prompt_version > ?) OR
          (recommendations.profile_id = ? AND recommendations.prompt_version = ? AND recommendations.model > ?) OR
          (recommendations.profile_id = ? AND recommendations.prompt_version = ? AND recommendations.model = ? AND queue_entries.rank_version > ?)
        )`;
        parameters.push(
          after.profileId, after.profileId, after.promptVersion,
          after.profileId, after.promptVersion, after.model,
          after.profileId, after.promptVersion, after.model, after.rankVersion,
        );
      }
      return database.query<{
        profile_id: string; prompt_version: string; model: string; rank_version: string; count: number;
      }>(`SELECT recommendations.profile_id, recommendations.prompt_version, recommendations.model,
          queue_entries.rank_version, COUNT(*) AS count
        FROM queue_entries JOIN recommendations ON recommendations.id = queue_entries.recommendation_id
        GROUP BY recommendations.profile_id, recommendations.prompt_version, recommendations.model, queue_entries.rank_version
        ${cursor}
        ORDER BY recommendations.profile_id ASC, recommendations.prompt_version ASC,
          recommendations.model ASC, queue_entries.rank_version ASC LIMIT ?`, [...parameters, limit]).map((row) =>
        RecommendationVersionCountSchema.parse({
          profileId: row.profile_id, promptVersion: row.prompt_version, model: row.model,
          rankVersion: row.rank_version, queueEntryCount: row.count,
        }));
    },
  };
}
