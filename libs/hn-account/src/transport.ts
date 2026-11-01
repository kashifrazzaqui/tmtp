import { HttpError } from "@tmtp/http-client";
import type { HttpResponse } from "@tmtp/http-client";
import { failure } from "./errors.js";
import type { HnAccountErrorCode } from "./errors.js";
import type { NormalizedOptions } from "./options.js";
import type { FormDiscovery } from "./html.js";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
export interface HtmlPage { html: string; finalUrl: string; }
async function cancellable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal?.aborted) throw signal.reason;
  if (signal === undefined) return promise;
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { if (listener !== undefined) signal.removeEventListener("abort", listener); }
}
function mapHttp(error: HttpError): never {
  const codes: Record<HttpError["code"], HnAccountErrorCode> = {
    "invalid-request": "invalid-request", timeout: "timeout", "response-too-large": "response-too-large",
    "redirect-policy": "origin-policy", "redirect-limit": "redirect-limit", "invalid-redirect": "invalid-redirect",
    transport: "transport", "client-closed": "client-closed",
  };
  throw failure(codes[error.code], error.status === undefined ? {} : { status: error.status });
}
function statusError(status: number): never {
  if (status === 401 || status === 403) throw failure("session-expired", { status });
  throw failure("http-status", { status });
}
function header(response: HttpResponse, name: string): readonly string[] | undefined {
  return Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
}
function decodeHtml(response: HttpResponse): string {
  const contentType = header(response, "content-type");
  const encoding = header(response, "content-encoding");
  if (encoding !== undefined && (encoding.length !== 1 || encoding[0]!.trim().toLowerCase() !== "identity")) throw failure("parse-failed");
  if (contentType?.length !== 1) throw failure("parse-failed");
  const parts = contentType[0]!.split(";").map((part) => part.trim());
  if (parts[0]?.toLowerCase() !== "text/html") throw failure("parse-failed");
  const charsets = parts.slice(1).filter((part) => part.toLowerCase().startsWith("charset="));
  if (charsets.length > 1 || (charsets.length === 1 && !["utf-8", "utf8"].includes(charsets[0]!.slice(8).trim().replace(/^"|"$/g, "").toLowerCase()))) {
    throw failure("parse-failed");
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(response.body); }
  catch { throw failure("parse-failed"); }
}
export function createTransport(options: NormalizedOptions) {
  const { http, clock, sleep } = options;
  let starts: number[] = [];
  async function reserve(signal: AbortSignal | undefined): Promise<void> {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const now = clock.monotonicNowMs();
      starts = starts.filter((started) => now - started < 60_000);
      if (starts.length < options.maxRequestsPerMinute) {
        starts.push(now);
        return;
      }
      const oldest = starts[0]!;
      const wait = Math.max(1, Math.ceil(60_000 - (now - oldest)));
      await cancellable(sleep(wait, signal), signal);
    }
  }
  async function request(method: "GET" | "POST", url: string, signal: AbortSignal | undefined, form?: FormDiscovery, onDispatch?: () => void): Promise<HttpResponse> {
    await reserve(signal);
    if (signal?.aborted) throw signal.reason;
    try {
      onDispatch?.();
      const pending = http.request({
        method, url, redirect: "manual", maxResponseBytes: 5_000_000,
        headers: {
          Accept: "text/html", Cookie: `user=${options.sessionCookie}`,
          ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(method === "POST" ? { body: new URLSearchParams(form!.fields.map((field) => [field.name, field.value])).toString() } : {}),
        ...(signal === undefined ? {} : { signal }),
      });
      return await cancellable(pending, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof HttpError) mapHttp(error);
      throw error;
    }
  }
  function validateUrl(url: URL, allowedPaths: ReadonlySet<string>): void {
    if (url.origin !== options.baseUrl || url.username !== "" || url.password !== "") throw failure("origin-policy");
    if (url.hash !== "" || !allowedPaths.has(url.pathname) || url.toString().length > 2048) throw failure("parse-failed");
  }
  async function get(initial: string, allowedPaths: ReadonlySet<string>, signal?: AbortSignal): Promise<HtmlPage> {
    let current = new URL(initial);
    validateUrl(current, allowedPaths);
    for (let followed = 0; ; ) {
      const response = await request("GET", current.toString(), signal);
      if (signal?.aborted) throw signal.reason;
      const locations = header(response, "location");
      if (REDIRECTS.has(response.status) && locations !== undefined) {
        if (locations.length !== 1 || locations[0]!.trim() === "") throw failure("invalid-redirect", { status: response.status });
        let target: URL;
        try { target = new URL(locations[0]!, current); } catch { throw failure("invalid-redirect", { status: response.status }); }
        if (target.origin !== options.baseUrl || target.username !== "" || target.password !== "") throw failure("origin-policy", { status: response.status });
        if (target.hash !== "") throw failure("invalid-redirect", { status: response.status });
        if (followed >= 5) throw failure("redirect-limit", { status: response.status });
        validateUrl(target, allowedPaths);
        current = target;
        followed += 1;
        continue;
      }
      if (response.status !== 200) statusError(response.status);
      return { html: decodeHtml(response), finalUrl: current.toString() };
    }
  }
  async function post(form: FormDiscovery, signal: AbortSignal | undefined, onDispatch: () => void): Promise<number> {
    const response = await request("POST", form.target, signal, form, onDispatch);
    return response.status;
  }
  return { get, post, validateUrl };
}
