import { createHash } from "node:crypto";
import { articleContentVersion } from "@tmtp/domain";
import type { Article, InterestProfile, QueueEntry, Recommendation, Story } from "@tmtp/domain";
import { describe, expect, it } from "vitest";
import {
  decodeQueueCursor,
  encodeQueueCursor,
  paginateQueue,
  QUEUE_BOOTSTRAP_RANK_VERSION,
  QUEUE_RANK_ALGORITHM_VERSION,
  rankQueue,
  transitionQueueState,
} from "../src/index.js";
import type { QueueCursorPosition, RankQueueInput } from "../src/index.js";

const AT = "2026-02-01T00:00:00.000Z";
const BEFORE = "2026-01-01T00:00:00.000Z";
const profile: InterestProfile = {
  id: "profile-1", rulesVersion: "rules-1", activityVersion: "1", sourceRules: [], sourceRulesSchemaVersion: 1,
  policy: {}, policySchemaVersion: 1, policyVersion: "ip1.test", builderVersion: "interests/1",
  interests: [], reason: "fixture", createdAt: BEFORE,
};
function story(id: number, flags: { deleted?: boolean; dead?: boolean } = {}): Story {
  return {
    id, itemType: "story", title: `Story ${id}`, canonicalUrl: `https://example.com/${id}`,
    publishedAt: BEFORE, firstSeenAt: BEFORE, lastSeenAt: BEFORE, contentVersion: `story-v${id}`,
    raw: { id, type: "story", title: `Story ${id}`, deleted: flags.deleted ?? false, dead: flags.dead ?? false, raw: {}, rawSchemaVersion: 1 },
    rawSchemaVersion: 1, deleted: flags.deleted ?? false, dead: flags.dead ?? false,
  };
}
function recommendation(id: number, score: number, overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: `rec-${id}`, storyId: id, profileId: profile.id, storyContentVersion: `story-v${id}`,
    articleContentVersion: "none", promptVersion: "prompt-1", model: "model-1", score,
    rationale: "fixture", evidence: [], evidenceSchemaVersion: 1, llmCallId: `call-${id}`, createdAt: BEFORE,
    ...overrides,
  };
}
function article(storyId: number, contentHash = "article-hash"): Article {
  const base = {
    storyId, status: "ready" as const, sourceContentVersion: `story-v${storyId}`, contentVersion: "",
    title: `Article ${storyId}`, contentHash, extractorVersion: "extractor-1", updatedAt: BEFORE,
  };
  return { ...base, contentVersion: articleContentVersion(base as Article) };
}
function input(stories: Story[], overrides: Partial<RankQueueInput> = {}): RankQueueInput {
  return {
    stories, articles: [], recommendations: [], evaluationByStory: {}, profile,
    blacklistedStoryIds: [], explorationRatio: 0, at: AT, ...overrides,
  };
}
function entry(storyId: number, evaluationState: QueueEntry["evaluationState"] = "pending", rankPosition?: number): QueueEntry {
  return {
    storyId, state: "unread", evaluationState, visibilityState: "visible", kind: "match",
    ...(evaluationState === "scored" ? { recommendationId: `rec-${storyId}`, rankScore: 0.5, rankPosition: rankPosition ?? storyId } : {}),
    rankVersion: "rank-1", queuedAt: BEFORE, updatedAt: BEFORE,
  };
}

