import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type AppConfig } from "./config";
import { TelegramNotifier } from "./alerts/telegram";
import { BitgetMarketRestClient } from "./connectors/bitget-market-rest";
import { BinanceFuturesRestClient } from "./connectors/binance-futures-rest";
import { BinanceWeb3SkillsConnector } from "./connectors/binance-web3-skills";
import { GateFuturesRestClient } from "./connectors/gate-futures-rest";
import { KlineStream, type KlineStreamConnectionEvent } from "./connectors/binance-futures-ws";
import { buildApp, type HealthState } from "./http/app";
import { OiPoller } from "./ingest/futures-pipeline";
import { BitgetReferenceService } from "./services/bitget-reference-service";
import { FuturesRadarService } from "./services/futures-radar-service";
import { FuturesRetentionService } from "./services/futures-retention-service";
import { OnchainGemService } from "./services/onchain-gem-service";
import { createMysqlPool } from "./storage/db";
import { createMysqlFuturesRepository } from "./storage/futures-repository";
import { DEFAULT_FUNDING_RATE } from "./domain/execution-pnl";
import { MysqlOnchainGemRepository } from "./storage/onchain-gem-repository";
import { MysqlExecutionAuditRepository, MysqlExecutionPositionStore, MysqlExecutionRecordRepository } from "./storage/execution-repository";
import { MysqlExecutionSettingsRepository } from "./storage/execution-settings-repository";
import { ExecutionSettingsService } from "./services/execution-settings-service";
import { AlphaMarketService } from "./services/alpha-market-service";
import { sanitizeErrorMessage } from "./utils/sanitize-error";
import { DemoExecutionRiskPolicy } from "./execution/risk-policy";
import { ExecutionEngine } from "./execution/execution-engine";
import { toExecutionSignal, toAmbushExecutionSignal } from "./execution/futures-signal-adapter";
import { BinanceDemoExecutionAdapter, BinanceProductionExecutionAdapter } from "./execution/binance-demo-adapter";
import type { ExecutionAdapter, ExecutionMode, ExecutionOrder } from "./execution/types";

export type Runtime = {
  config: AppConfig;
  health: HealthState;
  service: Pick<FuturesRadarService, "start" | "stop">;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type ConnectorHealthController = {
  markConnected(): void;
  markDegraded(message: string): void;
  markDisconnected(message: string): void;
};

type RuntimeConfig = Pick<AppConfig, "httpHost" | "httpPort">;

type RuntimeApp = {
  listen(options: { host: string; port: number }): Promise<string | void>;
  close(): Promise<void | undefined>;
};

type HealthTrackedStream = {
  onCandle(handler: Parameters<KlineStream["onCandle"]>[0]): void;
  start(symbols: string[], intervals: readonly ["5m", "15m"]): Promise<void>;
  stop(): Promise<void>;
  onConnectionState?(handler: (event: KlineStreamConnectionEvent) => void): void;
};

type RuntimeDependencies = {
  config: RuntimeConfig;
  health: HealthState;
  service: Pick<FuturesRadarService, "start" | "stop">;
  app: RuntimeApp;
  closePool: () => Promise<void>;
};

type DirectEntryOptions = {
  env?: NodeJS.ProcessEnv;
  startRuntime?: (env: NodeJS.ProcessEnv) => Promise<Runtime>;
  consoleLike?: Pick<typeof console, "error">;
  processLike?: Pick<NodeJS.Process, "exitCode" | "once">;
};

const ALLOWED_BINANCE_NON_PRODUCTION_EXECUTION_BASE_URLS = new Set([
  "https://demo-fapi.binance.com",
  "https://testnet.binancefuture.com",
]);

const BINANCE_PRODUCTION_FUTURES_BASE_URL = "https://fapi.binance.com";

function isAllowedBinanceNonProductionExecutionBaseUrl(value: string | undefined): value is string {
  if (!value) return false;
  return ALLOWED_BINANCE_NON_PRODUCTION_EXECUTION_BASE_URLS.has(value.replace(/\/+$/, ""));
}

/** 实盘执行端点白名单：只允许 fapi.binance.com，防止误配到其他环境产生真实资金交易 */
function isAllowedBinanceProductionExecutionBaseUrl(value: string | undefined): value is string {
  if (!value) return false;
  return value.replace(/\/+$/, "") === BINANCE_PRODUCTION_FUTURES_BASE_URL;
}

class SimulationExecutionAdapter implements ExecutionAdapter {
  private sequence = 0;

  private order(input: Omit<ExecutionOrder, "orderId">): ExecutionOrder {
    this.sequence += 1;
    return { ...input, orderId: `simulation-${this.sequence}` };
  }

  async placeEntryOrder(input: {
    symbol: string; clientOrderId: string; quantity: number; entryPrice: number;
    leverage: number; notionalUsdt: number; marginUsdt: number; mode: ExecutionMode;
  }): Promise<ExecutionOrder> {
    return this.order({ symbol: input.symbol, clientOrderId: input.clientOrderId, quantity: input.quantity, price: input.entryPrice, status: "FILLED", side: "BUY", reduceOnly: false, type: "ENTRY" });
  }

  async placeReduceOnlyOrder(input: { symbol: string; clientOrderId: string; quantity: number; price: number; reason: "TAKE_PROFIT" | "STOP_LOSS" | "REVERSAL" | "MAX_HOLD_REACHED" | "CIRCUIT_BREAKER" }): Promise<ExecutionOrder> {
    return this.order({ symbol: input.symbol, clientOrderId: input.clientOrderId, quantity: input.quantity, price: input.price, status: "FILLED", side: "SELL", reduceOnly: true, type: input.reason });
  }

  async placeProtectionOrder(input: { symbol: string; clientOrderId: string; quantity: number; stopPrice: number }): Promise<ExecutionOrder> {
    return this.order({ symbol: input.symbol, clientOrderId: input.clientOrderId, quantity: input.quantity, price: input.stopPrice, status: "OPEN", side: "SELL", reduceOnly: true, type: "PROTECTION" });
  }

  async replaceProtectionOrder(input: { symbol: string; oldOrderId: string; clientOrderId: string; quantity: number; stopPrice: number }): Promise<ExecutionOrder> {
    return this.placeProtectionOrder(input);
  }
}

function isExecutedDirectly(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url);
}

