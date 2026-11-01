import type { HnItem, IsoDateTime } from "@tmtp/domain";
import type { HnPublicApi } from "@tmtp/hn-public-api";
import type { Clock } from "@tmtp/clock";
import { check, wallNow } from "./time.js";
export interface FetchedItem { id: number; item: HnItem | undefined; observedAt: IsoDateTime; }
export async function fetchItems(ids: readonly number[], api: HnPublicApi, clock: Clock, signal: AbortSignal | undefined): Promise<FetchedItem[]> {
  const results = new Array<FetchedItem>(ids.length);
  const failures: Array<{ index: number; error: unknown }> = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (failures.length === 0 && !signal?.aborted) {
      const index = next++;
      if (index >= ids.length) return;
      try {
        check(signal);
        const item = await api.item(ids[index]!, signal);
        results[index] = { id: ids[index]!, item, observedAt: wallNow(clock) };
      } catch (error) { failures.push({ index, error }); return; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, ids.length) }, () => worker()));
  check(signal);
  if (failures.length > 0) throw failures.sort((left, right) => left.index - right.index)[0]!.error;
  return results;
}
