import { randomBytes } from "node:crypto";
import { IsoDateTimeSchema } from "@tmtp/domain";
import type { HnActionIntent, HnAccountState, IsoDateTime } from "@tmtp/domain";
import type { AccountCapability, AccountObservation, AccountObservationPage } from "@tmtp/hn-account";
import { ACCOUNT_CURSORS, cursorSnapshot, decodeAccount, encodeAccount } from "./checkpoints.js";
import type { AccountCheckpoint, AccountKind } from "./checkpoints.js";
import { HnIngestionError } from "./errors.js";
import { handoff } from "./jobs.js";
import type { NormalizedOptions } from "./options.js";
import { completeRun } from "./runs.js";
import type { RunContext } from "./runs.js";
import { check } from "./time.js";
import type { AccountReconciliationSummary } from "./types.js";

const SOURCES = [
  { kind: "upvote", capability: "upvoted", method: "readUpvoted" },
  { kind: "favorite", capability: "favorites", method: "readFavorites" },
  { kind: "flag", capability: "flagged", method: "readFlagged" },
] as const;
export interface AccountPlan {
  username: string; capabilities: AccountCapability[]; checkpoints: Record<AccountKind, AccountCheckpoint>;
  raw: Record<string, string | null>; cursorStart: string;
}
export interface AccountPage { kind: AccountKind; cursor?: string; nextCursor?: string; observations: AccountObservation[]; }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function validTimestamp(value: unknown): value is IsoDateTime {
  try { return IsoDateTimeSchema.safeParse(value).success; } catch { return false; }
}
function validateCapabilities(value: AccountCapability[]): AccountCapability[] {
  if (!Array.isArray(value) || value.length !== 4) throw new TypeError("Invalid account capabilities.");
  const names = new Set<string>();
  for (const capability of value) {
    if (!object(capability) || !exact(capability, ["name", "state", "reason"], ["name", "state"]) ||
      !["upvoted", "favorites", "flagged", "mutations"].includes(capability.name as string) ||
      !["available", "unavailable", "unverified"].includes(capability.state as string) ||
      (capability.reason !== undefined && typeof capability.reason !== "string") || names.has(capability.name as string)) throw new TypeError("Invalid account capabilities.");
    names.add(capability.name as string);
  }
  return structuredClone(value);
}
function validatePage(value: AccountObservationPage, kind: AccountKind): AccountObservationPage {
  if (!object(value) || !exact(value, ["observations", "nextCursor"], ["observations"]) || !Array.isArray(value.observations) ||
    (value.nextCursor !== undefined && (typeof value.nextCursor !== "string" || value.nextCursor === ""))) throw new TypeError("Invalid account observation page.");
  const ids = new Set<number>();
  for (const observation of value.observations) {
    if (!object(observation) || !exact(observation, ["storyId", "kind", "present", "observedAt"], ["storyId", "kind", "present", "observedAt"]) ||
      !positive(observation.storyId) || observation.kind !== kind || typeof observation.present !== "boolean" || !validTimestamp(observation.observedAt) || ids.has(observation.storyId)) {
      throw new TypeError("Invalid account observation.");
    }
    ids.add(observation.storyId);
  }
  return structuredClone(value);
}
export async function planAccount(options: NormalizedOptions, signal: AbortSignal | undefined, start: (cursorStart: string) => void): Promise<AccountPlan> {
  const account = options.account!;
  const raw: Record<string, string | null> = {
    [ACCOUNT_CURSORS.upvote]: options.store.sync.cursor(ACCOUNT_CURSORS.upvote) ?? null,
    [ACCOUNT_CURSORS.favorite]: options.store.sync.cursor(ACCOUNT_CURSORS.favorite) ?? null,
    [ACCOUNT_CURSORS.flag]: options.store.sync.cursor(ACCOUNT_CURSORS.flag) ?? null,
  };
  if (signal?.aborted) throw signal.reason;
  start(cursorSnapshot(raw));
  if (signal?.aborted) throw signal.reason;
  const identity = await account.validateSession(signal);
  if (!object(identity) || !exact(identity, ["username"], ["username"]) || typeof identity.username !== "string" || identity.username === "") throw new TypeError("Invalid account identity.");
  const username = identity.username;
  if (signal?.aborted) throw signal.reason;
  const capabilities = validateCapabilities(await account.capabilities(signal));
  const checkpoints = {
    upvote: decodeAccount(raw[ACCOUNT_CURSORS.upvote] ?? undefined, username),
    favorite: decodeAccount(raw[ACCOUNT_CURSORS.favorite] ?? undefined, username),
    flag: decodeAccount(raw[ACCOUNT_CURSORS.flag] ?? undefined, username),
  };
  return { username, capabilities, checkpoints, raw, cursorStart: cursorSnapshot(raw) };
}
export async function readAccountPages(options: NormalizedOptions, plan: AccountPlan, signal: AbortSignal | undefined): Promise<AccountPage[]> {
  const account = options.account!;
  const pages: AccountPage[] = [];
  for (const source of SOURCES) {
    if (plan.capabilities.find((capability) => capability.name === source.capability)?.state !== "available") continue;
    check(signal);
    const cursor = plan.checkpoints[source.kind].continuation;
    const page = validatePage(await account[source.method](cursor, signal), source.kind);
    pages.push({ kind: source.kind, observations: page.observations, ...(cursor === undefined ? {} : { cursor }),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
  }
  check(signal);
  return pages;
}
function verifiedIntent(intent: HnActionIntent, observedAt: IsoDateTime): HnActionIntent {
  return { id: intent.id, storyId: intent.storyId, action: intent.action, idempotencyKey: intent.idempotencyKey,
    status: "verified", result: { source: "hn-reconciliation", observedAt }, resultSchemaVersion: 1,
    createdAt: intent.createdAt, updatedAt: observedAt };
}
export function commitAccount(options: NormalizedOptions, context: RunContext, plan: AccountPlan, pages: readonly AccountPage[], completedAt: IsoDateTime): AccountReconciliationSummary {
  return options.store.transaction(() => {
    const states: HnAccountState[] = [];
    const novel: AccountObservation[] = [];
    const known: AccountObservation[] = [];
    let skippedUnknownStories = 0;
    const endRaw = { ...plan.raw };
    for (const page of pages) {
      const knownPage = page.observations.filter((observation) => {
        const exists = options.store.stories.byId(observation.storyId) !== undefined;
        if (!exists) skippedUnknownStories += 1;
        return exists;
      });
      const existingRows = options.store.hnAccountStates.byStoryIds(plan.username, page.kind, knownPage.map((observation) => observation.storyId));
      const existing = new Map(existingRows.map((state) => [state.storyId, state]));
      for (const observation of knownPage) {
        const previous = existing.get(observation.storyId);
        states.push({ username: plan.username, storyId: observation.storyId, kind: observation.kind, present: observation.present,
          firstObservedAt: previous?.firstObservedAt ?? observation.observedAt,
          lastObservedAt: previous !== undefined && previous.lastObservedAt > observation.observedAt ? previous.lastObservedAt : observation.observedAt,
          ...(page.cursor === undefined ? {} : { sourceCursor: page.cursor }) });
        if (previous === undefined || previous.present !== observation.present) novel.push(observation);
        known.push(observation);
      }
      const checkpoint: AccountCheckpoint = { schemaVersion: 1, username: plan.username, ...(page.nextCursor === undefined ? {} : { continuation: page.nextCursor }) };
      endRaw[ACCOUNT_CURSORS[page.kind]] = encodeAccount(checkpoint);
    }
    if (states.length > 0) options.store.hnAccountStates.upsertObservations(states);
    let remaining = options.refreshBatchSize;
    for (const observation of known) {
      if (!observation.present || remaining === 0) continue;
      let afterId: string | undefined;
      while (remaining > 0) {
        const limit = remaining;
        const candidates = options.store.hnActions.pendingOrIndeterminate({ status: "indeterminate", storyId: observation.storyId,
          action: observation.kind, limit, ...(afterId === undefined ? {} : { afterId }) });
        for (const intent of candidates) if (intent.status === "indeterminate") options.store.hnActions.updateOutcome(verifiedIntent(intent, observation.observedAt));
        remaining -= candidates.length;
        if (candidates.length < limit || remaining === 0) break;
        afterId = candidates.at(-1)!.id;
      }
    }
    let activityJobsEnqueued = 0;
    for (const observation of novel) {
      const clientEventId = randomBytes(32).toString("base64url");
      const result = handoff(options.jobs, { kind: "personalization.record-activity", payloadSchemaVersion: 1,
        payload: { batch: [{ clientEventId, storyId: observation.storyId, kind: observation.kind, source: "hn-reconciliation", value: { present: observation.present } }] },
        dedupeKey: clientEventId, runAfter: completedAt }, context.operation, context.id);
      if (!result.inserted) throw new HnIngestionError("job-handoff-failure", { operation: context.operation, retryable: false, runId: context.id, dependency: "job-queue" });
      activityJobsEnqueued += 1;
    }
    for (const kind of Object.keys(ACCOUNT_CURSORS) as AccountKind[]) {
      const name = ACCOUNT_CURSORS[kind];
      const value = endRaw[name];
      if (value !== null && value !== undefined && value !== plan.raw[name]) options.store.sync.setCursor(name, value, completedAt);
    }
    const cursorEnd = cursorSnapshot(endRaw);
    options.store.sync.finishRun(completeRun(context, cursorEnd, completedAt, 0, 0));
    return { runId: context.id, observations: states.length, skippedUnknownStories, activityJobsEnqueued,
      capabilities: plan.capabilities.map((capability) => ({ ...capability })) };
  });
}