describe("complete projection and active judgments", () => {
  it("should retain every story reading history visibility and evaluation section", () => {
    const existing = [
      { ...entry(1, "scored", 1), state: "read" as const, queuedAt: BEFORE },
      { ...entry(3, "failed"), lastError: "safe failure" },
    ];
    const result = rankQueue(input([story(1), story(2), story(3), story(4, { deleted: true, dead: true })], {
      recommendations: [recommendation(1, 0.9), recommendation(2, 0.8)],
      evaluationByStory: { 3: "failed" }, existingEntries: existing, blacklistedStoryIds: [2],
    }));
    expect(result.map((row) => [row.storyId, row.evaluationState])).toEqual([[1, "scored"], [2, "scored"], [4, "pending"], [3, "failed"]]);
    expect(result[0]).toMatchObject({ state: "read", queuedAt: BEFORE, rankScore: 0.9, rankPosition: 1 });
    expect(result[1]).toMatchObject({ visibilityState: "blacklisted", rankPosition: 2 });
    expect(result[3]).toMatchObject({ lastError: "safe failure", kind: "match" });
    expect(result[3]?.rankPosition).toBeUndefined();
    expect(result[2]).toMatchObject({ visibilityState: "visible", state: "unread" });
    expect(result[2]?.recommendationId).toBeUndefined();
    expect(new Set(result.map((row) => row.rankVersion)).size).toBe(1);
  });

  it("should activate only the exact profile story and article content version", () => {
    const currentArticle = article(1);
    const active = recommendation(1, 0.75, { articleContentVersion: currentArticle.contentVersion });
    const result = rankQueue(input([story(1)], { articles: [currentArticle], recommendations: [active] }));
    expect(result[0]).toMatchObject({ evaluationState: "scored", recommendationId: "rec-1" });
    const stale = rankQueue(input([story(1)], {
      articles: [currentArticle],
      recommendations: [{ ...active, articleContentVersion: "none" }, recommendation(2, 0.2, { storyId: 1, profileId: "old-profile" })],
    }));
    expect(stale[0]).toMatchObject({ evaluationState: "pending" });
    expect(stale[0]?.recommendationId).toBeUndefined();
    expect(stale[0]?.rankVersion).not.toBe(result[0]?.rankVersion);
    const changedArticle = article(1, "changed-hash");
    const changed = rankQueue(input([story(1)], { articles: [changedArticle], recommendations: [active] }));
    expect(changed[0]?.evaluationState).toBe("pending");
  });

  it("should reject duplicates orphans missing ambiguous and conflicting evaluations", () => {
    expect(() => rankQueue(input([story(1), story(1)]))).toThrowError(expect.objectContaining({ code: "duplicate-story" }));
    expect(() => rankQueue(input([story(1)], { articles: [article(1), article(1)] }))).toThrowError(expect.objectContaining({ code: "duplicate-article" }));
    expect(() => rankQueue(input([story(1)], { articles: [article(2)] }))).toThrowError(expect.objectContaining({ code: "unknown-story" }));
    expect(() => rankQueue(input([story(1)], { blacklistedStoryIds: [2] }))).toThrowError(expect.objectContaining({ code: "unknown-story" }));
    expect(() => rankQueue(input([story(1)], { evaluationByStory: { 1: "scored" } }))).toThrowError(expect.objectContaining({ code: "missing-recommendation" }));
    expect(() => rankQueue(input([story(1)], { recommendations: [recommendation(1, 0.5), recommendation(1, 0.4, { id: "other" })] }))).toThrowError(expect.objectContaining({ code: "ambiguous-recommendation" }));
    expect(() => rankQueue(input([story(1)], { recommendations: [recommendation(1, 0.5)], evaluationByStory: { 1: "failed" } }))).toThrowError(expect.objectContaining({ code: "evaluation-conflict" }));
    expect(() => rankQueue(input([story(1)], { recommendations: [recommendation(1, 0.5), recommendation(1, 0.4)] }))).toThrowError(expect.objectContaining({ code: "invalid-input" }));
  });

  it("should preserve failure details only across failed-to-failed projection and reject backward time", () => {
    const prior = { ...entry(1, "failed"), lastError: "old", updatedAt: AT };
    expect(rankQueue(input([story(1)], { evaluationByStory: { 1: "pending" }, existingEntries: [prior] }))[0]?.lastError).toBeUndefined();
    expect(rankQueue(input([story(1)], { evaluationByStory: { 1: "failed" }, existingEntries: [prior] }))[0]?.lastError).toBe("old");
    expect(() => rankQueue(input([story(1)], { existingEntries: [prior], at: BEFORE }))).toThrowError(expect.objectContaining({ code: "invalid-input" }));
  });
});

