import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "@tmtp/database";
import { afterEach, describe, expect, it } from "vitest";
import type { IngestionRun } from "@tmtp/domain";
import { createReaderStore, readerStoreMigrations } from "../src/index.js";
import { BEFORE, cleanup, intent, LATER, llmCall, NOW, profile, setup, story } from "./fixtures.js";

afterEach(cleanup);

function run(id: string, startedAt = NOW): IngestionRun {
  return {
    id, kind: "public", status: "running", cursorStart: "before", storiesUpserted: 0,
    nonStoriesSkipped: 0, startedAt,
  };
}

describe("sync LLM access and derived diagnostics", () => {
  it("should round-trip runs audits and sessions with bounded descending keysets", () => {
    const { store } = setup();
    store.sync.setCursor("public", "cursor-1", NOW);
    expect(store.sync.cursor("public")).toBe("cursor-1");
    store.sync.startRun(run("run-1"));
    store.sync.finishRun({ ...run("run-1"), status: "failed", completedAt: LATER, storiesUpserted: 3, errorCode: "fetch-failed", errorMessage: "not exposed" });
    store.sync.startRun(run("run-2", LATER));
    store.sync.finishRun({ ...run("run-2", LATER), status: "complete", completedAt: LATER, storiesUpserted: 2 });
    expect(store.sync.latestRun("public")?.id).toBe("run-2");
    expect(store.sync.recentRuns(undefined, 1).map((row) => row.id)).toEqual(["run-2"]);
    expect(store.sync.recentRuns({ timestamp: LATER, id: "run-2" }, 10).map((row) => row.id)).toEqual(["run-1"]);
    expect(() => store.sync.finishRun({ ...run("run-2", LATER), completedAt: LATER })).toThrowError(expect.objectContaining({ code: "invalid-query" }));

    store.llmCalls.insert(llmCall("call-1"));
    store.llmCalls.insert(llmCall("call-1"));
    expect(store.llmCalls.byId("call-1")).toEqual(llmCall("call-1"));
    expect(() => store.llmCalls.insert({ ...llmCall("call-1"), latencyMs: 9 })).toThrowError(expect.objectContaining({ code: "immutable-conflict" }));
    store.llmCalls.insert({ ...llmCall("call-2"), createdAt: LATER });
    expect(store.llmCalls.recent(undefined, 1).map((row) => row.id)).toEqual(["call-2"]);
    expect(store.llmCalls.recent({ timestamp: LATER, id: "call-2" }, 10).map((row) => row.id)).toEqual(["call-1"]);

    const session = { sessionHash: "session-hash", csrfSecretHash: "csrf-hash", createdAt: BEFORE, expiresAt: LATER, lastUsedAt: NOW };
    store.accessSessions.insert(session);
    store.accessSessions.touch(session.sessionHash, LATER);
    store.accessSessions.revoke(session.sessionHash, LATER);
    expect(store.accessSessions.find(session.sessionHash)).toMatchObject({ lastUsedAt: LATER, revokedAt: LATER });
  });

  it("should derive stable source-prefixed errors without a jobs table or messages", () => {
    const { database, store } = setup();
    store.stories.upsertBatch([story(1)]);
    store.sync.startRun(run("run-1"));
    store.sync.finishRun({ ...run("run-1"), status: "failed", completedAt: LATER, errorCode: "fetch-failed", errorMessage: "secret-message" });
    store.llmCalls.insert({ ...llmCall("call-1"), status: "provider-error", errorCode: "rate-limited" });
    store.hnActions.createIntent(intent("intent-1"));
    store.hnActions.updateOutcome({ ...intent("intent-1"), status: "failed", errorCode: "request-failed" });
    const errors = store.diagnostics.recentErrors(undefined, 10);
    expect(errors.map((row) => row.id)).toEqual(["ingestion:run-1", "llm:call-1", "hn-action:intent-1"]);
    expect(errors.every((row) => row.message === undefined)).toBe(true);
    expect(errors[0]).toMatchObject({ runId: "run-1", component: "ingestion" });
    expect(errors[1]).toMatchObject({ requestId: "provider-1", component: "llm" });
    expect(database.queryOne("SELECT name FROM sqlite_master WHERE name = 'jobs'")).toBeUndefined();
    expect(store.diagnostics.recentErrors({ timestamp: LATER, id: "ingestion:run-1" }, 1).map((row) => row.id)).toEqual(["llm:call-1"]);
  });
});

