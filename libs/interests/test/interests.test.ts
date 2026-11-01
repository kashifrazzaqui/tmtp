import { InterestProfileSchema } from "@tmtp/domain";
import type { PreferenceRule, StoredActivityEvent, Story } from "@tmtp/domain";
import { describe, expect, it } from "vitest";
import {
  buildInterestProfile,
  INTERESTS_BUILDER_VERSION,
  InterestError,
  isBlacklisted,
  normalizePreferenceValue,
} from "../src/index.js";
import type { InterestPolicy, ProfileBuild } from "../src/index.js";

const NOW = "2026-02-15T00:00:00.000Z";
const policy: InterestPolicy = { decayHalfLifeDays: 45, maxInferredTopics: 50, maxActivityEvents: 5_000 };

function story(id: number, title = "SQLite", author = "Alice", url = "https://www.example.com/article"): Story {
  const raw = {
    id, type: "story" as const, title, author, url, deleted: false, dead: false, raw: {}, rawSchemaVersion: 1 as const,
  };
  return {
    id, itemType: "story", url, canonicalUrl: url, title, author,
    publishedAt: "2026-01-01T00:00:00.000Z", firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z", contentVersion: `story-${id}`,
    raw, rawSchemaVersion: 1, deleted: false, dead: false,
  };
}

function event(
  sequence: number,
  kind: StoredActivityEvent["kind"] = "open",
  storyId = 1,
  occurredAt = "2026-02-15T00:00:00.000Z",
  source: StoredActivityEvent["source"] = "embedded-reader",
): StoredActivityEvent {
  return {
    id: `event-${sequence}`, clientEventId: `client-${sequence}`, storyId, kind,
    valueSchemaVersion: 1, source,
    observationQuality: source === "original-page" || source === "hn-reconciliation" ? "partial" : "full",
    occurredAt, receivedAt: occurredAt, sequence,
  };
}

