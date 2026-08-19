import type { AppConfig } from "../config";
import { buildContractUniverse } from "../analysis/contract-only";
import { applyBitgetReference } from "../analysis/bitget-reference-factor";
import { analyzeBreakoutContext, type BreakoutContext } from "../analysis/breakout-context";
import { calculateShortFuel, type ShortFuelFactor } from "../analysis/short-fuel";
import { calculateAmbushScore } from "../analysis/ambush-score";
import { calculateFuturesOiAnomalyScore } from "../analysis/futures-oi-factors";
import type { ExecutionSettings } from "../domain/execution-settings";
import type { GateFuturesRestClient } from "../connectors/gate-futures-rest";
import {
  aggregateFuturesSignals,
  classifyFuturesSignal,
  createFuturesThresholds,
} from "../analysis/futures-classifier";
import { computeFuturesMetrics } from "../analysis/futures-metrics";
import type { BitgetMarketInterval, BitgetReferenceFactor } from "../domain/bitget-reference";
import { RateLimitedQueue } from "../ingest/rate-limited-queue";
import type {
  ContractUniverseItem,
  FundingRateSnapshot,
  FuturesCandle,
  FuturesKlineInterval,
  FuturesMetrics,
  FuturesSignal,
  LongShortRatioSnapshot,
  MarketContext,
  MarketKlineInterval,
  SpotSymbolInfo,
  FuturesSymbolInfo,
} from "../domain/futures";
import type { FuturesRepository, FuturesSourceEvent } from "../storage/futures-repository";
import { sanitizeErrorMessage } from "../utils/sanitize-error";
import type { MarketUpdate } from "../execution/types";

type IntervalHandle = ReturnType<typeof setInterval>;
type SetIntervalLike = (callback: () => void, delayMs: number) => IntervalHandle;
type ClearIntervalLike = (intervalId: IntervalHandle) => void;

type RestClient = {
  getFuturesExchangeInfo(): Promise<FuturesSymbolInfo[]>;
  getSpotExchangeInfo(): Promise<SpotSymbolInfo[]>;
  getKlines?(symbol: string, interval: MarketKlineInterval, limit: number): Promise<FuturesCandle[]>;
  getFundingRateHistory?(symbol: string, limit: number): Promise<FundingRateSnapshot[]>;
  getGlobalLongShortAccountRatio?(symbol: string, period: "5m" | "15m" | "1h" | "4h", limit?: number): Promise<LongShortRatioSnapshot[]>;
  getTopLongShortPositionRatio?(symbol: string, period: "5m" | "15m" | "1h" | "4h", limit?: number): Promise<LongShortRatioSnapshot[]>;
};

type StreamClient = {
  onCandle(handler: (candle: FuturesCandle) => Promise<void>): void;
  start(symbols: string[], intervals: readonly ["5m", "15m"]): Promise<void>;
  stop(): Promise<void>;
};

type OiPoller = {
  pollClosedCandle(candle: FuturesCandle): Promise<MarketContext>;
};

type SignalNotifier = {
  send(signal: FuturesSignal): Promise<"sent" | "skipped">;
};

type Logger = {
  warn?: (message: string) => void;
};

type ReferenceService = {
  evaluate(input: {
    symbol: string;
    interval: BitgetMarketInterval;
    candleOpenTime: number;
    signalType: string;
    binanceOpen: number;
    binanceClose: number;
    binanceCloseTime: number;
  }): Promise<BitgetReferenceFactor>;
};

type ExecutionCandidateHandler = (input: {
  signal: FuturesSignal;
  metrics: import("../domain/futures").FuturesMetrics;
  candle: FuturesCandle;
}) => Promise<void>;

type ExecutionMarketUpdateHandler = (update: MarketUpdate) => Promise<void>;

export type FuturesRadarServiceErrorEvent = {
  scope: "initial-universe-refresh" | "initial-stream-start" | "stream-candle-processing" | "refresh-timer";
  message: string;
};

type ClosableResource = {
  close?: () => Promise<void> | void;
  end?: () => Promise<void> | void;
  destroy?: () => Promise<void> | void;
};

