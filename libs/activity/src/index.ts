import type { Clock } from "@tmtp/clock";
import {
  IsoDateTimeSchema,
  ReadingSessionSchema,
  StoredActivityEventSchema,
} from "@tmtp/domain";
import type {
  ActivityEvent,
  HnActionKind,
  IsoDateTime,
  ObservationQuality,
  ReadingSession,
  StoredActivityEvent,
  StoryId,
} from "@tmtp/domain";

export interface RawActivityBase {
  clientEventId: string;
  storyId: StoryId;
}
export interface DwellActivityValue { activeMs: number; }
export interface ScrollActivityValue { ratio: number; }
export interface HnActionActivityValue { present: true; }
export interface HnReconciliationActivityValue { present: boolean; }

export type RawActivity =
  | (RawActivityBase & {
    kind: "impression" | "open" | "complete" | "skip";
    occurredAt: IsoDateTime;
    source: "embedded-reader" | "original-page";
    value?: never;
  })
  | (RawActivityBase & {
    kind: "dwell";
    occurredAt: IsoDateTime;
    source: "embedded-reader" | "original-page";
    value: DwellActivityValue;
  })
  | (RawActivityBase & {
    kind: "scroll";
    occurredAt: IsoDateTime;
    source: "embedded-reader" | "original-page";
    value: ScrollActivityValue;
  })
  | (RawActivityBase & {
    kind: "dismiss";
    occurredAt: IsoDateTime;
    source: "app-action";
    value?: never;
  })
  | (RawActivityBase & {
    kind: HnActionKind;
    occurredAt: IsoDateTime;
    source: "app-action";
    value: HnActionActivityValue;
  })
  | (RawActivityBase & {
    kind: HnActionKind;
    occurredAt?: never;
    source: "hn-reconciliation";
    value: HnReconciliationActivityValue;
  });

export interface ActivityPolicy {
  idleTimeoutMs: number;
  minDwellMs: number;
  maxSessionGapMs: number;
}
export interface ActivityReduction {
  events: ActivityEvent[];
  sessions: ReadingSession[];
  observationQuality: ObservationQuality;
}
export type ActivityErrorCode =
  | "invalid-policy"
  | "invalid-activity"
  | "invalid-previous-session"
  | "invalid-replay"
  | "idempotency-conflict"
  | "out-of-order-session"
  | "session-overflow";

const ERROR_MESSAGES: Record<ActivityErrorCode, string> = {
  "invalid-policy": "Activity policy is invalid.",
  "invalid-activity": "Activity observation is invalid.",
  "invalid-previous-session": "Previous reading session is invalid.",
  "invalid-replay": "Persisted activity replay data is invalid.",
  "idempotency-conflict": "Client event identity conflicts with an existing observation.",
  "out-of-order-session": "Reading-session observations are out of order.",
  "session-overflow": "Reading-session dwell exceeds the supported range.",
};

export class ActivityError extends Error {
  override readonly name = "ActivityError" as const;
  readonly batchIndex?: number;
  constructor(readonly code: ActivityErrorCode, batchIndex?: number) {
    super(ERROR_MESSAGES[code]);
    if (batchIndex !== undefined) {
      if (!Number.isSafeInteger(batchIndex) || batchIndex < 0) {
        throw new TypeError("Activity batch index must be a non-negative safe integer.");
      }
      this.batchIndex = batchIndex;
    }
  }
}

const CLIENT_ID = /^[A-Za-z0-9_-]{43}$/;
const READER_KINDS = new Set(["impression", "open", "complete", "skip", "dwell", "scroll"]);
const SESSION_KINDS = new Set(["open", "dwell", "scroll", "complete", "skip"]);
const HN_KINDS = new Set(["upvote", "flag", "favorite"]);
const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validTimestamp = (value: unknown): value is IsoDateTime => IsoDateTimeSchema.safeParse(value).success;
const qualityFor = (source: string): ObservationQuality =>
  source === "original-page" || source === "hn-reconciliation" ? "partial" : "full";

function fail(code: ActivityErrorCode, batchIndex?: number): never {
  throw new ActivityError(code, batchIndex);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key));
}

