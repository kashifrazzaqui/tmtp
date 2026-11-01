import type { Article, InterestProfile, Story } from "@tmtp/domain";
import { RECOMMENDATION_INPUT_SCHEMA_VERSION, RECOMMENDATION_PROMPT_VERSION } from "./constants.js";

export interface ProjectedRule { id: string; kind: string; effect: string; normalizedValue: string; enabled: true; }
export interface ProjectedEvidence { kind: string; count: number; weight: number; }
export interface ProjectedInterest { topic: string; weight: number; evidence: ProjectedEvidence[]; }
export interface ProjectedProfile {
  id: string; rulesVersion: string; activityVersion: string; policyVersion: string; builderVersion: string;
  sourceRules: ProjectedRule[]; interests: ProjectedInterest[];
}
export interface ProjectedArticle {
  status: "pending" | "ready" | "failed"; title: string | null; byline: string | null; excerpt: string | null;
  textContent: string | null; textContentTruncated: boolean; contentHash: string | null; extractorVersion: string | null;
}
export interface ProjectedStory {
  storyId: number; contentVersion: string; title: string; author: string | null; url: string | null; canonicalUrl: string | null;
  textHtml: string | null; textHtmlTruncated: boolean; publishedAt: string; deleted: boolean; dead: boolean; article: ProjectedArticle | null;
}
export interface RecommendationInput {
  schemaVersion: 1; promptVersion: typeof RECOMMENDATION_PROMPT_VERSION; profile: ProjectedProfile; stories: ProjectedStory[];
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function truncate(value: string | undefined, maximum: number): { value: string | null; truncated: boolean } {
  if (value === undefined) return { value: null, truncated: false };
  const points = Array.from(value);
  if (points.length <= maximum) return { value, truncated: false };
  return { value: points.slice(0, maximum).join("") + "\n[truncated]", truncated: true };
}
export function projectProfile(profile: InterestProfile): ProjectedProfile {
  const sourceRules = profile.sourceRules.filter((rule) => rule.enabled).map((rule) => ({
    id: rule.id, kind: rule.kind, effect: rule.effect, normalizedValue: rule.normalizedValue, enabled: true as const,
  })).sort((a, b) => compare(a.kind, b.kind) || compare(a.effect, b.effect) || compare(a.normalizedValue, b.normalizedValue) || compare(a.id, b.id));
  const interests = profile.interests.map((interest) => ({
    topic: interest.topic, weight: interest.weight,
    evidence: interest.evidence.map((entry) => ({ kind: entry.kind, count: entry.count, weight: entry.weight }))
      .sort((a, b) => compare(a.kind, b.kind) || a.count - b.count || a.weight - b.weight),
  })).sort((a, b) => b.weight - a.weight || compare(a.topic, b.topic) || compare(JSON.stringify(a.evidence), JSON.stringify(b.evidence)));
  return {
    id: profile.id, rulesVersion: profile.rulesVersion, activityVersion: profile.activityVersion,
    policyVersion: profile.policyVersion, builderVersion: profile.builderVersion, sourceRules, interests,
  };
}
export function projectStory(story: Story, article: Article | undefined): ProjectedStory {
  const text = truncate(story.textHtml, 4_000);
  let projectedArticle: ProjectedArticle | null = null;
  if (article !== undefined) {
    if (article.status !== "ready") {
      projectedArticle = {
        status: article.status, title: null, byline: null, excerpt: null, textContent: null,
        textContentTruncated: false, contentHash: null, extractorVersion: null,
      };
    } else {
      const content = truncate(article.textContent, 24_000);
      projectedArticle = {
        status: "ready", title: article.title ?? null, byline: article.byline ?? null, excerpt: article.excerpt ?? null,
        textContent: content.value, textContentTruncated: content.truncated,
        contentHash: article.contentHash ?? null, extractorVersion: article.extractorVersion ?? null,
      };
    }
  }
  return {
    storyId: story.id, contentVersion: story.contentVersion, title: story.title, author: story.author ?? null,
    url: story.url ?? null, canonicalUrl: story.canonicalUrl ?? null, textHtml: text.value, textHtmlTruncated: text.truncated,
    publishedAt: story.publishedAt, deleted: story.deleted, dead: story.dead, article: projectedArticle,
  };
}
export function projectInput(profile: ProjectedProfile, stories: readonly ProjectedStory[]): RecommendationInput {
  return { schemaVersion: RECOMMENDATION_INPUT_SCHEMA_VERSION, promptVersion: RECOMMENDATION_PROMPT_VERSION, profile, stories: [...stories] };
}
