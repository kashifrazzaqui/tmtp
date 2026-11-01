import { describe, expect, it, vi } from "vitest";
import { ConfigValidationError } from "@tmtp/config";
import {
  loadConfig,
  personalReaderConfigSchema,
  validateConfig,
} from "../src/config.js";
import type { ResolvedConfig } from "../src/config.js";

const REQUIRED = {
  auth: { access_token_path: "/secrets/access-token" },
  database: { path: "/data/reader.sqlite" },
  llm: {
    base_url: "https://llm.example.test/v1",
    api_key_path: "/secrets/llm-key",
    model: "reader-model",
  },
};

const INVALID_MESSAGE = "Configuration value is invalid.";
const INCONSISTENT_MESSAGE = "Configuration values are inconsistent.";
const REQUIRED_MESSAGE = "Required configuration value is missing.";

function candidate(entries: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const raw = structuredClone(REQUIRED) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(entries)) {
    const segments = path.split(".");
    let parent = raw;
    for (const segment of segments.slice(0, -1)) {
      if (parent[segment] === undefined) parent[segment] = {};
      parent = parent[segment] as Record<string, unknown>;
    }
    parent[segments.at(-1)!] = value;
  }
  return raw;
}

function expectIssue(
  raw: unknown,
  key: string,
  code: "required" | "invalid" | "inconsistent",
): void {
  const message = code === "required"
    ? REQUIRED_MESSAGE
    : code === "invalid"
      ? INVALID_MESSAGE
      : INCONSISTENT_MESSAGE;
  expect(validateConfig(raw)).toEqual({ issues: [{ key, code, message }] });
}

