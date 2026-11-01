import { createFixedClock } from "@tmtp/clock";
import type { ReadingSession, StoredActivityEvent } from "@tmtp/domain";
import { describe, expect, it } from "vitest";
import {
  ActivityError,
  parseActivityBatch,
  reduceActivity,
} from "../src/index.js";
import type { ActivityPolicy, RawActivity } from "../src/index.js";

const ID = (letter: string) => letter.repeat(43);
const time = (seconds: number) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + seconds * 1000).toISOString();
const clockAt = (seconds = 100) => createFixedClock(new Date(time(seconds)));
const policy: ActivityPolicy = { idleTimeoutMs: 60_000, minDwellMs: 1_000, maxSessionGapMs: 300_000 };

function raw(
  kind: string,
  id: string,
  seconds = 0,
  source = "embedded-reader",
  value?: Record<string, unknown>,
): RawActivity {
  return {
    clientEventId: id,
    storyId: 1,
    kind,
    source,
    ...(source === "hn-reconciliation" ? {} : { occurredAt: time(seconds) }),
    ...(value === undefined ? {} : { value }),
  } as RawActivity;
}

const reduce = (
  batch: RawActivity[],
  previous?: ReadingSession,
  existing: StoredActivityEvent[] = [],
  clock = clockAt(),
) => reduceActivity(batch, previous, policy, clock, existing);

describe("parseActivityBatch", () => {
  it("should parse every kind/source/value combination and return defensive clones", () => {
    const input: RawActivity[] = [
      raw("impression", ID("A")), raw("open", ID("B"), 1, "original-page"),
      raw("dwell", ID("C"), 2, "embedded-reader", { activeMs: 2_000 }),
      raw("scroll", ID("D"), 3, "original-page", { ratio: 0.5 }),
      raw("complete", ID("E"), 4), raw("skip", ID("F"), 5),
      raw("dismiss", ID("G"), 6, "app-action"),
      raw("upvote", ID("H"), 7, "app-action", { present: true }),
      raw("flag", ID("I"), 8, "app-action", { present: true }),
      raw("favorite", ID("J"), 9, "app-action", { present: true }),
      raw("upvote", ID("K"), 0, "hn-reconciliation", { present: false }),
    ];
    const parsed = parseActivityBatch(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed[2]).not.toBe(input[2]);
    expect(parsed[2]?.value).not.toBe(input[2]?.value);
    (parsed[2]!.value as { activeMs: number }).activeMs = 9;
    expect(input[2]?.value).toEqual({ activeMs: 2_000 });
  });

  it("should preserve exact duplicates and reject conflicting in-batch identities", () => {
    const duplicate = raw("open", ID("A"));
    expect(parseActivityBatch([duplicate, structuredClone(duplicate)])).toHaveLength(2);
    expect(() => parseActivityBatch([duplicate, raw("dwell", ID("A"), 0, "embedded-reader", { activeMs: 1 })]))
      .toThrowError(expect.objectContaining({ code: "idempotency-conflict", batchIndex: 1 }));
  });

  it("should reject unknown keys invalid identities timestamps values and mixed stories without echoing input", () => {
    const sentinel = "sensitive-input-sentinel";
    const invalid: unknown[] = [
      null, [], { ...raw("open", ID("A")), extra: sentinel },
      raw("open", "bad"), raw("open", ID("A"), 0, "hn-reconciliation"),
      { ...raw("open", ID("A")), occurredAt: "2026-01-01T00:00:00Z" },
      { ...raw("open", ID("A")), value: null },
      raw("dwell", ID("A"), 0, "embedded-reader", { activeMs: -1 }),
      raw("scroll", ID("A"), 0, "embedded-reader", { ratio: Number.NaN }),
      raw("upvote", ID("A"), 0, "app-action", { present: false }),
      { ...raw("upvote", ID("A"), 0, "hn-reconciliation", { present: true }), occurredAt: time(0) },
    ];
    for (const row of invalid) {
      try {
        parseActivityBatch([row]);
        throw new Error("unreachable");
      } catch (error) {
        expect(error).toBeInstanceOf(ActivityError);
        expect((error as ActivityError).code).toBe("invalid-activity");
        expect((error as ActivityError).batchIndex).toBe(0);
        expect(JSON.stringify(error)).not.toContain(sentinel);
      }
    }
    expect(() => parseActivityBatch([raw("open", ID("A")), { ...raw("open", ID("B")), storyId: 2 }]))
      .toThrowError(expect.objectContaining({ code: "invalid-activity", batchIndex: 1 }));
    expect(() => parseActivityBatch("not-array" as never)).toThrowError(expect.objectContaining({ code: "invalid-activity", batchIndex: undefined }));
  });

  it("should expose fixed messages and validate direct batch indexes", () => {
    expect(new ActivityError("invalid-policy").message).toBe("Activity policy is invalid.");
    expect(new ActivityError("session-overflow", 0).batchIndex).toBe(0);
    expect(() => new ActivityError("invalid-activity", -1)).toThrow(TypeError);
    expect(() => new ActivityError("invalid-activity", 1.5)).toThrow(TypeError);
  });
});

