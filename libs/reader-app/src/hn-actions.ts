import { createHash } from "node:crypto";
import type { RawActivity } from "@tmtp/activity";
import { HnActionIntentSchema } from "@tmtp/domain";
import type { HnActionIntent, HnActionStatus } from "@tmtp/domain";
import type { HnActionResult } from "@tmtp/hn-account";
import { appError, translateError } from "./errors.js";
import type { HnActionCommand, NormalizedReaderAppOptions } from "./types.js";
import { checkpoint, exactKeys, newIntentId, plainObject, requireStory, timestamp, validIso } from "./validation.js";

const ACCOUNT_ERROR_CODES = new Set([
  "invalid-input", "invalid-cursor", "capability-disabled", "capability-unverified", "session-expired",
  "username-mismatch", "invalid-request", "origin-policy", "redirect-limit", "invalid-redirect", "http-status",
  "response-too-large", "timeout", "transport", "parse-failed", "action-unavailable", "action-conflict",
  "post-outcome-unknown", "verification-unavailable", "cancelled-after-dispatch", "client-closed",
]);

interface Flight {
  readonly storyId: number;
  readonly action: HnActionCommand["action"];
  readonly leaderSignal: AbortSignal | undefined;
  promise: Promise<HnActionResult>;
  outcomePersisted: boolean;
}

function invalidEvidence(storyId: number): never {
  throw appError("dependency-failure", "perform-hn-action", {
    retryable: false,
    dependency: "reader-store",
    dependencyCode: "invalid-result",
    storyId,
  });
}
function invalidAdapterResult(storyId: number): never {
  throw appError("dependency-failure", "perform-hn-action", {
    retryable: false,
    dependency: "hn-account",
    dependencyCode: "invalid-result",
    storyId,
  });
}

function validateAdapterResult(value: unknown, intent: HnActionIntent, adapter: boolean): HnActionResult {
  const invalid = (): never => adapter ? invalidAdapterResult(intent.storyId) : invalidEvidence(intent.storyId);
  if (!plainObject(value)) invalid();
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["intentId", "status", "observedAt"], ["errorCode"])) invalid();
  if (record.intentId !== intent.id || record.status !== "verified" && record.status !== "failed" && record.status !== "indeterminate" ||
    !validIso(record.observedAt)) invalid();
  if (record.errorCode !== undefined && (typeof record.errorCode !== "string" || !ACCOUNT_ERROR_CODES.has(record.errorCode))) invalid();
  if (record.status === "verified" ? record.errorCode !== undefined : record.errorCode === undefined) invalid();
  return {
    intentId: intent.id,
    status: record.status as HnActionResult["status"],
    observedAt: record.observedAt as string,
    ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode as NonNullable<HnActionResult["errorCode"]> }),
  };
}

function replayResult(intent: HnActionIntent): HnActionResult {
  if (!HnActionIntentSchema.safeParse(intent).success || intent.resultSchemaVersion !== 1 || intent.result === undefined) invalidEvidence(intent.storyId);
  const evidence = intent.result;
  if (intent.status === "verified" && plainObject(evidence) && exactKeys(evidence, ["source", "observedAt"]) &&
    evidence.source === "hn-reconciliation" && validIso(evidence.observedAt)) {
    return { intentId: intent.id, status: "verified", observedAt: evidence.observedAt };
  }
  if (intent.status !== "verified" && intent.status !== "failed") invalidEvidence(intent.storyId);
  const result = validateAdapterResult(evidence, intent, false);
  if (result.status !== intent.status || intent.errorCode !== result.errorCode) invalidEvidence(intent.storyId);
  return result;
}

function clientEventId(intentId: string): string {
  return createHash("sha256").update(`tmtp/hn-action-activity/1\0${intentId}`, "utf8").digest("base64url");
}

function ensureVerifiedActivity(options: NormalizedReaderAppOptions, intent: HnActionIntent, outcome: HnActionResult): void {
  if (outcome.status !== "verified") return;
  const id = clientEventId(intent.id);
  const existing = options.store.activity.query({ clientEventId: id, limit: 1 });
  if (existing.length > 0) return;
  const activity: RawActivity = {
    clientEventId: id,
    storyId: intent.storyId,
    kind: intent.action,
    source: "app-action",
    value: { present: true },
    occurredAt: outcome.observedAt,
  };
  try {
    options.jobs.enqueue({
      kind: "personalization.record-activity",
      payloadSchemaVersion: 1,
      payload: { batch: [activity] },
      dedupeKey: id,
      runAfter: outcome.observedAt,
    });
  } catch (error) {
    throw translateError(error, "perform-hn-action", "job-queue", { storyId: intent.storyId });
  }
}

function outcomeIntent(
  options: NormalizedReaderAppOptions,
  current: HnActionIntent,
  outcome: HnActionResult,
): HnActionIntent {
  const status: HnActionStatus = current.status === "indeterminate" && outcome.status === "failed" ? "indeterminate" : outcome.status;
  const result: HnActionResult = {
    intentId: current.id,
    status: status as HnActionResult["status"],
    observedAt: outcome.observedAt,
    ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
  };
  return {
    id: current.id,
    storyId: current.storyId,
    action: current.action,
    idempotencyKey: current.idempotencyKey,
    status,
    result: { ...result },
    resultSchemaVersion: 1,
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    createdAt: current.createdAt,
    updatedAt: timestamp(options.now, "perform-hn-action", current.updatedAt),
  };
}

