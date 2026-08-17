import type {
  BitgetMarketCandle,
  BitgetReferenceFactor,
  BitgetReferenceInput,
  BitgetReferenceMissingField,
  BitgetReferenceSignalBias,
  BitgetReferenceStatus,
  BitgetReferenceThresholds,
} from "../domain/bitget-reference";
import type { FuturesSignal, FuturesSignalType } from "../domain/futures";

const INTERVAL_MS: Record<"5m" | "15m", number> = {
  "5m": 300_000,
  "15m": 900_000,
};

function getSignalBias(signalType: FuturesSignalType): BitgetReferenceSignalBias {
  if (signalType === "LONG_BUILDUP_CANDIDATE" || signalType === "SHORT_COVERING") {
    return "LONG";
  }

  if (signalType === "SHORT_BUILDUP_CANDIDATE" || signalType === "LONG_LIQUIDATION") {
    return "SHORT";
  }

  return null;
}

function isDirectionalSignal(signal: FuturesSignal): boolean {
  return getSignalBias(signal.signalType) !== null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sortAscending(values: number[]): number[] {
  return [...values].sort((left, right) => left - right);
}

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const ordered = sortAscending(values);
  const middle = Math.floor(ordered.length / 2);

  if (ordered.length % 2 === 0) {
    return (ordered[middle - 1]! + ordered[middle]!) / 2;
  }

  return ordered[middle];
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "缺失";
  }

  return `${(value * 100).toFixed(2)}%`;
}

function formatRatio(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "缺失";
  }

  return value.toFixed(2);
}

function resolveAlignedCandle(
  candles: ReadonlyArray<BitgetMarketCandle> | undefined,
  input: BitgetReferenceInput,
): BitgetMarketCandle | undefined {
  if (!candles) {
    return undefined;
  }

  const intervalMs = INTERVAL_MS[input.interval];
  const targetOpenTime = input.candleOpenTime;
  const targetCloseTime = input.candleOpenTime + intervalMs;

  return candles
    .filter((candle) => candle.interval === input.interval)
    .find((candle) => candle.openTime === targetOpenTime && candle.openTime + intervalMs === targetCloseTime && targetCloseTime <= input.binanceCloseTime);
}

function computePriceReturn(candle: BitgetMarketCandle | undefined): number | undefined {
  if (!candle || candle.open === undefined || candle.close === undefined || candle.open === 0) {
    return undefined;
  }

  return (candle.close - candle.open) / candle.open;
}

function computeVolumeRatio(
  candles: ReadonlyArray<BitgetMarketCandle> | undefined,
  aligned: BitgetMarketCandle | undefined,
): number | undefined {
  if (!candles || !aligned || aligned.volumeQuote === undefined) {
    return undefined;
  }

  const baseline = candles
    .filter((candle) => candle.interval === aligned.interval && candle.openTime < aligned.openTime)
    .map((candle) => candle.volumeQuote)
    .filter((value): value is number => value !== undefined && Number.isFinite(value))
    .slice(-20);

  const baselineMedian = median(baseline);
  if (baselineMedian === undefined || baselineMedian === 0) {
    return undefined;
  }

  return aligned.volumeQuote / baselineMedian;
}

function computeOiDelta(input: BitgetReferenceInput): number | undefined {
  const current = input.openInterest?.openInterest;
  const previous = input.previousOpenInterest?.openInterest;

  if (current === undefined || previous === undefined || previous === 0) {
    return undefined;
  }

  return (current - previous) / previous;
}

function computeBasis(
  spotCandle: BitgetMarketCandle | undefined,
  futuresCandle: BitgetMarketCandle | undefined,
): number | undefined {
  if (!spotCandle || !futuresCandle || spotCandle.close === undefined || futuresCandle.close === undefined || spotCandle.close === 0) {
    return undefined;
  }

  return (futuresCandle.close - spotCandle.close) / spotCandle.close;
}

function computePriceGap(binanceClose: number, futuresCandle: BitgetMarketCandle | undefined): number | undefined {
  if (!futuresCandle || futuresCandle.close === undefined || binanceClose === 0) {
    return undefined;
  }

  return (futuresCandle.close - binanceClose) / binanceClose;
}

