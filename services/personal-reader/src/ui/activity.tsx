import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { api } from "./api.js";
import type { RawActivity } from "./types.js";
import { clampRatio, createClientEventId } from "./utils.js";

export type ActivityDraft = RawActivity extends infer Event
  ? Event extends RawActivity ? Omit<Event, "clientEventId" | "occurredAt"> : never
  : never;

type SendActivity = (batch: RawActivity[], keepalive?: boolean) => Promise<unknown>;

async function withStoryLock<T>(storyId: number, send: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || navigator.locks === undefined) return send();
  return navigator.locks.request(`tmtp.activity.${storyId}`, send);
}

export class ActivityBatcher {
  private readonly pending = new Map<number, RawActivity[]>();
  private readonly inFlight = new Map<number, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private lastTimestamp = 0;
  private lastError: string | undefined;

  constructor(private readonly send: SendActivity = api.recordActivity) {}

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private occurredAt(): string {
    const now = Date.now();
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 1);
    return new Date(this.lastTimestamp).toISOString();
  }

  get pendingCount(): number {
    let count = 0;
    for (const events of this.pending.values()) count += events.length;
    return count;
  }

  get error(): string | undefined { return this.lastError; }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  enqueue(draft: ActivityDraft): RawActivity {
    const event = {
      ...draft,
      clientEventId: createClientEventId(),
      occurredAt: this.occurredAt(),
    } as RawActivity;
    const events = this.pending.get(event.storyId) ?? [];
    events.push(event);
    this.pending.set(event.storyId, events);
    this.notify();
    queueMicrotask(() => { void this.flush(event.storyId).catch(() => undefined); });
    return event;
  }

  async flush(storyId: number, keepalive = false): Promise<void> {
    const existing = this.inFlight.get(storyId);
    if (existing !== undefined) return existing;
    const task = (async (): Promise<void> => {
      while ((this.pending.get(storyId)?.length ?? 0) > 0) {
        const queued = this.pending.get(storyId) ?? [];
        const batch = queued.slice(0, 1);
        this.pending.set(storyId, queued.slice(1));
        this.notify();
        try {
          await withStoryLock(storyId, () => this.send(batch, keepalive));
          this.lastError = undefined;
        } catch (error) {
          const remaining = this.pending.get(storyId) ?? [];
          this.pending.set(storyId, [...batch, ...remaining]);
          this.lastError = error instanceof Error ? error.message : "Activity could not be saved.";
          throw error;
        }
      }
      this.pending.delete(storyId);
    })().finally(() => {
      this.inFlight.delete(storyId);
      this.notify();
    });
    this.inFlight.set(storyId, task);
    return task;
  }

  async flushAll(keepalive = false): Promise<void> {
    const storyIds = new Set([...this.pending.keys(), ...this.inFlight.keys()]);
    const results = await Promise.allSettled([...storyIds].map((storyId) => this.flush(storyId, keepalive)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

interface ActivityContextValue {
  enqueue: (draft: ActivityDraft) => RawActivity;
  flush: (storyId: number, keepalive?: boolean) => Promise<void>;
  flushAll: (keepalive?: boolean) => Promise<void>;
  externalOpen: (storyId: number) => void;
  complete: (storyId: number) => Promise<void>;
  skip: (storyId: number) => Promise<void>;
  pendingCount: number;
  error?: string;
}

const ActivityContext = createContext<ActivityContextValue | undefined>(undefined);

export function ActivityProvider({ children }: { children: ReactNode }) {
  const [batcher] = useState(() => new ActivityBatcher());
  const [, setRevision] = useState(0);

  useEffect(() => batcher.subscribe(() => setRevision((value) => value + 1)), [batcher]);

  useEffect(() => {
    const retry = (): void => { void batcher.flushAll().catch(() => undefined); };
    const pageHide = (): void => { void batcher.flushAll(true).catch(() => undefined); };
    const visibility = (): void => { if (document.visibilityState === "hidden") pageHide(); };
    const timer = window.setInterval(retry, 5_000);
    window.addEventListener("online", retry);
    window.addEventListener("pagehide", pageHide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", retry);
      window.removeEventListener("pagehide", pageHide);
      document.removeEventListener("visibilitychange", visibility);
      pageHide();
    };
  }, [batcher]);

  const enqueue = useCallback((draft: ActivityDraft) => batcher.enqueue(draft), [batcher]);
  const flush = useCallback((storyId: number, keepalive?: boolean) => batcher.flush(storyId, keepalive), [batcher]);
  const flushAll = useCallback((keepalive?: boolean) => batcher.flushAll(keepalive), [batcher]);
  const externalOpen = useCallback((storyId: number): void => {
      batcher.enqueue({ storyId, kind: "open", source: "original-page" });
      void batcher.flush(storyId, true).catch(() => undefined);
  }, [batcher]);
  const complete = useCallback(async (storyId: number): Promise<void> => {
      batcher.enqueue({ storyId, kind: "complete", source: "embedded-reader" });
      await batcher.flush(storyId);
  }, [batcher]);
  const skip = useCallback(async (storyId: number): Promise<void> => {
      batcher.enqueue({ storyId, kind: "skip", source: "embedded-reader" });
      await batcher.flush(storyId);
  }, [batcher]);

  const value = useMemo<ActivityContextValue>(() => ({
    enqueue,
    flush,
    flushAll,
    externalOpen,
    complete,
    skip,
    pendingCount: batcher.pendingCount,
    ...(batcher.error === undefined ? {} : { error: batcher.error }),
  }), [batcher, enqueue, flush, flushAll, externalOpen, complete, skip, batcher.pendingCount, batcher.error]);

  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>;
}

export function useActivity(): ActivityContextValue {
  const value = useContext(ActivityContext);
  if (value === undefined) throw new Error("useActivity must be used inside ActivityProvider.");
  return value;
}

export function useReaderActivity(storyId: number, articleRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  const { enqueue, flush } = useActivity();
  const opened = useRef(new Set<number>());
  const maximumRatios = useRef(new Map<number, number>());

  useEffect(() => {
    if (!enabled || opened.current.has(storyId)) return;
    opened.current.add(storyId);
    enqueue({ storyId, kind: "open", source: "embedded-reader" });
    void flush(storyId).catch(() => undefined);
  }, [enqueue, flush, enabled, storyId]);

  useEffect(() => {
    if (!enabled) return;
    let previousTick = Date.now();
    let wasActive = document.visibilityState === "visible" && document.hasFocus();
    const tick = (): void => {
      const now = Date.now();
      const elapsed = now - previousTick;
      if (wasActive && elapsed >= 1_000) {
        enqueue({
          storyId,
          kind: "dwell",
          source: "embedded-reader",
          value: { activeMs: Math.min(elapsed, 60_000) },
        });
        void flush(storyId).catch(() => undefined);
      }
      previousTick = now;
      wasActive = document.visibilityState === "visible" && document.hasFocus();
    };
    const timer = window.setInterval(tick, 10_000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    window.addEventListener("blur", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
      window.removeEventListener("blur", tick);
      tick();
      void flush(storyId).catch(() => undefined);
    };
  }, [enqueue, flush, enabled, storyId]);

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const element = articleRef.current;
      if (element === null) return;
      const top = element.getBoundingClientRect().top + window.scrollY;
      const denominator = Math.max(1, element.offsetHeight - window.innerHeight);
      const ratio = element.offsetHeight <= window.innerHeight
        ? 1
        : clampRatio((window.scrollY - top) / denominator);
      const previous = maximumRatios.current.get(storyId) ?? 0;
      if (ratio >= previous + 0.05 || (ratio === 1 && previous < 1)) {
        maximumRatios.current.set(storyId, ratio);
        enqueue({ storyId, kind: "scroll", source: "embedded-reader", value: { ratio } });
      }
    };
    const requestMeasure = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    frame = window.requestAnimationFrame(measure);
    window.addEventListener("scroll", requestMeasure, { passive: true });
    window.addEventListener("resize", requestMeasure);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", requestMeasure);
      window.removeEventListener("resize", requestMeasure);
    };
  }, [enqueue, articleRef, enabled, storyId]);
}
