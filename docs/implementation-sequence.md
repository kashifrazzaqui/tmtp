# Implementation Sequence

> Expanded from `/docs/implementation-order.yaml`. The YAML is canonical; this file is a human-readable view.

## Batch A — Tier 0, no internal dependencies

| Lib | Path | New/OSS | Hosted? | Dependencies |
|-----|------|---------|---------|--------------|
| article-extractor | /libs/article-extractor/ | Wraps Mozilla Readability, jsdom, and DOMPurify | `article-reader` jobs in `services/personal-reader` | None |
| clock | /libs/clock/ | New; Node runtime | Callable in process and in tests | None |
| config | /libs/config/ | New wrapper around Zod | `services/personal-reader` startup | None |
| database | /libs/database/ | New wrapper around better-sqlite3; handwritten migrations | `services/personal-reader`; one shared connection | None |
| domain | /libs/domain/ | New domain model using Zod | Callable-only; shared in process | None |
| llm-interface | /libs/llm-interface/ | New TypeScript port; no runtime dependency | Implemented by `llm-openai-compatible` | None |
| logging | /libs/logging/ | New wrapper around Pino | `services/personal-reader` and in-process compositions | None |
| retry | /libs/retry/ | New wrapper around p-retry | `http-client`, job adapters, and service | None |

## Batch B — Tier 1, depends on Batch A

| Lib | Path | New/OSS | Hosted? | Dependencies |
|-----|------|---------|---------|--------------|
| access-control | /libs/access-control/ | New; Node Web Crypto | Service HTTP authentication hook | `clock` |
| activity | /libs/activity/ | New pure TypeScript | `reader-app` and `personalization` | `clock`, `domain` |
| http-client | /libs/http-client/ | New wrapper around Undici | HN clients and `article-fetcher` | `clock`, `logging`, `retry` |
| interests | /libs/interests/ | New pure TypeScript | `personalization` and `recommendations` | `domain` |
| job-queue | /libs/job-queue/ | New; shared SQLite database | Service background worker loop | `clock`, `database`, `domain` |
| llm-openai-compatible | /libs/llm-openai-compatible/ | New adapter around OpenAI Node SDK | Service; injected into recommendations and startup checks | `llm-interface` |
| queue | /libs/queue/ | New pure TypeScript | `personalization` and `reader-app` | `domain` |
| reader-store | /libs/reader-store/ | New; handwritten SQL repositories | Shared by all service compositions | `database`, `domain` |
| scheduler | /libs/scheduler/ | New wrapper around Croner | Service lifecycle | `clock`, `logging` |

## Batch C — Tier 2, depends on Batch B

| Lib | Path | New/OSS | Hosted? | Dependencies |
|-----|------|---------|---------|--------------|
| article-fetcher | /libs/article-fetcher/ | New; uses ip-address and Undici controls | `article-reader` jobs | `clock`, `http-client` |
| diagnostics | /libs/diagnostics/ | New composition | Service health, debug API/SSE, and UI drawer | `clock`, `domain`, `job-queue`, `reader-store` |
| hn-account | /libs/hn-account/ | New unofficial HTML adapter using Cheerio | `reader-app` and optional ingestion reconciliation | `clock`, `domain`, `http-client` |
| hn-public-api | /libs/hn-public-api/ | New client over official HN API | `hn-ingestion` | `domain`, `http-client` |
| recommendations | /libs/recommendations/ | New; provider access through `llm-interface` | Personalization jobs and reader-app explanation queries | `domain`, `interests`, `llm-interface`, `queue` |

## Batch D — Tier 3, depends on Batch C

| Lib | Path | New/OSS | Hosted? | Dependencies |
|-----|------|---------|---------|--------------|
| article-reader | /libs/article-reader/ | New composition | Reader-app article jobs and story queries | `article-extractor`, `article-fetcher`, `domain` |
| hn-ingestion | /libs/hn-ingestion/ | New composition | Reader-app ingestion jobs | `clock`, `domain`, `hn-account`, `hn-public-api`, `interests`, `job-queue`, `reader-store` |
| personalization | /libs/personalization/ | New composition | Reader-app commands and background jobs | `activity`, `clock`, `domain`, `interests`, `job-queue`, `llm-interface`, `queue`, `reader-store`, `recommendations` |

## Batch E — Tier 4, depends on Batch D

| Lib | Path | New/OSS | Hosted? | Dependencies |
|-----|------|---------|---------|--------------|
| reader-app | /libs/reader-app/ | New transport-free application composition | `services/personal-reader` | `activity`, `article-reader`, `domain`, `hn-account`, `hn-ingestion`, `job-queue`, `personalization`, `queue`, `reader-store` |

## Batch F — Tier 5, depends on Batch E

| Lib | Path | New/OSS | Hosted? | Dependencies |
|-----|------|---------|---------|--------------|
| personal-reader | /services/personal-reader/ | New service using Fastify, React, Vite, MUI, TanStack Query, and React Router | Process entry point | All 26 libraries; direct hosting and lifecycle wiring are listed in the service spec |

Each batch must pass its package tests and the workflow acceptance flows available at that layer before implementation proceeds to the next batch.