describe("event normalization and replay", () => {
  it("should use one receipt deterministic IDs and canonical event order", () => {
    const clock = clockAt(10);
    const result = reduceActivity([
      raw("upvote", ID("B"), 2, "app-action", { present: true }),
      raw("favorite", ID("C"), 0, "hn-reconciliation", { present: false }),
      raw("impression", ID("A"), 2, "original-page"),
    ], undefined, policy, clock);
    expect(result.events.map((event) => event.clientEventId)).toEqual([ID("A"), ID("B"), ID("C")]);
    expect(result.events.every((event) => event.receivedAt === time(10))).toBe(true);
    expect(result.events[2]).toMatchObject({ id: `evt_${ID("C")}`, occurredAt: time(10), observationQuality: "partial", value: { present: false } });
    expect(result.events[0]?.observationQuality).toBe("partial");
    expect(result.sessions).toEqual([]);
    expect(result.observationQuality).toBe("partial");
  });

  it("should reject future occurrence with its original batch index", () => {
    expect(() => reduce([raw("impression", ID("A")), raw("open", ID("B"), 101)]))
      .toThrowError(expect.objectContaining({ code: "invalid-activity", batchIndex: 1 }));
  });

  it("should collapse exact persisted and in-batch replays while ignoring receipt and sequence", () => {
    const first = reduce([raw("open", ID("A")), raw("dwell", ID("B"), 1, "embedded-reader", { activeMs: 2_000 })]);
    const previous = first.sessions[0]!;
    const stored = first.events.map((event, index) => ({ ...event, receivedAt: time(50 + index), sequence: index + 10 }));
    const retry = reduce([
      raw("open", ID("A")), raw("open", ID("A")),
      raw("dwell", ID("B"), 1, "embedded-reader", { activeMs: 2_000 }),
    ], previous, stored);
    expect(retry.events).toEqual([]);
    expect(retry.sessions).toEqual([]);
  });

  it("should reject changed logical replay content", () => {
    const first = reduce([raw("dwell", ID("A"), 0, "embedded-reader", { activeMs: 2_000 })]);
    const stored = [{ ...first.events[0]!, sequence: 1 }];
    expect(() => reduce([raw("dwell", ID("A"), 0, "embedded-reader", { activeMs: 3_000 })], first.sessions[0], stored))
      .toThrowError(expect.objectContaining({ code: "idempotency-conflict", batchIndex: 0 }));
  });

  it("should reject malformed unrelated and duplicate replay records", () => {
    const event = reduce([raw("open", ID("A"))]).events[0]!;
    expect(() => reduce([raw("open", ID("A"))], undefined, [{ ...event, sequence: 0 }]))
      .toThrowError(expect.objectContaining({ code: "invalid-replay" }));
    expect(() => reduce([raw("open", ID("A"))], undefined, [
      { ...event, sequence: 1 }, { ...event, sequence: 2 },
    ])).toThrowError(expect.objectContaining({ code: "invalid-replay" }));
    expect(() => reduce([raw("open", ID("B"))], undefined, [{ ...event, sequence: 1 }]))
      .toThrowError(expect.objectContaining({ code: "invalid-replay" }));
  });

  it("should make a full retry read no clock and an empty batch do no work", () => {
    const first = reduce([raw("open", ID("A"))]);
    let reads = 0;
    const clock = { now: () => { reads += 1; return new Date(time()); }, monotonicNowMs: () => 0 };
    const replay = reduceActivity([raw("open", ID("A"))], first.sessions[0], policy, clock, [{ ...first.events[0]!, sequence: 1 }]);
    expect(replay).toMatchObject({ events: [], sessions: [] });
    expect(reads).toBe(0);
    expect(reduceActivity([], undefined, policy, clock)).toEqual({ events: [], sessions: [], observationQuality: "full" });
    expect(() => reduceActivity([], first.sessions[0], policy, clock)).toThrowError(expect.objectContaining({ code: "invalid-previous-session" }));
    expect(() => reduceActivity([], undefined, policy, clock, [{ ...first.events[0]!, sequence: 1 }])).toThrowError(expect.objectContaining({ code: "invalid-replay" }));
  });
});

