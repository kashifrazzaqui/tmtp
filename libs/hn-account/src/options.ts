import { isIP } from "node:net";
import type { HnAccountOptions } from "./types.js";
export interface NormalizedOptions extends HnAccountOptions { baseUrl: string; username: string; flagReadbackEnabled: boolean; }
export function validateOptions(options: HnAccountOptions): NormalizedOptions {
  if (options === null || typeof options !== "object" || typeof options.baseUrl !== "string" || typeof options.username !== "string" ||
    typeof options.sessionCookie !== "string" || options.http === null || typeof options.http !== "object" || typeof options.http.request !== "function" ||
    options.clock === null || typeof options.clock !== "object" || typeof options.clock.now !== "function" || typeof options.clock.monotonicNowMs !== "function" ||
    typeof options.sleep !== "function" || typeof options.maxRequestsPerMinute !== "number" ||
    (options.flagReadbackEnabled !== undefined && typeof options.flagReadbackEnabled !== "boolean")) throw new TypeError("Invalid HN account options.");
  let url: URL;
  try { url = new URL(options.baseUrl); } catch { throw new RangeError("Invalid HN baseUrl."); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || (isIP(hostname) === 4 && hostname.startsWith("127.")) || hostname === "::1";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username !== "" || url.password !== "" ||
    url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new RangeError("Invalid HN baseUrl.");
  const username = options.username.trim();
  if (username.length === 0 || username.length > 128 || /[\u0000-\u001f\u007f]/.test(username)) throw new RangeError("Invalid HN username.");
  if (options.sessionCookie.length === 0 || /[;\u0000-\u001f\u007f]/.test(options.sessionCookie)) throw new RangeError("Invalid HN sessionCookie.");
  if (!Number.isSafeInteger(options.maxRequestsPerMinute) || options.maxRequestsPerMinute < 1 || options.maxRequestsPerMinute > 600) {
    throw new RangeError("Invalid HN maxRequestsPerMinute.");
  }
  return {
    baseUrl: url.origin, http: options.http, clock: options.clock, sleep: options.sleep, username,
    sessionCookie: options.sessionCookie, maxRequestsPerMinute: options.maxRequestsPerMinute,
    flagReadbackEnabled: options.flagReadbackEnabled ?? false,
  };
}