function createOnceAsync(action: () => Promise<void>): () => Promise<void> {
  let promise: Promise<void> | undefined;

  return async () => {
    if (!promise) {
      promise = action();
    }

    await promise;
  };
}

async function bestEffort(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {
    // best effort cleanup only
  }
}

export function createHealthTrackedStream(
  stream: HealthTrackedStream,
  health: HealthState,
): Pick<FuturesRadarService, never> & {
  onCandle(handler: Parameters<KlineStream["onCandle"]>[0]): void;
  start(symbols: string[], intervals: readonly ["5m", "15m"]): Promise<void>;
  stop(): Promise<void>;
} {
  let expectedChunkCount: number | null = null;
  let zeroSymbolStart = false;
  const connectedChunks = new Set<number>();

  const updateHealth = () => {
    if (zeroSymbolStart) {
      health.connectors.futuresStream.status = "connected";
      return;
    }

    if (expectedChunkCount === null || expectedChunkCount === 0) {
      health.connectors.futuresStream.status = "disconnected";
      return;
    }

    health.connectors.futuresStream.status =
      connectedChunks.size === expectedChunkCount ? "connected" : "disconnected";
  };

  stream.onConnectionState?.((event) => {
    zeroSymbolStart = false;
    expectedChunkCount = event.chunkCount;
    if (event.status === "connected") {
      connectedChunks.add(event.chunkIndex);
    } else {
      connectedChunks.delete(event.chunkIndex);
    }
    updateHealth();
  });

  return {
    onCandle(handler) {
      stream.onCandle(handler);
    },
    async start(symbols, intervals) {
      zeroSymbolStart = false;
      expectedChunkCount = symbols.length === 0 ? 0 : null;
      connectedChunks.clear();
      health.connectors.futuresStream.status = "disconnected";

      await stream.start(symbols, intervals);

      if (symbols.length === 0) {
        zeroSymbolStart = true;
        updateHealth();
      }
    },
    async stop() {
      zeroSymbolStart = false;
      expectedChunkCount = 0;
      connectedChunks.clear();

      await stream.stop();
      health.connectors.futuresStream.status = "disconnected";
    },
  };
}

export function createConnectorHealthController(
  health: HealthState,
  connectorName: string,
  now: () => number = () => Date.now(),
): ConnectorHealthController {
  return {
    markConnected() {
      health.connectors[connectorName] = {
        status: "connected",
        updatedAt: now(),
      };
    },
    markDegraded(message: string) {
      health.connectors[connectorName] = {
        status: "degraded",
        message: sanitizeErrorMessage(message),
        updatedAt: now(),
      };
    },
    markDisconnected(message: string) {
      health.connectors[connectorName] = {
        status: "disconnected",
        message: sanitizeErrorMessage(message),
        updatedAt: now(),
      };
    },
  };
}

