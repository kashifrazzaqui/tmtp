import type { Migration } from "@tmtp/database";

export const readerStoreMigrations: Migration[] = [{
  id: "0010_reader_foundation",
  sql: `
    CREATE TABLE stories (
      id INTEGER PRIMARY KEY,
      item_type TEXT NOT NULL CHECK(item_type = 'story'),
      url TEXT, canonical_url TEXT, title TEXT NOT NULL, author TEXT, text_html TEXT,
      score INTEGER, descendants INTEGER,
      published_at TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      content_version TEXT NOT NULL, raw_json TEXT NOT NULL, raw_schema_version INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0, dead INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX stories_published ON stories(published_at, id);
    CREATE INDEX stories_canonical_url ON stories(canonical_url);
    CREATE INDEX stories_last_seen ON stories(last_seen_at, id);

    CREATE TABLE articles (
      story_id INTEGER PRIMARY KEY REFERENCES stories(id),
      status TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
      source_content_version TEXT NOT NULL, content_version TEXT NOT NULL,
      source_url TEXT, final_url TEXT, title TEXT, byline TEXT, excerpt TEXT,
      text_content TEXT, sanitized_html TEXT, content_hash TEXT, extractor_version TEXT,
      fetched_at TEXT, updated_at TEXT NOT NULL, error_code TEXT, error_message TEXT
    );
    CREATE INDEX articles_status_updated ON articles(status, updated_at);
    CREATE INDEX articles_content_hash ON articles(content_hash);

    CREATE TABLE ingestion_cursors (
      name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE ingestion_runs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','complete','failed')),
      cursor_start TEXT, cursor_end TEXT,
      stories_upserted INTEGER NOT NULL, non_stories_skipped INTEGER NOT NULL,
      error_code TEXT, error_message TEXT, started_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE INDEX ingestion_runs_kind_started ON ingestion_runs(kind, started_at, id);
    CREATE INDEX ingestion_runs_started ON ingestion_runs(started_at DESC, id DESC);

    CREATE TABLE reading_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE, client_event_id TEXT NOT NULL UNIQUE,
      story_id INTEGER NOT NULL REFERENCES stories(id), kind TEXT NOT NULL,
      value_json TEXT, value_schema_version INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('embedded-reader','original-page','hn-reconciliation','app-action')),
      observation_quality TEXT NOT NULL CHECK(observation_quality IN ('full','partial')),
      occurred_at TEXT NOT NULL, received_at TEXT NOT NULL
    );
    CREATE INDEX reading_events_story_occurred ON reading_events(story_id, occurred_at);
    CREATE INDEX reading_events_kind_occurred ON reading_events(kind, occurred_at);
    CREATE INDEX reading_events_client ON reading_events(client_event_id, sequence);

    CREATE TABLE reading_sessions (
      id TEXT PRIMARY KEY, story_id INTEGER NOT NULL REFERENCES stories(id),
      started_at TEXT NOT NULL, ended_at TEXT, updated_at TEXT NOT NULL,
      active_dwell_ms INTEGER NOT NULL, max_scroll_ratio REAL NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','complete','abandoned')),
      observation_quality TEXT NOT NULL CHECK(observation_quality IN ('full','partial')),
      last_client_event_id TEXT NOT NULL UNIQUE
    );
    CREATE INDEX reading_sessions_story_updated ON reading_sessions(story_id, updated_at, id);
    CREATE INDEX reading_sessions_state_updated ON reading_sessions(state, updated_at);

    CREATE TABLE preference_rules (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('topic','keyword','author','domain')),
      effect TEXT NOT NULL CHECK(effect IN ('include','exclude')),
      value TEXT NOT NULL, normalized_value TEXT NOT NULL, enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(kind, effect, normalized_value)
    );
    CREATE INDEX preference_rules_enabled_effect ON preference_rules(enabled, effect);

    CREATE TABLE interest_profiles (
      id TEXT PRIMARY KEY, rules_version TEXT NOT NULL, activity_version TEXT NOT NULL,
      source_rules_json TEXT NOT NULL, source_rules_schema_version INTEGER NOT NULL,
      policy_json TEXT NOT NULL, policy_schema_version INTEGER NOT NULL,
      policy_version TEXT NOT NULL, builder_version TEXT NOT NULL,
      profile_json TEXT NOT NULL, profile_schema_version INTEGER NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(rules_version, activity_version, policy_version, builder_version)
    );
    CREATE INDEX interest_profiles_created ON interest_profiles(created_at, id);
    CREATE TABLE current_profile (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      profile_id TEXT NOT NULL REFERENCES interest_profiles(id), selected_at TEXT NOT NULL
    );

    CREATE TABLE llm_calls (
      id TEXT PRIMARY KEY, purpose TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
      request_hash TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
      latency_ms INTEGER NOT NULL, provider_request_id TEXT, error_code TEXT,
      request_payload_json TEXT, request_payload_schema_version INTEGER,
      response_payload_json TEXT, response_payload_schema_version INTEGER, created_at TEXT NOT NULL
    );
    CREATE INDEX llm_calls_created ON llm_calls(created_at DESC, id DESC);
    CREATE INDEX llm_calls_request_hash ON llm_calls(request_hash);
    CREATE INDEX llm_calls_purpose_status ON llm_calls(purpose, status);

    CREATE TABLE recommendations (
      id TEXT PRIMARY KEY, story_id INTEGER NOT NULL REFERENCES stories(id),
      profile_id TEXT NOT NULL REFERENCES interest_profiles(id),
      story_content_version TEXT NOT NULL, article_content_version TEXT NOT NULL,
      prompt_version TEXT NOT NULL, model TEXT NOT NULL,
      score REAL NOT NULL, rationale TEXT NOT NULL,
      evidence_json TEXT NOT NULL, evidence_schema_version INTEGER NOT NULL,
      llm_call_id TEXT REFERENCES llm_calls(id), created_at TEXT NOT NULL,
      UNIQUE(story_id, profile_id, story_content_version, article_content_version, prompt_version, model)
    );
    CREATE INDEX recommendations_profile_story ON recommendations(profile_id, story_id);
    CREATE INDEX recommendations_story_created ON recommendations(story_id, created_at, id);

    CREATE TABLE queue_entries (
      story_id INTEGER PRIMARY KEY REFERENCES stories(id),
      state TEXT NOT NULL CHECK(state IN ('unread','reading','read','dismissed','archived')),
      evaluation_state TEXT NOT NULL CHECK(evaluation_state IN ('pending','scored','failed')),
      visibility_state TEXT NOT NULL CHECK(visibility_state IN ('visible','blacklisted')),
      kind TEXT NOT NULL CHECK(kind IN ('match','exploration')),
      recommendation_id TEXT REFERENCES recommendations(id), rank_score REAL, rank_position INTEGER,
      rank_version TEXT NOT NULL, last_error TEXT, queued_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX queue_entries_page ON queue_entries(visibility_state, state, rank_version, rank_position, story_id);
    CREATE INDEX queue_entries_evaluation_updated ON queue_entries(evaluation_state, updated_at);
    CREATE TABLE queue_projection (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      profile_id TEXT NOT NULL REFERENCES interest_profiles(id),
      rank_version TEXT, projected_at TEXT NOT NULL
    );

    CREATE TABLE hn_action_intents (
      id TEXT PRIMARY KEY, story_id INTEGER NOT NULL REFERENCES stories(id),
      action TEXT NOT NULL CHECK(action IN ('upvote','flag','favorite')),
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('pending','verified','indeterminate','failed')),
      result_json TEXT, result_schema_version INTEGER, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX hn_action_story_created ON hn_action_intents(story_id, action, created_at, id);
    CREATE INDEX hn_action_filtered ON hn_action_intents(status, story_id, action, created_at, id);
    CREATE TABLE hn_account_states (
      username TEXT NOT NULL, story_id INTEGER NOT NULL REFERENCES stories(id),
      kind TEXT NOT NULL CHECK(kind IN ('upvote','flag','favorite')),
      present INTEGER NOT NULL, first_observed_at TEXT NOT NULL, last_observed_at TEXT NOT NULL,
      source_cursor TEXT, PRIMARY KEY(username, story_id, kind)
    );
    CREATE INDEX hn_account_present ON hn_account_states(username, kind, present);
    CREATE INDEX hn_account_story_ids ON hn_account_states(username, kind, story_id);

    CREATE TABLE access_sessions (
      session_hash TEXT PRIMARY KEY, csrf_secret_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_used_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE INDEX access_sessions_expires ON access_sessions(expires_at);
    CREATE INDEX access_sessions_revoked ON access_sessions(revoked_at);
  `,
}];
