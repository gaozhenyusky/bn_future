import type { BitgetReferenceFactor } from "../domain/bitget-reference";
import {
  buildFuturesOiAnomalyFactors,
  calculateFuturesOiAnomalyScore,
  DEFAULT_FUTURES_OI_FACTOR_THRESHOLDS,
  deriveFuturesOiValueAlignment,
  type FuturesOiFactorThresholds,
} from "../analysis/futures-oi-factors";
import type {
  ContractOnlyReason,
  ContractUniverseItem,
  FuturesCandle,
  FuturesKlineInterval,
  FuturesMetrics,
  FuturesOiLeaderboardRow,
  FuturesSignal,
  FuturesSignalSeverity,
  MarketContext,
  OpenInterestSnapshot,
  TakerFlowSnapshot,
} from "../domain/futures";
import type {
  FuturesRadarQuery,
  FuturesRadarRow,
  FuturesRepository,
  FuturesSourceEvent,
  FuturesSignalsQuery,
  FuturesOiLeaderboardQuery,
} from "./futures-repository";
import { storageKeys } from "./futures-repository";

type StoredSourceEvent = {
  eventKey: string;
  eventType: string;
  symbol?: string;
  interval?: FuturesKlineInterval;
  sourceTimestamp: number;
  receivedTimestamp: number;
  payload: unknown;
};

type StoredFlowMetric = {
  symbol: string;
  interval: FuturesKlineInterval;
  candleOpenTime: number;
  candleCloseTime?: number;
  sourceTimestamp?: number;
  receivedTimestamp?: number;
  takerFlow?: TakerFlowSnapshot;
  fundingRateRaw?: string;
  fundingRateTimestamp?: number;
  isContractOnly?: boolean;
  contractOnlyReason?: string;
  spotBaseAssetMatches?: readonly string[];
  isComplete?: boolean;
  missing?: readonly string[];
  volumeRatio?: number;
  volumePercentile?: number;
  oiValueDelta?: number;
  oiUnitDelta?: number;
  oiAccumulationDelta?: number;
  oiAccumulationWindowLabel?: string;
  oiAccumulationSamples?: number;
  priceReturn?: number;
  takerImbalance?: number;
  liquidationRatio?: number;
  priceOiAlignment?: string;
  dataCompleteness?: string;
  contractOnlyRiskLevel?: string;
  contractOnlyRiskReason?: string;
};

type StoredOiSnapshot = OpenInterestSnapshot & {
  interval: FuturesKlineInterval;
  sourceTimestamp: number;
  receivedTimestamp: number;
};

function getSeverityRank(severity: FuturesSignalSeverity): number {
  switch (severity) {
    case "HIGH":
      return 0;
    case "WARNING":
      return 1;
    case "INFO":
    default:
      return 2;
  }
}

function getAllowedSeverities(minSeverity: FuturesSignalSeverity | undefined): FuturesSignalSeverity[] {
  switch (minSeverity) {
    case "HIGH":
      return ["HIGH"];
    case "WARNING":
      return ["HIGH", "WARNING"];
    case "INFO":
    case undefined:
    default:
      return ["HIGH", "WARNING", "INFO"];
  }
}

export class InMemoryFuturesRepository implements FuturesRepository {
  constructor(
    private readonly oiFactorThresholds: FuturesOiFactorThresholds = DEFAULT_FUTURES_OI_FACTOR_THRESHOLDS,
  ) {}
  private readonly contracts = new Map<string, ContractUniverseItem>();
  private readonly candles = new Map<string, FuturesCandle>();
  private readonly flowMetrics = new Map<string, StoredFlowMetric>();
  private readonly oiSnapshots = new Map<string, StoredOiSnapshot>();
  private readonly signals = new Map<string, FuturesSignal>();
  private readonly bitgetReferences = new Map<string, BitgetReferenceFactor>();
  private readonly sourceEvents = new Map<string, StoredSourceEvent>();
  private readonly checkpoints = new Map<string, number>();

  async upsertContracts(items: readonly ContractUniverseItem[]): Promise<void> {
    for (const item of items) {
      this.contracts.set(storageKeys.createContractKey(item), {
        ...item,
        spotBaseAssetMatches: [...item.spotBaseAssetMatches],
      });
    }
  }

  private readonly marketCaps = new Map<string, number>();

