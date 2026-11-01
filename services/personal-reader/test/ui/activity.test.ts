import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityBatcher } from "../../src/ui/activity.js";
import type { RawActivity } from "../../src/ui/types.js";
import { isClientEventId } from "../../src/ui/utils.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ActivityBatcher", () => {
  it("should retry identical one-story events after a failed batch", async () => {
    const calls: RawActivity[][] = [];
    let fail = true;
    const batcher = new ActivityBatcher(async (batch) => {
      calls.push(batch);
      if (fail) throw new Error("offline");
    });
    batcher.enqueue({ storyId: 1, kind: "open", source: "embedded-reader" });
    batcher.enqueue({ storyId: 1, kind: "scroll", source: "embedded-reader", value: { ratio: 0.5 } });

    await expect(batcher.flush(1)).rejects.toThrow("offline");
    fail = false;
    await batcher.flush(1);

    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]?.[0]?.clientEventId).toBe(calls[1]?.[0]?.clientEventId);
    expect(calls.every((batch) => new Set(batch.map((event) => event.storyId)).size === 1)).toBe(true);
    expect(calls.flat().every((event) => isClientEventId(event.clientEventId))).toBe(true);
    expect(batcher.pendingCount).toBe(0);
  });

  it("should coalesce concurrent flushes without sending duplicates", async () => {
    let release: (() => void) | undefined;
    const send = vi.fn(async () => new Promise<void>((resolve) => { release = resolve; }));
    const batcher = new ActivityBatcher(send);
    batcher.enqueue({ storyId: 7, kind: "open", source: "embedded-reader" });

    const first = batcher.flush(7);
    const second = batcher.flush(7);
    expect(send).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.all([first, second]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("should send ordered single-event requests when the server batch size is one", async () => {
    const calls: RawActivity[][] = [];
    const batcher = new ActivityBatcher(async (batch) => { calls.push(batch); });
    for (let index = 0; index < 3; index += 1) {
      batcher.enqueue({ storyId: 9, kind: "scroll", source: "embedded-reader", value: { ratio: index / 105 } });
    }
    await batcher.flush(9);
    expect(calls.map((batch) => batch.length)).toEqual([1, 1, 1]);
    expect(calls.flat().map((event) => event.occurredAt)).toEqual([...calls.flat().map((event) => event.occurredAt)].sort());
  });

  it("should request a flush immediately after enqueue", async () => {
    const send = vi.fn(async () => undefined);
    const batcher = new ActivityBatcher(send);

    const event = batcher.enqueue({ storyId: 4, kind: "impression", source: "embedded-reader" });

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith([event], false));
    await batcher.flush(4);
    expect(batcher.pendingCount).toBe(0);
  });

  it("should serialize two clients through the same per-story Web Lock in request order", async () => {
    let tail = Promise.resolve();
    const request = vi.fn(<T,>(_name: string, callback: () => Promise<T>): Promise<T> => {
      const result = tail.then(callback);
      tail = result.then(() => undefined, () => undefined);
      return result;
    });
    vi.stubGlobal("navigator", { locks: { request } });
    let release = (): void => { throw new Error("Lock was not held"); };
    const held = request("tmtp.activity.42", () => new Promise<void>((resolve) => { release = resolve; }));
    const sent: string[] = [];
    const first = new ActivityBatcher(async ([event]) => { sent.push(`first:${event?.clientEventId}`); });
    const second = new ActivityBatcher(async ([event]) => { sent.push(`second:${event?.clientEventId}`); });

    const earlier = first.enqueue({ storyId: 42, kind: "open", source: "embedded-reader" });
    const later = second.enqueue({ storyId: 42, kind: "open", source: "embedded-reader" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(sent).toEqual([]);

    release();
    await Promise.all([held, first.flush(42), second.flush(42)]);

    expect(sent).toEqual([`first:${earlier.clientEventId}`, `second:${later.clientEventId}`]);
    expect(request.mock.calls.slice(1).every(([name]) => name === "tmtp.activity.42")).toBe(true);
  });

  it("should flush without Web Locks when they are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const send = vi.fn(async () => undefined);
    const batcher = new ActivityBatcher(send);

    batcher.enqueue({ storyId: 5, kind: "open", source: "embedded-reader" });
    await batcher.flush(5);

    expect(send).toHaveBeenCalledTimes(1);
    expect(batcher.pendingCount).toBe(0);
  });
});