function validateValue(kind: string, source: string, row: Record<string, unknown>): boolean {
  if (READER_KINDS.has(kind) && kind !== "dwell" && kind !== "scroll" || kind === "dismiss") {
    return !hasOwn(row, "value");
  }
  const value = row.value;
  if (!isObject(value)) return false;
  if (kind === "dwell") {
    return exactKeys(value, ["activeMs"]) && Number.isSafeInteger(value.activeMs) && (value.activeMs as number) >= 0;
  }
  if (kind === "scroll") {
    return exactKeys(value, ["ratio"]) && typeof value.ratio === "number" &&
      Number.isFinite(value.ratio) && value.ratio >= 0 && value.ratio <= 1;
  }
  if (HN_KINDS.has(kind)) {
    return exactKeys(value, ["present"]) && typeof value.present === "boolean" &&
      (source === "hn-reconciliation" || value.present === true);
  }
  return false;
}

function cloneRaw(row: Record<string, unknown>): RawActivity {
  const result: Record<string, unknown> = {
    clientEventId: row.clientEventId,
    storyId: row.storyId,
    kind: row.kind,
    source: row.source,
  };
  if (hasOwn(row, "occurredAt")) result.occurredAt = row.occurredAt;
  if (hasOwn(row, "value")) result.value = isObject(row.value) ? { ...row.value } : row.value;
  return result as unknown as RawActivity;
}

function sameValue(left: RawActivity["value"], right: RawActivity["value"]): boolean {
  if (left === undefined || right === undefined) return left === right;
  if ("activeMs" in left && "activeMs" in right) return left.activeMs === right.activeMs;
  if ("ratio" in left && "ratio" in right) return left.ratio === right.ratio;
  if ("present" in left && "present" in right) return left.present === right.present;
  return false;
}

function sameRaw(left: RawActivity, right: RawActivity): boolean {
  return left.clientEventId === right.clientEventId && left.storyId === right.storyId &&
    left.kind === right.kind && left.source === right.source && left.occurredAt === right.occurredAt &&
    sameValue(left.value, right.value);
}

export function parseActivityBatch(batch: readonly unknown[]): RawActivity[] {
  if (!Array.isArray(batch)) fail("invalid-activity");
  const parsed: RawActivity[] = [];
  const identities = new Map<string, RawActivity>();
  let storyId: number | undefined;
  for (let index = 0; index < batch.length; index += 1) {
    const row: unknown = batch[index];
    if (
      !isObject(row) || !exactKeys(row, ["clientEventId", "storyId", "kind", "occurredAt", "source", "value"]) ||
      typeof row.clientEventId !== "string" || !CLIENT_ID.test(row.clientEventId) ||
      !Number.isSafeInteger(row.storyId) || (row.storyId as number) < 1 ||
      typeof row.kind !== "string" || typeof row.source !== "string"
    ) {
      fail("invalid-activity", index);
    }
    if (storyId === undefined) storyId = row.storyId as number;
    if (row.storyId !== storyId) fail("invalid-activity", index);

    const kind = row.kind;
    const source = row.source;
    const reconciliation = source === "hn-reconciliation";
    const validSourceAndKind =
      (READER_KINDS.has(kind) && (source === "embedded-reader" || source === "original-page")) ||
      (kind === "dismiss" && source === "app-action") ||
      (HN_KINDS.has(kind) && (source === "app-action" || reconciliation));
    const validOccurrence = reconciliation ? !hasOwn(row, "occurredAt") : validTimestamp(row.occurredAt);
    if (!validSourceAndKind || !validOccurrence || !validateValue(kind, source, row)) {
      fail("invalid-activity", index);
    }
    const raw = cloneRaw(row);
    const previous = identities.get(raw.clientEventId);
    if (previous !== undefined) {
      if (!sameRaw(previous, raw)) fail("idempotency-conflict", index);
    } else {
      identities.set(raw.clientEventId, raw);
    }
    parsed.push(raw);
  }
  return parsed;
}

function validatePolicy(policy: ActivityPolicy): void {
  if (
    !isObject(policy) ||
    !Number.isSafeInteger(policy.minDwellMs) || policy.minDwellMs < 0 ||
    !Number.isSafeInteger(policy.idleTimeoutMs) || policy.idleTimeoutMs < 1 ||
    !Number.isSafeInteger(policy.maxSessionGapMs) || policy.maxSessionGapMs < 1 ||
    !(policy.minDwellMs <= policy.idleTimeoutMs && policy.idleTimeoutMs <= policy.maxSessionGapMs)
  ) {
    fail("invalid-policy");
  }
}