export function createRuntimeFromDependencies(deps: RuntimeDependencies): Runtime {
  const closeApp = createOnceAsync(() => deps.app.close());
  const closePool = createOnceAsync(deps.closePool);

  const cleanupAfterStartupFailure = async () => {
    await bestEffort(() => deps.service.stop());
    await bestEffort(closeApp);
    await bestEffort(closePool);
  };

  return {
    config: deps.config as AppConfig,
    health: deps.health,
    service: deps.service,
    async start() {
      try {
        await deps.app.listen({
          host: deps.config.httpHost,
          port: deps.config.httpPort,
        });
      } catch (error) {
        await cleanupAfterStartupFailure();
        throw error;
      }

      // The first exchange refresh and historical backfill can take tens of
      // seconds when Binance rate-limits or returns a large contract universe.
      // Keep the read-only HTTP API available while that work initializes.
      void deps.service.start().catch(() => undefined);
    },
    async stop() {
      let firstError: unknown;

      try {
        await closeApp();
      } catch (error) {
        firstError = error;
      }

      try {
        await deps.service.stop();
      } catch (error) {
        firstError ??= error;
      }

      try {
        await closePool();
      } catch (error) {
        firstError ??= error;
      }

      if (firstError) {
        throw firstError;
      }
    },
  };
}

