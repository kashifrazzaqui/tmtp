import { afterEach, describe, expect, it, vi } from "vitest";
import type { HnAccount } from "@tmtp/hn-account";
import type { InterestProfile, Recommendation } from "@tmtp/domain";
import { runCapabilityProbes } from "../src/probes.js";
import { fakeProvider, httpHarness, login, mutationHeaders, NOW, readJson, testGraph } from "./harness.js";
import type { HttpHarness, TestGraph } from "./harness.js";
import { queueFixture, readyArticleFixture, seedStory } from "./fixtures.js";

const active: Array<{ close(): Promise<void> }> = [];
async function http(overrides: Record<string, unknown> = {}, seams?: Parameters<typeof httpHarness>[1]): Promise<HttpHarness> {
  const value = await httpHarness(overrides, seams);
  active.push(value);
  return value;
}
async function graph(overrides: Record<string, unknown> = {}): Promise<TestGraph> {
  const value = await testGraph(overrides);
  active.push(value);
  return value;
}

afterEach(async () => {
  while (active.length > 0) await active.pop()!.close();
  vi.restoreAllMocks();
});

function mutation(session: Awaited<ReturnType<typeof login>>, origin: string, body?: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      ...mutationHeaders(session, origin),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function scoreStory(local: TestGraph, storyId: number): void {
  const profile: InterestProfile = {
    id: "profile-1",
    rulesVersion: "rules-1",
    activityVersion: "activity-1",
    sourceRules: [],
    sourceRulesSchemaVersion: 1,
    policy: { version: "policy-1" },
    policySchemaVersion: 1,
    policyVersion: "policy-1",
    builderVersion: "builder-1",
    interests: [],
    reason: "test profile",
    createdAt: NOW.toISOString(),
  };
  const recommendation: Recommendation = {
    id: "recommendation-1",
    storyId,
    profileId: profile.id,
    storyContentVersion: "story-version",
    articleContentVersion: "article-version",
    promptVersion: "prompt-1",
    model: "test-model",
    score: 0.91,
    rationale: "Relevant to the reader’s stated interest.",
    evidence: [{ kind: "explicit-rule", label: "TypeScript", value: 0.8, sourceId: "rule-1" }],
    evidenceSchemaVersion: 1,
    createdAt: NOW.toISOString(),
  };
  local.graph.store.transaction(() => {
    local.graph.store.profiles.insert(profile);
    local.graph.store.profiles.setCurrent(profile.id, NOW.toISOString());
    local.graph.store.recommendations.insertImmutable([recommendation]);
    local.graph.store.queue.upsertRankingPreservingState([{
      ...queueFixture(storyId),
      evaluationState: "scored",
      recommendationId: recommendation.id,
      rankScore: recommendation.score,
      rankPosition: 1,
      lastError: "stored-error-sentinel",
    }]);
  });
}

describe("WF-01 install and connect", () => {
  it("should pass local-only probes, persist connection audits, and keep payloads uncaptured", async () => {
    const provider = await fakeProvider();
    active.push(provider);
    const local = await graph({
      hn: { api_base_url: `${provider.origin}/v0` },
      llm: { base_url: `${provider.origin}/v1`, max_retries: 0 },
      http: { retry: { max_attempts: 1 } },
      debug: { enabled: true, include_llm_payloads: true },
    });
    const results = await runCapabilityProbes(local.graph, local.graph.operations.signal);
    expect(results).toEqual({ llm: true, hnPublic: true, article: "not-checked" });
    expect(provider.journal.some((entry) => entry.url === "/v0/maxitem.json")).toBe(true);
    expect(provider.journal.some((entry) => entry.url === "/v1/chat/completions")).toBe(true);
    const snapshot = local.graph.diagnostics.debugSnapshot();
    expect(snapshot.llmCalls.value.items).toHaveLength(1);
    expect(snapshot.llmCalls.value.items[0]).toMatchObject({ purpose: "connection-check", status: "success", requestPayload: { state: "not-captured" } });
    expect(JSON.stringify(snapshot)).not.toContain("test-llm-key-sentinel");
    local.graph.health.workersReady();
    const capabilities = local.graph.diagnostics.capabilities(local.graph.integrations.input(local.graph.health.readiness(local.graph.database)));
    expect(capabilities).toMatchObject({ storedReading: { state: "available" }, llmPersonalization: { state: "available" }, hnPublicCollection: { state: "available" } });
  });

  it("should degrade integrations independently without removing stored-reading capability", async () => {
    const provider = await fakeProvider();
    active.push(provider);
    provider.llmStatus = 500;
    provider.hnStatus = 503;
    const local = await graph({
      hn: { api_base_url: `${provider.origin}/v0` },
      llm: { base_url: `${provider.origin}/v1`, max_retries: 0 },
      http: { retry: { max_attempts: 1, base_delay_ms: 0, max_delay_ms: 0 } },
    });
    const results = await runCapabilityProbes(local.graph, local.graph.operations.signal);
    expect(results).toMatchObject({ llm: false, hnPublic: false });
    local.graph.health.workersReady();
    const capabilities = local.graph.diagnostics.capabilities(local.graph.integrations.input(local.graph.health.readiness(local.graph.database)));
    expect(capabilities).toMatchObject({
      storedReading: { state: "available" },
      llmPersonalization: { state: "degraded" },
      hnPublicCollection: { state: "degraded" },
      freshArticleContent: { state: "unknown", reason: "not-checked" },
    });
    expect(JSON.stringify(capabilities)).not.toContain("safe local failure");
  });

  it("should contain malformed LLM error evidence and distinguish audit persistence failures", async () => {
    const malformed = await testGraph({ debug: { enabled: true } }, {
      llm: { generate: async () => { throw { category: "provider", code: "provider-error", attempts: [{ hidden: "audit" }] }; } },
    });
    active.push(malformed);
    await expect(runCapabilityProbes(malformed.graph, malformed.graph.operations.signal)).resolves.toMatchObject({ llm: false });
    expect(malformed.graph.diagnostics.debugSnapshot().llmCalls.value.items).toEqual([]);
    expect(malformed.graph.diagnostics.capabilities(malformed.graph.integrations.input(malformed.graph.health.readiness()))).toMatchObject({
      llmPersonalization: { state: "degraded", reason: "invalid-response" },
    });

    const local = await graph();
    vi.spyOn(local.graph.llm, "generate").mockResolvedValue({ value: { ok: true }, attempts: [] });
    vi.spyOn(local.graph.personalization, "persistLlmAudits").mockRejectedValue(new Error("sqlite-sentinel"));
    await expect(runCapabilityProbes(local.graph, local.graph.operations.signal)).resolves.toMatchObject({ llm: false });
    expect(local.graph.health.readiness().sqlite).toEqual({ ready: false, reason: "database-unavailable" });
    expect(local.graph.diagnostics.capabilities(local.graph.integrations.input(local.graph.health.readiness()))).toMatchObject({
      llmPersonalization: { state: "unknown", reason: "not-checked" },
    });
  });
});

describe("WF-02 continuous collection", () => {
  it("should collect through the public operation idempotently and preserve pending work", async () => {
    const provider = await fakeProvider();
    active.push(provider);
    const local = await http({
      hn: { api_base_url: `${provider.origin}/v0` },
      ingestion: { feeds: ["top"] },
      http: { retry: { max_attempts: 1 } },
    });
    const session = await login(local.origin);
    for (const expectedUpserts of [1, 0]) {
      const response = await fetch(`${local.origin}/api/v1/operations/ingestion?mode=run`, mutation(session, local.origin));
      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({ storiesUpserted: expectedUpserts, highestSeenItemId: 100 });
    }
    const queue = await fetch(`${local.origin}/api/v1/queue`, { headers: { cookie: session.cookie } });
    const body = await readJson(queue) as { items: Array<{ story: { id: number }; entry: { evaluationState: string } }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ story: { id: 100 }, entry: { evaluationState: "pending" } });
    expect(local.graph.store.sync.cursor("hn.public.collection")).toBeDefined();
    expect(local.graph.jobs.list({ limit: 20 }).filter((job) => job.kind === "article.fetch-extract")).toHaveLength(1);
  });
});