describe("session reduction", () => {
  it("should apply minimum capped and sub-minimum dwell without mutating immutable event values", () => {
    const result = reduce([
      raw("dwell", ID("A"), 0, "embedded-reader", { activeMs: 500 }),
      raw("dwell", ID("B"), 1, "embedded-reader", { activeMs: 1_000 }),
      raw("dwell", ID("C"), 2, "embedded-reader", { activeMs: 120_000 }),
    ]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.activeDwellMs).toBe(61_000);
    expect(result.events.map((event) => event.value?.activeMs)).toEqual([500, 1_000, 120_000]);
  });

  it("should keep the exact maximum gap and abandon across larger gaps", () => {
    const exact = reduce([
      raw("open", ID("A"), 0), raw("dwell", ID("B"), 300, "embedded-reader", { activeMs: 1_000 }),
    ], undefined, [], clockAt(300));
    expect(exact.sessions).toHaveLength(1);
    const split = reduce([
      raw("open", ID("A"), 0),
      raw("dwell", ID("B"), 301, "embedded-reader", { activeMs: 1_000 }),
      raw("open", ID("C"), 602),
    ], undefined, [], clockAt(700));
    expect(split.sessions.map((session) => [session.state, session.startedAt, session.endedAt])).toEqual([
      ["abandoned", time(0), time(0)],
      ["abandoned", time(301), time(301)],
      ["active", time(602), undefined],
    ]);
    expect(split.sessions[0]?.lastClientEventId).toBe(ID("A"));
    expect(split.sessions[0]?.updatedAt).toBe(time(0));
  });

  it("should create zero-length terminal sessions for orphan complete and skip", () => {
    const result = reduce([raw("complete", ID("A")), raw("skip", ID("B"), 1)]);
    expect(result.sessions.map((session) => [session.state, session.startedAt, session.endedAt, session.activeDwellMs])).toEqual([
      ["complete", time(0), time(0), 0],
      ["abandoned", time(1), time(1), 0],
    ]);
  });

  it("should retain maximum scroll sticky partial quality and avoid forcing completion to full scroll", () => {
    const result = reduce([
      raw("open", ID("A")),
      raw("scroll", ID("B"), 1, "original-page", { ratio: 0.7 }),
      raw("scroll", ID("C"), 2, "embedded-reader", { ratio: 0.2 }),
      raw("complete", ID("D"), 3),
    ]);
    expect(result.sessions[0]).toMatchObject({ maxScrollRatio: 0.7, observationQuality: "partial", state: "complete" });
  });

  it("should enforce strict occurrence/client ordering and allow equal-time increasing IDs", () => {
    const first = reduce([raw("open", ID("B"))]);
    expect(() => reduce([raw("open", ID("A"))], first.sessions[0]))
      .toThrowError(expect.objectContaining({ code: "out-of-order-session", batchIndex: 0 }));
    expect(() => reduce([raw("open", ID("B"))], first.sessions[0]))
      .toThrowError(expect.objectContaining({ code: "out-of-order-session" }));
    const next = reduce([raw("open", ID("C"))], first.sessions[0]);
    expect(next.sessions[0]?.lastClientEventId).toBe(ID("C"));
    expect(() => reduce([raw("open", ID("A"), -1)], first.sessions[0]))
      .toThrowError(expect.objectContaining({ code: "out-of-order-session" }));
  });

  it("should reject dwell overflow without mutating the previous session", () => {
    const first = reduce([raw("open", ID("A"))]);
    const previous = { ...first.sessions[0]!, activeDwellMs: Number.MAX_SAFE_INTEGER };
    const snapshot = structuredClone(previous);
    expect(() => reduce([raw("dwell", ID("B"), 1, "embedded-reader", { activeMs: 1_000 })], previous))
      .toThrowError(expect.objectContaining({ code: "session-overflow", batchIndex: 0 }));
    expect(previous).toEqual(snapshot);
  });

  it("should reject invalid policy and previous-session invariants before reduction", () => {
    expect(() => reduceActivity([], undefined, { ...policy, minDwellMs: 61_000 }, clockAt()))
      .toThrowError(expect.objectContaining({ code: "invalid-policy" }));
    const previous = reduce([raw("open", ID("A"))]).sessions[0]!;
    expect(() => reduce([raw("open", ID("B"), 1)], { ...previous, storyId: 2 }))
      .toThrowError(expect.objectContaining({ code: "invalid-previous-session" }));
    expect(() => reduce([raw("open", ID("B"), 1)], { ...previous, lastClientEventId: "bad" }))
      .toThrowError(expect.objectContaining({ code: "invalid-previous-session" }));
  });

  it("should match chunked reduction to an ordered rebuild with a backward current clock", () => {
    const history: RawActivity[] = [
      raw("open", ID("A"), 0),
      raw("dwell", ID("B"), 1, "original-page", { activeMs: 2_000 }),
      raw("open", ID("C"), 302),
      raw("complete", ID("D"), 303),
      raw("skip", ID("E"), 700),
    ];
    const whole = reduceActivity(history, undefined, policy, clockAt(700));
    let previous: ReadingSession | undefined;
    const chunked = new Map<string, ReadingSession>();
    for (let index = 0; index < history.length; index += 1) {
      const result = reduceActivity([history[index]!], previous, policy, clockAt(700));
      for (const session of result.sessions) chunked.set(session.id, session);
      previous = result.sessions.at(-1) ?? previous;
    }
    expect(chunked).toEqual(new Map(whole.sessions.map((session) => [session.id, session])));
    expect(whole.sessions.map((session) => session.state)).toEqual(["abandoned", "complete", "abandoned"]);
  });
});
