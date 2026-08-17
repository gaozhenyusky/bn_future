# Binance Futures Contract-Only Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox markers (- [ ]) for tracking.

**Goal:** Build the first independently testable vertical slice of the monitoring system: a read-only Binance USDⓈ-M USDT perpetual radar that discovers contract-only assets, evaluates closed 5m/15m candles with OI changes, stores evidence, exposes local HTTP data, and sends optional Telegram alerts.

**Architecture:** A TypeScript/Node.js 22 service owns typed Binance Futures REST and WebSocket adapters, pure metric/classification functions, a PostgreSQL repository, and a small Fastify API. Public market data is used for the first slice; X, Binance Square, DBot, Smart Money, and LP adapters will consume the same normalized signal interfaces in subsequent plans.

**Tech Stack:** Node.js 22, TypeScript, Fastify, native fetch, ws, PostgreSQL/pg, zod, pino, Vitest, tsx.

## Global Constraints

- Read-only monitoring only; do not place, cancel, modify, or simulate a Futures order.
- First version monitors Binance USDⓈ-M USDT perpetual contracts only.
- Build the contract-only universe by comparing Futures and Spot exchangeInfo; do not hardcode HEI or BANK as the universe.
- Generate primary signals only from closed 5m/15m candles.
- Use sumOpenInterestValue for the primary OI change metric and preserve raw API values.
- OI growth is not a long-only signal; classification must use price, taker flow, liquidation context, and direction-conflict states.
- PostgreSQL is the production store; the repository interface must permit an in-memory test double.
- Never log API keys, API secrets, Telegram bot tokens, raw request headers, or user credentials.
- No credentials or trade permissions are required for public market data; future private account monitoring must use read-only USER_DATA only.
- Every persisted external event must have a deterministic idempotency key and source timestamp.
- Use exponential reconnect backoff and REST gap recovery for every WebSocket consumer.
- Thresholds are configuration and backtest parameters, not execution rules.
- The project runs from /Users/gaozhenyu/Documents/ChatGPT/加密货币.

---

### Task 1: Scaffold the TypeScript service and safe configuration

**Files:**
- Create: package.json
- Create: tsconfig.json
- Create: vitest.config.ts
- Create: .env.example
- Create: src/config.ts
- Create: src/main.ts
- Create: tests/config.test.ts
- Create: README.md

**Interfaces:**
- Produces loadConfig(env: NodeJS.ProcessEnv): AppConfig.
- AppConfig contains httpHost, httpPort, databaseUrl, binanceFuturesRestBaseUrl, binanceFuturesWsBaseUrl, telegramBotToken, telegramChatId, futuresPollConcurrency, and threshold defaults.
- Runtime startup must fail with a readable configuration error when databaseUrl is missing or malformed; Telegram settings remain optional.

- [ ] **Step 1: Write the failing configuration tests**

Create tests/config.test.ts with these cases:

~~~ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("loads public Binance Futures defaults without requiring credentials", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/crypto_monitor",
    });

    expect(config.binanceFuturesRestBaseUrl).toBe("https://fapi.binance.com");
    expect(config.binanceFuturesWsBaseUrl).toBe("wss://fstream.binance.com");
    expect(config.telegramBotToken).toBeUndefined();
  });

  it("rejects an absent database URL", () => {
    expect(() => loadConfig({})).toThrow("DATABASE_URL");
  });

  it("rejects Telegram configuration when only one Telegram field is present", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/crypto_monitor",
        TELEGRAM_BOT_TOKEN: "secret-is-not-printed",
      }),
    ).toThrow("TELEGRAM_CHAT_ID");
  });
});
~~~

- [ ] **Step 2: Run the focused test to verify it fails**

Run: npm test -- --run tests/config.test.ts
Expected: FAIL because the source module and package scripts do not exist.

- [ ] **Step 3: Implement the scaffold and configuration parser**

Add the package scripts build, test, test:watch, dev, and start. Implement loadConfig with zod. Use defaults:

