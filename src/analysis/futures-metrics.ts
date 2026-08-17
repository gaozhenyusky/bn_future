import type {
  ContractOnlyReason,
  FuturesCandle,
  FuturesContractOnlyRisk,
  FuturesDataCompleteness,
  FuturesMetrics,
  FuturesPriceOiAlignment,
  MarketContext,
} from "../domain/futures";

function parseNumericString(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

function computeRelativeDelta(currentValue: number, previousValue: number): number {
  if (previousValue === 0) {
    return 0;
  }

  return (currentValue - previousValue) / previousValue;
}

function computeVolumePercentile(currentVolume: number, baselineVolumes: readonly number[]): number {
  if (baselineVolumes.length === 0) {
    return 0;
  }

  const countAtOrBelow = baselineVolumes.filter((volume) => volume <= currentVolume).length;
  return countAtOrBelow / baselineVolumes.length;
}

function compareCandlesByOpenTime(left: FuturesCandle, right: FuturesCandle): number {
  if (left.openTime !== right.openTime) {
    return left.openTime - right.openTime;
  }

  return left.closeTime - right.closeTime;
}

function selectBaselineWindow(
  candle: FuturesCandle,
  baseline: readonly FuturesCandle[],
  context: MarketContext,
): FuturesCandle[] {
  const targetInterval = candle.interval ?? context.interval;

  return baseline
    .filter((baselineCandle) => {
      if (baselineCandle.openTime >= candle.openTime) {
        return false;
      }

      if (targetInterval === undefined) {
        return true;
      }

      return baselineCandle.interval === targetInterval;
    })
    .sort(compareCandlesByOpenTime)
    .slice(-20);
}

function determinePriceOiAlignment(priceReturn: number, oiDirectionalDelta: number): FuturesPriceOiAlignment {
  if (priceReturn === 0) {
    return "FLAT_PRICE";
  }

  if (oiDirectionalDelta === 0) {
    return "FLAT_OI";
  }

  if (priceReturn > 0 && oiDirectionalDelta > 0) {
    return "PRICE_UP_OI_UP";
  }

  if (priceReturn < 0 && oiDirectionalDelta > 0) {
    return "PRICE_DOWN_OI_UP";
  }

  if (priceReturn > 0 && oiDirectionalDelta < 0) {
    return "PRICE_UP_OI_DOWN";
  }

  if (priceReturn < 0 && oiDirectionalDelta < 0) {
    return "PRICE_DOWN_OI_DOWN";
  }

  return "UNAVAILABLE";
}

function determineDataCompleteness(
  baselineVolumes: readonly number[],
  baselineMedian: number,
  context: MarketContext,
): FuturesDataCompleteness {
  if (baselineVolumes.length < 20 || baselineMedian <= 0) {
    return "INSUFFICIENT_BASELINE";
  }

  if (!context.openInterest || !context.previousOpenInterest || !context.takerFlow) {
    return "INCOMPLETE_CONTEXT";
  }

  return "COMPLETE";
}

function determineContractOnlyRisk(context: MarketContext): FuturesContractOnlyRisk {
  const reason: ContractOnlyReason | "SPOT_BASE_ASSET_PRESENT" =
    context.contractOnlyReason ?? "SPOT_BASE_ASSET_PRESENT";

  if (context.isContractOnly || reason === "NO_ACTIVE_SPOT_BASE_ASSET") {
    return {
      level: "HIGH",
      reason: "NO_ACTIVE_SPOT_BASE_ASSET",
    };
  }

  return {
    level: "LOW",
    reason,
  };
}

export function computeFuturesMetrics(
  candle: FuturesCandle,
  baseline: readonly FuturesCandle[],
  context: MarketContext,
): FuturesMetrics {
  const baselineWindow = selectBaselineWindow(candle, baseline, context);
  const baselineVolumes = baselineWindow.map((baselineCandle) => parseNumericString(baselineCandle.volume));
  const baselineMedian = median(baselineVolumes);
  const currentVolume = parseNumericString(candle.volume);
  const currentOpen = parseNumericString(candle.open);
  const currentClose = parseNumericString(candle.close);
  const currentOpenInterestValue = parseNumericString(context.openInterest?.sumOpenInterestValue);
  const previousOpenInterestValue = parseNumericString(context.previousOpenInterest?.sumOpenInterestValue);
  const currentOpenInterestUnits = parseNumericString(context.openInterest?.sumOpenInterest);
  const previousOpenInterestUnits = parseNumericString(context.previousOpenInterest?.sumOpenInterest);
  const buyVolume = parseNumericString(context.takerFlow?.buyVol);
  const sellVolume = parseNumericString(context.takerFlow?.sellVol);
  const takerDenominator = buyVolume + sellVolume;
  const oiValueDelta = computeRelativeDelta(currentOpenInterestValue, previousOpenInterestValue);
  const oiUnitDelta = computeRelativeDelta(currentOpenInterestUnits, previousOpenInterestUnits);
  const oiDirectionalDelta = oiUnitDelta !== 0 ? oiUnitDelta : oiValueDelta;
  const priceReturn = currentOpen === 0 ? 0 : (currentClose - currentOpen) / currentOpen;

  return {
    symbol: candle.symbol ?? context.symbol,
    interval: candle.interval ?? context.interval,
    candleOpenTime: candle.openTime,
    candleCloseTime: candle.closeTime,
    volumeRatio: baselineMedian === 0 ? 0 : currentVolume / baselineMedian,
    volumePercentile: computeVolumePercentile(currentVolume, baselineVolumes),
    oiValueDelta,
    oiUnitDelta,
    oiAccumulationDelta: context.oiAccumulation?.delta,
    oiAccumulationWindowLabel: context.oiAccumulation?.windowLabel,
    oiAccumulationSamples: context.oiAccumulation?.samples,
    priceReturn,
    takerImbalance: takerDenominator === 0 ? 0 : (buyVolume - sellVolume) / takerDenominator,
    liquidationRatio: Math.abs(priceReturn * oiDirectionalDelta),
    priceOiAlignment: determinePriceOiAlignment(priceReturn, oiDirectionalDelta),
    dataCompleteness: determineDataCompleteness(baselineVolumes, baselineMedian, context),
    contractOnlyRisk: determineContractOnlyRisk(context),
  };
}