  async updateMarketCaps(marketCapBySymbol: ReadonlyMap<string, number>): Promise<void> {
    for (const [symbol, marketCapM] of marketCapBySymbol) {
      this.marketCaps.set(symbol, marketCapM);
    }
  }

  getMarketCapM(symbol: string): number | undefined {
    return this.marketCaps.get(symbol);
  }

  async getClosedCandleBaseline(
    symbol: string,
    interval: FuturesKlineInterval,
    limit: number,
  ): Promise<FuturesCandle[]> {
    return [...this.candles.values()]
      .filter((candle) => candle.symbol === symbol && candle.interval === interval && candle.isClosed)
      .sort((left, right) => left.openTime - right.openTime)
      .slice(-limit);
  }

  async saveCandle(candle: FuturesCandle): Promise<void> {
    const key = storageKeys.createCandleKey({
      symbol: candle.symbol,
      interval: candle.interval,
      openTime: candle.openTime,
    });

    this.candles.set(key, { ...candle });

    if (candle.sourceTimestamp !== undefined && candle.receivedTimestamp !== undefined) {
      this.sourceEvents.set(`candle:${key}`, {
        eventKey: `candle:${key}`,
        eventType: "futures_candle",
        symbol: candle.symbol,
        interval: candle.interval,
        sourceTimestamp: candle.sourceTimestamp,
        receivedTimestamp: candle.receivedTimestamp,
        payload: { ...candle },
      });
    }
  }

  async saveMarketContext(context: MarketContext): Promise<void> {
    const flowMetricKey = `${context.symbol}:${context.interval}:${context.candleOpenTime}`;
    const previous = this.flowMetrics.get(flowMetricKey);

    this.flowMetrics.set(flowMetricKey, {
      ...previous,
      symbol: context.symbol,
      interval: context.interval,
      candleOpenTime: context.candleOpenTime,
      candleCloseTime: context.candleCloseTime,
      sourceTimestamp: context.sourceTimestamp,
      receivedTimestamp: context.receivedTimestamp,
      takerFlow: context.takerFlow ? { ...context.takerFlow } : previous?.takerFlow,
      fundingRateRaw: context.fundingRate?.fundingRate ?? previous?.fundingRateRaw,
      fundingRateTimestamp: context.fundingRateTimestamp ?? previous?.fundingRateTimestamp,
      isContractOnly: context.isContractOnly ?? previous?.isContractOnly,
      contractOnlyReason: context.contractOnlyReason ?? previous?.contractOnlyReason,
      spotBaseAssetMatches: context.spotBaseAssetMatches
        ? [...context.spotBaseAssetMatches]
        : previous?.spotBaseAssetMatches,
      isComplete: context.isComplete,
      missing: [...context.missing],
    });

    this.persistOpenInterestSnapshot(context.interval, context.receivedTimestamp, context.openInterest);
    this.persistOpenInterestSnapshot(context.interval, context.receivedTimestamp, context.previousOpenInterest);

    if (context.takerFlow) {
      this.sourceEvents.set(`taker-flow:${context.symbol}:${context.interval}:${context.takerFlow.timestamp}`, {
        eventKey: `taker-flow:${context.symbol}:${context.interval}:${context.takerFlow.timestamp}`,
        eventType: "taker_flow_snapshot",
        symbol: context.symbol,
        interval: context.interval,
        sourceTimestamp: context.takerFlow.timestamp,
        receivedTimestamp: context.receivedTimestamp,
        payload: { ...context.takerFlow },
      });
    }

    if (context.fundingRate) {
      this.sourceEvents.set(`funding-rate:${context.symbol}:${context.fundingRate.fundingTime}`, {
        eventKey: `funding-rate:${context.symbol}:${context.fundingRate.fundingTime}`,
        eventType: "funding_rate_snapshot",
        symbol: context.symbol,
        interval: context.interval,
        sourceTimestamp: context.fundingRate.fundingTime,
        receivedTimestamp: context.receivedTimestamp,
        payload: { ...context.fundingRate },
      });
    }
  }

