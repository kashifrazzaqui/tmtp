import { apiError, InvalidResponse } from "./errors.js";
import { getJson } from "./http.js";
import { parseItem } from "./items.js";
import { normalizeOptions } from "./options.js";
import { normalizeStory } from "./stories.js";
import type { HnPublicApi, HnPublicApiOperation, HnPublicApiOptions } from "./types.js";

export { HnPublicApiError } from "./errors.js";
export { normalizeStory } from "./stories.js";
export type { HnPublicApi, HnPublicApiOptions, NormalizeStoryInput, HnPublicApiOperation, HnPublicApiErrorCode } from "./types.js";

const FEEDS = { top: "topstories.json", new: "newstories.json", best: "beststories.json", ask: "askstories.json", show: "showstories.json" } as const;
function validateSignal(signal: AbortSignal | undefined, operation: HnPublicApiOperation): void {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw apiError("invalid-input", operation);
  if (signal?.aborted) throw signal.reason;
}
function positiveId(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
export function createHnPublicApi(input: HnPublicApiOptions): HnPublicApi {
  const { baseUrl, http } = normalizeOptions(input);
  async function execute<T>(operation: HnPublicApiOperation, url: string, signal: AbortSignal | undefined, parse: (value: unknown) => T): Promise<T> {
    try {
      const value = await getJson(http, url, operation, signal);
      if (signal?.aborted) throw signal.reason;
      const result = parse(value);
      if (signal?.aborted) throw signal.reason;
      return result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof InvalidResponse) throw apiError("invalid-response", operation);
      throw error;
    }
  }
  return {
    async maxItemId(signal?: AbortSignal): Promise<number> {
      validateSignal(signal, "max-item");
      return execute("max-item", `${baseUrl}maxitem.json`, signal, (value) => {
        if (!positiveId(value)) throw new InvalidResponse();
        return value;
      });
    },
    async item(id: number, signal?: AbortSignal) {
      if (!positiveId(id)) throw apiError("invalid-input", "item");
      validateSignal(signal, "item");
      return execute("item", `${baseUrl}item/${id}.json`, signal, (value) => parseItem(value, id));
    },
    async feed(name: keyof typeof FEEDS, signal?: AbortSignal): Promise<number[]> {
      if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(FEEDS, name)) throw apiError("invalid-input", "feed");
      validateSignal(signal, "feed");
      return execute("feed", `${baseUrl}${FEEDS[name]}`, signal, (value) => {
        const maximum = name === "ask" || name === "show" ? 200 : 500;
        if (!Array.isArray(value) || value.length > maximum) throw new InvalidResponse();
        const seen = new Set<number>();
        for (const id of value) {
          if (!positiveId(id) || seen.has(id)) throw new InvalidResponse();
          seen.add(id);
        }
        return [...value];
      });
    },
  };
}
