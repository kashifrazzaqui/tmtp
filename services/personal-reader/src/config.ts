import { isIP } from "node:net";
import {
  assertValidConfig,
  parseConfig,
  z,
} from "@tmtp/config";
import type { ConfigResult } from "@tmtp/config";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_LEASE_MS = 3 * MAX_TIMER_DELAY_MS + 2;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const nonNegativeInteger = z.number().int().min(0).max(MAX_SAFE_INTEGER);
const positiveInteger = z.number().int().min(1).max(MAX_SAFE_INTEGER);
const timerDelay = (minimum: number) => z.number().int().min(minimum).max(MAX_TIMER_DELAY_MS);

function invalidFormat<T>(context: { value: T; issues: { push: (issue: {
  code: "invalid_value";
  values: never[];
  message: string;
  input: T;
}) => unknown } }): void {
  context.issues.push({
    code: "invalid_value",
    values: [],
    message: "Configuration value is invalid.",
    input: context.value,
  });
}

function isLoopbackHost(host: string): boolean {
  const hostname = host.replace(/^\[|\]$/g, "").toLowerCase();
  return hostname === "localhost" || hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.startsWith("127."));
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.hostname === "" || url.username !== "" || url.password !== "" ||
      value.includes("?") || value.includes("#")
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function parseOrigin(value: string): URL | undefined {
  const url = parseHttpUrl(value);
  return url !== undefined && url.pathname === "/" ? url : undefined;
}

const hnApiBaseUrlSchema = z.string().check((context) => {
  if (context.issues.length > 0) return;
  const value = context.value;
  if (parseHttpUrl(value) === undefined) invalidFormat(context);
});

const llmBaseUrlSchema = z.string().check((context) => {
  if (context.issues.length > 0) return;
  const value = context.value;
  if (value.trim() !== value || parseHttpUrl(value) === undefined) invalidFormat(context);
});

const publicBaseUrlSchema = z.string().check((context) => {
  if (context.issues.length > 0) return;
  const value = context.value;
  if (parseOrigin(value) === undefined) invalidFormat(context);
}).transform((value) => new URL(value).origin);

const hnWebBaseUrlSchema = z.string().check((context) => {
  if (context.issues.length > 0) return;
  const value = context.value;
  const url = parseOrigin(value);
  if (url === undefined || (url.protocol !== "https:" && !isLoopbackHost(url.hostname))) {
    invalidFormat(context);
  }
}).transform((value) => new URL(value).origin);

const timezoneSchema = z.string().check((context) => {
  if (context.issues.length > 0) return;
  const value = context.value;
  let valid = value.length > 0 && !/^[+-]/.test(value) && !/^(?:UTC|GMT)[+-]/i.test(value);
  if (valid) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    } catch {
      valid = false;
    }
  }
  if (!valid) invalidFormat(context);
});

const CRON_NAMES: Readonly<Record<string, readonly string[]>> = {
  month: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
  weekday: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
};

function cronAtom(value: string, index: number, minimum: number, maximum: number): number | undefined {
  const named = index === 3 ? CRON_NAMES.month : index === 4 ? CRON_NAMES.weekday : undefined;
  const namedValue = named?.indexOf(value.toUpperCase());
  const numeric = namedValue !== undefined && namedValue >= 0
    ? namedValue + (index === 3 ? 1 : 0)
    : /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric >= minimum && numeric <= maximum
    ? numeric
    : undefined;
}

function validCronRange(base: string, index: number, minimum: number, maximum: number): boolean {
  const range = base.split("-");
  if (range.length !== 2 || range[0] === "" || range[1] === "") return false;
  const start = cronAtom(range[0]!, index, minimum, maximum);
  const end = cronAtom(range[1]!, index, minimum, maximum);
  return start !== undefined && end !== undefined;
}