  async saveMetrics(metrics: FuturesMetrics): Promise<void> {
    const flowMetricKey = `${metrics.symbol}:${metrics.interval}:${metrics.candleOpenTime}`;
    const previous = this.flowMetrics.get(flowMetricKey);

    this.flowMetrics.set(flowMetricKey, {
      ...previous,
      symbol: metrics.symbol,
      interval: metrics.interval,
      candleOpenTime: metrics.candleOpenTime,
      candleCloseTime: metrics.candleCloseTime,
      volumeRatio: metrics.volumeRatio,
      volumePercentile: metrics.volumePercentile,
      oiValueDelta: metrics.oiValueDelta,
      oiUnitDelta: metrics.oiUnitDelta,
      oiAccumulationDelta: metrics.oiAccumulationDelta,
      oiAccumulationWindowLabel: metrics.oiAccumulationWindowLabel,
      oiAccumulationSamples: metrics.oiAccumulationSamples,
      priceReturn: metrics.priceReturn,
      takerImbalance: metrics.takerImbalance,
      liquidationRatio: metrics.liquidationRatio,
      priceOiAlignment: metrics.priceOiAlignment,
      dataCompleteness: metrics.dataCompleteness,
      contractOnlyRiskLevel: metrics.contractOnlyRisk.level,
      contractOnlyRiskReason: metrics.contractOnlyRisk.reason,
    });
  }

  async saveSignal(signal: FuturesSignal): Promise<void> {
    this.signals.set(storageKeys.createSignalKey(signal), {
      ...signal,
      evidence: [...signal.evidence],
      contractOnlyRisk: signal.contractOnlyRisk ? { ...signal.contractOnlyRisk } : undefined,
    });
  }

  async saveSignalIfNew(signal: FuturesSignal): Promise<boolean> {
    const key = storageKeys.createSignalKey(signal);
    if (this.signals.has(key)) {
      return false;
    }

    await this.saveSignal(signal);
    return true;
  }

  async saveBitgetReference(factor: BitgetReferenceFactor): Promise<void> {
    this.bitgetReferences.set(storageKeys.createBitgetReferenceKey(factor), {
      ...factor,
      missing: [...factor.missing],
      evidence: [...factor.evidence],
    });
  }

  async getBitgetReference(
    symbol: string,
    interval: FuturesKlineInterval,
    candleOpenTime: number,
  ): Promise<BitgetReferenceFactor | undefined> {
    const factor = this.bitgetReferences.get(
      storageKeys.createBitgetReferenceKey({
        symbol,
        interval,
        candleOpenTime,
        provider: "bitget",
      }),
    );

    if (!factor) {
      return undefined;
    }

    return {
      ...factor,
      missing: [...factor.missing],
      evidence: [...factor.evidence],
    };
  }

  async saveSourceEvent(event: FuturesSourceEvent): Promise<void> {
    this.sourceEvents.set(event.eventKey, {
      ...event,
    });
  }

  async getCheckpoint(stream: string): Promise<number | null> {
    return this.checkpoints.get(stream) ?? null;
  }

  async setCheckpoint(stream: string, timestamp: number): Promise<void> {
    const current = this.checkpoints.get(stream);
    if (current === undefined || timestamp > current) {
      this.checkpoints.set(stream, timestamp);
    }
  }

  async listRadar(query: FuturesRadarQuery): Promise<FuturesRadarRow[]> {
    const allowedSeverities = new Set(getAllowedSeverities(query.minSeverity));

    return [...this.signals.values()]
      .map((signal) => {
        const metrics = this.flowMetrics.get(`${signal.symbol}:${signal.interval}:${signal.candleOpenTime}`);
        const bitgetReference = this.bitgetReferences.get(
          storageKeys.createBitgetReferenceKey({
            symbol: signal.symbol,
            interval: signal.interval,
            candleOpenTime: signal.candleOpenTime,
            provider: "bitget",
          }),
        );
        const contractOnlyReason = (metrics?.contractOnlyReason ??
          signal.contractOnlyRisk?.reason ??
          "SPOT_BASE_ASSET_PRESENT") as ContractOnlyReason;

        return {
          symbol: signal.symbol,
          interval: signal.interval,
          signalType: signal.signalType,
          severity: signal.severity,
          confidence: signal.confidence,
          explanation: signal.explanation,
          evidence: [...signal.evidence],
          thresholdVersion: signal.thresholdVersion,
          candleOpenTime: signal.candleOpenTime,
          isContractOnly: metrics?.isContractOnly ?? false,
          contractOnlyReason,
          dataCompleteness: (metrics?.dataCompleteness ?? "COMPLETE") as FuturesRadarRow["dataCompleteness"],
          priceReturn: metrics?.priceReturn ?? 0,
          volumeRatio: metrics?.volumeRatio ?? 0,
          oiValueDelta: metrics?.oiValueDelta ?? 0,
          takerImbalance: metrics?.takerImbalance ?? 0,
          contractOnlyRisk: signal.contractOnlyRisk ? { ...signal.contractOnlyRisk } : undefined,
          bitgetReference: bitgetReference
            ? {
                ...bitgetReference,
                missing: [...bitgetReference.missing],
                evidence: [...bitgetReference.evidence],
              }
            : undefined,
        } satisfies FuturesRadarRow;
      })
      .filter((row) => (query.interval ? row.interval === query.interval : true))
      .filter((row) => (query.contractOnly === undefined ? true : row.isContractOnly === query.contractOnly))
      .filter((row) => allowedSeverities.has(row.severity))
      .sort((left, right) => {
        const severityOrder = getSeverityRank(left.severity) - getSeverityRank(right.severity);
        if (severityOrder !== 0) {
          return severityOrder;
        }

        if (left.candleOpenTime !== right.candleOpenTime) {
          return right.candleOpenTime - left.candleOpenTime;
        }

        const symbolOrder = left.symbol.localeCompare(right.symbol);
        if (symbolOrder !== 0) {
          return symbolOrder;
        }

        return left.interval.localeCompare(right.interval);
      })
      .slice(0, query.limit);
  }

