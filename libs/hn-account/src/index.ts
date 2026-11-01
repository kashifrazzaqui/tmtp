import { HnActionIntentSchema } from "@tmtp/domain";
import type { HnActionIntent } from "@tmtp/domain";
import { HnAccountError, failure } from "./errors.js";
import { assertIdentity, currentState, discoverForm, parseHtml, parseList } from "./html.js";
import type { PageKind } from "./html.js";
import { validateOptions } from "./options.js";
import { createTransport } from "./transport.js";
import type { AccountCapability, AccountObservationPage, HnAccount, HnAccountOptions, HnActionResult } from "./types.js";

export { HnAccountError } from "./errors.js";
export type { HnAccountErrorCode } from "./errors.js";
export type { AccountCapabilityName, AccountCapabilityState, AccountCapability, AccountObservation, AccountObservationPage, HnActionResult, HnAccountOptions, HnAccount } from "./types.js";

const LIST_PATHS: Record<PageKind, string> = { upvote: "/upvoted", favorite: "/favorites", flag: "/flagged" };
function validateSignal(signal: AbortSignal | undefined): void {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure("invalid-input");
  if (signal?.aborted) throw signal.reason;
}
function encodeCursor(kind: PageKind, username: string, url: string): string {
  return Buffer.from(JSON.stringify({ v: 1, kind, username, url }), "utf8").toString("base64url");
}
function decodeCursor(cursor: string, kind: PageKind, username: string): string {
  try {
    if (cursor.length === 0 || cursor.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("Invalid");
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; kind?: unknown; username?: unknown; url?: unknown };
    if (value === null || typeof value !== "object" || Array.isArray(value) || value.v !== 1 || value.kind !== kind ||
      value.username !== username || typeof value.url !== "string" || Object.keys(value).sort().join(",") !== "kind,url,username,v" ||
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url") !== cursor) throw new Error("Invalid");
    return value.url;
  } catch { throw failure("invalid-cursor"); }
}
export function createHnAccount(input: HnAccountOptions): HnAccount {
  const options = validateOptions(input);
  const transport = createTransport(options);
  const mutationEvidence = new Set<HnActionIntent["action"]>();
  const inFlight = new Map<string, { fingerprint: string; promise: Promise<HnActionResult> }>();
  let lane = Promise.resolve();
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = lane.then(work);
    lane = result.then(() => undefined, () => undefined);
    return result;
  }
  function listUrl(kind: PageKind): string {
    return `${options.baseUrl}${LIST_PATHS[kind]}?id=${encodeURIComponent(options.username)}`;
  }
  function storyUrl(storyId: number): string { return `${options.baseUrl}/item?id=${storyId}`; }
  async function validateSessionInternal(signal?: AbortSignal): Promise<{ username: string }> {
    const page = await transport.get(`${options.baseUrl}/`, new Set(["/", "/login"]), signal);
    assertIdentity(parseHtml(page.html), page.finalUrl, options.username);
    return { username: options.username };
  }
  async function readListInternal(kind: PageKind, cursor: string | undefined, signal?: AbortSignal): Promise<AccountObservationPage> {
    const initial = cursor === undefined ? listUrl(kind) : decodeCursor(cursor, kind, options.username);
    const parsedInitial = new URL(initial);
    transport.validateUrl(parsedInitial, new Set([LIST_PATHS[kind]]));
    if (parsedInitial.searchParams.get("id") !== options.username) throw failure("invalid-cursor");
    const page = await transport.get(initial, new Set([LIST_PATHS[kind], "/login"]), signal);
    const parsed = parseList(parseHtml(page.html), page.finalUrl, options.username, kind);
    let nextCursor: string | undefined;
    if (parsed.continuation !== undefined) {
      let target: URL;
      try { target = new URL(parsed.continuation, page.finalUrl); } catch { throw failure("parse-failed"); }
      transport.validateUrl(target, new Set([LIST_PATHS[kind]]));
      if (target.searchParams.get("id") !== options.username) throw failure("parse-failed");
      nextCursor = encodeCursor(kind, options.username, target.toString());
    }
    const observedAt = options.clock.now().toISOString();
    return {
      observations: parsed.storyIds.map((storyId) => ({ storyId, kind, present: true, observedAt })),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }
  async function storyPage(storyId: number, signal?: AbortSignal) {
    const page = await transport.get(storyUrl(storyId), new Set(["/item", "/login"]), signal);
    return { ...page, $: parseHtml(page.html) };
  }
  function outcome(intent: HnActionIntent, status: HnActionResult["status"], errorCode?: HnActionResult["errorCode"]): HnActionResult {
    return { intentId: intent.id, status, observedAt: options.clock.now().toISOString(), ...(errorCode === undefined ? {} : { errorCode }) };
  }
  async function executeAction(intent: HnActionIntent, signal?: AbortSignal): Promise<HnActionResult> {
    let dispatched = false;
    try {
      const before = await storyPage(intent.storyId, signal);
      const state = currentState(before.$, before.finalUrl, options.username, intent);
      if (state === "present") return outcome(intent, "verified");
      if (state === "unknown") throw failure("capability-unverified", { storyId: intent.storyId });
      const form = discoverForm(before.$, before.finalUrl, options.baseUrl, options.username, intent);
      mutationEvidence.add(intent.action);
      let postStatus: number | undefined;
      let postError: unknown;
      try { postStatus = await transport.post(form, signal, () => { dispatched = true; }); }
      catch (error) { postError = error; }
      if (signal?.aborted) return outcome(intent, "indeterminate", "cancelled-after-dispatch");
      try {
        const after = await storyPage(intent.storyId, signal);
        if (currentState(after.$, after.finalUrl, options.username, intent) === "present") return outcome(intent, "verified");
      } catch (error) {
        if (signal?.aborted) return outcome(intent, "indeterminate", "cancelled-after-dispatch");
        void error;
      }
      if (postError !== undefined) return outcome(intent, "indeterminate", "post-outcome-unknown");
      if (postStatus !== undefined && postStatus >= 200 && postStatus < 300) return outcome(intent, "indeterminate", "verification-unavailable");
      if (postStatus !== undefined && postStatus >= 400 && postStatus < 500) {
        if (postStatus === 401 || postStatus === 403) return outcome(intent, "failed", "session-expired");
        if (postStatus === 404 || postStatus === 410) return outcome(intent, "failed", "action-unavailable");
        return outcome(intent, "failed", "http-status");
      }
      return outcome(intent, "indeterminate", "post-outcome-unknown");
    } catch (error) {
      if (dispatched) return outcome(intent, "indeterminate", signal?.aborted ? "cancelled-after-dispatch" : "post-outcome-unknown");
      if (signal?.aborted) throw signal.reason;
      if (error instanceof HnAccountError) return outcome(intent, "failed", error.code);
      throw error;
    }
  }
  function capabilityFromError(name: AccountCapability["name"], error: unknown): AccountCapability {
    if (error instanceof HnAccountError && ["session-expired", "username-mismatch", "http-status"].includes(error.code)) {
      return { name, state: "unavailable", reason: error.code };
    }
    return { name, state: "unverified", reason: error instanceof HnAccountError ? error.code : "capability-unverified" };
  }
  return {
    async capabilities(signal?: AbortSignal): Promise<AccountCapability[]> {
      validateSignal(signal);
      return enqueue(async () => {
        let sessionError: unknown;
        try { await validateSessionInternal(signal); } catch (error) {
          if (signal?.aborted) throw signal.reason;
          sessionError = error;
        }
        const probe = async (name: "upvoted" | "favorites", kind: PageKind): Promise<AccountCapability> => {
          if (sessionError !== undefined) return capabilityFromError(name, sessionError);
          try { await readListInternal(kind, undefined, signal); return { name, state: "available" }; }
          catch (error) {
            if (signal?.aborted) throw signal.reason;
            return capabilityFromError(name, error);
          }
        };
        const upvoted = await probe("upvoted", "upvote");
        const favorites = await probe("favorites", "favorite");
        let flagged: AccountCapability;
        if (!options.flagReadbackEnabled) flagged = { name: "flagged", state: "unavailable", reason: "capability-disabled" };
        else if (sessionError !== undefined) flagged = capabilityFromError("flagged", sessionError);
        else {
          try { await readListInternal("flag", undefined, signal); flagged = { name: "flagged", state: "available" }; }
          catch (error) {
            if (signal?.aborted) throw signal.reason;
            flagged = capabilityFromError("flagged", error);
          }
        }
        const mutations: AccountCapability = sessionError === undefined && mutationEvidence.size === 3
          ? { name: "mutations", state: "available" }
          : { name: "mutations", state: "unverified", reason: "capability-unverified" };
        return [upvoted, favorites, flagged, mutations];
      });
    },
    async validateSession(signal?: AbortSignal) {
      validateSignal(signal);
      return enqueue(() => validateSessionInternal(signal));
    },
    async readUpvoted(cursor?: string, signal?: AbortSignal) {
      if (cursor !== undefined && typeof cursor !== "string") throw failure("invalid-cursor");
      validateSignal(signal);
      return enqueue(() => readListInternal("upvote", cursor, signal));
    },
    async readFavorites(cursor?: string, signal?: AbortSignal) {
      if (cursor !== undefined && typeof cursor !== "string") throw failure("invalid-cursor");
      validateSignal(signal);
      return enqueue(() => readListInternal("favorite", cursor, signal));
    },
    async readFlagged(cursor?: string, signal?: AbortSignal) {
      if (!options.flagReadbackEnabled) throw failure("capability-disabled");
      if (cursor !== undefined && typeof cursor !== "string") throw failure("invalid-cursor");
      validateSignal(signal);
      return enqueue(() => readListInternal("flag", cursor, signal));
    },
    async performAction(intent: HnActionIntent, signal?: AbortSignal): Promise<HnActionResult> {
      const parsed = HnActionIntentSchema.safeParse(intent);
      if (!parsed.success) throw failure("invalid-input");
      if (parsed.data.status !== "pending" && parsed.data.status !== "indeterminate") throw failure("action-conflict");
      validateSignal(signal);
      const value = parsed.data;
      const fingerprint = JSON.stringify([value.idempotencyKey, value.storyId, value.action, value.status]);
      const existing = inFlight.get(value.id);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) throw failure("invalid-input");
        return existing.promise;
      }
      const promise = enqueue(() => executeAction(value, signal));
      inFlight.set(value.id, { fingerprint, promise });
      try { return await promise; }
      finally { inFlight.delete(value.id); }
    },
  };
}
