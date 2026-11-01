import { createHash } from "node:crypto";
import {
  InterestProfileSchema,
  IsoDateTimeSchema,
  PreferenceRuleSchema,
  StoredActivityEventSchema,
  StorySchema,
} from "@tmtp/domain";
import type {
  InterestEvidence,
  InterestProfile,
  IsoDateTime,
  PreferenceKind,
  PreferenceRule,
  StoredActivityEvent,
  Story,
  StoryId,
  WeightedInterest,
} from "@tmtp/domain";

export const INTERESTS_BUILDER_VERSION = "interests/1" as const;
export const INTERESTS_POLICY_SCHEMA_VERSION = 1 as const;

export interface ProfileBuild {
  rules: readonly PreferenceRule[];
  activity: readonly StoredActivityEvent[];
  stories: readonly Story[];
  rulesVersion: string;
  activityVersion: string;
  builtAt: IsoDateTime;
  reason: string;
}
export interface InterestPolicy {
  decayHalfLifeDays: number;
  maxInferredTopics: number;
  maxActivityEvents: number;
}
export type InterestErrorCode =
  | "invalid-input"
  | "invalid-rule"
  | "duplicate-rule"
  | "missing-story"
  | "activity-version-mismatch";

export class InterestError extends Error {
  override readonly name = "InterestError" as const;
  readonly field?: string;
  readonly storyId?: StoryId;
  constructor(readonly code: InterestErrorCode, message: string, details: { field?: string; storyId?: StoryId } = {}) {
    super(message);
    if (details.field !== undefined) this.field = details.field;
    if (details.storyId !== undefined) this.storyId = details.storyId;
  }
}

const STOP_WORDS = new Set(("a an and are as at be been but by for from has have how i in into is it its me my new not of on or our show so ask hn that the this to was we what when where which who why will with you your").split(" "));
const BASE_WEIGHTS: Record<string, number> = {
  impression: 0.01, open: 0.10, dwell: 0.20, scroll: 0.10, complete: 0.50,
  skip: -0.15, dismiss: -0.50, upvote: 0.80, flag: -0.80, favorite: 1.00,
};
const EXACT_BUILD_KEYS = ["rules", "activity", "stories", "rulesVersion", "activityVersion", "builtAt", "reason"];
const EXACT_POLICY_KEYS = ["decayHalfLifeDays", "maxInferredTopics", "maxActivityEvents"];
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const round12 = (value: number): number => {
  const rounded = Math.round(value * 1e12) / 1e12;
  return rounded === 0 ? 0 : rounded;
};
const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function invalidRule(): never {
  throw new InterestError("invalid-rule", "Preference rule is invalid.", { field: "value" });
}