describe("HN actions and account observations", () => {
  it("should deduplicate intents page exact history and enrich indeterminate outcomes", () => {
    const { store } = setup();
    store.stories.upsertBatch([story(1), story(2)]);
    store.hnActions.createIntent(intent("intent-1"));
    store.hnActions.createIntent(intent("intent-1"));
    expect(() => store.hnActions.createIntent({ ...intent("intent-1"), storyId: 2 })).toThrowError(expect.objectContaining({ code: "conflict" }));
    store.hnActions.createIntent({ ...intent("intent-2"), idempotencyKey: "key-2" });
    expect(store.hnActions.historyForStory(1, undefined, 1).map((row) => row.id)).toEqual(["intent-1"]);
    expect(store.hnActions.historyForStory(1, "intent-1", 10).map((row) => row.id)).toEqual(["intent-2"]);
    expect(() => store.hnActions.historyForStory(2, "intent-1", 10)).toThrowError(expect.objectContaining({ code: "invalid-query" }));
    expect(store.hnActions.byIdempotencyKey("key-intent-1")?.id).toBe("intent-1");
    store.hnActions.updateOutcome({ ...intent("intent-1"), status: "indeterminate", errorCode: "timeout", updatedAt: LATER });
    expect(store.hnActions.pendingOrIndeterminate({ storyId: 1, action: "upvote", status: "indeterminate", limit: 10 }).map((row) => row.id)).toEqual(["intent-1"]);
    store.hnActions.updateOutcome({ ...intent("intent-1"), status: "verified", result: { present: true }, resultSchemaVersion: 1, updatedAt: LATER });
    expect(store.hnActions.byId("intent-1")).toMatchObject({ status: "verified", result: { present: true } });
    expect(() => store.hnActions.updateOutcome({ ...intent("intent-1"), status: "failed", errorCode: "failed" })).toThrowError(expect.objectContaining({ code: "conflict" }));
  });

  it("should upsert observation bounds and read only requested account states", () => {
    const { store } = setup();
    store.stories.upsertBatch([story(1), story(2)]);
    store.hnAccountStates.upsertObservations([
      { username: "reader", storyId: 1, kind: "upvote", present: true, firstObservedAt: NOW, lastObservedAt: NOW, sourceCursor: "a" },
      { username: "reader", storyId: 2, kind: "favorite", present: true, firstObservedAt: NOW, lastObservedAt: NOW },
      { username: "other", storyId: 1, kind: "upvote", present: false, firstObservedAt: NOW, lastObservedAt: NOW },
    ]);
    store.hnAccountStates.upsertObservations([
      { username: "reader", storyId: 1, kind: "upvote", present: false, firstObservedAt: BEFORE, lastObservedAt: LATER, sourceCursor: "b" },
    ]);
    expect(store.hnAccountStates.byStoryIds("reader", "upvote", [2, 1, 99])).toEqual([{
      username: "reader", storyId: 1, kind: "upvote", present: false,
      firstObservedAt: BEFORE, lastObservedAt: LATER, sourceCursor: "b",
    }]);
    expect(store.hnAccountStates.current("reader").map((row) => [row.storyId, row.kind])).toEqual([[1, "upvote"], [2, "favorite"]]);
    expect(store.hnAccountStates.byStoryIds("reader", "upvote", [])).toEqual([]);
  });
});

describe("migration and restart persistence", () => {
  it("should create all sixteen owned tables and retain historical current selection after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "reader-store-"));
    const path = join(directory, "reader.sqlite");
    try {
      const first = openDatabase({ path, busyTimeoutMs: 100, wal: false });
      migrate(first, readerStoreMigrations);
      const store = createReaderStore(first);
      expect(first.query<{ count: number }>("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'")[0]?.count).toBe(16);
      store.profiles.insert(profile("profile-1"));
      store.profiles.insert(profile("profile-2"));
      store.profiles.setCurrent("profile-1", NOW);
      first.close();
      const reopened = openDatabase({ path, busyTimeoutMs: 100, wal: false });
      try {
        expect(createReaderStore(reopened).profiles.current()?.id).toBe("profile-1");
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
