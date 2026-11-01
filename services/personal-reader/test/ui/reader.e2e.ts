import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { resolve } from "node:path";
import { articleContentVersion } from "@tmtp/domain";
import type { Article } from "@tmtp/domain";
import { extractArticle } from "@tmtp/article-extractor";
import { ACCESS_TOKEN, fakeProvider, httpHarness } from "../harness.js";
import { readyArticleFixture, seedStory } from "../fixtures.js";
import type { PreferenceRuleDto } from "../../src/ui/types.js";

interface ActivityInput { clientEventId: string; storyId: number; kind: string; occurredAt: string; source: string }

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockReaderApi(page: Page, options: { articleStatus?: "ready" | "failed" | "missing"; hnAvailable?: boolean } = {}) {
  const state = {
    authenticated: false,
    detailRequests: 0,
    queueState: "unread",
    activity: [] as ActivityInput[],
    activityFailures: false,
    logoutRequests: 0,
    queueRequests: [] as string[],
    historyRequests: [] as string[],
    patches: [] as Array<{ state: string }>,
    preferences: [] as PreferenceRuleDto[],
    preferenceWrites: [] as PreferenceRuleDto[][],
    rebuilds: [] as string[],
    hnActionRequests: [] as Array<{ storyId: number; action: string; idempotencyKey: string }>,
    reconciliationRequests: 0,
  };
  const entry = () => ({
    storyId: 42,
    state: state.queueState,
    evaluationState: "scored",
    visibilityState: "visible",
    kind: "match",
    recommendationId: "rec-42",
    rankScore: 0.82,
    rankPosition: 1,
    rankVersion: "rank-1",
    queuedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const story = {
    id: 42,
    itemType: "story",
    title: "A readable test story",
    publishedAt: "2026-01-01T00:00:00.000Z",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    contentVersion: "story-v1",
    deleted: false,
    dead: false,
    author: "reader",
    score: 20,
    descendants: 4,
  };
  const article = options.articleStatus === "missing" ? undefined : {
      storyId: 42,
      status: options.articleStatus ?? "ready",
      sourceContentVersion: "story-v1",
      contentVersion: "article-v1",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...(options.articleStatus === "failed" ? { extractorVersion: "reader-test", errorCode: "extraction-failed" } : {
        sanitizedHtml: "<h2>Inside the article</h2><p>Cached sanitized body.</p><a href=\"https://example.test/reference\">Reference</a>",
      }),
  };
  const detail = () => ({
    story,
    ...(article === undefined ? {} : { article }),
    recommendation: {
      id: "rec-42",
      storyId: 42,
      profileId: "profile-1",
      storyContentVersion: "story-v1",
      articleContentVersion: "article-v1",
      promptVersion: "prompt-1",
      model: "test-model",
      score: 0.82,
      rationale: "It matches an explicit interest.",
      evidence: [{ kind: "explicit-rule", label: "Testing", value: 0.8 }],
      evidenceSchemaVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    queueEntry: entry(),
    originalUrl: "https://example.test/story",
    fallback: { kind: "original-page", observationQuality: "partial" },
  });
  const queue = () => ({ items: [{ entry: entry(), story, originalUrl: "https://example.test/story", fallback: { kind: "original-page", observationQuality: "partial" } }], evaluationCounts: { pending: 0, scored: 1, failed: 0 }, rankVersions: ["rank-1"] });
  const profile = (rules: PreferenceRuleDto[], reason: string) => ({
    id: "profile-new", rulesVersion: "rules-new", activityVersion: "activity-1", sourceRules: rules,
    sourceRulesSchemaVersion: 1, policy: { version: "policy-1" }, policySchemaVersion: 1,
    policyVersion: "policy-1", builderVersion: "builder-1", interests: [], reason,
    createdAt: "2026-01-02T00:00:00.000Z",
  });
  const job = (id: string, kind: string) => ({
    id, kind, status: "queued", runAfter: "2026-01-02T00:00:00.000Z", attempts: 0, maxAttempts: 3,
    createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/auth/session") return json(route, state.authenticated ? { authenticated: true, expiresAt: "2027-01-01T00:00:00.000Z", csrfState: "stored" } : { authenticated: false });
    if (path === "/api/v1/auth/login") {
      state.authenticated = true;
      return json(route, { expiresAt: "2027-01-01T00:00:00.000Z", csrfSecret: "c".repeat(43) });
    }
    if (path === "/api/v1/auth/logout") {
      state.logoutRequests += 1;
      state.authenticated = false;
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === "/api/v1/queue" && request.method() === "GET") {
      state.queueRequests.push(request.url());
      return json(route, queue());
    }
    if (path === "/api/v1/queue/42" && request.method() === "PATCH") {
      const body = request.postDataJSON() as { state: string };
      state.patches.push(body);
      state.queueState = body.state;
      return json(route, entry());
    }
    if (path === "/api/v1/stories/42") {
      state.detailRequests += 1;
      return json(route, detail());
    }
    if (path === "/api/v1/stories/42/hn-actions") {
      state.historyRequests.push(request.url());
      const afterId = new URL(request.url()).searchParams.get("afterId");
      return json(route, afterId === null ? [{
        id: "hn-1",
        storyId: 42,
        action: "upvote",
        status: "verified",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }] : []);
    }
    if (path === "/api/v1/hn/capabilities") return json(route, ["upvoted", "favorites", "flagged", "mutations"].map((name) => (
      options.hnAvailable === true ? { name, state: "available" } : { name, state: "unavailable", reason: "capability-disabled" }
    )));
    if (path === "/api/v1/hn/actions" && request.method() === "POST") {
      const body = request.postDataJSON() as { storyId: number; action: string; idempotencyKey: string };
      state.hnActionRequests.push(body);
      return json(route, { intentId: "hn-new", status: "indeterminate", observedAt: "2026-01-02T00:00:00.000Z", errorCode: "post-outcome-unknown" });
    }
    if (path === "/api/v1/hn/reconcile" && request.method() === "POST") {
      state.reconciliationRequests += 1;
      return json(route, job("reconcile-new", "ingestion.reconcile-account"));
    }
    if (path === "/api/v1/activity/batches") {
      const body = request.postDataJSON() as { batch: ActivityInput[] };
      if (state.activityFailures) return json(route, { error: { code: "unavailable", message: "Activity storage is unavailable.", retryable: true, requestId: "request-activity" } }, 503);
      state.activity.push(...body.batch);
      return json(route, { accepted: body.batch.length, profileWorkEnqueued: true });
    }
    if (path === "/api/v1/preferences") {
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as { rules: PreferenceRuleDto[] };
        state.preferences = body.rules;
        state.preferenceWrites.push(body.rules);
        return json(route, profile(body.rules, "preference-change"));
      }
      return json(route, state.preferences);
    }
    if (path === "/api/v1/personalization/rebuild" && request.method() === "POST") {
      const body = request.postDataJSON() as { reason: string };
      state.rebuilds.push(body.reason);
      return json(route, profile(state.preferences, body.reason));
    }
    if (path === "/api/v1/debug/state") return json(route, { error: { code: "not-found", message: "Not found.", retryable: false, requestId: "request-1" } }, 404);
    return json(route, { error: { code: "not-found", message: "Not found.", retryable: false, requestId: "request-1" } }, 404);
  });
  await page.route("**/health/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/health/ready") return json(route, { generatedAt: "2026-01-01T00:00:00.000Z", status: "ready", checks: [] });
    return json(route, {
      generatedAt: "2026-01-01T00:00:00.000Z",
      storedReading: { state: "available", reason: "ok" },
      backgroundWork: { state: "available", reason: "ok" },
      llmPersonalization: { state: "available", reason: "ok" },
      hnPublicCollection: { state: "available", reason: "ok" },
      hnAccount: { state: "disabled", reason: "not-configured" },
      freshArticleContent: { state: "unknown", reason: "not-checked" },
    });
  });
  return state;
}