function titleTokens(value: string): string[] {
  const normalized = value.normalize("NFKC").toLowerCase();
  return normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function normalizePreferenceValue(kind: PreferenceKind, value: string): string {
  if (typeof value !== "string") invalidRule();
  let normalized: string;
  if (kind === "topic" || kind === "keyword") {
    normalized = titleTokens(value).join(" ");
  } else if (kind === "author") {
    normalized = value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  } else if (kind === "domain") {
    const candidate = value.normalize("NFKC").toLowerCase().replace(/\.$/, "");
    if (candidate === "") invalidRule();
    let url: URL;
    try {
      url = new URL(`http://${candidate}`);
    } catch {
      invalidRule();
    }
    if (
      url.username !== "" || url.password !== "" || url.port !== "" || url.pathname !== "/" ||
      url.search !== "" || url.hash !== "" || url.hostname === ""
    ) invalidRule();
    normalized = url.hostname;
  } else {
    invalidRule();
  }
  if (normalized === "" || normalized.length > 128) invalidRule();
  return normalized;
}

function validateRules(rules: readonly PreferenceRule[]): PreferenceRule[] {
  if (!Array.isArray(rules)) throw new InterestError("invalid-input", "Profile rules are invalid.", { field: "rules" });
  const ids = new Set<string>();
  const triplets = new Set<string>();
  const clones: PreferenceRule[] = [];
  for (const rule of rules) {
    if (!PreferenceRuleSchema.safeParse(rule).success) invalidRule();
    let normalized: string;
    try {
      normalized = normalizePreferenceValue(rule.kind, rule.value);
    } catch {
      invalidRule();
    }
    if (normalized !== rule.normalizedValue) invalidRule();
    if (ids.has(rule.id) || triplets.has(`${rule.kind}\0${rule.effect}\0${rule.normalizedValue}`)) {
      throw new InterestError("duplicate-rule", "Duplicate preference rule.");
    }
    ids.add(rule.id);
    triplets.add(`${rule.kind}\0${rule.effect}\0${rule.normalizedValue}`);
    clones.push({ ...rule });
  }
  clones.sort((left, right) =>
    compare(left.kind, right.kind) || compare(left.effect, right.effect) ||
    compare(left.normalizedValue, right.normalizedValue) || compare(left.id, right.id)
  );
  return clones;
}

function containsPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  for (let start = 0; start <= tokens.length - phrase.length; start += 1) {
    if (phrase.every((token, index) => tokens[start + index] === token)) return true;
  }
  return false;
}

function storyHosts(story: Story): string[] {
  const hosts = new Set<string>();
  for (const candidate of [story.canonicalUrl, story.url]) {
    if (candidate === undefined) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      hosts.add(normalizePreferenceValue("domain", url.hostname));
    } catch {
      // One malformed URL contributes no host and does not hide the other source.
    }
  }
  return [...hosts].sort(compare);
}

function storyFeatures(story: Story, rules: readonly PreferenceRule[]): string[] {
  const features = new Set<string>();
  const tokens = titleTokens(story.title);
  for (const token of tokens) {
    if (!STOP_WORDS.has(token) && /\p{L}/u.test(token) && token.length <= 128) features.add(`topic:${token}`);
  }
  if (story.author !== undefined) {
    try {
      features.add(`author:${normalizePreferenceValue("author", story.author)}`);
    } catch {
      // Invalid authors contribute no feature.
    }
  }
  for (const host of storyHosts(story)) features.add(`domain:${host}`);
  for (const rule of rules) {
    if (rule.enabled && (rule.kind === "topic" || rule.kind === "keyword") && containsPhrase(tokens, rule.normalizedValue.split(" "))) {
      features.add(`${rule.kind}:${rule.normalizedValue}`);
    }
  }
  return [...features].sort(compare);
}