describe("ranking exploration and versions", () => {
  it("should sort scores descending with story ID ties and pin a golden rank version", () => {
    const result = rankQueue(input([story(2), story(1)], {
      recommendations: [recommendation(2, 0.75), recommendation(1, 0.75)],
    }));
    expect(result.map((row) => [row.storyId, row.rankPosition])).toEqual([[1, 1], [2, 2]]);
    const golden = rankQueue(input([story(1)], { recommendations: [recommendation(1, 0.75)] }));
    expect(golden[0]?.rankVersion).toBe("qr1.c1c3659a8671d48a0caea0afc8cccdb939b989538870c1ec7e1d017e986ea908");
    expect(QUEUE_RANK_ALGORITHM_VERSION).toBe("queue-rank/1");
    expect(QUEUE_BOOTSTRAP_RANK_VERSION).toBe("qb1.initial");
  });

  it("should select the lower visible half by hash and merge at exact positions", () => {
    const stories = Array.from({ length: 6 }, (_, index) => story(index + 1));
    const recommendations = stories.map((item, index) => recommendation(item.id, 1 - index * 0.1));
    const result = rankQueue(input(stories, { recommendations, explorationRatio: 0.5 }));
    expect(result.map((row) => [row.storyId, row.kind, row.rankPosition])).toEqual([
      [5, "exploration", 1], [1, "match", 2], [4, "exploration", 3],
      [2, "match", 4], [6, "exploration", 5], [3, "match", 6],
    ]);
  });

  it("should never select blacklisted rows and should include them in rank positions", () => {
    const stories = Array.from({ length: 6 }, (_, index) => story(index + 1));
    const recommendations = stories.map((item, index) => recommendation(item.id, 1 - index * 0.1));
    const result = rankQueue(input(stories, { recommendations, explorationRatio: 0.5, blacklistedStoryIds: [5, 6] }));
    expect(result.filter((row) => row.kind === "exploration").every((row) => row.visibilityState === "visible")).toBe(true);
    expect(result.map((row) => row.rankPosition)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.find((row) => row.storyId === 5)?.visibilityState).toBe("blacklisted");
    expect(result.find((row) => row.storyId === 6)?.visibilityState).toBe("blacklisted");
  });

  it("should keep rank versions stable under input permutation reading and time but change semantic inputs", () => {
    const stories = [story(1), story(2)];
    const recommendations = [recommendation(1, 0.8), recommendation(2, 0.7)];
    const first = rankQueue(input(stories, { recommendations }));
    const second = rankQueue(input([...stories].reverse(), {
      recommendations: [...recommendations].reverse(), at: "2026-03-01T00:00:00.000Z",
      existingEntries: [{ ...entry(1, "scored", 1), state: "read" }],
    }));
    expect(second.map((row) => row.rankVersion)).toEqual(first.map((row) => row.rankVersion));
    expect(rankQueue(input(stories, { recommendations, explorationRatio: 0.1 }))[0]?.rankVersion).not.toBe(first[0]?.rankVersion);
    expect(rankQueue(input(stories, { recommendations, explorationSeed: "other" }))[0]?.rankVersion).not.toBe(first[0]?.rankVersion);
    expect(rankQueue(input(stories, { recommendations, blacklistedStoryIds: [1] }))[0]?.rankVersion).not.toBe(first[0]?.rankVersion);
  });
});

describe("reading-state transitions", () => {
  it("should implement every matrix cell preserve fields and make no-op timestamps stable", () => {
    const states: QueueEntry["state"][] = ["unread", "reading", "read", "dismissed", "archived"];
    for (const from of states) {
      for (const to of states) {
        const original = { ...entry(1), state: from };
        const rejected = (from === "dismissed" && ["reading", "read"].includes(to)) || (from === "archived" && ["reading", "read", "dismissed"].includes(to));
        if (rejected) {
          expect(() => transitionQueueState(original, to, AT)).toThrowError(expect.objectContaining({ code: "invalid-transition", from, to }));
        } else {
          const changed = transitionQueueState(original, to, AT);
          expect(changed).not.toBe(original);
          expect(changed.state).toBe(to);
          expect(changed.updatedAt).toBe(from === to ? BEFORE : AT);
          expect(changed.rankVersion).toBe(original.rankVersion);
          expect(changed.queuedAt).toBe(original.queuedAt);
        }
      }
    }
    expect(() => transitionQueueState(entry(1), "read", "2025-01-01T00:00:00.000Z")).toThrowError(expect.objectContaining({ code: "invalid-input" }));
    expect(() => transitionQueueState(entry(1), "unknown" as never, AT)).toThrowError(expect.objectContaining({ code: "invalid-input" }));
  });
});

function rawCursor(value: unknown): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
  return `q1.${bytes.toString("base64url")}.${createHash("sha256").update(bytes).digest("base64url")}`;
}