function validCronBase(base: string, index: number, minimum: number, maximum: number): boolean {
  if (base === "*" || base === "?") return true;
  if (validCronRange(base, index, minimum, maximum)) return true;
  if (cronAtom(base, index, minimum, maximum) !== undefined) return true;
  if (index === 2) {
    if (base === "L" || base === "LW" || /^L-\d{1,2}$/.test(base)) return true;
    if (/^\d{1,2}W$/.test(base)) return cronAtom(base.slice(0, -1), index, minimum, maximum) !== undefined;
  }
  if (index === 4) {
    if (base === "L") return true;
    const last = /^(\d)L$/.exec(base);
    if (last !== null) return cronAtom(last[1]!, index, minimum, maximum) !== undefined;
    const nth = /^(\d)#(\d)$/.exec(base);
    if (nth !== null) {
      return cronAtom(nth[1]!, index, minimum, maximum) !== undefined &&
        Number(nth[2]) >= 1 && Number(nth[2]) <= 5;
    }
  }
  return false;
}

function validCronField(field: string, index: number, minimum: number, maximum: number): boolean {
  return field.split(",").every((part) => {
    if (part === "") return false;
    const stepped = part.split("/");
    if (stepped.length > 2 || stepped[0] === "") return false;
    if (stepped.length === 2) {
      if (!/^\d+$/.test(stepped[1]!) || Number(stepped[1]) < 1) return false;
      const base = stepped[0]!;
      if (base !== "*" && base !== "?" && !validCronRange(base, index, minimum, maximum)) return false;
    }
    return validCronBase(stepped[0]!, index, minimum, maximum);
  });
}

function validCronExpression(value: string): boolean {
  const fields = value.split(" ");
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ] as const;
  return fields.length === 5 && fields.every((field, index) => {
    const range = ranges[index]!;
    return validCronField(field, index, range[0], range[1]);
  });
}

const cronSchema = z.string().trim().transform((value) => value.replace(/\s+/g, " "))
  .check((context) => {
  if (context.issues.length > 0) return;
  const value = context.value;
    if (!validCronExpression(value)) invalidFormat(context);
  });

function uniqueArrayIssue<T>(values: readonly unknown[], context: {
  value: T;
  issues: { push: (issue: { code: "invalid_value"; values: never[]; message: string; input: T }) => unknown };
}): void {
  if (new Set(values).size !== values.length) invalidFormat(context);
}

const authSchema = z.strictObject({
  access_token_path: z.string(),
  session_ttl_seconds: z.number().int().min(1).max(31_536_000).default(604_800),
  login_max_attempts: z.number().int().min(1).max(1_000_000).default(10),
  login_window_seconds: z.number().int().min(1).max(86_400).default(300),
});

const databaseSchema = z.strictObject({
  path: z.string().min(1),
  busy_timeout_ms: z.number().int().min(0).max(60_000).default(5000),
  wal: z.boolean().default(true),
});

const serverSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(0).max(65_535).default(3000),
  public_base_url: publicBaseUrlSchema.nullable().default(null),
  trust_proxy: z.boolean().default(false),
  shutdown_grace_ms: timerDelay(0).default(10_000),
}).prefault({});

const loggingSchema = z.strictObject({
  level: z.enum(["error", "warn", "info", "debug", "trace"]).default("info"),
}).prefault({});

const schedulerSchema = z.strictObject({
  timezone: timezoneSchema.default("UTC"),
  overrun_protection: z.boolean().default(true),
}).prefault({});

const jobsSchema = z.strictObject({
  poll_interval_ms: timerDelay(0).default(1000),
  lease_ms: z.number().int().min(1000).max(MAX_LEASE_MS).default(120_000),
  max_attempts: positiveInteger.default(5),
  backoff_base_ms: nonNegativeInteger.default(1000),
  backoff_max_ms: nonNegativeInteger.default(300_000),
  batch_size: positiveInteger.default(20),
}).check((context) => {
  if (context.issues.length > 0) return;
  const value = context.value;
  if (value.backoff_max_ms < value.backoff_base_ms) {
    context.issues.push({
      code: "custom",
      input: value,
      path: ["backoff_max_ms"],
      message: "Configuration values are inconsistent.",
    });
  }
}).prefault({});