function validateBuild(input: ProfileBuild, policy: InterestPolicy): {
  rules: PreferenceRule[];
  activity: StoredActivityEvent[];
  stories: Map<number, Story>;
  policy: InterestPolicy;
} {
  if (!isObject(input) || !exactKeys(input, EXACT_BUILD_KEYS)) {
    throw new InterestError("invalid-input", "Profile build input is invalid.");
  }
  if (!isObject(policy) || !exactKeys(policy, EXACT_POLICY_KEYS)) {
    throw new InterestError("invalid-input", "Interest policy is invalid.", { field: "policy" });
  }
  if (
    typeof input.rulesVersion !== "string" || input.rulesVersion === "" ||
    typeof input.activityVersion !== "string" || input.activityVersion === "" ||
    typeof input.reason !== "string" || input.reason === "" || !IsoDateTimeSchema.safeParse(input.builtAt).success
  ) throw new InterestError("invalid-input", "Profile build metadata is invalid.");
  if (
    typeof policy.decayHalfLifeDays !== "number" || !Number.isFinite(policy.decayHalfLifeDays) || policy.decayHalfLifeDays <= 0 ||
    !Number.isSafeInteger(policy.maxInferredTopics) || policy.maxInferredTopics < 0 ||
    !Number.isSafeInteger(policy.maxActivityEvents) || policy.maxActivityEvents < 0
  ) throw new InterestError("invalid-input", "Interest policy is invalid.", { field: "policy" });

  const rules = validateRules(input.rules);
  if (!Array.isArray(input.activity) || !Array.isArray(input.stories)) {
    throw new InterestError("invalid-input", "Profile collections are invalid.");
  }
  const activityIds = new Set<string>();
  const sequences = new Set<number>();
  const activity: StoredActivityEvent[] = [];
  for (const event of input.activity) {
    if (!StoredActivityEventSchema.safeParse(event).success || activityIds.has(event.id) || sequences.has(event.sequence)) {
      throw new InterestError("invalid-input", "Stored activity input is invalid.", { field: "activity" });
    }
    activityIds.add(event.id);
    sequences.add(event.sequence);
    activity.push({ ...event, ...(event.value === undefined ? {} : { value: { ...event.value } }) });
  }
  activity.sort((left, right) => left.sequence - right.sequence);

  const stories = new Map<number, Story>();
  for (const story of input.stories) {
    if (!StorySchema.safeParse(story).success || stories.has(story.id)) {
      throw new InterestError("invalid-input", "Story input is invalid.", { field: "stories" });
    }
    stories.set(story.id, {
      ...story,
      raw: { ...story.raw, raw: { ...story.raw.raw } },
    });
  }
  return {
    rules,
    activity,
    stories,
    policy: {
      decayHalfLifeDays: policy.decayHalfLifeDays,
      maxInferredTopics: policy.maxInferredTopics === 0 ? 0 : policy.maxInferredTopics,
      maxActivityEvents: policy.maxActivityEvents === 0 ? 0 : policy.maxActivityEvents,
    },
  };
}