function validatePrevious(previous: ReadingSession | undefined): void {
  if (previous === undefined) return;
  if (!ReadingSessionSchema.safeParse(previous).success || !CLIENT_ID.test(previous.lastClientEventId)) {
    fail("invalid-previous-session");
  }
  const started = Date.parse(previous.startedAt);
  const updated = Date.parse(previous.updatedAt);
  const ended = previous.endedAt === undefined ? undefined : Date.parse(previous.endedAt);
  if (
    started > updated ||
    (previous.state === "active" && ended !== undefined) ||
    (previous.state !== "active" && (ended === undefined || started > ended))
  ) {
    fail("invalid-previous-session");
  }
}

function validStoredSemantics(event: StoredActivityEvent): boolean {
  if (
    event.id !== `evt_${event.clientEventId}` || !CLIENT_ID.test(event.clientEventId) ||
    event.observationQuality !== qualityFor(event.source)
  ) return false;
  const row: Record<string, unknown> = { ...event };
  if (event.source === "hn-reconciliation") {
    delete row.occurredAt;
    if (event.occurredAt !== event.receivedAt) return false;
  }
  return validateValue(event.kind, event.source, row) &&
    ((event.source === "embedded-reader" || event.source === "original-page") && READER_KINDS.has(event.kind) ||
      event.kind === "dismiss" && event.source === "app-action" ||
      HN_KINDS.has(event.kind) && (event.source === "app-action" || event.source === "hn-reconciliation"));
}

function sameStoredValue(raw: RawActivity, event: StoredActivityEvent): boolean {
  if (raw.value === undefined) return event.value === undefined;
  if (event.value === undefined) return false;
  if ("activeMs" in raw.value) return event.value.activeMs === raw.value.activeMs;
  if ("ratio" in raw.value) return event.value.ratio === raw.value.ratio;
  return event.value.present === raw.value.present;
}

function isExactReplay(raw: RawActivity, event: StoredActivityEvent): boolean {
  return event.id === `evt_${raw.clientEventId}` && event.storyId === raw.storyId &&
    event.kind === raw.kind && event.source === raw.source && event.valueSchemaVersion === 1 &&
    event.observationQuality === qualityFor(raw.source) && sameStoredValue(raw, event) &&
    (raw.source === "hn-reconciliation" || event.occurredAt === raw.occurredAt);
}

interface NovelEvent {
  event: ActivityEvent;
  batchIndex: number;
}

