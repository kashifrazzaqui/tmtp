import { createHash } from "node:crypto";
import { resolveArticleOriginalTarget } from "@tmtp/article-reader";
import type { EvaluationState, QueueEntry, Story } from "@tmtp/domain";
import { QUEUE_BOOTSTRAP_RANK_VERSION } from "@tmtp/queue";
import type { QueueCursorPosition } from "@tmtp/queue";
import type { ReaderStore } from "@tmtp/reader-store";
import { appError } from "./errors.js";
import { encodeReaderCursor } from "./queue-cursor.js";
import type { DecodedReaderCursor } from "./queue-cursor.js";
import type { NormalizedReaderAppOptions, ReaderQueueResult, ReaderQueueStory } from "./types.js";
import type { NormalizedQueueQuery } from "./validation.js";

interface ManifestRow {
  storyId: number;
  rankVersion: string;
  evaluationState: EvaluationState;
  rankPosition: number | null;
  visibilityState: "visible" | "blacklisted";
  state: QueueEntry["state"] | null;
}
interface Manifest {
  versions: string[];
  hash: string;
}

function discoverManifest(store: ReaderStore, maxPageSize: number, query: NormalizedQueueQuery): Manifest {
  const projection = store.queue.projection();
  const rows: ManifestRow[] = [];
  let afterStoryId: number | undefined;
  while (true) {
    const page = store.queue.forReprojection(afterStoryId, maxPageSize);
    for (const entry of page) {
      rows.push({
        storyId: entry.storyId,
        rankVersion: entry.rankVersion,
        evaluationState: entry.evaluationState,
        rankPosition: entry.rankPosition ?? null,
        visibilityState: entry.visibilityState,
        state: query.state === undefined ? null : entry.state,
      });
    }
    if (page.length < maxPageSize) break;
    afterStoryId = page.at(-1)!.storyId;
  }
  const activeRankVersion = projection?.rankVersion ?? null;
  const hash = createHash("sha256").update(JSON.stringify({ activeRankVersion, rows }), "utf8").digest("hex");
  const discovered = new Set(rows.map((row) => row.rankVersion));
  const nonBootstrap = [...discovered].filter((version) => version !== QUEUE_BOOTSTRAP_RANK_VERSION);
  nonBootstrap.sort((left, right) => {
    if (left === activeRankVersion && right !== activeRankVersion) return -1;
    if (right === activeRankVersion && left !== activeRankVersion) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (discovered.has(QUEUE_BOOTSTRAP_RANK_VERSION)) nonBootstrap.push(QUEUE_BOOTSTRAP_RANK_VERSION);
  return { versions: nonBootstrap, hash };
}

function afterFor(entry: QueueEntry): QueueCursorPosition {
  return {
    rankVersion: entry.rankVersion,
    evaluationState: entry.evaluationState,
    ...(entry.evaluationState === "scored" ? { rankPosition: entry.rankPosition! } : {}),
    storyId: entry.storyId,
  };
}

function detail(story: Story): ReaderQueueStory {
  const target = resolveArticleOriginalTarget(story);
  return {
    story,
    originalUrl: target.url,
    fallback: { kind: target.kind, observationQuality: "partial" },
  };
}

export function readQueue(
  options: NormalizedReaderAppOptions,
  query: NormalizedQueueQuery,
  decoded?: DecodedReaderCursor,
): ReaderQueueResult {
  return options.store.transaction(() => {
    const manifest = discoverManifest(options.store, options.queueMaxPageSize, query);
    if (decoded !== undefined && decoded.manifestHash !== manifest.hash) {
      throw appError("stale-queue-cursor", "get-queue", { field: "cursor", retryable: false });
    }
    const startVersion = decoded?.position.rankVersion;
    const startIndex = startVersion === undefined ? 0 : manifest.versions.indexOf(startVersion);
    if (startIndex < 0) throw appError("invalid-cursor", "get-queue", { field: "cursor", retryable: false });
    const candidates: QueueEntry[] = [];
    for (let groupIndex = startIndex; groupIndex < manifest.versions.length && candidates.length <= query.limit; groupIndex += 1) {
      const rankVersion = manifest.versions[groupIndex]!;
      let after = groupIndex === startIndex ? decoded?.position : undefined;
      while (candidates.length <= query.limit) {
        const remaining = query.limit + 1 - candidates.length;
        const readSize = Math.min(options.queueMaxPageSize, remaining);
        const chunk = options.store.queue.page({
          ...(query.state === undefined ? {} : { state: query.state }),
          ...(query.evaluationState === undefined ? {} : { evaluationState: query.evaluationState }),
          visibilityState: query.visibilityState,
          rankVersion,
          ...(after === undefined ? {} : { after }),
          limit: readSize,
        });
        const capacity = query.limit + 1 - candidates.length;
        candidates.push(...chunk.slice(0, capacity));
        if (chunk.length < readSize) break;
        after = afterFor(chunk.at(-1)!);
      }
    }
    const hasNext = candidates.length > query.limit;
    const entries = candidates.slice(0, query.limit);
    const stories = entries.length === 0 ? [] : options.store.stories.byStoryIds(entries.map((entry) => entry.storyId));
    const byId = new Map(stories.map((story) => [story.id, story]));
    const storyDetails = entries.map((entry) => {
      const story = byId.get(entry.storyId);
      if (story === undefined) {
        throw appError("dependency-failure", "get-queue", {
          retryable: false,
          dependency: "reader-store",
          dependencyCode: "missing-story",
          storyId: entry.storyId,
        });
      }
      return detail(story);
    });
    const counts = options.store.queue.countsByEvaluationState({ visibilityState: query.visibilityState });
    const evaluationCounts: Record<EvaluationState, number> = {
      pending: counts.pending ?? 0,
      scored: counts.scored ?? 0,
      failed: counts.failed ?? 0,
    };
    return {
      entries,
      storyDetails,
      ...(hasNext ? { nextCursor: encodeReaderCursor(query, manifest.hash, entries.at(-1)!) } : {}),
      evaluationCounts,
      rankVersions: [...manifest.versions],
    };
  });
}
