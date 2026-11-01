import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Address4, Address6 } from "ip-address";
import { HttpError } from "@tmtp/http-client";
import type { HttpConnection, HttpResponse } from "@tmtp/http-client";
import { ArticleFetchError, failure, mapHttpError } from "./errors.js";
import { decodeContent } from "./content.js";
import { validateOptions } from "./options.js";
import type { ArticleFetcherOptions } from "./options.js";
import type { ArticleDnsResolver, ArticleFetcher, FetchedArticle } from "./types.js";

export { ArticleFetchError } from "./errors.js";
export type { ArticleFetchErrorCode } from "./errors.js";
export type { ArticleFetcherOptions } from "./options.js";
export type { ArticleProtocol, ArticleContentType, FetchedArticle, ArticleDnsResolver, ArticleFetcher } from "./types.js";

const OVERALL_TIMEOUT = Symbol("article-overall-timeout");
const DNS_TIMEOUT = Symbol("article-dns-timeout");
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
interface NormalizedUrl { url: string; hostname: string; port: number; }
async function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { if (listener !== undefined) signal.removeEventListener("abort", listener); }
}
function parseUrl(value: string, redirect: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw failure(redirect ? "invalid-redirect" : "invalid-url");
  }
  if (url.hostname === "") throw failure("url-policy");
  url.hash = "";
  return url;
}
function applyUrlPolicy(url: URL, options: ArticleFetcherOptions): NormalizedUrl {
  const protocol = url.protocol.slice(0, -1);
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (url.username !== "" || url.password !== "" || !options.allowedProtocols.includes(protocol as "http" | "https") ||
    !options.allowedPorts.includes(port)) throw failure("url-policy");
  return { url: url.toString(), hostname: url.hostname, port };
}
function canonicalAddress(value: string): string {
  try {
    if (typeof value !== "string") throw failure("address-policy");
    const family = isIP(value);
    if (family === 4) {
      const address = new Address4(value);
      if (!address.isGlobal()) throw failure("address-policy");
      return address.correctForm();
    }
    if (family === 6) {
      const address = new Address6(value);
      if (!address.isGlobal()) throw failure("address-policy");
      return address.correctForm();
    }
  } catch (error) {
    if (error instanceof ArticleFetchError) throw error;
    throw failure("address-policy");
  }
  throw failure("address-policy");
}
function literalHostname(hostname: string): string | undefined {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
  return isIP(hostname) === 0 ? undefined : hostname;
}
const nodeResolver: ArticleDnsResolver = {
  async resolve(hostname) {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.map((entry) => entry.address);
  },
};

