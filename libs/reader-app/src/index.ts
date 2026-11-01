import { QUEUE_BOOTSTRAP_RANK_VERSION } from "@tmtp/queue";

export { ReaderAppError } from "./errors.js";
export { createApplication as createReaderApp } from "./app.js";
export { READER_APP_JOB_PAYLOAD_SCHEMA_VERSION, readerAppJobCodecs } from "./job-codecs.js";
export { jobFailure as readerAppJobFailure } from "./app.js";

export function readerAppBootstrapRankVersion(): "qb1.initial" {
  return QUEUE_BOOTSTRAP_RANK_VERSION;
}

export type {
  ReaderAppJobKind,
  ArticleFetchExtractJobPayload,
  RecordActivityJobPayload,
  ReaderQueueQuery,
  ReaderQueueResult,
  StoryFallback,
  ReaderQueueStory,
  StoryDetail,
  RecommendationHistoryQuery,
  HnActionHistoryQuery,
  ActivityHistoryQuery,
  ActivityHistory,
  HnActionCommand,
  ReaderAppOperation,
  ReaderAppDependency,
  ReaderAppErrorCode,
  ReaderApp,
  ReaderAppOptions,
} from "./types.js";