function getDirectionalContribution(
  label: "现货" | "合约",
  signalBias: BitgetReferenceSignalBias,
  priceReturn: number | undefined,
  thresholds: BitgetReferenceThresholds,
  evidence: string[],
  missing: Set<BitgetReferenceMissingField>,
): number {
  if (signalBias === null) {
    return 0;
  }

  if (priceReturn === undefined) {
    missing.add(label === "现货" ? "spotDirection" : "futuresDirection");
    return 0;
  }

  if (Math.abs(priceReturn) < thresholds.directionalReturnThreshold) {
    evidence.push(
      `Bitget${label}方向不足阈值：收益率=${formatPercent(priceReturn)}，directionalReturnThreshold=${formatPercent(
        thresholds.directionalReturnThreshold,
      )}`,
    );
    return 0;
  }

  const sameDirection = (signalBias === "LONG" && priceReturn > 0) || (signalBias === "SHORT" && priceReturn < 0);

  if (sameDirection) {
    evidence.push(
      `Bitget${label}方向一致：收益率=${formatPercent(priceReturn)}，directionalReturnThreshold=${formatPercent(
        thresholds.directionalReturnThreshold,
      )}`,
    );
    return 0.35;
  }

  evidence.push(
    `Bitget${label}方向相反：收益率=${formatPercent(priceReturn)}，directionalReturnThreshold=${formatPercent(
      thresholds.directionalReturnThreshold,
    )}`,
  );
  return -0.35;
}

function dedupeEvidence(evidence: readonly string[]): string[] {
  return Array.from(new Set(evidence));
}