export function createArticleFetcher(input: ArticleFetcherOptions): ArticleFetcher {
  const options = validateOptions(input);
  const { http, clock, sleep } = options;
  async function fetch(value: string, callerSignal?: AbortSignal): Promise<FetchedArticle> {
    if (typeof value !== "string") throw failure("invalid-url");
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) throw failure("invalid-request");
    const source = applyUrlPolicy(parseUrl(value, false), options);
    if (callerSignal?.aborted) throw callerSignal.reason;
    const operation = new AbortController();
    const deadline = new AbortController();
    const callerAbort = (): void => operation.abort(callerSignal?.reason);
    let deadlineObservation: Promise<void> | undefined;
    const throwIfAborted = (): void => {
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (!operation.signal.aborted) return;
      if (operation.signal.reason === OVERALL_TIMEOUT) throw failure("timeout");
      throw operation.signal.reason;
    };
    let startedAt = 0;
    try {
      callerSignal?.addEventListener("abort", callerAbort);
      if (callerSignal?.aborted) callerAbort();
      startedAt = clock.monotonicNowMs();
      const sleeping = sleep(options.timeoutMs, deadline.signal);
      deadlineObservation = Promise.resolve(sleeping).then(
        () => { if (!deadline.signal.aborted) operation.abort(OVERALL_TIMEOUT); },
        (error: unknown) => { if (!deadline.signal.aborted) operation.abort(error); },
      );
      const remaining = (): number => {
        throwIfAborted();
        const left = options.timeoutMs - Math.max(0, clock.monotonicNowMs() - startedAt);
        if (left <= 0) throw failure("timeout");
        return left;
      };
      const resolveDns = async (hostname: string): Promise<readonly string[]> => {
        const wait = Math.min(options.dnsTimeoutMs, Math.max(1, Math.ceil(remaining())));
        const dnsDeadline = new AbortController();
        const dnsController = new AbortController();
        const operationAbort = (): void => dnsController.abort(operation.signal.reason);
        let observation: Promise<void> | undefined;
        let resolverStarted = false;
        operation.signal.addEventListener("abort", operationAbort);
        try {
          if (operation.signal.aborted) operationAbort();
          const sleepingDns = sleep(wait, dnsDeadline.signal);
          observation = Promise.resolve(sleepingDns).then(
            () => { if (!dnsDeadline.signal.aborted) dnsController.abort(DNS_TIMEOUT); },
            (error: unknown) => { if (!dnsDeadline.signal.aborted) dnsController.abort(error); },
          );
          resolverStarted = true;
          const resolving = Promise.resolve().then(() => (options.resolver ?? nodeResolver).resolve(hostname, operation.signal));
          const addresses = await raceSignal(resolving, dnsController.signal);
          throwIfAborted();
          if (dnsController.signal.aborted) {
            if (dnsController.signal.reason === DNS_TIMEOUT) throw failure("dns-timeout");
            throw dnsController.signal.reason;
          }
          if (!Array.isArray(addresses) || addresses.length === 0) throw failure("dns-failed");
          return addresses;
        } catch (error) {
          throwIfAborted();
          if (dnsController.signal.aborted) {
            if (dnsController.signal.reason === DNS_TIMEOUT) throw failure("dns-timeout");
            throw dnsController.signal.reason;
          }
          if (resolverStarted && !(error instanceof ArticleFetchError)) throw failure("dns-failed");
          throw error;
        } finally {
          operation.signal.removeEventListener("abort", operationAbort);
          dnsDeadline.abort();
          void observation;
        }
      };
      const pinFor = async (normalized: NormalizedUrl): Promise<HttpConnection> => {
        const literal = literalHostname(normalized.hostname);
        const addresses = literal === undefined ? await resolveDns(normalized.hostname) : [literal];
        throwIfAborted();
        const canonical = addresses.map((address) => canonicalAddress(address));
        const selected = canonical[0];
        if (selected === undefined) throw failure("dns-failed");
        return { address: selected, port: normalized.port, servername: normalized.hostname };
      };
      const request = async (normalized: NormalizedUrl): Promise<HttpResponse> => {
        const connection = await pinFor(normalized);
        const timeoutMs = Math.max(1, Math.ceil(remaining()));
        throwIfAborted();
        try {
          const response = await raceSignal(Promise.resolve().then(() => http.request({
            method: "GET", url: normalized.url,
            headers: { Accept: "text/html,application/xhtml+xml", "Accept-Encoding": "gzip, deflate, br, identity" },
            timeoutMs, maxResponseBytes: options.maxResponseBytes, redirect: "manual",
            connection, signal: operation.signal,
          })), operation.signal);
          throwIfAborted();
          return response;
        } catch (error) {
          throwIfAborted();
          if (error instanceof HttpError) throw mapHttpError(error);
          throw error;
        }
      };
      let current = source;
      let followed = 0;
      while (true) {
        throwIfAborted();
        const response = await request(current);
        const locations = Object.entries(response.headers).find(([name]) => name.toLowerCase() === "location")?.[1];
        if (REDIRECTS.has(response.status) && locations !== undefined) {
          if (locations.length !== 1 || locations[0]!.trim() === "") throw failure("invalid-redirect", response.status);
          let target: URL;
          try { target = parseUrl(new URL(locations[0]!, current.url).toString(), true); }
          catch (error) {
            if (error instanceof ArticleFetchError) throw error;
            throw failure("invalid-redirect");
          }
          if (followed >= options.maxRedirects) throw failure("redirect-limit", response.status);
          current = applyUrlPolicy(target, options);
          followed += 1;
          continue;
        }
        if (response.status !== 200) throw failure("http-status", response.status);
        const decoded = await decodeContent(response, options.maxResponseBytes, operation.signal, raceSignal);
        throwIfAborted();
        let html: string;
        try { html = new TextDecoder("utf-8", { fatal: true }).decode(decoded.bytes); }
        catch { throw failure("invalid-text"); }
        throwIfAborted();
        return {
          sourceUrl: source.url, finalUrl: current.url, contentType: decoded.contentType,
          html, fetchedAt: clock.now().toISOString(),
        };
      }
    } catch (error) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (operation.signal.aborted) {
        if (operation.signal.reason === OVERALL_TIMEOUT) throw failure("timeout");
        throw operation.signal.reason;
      }
      throw error;
    } finally {
      callerSignal?.removeEventListener("abort", callerAbort);
      deadline.abort();
      void deadlineObservation;
      void startedAt;
    }
  }
  return { fetch };
}
