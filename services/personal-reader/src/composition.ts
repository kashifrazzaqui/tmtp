import { randomUUID } from "node:crypto";
import { createAccessControl } from "@tmtp/access-control";
import type { AccessControl, AccessSessionStore } from "@tmtp/access-control";
import { createArticleFetcher } from "@tmtp/article-fetcher";
import { createArticleReader } from "@tmtp/article-reader";
import { systemClock, systemSleep } from "@tmtp/clock";
import type { Clock, Sleep } from "@tmtp/clock";
import { createDiagnostics } from "@tmtp/diagnostics";
import type { Diagnostics } from "@tmtp/diagnostics";
import { createHnAccount } from "@tmtp/hn-account";
import type { HnAccount } from "@tmtp/hn-account";
import { createHnIngestion } from "@tmtp/hn-ingestion";
import { createHnPublicApi } from "@tmtp/hn-public-api";
import type { HnPublicApi } from "@tmtp/hn-public-api";
import { createHttpClient } from "@tmtp/http-client";
import type { HttpClient } from "@tmtp/http-client";
import { createOpenAiCompatibleLlm } from "@tmtp/llm-openai-compatible";
import type { LlmPort } from "@tmtp/llm-interface";
import type { ArticleReader } from "@tmtp/article-reader";
import { createLogger } from "@tmtp/logging";
import type { Logger } from "@tmtp/logging";
import { createPersonalization } from "@tmtp/personalization";
import type { Personalization } from "@tmtp/personalization";
import { createReaderApp, readerAppBootstrapRankVersion } from "@tmtp/reader-app";
import type { ReaderApp } from "@tmtp/reader-app";
import type { ResolvedConfig } from "./config.js";
import { IntegrationHealthState, LocalHealthState, observeLlm } from "./health.js";
import { ServiceOperations } from "./operations.js";
import type { SecretRedactionRegistry, StartupSecrets } from "./secrets.js";

export interface LoadedSecrets extends StartupSecrets {
  registry: SecretRedactionRegistry;
}
import { openStorage } from "./storage.js";
import type { StorageGraph } from "./storage.js";

export interface CompositionOptions {
  config: ResolvedConfig;
  secrets: LoadedSecrets;
  logger?: Logger;
  clock?: Clock;
  sleep?: Sleep;
  health?: LocalHealthState;
  operations?: ServiceOperations;
  adapters?: {
    account?: HnAccount;
    articles?: ArticleReader;
    llm?: LlmPort;
  };
}

export interface ServiceGraph extends StorageGraph {
  config: ResolvedConfig;
  secrets: LoadedSecrets;
  logger: Logger;
  clock: Clock;
  sleep: Sleep;
  health: LocalHealthState;
  integrations: IntegrationHealthState;
  operations: ServiceOperations;
  generalHttp: HttpClient;
  accountHttp?: HttpClient;
  hnPublic: HnPublicApi;
  account?: HnAccount;
  llm: LlmPort;
  accessControl: AccessControl;
  personalization: Personalization;
  readerApp: ReaderApp;
  diagnostics: Diagnostics;
  closeLocal(): Promise<void>;
}

export function accountConfigured(config: ResolvedConfig): boolean {
  return config.hn.username !== null && config.hn.session_cookie_path !== null;
}