~~~text
HTTP_HOST=127.0.0.1
HTTP_PORT=8787
BINANCE_FUTURES_REST_BASE_URL=https://fapi.binance.com
BINANCE_FUTURES_WS_BASE_URL=wss://fstream.binance.com
FUTURES_POLL_CONCURRENCY=5
FUTURES_VOLUME_RATIO_5M=2
FUTURES_OI_DELTA_5M=0.05
FUTURES_VOLUME_RATIO_15M=1.5
FUTURES_OI_DELTA_15M=0.08
~~~

Reject malformed URLs and non-positive numeric values. Do not print the values of secret-looking variables in error messages.

- [ ] **Step 4: Run type-check and focused tests**

Run: npm test -- --run tests/config.test.ts
Run: npm run build
Expected: all focused tests pass and tsc emits no errors.

- [ ] **Step 5: Commit the scaffold**

~~~bash
git add package.json tsconfig.json vitest.config.ts .env.example src/config.ts src/main.ts tests/config.test.ts README.md
git commit -m "feat: scaffold futures radar service"
~~~

---

### Task 2: Define the domain model and contract-only universe

**Files:**
- Create: src/domain/futures.ts
- Create: src/domain/universe.ts
- Create: src/analysis/contract-only.ts
- Create: tests/contract-only.test.ts

**Interfaces:**
- FuturesSymbolInfo represents one Binance Futures symbol with symbol, pair, baseAsset, quoteAsset, contractType, status, onboardDate, deliveryDate, and price/quantity filters.
- SpotSymbolInfo represents one Binance Spot symbol with symbol, baseAsset, quoteAsset, and status.
- ContractUniverseItem extends FuturesSymbolInfo with isContractOnly, spotBaseAssetMatches, and contractOnlyReason.
- classifyContractOnly(futures: FuturesSymbolInfo, activeSpotBaseAssets: ReadonlySet<string>): ContractUniverseItem.
- buildContractUniverse(futuresSymbols: FuturesSymbolInfo[], spotSymbols: SpotSymbolInfo[]): ContractUniverseItem[].

- [ ] **Step 1: Write failing contract-only tests**

Include representative fixtures named HEIUSDT and BANKUSDT, but assert based on Spot symbol presence rather than fixture names:

~~~ts
import { describe, expect, it } from "vitest";
import { buildContractUniverse } from "../src/analysis/contract-only";