describe("WF-03 complete personalized queue", () => {
  it("should page mixed evaluation states without caps or unsafe stored fields", async () => {
    const local = await http({ queue: { page_size: 2, max_page_size: 3 } });
    seedStory(local.graph, 1, "Scored story");
    seedStory(local.graph, 2, "Failed story");
    seedStory(local.graph, 3, "Pending story");
    scoreStory(local, 1);
    local.graph.store.queue.markEvaluation({
      storyId: 2, evaluationState: "failed", rankVersion: "qb1.initial", lastError: "stored-error-sentinel", at: NOW.toISOString(),
    });
    const session = await login(local.origin);
    const first = await (await fetch(`${local.origin}/api/v1/queue?limit=2`, { headers: { cookie: session.cookie } })).json() as {
      items: Array<{ entry: { storyId: number } }>; nextCursor?: string;
    };
    expect(first.nextCursor).toBeDefined();
    const second = await (await fetch(`${local.origin}/api/v1/queue?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`, { headers: { cookie: session.cookie } })).json() as {
      items: Array<{ entry: { storyId: number } }>;
    };
    const ids = [...first.items, ...second.items].map((item) => item.entry.storyId);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toHaveLength(3);
    const serialized = JSON.stringify([first, second]);
    expect(serialized).not.toContain("stored-error-sentinel");
    expect(serialized).not.toContain("raw-envelope-must-not-escape");
    const detail = await fetch(`${local.origin}/api/v1/stories/1`, { headers: { cookie: session.cookie } });
    expect(await readJson(detail)).toMatchObject({
      story: { id: 1 },
      recommendation: { id: "recommendation-1", profileId: "profile-1", promptVersion: "prompt-1", model: "test-model" },
      queueEntry: { evaluationState: "scored" },
    });
  });
});