const DEFAULT_INTERVALS = ["5m", "15m"] as const;
const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1_000;
const FIVE_MINUTES_MS = 5 * 60 * 1_000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;

function intervalToMs(interval: FuturesKlineInterval): number {
  return interval === "5m" ? FIVE_MINUTES_MS : FIFTEEN_MINUTES_MS;
}

function normalizeClosedCandle(candle: FuturesCandle, now: () => number): FuturesCandle {
  return {
    ...candle,
    isClosed: candle.isClosed ?? true,
    sourceTimestamp: candle.sourceTimestamp ?? candle.closeTime,
    receivedTimestamp: candle.receivedTimestamp ?? now(),
  };
}

function requireSymbol(candle: FuturesCandle): string {
  if (!candle.symbol) {
    throw new Error("Futures candle is missing symbol");
  }

  return candle.symbol;
}

function requireInterval(candle: FuturesCandle): FuturesKlineInterval {
  if (!candle.interval) {
    throw new Error("Futures candle is missing interval");
  }

  return candle.interval;
}

function createClosedCandleKey(symbol: string, interval: FuturesKlineInterval, openTime: number): string {
  return `${symbol}:${interval}:${openTime}`;
}

function createStreamKey(symbol: string, interval: FuturesKlineInterval): string {
  return `${symbol}:${interval}`;
}