  async listOiLeaderboard(query: FuturesOiLeaderboardQuery): Promise<FuturesOiLeaderboardRow[]> {
    const latestBySymbol = new Map<string, StoredFlowMetric>();

    for (const metric of this.flowMetrics.values()) {
      const contract = this.contracts.get(metric.symbol);
      const marketCapM = this.marketCaps.get(metric.symbol);
      if (
        metric.interval !== query.interval ||
        !metric.isContractOnly ||
        metric.oiValueDelta === undefined ||
        !contract ||
        contract.status !== "TRADING" ||
        contract.quoteAsset !== "USDT" ||
        contract.contractType !== "PERPETUAL" ||
        !contract.isContractOnly ||
        // 埋伏段市值上限过滤（与 MySQL 版 SQL 一致）
        (query.maxMarketCapM !== undefined && (marketCapM === undefined || marketCapM > query.maxMarketCapM))
      ) {
        continue;
      }

      const current = latestBySymbol.get(metric.symbol);
      if (!current || metric.candleOpenTime > current.candleOpenTime) {
        latestBySymbol.set(metric.symbol, metric);
      }
    }

    const rows = [...latestBySymbol.values()].map((metric) => {
        const oiValueDelta = metric.oiValueDelta ?? 0;
        const priceReturn = metric.priceReturn ?? 0;
        const priceReturn5m = metric.interval === "5m" ? priceReturn : 0;
        const volumeRatio = metric.volumeRatio ?? 0;
        const takerImbalance = metric.takerImbalance ?? 0;
        const priceOiAlignment = deriveFuturesOiValueAlignment(priceReturn, oiValueDelta);
        const factorInput = {
          interval: metric.interval,
          oiValueDelta,
          oiAccumulationDelta: metric.oiAccumulationDelta,
          oiAccumulationWindowLabel: metric.oiAccumulationWindowLabel,
          volumeRatio,
          priceReturn,
          priceReturn5m,
          takerImbalance,
          priceOiAlignment,
          dataCompleteness: (metric.dataCompleteness ?? "INCOMPLETE_CONTEXT") as FuturesOiLeaderboardRow["dataCompleteness"],
          isContractOnly: true,
        } as const;
        const signals = [...this.signals.values()]
          .filter((signal) => signal.symbol === metric.symbol && signal.interval === metric.interval && signal.candleOpenTime === metric.candleOpenTime)
          .sort((left, right) => getSeverityRank(left.severity) - getSeverityRank(right.severity));

        return {
          rank: 0,
          symbol: metric.symbol,
          interval: metric.interval,
          candleOpenTime: metric.candleOpenTime,
          isContractOnly: true,
          contractOnlyReason: (metric.contractOnlyReason ?? "NO_ACTIVE_SPOT_BASE_ASSET") as FuturesOiLeaderboardRow["contractOnlyReason"],
          dataCompleteness: factorInput.dataCompleteness,
          priceReturn,
          priceReturn5m,
          volumeRatio,
          oiValueDelta,
          oiUnitDelta: metric.oiUnitDelta ?? oiValueDelta,
          takerImbalance,
          priceOiAlignment,
          anomalyScore: calculateFuturesOiAnomalyScore(factorInput, this.oiFactorThresholds),
          factors: buildFuturesOiAnomalyFactors(factorInput, this.oiFactorThresholds),
          signals,
        } satisfies FuturesOiLeaderboardRow;
      });

    return rows
      .sort((left, right) => {
        const scoreOrder = right.anomalyScore - left.anomalyScore;
        if (scoreOrder !== 0) return scoreOrder;

        const oiOrder = Math.abs(right.oiValueDelta) - Math.abs(left.oiValueDelta);
        if (oiOrder !== 0) return oiOrder;

        const volumeOrder = right.volumeRatio - left.volumeRatio;
        if (volumeOrder !== 0) return volumeOrder;

        const timeOrder = right.candleOpenTime - left.candleOpenTime;
        if (timeOrder !== 0) return timeOrder;

        return left.symbol.localeCompare(right.symbol);
      })
      .slice(0, query.limit)
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }

