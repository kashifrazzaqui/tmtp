import type { ReaderAppOptions, NormalizedReaderAppOptions } from "./types.js";
import { exactKeys, plainObject } from "./validation.js";

const KEYS = [
  "store", "jobs", "articles", "ingestion", "personalization", "queuePageSize", "queueMaxPageSize", "now", "createId",
];
function invalid(field: string): never { throw new TypeError(`Invalid reader application option: ${field}.`); }
function range(field: string): never { throw new RangeError(`Invalid reader application option range: ${field}.`); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}
function methods(value: unknown, field: string, names: readonly string[]): void {
  const dependency = object(value, field);
  for (const name of names) if (typeof dependency[name] !== "function") invalid(`${field}.${name}`);
}
function repository(parent: Record<string, unknown>, parentField: string, name: string, names: readonly string[]): void {
  methods(parent[name], `${parentField}.${name}`, names);
}

export function normalizeOptions(input: ReaderAppOptions): NormalizedReaderAppOptions {
  if (!plainObject(input) || !exactKeys(input, KEYS, ["account"])) invalid("options");
  const store = object(input.store, "store");
  methods(store, "store", ["transaction"]);
  repository(store, "store", "stories", ["byId", "byStoryIds"]);
  repository(store, "store", "articles", ["upsert", "byStoryId", "needingContent"]);
  repository(store, "store", "activity", ["query"]);
  repository(store, "store", "readingSessions", ["query"]);
  repository(store, "store", "preferences", ["list"]);
  repository(store, "store", "recommendations", ["byId", "historyForStory"]);
  repository(store, "store", "queue", ["byStoryId", "updateState", "page", "countsByEvaluationState", "forReprojection", "projection"]);
  repository(store, "store", "hnActions", ["createIntent", "byId", "byIdempotencyKey", "updateOutcome", "historyForStory"]);
  methods(input.jobs, "jobs", ["enqueue"]);
  methods(input.articles, "articles", ["read"]);
  methods(input.ingestion, "ingestion", ["collectPublic", "reconcileAccount"]);
  methods(input.personalization, "personalization", ["recordActivity", "rebuildProfile", "applyPreferenceChange", "recover", "runJob"]);
  if (input.account !== undefined) methods(input.account, "account", ["capabilities", "performAction"]);
  if (typeof input.now !== "function") invalid("now");
  if (typeof input.createId !== "function") invalid("createId");
  for (const field of ["queuePageSize", "queueMaxPageSize"] as const) {
    if (!Number.isSafeInteger(input[field]) || input[field] < 1) range(field);
  }
  if (input.queuePageSize > input.queueMaxPageSize) range("queuePageSize");
  return {
    store: input.store,
    jobs: input.jobs,
    articles: input.articles,
    ingestion: input.ingestion,
    personalization: input.personalization,
    ...(input.account === undefined ? {} : { account: input.account }),
    queuePageSize: input.queuePageSize,
    queueMaxPageSize: input.queueMaxPageSize,
    now: input.now,
    createId: input.createId,
  };
}