export function reduceActivity(
  batch: readonly RawActivity[],
  previousSession: ReadingSession | undefined,
  policy: ActivityPolicy,
  clock: Clock,
  existingEvents: readonly StoredActivityEvent[] = [],
): ActivityReduction {
  validatePolicy(policy);
  validatePrevious(previousSession);
  if (!Array.isArray(existingEvents)) fail("invalid-replay");
  const storedByIdentity = new Map<string, StoredActivityEvent>();
  for (const event of existingEvents) {
    if (
      !StoredActivityEventSchema.safeParse(event).success || !validStoredSemantics(event) ||
      storedByIdentity.has(event.clientEventId)
    ) fail("invalid-replay");
    storedByIdentity.set(event.clientEventId, event);
  }

  const parsed = parseActivityBatch(batch);
  if (parsed.length === 0) {
    if (previousSession !== undefined) fail("invalid-previous-session");
    if (existingEvents.length !== 0) fail("invalid-replay");
    return { events: [], sessions: [], observationQuality: "full" };
  }
  const storyId = parsed[0]!.storyId;
  if (previousSession !== undefined && previousSession.storyId !== storyId) fail("invalid-previous-session");
  const inputIds = new Set(parsed.map((row) => row.clientEventId));
  for (const event of existingEvents) {
    if (event.storyId !== storyId || !inputIds.has(event.clientEventId)) fail("invalid-replay");
  }

  const novel: Array<{ raw: RawActivity; batchIndex: number }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < parsed.length; index += 1) {
    const raw = parsed[index]!;
    const stored = storedByIdentity.get(raw.clientEventId);
    if (stored !== undefined) {
      if (!isExactReplay(raw, stored)) fail("idempotency-conflict", index);
      continue;
    }
    if (seen.has(raw.clientEventId)) continue;
    seen.add(raw.clientEventId);
    novel.push({ raw, batchIndex: index });
  }

  const candidates: NovelEvent[] = [];
  if (novel.length > 0) {
    const receivedAt = clock.now().toISOString();
    const receivedMs = Date.parse(receivedAt);
    for (const { raw, batchIndex } of novel) {
      if (raw.source !== "hn-reconciliation" && Date.parse(raw.occurredAt) > receivedMs) {
        fail("invalid-activity", batchIndex);
      }
      const occurredAt = raw.source === "hn-reconciliation" ? receivedAt : raw.occurredAt;
      const event: ActivityEvent = {
        id: `evt_${raw.clientEventId}`,
        clientEventId: raw.clientEventId,
        storyId: raw.storyId,
        kind: raw.kind,
        ...(raw.value === undefined ? {} : { value: { ...raw.value } }),
        valueSchemaVersion: 1,
        source: raw.source,
        observationQuality: qualityFor(raw.source),
        occurredAt,
        receivedAt,
      };
      candidates.push({ event, batchIndex });
    }
  }
  candidates.sort((left, right) =>
    Date.parse(left.event.occurredAt) - Date.parse(right.event.occurredAt) ||
    (left.event.clientEventId < right.event.clientEventId ? -1 : left.event.clientEventId > right.event.clientEventId ? 1 : 0)
  );

  const sessions: ReadingSession[] = [];
  let working = previousSession?.state === "active" ? { ...previousSession } : undefined;
  let workingTouched = false;
  let lastPosition = previousSession === undefined ? undefined : {
    occurredMs: Date.parse(previousSession.updatedAt),
    clientEventId: previousSession.lastClientEventId,
  };

  for (const { event, batchIndex } of candidates) {
    if (!SESSION_KINDS.has(event.kind)) continue;
    const occurredMs = Date.parse(event.occurredAt);
    if (lastPosition !== undefined) {
      const after = occurredMs > lastPosition.occurredMs ||
        occurredMs === lastPosition.occurredMs && event.clientEventId > lastPosition.clientEventId;
      if (!after) fail("out-of-order-session", batchIndex);
    }
    lastPosition = { occurredMs, clientEventId: event.clientEventId };

    if (working !== undefined && occurredMs - Date.parse(working.updatedAt) > policy.maxSessionGapMs) {
      sessions.push({ ...working, state: "abandoned", endedAt: working.updatedAt });
      working = undefined;
      workingTouched = false;
    }
    if (working === undefined) {
      working = {
        id: `ses_${event.clientEventId}`,
        storyId: event.storyId,
        startedAt: event.occurredAt,
        updatedAt: event.occurredAt,
        activeDwellMs: 0,
        maxScrollRatio: 0,
        state: "active",
        observationQuality: event.observationQuality,
        lastClientEventId: event.clientEventId,
      };
    }
    workingTouched = true;

    if (event.kind === "dwell") {
      const activeMs = event.value!.activeMs as number;
      const contribution = activeMs >= policy.minDwellMs ? Math.min(activeMs, policy.idleTimeoutMs) : 0;
      if (working.activeDwellMs + contribution > Number.MAX_SAFE_INTEGER) fail("session-overflow", batchIndex);
      working.activeDwellMs += contribution;
    } else if (event.kind === "scroll") {
      working.maxScrollRatio = Math.max(working.maxScrollRatio, event.value!.ratio as number);
    }
    working.updatedAt = event.occurredAt;
    working.lastClientEventId = event.clientEventId;
    if (event.observationQuality === "partial") working.observationQuality = "partial";
    if (event.kind === "complete" || event.kind === "skip") {
      working.state = event.kind === "complete" ? "complete" : "abandoned";
      working.endedAt = event.occurredAt;
      sessions.push({ ...working });
      working = undefined;
      workingTouched = false;
    }
  }
  if (working !== undefined && workingTouched) sessions.push({ ...working });

  return {
    events: candidates.map(({ event }) => ({ ...event, ...(event.value === undefined ? {} : { value: { ...event.value } }) })),
    sessions,
    observationQuality: parsed.some((row) => qualityFor(row.source) === "partial") ? "partial" : "full",
  };
}
