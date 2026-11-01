import type { Clock, Sleep } from "@tmtp/clock";
import type { HttpClient } from "@tmtp/http-client";
import type { ArticleDnsResolver, ArticleProtocol } from "./types.js";

export interface ArticleFetcherOptions {
  http: HttpClient;
  clock: Clock;
  sleep: Sleep;
  timeoutMs: number;
  dnsTimeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  allowedProtocols: readonly ArticleProtocol[];
  allowedPorts: readonly number[];
  resolver?: ArticleDnsResolver;
}
const MAX = 2_147_483_647;
export function validateOptions(options: ArticleFetcherOptions): ArticleFetcherOptions {
  if (options === null || typeof options !== "object" || options.http === null || typeof options.http !== "object" ||
    typeof options.http.request !== "function" || options.clock === null || typeof options.clock !== "object" ||
    typeof options.clock.now !== "function" || typeof options.clock.monotonicNowMs !== "function" ||
    typeof options.sleep !== "function" || (options.resolver !== undefined &&
      (options.resolver === null || typeof options.resolver !== "object" || typeof options.resolver.resolve !== "function"))) {
    throw new TypeError("Invalid article fetcher dependencies.");
  }
  for (const value of [options.timeoutMs, options.dnsTimeoutMs, options.maxResponseBytes, options.maxRedirects, ...options.allowedPorts]) {
    if (typeof value !== "number") throw new TypeError("Article fetcher numeric options must be numbers.");
  }
  if (!Array.isArray(options.allowedProtocols) || !Array.isArray(options.allowedPorts)) throw new TypeError("Article fetcher policies must be arrays.");
  if (options.allowedProtocols.some((value) => typeof value !== "string")) throw new TypeError("Article protocols must be strings.");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX ||
    !Number.isSafeInteger(options.dnsTimeoutMs) || options.dnsTimeoutMs < 1 || options.dnsTimeoutMs > MAX ||
    !Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1 || options.maxResponseBytes > MAX ||
    !Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0 || options.maxRedirects > 100 ||
    options.allowedProtocols.length === 0 || options.allowedPorts.length === 0 ||
    options.allowedProtocols.some((value) => value !== "http" && value !== "https") ||
    options.allowedPorts.some((value) => !Number.isInteger(value) || value < 1 || value > 65535) ||
    new Set(options.allowedProtocols).size !== options.allowedProtocols.length ||
    new Set(options.allowedPorts).size !== options.allowedPorts.length) {
    throw new RangeError("Article fetcher policy is outside its supported range.");
  }
  return {
    http: options.http, clock: options.clock, sleep: options.sleep,
    timeoutMs: options.timeoutMs, dnsTimeoutMs: options.dnsTimeoutMs,
    maxResponseBytes: options.maxResponseBytes, maxRedirects: options.maxRedirects,
    allowedProtocols: Object.freeze([...options.allowedProtocols]),
    allowedPorts: Object.freeze([...options.allowedPorts]),
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
  };
}
