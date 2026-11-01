import { reduceActivity } from "@tmtp/activity";
import type { RawActivity } from "@tmtp/activity";
import type { StoredActivityEvent } from "@tmtp/domain";
import { PersonalizationError } from "./errors.js";
import { createPersonalizationJobEnqueue } from "./jobs.js";
import type { PersonalizationOptions, RecordActivityResult } from "./types.js";

export function recordActivity(options: PersonalizationOptions, batch: readonly RawActivity[]): RecordActivityResult {
  const parsed = batch;
  if (parsed.length === 0) return { accepted: 0, profileWorkEnqueued: false };
  return options.store.transaction((): RecordActivityResult => {
    const replay: StoredActivityEvent[] = [];
    const queried = new Set<string>();
    for (const activity of parsed) {
      if (queried.has(activity.clientEventId)) continue;
      queried.add(activity.clientEventId);
      replay.push(...options.store.activity.query({ clientEventId: activity.clientEventId, limit: 1 }));
    }
    const previous = options.store.readingSessions.latestForStory(parsed[0]!.storyId);
    const reduction = reduceActivity(parsed, previous, options.activityPolicy, options.clock, replay);
    const appended = options.store.activity.appendIdempotent(reduction.events);
    if (appended !== reduction.events.length) throw new PersonalizationError("activity-append-incomplete");
    for (const session of reduction.sessions) options.store.readingSessions.upsert(session);
    let inserted = false;
    if (reduction.events.length > 0) {
      const activityVersion = options.store.activity.latestVersion();
      const rulesVersion = options.store.preferences.currentVersion();
      inserted = options.jobs.enqueue(createPersonalizationJobEnqueue({
        kind: "personalization.profile-rebuild",
        payload: { reason: "activity", rulesVersion, activityVersion },
        runAfter: reduction.events[0]!.receivedAt,
      })).inserted;
    }
    return { accepted: reduction.events.length, profileWorkEnqueued: inserted };
  });
}