describe("strict cursor codec", () => {
  it("should round-trip and match independent golden cursors", () => {
    const cases: Array<[QueueCursorPosition, string]> = [
      [{ rankVersion: "rank-1", evaluationState: "scored", rankPosition: 2, storyId: 7 }, "q1.eyJyYW5rVmVyc2lvbiI6InJhbmstMSIsImV2YWx1YXRpb25TdGF0ZSI6InNjb3JlZCIsInJhbmtQb3NpdGlvbiI6Miwic3RvcnlJZCI6N30.xtLgD4s_6HqI9yVTdPnHwHxXyTxZ4yP2rhOEHNYNuRI"],
      [{ rankVersion: "δοκιμή", evaluationState: "pending", storyId: 8 }, "q1.eyJyYW5rVmVyc2lvbiI6Is60zr_Ous65zrzOriIsImV2YWx1YXRpb25TdGF0ZSI6InBlbmRpbmciLCJzdG9yeUlkIjo4fQ.EV9ITWFnK52AKYAHJfoFG2lAgDI87U3YKfg3FthV9RY"],
      [{ rankVersion: "rank-1", evaluationState: "failed", storyId: 9 }, "q1.eyJyYW5rVmVyc2lvbiI6InJhbmstMSIsImV2YWx1YXRpb25TdGF0ZSI6ImZhaWxlZCIsInN0b3J5SWQiOjl9.07WGVXjpK_sT4oteeeq3yH0lsPjqkZD5T8aeRoBUbwI"],
    ];
    for (const [position, golden] of cases) {
      expect(encodeQueueCursor(position)).toBe(golden);
      expect(decodeQueueCursor(golden)).toEqual(position);
    }
  });

  it("should reject noncanonical malformed and checksummed-but-invalid cursors without payload leaks", () => {
    const valid = encodeQueueCursor({ rankVersion: "secret-cursor-payload", evaluationState: "pending", storyId: 1 });
    const invalid: unknown[] = [
      null, "", "x".repeat(2_049), valid.replace("q1", "q2"), valid + ".extra",
      valid.replace(/\.([^.]+)$/, ".$1="), "q1.***.***",
      rawCursor(Buffer.from([0xff])), rawCursor("not json"),
      rawCursor({ evaluationState: "pending", rankVersion: "rank-1", storyId: 1 }),
      rawCursor({ rankVersion: "rank-1", evaluationState: "pending", storyId: 1, extra: true }),
      rawCursor({ rankVersion: "rank-1", evaluationState: "scored", storyId: 1 }),
      rawCursor({ rankVersion: "rank-1", evaluationState: "pending", rankPosition: 1, storyId: 1 }),
      rawCursor({ rankVersion: "rank-1", evaluationState: "pending", storyId: 0 }),
      rawCursor("{ \"rankVersion\":\"rank-1\",\"evaluationState\":\"pending\",\"storyId\":1 }"),
    ];
    for (const cursor of invalid) {
      expect(() => decodeQueueCursor(cursor as string)).toThrowError(expect.objectContaining({ code: "invalid-cursor" }));
    }
    expect(() => decodeQueueCursor(valid.slice(0, -1) + (valid.endsWith("A") ? "B" : "A"))).toThrowError(expect.objectContaining({ code: "invalid-cursor" }));
    try {
      decodeQueueCursor(valid.slice(0, -1) + "A");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-cursor-payload");
    }
    expect(() => encodeQueueCursor({ rankVersion: "", evaluationState: "pending", storyId: 1 })).toThrowError(expect.objectContaining({ code: "invalid-cursor" }));
  });
});

describe("keyset pagination", () => {
  it("should concatenate mixed-section pages without duplicates omissions or a terminal cursor", () => {
    const entries = [entry(4, "failed"), entry(3, "pending"), entry(2, "scored", 1), entry(1, "scored", 1)];
    const collected: number[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = paginateQueue(entries, cursor, 1);
      collected.push(...page.entries.map((row) => row.storyId));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    expect(collected).toEqual([1, 2, 3, 4]);
    expect(paginateQueue(entries, undefined, 4).nextCursor).toBeUndefined();
    expect(paginateQueue([], undefined, 2)).toEqual({ entries: [] });
  });

  it("should resume by tuple after the original row disappears and enforce cursor compatibility", () => {
    const entries = [entry(1, "scored", 1), entry(2, "scored", 2), entry(3, "pending")];
    const first = paginateQueue(entries, undefined, 2);
    const resumed = paginateQueue([entries[0]!, entries[2]!], first.nextCursor, 2);
    expect(resumed.entries.map((row) => row.storyId)).toEqual([3]);
    const wrongVersion = encodeQueueCursor({ rankVersion: "other", evaluationState: "scored", rankPosition: 1, storyId: 1 });
    expect(() => paginateQueue(entries, wrongVersion, 2)).toThrowError(expect.objectContaining({ code: "cursor-version-mismatch" }));
    const scoredCursor = encodeQueueCursor({ rankVersion: "rank-1", evaluationState: "scored", rankPosition: 1, storyId: 1 });
    expect(() => paginateQueue([entry(3, "pending")], scoredCursor, 2)).toThrowError(expect.objectContaining({ code: "cursor-section-mismatch" }));
    expect(() => paginateQueue([], "bad", 2)).toThrowError(expect.objectContaining({ code: "invalid-cursor" }));
    expect(() => paginateQueue(entries, undefined, 0)).toThrowError(expect.objectContaining({ code: "invalid-page-size" }));
  });
});