describe("personal-reader configuration", () => {
  it("should resolve every key and default from only the required values", () => {
    const config: ResolvedConfig = loadConfig(candidate());
    expect(config).toEqual({
      server: {
        host: "127.0.0.1",
        port: 3000,
        public_base_url: null,
        trust_proxy: false,
        shutdown_grace_ms: 10_000,
      },
      auth: {
        access_token_path: "/secrets/access-token",
        session_ttl_seconds: 604_800,
        login_max_attempts: 10,
        login_window_seconds: 300,
      },
      database: { path: "/data/reader.sqlite", busy_timeout_ms: 5000, wal: true },
      logging: { level: "info" },
      scheduler: { timezone: "UTC", overrun_protection: true },
      jobs: {
        poll_interval_ms: 1000,
        lease_ms: 120_000,
        max_attempts: 5,
        backoff_base_ms: 1000,
        backoff_max_ms: 300_000,
        batch_size: 20,
      },
      http: {
        timeout_ms: 20_000,
        retry: { max_attempts: 3, base_delay_ms: 500, max_delay_ms: 8000, jitter_ratio: 0.2 },
        user_agent: "tmtp-personal-reader/0.1",
      },
      hn: {
        api_base_url: "https://hacker-news.firebaseio.com/v0",
        web_base_url: "https://news.ycombinator.com",
        username: null,
        session_cookie_path: null,
        max_requests_per_minute: 10,
        flag_readback_enabled: false,
      },
      ingestion: {
        cron: "*/15 * * * *",
        feeds: ["top", "new", "best", "ask", "show"],
        initial_lookback_items: 0,
        max_items_per_run: 2000,
        refresh_batch_size: 100,
        refresh_after_hours: 24,
      },
      article: {
        timeout_ms: 20_000,
        dns_timeout_ms: 5000,
        max_response_bytes: 5_000_000,
        max_redirects: 5,
        allowed_protocols: ["https", "http"],
        allowed_ports: [80, 443],
        max_content_chars: 500_000,
      },
      activity: { idle_timeout_ms: 60_000, min_dwell_ms: 1000, max_session_gap_ms: 300_000 },
      interests: { decay_half_life_days: 45, max_inferred_topics: 50, max_activity_events: 5000 },
      llm: {
        base_url: "https://llm.example.test/v1",
        api_key_path: "/secrets/llm-key",
        model: "reader-model",
        timeout_ms: 60_000,
        max_retries: 2,
        max_output_tokens: 4096,
      },
      recommendations: {
        batch_size: 10,
        max_stories_per_run: 50,
        max_prompt_chars: 60_000,
        exploration_ratio: 0.1,
      },
      queue: { page_size: 50, max_page_size: 200 },
      personalization: { cron: "7,37 * * * *", activity_batch_size: 500, queue_sync_batch_size: 500 },
      debug: { enabled: false, stream_interval_ms: 2000, include_llm_payloads: false },
    });
  });

  it.each([
    "auth.access_token_path",
    "database.path",
    "llm.base_url",
    "llm.api_key_path",
    "llm.model",
  ])("should report %s as required", (path) => {
    expectIssue(candidate({ [path]: undefined }), path, "required");
  });

  it("should parse and assert one candidate exactly once", () => {
    const spy = vi.spyOn(personalReaderConfigSchema, "safeParse");
    const raw = candidate();
    const resolved = loadConfig(raw);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    expect(validateConfig(raw).value).toEqual(resolved);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("should not mutate the raw candidate", () => {
    const raw = candidate();
    const before = structuredClone(raw);
    loadConfig(raw);
    expect(raw).toEqual(before);
  });

  it("should reject secret paths only through the file loader rather than inventing path rules", () => {
    const config = loadConfig(candidate({
      "auth.access_token_path": "",
      "llm.api_key_path": "",
      "hn.username": "reader",
      "hn.session_cookie_path": "",
    }));
    expect(config.auth.access_token_path).toBe("");
    expect(config.llm.api_key_path).toBe("");
    expect(config.hn.session_cookie_path).toBe("");
  });

  it("should normalize origins usernames user agents and cron whitespace", () => {
    const config = loadConfig(candidate({
      "server.public_base_url": "https://Example.COM:443/",
      "hn.web_base_url": "https://News.YCombinator.com/",
      "hn.username": "  reader  ",
      "hn.session_cookie_path": "/secrets/hn-cookie",
      "http.user_agent": "  reader-agent  ",
      "ingestion.cron": "  */15   *  * * *  ",
    }));
    expect(config.server.public_base_url).toBe("https://example.com");
    expect(config.hn.web_base_url).toBe("https://news.ycombinator.com");
    expect(config.hn.username).toBe("reader");
    expect(config.http.user_agent).toBe("reader-agent");
    expect(config.ingestion.cron).toBe("*/15 * * * *");
  });

  it.each([
    ["server.host", ""],
    ["server.port", 65_536],
    ["database.path", ""],
    ["database.busy_timeout_ms", 60_001],
    ["logging.level", "verbose"],
    ["scheduler.timezone", "UTC+1"],
    ["jobs.max_attempts", 0],
    ["jobs.backoff_base_ms", -1],
    ["jobs.batch_size", 0],
    ["http.retry.max_attempts", 0],
    ["http.retry.jitter_ratio", 1.1],
    ["http.user_agent", "bad\nagent"],
    ["hn.api_base_url", "https://hacker-news.firebaseio.com/v0?key=value"],
    ["hn.web_base_url", "https://news.ycombinator.com/path"],
    ["hn.username", "x".repeat(129)],
    ["hn.max_requests_per_minute", 601],
    ["ingestion.cron", "not cron"],
    ["ingestion.feeds", ["top", "top"]],
    ["ingestion.initial_lookback_items", -1],
    ["ingestion.max_items_per_run", 0],
    ["ingestion.refresh_batch_size", 0],
    ["ingestion.refresh_after_hours", Number.MAX_SAFE_INTEGER],
    ["article.max_response_bytes", 0],
    ["article.max_redirects", 101],
    ["article.allowed_protocols", []],
    ["article.allowed_protocols", ["http", "http"]],
    ["article.allowed_ports", [80, 80]],
    ["article.max_content_chars", 0],
    ["activity.idle_timeout_ms", 0],
    ["activity.min_dwell_ms", -1],
    ["activity.max_session_gap_ms", 0],
    ["interests.decay_half_life_days", 0],
    ["interests.max_inferred_topics", -1],
    ["llm.base_url", " https://llm.example.test/v1"],
    ["llm.model", " reader-model "],
    ["llm.max_retries", -1],
    ["llm.max_output_tokens", 0],
    ["recommendations.batch_size", 0],
    ["recommendations.max_stories_per_run", -1],
    ["recommendations.max_prompt_chars", 0],
    ["recommendations.exploration_ratio", 0.6],
    ["queue.page_size", 0],
    ["queue.max_page_size", 0],
    ["personalization.activity_batch_size", 0],
    ["personalization.queue_sync_batch_size", 0],
  ])("should report an invalid value at %s", (path, value) => {
    expectIssue(candidate({ [path]: value }), path, "invalid");
  });

  it.each([
    "ftp://example.com",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com?query=yes",
    "https://example.com#fragment",
    "not a URL",
  ])("should reject invalid public origin %s", (value) => {
    expectIssue(candidate({ "server.public_base_url": value }), "server.public_base_url", "invalid");
  });

  it.each([
    ["server.public_base_url", 42],
    ["hn.api_base_url", 42],
    ["hn.web_base_url", 42],
    ["llm.base_url", 42],
    ["llm.model", 42],
    ["scheduler.timezone", 42],
    ["ingestion.cron", 42],
    ["ingestion.refresh_after_hours", "24"],
    ["article.allowed_protocols", "https"],
  ])("should safely reject a wrong type at %s", (path, value) => {
    expectIssue(candidate({ [path]: value }), path, "invalid");
  });

  it("should identify an invalid array element without running uniqueness checks", () => {
    expectIssue(candidate({ "article.allowed_ports": [80, "80"] }), "article.allowed_ports[1]", "invalid");
  });

  it("should require both HN account settings or neither", () => {
    expectIssue(candidate({ "hn.username": "reader" }), "hn.session_cookie_path", "inconsistent");
    expectIssue(
      candidate({ "hn.session_cookie_path": "/secrets/hn-cookie" }),
      "hn.username",
      "inconsistent",
    );
    expect(validateConfig(candidate({
      "hn.username": "reader",
      "hn.session_cookie_path": "/secrets/hn-cookie",
    })).issues).toEqual([]);
  });

  it("should apply both independent deployment HTTPS rules", () => {
    expectIssue(candidate({ "server.host": "0.0.0.0" }), "server.public_base_url", "inconsistent");
    expectIssue(candidate({
      "server.host": "0.0.0.0",
      "server.public_base_url": "http://127.0.0.1:3000",
    }), "server.public_base_url", "inconsistent");
    expectIssue(candidate({
      "server.public_base_url": "http://reader.example.test",
    }), "server.public_base_url", "inconsistent");

    expect(validateConfig(candidate({
      "server.host": "0.0.0.0",
      "server.public_base_url": "https://reader.example.test",
    })).issues).toEqual([]);
    expect(validateConfig(candidate({
      "server.public_base_url": "http://127.0.0.1:3000",
    })).issues).toEqual([]);
    expect(validateConfig(candidate({
      "server.public_base_url": "https://reader.example.test",
    })).issues).toEqual([]);
  });

  it("should report every component-owned cross-field relation as inconsistent", () => {
    expectIssue(candidate({
      "jobs.backoff_base_ms": 500,
      "jobs.backoff_max_ms": 499,
    }), "jobs.backoff_max_ms", "inconsistent");
    expectIssue(candidate({
      "http.retry.base_delay_ms": 500,
      "http.retry.max_delay_ms": 499,
    }), "http.retry.max_delay_ms", "inconsistent");
    expectIssue(candidate({
      "activity.idle_timeout_ms": 100,
      "activity.min_dwell_ms": 101,
    }), "activity.min_dwell_ms", "inconsistent");
    expectIssue(candidate({
      "activity.idle_timeout_ms": 301,
      "activity.min_dwell_ms": 0,
      "activity.max_session_gap_ms": 300,
    }), "activity.max_session_gap_ms", "inconsistent");
    expectIssue(candidate({
      "queue.page_size": 201,
      "queue.max_page_size": 200,
    }), "queue.page_size", "inconsistent");
    expectIssue(candidate({
      "debug.include_llm_payloads": true,
    }), "debug.include_llm_payloads", "inconsistent");
  });

  it("should accept equal cross-field boundaries and enabled payload capture", () => {
    expect(validateConfig(candidate({
      "jobs.backoff_base_ms": 0,
      "jobs.backoff_max_ms": 0,
      "http.retry.base_delay_ms": 0,
      "http.retry.max_delay_ms": 0,
      "activity.idle_timeout_ms": 1,
      "activity.min_dwell_ms": 0,
      "activity.max_session_gap_ms": 1,
      "queue.page_size": 1,
      "queue.max_page_size": 1,
      "debug.enabled": true,
      "debug.include_llm_payloads": true,
    })).issues).toEqual([]);
  });

  it.each([
    ["server.shutdown_grace_ms", 0, 2_147_483_647],
    ["jobs.poll_interval_ms", 0, 2_147_483_647],
    ["jobs.lease_ms", 1000, 6_442_450_943],
    ["http.timeout_ms", 1, 2_147_483_647],
    ["http.retry.base_delay_ms", 0, 2_147_483_647],
    ["http.retry.max_delay_ms", 0, 2_147_483_647],
    ["article.timeout_ms", 1, 2_147_483_647],
    ["article.dns_timeout_ms", 1, 2_147_483_647],
    ["llm.timeout_ms", 1, 2_147_483_647],
    ["debug.stream_interval_ms", 250, 60_000],
  ])("should enforce exact delay bounds for %s", (path, minimum, maximum) => {
    const companions = path === "http.retry.base_delay_ms"
      ? { "http.retry.max_delay_ms": maximum }
      : path === "http.retry.max_delay_ms"
        ? { "http.retry.base_delay_ms": minimum }
        : {};
    expect(validateConfig(candidate({ ...companions, [path]: minimum })).issues, `${path} minimum`).toEqual([]);
    expect(validateConfig(candidate({ ...companions, [path]: maximum })).issues, `${path} maximum`).toEqual([]);
    expectIssue(candidate({ [path]: minimum - 1 }), path, "invalid");
    expectIssue(candidate({ [path]: maximum + 1 }), path, "invalid");
  });

  it("should keep job backoff bounds at safe integers rather than timer bounds", () => {
    expect(validateConfig(candidate({
      "jobs.backoff_base_ms": Number.MAX_SAFE_INTEGER,
      "jobs.backoff_max_ms": Number.MAX_SAFE_INTEGER,
    })).issues).toEqual([]);
  });

  it("should reject unknown keys without echoing values keys or custom text", () => {
    const secret = "secret-sentinel-6a4e";
    const raw = candidate({
      "server.port": secret,
      [`server.${secret}`]: true,
    });
    const result = validateConfig(raw);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.issues.map((issue) => issue.key)).toEqual(["server.port", "server"]);
    expect(() => loadConfig(raw)).toThrow(ConfigValidationError);
    try {
      loadConfig(raw);
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).cause).toBeUndefined();
    }
  });
});
