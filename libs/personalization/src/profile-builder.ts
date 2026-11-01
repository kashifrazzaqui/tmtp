import { buildInterestProfile } from "@tmtp/interests";
import type { InterestProfile, Story } from "@tmtp/domain";
import { profileTimestamp, wallNow } from "./time.js";
import type { PersonalizationOptions } from "./types.js";

export interface BuiltProfile {
  profile: InterestProfile;
  previous: InterestProfile | undefined;
  changed: boolean;
  builtAt: string;
}

export function buildCurrentProfile(options: PersonalizationOptions, reason: string): BuiltProfile {
  const previous = options.store.profiles.current();
  const rules = options.store.preferences.list();
  const rulesVersion = options.store.preferences.currentVersion();
  const activity = options.store.activity.latestWindow(options.interestPolicy.maxActivityEvents);
  const activityVersion = options.store.activity.latestVersion();
  const storyIds = new Set<number>();
  const stories: Story[] = [];
  for (const event of activity) {
    if (storyIds.has(event.storyId)) continue;
    storyIds.add(event.storyId);
    const story = options.store.stories.byId(event.storyId);
    if (story !== undefined) stories.push(story);
  }
  const builtAt = profileTimestamp(wallNow(options.clock), previous?.createdAt);
  const candidate = buildInterestProfile({ rules, activity, stories, rulesVersion, activityVersion, builtAt, reason }, options.interestPolicy);
  const existing = options.store.profiles.byVersion({
    rulesVersion: candidate.rulesVersion,
    activityVersion: candidate.activityVersion,
    policyVersion: candidate.policyVersion,
    builderVersion: candidate.builderVersion,
  });
  if (existing === undefined) options.store.profiles.insert(candidate);
  const selected = existing ?? candidate;
  const profile = options.store.profiles.setCurrent(selected.id, builtAt);
  return { profile, previous, changed: previous?.id !== profile.id, builtAt };
}
