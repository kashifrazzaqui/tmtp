import type { HnFeed } from "@tmtp/domain";
import type { HnIngestionOptions } from "./types.js";
const FEEDS: readonly HnFeed[] = ["top", "new", "best", "ask", "show"];
const OPTION_KEYS = ["api", "account", "store", "jobs", "clock", "bootstrapRankVersion", "feeds", "initialLookbackItems", "maxItemsPerRun", "refreshBatchSize", "refreshAfterHours"];
export interface NormalizedOptions extends HnIngestionOptions { feeds: readonly HnFeed[]; bootstrapRank: string; refreshAfterMs: number; }
function object(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Invalid HN ingestion ${field}.`);
}
function methods(value: unknown, field: string, names: Record<string, readonly string[]>): void {
  object(value, field);
  for (const [key, children] of Object.entries(names)) {
    const member = (value as Record<string, unknown>)[key];
    if (children.length === 0) { if (typeof member !== "function") throw new TypeError(`Invalid HN ingestion ${field}.${key}.`); continue; }
    object(member, `${field}.${key}`);
    for (const child of children) if (typeof (member as Record<string, unknown>)[child] !== "function") throw new TypeError(`Invalid HN ingestion ${field}.${key}.${child}.`);
  }
}
function integer(value: unknown, field: string, minimum: number): asserts value is number {
  if (typeof value !== "number") throw new TypeError(`Invalid HN ingestion ${field}.`);
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`Invalid HN ingestion ${field}.`);
}
export function normalizeOptions(options: HnIngestionOptions): NormalizedOptions {
  object(options, "options");
  if (Object.keys(options).some((key) => !OPTION_KEYS.includes(key))) throw new TypeError("Invalid HN ingestion options key.");
  methods(options.api, "api", { maxItemId: [], item: [], feed: [] });
  if (options.account !== undefined) methods(options.account, "account", { validateSession: [], capabilities: [], readUpvoted: [], readFavorites: [], readFlagged: [], performAction: [] });
  methods(options.store, "store", {
    transaction: [], stories: ["byId", "upsertBatch", "needingRefresh"], profiles: ["current"],
    queue: ["projection", "insertPendingIfMissing"], sync: ["cursor", "setCursor", "startRun", "finishRun"],
    hnAccountStates: ["byStoryIds", "upsertObservations"], hnActions: ["pendingOrIndeterminate", "updateOutcome"],
  });
  methods(options.jobs, "jobs", { enqueue: [] }); methods(options.clock, "clock", { now: [] });
  if (typeof options.bootstrapRankVersion !== "function") throw new TypeError("Invalid HN ingestion bootstrapRankVersion.");
  if (!Array.isArray(options.feeds)) throw new TypeError("Invalid HN ingestion feeds.");
  const feeds = [...options.feeds];
  if (feeds.some((feed, index) => !FEEDS.includes(feed) || feeds.indexOf(feed) !== index)) throw new RangeError("Invalid HN ingestion feeds.");
  integer(options.initialLookbackItems, "initialLookbackItems", 0); integer(options.maxItemsPerRun, "maxItemsPerRun", 1); integer(options.refreshBatchSize, "refreshBatchSize", 1);
  if (typeof options.refreshAfterHours !== "number") throw new TypeError("Invalid HN ingestion refreshAfterHours.");
  const refreshAfterMs = options.refreshAfterHours * 3_600_000;
  if (!Number.isFinite(options.refreshAfterHours) || options.refreshAfterHours <= 0 || !Number.isSafeInteger(refreshAfterMs) || refreshAfterMs <= 0) throw new RangeError("Invalid HN ingestion refreshAfterHours.");
  const bootstrapRank = options.bootstrapRankVersion();
  if (typeof bootstrapRank !== "string") throw new TypeError("Invalid HN ingestion bootstrapRankVersion result.");
  if (bootstrapRank.length === 0 || bootstrapRank.length > 128) throw new RangeError("Invalid HN ingestion bootstrapRankVersion result.");
  return { ...options, feeds, bootstrapRank, refreshAfterMs };
}