export function buildInterestProfile(input: ProfileBuild, policy: InterestPolicy): InterestProfile {
  const valid = validateBuild(input, policy);
  if (valid.activity.length === 0) {
    if (input.activityVersion !== "0" && valid.policy.maxActivityEvents !== 0) {
      throw new InterestError("activity-version-mismatch", "Activity version does not match the supplied log.");
    }
  } else if (String(valid.activity.at(-1)!.sequence) !== input.activityVersion) {
    throw new InterestError("activity-version-mismatch", "Activity version does not match the supplied log.");
  }
  const selected = valid.policy.maxActivityEvents === 0
    ? []
    : valid.activity.slice(-valid.policy.maxActivityEvents);
  const builtMs = Date.parse(input.builtAt);
  const evidence = new Map<string, Map<string, InterestEvidence>>();
  const featureCache = new Map<number, string[]>();

  for (const event of selected) {
    const story = valid.stories.get(event.storyId);
    if (story === undefined) {
      throw new InterestError("missing-story", "Activity references a missing story.", { storyId: event.storyId });
    }
    let features = featureCache.get(story.id);
    if (features === undefined) {
      features = storyFeatures(story, valid.rules);
      featureCache.set(story.id, features);
    }
    const ageMs = Math.max(0, builtMs - Date.parse(event.occurredAt));
    const decay = 2 ** (-(ageMs / 86_400_000) / valid.policy.decayHalfLifeDays);
    const quality = event.observationQuality === "partial" && !["upvote", "flag", "favorite"].includes(event.kind) ? 0.5 : 1;
    const contribution = round12(BASE_WEIGHTS[event.kind]! * quality * decay);
    for (const key of features) {
      let byKind = evidence.get(key);
      if (byKind === undefined) {
        byKind = new Map();
        evidence.set(key, byKind);
      }
      const current = byKind.get(event.kind) ?? { kind: event.kind, count: 0, weight: 0 } as InterestEvidence;
      byKind.set(event.kind, {
        kind: event.kind,
        count: current.count + 1,
        weight: current.weight + contribution,
      });
    }
  }

  const included = new Set<string>();
  const excluded = new Set<string>();
  for (const rule of valid.rules) {
    if (!rule.enabled) continue;
    const key = `${rule.kind}:${rule.normalizedValue}`;
    if (rule.effect === "include") included.add(key);
    else excluded.add(key);
  }
  for (const key of included) {
    if (excluded.has(key)) continue;
    const byKind = evidence.get(key) ?? new Map<string, InterestEvidence>();
    byKind.set("explicit-rule", { kind: "explicit-rule", count: 1, weight: 1 });
    evidence.set(key, byKind);
  }
  for (const key of excluded) evidence.delete(key);

  const candidates: Array<{ key: string; raw: number }> = [];
  for (const [key, byKind] of evidence) {
    if (included.has(key)) continue;
    const raw = round12([...byKind.values()].reduce((sum, item) => sum + round12(item.weight), 0));
    if (raw > 0) candidates.push({ key, raw });
  }
  candidates.sort((left, right) => right.raw - left.raw || compare(left.key, right.key));
  const largest = candidates[0]?.raw;
  const retained = new Map(candidates.slice(0, valid.policy.maxInferredTopics).map((candidate) => [candidate.key, candidate.raw]));
  const interests: WeightedInterest[] = [];
  for (const [key, byKind] of evidence) {
    const explicit = included.has(key);
    const raw = retained.get(key);
    if (!explicit && raw === undefined) continue;
    const items = [...byKind.values()].map((item) => ({ ...item, weight: round12(item.weight) })).sort((left, right) => compare(left.kind, right.kind));
    interests.push({
      topic: key,
      weight: explicit ? 1 : round12(raw! / largest!),
      evidence: items,
    });
  }
  interests.sort((left, right) => right.weight - left.weight || compare(left.topic, right.topic));

  const policySnapshot = {
    decayHalfLifeDays: valid.policy.decayHalfLifeDays,
    maxInferredTopics: valid.policy.maxInferredTopics,
    maxActivityEvents: valid.policy.maxActivityEvents,
  };
  const policyVersion = `ip1.${hash(JSON.stringify(policySnapshot))}`;
  const id = `profile_${hash(JSON.stringify({
    rulesVersion: input.rulesVersion,
    activityVersion: input.activityVersion,
    policyVersion,
    builderVersion: INTERESTS_BUILDER_VERSION,
  }))}`;
  return {
    id,
    rulesVersion: input.rulesVersion,
    activityVersion: input.activityVersion,
    sourceRules: valid.rules.map((rule) => ({ ...rule })),
    sourceRulesSchemaVersion: 1,
    policy: policySnapshot,
    policySchemaVersion: INTERESTS_POLICY_SCHEMA_VERSION,
    policyVersion,
    builderVersion: INTERESTS_BUILDER_VERSION,
    interests,
    reason: input.reason,
    createdAt: input.builtAt,
  };
}

export function isBlacklisted(story: Story, profile: InterestProfile): boolean {
  if (!StorySchema.safeParse(story).success || !InterestProfileSchema.safeParse(profile).success) {
    throw new InterestError("invalid-input", "Blacklist input is invalid.");
  }
  const rules = validateRules(profile.sourceRules);
  const tokens = titleTokens(story.title);
  let author: string | undefined;
  if (story.author !== undefined) {
    try {
      author = normalizePreferenceValue("author", story.author);
    } catch {
      author = undefined;
    }
  }
  const hosts = storyHosts(story);
  for (const rule of rules) {
    if (!rule.enabled || rule.effect !== "exclude") continue;
    if ((rule.kind === "topic" || rule.kind === "keyword") && containsPhrase(tokens, rule.normalizedValue.split(" "))) return true;
    if (rule.kind === "author" && author === rule.normalizedValue) return true;
    if (rule.kind === "domain" && hosts.some((host) => host === rule.normalizedValue || host.endsWith(`.${rule.normalizedValue}`))) return true;
  }
  return false;
}
