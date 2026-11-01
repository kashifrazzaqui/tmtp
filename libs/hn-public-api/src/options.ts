import type { HnPublicApiOptions } from "./types.js";
export function normalizeOptions(options: HnPublicApiOptions): { baseUrl: string; http: HnPublicApiOptions["http"] } {
  if (options === null || typeof options !== "object" || typeof options.baseUrl !== "string") throw new TypeError("HN public API baseUrl is invalid.");
  if (options.http === null || typeof options.http !== "object" || typeof options.http.request !== "function") throw new TypeError("HN public API http is invalid.");
  let url: URL;
  try { url = new URL(options.baseUrl); } catch { throw new TypeError("HN public API baseUrl is invalid."); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError("HN public API baseUrl is invalid.");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") + "/";
  return { baseUrl: url.toString(), http: options.http };
}
