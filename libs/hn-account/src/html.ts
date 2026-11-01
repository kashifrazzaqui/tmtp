import { load } from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { HnActionKind } from "@tmtp/domain";
import { failure } from "./errors.js";

export type PageKind = "upvote" | "favorite" | "flag";
export interface FormDiscovery { target: string; fields: Array<{ name: string; value: string }>; }
export function parseHtml(html: string): CheerioAPI { return load(html); }
function storyId(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) throw failure("parse-failed");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw failure("parse-failed");
  return id;
}
function resolved(value: string, base: string): URL | undefined {
  try { return new URL(value, base); } catch { return undefined; }
}
export function assertIdentity($: CheerioAPI, pageUrl: string, username: string): void {
  const identities = new Set<string>();
  let anonymous = false;
  $("a[href], form[action]").each((_index, element) => {
    const raw = $(element).attr("href") ?? $(element).attr("action") ?? "";
    const url = resolved(raw, pageUrl);
    if (url === undefined) return;
    if (url.pathname === "/login") anonymous = true;
    if (url.pathname !== "/user") return;
    const id = url.searchParams.get("id");
    if (id !== null && id !== "" && $(element).text().trim() === id) identities.add(id);
  });
  if (identities.has(username)) {
    if (identities.size !== 1) throw failure("parse-failed");
    return;
  }
  if (identities.size === 1) throw failure("username-mismatch");
  if (identities.size > 1) throw failure("parse-failed");
  if (anonymous) throw failure("session-expired");
  throw failure("parse-failed");
}
export function parseList($: CheerioAPI, pageUrl: string, username: string, kind: PageKind): { storyIds: number[]; continuation?: string } {
  assertIdentity($, pageUrl, username);
  const storyIds: number[] = [];
  const seen = new Set<number>();
  $("tr.athing").each((_index, element) => {
    const id = storyId($(element).attr("id"));
    if (seen.has(id)) throw failure("parse-failed");
    seen.add(id);
    storyIds.push(id);
  });
  const links = $("a.morelink").toArray();
  if (links.length > 1) throw failure("parse-failed");
  if (links.length === 0) return { storyIds };
  const raw = $(links[0]!).attr("href");
  if (raw === undefined || raw.trim() === "") throw failure("parse-failed");
  return { storyIds, continuation: raw };
}
interface StateControl { state: "present" | "absent"; }
function controlFor(url: URL, kind: HnActionKind): StateControl | undefined {
  const names = kind === "upvote" ? { present: "/unvote", absent: "/vote" } : kind === "favorite" ? { present: "/unfavorite", absent: "/favorite" } : { present: "/unflag", absent: "/flag" };
  if (url.pathname === names.present) return { state: "present" };
  if (url.pathname === names.absent) {
    if (kind === "upvote" && url.searchParams.get("how") !== "up") return undefined;
    return { state: "absent" };
  }
  return undefined;
}
export function currentState($: CheerioAPI, pageUrl: string, username: string, intent: { storyId: number; action: HnActionKind }): "present" | "absent" | "unknown" {
  assertIdentity($, pageUrl, username);
  const states: Array<"present" | "absent"> = [];
  $("a[href]").each((_index, element) => {
    const url = resolved($(element).attr("href")!, pageUrl);
    if (url === undefined) return;
    const control = controlFor(url, intent.action);
    if (control === undefined) return;
    if (url.searchParams.get("id") !== String(intent.storyId)) throw failure("action-conflict", { storyId: intent.storyId });
    states.push(control.state);
  });
  if (states.length > 1 || new Set(states).size > 1) throw failure("action-conflict", { storyId: intent.storyId });
  return states[0] ?? "unknown";
}
const ACTION_PATHS: Record<HnActionKind, string> = { upvote: "/vote", favorite: "/favorite", flag: "/flag" };
const ALLOWED_FIELDS: Record<HnActionKind, Set<string>> = {
  upvote: new Set(["id", "how", "csrf", "goto"]), favorite: new Set(["id", "csrf", "goto"]), flag: new Set(["id", "csrf", "goto"]),
};
export function discoverForm($: CheerioAPI, pageUrl: string, origin: string, username: string, intent: { storyId: number; action: HnActionKind }): FormDiscovery {
  assertIdentity($, pageUrl, username);
  const path = ACTION_PATHS[intent.action];
  const forms = $("form").toArray().filter((form) => {
    const action = $(form).attr("action") ?? "";
    const url = resolved(action, pageUrl);
    return url?.pathname === path;
  });
  if (forms.length === 0) throw failure("action-unavailable", { storyId: intent.storyId });
  if (forms.length !== 1) throw failure("action-conflict", { storyId: intent.storyId });
  const form = forms[0]!;
  if (($(form).attr("method") ?? "get").toLowerCase() !== "post") throw failure("action-conflict", { storyId: intent.storyId });
  const actionUrl = resolved($(form).attr("action") ?? "", pageUrl);
  if (actionUrl === undefined) throw failure("parse-failed", { storyId: intent.storyId });
  const target = actionUrl.toString();
  if (actionUrl.origin !== origin || actionUrl.username !== "" || actionUrl.password !== "") throw failure("origin-policy", { storyId: intent.storyId });
  if (actionUrl.hash !== "" || target.length > 2048) throw failure("parse-failed", { storyId: intent.storyId });
  const fields: FormDiscovery["fields"] = [];
  const names = new Set<string>();
  $(form).find("input, select, textarea").each((_index, element) => {
    const input = $(element);
    const name = input.attr("name");
    const hidden = input.attr("type")?.toLowerCase() === "hidden";
    if (!hidden) {
      if (name !== undefined && name !== "") throw failure("action-conflict", { storyId: intent.storyId });
      return;
    }
    if (name === undefined || !ALLOWED_FIELDS[intent.action].has(name) || names.has(name)) throw failure("action-conflict", { storyId: intent.storyId });
    names.add(name);
    fields.push({ name, value: input.attr("value") ?? "" });
  });
  const id = fields.find((field) => field.name === "id")?.value;
  const csrf = fields.find((field) => field.name === "csrf")?.value;
  const how = fields.find((field) => field.name === "how")?.value;
  if (id !== String(intent.storyId) || csrf === undefined || csrf === "" || (intent.action === "upvote" && how !== "up")) {
    throw failure("action-conflict", { storyId: intent.storyId });
  }
  return { target, fields };
}