export function calculateBitgetReference(input: BitgetReferenceInput): BitgetReferenceFactor {
  const evidence: string[] = [];
  const missing = new Set<BitgetReferenceMissingField>(input.unavailable ?? []);

  if ((input.unavailable?.length ?? 0) > 0) {
    evidence.push(`Bitget数据不可用字段=${(input.unavailable ?? []).join(",")}`);
  }

  const spotCandle = resolveAlignedCandle(input.spotCandles, input);
  const futuresCandle = resolveAlignedCandle(input.futuresCandles, input);
  const spotPriceReturn = computePriceReturn(spotCandle);
  const futuresPriceReturn = computePriceReturn(futuresCandle);
  const spotQuoteVolumeRatio = computeVolumeRatio(input.spotCandles, spotCandle);
  const futuresQuoteVolumeRatio = computeVolumeRatio(input.futuresCandles, futuresCandle);
  const oiDelta = computeOiDelta(input);
  const basis = computeBasis(spotCandle, futuresCandle);
  const priceGap = computePriceGap(input.binanceClose, futuresCandle);

  if (spotCandle === undefined && !(input.unavailable ?? []).includes("spotCandles")) {
    missing.add("spotCandles");
  }
  if (futuresCandle === undefined && !(input.unavailable ?? []).includes("futuresCandles")) {
    missing.add("futuresCandles");
  }
  if (spotQuoteVolumeRatio === undefined) {
    missing.add("spotQuoteVolumeRatio");
  }
  if (futuresQuoteVolumeRatio === undefined) {
    missing.add("futuresQuoteVolumeRatio");
  }
  if (input.openInterest === undefined) {
    missing.add("openInterest");
  }
  if (input.previousOpenInterest === undefined) {
    missing.add("previousOpenInterest");
  }
  if (oiDelta === undefined && input.openInterest !== undefined && input.previousOpenInterest !== undefined) {
    missing.add("openInterest");
  }
  if (basis === undefined) {
    missing.add("basis");
  }
  if (priceGap === undefined) {
    missing.add("priceGap");
  }

  let score = 0;
  score += getDirectionalContribution("现货", input.signalBias, spotPriceReturn, input.thresholds, evidence, missing);
  score += getDirectionalContribution("合约", input.signalBias, futuresPriceReturn, input.thresholds, evidence, missing);

  if (spotQuoteVolumeRatio !== undefined) {
    evidence.push(`Bitget现货成交额比=${formatRatio(spotQuoteVolumeRatio)}`);
    score += 0.05;
  }

  if (futuresQuoteVolumeRatio !== undefined) {
    evidence.push(`Bitget合约成交额比=${formatRatio(futuresQuoteVolumeRatio)}`);
    score += 0.05;
  }

  if (oiDelta !== undefined && futuresCandle !== undefined) {
    const sameDirection =
      input.signalBias !== null &&
      ((input.signalBias === "LONG" && oiDelta >= input.thresholds.oiDeltaThreshold) ||
        (input.signalBias === "SHORT" && oiDelta >= input.thresholds.oiDeltaThreshold));
    if (sameDirection) {
      evidence.push(
        `Bitget合约持仓变化一致：变化=${formatPercent(oiDelta)}，oiDeltaThreshold=${formatPercent(
          input.thresholds.oiDeltaThreshold,
        )}`,
      );
      score += 0.2;
    } else if (Math.abs(oiDelta) >= input.thresholds.oiDeltaThreshold) {
      evidence.push(
        `Bitget合约持仓变化偏弱：变化=${formatPercent(oiDelta)}，oiDeltaThreshold=${formatPercent(
          input.thresholds.oiDeltaThreshold,
        )}`,
      );
    }
  }

  if (input.fundingRate?.fundingRate !== undefined) {
    evidence.push(`Bitget资金费率=${formatPercent(input.fundingRate.fundingRate)}`);
  } else {
    missing.add("fundingRate");
  }

  if (basis !== undefined) {
    evidence.push(`Bitget合约基差=${formatPercent(basis)}`);
  }

  if (priceGap !== undefined) {
    evidence.push(
      `Bitget跨所价差=${formatPercent(priceGap)}，priceGapThreshold=${formatPercent(input.thresholds.priceGapThreshold)}`,
    );
    if (Math.abs(priceGap) > input.thresholds.priceGapThreshold) {
      score -= 0.05;
    }
  }

  let status: BitgetReferenceStatus;
  let completeness: BitgetReferenceFactor["completeness"];

  const unavailableOnly =
    (input.unavailable?.includes("spotCandles") ?? false) &&
    (input.unavailable?.includes("futuresCandles") ?? false) &&
    (input.unavailable?.includes("openInterest") ?? false) &&
    ((input.unavailable?.includes("fundingRate") ?? false) || input.fundingRate?.fundingRate === undefined) &&
    spotCandle === undefined &&
    futuresCandle === undefined &&
    input.openInterest === undefined &&
    input.previousOpenInterest === undefined &&
    input.fundingRate?.fundingRate === undefined;

  if (unavailableOnly) {
    status = "BITGET_UNAVAILABLE";
    completeness = "MISSING";
    score = 0;
  } else if (missing.size === 0) {
    completeness = "COMPLETE";
    status = score > 0 ? "BITGET_CONFIRMED" : score < 0 ? "BITGET_CONTRADICTED" : "BITGET_INCOMPLETE";
  } else {
    completeness = "PARTIAL";
    status = "BITGET_INCOMPLETE";
  }

  const boundedScore = clamp(score, -1, 1);
  const confidenceAdjustment =
    status === "BITGET_CONFIRMED" || status === "BITGET_CONTRADICTED"
      ? clamp(boundedScore, -input.thresholds.confidenceAdjustmentCap, input.thresholds.confidenceAdjustmentCap)
      : 0;

  const observedAtCandidates = [
    spotCandle?.sourceTimestamp,
    futuresCandle?.sourceTimestamp,
    input.openInterest?.sourceTimestamp,
    input.previousOpenInterest?.sourceTimestamp,
    input.fundingRate?.receivedTimestamp,
  ].filter((value): value is number => value !== undefined);

  const finalMissing = unavailableOnly ? [...(input.unavailable ?? [])] : Array.from(missing);

  return {
    provider: "bitget",
    symbol: input.symbol,
    interval: input.interval,
    candleOpenTime: input.candleOpenTime,
    signalType: input.signalType,
    signalBias: input.signalBias,
    status,
    completeness,
    score: boundedScore,
    confidenceAdjustment,
    missing: finalMissing,
    evidence: dedupeEvidence(evidence),
    alignedSpotOpenTime: spotCandle?.openTime,
    alignedFuturesOpenTime: futuresCandle?.openTime,
    spotPriceReturn,
    futuresPriceReturn,
    spotQuoteVolumeRatio,
    futuresQuoteVolumeRatio,
    oiDelta,
    fundingRate: input.fundingRate?.fundingRate,
    basis,
    priceGap,
    observedAt: observedAtCandidates.length === 0 ? input.binanceCloseTime : Math.max(...observedAtCandidates),
  };
}

export function applyBitgetReference(signal: FuturesSignal, factor: BitgetReferenceFactor): FuturesSignal {
  const combinedEvidence = dedupeEvidence([
    ...signal.evidence,
    `bitgetStatus=${factor.status}`,
    ...factor.evidence,
  ]);

  if (!isDirectionalSignal(signal) || factor.status === "BITGET_UNAVAILABLE") {
    return {
      ...signal,
      evidence: combinedEvidence,
    };
  }

  if (factor.status !== "BITGET_CONFIRMED" && factor.status !== "BITGET_CONTRADICTED") {
    return {
      ...signal,
      evidence: combinedEvidence,
    };
  }

  return {
    ...signal,
    confidence: clamp(signal.confidence + factor.confidenceAdjustment, 0, 1),
    evidence: combinedEvidence,
  };
}