function createAggregationBucketStart(candleOpenTime: number): number {
  return Math.floor(candleOpenTime / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
}

function isDirectionalSignal(signal: FuturesSignal): boolean {
  return (
    signal.signalType === "LONG_BUILDUP_CANDIDATE" ||
    signal.signalType === "SHORT_BUILDUP_CANDIDATE" ||
    signal.signalType === "SHORT_COVERING" ||
    signal.signalType === "LONG_LIQUIDATION"
  );
}

function determineFuturesExclusionReason(symbol: FuturesSymbolInfo): string | null {
  if (symbol.status !== "TRADING") {
    return `STATUS_${symbol.status}`;
  }

  if (symbol.quoteAsset !== "USDT" || symbol.contractType !== "PERPETUAL") {
    return "NON_USDT_OR_NON_PERPETUAL";
  }

  return null;
}

function determineSpotExclusionReason(symbol: SpotSymbolInfo): string | null {
  if (symbol.status !== "TRADING") {
    return `STATUS_${symbol.status}`;
  }

  return null;
}

function createUniverseAuditEvents(
  futuresSymbols: readonly FuturesSymbolInfo[],
  spotSymbols: readonly SpotSymbolInfo[],
  timestamp: number,
): FuturesSourceEvent[] {
  const events: FuturesSourceEvent[] = [];

  for (const symbol of futuresSymbols) {
    const exclusionReason = determineFuturesExclusionReason(symbol);
    if (!exclusionReason) {
      continue;
    }

    events.push({
      eventKey: `universe-excluded:futures:${symbol.symbol}:${exclusionReason}`,
      eventType: "universe_symbol_excluded",
      symbol: symbol.symbol,
      sourceTimestamp: timestamp,
      receivedTimestamp: timestamp,
      payload: {
        scope: "futures",
        symbol: symbol.symbol,
        pair: symbol.pair,
        baseAsset: symbol.baseAsset,
        quoteAsset: symbol.quoteAsset,
        status: symbol.status,
        contractType: symbol.contractType,
        exclusionReason,
      },
    });
  }

  for (const symbol of spotSymbols) {
    const exclusionReason = determineSpotExclusionReason(symbol);
    if (!exclusionReason) {
      continue;
    }

    events.push({
      eventKey: `universe-excluded:spot:${symbol.symbol}:${exclusionReason}`,
      eventType: "universe_symbol_excluded",
      symbol: symbol.symbol,
      sourceTimestamp: timestamp,
      receivedTimestamp: timestamp,
      payload: {
        scope: "spot",
        symbol: symbol.symbol,
        baseAsset: symbol.baseAsset,
        quoteAsset: symbol.quoteAsset,
        status: symbol.status,
        exclusionReason,
      },
    });
  }

  return events;
}

async function closeIfSupported(resource: ClosableResource | undefined): Promise<void> {
  if (!resource) {
    return;
  }

  if (typeof resource.close === "function") {
    await resource.close();
    return;
  }

  if (typeof resource.end === "function") {
    await resource.end();
    return;
  }

  if (typeof resource.destroy === "function") {
    await resource.destroy();
  }
}

export class FuturesRadarService {
  private readonly config: Pick<
    AppConfig,
    | "futuresPollConcurrency"
    | "futuresVolumeRatio5m"
    | "futuresOiDelta5m"
    | "futuresVolumeRatio15m"
    | "futuresOiDelta15m"
  >;
  private readonly repository: FuturesRepository & ClosableResource;
  private readonly restClient: RestClient;
  private readonly stream: StreamClient;
  private readonly oiPoller: OiPoller;
  private readonly notifier: SignalNotifier;
  private readonly now: () => number;
  private readonly setIntervalFn: SetIntervalLike;
  private readonly clearIntervalFn: ClearIntervalLike;
  private readonly refreshIntervalMs: number;
  private readonly onUniverseRefreshed?: (items: readonly ContractUniverseItem[]) => void;
  private readonly logger: Logger;
  private readonly onError?: (event: FuturesRadarServiceErrorEvent) => void;
  private readonly onHealthy?: () => void;
  private readonly referenceService?: ReferenceService;
  private readonly onExecutionCandidate?: ExecutionCandidateHandler;
  private readonly onExecutionMarketUpdate?: ExecutionMarketUpdateHandler;
  private readonly gateClient?: Pick<GateFuturesRestClient, "getShortFuelData">;
  private readonly alphaProvider?: {
    marketCapByBaseAssetSnapshot: ReadonlyMap<string, number>;
    alphaReady: boolean;
  };
  /** 执行设置提供者（埋伏开单条件、评分门槛等） */
  private readonly settingsProvider?: () => Promise<ExecutionSettings>;
  private readonly queue: RateLimitedQueue;
  private refreshTimer?: IntervalHandle;
  private started = false;
  private universeBySymbol = new Map<string, ContractUniverseItem>();
  private currentSubscriptionSignature = "";
  private readonly backfillBaselineChecked = new Set<string>();
  private readonly backfillBaselineReady = new Set<string>();
  /** 开仓场景缓存：同一 symbol 15 分钟内复用 1h K 线分析结果 */
  private readonly breakoutContextCache = new Map<string, { at: number; context: BreakoutContext }>();

  constructor(options: {
    config: Pick<
      AppConfig,
      | "futuresPollConcurrency"
      | "futuresVolumeRatio5m"
      | "futuresOiDelta5m"
      | "futuresVolumeRatio15m"
      | "futuresOiDelta15m"
    >;
    repository: FuturesRepository & ClosableResource;
    restClient: RestClient;
    stream: StreamClient;
    oiPoller: OiPoller;
    notifier: SignalNotifier;
    now?: () => number;
    setIntervalFn?: SetIntervalLike;
    clearIntervalFn?: ClearIntervalLike;
    refreshIntervalMs?: number;
    onUniverseRefreshed?: (items: readonly ContractUniverseItem[]) => void;
    logger?: Logger;
    onError?: (event: FuturesRadarServiceErrorEvent) => void;
    onHealthy?: () => void;
    referenceService?: ReferenceService;
    onExecutionCandidate?: ExecutionCandidateHandler;
    onExecutionMarketUpdate?: ExecutionMarketUpdateHandler;
    queue?: RateLimitedQueue;
    /** Gate 合约行情客户端（空头燃料因子，可选） */
    gateClient?: Pick<GateFuturesRestClient, "getShortFuelData">;
    /** Binance Alpha 板块（可选）：就绪后仅监控 Alpha 内的合约并同步市值 */
    alphaProvider?: {
      marketCapByBaseAssetSnapshot: ReadonlyMap<string, number>;
      alphaReady: boolean;
    };
    /** 执行设置提供者（可选）：用于埋伏开单条件 */
    settingsProvider?: () => Promise<ExecutionSettings>;
  }) {
    this.config = options.config;
    this.repository = options.repository;
    this.restClient = options.restClient;
    this.stream = options.stream;
    this.oiPoller = options.oiPoller;
    this.gateClient = options.gateClient;
    this.alphaProvider = options.alphaProvider;
    this.settingsProvider = options.settingsProvider;
    this.notifier = options.notifier;
    this.now = options.now ?? (() => Date.now());
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.onUniverseRefreshed = options.onUniverseRefreshed;
    this.logger = options.logger ?? {};
    this.onError = options.onError;
    this.onHealthy = options.onHealthy;
    this.referenceService = options.referenceService;
    this.onExecutionCandidate = options.onExecutionCandidate;
    this.onExecutionMarketUpdate = options.onExecutionMarketUpdate;
    this.queue = options.queue ?? new RateLimitedQueue({ concurrency: this.config.futuresPollConcurrency });

    this.stream.onCandle(async (candle) => {
      try {
        await this.handleStreamCandle(candle);
      } catch (error) {
        this.reportBackgroundError("stream-candle-processing", error);
      }
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    try {
      await this.refreshUniverse();
    } catch (error) {
      // Keep the API and retry timer alive when a public provider is rate-limited
      // or temporarily unavailable. The health callback exposes the degraded state.
      this.reportBackgroundError("initial-universe-refresh", error);
    }
    this.started = true;
    void this.ensureStreamMatchesUniverse(true).catch((error) => {
      this.reportBackgroundError("initial-stream-start", error);
    });

    if (!this.refreshTimer && this.refreshIntervalMs > 0) {
      this.refreshTimer = this.setIntervalFn(() => {
        void this.runRefreshTimer();
      }, this.refreshIntervalMs);
    }
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) {
      this.clearIntervalFn(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    if (this.started || this.currentSubscriptionSignature) {
      await this.stream.stop();
    }

    this.started = false;
    this.currentSubscriptionSignature = "";
    this.backfillBaselineChecked.clear();
    this.backfillBaselineReady.clear();

    await closeIfSupported(this.repository);
  }

  async refreshUniverse(): Promise<void> {
    const futuresSymbols = await this.restClient.getFuturesExchangeInfo();
    const spotSymbols = await this.restClient.getSpotExchangeInfo();
    let universe = buildContractUniverse(futuresSymbols, spotSymbols);
    const auditTimestamp = this.now();

    // Binance Alpha 约束：Alpha 列表就绪后，只监控 Alpha 板块内的合约；未就绪时保持全量。
    if (this.alphaProvider?.alphaReady) {
      const alphaBaseAssets = this.alphaProvider.marketCapByBaseAssetSnapshot;
      const filtered = universe.filter((item) => alphaBaseAssets.has(item.baseAsset));
      if (filtered.length > 0) {
        universe = filtered;
      }
      // 同步 Alpha 市值（M USD）到合约表，供排行榜展示。
      const marketCapBySymbol = new Map<string, number>();
      for (const item of universe) {
        const marketCapM = alphaBaseAssets.get(item.baseAsset);
        if (marketCapM !== undefined) {
          marketCapBySymbol.set(item.symbol, marketCapM);
        }
      }
      if (marketCapBySymbol.size > 0) {
        await this.repository.updateMarketCaps(marketCapBySymbol);
      }
    }

    await this.repository.upsertContracts(universe);
    for (const event of createUniverseAuditEvents(futuresSymbols, spotSymbols, auditTimestamp)) {
      await this.repository.saveSourceEvent(event);
    }
    this.universeBySymbol = new Map(universe.map((item) => [item.symbol, item]));
    this.onUniverseRefreshed?.(universe);
    this.onHealthy?.();

    if (this.started) {
      await this.ensureStreamMatchesUniverse(false);
    }
  }

  async handleCandle(candle: FuturesCandle): Promise<void> {
    const normalizedCandle = normalizeClosedCandle(candle, this.now);

    if (normalizedCandle.isBackfill && !normalizedCandle.isStartupSnapshot) {
      const streamKey = createStreamKey(requireSymbol(normalizedCandle), requireInterval(normalizedCandle));
      if (!(await this.hasBackfillBaseline(streamKey, normalizedCandle))) {
        await this.repository.saveCandle(normalizedCandle);
      }
      this.onHealthy?.();
      return;
    }

    if (normalizedCandle.isClosed === false) {
      await this.repository.saveCandle(normalizedCandle);
      this.onHealthy?.();
      return;
    }

    await this.processClosedCandle(normalizedCandle, {
      allowGapRecovery: !normalizedCandle.isStartupSnapshot,
    });
    this.onHealthy?.();
  }

  private async hasBackfillBaseline(streamKey: string, candle: FuturesCandle): Promise<boolean> {
    if (this.backfillBaselineChecked.has(streamKey)) {
      return this.backfillBaselineReady.has(streamKey);
    }

    this.backfillBaselineChecked.add(streamKey);
    const baseline = await this.repository.getClosedCandleBaseline(
      requireSymbol(candle),
      requireInterval(candle),
      21,
    );
    if (baseline.length >= 21) {
      this.backfillBaselineReady.add(streamKey);
      return true;
    }

    return false;
  }

  async handleClosedCandle(candle: FuturesCandle): Promise<void> {
    const normalizedCandle = normalizeClosedCandle(candle, this.now);
    await this.processClosedCandle(normalizedCandle, {
      allowGapRecovery: true,
    });
    this.onHealthy?.();
  }

  private async handleStreamCandle(candle: FuturesCandle): Promise<void> {
    await this.handleCandle(candle);
  }

  private async runRefreshTimer(): Promise<void> {
    try {
      await this.refreshUniverse();
    } catch (error) {
      this.reportBackgroundError("refresh-timer", error);
    }
  }

  private async processClosedCandle(
    normalizedCandle: FuturesCandle,
    options: {
      allowGapRecovery: boolean;
    },
  ): Promise<void> {
    const symbol = requireSymbol(normalizedCandle);
    const interval = requireInterval(normalizedCandle);
    const streamKey = createStreamKey(symbol, interval);
    const checkpoint = await this.repository.getCheckpoint(streamKey);
    if (checkpoint !== null && normalizedCandle.closeTime <= checkpoint) {
      return;
    }

    if (options.allowGapRecovery) {
      await this.recoverGap(normalizedCandle, streamKey, checkpoint);
      const checkpointAfterRecovery = await this.repository.getCheckpoint(streamKey);
      if (checkpointAfterRecovery !== null && normalizedCandle.closeTime <= checkpointAfterRecovery) {
        return;
      }
    }

    const closedCandleKey = createClosedCandleKey(symbol, interval, normalizedCandle.openTime);
    await this.queue.enqueue(closedCandleKey, async () => {
      const checkpointBeforeProcessing = await this.repository.getCheckpoint(streamKey);
      if (checkpointBeforeProcessing !== null && normalizedCandle.closeTime <= checkpointBeforeProcessing) {
        return;
      }

      await this.repository.saveCandle(normalizedCandle);

      const baseline = await this.repository.getClosedCandleBaseline(symbol, interval, 21);
      const polledContext = await this.oiPoller.pollClosedCandle(normalizedCandle);
      const contract = this.universeBySymbol.get(symbol);
      const context: MarketContext = {
        ...polledContext,
        symbol,
        interval,
        candleOpenTime: normalizedCandle.openTime,
        candleCloseTime: normalizedCandle.closeTime,
        sourceTimestamp:
          polledContext.sourceTimestamp ?? normalizedCandle.sourceTimestamp ?? normalizedCandle.closeTime,
        receivedTimestamp: polledContext.receivedTimestamp ?? normalizedCandle.receivedTimestamp ?? this.now(),
        isContractOnly: contract?.isContractOnly ?? false,
        contractOnlyReason: contract?.contractOnlyReason ?? "SPOT_BASE_ASSET_PRESENT",
        spotBaseAssetMatches: contract?.spotBaseAssetMatches ?? [],
      };

      await this.repository.saveMarketContext(context);

      const metrics = computeFuturesMetrics(normalizedCandle, baseline, context);
      // 跨交易所空头燃料因子（Binance/Gate 合约持仓结构），持久化供雷达展示与评分。
      const shortFuel = await this.loadShortFuel(symbol);
      if (shortFuel) {
        metrics.shortFuelScore = shortFuel.score;
        metrics.shortFuelLevel = shortFuel.level;
        metrics.shortFuelEvidence = shortFuel.evidence;
      }
      // 开仓场景（1h K 线分析，15 分钟缓存）：持久化供可开单区域判断。
      const breakoutContext = await this.loadBreakoutContext(symbol, Number(normalizedCandle.close));
      if (breakoutContext) {
        metrics.breakoutContext = breakoutContext.kind;
        metrics.positionPercentile = breakoutContext.positionPercentile;
        metrics.sevenDayRange = breakoutContext.sevenDayRange;
      }
      // 埋伏评分（不参考 OI）：空头燃料 + 低位 + 横盘 + 主动盘 + 温和上涨 + 量能蓄势。
      metrics.ambushScore = calculateAmbushScore({
        shortFuelScore: metrics.shortFuelScore ?? 0,
        positionPercentile: metrics.positionPercentile ?? 0.5,
        sevenDayRange: metrics.sevenDayRange ?? 0.3,
        takerImbalance: metrics.takerImbalance,
        priceReturn: metrics.priceReturn,
        volumeRatio: metrics.volumeRatio,
      });
      await this.repository.saveMetrics(metrics);

      await this.onExecutionMarketUpdate?.({
        symbol,
        interval,
        price: Number(normalizedCandle.close),
        detectedAt: normalizedCandle.closeTime,
        has5mReversal:
          // 收紧反转判定：仅"价格下跌 + OI 增仓"（空头增仓压制）算确认反转；
          // 横盘、微涨、获利了结（上涨 OI 减）不再触发，避免震荡行情开平循环亏手续费。
          interval === "5m" &&
          metrics.priceReturn < 0 &&
          metrics.priceOiAlignment === "PRICE_DOWN_OI_UP",
        dataStreamOk: true,
        // The simulation adapter owns this protection order. A real adapter
        // must replace this callback with an exchange order-state read.
        protectionOrderPresent: true,
        orderStatusKnown: true,
      });

      const candidateSignal = classifyFuturesSignal(metrics, createFuturesThresholds(this.config, interval));
      if (candidateSignal) {
        // 开仓场景分类：低位启动（宽松持仓）/ 高位风险（过滤开仓）/ 中性。
        if (breakoutContext) {
          candidateSignal.breakoutContext = breakoutContext.kind;
          candidateSignal.positionPercentile = breakoutContext.positionPercentile;
          candidateSignal.move24h = breakoutContext.move24h;
        }
        const signalWithReference = await this.applyReferenceIfAvailable(candidateSignal, normalizedCandle);
        const publicationSignal = await this.resolvePublicationSignal(signalWithReference);
        if (await this.repository.saveSignalIfNew(publicationSignal)) {
          await this.onExecutionCandidate?.({
            // Execution is keyed to the exact closed candle and interval. Do
            // not feed the optional 5m/15m publication aggregation into the
            // execution dedupe key or threshold lookup.
            signal: signalWithReference,
            metrics,
            candle: normalizedCandle,
          });
          await this.notifier.send(publicationSignal);
        }
      }

      // 埋伏开单：低位 + 空头燃料堆积（不依赖放量增仓确认），等庄家吸筹后拉盘。
      await this.evaluateAmbushCandidate(symbol, interval, metrics, normalizedCandle, shortFuel, breakoutContext);

      const checkpointAfterProcessing = await this.repository.getCheckpoint(streamKey);
      if (checkpointAfterProcessing === null || normalizedCandle.closeTime > checkpointAfterProcessing) {
        await this.repository.setCheckpoint(streamKey, normalizedCandle.closeTime);
      }
    });
  }

  private async loadBreakoutContext(symbol: string, currentPrice: number): Promise<BreakoutContext | undefined> {
    if (!this.restClient.getKlines) {
      return undefined;
    }

    const cached = this.breakoutContextCache.get(symbol);
    if (cached && this.now() - cached.at < 15 * 60_000) {
      return cached.context;
    }

    try {
      const candles = await this.restClient.getKlines(symbol, "1h", 30 * 24);
      const context = analyzeBreakoutContext(candles, currentPrice);
      this.breakoutContextCache.set(symbol, { at: this.now(), context });
      return context;
    } catch {
      // 场景分析失败不阻断信号链路，按中性处理。
      return undefined;
    }
  }

  /** 跨交易所空头燃料：Binance 多空比/大户比/费率 + Gate 合约统计（5 分钟缓存） */
  private readonly shortFuelCache = new Map<string, { at: number; factor: ShortFuelFactor }>();

  private async loadShortFuel(symbol: string): Promise<ShortFuelFactor | undefined> {
    const cached = this.shortFuelCache.get(symbol);
    if (cached && this.now() - cached.at < 5 * 60_000) {
      return cached.factor;
    }

    try {
      const [globalRatio, topRatio, fundingHistory, gateData] = await Promise.all([
        this.restClient.getGlobalLongShortAccountRatio?.(symbol, "5m", 1).catch(() => []),
        this.restClient.getTopLongShortPositionRatio?.(symbol, "5m", 1).catch(() => []),
        this.restClient.getFundingRateHistory?.(symbol, 1).catch(() => []),
        this.gateClient?.getShortFuelData(symbol).catch(() => undefined),
      ]);

      const global = globalRatio?.[globalRatio.length - 1];
      const top = topRatio?.[topRatio.length - 1];
      const funding = fundingHistory?.[fundingHistory.length - 1];
      const factor = calculateShortFuel({
        binance: {
          longShortRatio: global ? Number(global.longShortRatio) : undefined,
          topPositionRatio: top ? Number(top.longShortRatio) : undefined,
          fundingRate: funding ? Number(funding.fundingRate) : undefined,
        },
        gate: gateData,
      });
      this.shortFuelCache.set(symbol, { at: this.now(), factor });
      return factor;
    } catch {
      return undefined;
    }
  }

  /**
   * 埋伏开单候选：低位启动 + 空头燃料堆积 + 评分达标 + 非暴跌时，
   * 生成 AMBUSH_CANDIDATE 信号交给执行层（放宽方向性门槛直接开单）。
   */
  private async evaluateAmbushCandidate(
    symbol: string,
    interval: FuturesKlineInterval,
    metrics: FuturesMetrics,
    candle: FuturesCandle,
    shortFuel: ShortFuelFactor | undefined,
    breakoutContext: BreakoutContext | undefined,
  ): Promise<void> {
    if (!this.onExecutionCandidate || !this.settingsProvider) return;
    if (!shortFuel || !shortFuel.dataAvailable || shortFuel.score === 0) return;
    if (breakoutContext?.kind !== "LOW_POSITION_BREAKOUT") return;
    // 价格明显下跌时不埋伏（避免接飞刀）。
    if (metrics.priceReturn < -0.01) return;

    let settings: ExecutionSettings;
    try {
      settings = await this.settingsProvider();
    } catch {
      return;
    }
    if (!settings.ambush.enabled) return;
    if (shortFuel.score < settings.ambush.minShortFuelScore) return;
    // 市值上限：超过上限的币庄家难控盘，不做埋伏。
    const marketCapM = this.alphaProvider?.marketCapByBaseAssetSnapshot.get(symbol.replace(/USDT$/, ""));
    if (marketCapM !== undefined && marketCapM > settings.ambush.maxMarketCapM) return;
    // 埋伏评分（不参考 OI）达到门槛才开单。
    if ((metrics.ambushScore ?? 0) < settings.ambush.minScore) return;

    const signal: FuturesSignal = {
      signalType: "AMBUSH_CANDIDATE",
      severity: "WARNING",
      confidence: 0.5,
      explanation: "低位横盘 + 跨交易所空头燃料堆积，埋伏等待庄家拉盘爆空",
      evidence: shortFuel.evidence,
      symbol,
      interval,
      candleOpenTime: candle.openTime,
      thresholdVersion: `ambush:sf=${settings.ambush.minShortFuelScore}`,
      contractOnlyRisk: metrics.contractOnlyRisk,
      breakoutContext: breakoutContext.kind,
      positionPercentile: breakoutContext.positionPercentile,
      move24h: breakoutContext.move24h,
      entryMode: "AMBUSH",
      shortFuelScore: shortFuel.score,
    };

    if (await this.repository.saveSignalIfNew(signal)) {
      await this.onExecutionCandidate({
        signal,
        metrics,
        candle,
      });
    }
  }

  private async recoverGap(candle: FuturesCandle, streamKey: string, checkpoint: number | null): Promise<void> {
    if (!this.restClient.getKlines) {
      return;
    }

    const interval = requireInterval(candle);
    const symbol = requireSymbol(candle);
    if (checkpoint === null || candle.closeTime - checkpoint <= intervalToMs(interval)) {
      return;
    }

    const backfill = await this.restClient.getKlines(symbol, interval, 50);
    const orderedMissingCandles = backfill
      .map((item) =>
        normalizeClosedCandle(
          {
            ...item,
            symbol: item.symbol ?? symbol,
            interval: item.interval ?? interval,
          },
          this.now,
        ),
      )
      .filter((item) => item.closeTime > checkpoint && item.closeTime < candle.closeTime && item.isClosed !== false)
      .sort((left, right) => left.openTime - right.openTime);

    for (const missingCandle of orderedMissingCandles) {
      await this.processClosedCandle(missingCandle, {
        allowGapRecovery: false,
      });
    }
  }

  private async resolvePublicationSignal(signal: FuturesSignal): Promise<FuturesSignal> {
    if (!isDirectionalSignal(signal)) {
      return signal;
    }

    const bucketStart = createAggregationBucketStart(signal.candleOpenTime);
    const siblingSignals = await this.repository.listSignals({
      symbol: signal.symbol,
      from: bucketStart,
      to: bucketStart + FIFTEEN_MINUTES_MS - 1,
      limit: 20,
    });

    const sibling =
      signal.interval === "5m"
        ? siblingSignals.find(
            (candidate) =>
              candidate.interval === "15m" &&
              candidate.candleOpenTime === bucketStart &&
              isDirectionalSignal(candidate),
          )
        : siblingSignals
            .filter((candidate) => candidate.interval === "5m" && isDirectionalSignal(candidate))
            .sort((left, right) => right.candleOpenTime - left.candleOpenTime)
            .at(0);

    if (!sibling) {
      return signal;
    }

    return aggregateFuturesSignals([sibling, signal]) ?? signal;
  }

  private async applyReferenceIfAvailable(signal: FuturesSignal, candle: FuturesCandle): Promise<FuturesSignal> {
    if (!this.referenceService) {
      return signal;
    }

    if (!isDirectionalSignal(signal)) {
      return signal;
    }

    if (signal.interval !== "5m" && signal.interval !== "15m") {
      return signal;
    }

    let factor: BitgetReferenceFactor;
    try {
      factor = await this.referenceService.evaluate({
        symbol: signal.symbol,
        interval: signal.interval,
        candleOpenTime: signal.candleOpenTime,
        signalType: signal.signalType,
        binanceOpen: Number(candle.open),
        binanceClose: Number(candle.close),
        binanceCloseTime: candle.closeTime,
      });
    } catch {
      return signal;
    }

    await this.repository.saveBitgetReference(factor);

    if (factor.status === "BITGET_UNAVAILABLE") {
      return signal;
    }

    return applyBitgetReference(signal, factor);
  }

  private async ensureStreamMatchesUniverse(forceStart: boolean): Promise<void> {
    const contractOnlySymbols = [...this.universeBySymbol.values()]
      .filter((item) => item.isContractOnly)
      .map((item) => item.symbol)
      .sort((left, right) => left.localeCompare(right));
    const nextSignature = contractOnlySymbols.join(",");

    if (!forceStart && nextSignature === this.currentSubscriptionSignature) {
      return;
    }

    if (this.currentSubscriptionSignature) {
      await this.stream.stop();
    }

    await this.stream.start(contractOnlySymbols, DEFAULT_INTERVALS);
    this.currentSubscriptionSignature = nextSignature;
  }

  private reportBackgroundError(scope: FuturesRadarServiceErrorEvent["scope"], error: unknown) {
    const message = sanitizeErrorMessage(error);
    this.logger.warn?.(`Futures radar service ${scope} failed: ${message}`);
    this.onError?.({
      scope,
      message,
    });
  }
}