export async function composeService(options: CompositionOptions): Promise<ServiceGraph> {
  const { config, secrets } = options;
  const clock = options.clock ?? systemClock;
  const sleep = options.sleep ?? systemSleep;
  const logger = options.logger ?? createLogger({
    level: config.logging.level,
    service: "personal-reader",
    secretValuesProvider: secrets.registry.secretValuesProvider,
  });
  const health = options.health ?? new LocalHealthState();
  health.configurationLoaded();
  const operations = options.operations ?? new ServiceOperations();
  const storage = openStorage(config, clock, health);
  let generalHttp: HttpClient | undefined;
  let accountHttp: HttpClient | undefined;
  try {
    const retryPolicy = {
      maxAttempts: config.http.retry.max_attempts,
      baseDelayMs: config.http.retry.base_delay_ms,
      maxDelayMs: config.http.retry.max_delay_ms,
      jitterRatio: config.http.retry.jitter_ratio,
    };
    generalHttp = createHttpClient({
      clock,
      sleep,
      timeoutMs: config.http.timeout_ms,
      userAgent: config.http.user_agent,
      retryPolicy,
      logger: logger.child({ component: "http" }),
    });
    if (accountConfigured(config)) {
      accountHttp = createHttpClient({
        clock,
        sleep,
        timeoutMs: config.http.timeout_ms,
        userAgent: config.http.user_agent,
        retryPolicy: { ...retryPolicy, maxAttempts: 1 },
        logger: logger.child({ component: "account-http" }),
      });
    }
    const hnPublic = createHnPublicApi({ baseUrl: config.hn.api_base_url, http: generalHttp });
    const account = options.adapters?.account ?? (accountHttp === undefined ? undefined : createHnAccount({
      baseUrl: config.hn.web_base_url,
      http: accountHttp,
      clock,
      sleep,
      username: config.hn.username!,
      sessionCookie: secrets.hnSessionCookie!,
      maxRequestsPerMinute: config.hn.max_requests_per_minute,
      flagReadbackEnabled: config.hn.flag_readback_enabled,
    }));
    const fetcher = createArticleFetcher({
      http: generalHttp,
      clock,
      sleep,
      timeoutMs: config.article.timeout_ms,
      dnsTimeoutMs: config.article.dns_timeout_ms,
      maxResponseBytes: config.article.max_response_bytes,
      maxRedirects: config.article.max_redirects,
      allowedProtocols: config.article.allowed_protocols,
      allowedPorts: config.article.allowed_ports,
    });
    const articles = options.adapters?.articles ?? createArticleReader({
      fetcher,
      maxContentChars: config.article.max_content_chars,
      maxInputBytes: config.article.max_response_bytes,
      now: clock.now,
    });
    const llm = options.adapters?.llm ?? createOpenAiCompatibleLlm({
      baseUrl: config.llm.base_url,
      apiKey: secrets.llmApiKey,
      timeoutMs: config.llm.timeout_ms,
      maxRetries: config.llm.max_retries,
      maxOutputTokens: config.llm.max_output_tokens,
    });
    const integrations = new IntegrationHealthState(account !== undefined);
    const accessControl = createAccessControl({
      accessToken: secrets.accessToken,
      store: storage.store.accessSessions as AccessSessionStore,
      clock,
      sessionTtlSeconds: config.auth.session_ttl_seconds,
      loginMaxAttempts: config.auth.login_max_attempts,
      loginWindowSeconds: config.auth.login_window_seconds,
    });
    const ingestion = createHnIngestion({
      api: hnPublic,
      ...(account === undefined ? {} : { account }),
      store: storage.store,
      jobs: storage.jobs,
      clock,
      bootstrapRankVersion: readerAppBootstrapRankVersion,
      feeds: config.ingestion.feeds,
      initialLookbackItems: config.ingestion.initial_lookback_items,
      maxItemsPerRun: config.ingestion.max_items_per_run,
      refreshBatchSize: config.ingestion.refresh_batch_size,
      refreshAfterHours: config.ingestion.refresh_after_hours,
    });
    const personalization = createPersonalization({
      store: storage.store,
      jobs: storage.jobs,
      llm: observeLlm(llm, integrations, clock),
      model: config.llm.model,
      clock,
      activityPolicy: {
        idleTimeoutMs: config.activity.idle_timeout_ms,
        minDwellMs: config.activity.min_dwell_ms,
        maxSessionGapMs: config.activity.max_session_gap_ms,
      },
      interestPolicy: {
        decayHalfLifeDays: config.interests.decay_half_life_days,
        maxInferredTopics: config.interests.max_inferred_topics,
        maxActivityEvents: config.interests.max_activity_events,
      },
      recommendationPolicy: {
        batchSize: config.recommendations.batch_size,
        maxStoriesPerRun: config.recommendations.max_stories_per_run,
        maxPromptChars: config.recommendations.max_prompt_chars,
        explorationRatio: config.recommendations.exploration_ratio,
        capturePayloads: config.debug.include_llm_payloads,
      },
      activityBatchSize: config.personalization.activity_batch_size,
      queueSyncBatchSize: config.personalization.queue_sync_batch_size,
    });
    const readerApp = createReaderApp({
      store: storage.store,
      jobs: storage.jobs,
      articles,
      ingestion,
      personalization,
      ...(account === undefined ? {} : { account }),
      queuePageSize: config.queue.page_size,
      queueMaxPageSize: config.queue.max_page_size,
      now: clock.now,
      createId: randomUUID,
    });
    const diagnostics = createDiagnostics({
      store: storage.store,
      jobs: storage.jobs,
      clock,
      sleep,
      secretValuesProvider: secrets.registry.secretValuesProvider,
      debug: {
        enabled: config.debug.enabled,
        streamIntervalMs: config.debug.stream_interval_ms,
        includeLlmPayloads: config.debug.include_llm_payloads,
      },
    });
    let closed = false;
    const closeLocal = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      let first: unknown;
      for (const close of [
        accountHttp?.close.bind(accountHttp),
        generalHttp?.close.bind(generalHttp),
        () => { storage.database.close(); },
      ]) {
        if (close === undefined) continue;
        try { await close(); } catch (error) { first ??= error; }
      }
      if (first !== undefined) throw first;
    };
    return {
      config,
      secrets,
      logger,
      clock,
      sleep,
      health,
      integrations,
      operations,
      ...storage,
      generalHttp,
      ...(accountHttp === undefined ? {} : { accountHttp }),
      hnPublic,
      ...(account === undefined ? {} : { account }),
      llm,
      accessControl,
      personalization,
      readerApp,
      diagnostics,
      closeLocal,
    };
  } catch (error) {
    operations.abort();
    try { await accountHttp?.close(); } catch { /* retain the construction failure */ }
    try { await generalHttp?.close(); } catch { /* retain the construction failure */ }
    try { storage.database.close(); } catch { /* retain the construction failure */ }
    throw error;
  }
}
