import type { Database } from "@tmtp/database";
import type { ReaderStore } from "./types.js";
import { createActivityRepository, createReadingSessionRepository } from "./activity.js";
import { createHnAccountStateRepository, createHnActionRepository } from "./hn.js";
import { createAccessSessionRepository, createDiagnosticErrorRepository, createLlmCallRepository, createSyncRepository } from "./operations.js";
import { createPreferenceRepository, createProfileRepository, createRecommendationRepository } from "./personalization.js";
import { createQueueRepository } from "./queue.js";
import { createArticleRepository, createStoryRepository } from "./story.js";

export function createReaderStore(database: Database): ReaderStore {
  return {
    stories: createStoryRepository(database),
    articles: createArticleRepository(database),
    activity: createActivityRepository(database),
    readingSessions: createReadingSessionRepository(database),
    preferences: createPreferenceRepository(database),
    profiles: createProfileRepository(database),
    recommendations: createRecommendationRepository(database),
    queue: createQueueRepository(database),
    sync: createSyncRepository(database),
    llmCalls: createLlmCallRepository(database),
    diagnostics: createDiagnosticErrorRepository(database),
    accessSessions: createAccessSessionRepository(database),
    hnActions: createHnActionRepository(database),
    hnAccountStates: createHnAccountStateRepository(database),
    transaction<T>(work: () => T): T { return database.transaction(work); },
  };
}

export { readerStoreMigrations } from "./migrations.js";
export { ReaderStoreError } from "./error.js";
export type { ReaderStoreErrorCode } from "./error.js";
export type * from "./types.js";