export function createRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  const config = loadConfig(env);
  // Skill CLIs are zero-dependency Node scripts whose global fetch ignores proxy
  // environment variables. Preload the undici proxy dispatcher into every node
  // child process so on-chain discovery can reach Binance Web3 endpoints through
  // the same BINANCE_HTTP_PROXY used by the REST and WebSocket connectors.
  const proxyUrl = config.binanceHttpProxy?.trim();
  if (proxyUrl) {
    const preloadPath = resolve(process.cwd(), "scripts/node-proxy-preload.mjs");
    if (existsSync(preloadPath) && !/\s/.test(preloadPath)) {
      const importFlag = `--import=${preloadPath}`;
      const currentOptions = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = currentOptions ? `${currentOptions} ${importFlag}` : importFlag;
    }
  }
  const demoExecutionConfigured =
    config.executionMode === "BINANCE_DEMO_TESTNET" &&
    Boolean(config.binanceDemoApiKey && config.binanceDemoApiSecret && config.binanceDemoFuturesRestBaseUrl) &&
    isAllowedBinanceNonProductionExecutionBaseUrl(config.binanceDemoFuturesRestBaseUrl);
  const productionExecutionConfigured =
    config.executionMode === "BINANCE_PRODUCTION" &&
    Boolean(config.binanceProductionApiKey && config.binanceProductionApiSecret) &&
    isAllowedBinanceProductionExecutionBaseUrl(BINANCE_PRODUCTION_FUTURES_BASE_URL);
  const executionConfigured = config.executionMode === "SIMULATION" || demoExecutionConfigured || productionExecutionConfigured;
  const health: HealthState = {
    connectors: {
      futuresStream: {
        status: "disconnected",
      },
      futuresProcessing: {
        status: "connected",
      },
      bitgetReference: {
        status: "disconnected",
      },
      execution: {
        status: executionConfigured ? "connected" : "degraded",
        message:
          config.executionMode === "SIMULATION"
            ? "simulation execution enabled"
            : demoExecutionConfigured
              ? "Binance Demo/Testnet execution adapter configured"
              : productionExecutionConfigured
                ? "Binance PRODUCTION execution adapter configured (real funds)"
                : "execution adapter requires credentials and an allowed base URL; execution disabled",
      },
    },
  };

  const pool = createMysqlPool(env);
  const closePool = createOnceAsync(async () => {
    await pool.end();
  });
  const oiFactorThresholds = {
    "5m": { oi: config.futuresOiDelta5m, volume: config.futuresVolumeRatio5m, price5m: config.futuresPriceReturn5mThreshold },
    "15m": { oi: config.futuresOiDelta15m, volume: config.futuresVolumeRatio15m, price5m: config.futuresPriceReturn5mThreshold },
  } as const;
  const repository = Object.assign(createMysqlFuturesRepository(pool, oiFactorThresholds), {
    async close() {
      await closePool();
    },
  });
  const restClient = new BinanceFuturesRestClient({
    futuresBaseUrl: config.binanceFuturesRestBaseUrl,
    proxyUrl: config.binanceHttpProxy,
  });
  const stream = createHealthTrackedStream(
    new KlineStream({
      wsBaseUrl: config.binanceFuturesWsBaseUrl,
      restClient,
      checkpointProvider: repository,
      startupBackfillSymbolLimit: config.futuresStartupBackfillSymbolLimit,
      websocketProxyUrl: config.binanceHttpProxy,
      restPollingIntervalMs: config.futuresRestPollIntervalMs,
      restPollingSymbolLimit: config.futuresRestPollSymbolLimit,
    }),
    health,
  );
  const futuresProcessingHealth = createConnectorHealthController(health, "futuresProcessing");
  const bitgetReferenceHealth = createConnectorHealthController(health, "bitgetReference");
  const bitgetReferenceService = new BitgetReferenceService({
    marketClient: new BitgetMarketRestClient({
      baseUrl: config.bitgetApiBaseUrl,
      proxyUrl: config.binanceHttpProxy,
      timeoutMs: config.bitgetHttpTimeoutMs,
    }),
    cacheMs: config.bitgetReferenceCacheMs,
    concurrency: config.bitgetReferenceConcurrency,
    thresholds: {
      directionalReturnThreshold: config.bitgetReferenceDirectionalReturn,
      oiDeltaThreshold: config.bitgetReferenceOiDelta,
      priceGapThreshold: config.bitgetReferencePriceGap,
      confidenceAdjustmentCap: config.bitgetReferenceConfidenceCap,
    },
    onHealthChange(status, message) {
      if (status === "connected") {
        bitgetReferenceHealth.markConnected();
        return;
      }

      if (status === "degraded") {
        bitgetReferenceHealth.markDegraded(message ?? "Bitget returned partial data");
        return;
      }

      bitgetReferenceHealth.markDisconnected(message ?? "Bitget reference unavailable");
    },
  });
  const settingsRepository = new MysqlExecutionSettingsRepository(pool);
  const settingsService = new ExecutionSettingsService(settingsRepository);
  const executionEngine =
    executionConfigured
      ? new ExecutionEngine({
          mode: config.executionMode,
          adapter:
            config.executionMode === "SIMULATION"
              ? new SimulationExecutionAdapter()
              : config.executionMode === "BINANCE_PRODUCTION"
                ? new BinanceProductionExecutionAdapter({
                    apiKey: config.binanceProductionApiKey!,
                    apiSecret: config.binanceProductionApiSecret!,
                    baseUrl: BINANCE_PRODUCTION_FUTURES_BASE_URL,
                    proxyUrl: config.binanceHttpProxy,
                    minFreeMarginMultiplier: config.binanceProductionMinFreeMarginMultiplier,
                  })
                : new BinanceDemoExecutionAdapter({
                    apiKey: config.binanceDemoApiKey!,
                    apiSecret: config.binanceDemoApiSecret!,
                    baseUrl: config.binanceDemoFuturesRestBaseUrl!,
                    proxyUrl: config.binanceHttpProxy,
                  }),
          riskPolicy: new DemoExecutionRiskPolicy({
            thresholds: {
              "5m": { oiDelta: config.futuresOiDelta5m, volumeRatio: config.futuresVolumeRatio5m },
              "15m": { oiDelta: config.futuresOiDelta15m, volumeRatio: config.futuresVolumeRatio15m },
            },
            maxSlippageBps: config.executionMaxSlippageBps,
            settingsProvider: () => settingsService.get(),
          }),
          positions: new MysqlExecutionPositionStore(pool),
          audit: new MysqlExecutionAuditRepository(pool),
          settingsProvider: () => settingsService.get(),
        })
      : undefined;

  const web3Connector = new BinanceWeb3SkillsConnector({
    skillsRoot: config.binanceWeb3SkillsDir,
  });
  const alphaHealth = createConnectorHealthController(health, "alphaMarket");
  const alphaMarketService = new AlphaMarketService({
    connector: web3Connector,
    refreshMs: 60 * 60 * 1000,
    onHealthChange: (status, message) => {
      if (status === "connected") {
        alphaHealth.markConnected();
      } else if (status === "degraded") {
        alphaHealth.markDegraded(message ?? "Alpha 列表部分拉取失败");
      } else {
        alphaHealth.markDisconnected(message ?? "Alpha 列表不可用");
      }
    },
  });
  const service = new FuturesRadarService({
    config,
    repository,
    restClient,
    stream,
    oiPoller: new OiPoller({
      restClient,
    }),
    gateClient: new GateFuturesRestClient({
      proxyUrl: config.binanceHttpProxy,
    }),
    alphaProvider: {
      get marketCapByBaseAssetSnapshot() {
        return alphaMarketService.marketCapByBaseAssetSnapshot;
      },
      get alphaReady() {
        return alphaMarketService.alphaReady;
      },
    },
    settingsProvider: () => settingsService.get(),
    notifier: new TelegramNotifier({
      botToken: config.telegramBotToken,
      chatId: config.telegramChatId,
    }),
    onHealthy: () => {
      futuresProcessingHealth.markConnected();
    },
    onError: (event) => {
      futuresProcessingHealth.markDegraded(event.message);
    },
    referenceService: bitgetReferenceService,
    onExecutionCandidate: executionEngine
      ? async ({ signal, metrics, candle }) => {
          // 埋伏开单：低位 + 空头燃料堆积，放宽方向性门槛直接开单。
          if (signal.entryMode === "AMBUSH") {
            const ambushSignal = toAmbushExecutionSignal(signal, metrics, candle, 0, config.executionMaxSlippageBps);
            if (ambushSignal) {
              await executionEngine.handleSignal(ambushSignal);
            }
            return;
          }
          const executionSignal = toExecutionSignal(signal, metrics, candle, oiFactorThresholds, 0, config.executionMaxSlippageBps);
          if (executionSignal) {
            await executionEngine.handleSignal(executionSignal);
          }
        }
      : undefined,
    onExecutionMarketUpdate: executionEngine
      ? async (update) => {
          await executionEngine.handleMarketUpdate(update);
        }
      : undefined,
  });
  const onchainService = new OnchainGemService({
    connector: web3Connector,
    refreshMs: config.onchainRefreshMs,
    store: new MysqlOnchainGemRepository(pool),
  });
  const retentionService = new FuturesRetentionService({
    repository,
    retention: {
      hotRetentionDays: config.futuresHotRetentionDays,
      signalRetentionDays: config.futuresSignalRetentionDays,
      sourceEventRetentionDays: config.futuresSourceEventRetentionDays,
      cleanupIntervalMs: config.futuresCleanupIntervalMs,
      cleanupBatchSize: config.futuresCleanupBatchSize,
    },
  });
  const runtimeService: Pick<FuturesRadarService, "start" | "stop"> = {
    async start() {
      await Promise.all([service.start(), onchainService.start(), retentionService.start(), alphaMarketService.start()]);
    },
    async stop() {
      await Promise.all([
        onchainService.stop(),
        bitgetReferenceService.stop(),
        retentionService.stop(),
        alphaMarketService.stop(),
      ]);
      await service.stop();
    },
  };
  const app = buildApp({
    repository,
    health,
    onchainService,
    settingsService,
    refreshHandlers: {
      refreshUniverse: () => service.refreshUniverse(),
      refreshAlpha: () => alphaMarketService.refresh(),
    },
    executionRecords: new MysqlExecutionRecordRepository(pool),
    latestPriceProvider: async (symbol) => {
      const candles = await repository.getClosedCandleBaseline(symbol, "5m", 1);
      const close = Number(candles[candles.length - 1]?.close);
      return Number.isFinite(close) && close > 0 ? close : undefined;
    },
    fundingRateProvider: async (symbol) => {
      const history = await restClient.getFundingRateHistory(symbol, 1);
      const rate = Number(history[history.length - 1]?.fundingRate);
      return Number.isFinite(rate) ? rate : DEFAULT_FUNDING_RATE;
    },
  });

  return createRuntimeFromDependencies({
    config,
    health,
    service: runtimeService,
    app: app as unknown as RuntimeApp,
    closePool,
  });
}

export async function start(env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  const runtime = createRuntime(env);
  await runtime.start();
  return runtime;
}

export async function runDirectEntry(options: DirectEntryOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const startRuntime = options.startRuntime ?? start;
  const consoleLike = options.consoleLike ?? console;
  const processLike = options.processLike ?? process;

  try {
    const runtime = await startRuntime(env);
    const shutdown = async () => {
      try {
        await runtime.stop();
      } catch {
        processLike.exitCode = 1;
      }
    };

    processLike.once("SIGINT", () => {
      void shutdown();
    });
    processLike.once("SIGTERM", () => {
      void shutdown();
    });
  } catch {
    consoleLike.error("Startup failed. Check configuration and connectivity.");
    processLike.exitCode = 1;
  }
}

if (isExecutedDirectly()) {
  await runDirectEntry();
}