const retrySchema = z.strictObject({
  max_attempts: positiveInteger.default(3),
  base_delay_ms: timerDelay(0).default(500),
  max_delay_ms: timerDelay(0).default(8000),
  jitter_ratio: z.number().min(0).max(1).default(0.2),
}).check((context) => {
  if (context.issues.length > 0) return;
  const value = context.value;
  if (value.max_delay_ms < value.base_delay_ms) {
    context.issues.push({
      code: "custom",
      input: value,
      path: ["max_delay_ms"],
      message: "Configuration values are inconsistent.",
    });
  }
}).prefault({});

const httpSchema = z.strictObject({
  timeout_ms: timerDelay(1).default(20_000),
  retry: retrySchema,
  user_agent: z.string().trim().min(1).regex(/^[^\r\n\0]+$/).default("tmtp-personal-reader/0.1"),
}).prefault({});

const hnSchema = z.strictObject({
  api_base_url: hnApiBaseUrlSchema.default("https://hacker-news.firebaseio.com/v0"),
  web_base_url: hnWebBaseUrlSchema.default("https://news.ycombinator.com"),
  username: z.string().trim().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/).nullable().default(null),
  session_cookie_path: z.string().nullable().default(null),
  max_requests_per_minute: z.number().int().min(1).max(600).default(10),
  flag_readback_enabled: z.boolean().default(false),
}).check((context) => {
  if (context.issues.length > 0) return;
  const value = context.value;
  if (value.username !== null && value.session_cookie_path === null) {
    context.issues.push({
      code: "custom",
      input: value,
      path: ["session_cookie_path"],
      message: "Configuration values are inconsistent.",
    });
  }
  if (value.username === null && value.session_cookie_path !== null) {
    context.issues.push({
      code: "custom",
      input: value,
      path: ["username"],
      message: "Configuration values are inconsistent.",
    });
  }
}).prefault({});

const ingestionSchema = z.strictObject({
  cron: cronSchema.default("*/15 * * * *"),
  feeds: z.array(z.enum(["top", "new", "best", "ask", "show"]))
    .check((context) => {
      if (context.issues.length === 0) uniqueArrayIssue(context.value, context);
    })
    .default(["top", "new", "best", "ask", "show"]),
  initial_lookback_items: nonNegativeInteger.default(0),
  max_items_per_run: positiveInteger.default(2000),
  refresh_batch_size: positiveInteger.default(100),
  refresh_after_hours: z.number().positive().check((context) => {
  if (context.issues.length > 0) return;
  const value = context.value;
    const milliseconds = value * 3_600_000;
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) invalidFormat(context);
  }).default(24),
}).prefault({});

const articleSchema = z.strictObject({
  timeout_ms: timerDelay(1).default(20_000),
  dns_timeout_ms: timerDelay(1).default(5000),
  max_response_bytes: timerDelay(1).default(5_000_000),
  max_redirects: z.number().int().min(0).max(100).default(5),
  allowed_protocols: z.array(z.enum(["https", "http"])).min(1)
    .check((context) => {
      if (context.issues.length === 0) uniqueArrayIssue(context.value, context);
    })
    .default(["https", "http"]),
  allowed_ports: z.array(z.number().int().min(1).max(65_535)).min(1)
    .check((context) => {
      if (context.issues.length === 0) uniqueArrayIssue(context.value, context);
    })
    .default([80, 443]),
  max_content_chars: positiveInteger.default(500_000),
}).prefault({});

const activitySchema = z.strictObject({
  idle_timeout_ms: positiveInteger.default(60_000),
  min_dwell_ms: nonNegativeInteger.default(1000),
  max_session_gap_ms: positiveInteger.default(300_000),
}).check((context) => {
  if (context.issues.length > 0) return;
  const value = context.value;
  if (value.min_dwell_ms > value.idle_timeout_ms) {
    context.issues.push({
      code: "custom",
      input: value,
      path: ["min_dwell_ms"],
      message: "Configuration values are inconsistent.",
    });
  }
  if (value.idle_timeout_ms > value.max_session_gap_ms) {
    context.issues.push({
      code: "custom",
      input: value,
      path: ["max_session_gap_ms"],
      message: "Configuration values are inconsistent.",
    });
  }
}).prefault({});

