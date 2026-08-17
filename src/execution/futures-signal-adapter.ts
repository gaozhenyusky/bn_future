import {
  calculateFuturesOiAnomalyScore,
  type FuturesOiFactorThresholds,
} from "../analysis/futures-oi-factors";
import type { AppConfig } from "../config";
import type {
  FuturesCandle,
  FuturesMetrics,
  FuturesSignal,
} from "../domain/futures";
import type { ExecutionSignal } from "./types";

type SignalThresholdConfig =
  | FuturesOiFactorThresholds
  | (Pick<
      AppConfig,
      "futuresVolumeRatio5m" | "futuresOiDelta5m" | "futuresVolumeRatio15m" | "futuresOiDelta15m" | "futuresOiAccumulationThreshold"
    > &
      Partial<Pick<AppConfig, "futuresPriceReturn5mThreshold">>);

function normalizeThresholds(config: SignalThresholdConfig): FuturesOiFactorThresholds {
  if ("5m" in config) return config;

  return {
    "5m": { oi: config.futuresOiDelta5m, volume: config.futuresVolumeRatio5m, price5m: config.futuresPriceReturn5mThreshold ?? 0.03, oiAccumulation: config.futuresOiAccumulationThreshold ?? 0.3 },
    "15m": { oi: config.futuresOiDelta15m, volume: config.futuresVolumeRatio15m, price5m: config.futuresPriceReturn5mThreshold ?? 0.03, oiAccumulation: config.futuresOiAccumulationThreshold ?? 0.3 },
  };
}

/**
 * Converts a closed Binance radar observation into the narrower execution
 * contract.  The execution risk policy repeats every hard gate; this adapter
 * only prevents non-actionable radar records from entering that layer.
 */
export function toExecutionSignal(
  signal: FuturesSignal,
  metrics: FuturesMetrics,
  candle: FuturesCandle,
  thresholds: SignalThresholdConfig,
  slippageBps: number,
  maxSlippageBps = 15,
): ExecutionSignal | null {
  if (signal.signalType !== "LONG_BUILDUP_CANDIDATE") return null;
  if (candle.isClosed === false) return null;
  if (metrics.dataCompleteness !== "COMPLETE") return null;
  if (metrics.contractOnlyRisk.level !== "HIGH" || metrics.contractOnlyRisk.reason !== "NO_ACTIVE_SPOT_BASE_ASSET") {
    return null;
  }
  if (metrics.priceOiAlignment !== "PRICE_UP_OI_UP") return null;

  const normalizedThresholds = normalizeThresholds(thresholds);
  const threshold = normalizedThresholds[metrics.interval];
  const activeBuyConfirmed = metrics.takerImbalance >= 0.05;
  const anomalyScore = calculateFuturesOiAnomalyScore({
    interval: metrics.interval,
    oiValueDelta: metrics.oiValueDelta,
    volumeRatio: metrics.volumeRatio,
    priceReturn: metrics.priceReturn,
    priceReturn5m: metrics.interval === "5m" ? metrics.priceReturn : 0,
    takerImbalance: metrics.takerImbalance,
    priceOiAlignment: metrics.priceOiAlignment,
    dataCompleteness: metrics.dataCompleteness,
    isContractOnly: true,
  }, normalizedThresholds);
  const dedupeKey = `${metrics.symbol}:${metrics.interval}:${metrics.candleOpenTime}`;

  return {
    signalId: `${dedupeKey}:${signal.signalType}`,
    dedupeKey,
    symbol: metrics.symbol,
    interval: metrics.interval,
    detectedAt: candle.closeTime,
    side: "LONG",
    isContractOnly: true,
    contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
    anomalyScore,
    priceOiAlignment: metrics.priceOiAlignment,
    oiValueDelta: metrics.oiValueDelta,
    oiDeltaThreshold: threshold.oi,
    volumeRatio: metrics.volumeRatio,
    volumeThreshold: threshold.volume,
    dataCompleteness: metrics.dataCompleteness,
    activeBuyConfirmed,
    slippageBps,
    maxSlippageBps,
    referencePrice: Number(candle.close),
    entryPrice: Number(candle.close),
    breakoutContext: signal.breakoutContext,
    positionPercentile: signal.positionPercentile,
    move24h: signal.move24h,
  };
}

/**
 * 埋伏开单信号：低位启动 + 空头燃料堆积，不要求放量增仓确认。
 * 方向性门槛（PRICE_UP_OI_UP / OI 阈值 / 数据完整 / 主动买盘）由风险策略
 * 在 AMBUSH 模式下放宽，此处仅要求基础信息可用。
 */
export function toAmbushExecutionSignal(
  signal: FuturesSignal,
  metrics: FuturesMetrics,
  candle: FuturesCandle,
  slippageBps = 0,
  maxSlippageBps = 15,
): ExecutionSignal | null {
  if (signal.signalType !== "AMBUSH_CANDIDATE") return null;
  if (candle.isClosed === false) return null;
  if (metrics.contractOnlyRisk.level !== "HIGH" || metrics.contractOnlyRisk.reason !== "NO_ACTIVE_SPOT_BASE_ASSET") {
    return null;
  }
  if (signal.breakoutContext !== "LOW_POSITION_BREAKOUT") return null;

  const anomalyScore = calculateFuturesOiAnomalyScore({
    interval: metrics.interval,
    oiValueDelta: metrics.oiValueDelta,
    volumeRatio: metrics.volumeRatio,
    priceReturn: metrics.priceReturn,
    priceReturn5m: metrics.interval === "5m" ? metrics.priceReturn : 0,
    takerImbalance: metrics.takerImbalance,
    priceOiAlignment: metrics.priceOiAlignment,
    dataCompleteness: metrics.dataCompleteness,
    isContractOnly: true,
    shortFuel:
      signal.shortFuelScore !== undefined
        ? {
            score: signal.shortFuelScore,
            level: signal.shortFuelScore >= 10 ? "HIGH" : "WARNING",
            evidence: ["埋伏开单：低位 + 空头燃料堆积"],
            dataAvailable: true,
          }
        : undefined,
  });

  const dedupeKey = `${metrics.symbol}:${metrics.interval}:${metrics.candleOpenTime}`;
  return {
    signalId: `${dedupeKey}:AMBUSH`,
    dedupeKey,
    symbol: metrics.symbol,
    interval: metrics.interval,
    detectedAt: candle.closeTime,
    side: "LONG",
    isContractOnly: true,
    contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
    anomalyScore,
    priceOiAlignment: metrics.priceOiAlignment,
    oiValueDelta: metrics.oiValueDelta,
    oiDeltaThreshold: 0,
    volumeRatio: metrics.volumeRatio,
    volumeThreshold: 0,
    dataCompleteness: metrics.dataCompleteness,
    activeBuyConfirmed: false,
    slippageBps,
    maxSlippageBps,
    referencePrice: Number(candle.close),
    entryPrice: Number(candle.close),
    breakoutContext: signal.breakoutContext,
    positionPercentile: signal.positionPercentile,
    move24h: signal.move24h,
    entryMode: "AMBUSH",
    shortFuelScore: signal.shortFuelScore,
  };
}