  async listSignals(query: FuturesSignalsQuery): Promise<FuturesSignal[]> {
    return [...this.signals.values()]
      .filter((signal) => (query.symbol ? signal.symbol === query.symbol : true))
      .filter((signal) => (query.interval ? signal.interval === query.interval : true))
      .filter((signal) => (query.from !== undefined ? signal.candleOpenTime >= query.from : true))
      .filter((signal) => (query.to !== undefined ? signal.candleOpenTime <= query.to : true))
      .sort((left, right) => {
        if (left.candleOpenTime !== right.candleOpenTime) {
          return right.candleOpenTime - left.candleOpenTime;
        }

        const symbolOrder = left.symbol.localeCompare(right.symbol);
        if (symbolOrder !== 0) {
          return symbolOrder;
        }

        const intervalOrder = left.interval.localeCompare(right.interval);
        if (intervalOrder !== 0) {
          return intervalOrder;
        }

        const signalTypeOrder = left.signalType.localeCompare(right.signalType);
        if (signalTypeOrder !== 0) {
          return signalTypeOrder;
        }

        return left.thresholdVersion.localeCompare(right.thresholdVersion);
      })
      .slice(0, query.limit)
      .map((signal) => ({
        ...signal,
        evidence: [...signal.evidence],
        contractOnlyRisk: signal.contractOnlyRisk ? { ...signal.contractOnlyRisk } : undefined,
      }));
  }

  debugSnapshot() {
    return {
      contracts: [...this.contracts.values()].sort((left, right) => left.symbol.localeCompare(right.symbol)),
      candles: [...this.candles.values()].sort((left, right) => left.openTime - right.openTime),
      flowMetrics: [...this.flowMetrics.values()].sort((left, right) => left.candleOpenTime - right.candleOpenTime),
      oiSnapshots: [...this.oiSnapshots.values()].sort((left, right) => left.timestamp - right.timestamp),
      bitgetReferences: [...this.bitgetReferences.values()].sort((left, right) =>
        storageKeys.createBitgetReferenceKey(left).localeCompare(storageKeys.createBitgetReferenceKey(right)),
      ),
      signals: [...this.signals.values()].sort((left, right) =>
        storageKeys.createSignalKey(left).localeCompare(storageKeys.createSignalKey(right)),
      ),
      sourceEvents: [...this.sourceEvents.values()].sort((left, right) => left.eventKey.localeCompare(right.eventKey)),
      checkpoints: Object.fromEntries([...this.checkpoints.entries()].sort(([left], [right]) => left.localeCompare(right))),
    };
  }

  private persistOpenInterestSnapshot(
    interval: FuturesKlineInterval,
    receivedTimestamp: number,
    snapshot: OpenInterestSnapshot | undefined,
  ) {
    if (!snapshot) {
      return;
    }

    const key = storageKeys.createOpenInterestKey(snapshot, interval);
    this.oiSnapshots.set(key, {
      ...snapshot,
      interval,
      sourceTimestamp: snapshot.timestamp,
      receivedTimestamp,
    });

    this.sourceEvents.set(`oi:${key}`, {
      eventKey: `oi:${key}`,
      eventType: "open_interest_snapshot",
      symbol: snapshot.symbol,
      interval,
      sourceTimestamp: snapshot.timestamp,
      receivedTimestamp,
      payload: { ...snapshot },
    });
  }
}