const interestsSchema = z.strictObject({
  decay_half_life_days: z.number().positive().default(45),
  max_inferred_topics: nonNegativeInteger.default(50),
  max_activity_events: nonNegativeInteger.default(5000),
}).prefault({});

const llmSchema = z.strictObject({
  base_url: llmBaseUrlSchema,
  api_key_path: z.string(),
  model: z.string().min(1).check((context) => {
  if (context.issues.length > 0) return;
  const value = context.value;
    if (value.trim() !== value) invalidFormat(context);
  }),
  timeout_ms: timerDelay(1).default(60_000),
  max_retries: nonNegativeInteger.default(2),
  max_output_tokens: positiveInteger.default(4096),
});

const recommendationsSchema = z.strictObject({
  batch_size: positiveInteger.default(10),
  max_stories_per_run: nonNegativeInteger.default(50),
  max_prompt_chars: positiveInteger.default(60_000),
  exploration_ratio: z.number().min(0).max(0.5).default(0.1),
}).prefault({});

const queueSchema = z.strictObject({
  page_size: positiveInteger.default(50),
  max_page_size: positiveInteger.default(200),
}).check((context) => {
  if (context.issues.length > 0) return;
  const value = context.value;
  if (value.page_size > value.max_page_size) {
    context.issues.push({
      code: "custom",
      input: value,
      path: ["page_size"],
      message: "Configuration values are inconsistent.",
    });
  }
}).prefault({});

const personalizationSchema = z.strictObject({
  cron: cronSchema.default("7,37 * * * *"),
  activity_batch_size: positiveInteger.default(500),
  queue_sync_batch_size: positiveInteger.default(500),
}).prefault({});

const debugSchema = z.strictObject({
  enabled: z.boolean().default(false),
  stream_interval_ms: z.number().int().min(250).max(60_000).default(2000),
  include_llm_payloads: z.boolean().default(false),
}).check((context) => {
  if (context.issues.length > 0) return;
  const value = context.value;
  if (value.include_llm_payloads && !value.enabled) {
    context.issues.push({
      code: "custom",
      input: value,
      path: ["include_llm_payloads"],
      message: "Configuration values are inconsistent.",
    });
  }
}).prefault({});

export const personalReaderConfigSchema = z.strictObject({
  server: serverSchema,
  auth: authSchema,
  database: databaseSchema,
  logging: loggingSchema,
  scheduler: schedulerSchema,
  jobs: jobsSchema,
  http: httpSchema,
  hn: hnSchema,
  ingestion: ingestionSchema,
  article: articleSchema,
  activity: activitySchema,
  interests: interestsSchema,
  llm: llmSchema,
  recommendations: recommendationsSchema,
  queue: queueSchema,
  personalization: personalizationSchema,
  debug: debugSchema,
}).check((context) => {
  if (context.issues.length > 0) return;
  const value = context.value;
  const publicUrl = value.server.public_base_url;
  const publicOrigin = publicUrl === null ? undefined : new URL(publicUrl);
  const requiresHttps = !isLoopbackHost(value.server.host) ||
    (publicOrigin !== undefined && !isLoopbackHost(publicOrigin.hostname));
  if (requiresHttps && (publicOrigin === undefined || publicOrigin.protocol !== "https:")) {
    context.issues.push({
      code: "custom",
      input: value,
      path: ["server", "public_base_url"],
      message: "Configuration values are inconsistent.",
    });
  }
});

export type ResolvedConfig = z.infer<typeof personalReaderConfigSchema>;

export function validateConfig(raw: unknown): ConfigResult<ResolvedConfig> {
  return parseConfig(personalReaderConfigSchema, raw);
}

export function loadConfig(raw: unknown): ResolvedConfig {
  return assertValidConfig(validateConfig(raw));
}