function rule(
  id: string,
  kind: PreferenceRule["kind"],
  effect: PreferenceRule["effect"],
  value: string,
  enabled = true,
): PreferenceRule {
  return {
    id, kind, effect, value, normalizedValue: normalizePreferenceValue(kind, value), enabled,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function build(overrides: Partial<ProfileBuild> = {}, policyOverrides: Partial<InterestPolicy> = {}) {
  const activity = overrides.activity ?? [];
  const ordered = [...activity].sort((left, right) => left.sequence - right.sequence);
  return buildInterestProfile({
    rules: [], activity, stories: [story(1)], rulesVersion: "rules-1",
    activityVersion: ordered.length === 0 ? "0" : String(ordered.at(-1)!.sequence),
    builtAt: NOW, reason: "test build", ...overrides,
  }, { ...policy, ...policyOverrides });
}

describe("preference normalization", () => {
  it("should normalize Unicode text domains and IP literals exactly", () => {
    expect(normalizePreferenceValue("topic", "  Machine,   LEARNING ")).toBe("machine learning");
    expect(normalizePreferenceValue("keyword", "Ｃ++")).toBe("c");
    expect(normalizePreferenceValue("author", "  ALICE\t  Example ")).toBe("alice example");
    expect(normalizePreferenceValue("author", "Alice-Example!")).toBe("alice-example!");
    expect(normalizePreferenceValue("domain", "BÜCHER.DE.")).toBe("xn--bcher-kva.de");
    expect(normalizePreferenceValue("domain", "127.0.0.1")).toBe("127.0.0.1");
    expect(normalizePreferenceValue("domain", "[::1]")).toBe("[::1]");
  });

  it("should reject invalid and overlong values without echoing them", () => {
    for (const [kind, value] of [
      ["domain", "https://example.com"], ["domain", "example.com:8080"],
      ["domain", "example.com/path"], ["domain", "user@example.com"],
      ["topic", "+++"], ["author", " "], ["topic", "a".repeat(129)],
      ["unknown", "value"],
    ] as const) {
      expect(() => normalizePreferenceValue(kind as never, value)).toThrowError(expect.objectContaining({ code: "invalid-rule" }));
    }
  });

  it("should enforce canonical normalized values and reject duplicate IDs or triplets", () => {
    const valid = rule("r1", "topic", "include", "SQLite");
    expect(() => build({ rules: [{ ...valid, normalizedValue: "sql" }] })).toThrowError(expect.objectContaining({ code: "invalid-rule" }));
    expect(() => build({ rules: [valid, valid] })).toThrowError(expect.objectContaining({ code: "duplicate-rule" }));
    expect(() => build({ rules: [valid, { ...valid, id: "r2" }] })).toThrowError(expect.objectContaining({ code: "duplicate-rule" }));
  });
});

describe("story matching and blacklists", () => {
  it("should match phrase boundaries stop-word lexicon authors and alternate domains", () => {
    const rules = [
      rule("r1", "topic", "exclude", "machine learning"),
      rule("r2", "keyword", "exclude", "the"),
      rule("r3", "author", "exclude", "Alice"),
      rule("r4", "domain", "exclude", "example.com"),
    ];
    const profile = build({ rules });
    const onlyRule = (id: string) => profile.sourceRules.find((item) => item.id === id)!;
    expect(isBlacklisted(story(1, "New machine learning tools"), profile)).toBe(true);
    expect(isBlacklisted(story(1, "machine learning"), profile)).toBe(true);
    expect(isBlacklisted(story(1, "The"), profile)).toBe(true);
    expect(isBlacklisted(story(1, "there"), { ...profile, sourceRules: [onlyRule("r2")] })).toBe(false);
    expect(isBlacklisted(story(1, "Other", "Alice"), { ...profile, sourceRules: [onlyRule("r3")] })).toBe(true);
    expect(isBlacklisted(story(1, "Other", "Alice2"), { ...profile, sourceRules: [onlyRule("r3")] })).toBe(false);
    expect(isBlacklisted(story(1, "Other", "Bob", "https://sub.example.com/a"), { ...profile, sourceRules: [onlyRule("r4")] })).toBe(true);
    expect(isBlacklisted(story(1, "Other", "Bob", "https://badexample.com/a"), { ...profile, sourceRules: [onlyRule("r4")] })).toBe(false);
  });

  it("should ignore disabled excludes and survive malformed alternate URLs", () => {
    const disabled = rule("r1", "domain", "exclude", "example.com", false);
    const profile = build({ rules: [disabled] });
    const target = { ...story(1, "Other", "Bob", "not-a-url"), canonicalUrl: "https://example.com/a" };
    expect(isBlacklisted(target, profile)).toBe(false);
    expect(() => isBlacklisted(target, build({ rules: [rule("r2", "domain", "exclude", "example.com")] }))).not.toThrow();
  });
});

describe("activity evidence", () => {
  it("should apply every base weight and only the non-account partial multiplier", () => {
    const kinds: StoredActivityEvent["kind"][] = ["impression", "open", "dwell", "scroll", "complete", "skip", "dismiss", "upvote", "flag", "favorite"];
    const activity = kinds.map((kind, index) => event(index + 1, kind, 1, NOW, "original-page"));
    const profile = build({ activity });
    const sqlite = profile.interests.find((interest) => interest.topic === "topic:sqlite")!;
    const weights = Object.fromEntries(sqlite.evidence.map((item) => [item.kind, item.weight]));
    expect(weights).toEqual({
      impression: 0.005, open: 0.05, dwell: 0.1, scroll: 0.05, complete: 0.25,
      skip: -0.075, dismiss: -0.25, upvote: 0.8, flag: -0.8, favorite: 1,
    });
  });

  it("should apply exact half-life decay and clamp future occurrences to zero age", () => {
    const profile = build({ activity: [
      event(1, "open", 1, "2026-01-01T00:00:00.000Z"),
      event(2, "open", 1, "2026-02-16T00:00:00.000Z"),
    ] });
    const sqlite = profile.interests.find((interest) => interest.topic === "topic:sqlite")!;
    expect(sqlite.evidence.find((item) => item.kind === "open")).toEqual({ kind: "open", count: 2, weight: 0.15 });
  });

  it("should select the newest sequence window and ignore missing stories outside it", () => {
    const profile = build({ activity: [
      event(10, "favorite", 99), event(20, "open", 1),
    ] }, { maxActivityEvents: 1 });
    expect(profile.activityVersion).toBe("20");
    expect(profile.interests.map((interest) => interest.topic)).toContain("topic:sqlite");
    expect(() => build({ activity: [event(1, "open", 99)] })).toThrowError(expect.objectContaining({ code: "missing-story", storyId: 99 }));
  });

  it("should validate activity endpoints empty logs and zero budgets", () => {
    expect(build().activityVersion).toBe("0");
    expect(() => build({ activityVersion: "1" })).toThrowError(expect.objectContaining({ code: "activity-version-mismatch" }));
    expect(build({ activityVersion: "99" }, { maxActivityEvents: 0 }).interests).toEqual([]);
    expect(build({ activity: [event(1)] }, { maxActivityEvents: 0 }).interests).toEqual([]);
    expect(() => build({ activity: [event(1)], activityVersion: "01" })).toThrowError(expect.objectContaining({ code: "activity-version-mismatch" }));
    expect(() => build({ activity: [event(1), { ...event(2), sequence: 1 }] })).toThrowError(expect.objectContaining({ code: "invalid-input" }));
  });
});

describe("profile assembly", () => {
  it("should pin explicit includes and let excludes remove exact keys", () => {
    const include = rule("include", "topic", "include", "SQLite");
    const pinned = build({ rules: [include], activity: [event(1, "flag")] });
    const sqlite = pinned.interests.find((interest) => interest.topic === "topic:sqlite")!;
    expect(sqlite.weight).toBe(1);
    expect(sqlite.evidence).toEqual(expect.arrayContaining([
      { kind: "explicit-rule", count: 1, weight: 1 },
      { kind: "flag", count: 1, weight: -0.8 },
    ]));
    const excluded = build({ rules: [include, rule("exclude", "topic", "exclude", "SQLite")], activity: [event(1, "flag")] });
    expect(excluded.interests.some((interest) => interest.topic === "topic:sqlite")).toBe(false);
  });

  it("should normalize inferred scores before truncation and omit negative-only keys", () => {
    const stories = [story(1, "Alpha"), story(2, "Beta"), story(3, "Gamma"), story(4, "Delta")]
      .map((item) => ({ ...item, author: undefined, url: undefined, canonicalUrl: undefined }));
    const profile = build({
      stories,
      activity: [
        event(1, "favorite", 1), event(2, "favorite", 1), event(3, "favorite", 2),
        event(4, "complete", 3), event(5, "skip", 4),
      ],
    }, { maxInferredTopics: 2 });
    expect(profile.interests.map((interest) => [interest.topic, interest.weight])).toEqual([
      ["topic:alpha", 1], ["topic:beta", 0.5],
    ]);
    expect(profile.interests.some((interest) => interest.topic === "topic:delta")).toBe(false);
  });

  it("should be byte-equivalent across meaningful input permutations and satisfy the domain schema", () => {
    const rules = [rule("r2", "author", "include", "Alice"), rule("r1", "topic", "include", "SQLite")];
    const activity = [event(2, "complete"), event(1, "open")];
    const first = build({ rules, activity });
    const second = build({ rules: [...rules].reverse(), activity: [...activity].reverse(), stories: [story(1)] });
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(InterestProfileSchema.safeParse(first).success).toBe(true);
    expect(first.builderVersion).toBe(INTERESTS_BUILDER_VERSION);
    expect(first.createdAt).toBe(NOW);
    expect(first.reason).toBe("test build");
    expect(first.sourceRules.map((item) => item.id)).toEqual(["r2", "r1"]);
  });

  it("should reject malformed policies duplicate story/activity IDs and unknown build keys", () => {
    expect(() => build({}, { decayHalfLifeDays: 0 })).toThrowError(expect.objectContaining({ code: "invalid-input" }));
    expect(() => build({ stories: [story(1), story(1)] })).toThrowError(expect.objectContaining({ code: "invalid-input" }));
    expect(() => build({ activity: [event(1), { ...event(2), id: "event-1" }] })).toThrowError(expect.objectContaining({ code: "invalid-input" }));
    expect(() => build({ extra: true } as never)).toThrow(InterestError);
  });
});
