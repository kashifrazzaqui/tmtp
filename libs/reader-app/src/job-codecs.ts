import { parseActivityBatch } from "@tmtp/activity";
import { StoryIdSchema } from "@tmtp/domain";
import { hnIngestionJobCodecs } from "@tmtp/hn-ingestion";
import type { JobPayloadCodec } from "@tmtp/job-queue";
import { personalizationJobCodecs } from "@tmtp/personalization";
import { exactKeys, plainObject } from "./validation.js";
import type { ArticleFetchExtractJobPayload, RecordActivityJobPayload } from "./types.js";

export const READER_APP_JOB_PAYLOAD_SCHEMA_VERSION = 1 as const;

function invalidPayload(): never { throw new TypeError("Invalid reader application job payload."); }
function decodeArticle(payload: unknown, sourceVersion: number): ArticleFetchExtractJobPayload {
  if (sourceVersion !== READER_APP_JOB_PAYLOAD_SCHEMA_VERSION || !plainObject(payload) ||
    !exactKeys(payload, ["storyId", "storyContentVersion"]) || !StoryIdSchema.safeParse(payload.storyId).success ||
    typeof payload.storyContentVersion !== "string" || payload.storyContentVersion.length === 0 || payload.storyContentVersion.length > 256) invalidPayload();
  return { storyId: payload.storyId as number, storyContentVersion: payload.storyContentVersion };
}
function decodeActivity(payload: unknown, sourceVersion: number): RecordActivityJobPayload {
  if (sourceVersion !== READER_APP_JOB_PAYLOAD_SCHEMA_VERSION || !plainObject(payload) || !exactKeys(payload, ["batch"]) ||
    !Array.isArray(payload.batch) || payload.batch.length !== 1 || !Object.hasOwn(payload.batch, 0)) invalidPayload();
  try {
    return { batch: parseActivityBatch(payload.batch) };
  } catch {
    invalidPayload();
  }
}

const articleCodec: JobPayloadCodec = {
  kind: "article.fetch-extract",
  currentVersion: READER_APP_JOB_PAYLOAD_SCHEMA_VERSION,
  decode: decodeArticle,
};
const activityCodec: JobPayloadCodec = {
  kind: "personalization.record-activity",
  currentVersion: READER_APP_JOB_PAYLOAD_SCHEMA_VERSION,
  decode: decodeActivity,
};

export const readerAppJobCodecs: readonly JobPayloadCodec[] = [
  articleCodec,
  activityCodec,
  ...hnIngestionJobCodecs,
  ...personalizationJobCodecs,
];

export function decodeJobPayload(kind: string, payload: unknown, version: number): unknown {
  const codec = readerAppJobCodecs.find((candidate) => candidate.kind === kind);
  if (codec === undefined || codec.currentVersion !== version) invalidPayload();
  return codec.decode(payload, version);
}