async function coordinate(
  options: NormalizedReaderAppOptions,
  command: HnActionCommand,
  signal: AbortSignal | undefined,
  flight: Flight,
): Promise<HnActionResult> {
  checkpoint(signal);
  const stored = options.store.transaction((): HnActionIntent => {
    requireStory(options.store, command.storyId, "perform-hn-action");
    const existing = options.store.hnActions.byIdempotencyKey(command.idempotencyKey);
    if (existing !== undefined && (existing.storyId !== command.storyId || existing.action !== command.action)) {
      throw appError("conflict", "perform-hn-action", { storyId: command.storyId, retryable: false });
    }
    if (existing === undefined) {
      if (options.account === undefined) throw appError("account-not-configured", "perform-hn-action", { storyId: command.storyId, retryable: false });
      const at = timestamp(options.now, "perform-hn-action");
      const intent: HnActionIntent = {
        id: newIntentId(options.createId),
        storyId: command.storyId,
        action: command.action,
        idempotencyKey: command.idempotencyKey,
        status: "pending",
        createdAt: at,
        updatedAt: at,
      };
      options.store.hnActions.createIntent(intent);
      return intent;
    }
    if ((existing.status === "pending" || existing.status === "indeterminate") && options.account === undefined) {
      throw appError("account-not-configured", "perform-hn-action", { storyId: command.storyId, retryable: false });
    }
    return existing;
  });
  checkpoint(signal);

  if (stored.status === "verified" || stored.status === "failed") {
    const replay = replayResult(stored);
    if (stored.status === "verified") {
      options.store.transaction(() => {
        const current = options.store.hnActions.byId(stored.id);
        if (current === undefined || current.status !== "verified") invalidEvidence(stored.storyId);
        const currentResult = replayResult(current);
        ensureVerifiedActivity(options, current, currentResult);
      });
    }
    flight.outcomePersisted = true;
    return replay;
  }

  const account = options.account;
  if (account === undefined) throw appError("account-not-configured", "perform-hn-action", { storyId: command.storyId, retryable: false });
  const returned = validateAdapterResult(await account.performAction(stored, signal), stored, true);
  const persisted = options.store.transaction((): HnActionResult => {
    const current = options.store.hnActions.byId(stored.id);
    if (current === undefined) invalidEvidence(stored.storyId);
    if (current.status === "verified" || current.status === "failed") {
      const replay = replayResult(current);
      if (current.status === "verified") ensureVerifiedActivity(options, current, replay);
      return replay;
    }
    if (current.status !== "pending" && current.status !== "indeterminate") invalidEvidence(current.storyId);
    const next = outcomeIntent(options, current, returned);
    options.store.hnActions.updateOutcome(next);
    const result = validateAdapterResult(next.result, next, false);
    if (result.status !== next.status || next.errorCode !== result.errorCode) invalidEvidence(next.storyId);
    ensureVerifiedActivity(options, next, result);
    return result;
  });
  flight.outcomePersisted = true;
  return persisted;
}

async function execute(
  options: NormalizedReaderAppOptions,
  command: HnActionCommand,
  signal: AbortSignal | undefined,
  flight: Flight,
): Promise<HnActionResult> {
  try {
    return await coordinate(options, command, signal, flight);
  } catch (error) {
    if (signal?.aborted && error === signal.reason) throw error;
    throw translateError(error, "perform-hn-action", "reader-store", { storyId: command.storyId });
  }
}

function waitForCaller(flight: Flight, signal: AbortSignal | undefined, leader: boolean): Promise<HnActionResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => { if (signal !== undefined) signal.removeEventListener("abort", onAbort); };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal!.reason);
    };
    if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    flight.promise.then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!leader && flight.leaderSignal?.aborted && !flight.outcomePersisted) {
          reject(appError("cancelled", "perform-hn-action", { retryable: true, storyId: flight.storyId }));
        } else {
          reject(error);
        }
      },
    );
  });
}

export function createHnActionCoordinator(options: NormalizedReaderAppOptions) {
  const flights = new Map<string, Flight>();
  return async function perform(command: HnActionCommand, signal: AbortSignal | undefined): Promise<HnActionResult> {
    checkpoint(signal);
    const existing = flights.get(command.idempotencyKey);
    if (existing !== undefined) {
      if (existing.storyId !== command.storyId || existing.action !== command.action) {
        throw appError("conflict", "perform-hn-action", { storyId: command.storyId, retryable: false });
      }
      return waitForCaller(existing, signal, false);
    }
    let flight: Flight;
    const shared = Promise.resolve().then(() => execute(options, command, signal, flight));
    const tracked = shared.finally(() => {
      if (flights.get(command.idempotencyKey) === flight) flights.delete(command.idempotencyKey);
    });
    flight = {
      storyId: command.storyId,
      action: command.action,
      leaderSignal: signal,
      outcomePersisted: false,
      promise: tracked,
    };
    flights.set(command.idempotencyKey, flight);
    return waitForCaller(flight, signal, true);
  };
}