test("should log in, read cached sanitized content, track completion, and honor the selected scheme", async ({ page }) => {
  const state = await mockReaderApi(page);
  await page.goto("/");
  await page.getByLabel("Access token").fill("test-access-token");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your queue" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Page size" })).toHaveCount(0);
  expect(state.queueRequests.every((url) => new URL(url).searchParams.has("limit") === false)).toBe(true);
  await expect.poll(() => state.activity.filter((event) => event.kind === "impression").length).toBe(1);
  await expect(page.getByRole("link", { name: "Debug", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content")).toContain("object-src 'none'");
  expect(await page.locator(".story-card").evaluate((element) => getComputedStyle(element).transitionDuration)).toMatch(/0\.01ms|0\.00001s|1e-05s/);

  await page.getByRole("combobox", { name: "Scheme" }).click();
  await page.getByRole("option", { name: "Sepia" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mui-color-scheme", "sepia");
  expect(state.activity.filter((event) => event.kind === "impression").length).toBe(1);

  await page.getByRole("link", { name: "Why this story?" }).click();
  await expect(page.getByRole("heading", { name: "Why this story?" })).toBeVisible();
  await expect(page.getByText("It matches an explicit interest.")).toBeVisible();
  await page.getByRole("button", { name: "Close recommendation explanation" }).click();
  await expect(page.getByRole("heading", { name: "A readable test story" })).toBeVisible();
  await expect(page.locator(".article-content")).toContainText("Cached sanitized body.");
  await expect(page.locator(".article-content")).toHaveCSS("font-size", "19px");
  await expect(page.locator(".article-content")).toHaveCSS("line-height", "31.35px");
  const reference = page.getByRole("link", { name: "Reference" });
  await expect(reference).toHaveAttribute("target", "_blank");
  await expect(reference).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await expect.poll(() => state.detailRequests).toBe(1);

  await page.getByRole("link", { name: "← Back to queue" }).click();
  await expect.poll(() => state.activity.filter((event) => event.kind === "impression").length).toBe(2);
  await page.getByRole("link", { name: "A readable test story", exact: true }).click();
  await expect(page.locator(".article-content")).toContainText("Cached sanitized body.");
  expect(state.detailRequests).toBe(1);

  await page.getByRole("button", { name: "Mark complete" }).click();
  await expect.poll(() => state.activity.some((event) => event.kind === "complete")).toBe(true);
  await expect.poll(() => state.patches.some((patch) => patch.state === "read")).toBe(true);
  expect(state.activity.every((event) => /^[A-Za-z0-9_-]{43}$/.test(event.clientEventId))).toBe(true);
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Personal Reader" })).toBeVisible();
});

test("should continue one-item history pages until an empty page and expose only visible navigation", async ({ page }) => {
  const state = await mockReaderApi(page);
  await page.goto("/");
  await page.getByLabel("Access token").fill("test-access-token");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.getByRole("link", { name: "A readable test story", exact: true }).click();

  await expect(page.getByRole("link", { name: "← Back to queue" })).toBeVisible();
  await expect(page.locator("button").filter({ hasText: "Go back" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load earlier actions" })).toBeVisible();
  expect(new URL(state.historyRequests[0]!).searchParams.has("limit")).toBe(false);
  await page.getByRole("button", { name: "Load earlier actions" }).click();
  await expect(page.getByRole("button", { name: "Load earlier actions" })).toHaveCount(0);
  expect(state.historyRequests).toHaveLength(2);
  expect(new URL(state.historyRequests[1]!).searchParams.get("afterId")).toBe("hn-1");
});

test("should block logout when pending activity cannot be flushed", async ({ page }) => {
  const state = await mockReaderApi(page);
  state.activityFailures = true;
  await page.goto("/");
  await page.getByLabel("Access token").fill("test-access-token");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.getByRole("link", { name: "A readable test story", exact: true }).click();
  await expect(page.getByText(/Reading activity is queued for retry:/)).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).click();

  await expect(page.getByText(/Reading activity may still be queued; try logout again\./)).toBeVisible();
  expect(state.logoutRequests).toBe(0);
  await expect(page.getByRole("heading", { name: "A readable test story" })).toBeVisible();
});

test("should record skip without marking the story read", async ({ page }) => {
  const state = await mockReaderApi(page);
  await page.goto("/");
  await page.getByLabel("Access token").fill("test-access-token");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.getByRole("link", { name: "A readable test story", exact: true }).click();
  await page.getByRole("button", { name: "Skip story", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your queue" })).toBeVisible();
  expect(state.activity.some((event) => event.kind === "skip")).toBe(true);
  expect(state.patches.some((patch) => patch.state === "read")).toBe(false);
});

test("should save a preference correction and rebuild its profile", async ({ page }) => {
  const state = await mockReaderApi(page);
  await page.goto("/");
  await page.getByLabel("Access token").fill("test-access-token");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Add rule" }).click();
  await page.getByRole("combobox", { name: "Kind", exact: true }).click();
  await page.getByRole("option", { name: "Domain", exact: true }).click();
  await page.getByRole("combobox", { name: "Effect", exact: true }).click();
  await page.getByRole("option", { name: "Exclude", exact: true }).click();
  await page.getByLabel("Value", { exact: true }).fill("Example.TEST");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText(/Preferences saved\./)).toBeVisible();
  expect(state.preferenceWrites[0]?.[0]).toMatchObject({ kind: "domain", effect: "exclude", normalizedValue: "example.test" });
  await page.getByRole("button", { name: "Rebuild now" }).click();
  await expect(page.getByText("Personalization was rebuilt.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Current profile" })).toBeVisible();
  expect(state.rebuilds).toEqual(["Manual rebuild from preference settings"]);
});

test("should require HN confirmation and show an indeterminate outcome without blind retry", async ({ page }) => {
  const state = await mockReaderApi(page, { hnAvailable: true });
  await page.goto("/");
  await page.getByLabel("Access token").fill("test-access-token");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.getByRole("link", { name: "A readable test story", exact: true }).click();
  await page.getByRole("button", { name: "Upvote", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(state.hnActionRequests).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm upvote", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Indeterminate" })).toContainText("Do not repeat it blindly");
  expect(state.hnActionRequests).toHaveLength(1);
  expect(state.hnActionRequests[0]).toMatchObject({ storyId: 42, action: "upvote" });
  await expect(page.getByRole("button", { name: "Upvote", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Schedule account reconciliation" }).click();
  await expect(page.getByText(/Reconciliation was scheduled\./)).toBeVisible();
  expect(state.reconciliationRequests).toBe(1);
});

test("should preserve a safe original-page fallback when extraction failed", async ({ page }) => {
  await mockReaderApi(page, { articleStatus: "failed" });
  await page.goto("/");
  await page.getByLabel("Access token").fill("test-access-token");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.getByRole("link", { name: "A readable test story", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The article could not be extracted" })).toBeVisible();
  await expect(page.getByText("Extraction outcome: Extraction failed")).toBeVisible();
  await expect(page.getByText("External reading is partially observed")).toBeVisible();
  const fallback = page.getByRole("link", { name: "Continue to the original page" });
  await expect(fallback).toHaveAttribute("href", "https://example.test/story");
  await expect(fallback).toHaveAttribute("target", "_blank");
  await expect(fallback).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await expect(page.locator(".article-content")).toHaveCount(0);
});

test("should use server defaults when queue pages are configured to one item", async ({ page }) => {
  const local = await httpHarness({ queue: { page_size: 1, max_page_size: 1 } }, {}, resolve("dist-ui"));
  try {
    seedStory(local.graph, 1, "First single-item page");
    seedStory(local.graph, 2, "Second single-item page");
    await page.goto(local.origin);
    await page.getByLabel("Access token").fill(ACCESS_TOKEN);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await expect(page.getByRole("link", { name: "First single-item page", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("link", { name: "Second single-item page", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Second single-item page", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Second single-item page" })).toBeVisible();
  } finally {
    await local.close();
  }
});

test("should use the real backend CSP and same-origin debug stream without executing hostile source HTML", async ({ page }) => {
  const local = await httpHarness(
    { debug: { enabled: true, include_llm_payloads: false, stream_interval_ms: 250 } },
    {},
    resolve("dist-ui"),
  );
  const remote = await fakeProvider();
  try {
    const story = seedStory(local.graph, 1, "Browser safety story");
    const extracted = extractArticle({
      sourceUrl: story.url!,
      maxContentChars: 10_000,
      html: `<html><head><title>Browser safety story</title></head><body><article>
        <p>Safe extracted article text with enough readable content for the local browser test.</p>
        <script>window.hostileScriptRan = true</script>
        <form action="${remote.origin}/submit"><button>Send</button></form>
        <iframe src="${remote.origin}/frame"></iframe>
        <img src="${remote.origin}/pixel.png" alt="remote pixel">
      </article></body></html>`,
    });
    const article = readyArticleFixture(story);
    article.sanitizedHtml = extracted.sanitizedHtml;
    article.contentHash = extracted.contentHash;
    article.extractorVersion = extracted.extractorVersion;
    article.contentVersion = articleContentVersion(article as Article);
    local.graph.store.articles.upsert(article);
    const response = await page.goto(local.origin);
    expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
    await page.getByLabel("Access token").fill(ACCESS_TOKEN);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await page.getByRole("link", { name: "Browser safety story", exact: true }).click();
    await expect(page.getByText("Safe extracted article text", { exact: false })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { hostileScriptRan?: boolean }).hostileScriptRan)).toBeUndefined();
    await expect(page.locator(".article-content script, .article-content form, .article-content iframe")).toHaveCount(0);
    expect(remote.journal.some((entry) => entry.url === "/pixel.png")).toBe(false);

    await page.getByRole("link", { name: "Debug", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Live debug window" })).toBeVisible();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await expect(page.getByText(/^Frame \d+$/)).toBeVisible();
    await expect(page.getByText("Some diagnostic sections are unavailable.")).toHaveCount(0);
  } finally {
    await local.close();
    await remote.close();
  }
});