describe("WF-04 cached reading and natural activity", () => {
  it("should expose only sanitized cached content and append activity idempotently", async () => {
    const local = await http();
    const story = seedStory(local.graph, 1);
    local.graph.store.articles.upsert(readyArticleFixture(story));
    const session = await login(local.origin);
    const detailResponse = await fetch(`${local.origin}/api/v1/stories/1`, { headers: { cookie: session.cookie } });
    const detail = await readJson(detailResponse) as Record<string, unknown>;
    expect(detail).toMatchObject({ article: { status: "ready", sanitizedHtml: expect.stringContaining("Safe article") }, originalUrl: story.url });
    expect(JSON.stringify(detail)).not.toContain("raw HN text");
    expect(JSON.stringify(detail)).not.toContain("raw text must not escape");
    expect(JSON.stringify(detail)).not.toContain("sourceUrl");
    expect(JSON.stringify(detail)).not.toContain("errorMessage");

    const activity = {
      batch: [{ clientEventId: "a".repeat(43), storyId: 1, kind: "open", occurredAt: NOW.toISOString(), source: "embedded-reader" }],
    };
    const first = await fetch(`${local.origin}/api/v1/activity/batches`, mutation(session, local.origin, activity));
    const second = await fetch(`${local.origin}/api/v1/activity/batches`, mutation(session, local.origin, activity));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await readJson(first)).toMatchObject({ accepted: 1 });
    expect(await readJson(second)).toMatchObject({ accepted: 0 });
    const history = await fetch(`${local.origin}/api/v1/activity?clientEventId=${"a".repeat(43)}`, { headers: { cookie: session.cookie } });
    const historyBody = await readJson(history) as { events: unknown[]; sessions: Array<{ lastClientEventId: string; observationQuality: string }> };
    expect(historyBody.events).toHaveLength(1);
    expect(historyBody.sessions).toHaveLength(1);
    expect(historyBody.sessions[0]).toMatchObject({ lastClientEventId: "a".repeat(43), observationQuality: "full" });
  });

  it("should keep an original-page fallback readable when article extraction failed", async () => {
    const local = await http();
    seedStory(local.graph, 2);
    const session = await login(local.origin);
    const response = await fetch(`${local.origin}/api/v1/stories/2`, { headers: { cookie: session.cookie } });
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      story: { id: 2 },
      originalUrl: "https://example.test/articles/2",
      fallback: { kind: "original-page", observationQuality: "partial" },
    });
  });
});

