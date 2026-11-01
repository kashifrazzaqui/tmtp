import type { HnItem, IsoDateTime, QueueEntry, Story } from "@tmtp/domain";
import { normalizeStory } from "@tmtp/hn-public-api";
import { isBlacklisted } from "@tmtp/interests";
import { COLLECTION_CURSOR, REFRESH_CURSOR, cursorSnapshot, decodeCollection, decodeRefresh, encodeCollection, encodeRefresh } from "./checkpoints.js";
import type { CollectionCheckpoint, RefreshCheckpoint } from "./checkpoints.js";
import type { FetchedItem } from "./fetch-pool.js";
import { handoff } from "./jobs.js";
import type { NormalizedOptions } from "./options.js";
import { completeRun } from "./runs.js";
import type { RunContext } from "./runs.js";
import { refreshCutoff } from "./time.js";
import type { IngestionSummary } from "./types.js";
export interface PublicPlan {
  ids: number[]; highestSeenItemId: number; nextCollection: CollectionCheckpoint; nextRefresh: RefreshCheckpoint;
  cursorStart: string; collectionRaw?: string; refreshRaw?: string;
}
function bootstrapSelection(cursor: Extract<CollectionCheckpoint, { state: "bootstrap" }>, limit: number): { ids: number[]; next: CollectionCheckpoint } {
  const ids: number[] = [];
  let feedIndex = cursor.nextFeedIndex;
  let lookback = cursor.nextLookbackId;
  while (ids.length < limit) {
    const feed = cursor.feedIds[feedIndex];
    const candidate = feed === undefined ? lookback : lookback === undefined ? feed : Math.min(feed, lookback);
    if (candidate === undefined) break;
    ids.push(candidate);
    while (cursor.feedIds[feedIndex] === candidate) feedIndex += 1;
    if (lookback === candidate) lookback = candidate < cursor.targetMaxItemId ? candidate + 1 : undefined;
  }
  const next: CollectionCheckpoint = feedIndex < cursor.feedIds.length || lookback !== undefined
    ? { schemaVersion: 1, state: "bootstrap", targetMaxItemId: cursor.targetMaxItemId, feedIds: [...cursor.feedIds], nextFeedIndex: feedIndex, ...(lookback === undefined ? {} : { nextLookbackId: lookback }) }
    : { schemaVersion: 1, state: "advance", lastProcessedItemId: cursor.targetMaxItemId };
  return { ids, next };
}
function advanceSelection(last: number, officialMax: number, limit: number): { ids: number[]; next: CollectionCheckpoint; highest: number } {
  const target = Math.max(last, officialMax);
  const count = Math.min(limit, target - last);
  const ids = Array.from({ length: count }, (_, index) => last + index + 1);
  return { ids, next: { schemaVersion: 1, state: "advance", lastProcessedItemId: last + count }, highest: Math.max(officialMax, last + count) };
}
export async function planPublic(options: NormalizedOptions, startedAt: IsoDateTime, signal: AbortSignal | undefined, start: (cursorStart: string) => void): Promise<PublicPlan> {
  const collectionRaw = options.store.sync.cursor(COLLECTION_CURSOR);
  const refreshRaw = options.store.sync.cursor(REFRESH_CURSOR);
  const collection = decodeCollection(collectionRaw);
  const refresh = decodeRefresh(refreshRaw);
  const olderThan = refreshCutoff(startedAt, options.refreshAfterMs, "collect-public");
  const refreshStories = options.store.stories.needingRefresh(olderThan, refresh.afterStoryId, options.refreshBatchSize);
  const nextRefresh: RefreshCheckpoint = refreshStories.length === options.refreshBatchSize
    ? { schemaVersion: 1, afterStoryId: refreshStories.at(-1)!.id } : { schemaVersion: 1 };
  const cursorStart = cursorSnapshot({ [COLLECTION_CURSOR]: collectionRaw ?? null, [REFRESH_CURSOR]: refreshRaw ?? null });
  if (signal?.aborted) throw signal.reason;
  start(cursorStart);
  let publicIds: number[];
  let nextCollection: CollectionCheckpoint;
  let highestSeenItemId: number;
  if (collection === undefined) {
    if (signal?.aborted) throw signal.reason;
    const maximum = await options.api.maxItemId(signal);
    const feedIds = new Set<number>();
    for (const feed of options.feeds) {
      if (signal?.aborted) throw signal.reason;
      for (const id of await options.api.feed(feed, signal)) feedIds.add(id);
    }
    const firstLookback = options.initialLookbackItems === 0 ? undefined : Math.max(1, maximum - options.initialLookbackItems + 1);
    const selected = bootstrapSelection({ schemaVersion: 1, state: "bootstrap", targetMaxItemId: maximum, feedIds: [...feedIds].sort((a, b) => a - b),
      nextFeedIndex: 0, ...(firstLookback === undefined ? {} : { nextLookbackId: firstLookback }) }, options.maxItemsPerRun);
    publicIds = selected.ids; nextCollection = selected.next; highestSeenItemId = maximum;
  } else if (collection.state === "bootstrap") {
    const selected = bootstrapSelection(collection, options.maxItemsPerRun);
    publicIds = selected.ids; nextCollection = selected.next; highestSeenItemId = collection.targetMaxItemId;
  } else {
    if (signal?.aborted) throw signal.reason;
    const maximum = await options.api.maxItemId(signal);
    const selected = advanceSelection(collection.lastProcessedItemId, maximum, options.maxItemsPerRun);
    publicIds = selected.ids; nextCollection = selected.next; highestSeenItemId = selected.highest;
  }
  return {
    ids: [...new Set([...publicIds, ...refreshStories.map((story) => story.id)])].sort((a, b) => a - b),
    highestSeenItemId, nextCollection, nextRefresh,
    cursorStart,
    ...(collectionRaw === undefined ? {} : { collectionRaw }), ...(refreshRaw === undefined ? {} : { refreshRaw }),
  };
}
export function commitPublic(options: NormalizedOptions, context: RunContext, plan: PublicPlan, fetched: readonly FetchedItem[], completedAt: IsoDateTime): IngestionSummary {
  return options.store.transaction(() => {
    const stories: Story[] = [];
    const changed: Array<{ story: Story; previous?: Story }> = [];
    for (const candidate of fetched) {
      if (candidate.item === undefined) continue;
      const previous = options.store.stories.byId(candidate.id);
      const story = normalizeStory({ item: candidate.item as HnItem, observedAt: candidate.observedAt, ...(previous === undefined ? {} : { previous }) });
      if (story === undefined) continue;
      stories.push(story);
      if (previous === undefined || previous.contentVersion !== story.contentVersion) changed.push({ story, ...(previous === undefined ? {} : { previous }) });
    }
    if (stories.length > 0) options.store.stories.upsertBatch(stories);
    const profile = options.store.profiles.current();
    const projection = options.store.queue.projection();
    const rankVersion = projection?.rankVersion ?? options.bootstrapRank;
    const entries: QueueEntry[] = stories.map((story) => ({
      storyId: story.id, state: "unread", evaluationState: "pending",
      visibilityState: profile !== undefined && isBlacklisted(story, profile) ? "blacklisted" : "visible",
      kind: "match", rankVersion, queuedAt: story.lastSeenAt, updatedAt: story.lastSeenAt,
    }));
    if (entries.length > 0) options.store.queue.insertPendingIfMissing(entries);
    const collectionValue = encodeCollection(plan.nextCollection);
    const refreshValue = encodeRefresh(plan.nextRefresh);
    options.store.sync.setCursor(COLLECTION_CURSOR, collectionValue, completedAt);
    options.store.sync.setCursor(REFRESH_CURSOR, refreshValue, completedAt);
    let jobsEnqueued = 0;
    for (const { story } of changed) {
      if (handoff(options.jobs, { kind: "article.fetch-extract", payloadSchemaVersion: 1,
        payload: { storyId: story.id, storyContentVersion: story.contentVersion }, dedupeKey: `${story.id}:${story.contentVersion}`, runAfter: completedAt,
      }, context.operation, context.id).inserted) jobsEnqueued += 1;
    }
    if (changed.length > 0) {
      const input = profile === undefined
        ? { kind: "personalization.recover", payloadSchemaVersion: 1, payload: {}, dedupeKey: JSON.stringify(["personalization.recover"]), runAfter: completedAt }
        : { kind: "personalization.score-pending", payloadSchemaVersion: 1, payload: { profileId: profile.id }, dedupeKey: JSON.stringify(["personalization.score-pending", profile.id]), runAfter: completedAt };
      if (handoff(options.jobs, input, context.operation, context.id).inserted) jobsEnqueued += 1;
    }
    const cursorEnd = cursorSnapshot({ [COLLECTION_CURSOR]: collectionValue, [REFRESH_CURSOR]: refreshValue });
    options.store.sync.finishRun(completeRun(context, cursorEnd, completedAt, stories.length, fetched.length - stories.length));
    return { runId: context.id, highestSeenItemId: plan.highestSeenItemId, storiesUpserted: stories.length,
      nonStoriesSkipped: fetched.length - stories.length, jobsEnqueued };
  });
}