describe("contract-only classification", () => {
  it("marks a Futures base asset with no active Spot base asset as contract-only", () => {
    const result = buildContractUniverse(
      [{ symbol: "HEIUSDT", pair: "HEIUSDT", baseAsset: "HEI", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", onboardDate: 1 }],
      [],
    );

    expect(result[0].isContractOnly).toBe(true);
    expect(result[0].contractOnlyReason).toBe("NO_ACTIVE_SPOT_BASE_ASSET");
  });

  it("does not mark a Futures symbol as contract-only when an active Spot pair exists", () => {
    const result = buildContractUniverse(
      [{ symbol: "BANKUSDT", pair: "BANKUSDT", baseAsset: "BANK", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", onboardDate: 1 }],
      [{ symbol: "BANKUSDT", baseAsset: "BANK", quoteAsset: "USDT", status: "TRADING" }],
    );

    expect(result[0].isContractOnly).toBe(false);
    expect(result[0].spotBaseAssetMatches).toEqual(["BANK"]);
  });

  it("excludes non-trading or non-perpetual Futures symbols from the default universe", () => {
    const result = buildContractUniverse(
      [
        { symbol: "OLDUSDT", pair: "OLDUSDT", baseAsset: "OLD", quoteAsset: "USDT", contractType: "PERPETUAL", status: "CLOSE", onboardDate: 1 },
        { symbol: "QUARTERUSDT", pair: "QUARTERUSDT", baseAsset: "QUARTER", quoteAsset: "USDT", contractType: "CURRENT_QUARTER", status: "TRADING", onboardDate: 1 },
      ],
      [],
    );

    expect(result).toEqual([]);
  });
});
~~~

- [ ] **Step 2: Run the focused test and verify failure**

Run: npm test -- --run tests/contract-only.test.ts
Expected: FAIL because the domain types and classification functions do not exist.

- [ ] **Step 3: Implement normalized domain types and classification**

Keep raw numeric API values as strings at connector boundaries. Convert to number only in metric functions. Filter the default universe to status TRADING, contractType PERPETUAL, and quoteAsset USDT. Build the active Spot base asset set from status TRADING symbols only. Preserve excluded symbols in the raw source event store, not in the active radar list.

- [ ] **Step 4: Run the focused tests and build**

Run: npm test -- --run tests/contract-only.test.ts
Run: npm run build
Expected: PASS and no type errors.

- [ ] **Step 5: Commit the domain slice**

~~~bash
git add src/domain/futures.ts src/domain/universe.ts src/analysis/contract-only.ts tests/contract-only.test.ts
git commit -m "feat: classify Binance contract-only symbols"
~~~

---

### Task 3: Implement public Binance Futures and Spot REST adapters

**Files:**
- Create: src/connectors/binance-http.ts
- Create: src/connectors/binance-futures-rest.ts
- Create: src/connectors/binance-response.ts
- Create: tests/binance-futures-rest.test.ts

**Interfaces:**
- BinanceHttpClient.getJson<T>(path: string, query: Record<string, string | number | undefined>): Promise<T>.
- BinanceFuturesRestClient.getFuturesExchangeInfo(): Promise<FuturesSymbolInfo[]>.
- BinanceFuturesRestClient.getSpotExchangeInfo(): Promise<SpotSymbolInfo[]>.
- BinanceFuturesRestClient.getKlines(symbol: string, interval: "5m" | "15m", limit: number): Promise<FuturesCandle[]>;
- BinanceFuturesRestClient.getOpenInterestHistory(symbol: string, period: "5m" | "15m", limit: number): Promise<OpenInterestSnapshot[]>;
- BinanceFuturesRestClient.getTakerLongShortRatio(symbol: string, period: "5m" | "15m", limit: number): Promise<TakerFlowSnapshot[]>;
- BinanceFuturesRestClient.getFundingRateHistory(symbol: string, limit: number): Promise<FundingRateSnapshot[]>.
- All methods use public Binance endpoints and never add an API key header.

- [ ] **Step 1: Write failing adapter tests with mocked fetch**

Test correct paths and normalization for:
- /fapi/v1/exchangeInfo;
- /api/v3/exchangeInfo;
- /fapi/v1/klines;
- /futures/data/openInterestHist;
- /futures/data/takerlongshortRatio;
- /fapi/v1/income with an intentionally omitted authenticated call to prove no private endpoint is used.

Assert that invalid JSON and HTTP 429 become typed BinanceHttpError values with status and retryAfterMs, without including request headers or credentials.

- [ ] **Step 2: Run the focused tests to verify failure**

Run: npm test -- --run tests/binance-futures-rest.test.ts
Expected: FAIL because the HTTP client and adapter do not exist.

- [ ] **Step 3: Implement the HTTP client and endpoint mapping**

Use native fetch with an AbortController timeout of 8 seconds. Retry only network failures, 408, 429, and 5xx responses, with capped exponential backoff. Do not retry 4xx validation errors. Parse the Binance kline tuple into FuturesCandle, preserving the original raw payload and the closed flag when available. Map Open Interest Statistics fields sumOpenInterest and sumOpenInterestValue to OpenInterestSnapshot.

- [ ] **Step 4: Run tests and build**

Run: npm test -- --run tests/binance-futures-rest.test.ts
Run: npm run build
Expected: PASS and no type errors.

- [ ] **Step 5: Commit the REST adapter**

~~~bash
git add src/connectors/binance-http.ts src/connectors/binance-futures-rest.ts src/connectors/binance-response.ts tests/binance-futures-rest.test.ts
git commit -m "feat: add public Binance Futures market data client"
~~~

---

### Task 4: Add Kline WebSocket ingestion, OI polling, and gap recovery

**Files:**
- Create: src/connectors/binance-futures-ws.ts
- Create: src/ingest/futures-pipeline.ts
- Create: src/ingest/rate-limited-queue.ts
- Create: tests/binance-futures-ws.test.ts
- Create: tests/futures-pipeline.test.ts

**Interfaces:**
- KlineStream.start(symbols: string[], intervals: readonly ["5m", "15m"]): Promise<void>.
- KlineStream.onCandle(handler: (candle: FuturesCandle) => Promise<void>): void.
- KlineStream.stop(): Promise<void>.
- OiPoller.pollClosedCandle(candle: FuturesCandle): Promise<MarketContext>.
- FuturesPipeline.handleCandle(candle: FuturesCandle): Promise<void>.
- MarketContext contains the matching OI snapshot, taker flow, funding rate, and data timestamps.

- [ ] **Step 1: Write failing WebSocket and pipeline tests**

Use a fake WebSocket that can emit:
- a live kline with closed=false;
- a closed 5m kline;
- a closed 15m kline;
- a malformed message;
- a close event followed by a reconnect.

Assert:
- live candles are stored as updates but do not invoke classification;
- closed candles invoke OI polling exactly once per symbol, interval, and openTime;
- malformed messages are ignored and logged without raw headers;
- reconnect delay is capped and uses exponential backoff;
- a REST backfill is requested when the last persisted close time is behind the incoming candle by more than one interval.

- [ ] **Step 2: Run focused tests to verify failure**

Run: npm test -- --run tests/binance-futures-ws.test.ts tests/futures-pipeline.test.ts
Expected: FAIL because the stream and pipeline are absent.

- [ ] **Step 3: Implement the stream and bounded poll queue**

Use multiplexed Binance Futures kline streams. Subscribe only to the current contract-only universe, refresh the subscription set when exchangeInfo changes, and split subscriptions into configured chunks. Respond to server ping/pong, treat a missing heartbeat or closed socket as unhealthy, reconnect with delays 1s, 2s, 4s, 8s, 16s, capped at 30s, and reset the delay after a stable connection.

Use a bounded queue with concurrency from futuresPollConcurrency. Deduplicate OI work by symbol + interval + candle openTime. After a closed candle, fetch Open Interest Statistics for the same period and Taker Buy/Sell Volume for context. If the endpoint does not yet expose the latest closed period, retry the poll twice with 2s and 5s delays, then mark the signal context incomplete rather than fabricating values.

- [ ] **Step 4: Add REST gap recovery**

On startup and after reconnect, fetch the last 50 closed 5m and 15m candles for each active contract-only symbol. Compare open times with the repository checkpoint and process missing candles in order. Store source timestamps separately from local received timestamps.

- [ ] **Step 5: Run tests and build**

Run: npm test -- --run tests/binance-futures-ws.test.ts tests/futures-pipeline.test.ts
Run: npm run build
Expected: PASS and no type errors.

- [ ] **Step 6: Commit ingestion**

~~~bash
git add src/connectors/binance-futures-ws.ts src/ingest/futures-pipeline.ts src/ingest/rate-limited-queue.ts tests/binance-futures-ws.test.ts tests/futures-pipeline.test.ts
git commit -m "feat: ingest Futures candles with OI context"
~~~

---

### Task 5: Implement 5m/15m metrics and signal classification

**Files:**
- Create: src/analysis/futures-metrics.ts
- Create: src/analysis/futures-classifier.ts
- Create: tests/futures-metrics.test.ts
- Create: tests/futures-classifier.test.ts

**Interfaces:**
- computeFuturesMetrics(candle: FuturesCandle, baseline: readonly FuturesCandle[], context: MarketContext): FuturesMetrics.
- classifyFuturesSignal(metrics: FuturesMetrics, thresholds: FuturesThresholds): FuturesSignal | null.
- FuturesMetrics contains volumeRatio, volumePercentile, oiValueDelta, oiUnitDelta, priceReturn, takerImbalance, liquidationRatio, priceOiAlignment, dataCompleteness, and contractOnlyRisk.
- FuturesSignal contains signalType, severity, confidence, explanation, evidence, symbol, interval, candleOpenTime, and thresholdVersion.

- [ ] **Step 1: Write failing metric tests**

Cover:
- volume ratio against the median of the previous 20 same-interval candles;
- zero-baseline handling with dataCompleteness=INSUFFICIENT_BASELINE;
- OI value delta and unit delta;
- taker imbalance when buyVol + sellVol is zero;
- contract-only risk when no Spot base asset exists;
- incomplete context when OI or taker flow is absent.

- [ ] **Step 2: Run focused tests to verify failure**

Run: npm test -- --run tests/futures-metrics.test.ts
Expected: FAIL because metric functions do not exist.

- [ ] **Step 3: Write the classifier tests**

Assert the matrix:
- positive price return + positive OI delta + high volume produces LONG_BUILDUP_CANDIDATE;
- negative price return + positive OI delta + high volume produces SHORT_BUILDUP_CANDIDATE;
- positive price return + negative OI delta produces SHORT_COVERING;
- negative price return + negative OI delta produces LONG_LIQUIDATION;
- high volume with flat OI produces no directional signal and a turnover explanation;
- missing baseline or incomplete context produces no hot-direction signal;
- conflicting 5m and 15m signals are represented as FUTURES_OI_CONFLICT by the aggregation layer.

- [ ] **Step 4: Run classifier tests to verify failure**

Run: npm test -- --run tests/futures-classifier.test.ts
Expected: FAIL because the classifier does not exist.

- [ ] **Step 5: Implement pure functions**

Use the configurable defaults from AppConfig. Use absolute OI delta thresholds for surge detection, but retain the signed delta for classification. Emit risk signals when contractOnlyRisk is high, even when the directional signal is suppressed. Never describe OI growth as net long growth without supporting taker and price evidence.

- [ ] **Step 6: Run all analysis tests and build**

Run: npm test -- --run tests/futures-metrics.test.ts tests/futures-classifier.test.ts
Run: npm run build
Expected: PASS and no type errors.

- [ ] **Step 7: Commit analysis**

~~~bash
git add src/analysis/futures-metrics.ts src/analysis/futures-classifier.ts tests/futures-metrics.test.ts tests/futures-classifier.test.ts
git commit -m "feat: classify Futures volume and OI structures"
~~~

---

### Task 6: Add PostgreSQL schema, repository, and idempotent persistence

**Files:**
- Create: src/storage/migrations/001_futures_radar.sql
- Create: src/storage/db.ts
- Create: src/storage/futures-repository.ts
- Create: src/storage/in-memory-futures-repository.ts
- Create: tests/futures-repository.test.ts
- Modify: package.json to add db:migrate

**Interfaces:**
- FuturesRepository.upsertContracts(items: readonly ContractUniverseItem[]): Promise<void>.
- FuturesRepository.getClosedCandleBaseline(symbol: string, interval: "5m" | "15m", limit: number): Promise<FuturesCandle[]>.
- FuturesRepository.saveCandle(candle: FuturesCandle): Promise<void>.
- FuturesRepository.saveMarketContext(context: MarketContext): Promise<void>.
- FuturesRepository.saveMetrics(metrics: FuturesMetrics): Promise<void>.
- FuturesRepository.saveSignal(signal: FuturesSignal): Promise<void>.
- FuturesRepository.getCheckpoint(stream: string): Promise<number | null>.
- FuturesRepository.setCheckpoint(stream: string, timestamp: number): Promise<void>.
- The in-memory repository implements the same interface for unit tests.

- [ ] **Step 1: Write repository behavior tests**

Test:
- saving the same candle twice does not create a duplicate;
- saving the same signal twice uses its deterministic signal key;
- baseline returns only closed candles for the requested symbol and interval in chronological order;
- checkpoints survive a read/write cycle in the in-memory repository;
- source timestamps and received timestamps remain distinct.

- [ ] **Step 2: Run focused tests to verify failure**

Run: npm test -- --run tests/futures-repository.test.ts
Expected: FAIL because repository implementations do not exist.

- [ ] **Step 3: Implement SQL schema and in-memory repository**

Create tables futures_contracts, futures_candles, futures_oi_snapshots, futures_flow_metrics, futures_signals, source_events, and connector_checkpoints. Add unique constraints:
- futures_contracts: symbol;
- futures_candles: symbol + interval + open_time;
- futures_oi_snapshots: symbol + interval + timestamp;
- futures_signals: symbol + interval + candle_open_time + signal_type + threshold_version.

Use parameterized pg queries. Store raw numeric values as numeric/text columns with a documented choice; store derived metrics as double precision. Do not use SQL string interpolation for symbol or interval.

- [ ] **Step 4: Add migration command**

Implement db:migrate to apply numbered SQL files in lexical order and record them in schema_migrations. The command must fail closed when DATABASE_URL is absent and must not print it.

- [ ] **Step 5: Run repository tests and build**

Run: npm test -- --run tests/futures-repository.test.ts
Run: npm run build
Expected: PASS and no type errors. If DATABASE_URL is configured, run npm run db:migrate and confirm the migration records exist.

- [ ] **Step 6: Commit persistence**

~~~bash
git add src/storage/migrations/001_futures_radar.sql src/storage/db.ts src/storage/futures-repository.ts src/storage/in-memory-futures-repository.ts tests/futures-repository.test.ts package.json
git commit -m "feat: persist futures radar evidence"
~~~

---

### Task 7: Expose the local radar API and optional Telegram alerts

**Files:**
- Create: src/http/app.ts
- Create: src/http/futures-routes.ts
- Create: src/alerts/telegram.ts
- Create: tests/futures-routes.test.ts
- Create: tests/telegram-alert.test.ts
- Modify: src/main.ts

**Interfaces:**
- buildApp(deps: { repository: FuturesRepository; health: HealthState }): FastifyInstance.
- GET /health returns { status: "ok" | "degraded", connectors: ... }.
- GET /api/futures/radar accepts interval, contractOnly, minSeverity, and limit query parameters.
- GET /api/futures/signals accepts symbol, interval, from, to, and limit query parameters.
- TelegramNotifier.send(signal: FuturesSignal): Promise<"sent" | "skipped">.

- [ ] **Step 1: Write failing route and notification tests**

Test:
- /health returns degraded when the Futures stream is disconnected;
- /api/futures/radar rejects unsupported intervals and negative limits with 400;
- /api/futures/radar returns contract-only items in stable severity order;
- /api/futures/signals returns evidence and thresholdVersion;
- Telegram is skipped when both Telegram settings are absent;
- Telegram sends JSON with a timeout when configured and converts non-2xx responses to a typed error without logging the token.

- [ ] **Step 2: Run focused tests to verify failure**

Run: npm test -- --run tests/futures-routes.test.ts tests/telegram-alert.test.ts
Expected: FAIL because the HTTP app and notifier do not exist.

- [ ] **Step 3: Implement Fastify routes and notifier**

Use zod or Fastify schemas for query validation. Return only normalized fields and evidence links; do not expose raw secrets or raw provider headers. The Telegram message must show symbol, interval, price direction, volume ratio, OI value delta, taker imbalance, contract-only risk, signal explanation, data completeness, and a “read-only observation” label.

- [ ] **Step 4: Run API tests and build**

Run: npm test -- --run tests/futures-routes.test.ts tests/telegram-alert.test.ts
Run: npm run build
Expected: PASS and no type errors.

- [ ] **Step 5: Commit the API slice**

~~~bash
git add src/http/app.ts src/http/futures-routes.ts src/alerts/telegram.ts tests/futures-routes.test.ts tests/telegram-alert.test.ts src/main.ts
git commit -m "feat: expose futures radar and Telegram alerts"
~~~

---

### Task 8: Wire the service, add smoke mode, and verify the vertical slice

**Files:**
- Create: src/services/futures-radar-service.ts
- Create: scripts/futures-radar-smoke.ts
- Create: tests/futures-radar-service.test.ts
- Modify: src/main.ts
- Modify: README.md

**Interfaces:**
- FuturesRadarService.start(): Promise<void>.
- FuturesRadarService.stop(): Promise<void>.
- FuturesRadarService.refreshUniverse(): Promise<void>.
- FuturesRadarService.handleClosedCandle(candle: FuturesCandle): Promise<void>.
- Smoke mode must execute exactly one public Binance Futures exchangeInfo fetch, summarize the current USDT perpetual snapshot only, and print only counts plus non-sensitive symbol names; it must not attempt Spot cross-checking or contract-only classification.

- [ ] **Step 1: Write the service orchestration tests**

Use fake REST, fake stream, in-memory repository, and fake notifier. Test:
- start refreshes the universe before opening the stream;
- only contract-only symbols are subscribed;
- a closed candle is persisted, enriched, scored, persisted as a signal, and sent once;
- repeated delivery of the same candle is idempotent;
- stop closes the stream and repository resources;
- a degraded OI response saves the candle but emits no directional signal.

- [ ] **Step 2: Run the focused test to verify failure**

Run: npm test -- --run tests/futures-radar-service.test.ts
Expected: FAIL because the service is not wired.

- [ ] **Step 3: Implement orchestration and smoke mode**

Wire the REST client, stream, repository, metrics/classifier, Fastify app, and Telegram notifier through dependency injection. Refresh exchangeInfo on a fixed interval. On every closed candle, load the 20-candle baseline, fetch OI/flow context, compute metrics, persist evidence, classify, and notify only on a new deterministic signal key.

Add scripts:
- npm run dev;
- npm run start;
- npm run futures:smoke;
- npm run db:migrate.

- [ ] **Step 4: Run the full test suite and static verification**

Run: npm test -- --run
Run: npm run build
Run: npm run futures:smoke
Expected:
- all tests pass;
- build passes;
- smoke mode either prints a public Futures-only USDT perpetual snapshot summary or exits with a clear network error;
- no secret-looking value appears in test or smoke output.

- [ ] **Step 5: Verify with a local PostgreSQL instance when available**

Run: npm run db:migrate
Run: npm run futures:smoke
Run: npm run start
Check: curl http://127.0.0.1:8787/health
Check: curl "http://127.0.0.1:8787/api/futures/radar?interval=5m&contractOnly=true&limit=20"
Expected: health is ok or degraded with connector details, the radar endpoint returns JSON, and no write/trade endpoint exists.

- [ ] **Step 6: Commit the integrated vertical slice**

~~~bash
git add src/services/futures-radar-service.ts scripts/futures-radar-smoke.ts tests/futures-radar-service.test.ts src/main.ts README.md package.json
git commit -m "feat: run read-only futures radar vertical slice"
~~~

## Self-Review Checklist

- Spec coverage: Tasks 1–2 cover configuration and contract-only discovery; Tasks 3–4 cover Binance Futures/Spot market data, 5m/15m Kline, OI, flow, reconnect, and gap recovery; Task 5 covers all required price/OI structures; Task 6 covers persistence and idempotency; Task 7 covers local API and Telegram; Task 8 covers orchestration, smoke verification, and runtime boundaries.
- Completeness scan: no unresolved markers or unspecified implementation steps are used.
- Type consistency: FuturesCandle, MarketContext, FuturesMetrics, FuturesSignal, FuturesRepository, and FuturesRadarService are defined before downstream tasks consume them.
- Scope boundary: X, Binance Square, DBot, Smart Money, LP, and the full dashboard remain separate follow-up adapters after this vertical slice; the shared source event and signal interfaces preserve that extension path.