describe("WF-05 explicit HN action", () => {
  it("should return an indeterminate command outcome as HTTP 200 and safe history", async () => {
    const account: HnAccount = {
      capabilities: async () => [
        { name: "upvoted", state: "available" },
        { name: "favorites", state: "available" },
        { name: "flagged", state: "unavailable", reason: "capability-disabled" },
        { name: "mutations", state: "available" },
      ],
      validateSession: async () => ({ username: "reader" }),
      readUpvoted: async () => ({ observations: [] }),
      readFavorites: async () => ({ observations: [] }),
      readFlagged: async () => ({ observations: [] }),
      performAction: async (intent) => ({
        intentId: intent.id, status: "indeterminate", observedAt: NOW.toISOString(), errorCode: "post-outcome-unknown",
      }),
    };
    const local = await http({}, { account, accountCookie: "local-hn-cookie" });
    seedStory(local.graph, 1);
    const session = await login(local.origin);
    const response = await fetch(`${local.origin}/api/v1/hn/actions`, mutation(session, local.origin, {
      storyId: 1, action: "upvote", idempotencyKey: "explicit-user-action-1",
    }));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ status: "indeterminate", errorCode: "post-outcome-unknown" });
    const history = await fetch(`${local.origin}/api/v1/stories/1/hn-actions`, { headers: { cookie: session.cookie } });
    const body = await readJson(history) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ storyId: 1, action: "upvote", status: "indeterminate", outcome: { status: "indeterminate" } });
    expect(JSON.stringify(body)).not.toContain("explicit-user-action-1");
    expect(JSON.stringify(body)).not.toContain("idempotencyKey");
    expect(JSON.stringify(body)).not.toContain("result");
  });
});

describe("WF-06 preference correction", () => {
  it("should apply exclusions without deleting story or activity history", async () => {
    const local = await http();
    seedStory(local.graph, 1);
    const session = await login(local.origin);
    const rule = {
      id: "rule-domain-1", kind: "domain", effect: "exclude", value: "example.test", normalizedValue: "example.test",
      enabled: true, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    };
    const replaced = await fetch(`${local.origin}/api/v1/preferences`, {
      method: "PUT",
      headers: { ...mutationHeaders(session, local.origin), "content-type": "application/json" },
      body: JSON.stringify({ rules: [rule] }),
    });
    expect(replaced.status).toBe(200);
    expect(await readJson(replaced)).toMatchObject({ sourceRules: [rule], sourceRulesSchemaVersion: 1, policySchemaVersion: 1 });
    const hidden = await fetch(`${local.origin}/api/v1/queue?visibilityState=blacklisted`, { headers: { cookie: session.cookie } });
    expect(await readJson(hidden)).toMatchObject({ items: [{ entry: { storyId: 1, visibilityState: "blacklisted" } }] });
    const story = await fetch(`${local.origin}/api/v1/stories/1`, { headers: { cookie: session.cookie } });
    expect(story.status).toBe(200);
    const rebuilt = await fetch(`${local.origin}/api/v1/personalization/rebuild`, mutation(session, local.origin, { reason: "reader correction" }));
    expect(rebuilt.status).toBe(200);
    expect(await readJson(rebuilt)).toMatchObject({ reason: "preference-change", sourceRules: [rule] });
  });
});

describe("WF-08 diagnostics", () => {
  it("should keep startup and live session secrets out of debug output", async () => {
    const local = await http({ debug: { enabled: true, include_llm_payloads: false } });
    const session = await login(local.origin);
    const response = await fetch(`${local.origin}/api/v1/debug/state`, { headers: mutationHeaders(session, local.origin) });
    const serialized = JSON.stringify(await readJson(response));
    expect(serialized).not.toContain("test-access-token-32-characters-0001");
    expect(serialized).not.toContain("test-llm-key-sentinel-0001");
    expect(serialized).not.toContain(session.cookie);
    expect(serialized).not.toContain(session.csrf);
    expect(serialized).not.toContain('"payload":');
  });
});
