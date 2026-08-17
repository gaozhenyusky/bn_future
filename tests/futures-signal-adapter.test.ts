import { describe, expect, it } from "vitest";
import { toExecutionSignal } from "../src/execution/futures-signal-adapter";
import type { FuturesCandle, FuturesMetrics, FuturesSignal } from "../src/domain/futures";

const signal: FuturesSignal = {
  signalType: "LONG_BUILDUP_CANDIDATE",
  severity: "HIGH",
  confidence: 0.9,
  explanation: "long buildup",
  evidence: [],
  symbol: "HEIUSDT",
  interval: "5m",
  candleOpenTime: 1_000,
  thresholdVersion: "cfg:5m",
};

const candle: FuturesCandle = {
  symbol: "HEIUSDT", interval: "5m", openTime: 1_000, open: "100", high: "111", low: "99", close: "110",
  volume: "250", closeTime: 301_000, quoteAssetVolume: "27_500", tradeCount: 10,
  takerBuyBaseAssetVolume: "150", takerBuyQuoteAssetVolume: "16_500", isClosed: true, raw: {},
};

const metrics: FuturesMetrics = {
  symbol: "HEIUSDT", interval: "5m", candleOpenTime: 1_000, candleCloseTime: 301_000,
  volumeRatio: 2.4, volumePercentile: 0.9, oiValueDelta: 0.11, oiUnitDelta: 0.1, priceReturn: 0.1,
  takerImbalance: 0.2, liquidationRatio: 0, priceOiAlignment: "PRICE_UP_OI_UP", dataCompleteness: "COMPLETE",
  contractOnlyRisk: { level: "HIGH", reason: "NO_ACTIVE_SPOT_BASE_ASSET" },
};

describe("toExecutionSignal", () => {
  it("converts only complete contract-only long buildup signals with independent thresholds", () => {
    const result = toExecutionSignal(signal, metrics, candle, {
      futuresVolumeRatio5m: 2, futuresOiDelta5m: 0.05, futuresVolumeRatio15m: 1.5, futuresOiDelta15m: 0.08,
    }, 12);

    expect(result).toMatchObject({
      symbol: "HEIUSDT", side: "LONG", isContractOnly: true, oiValueDelta: 0.11, oiDeltaThreshold: 0.05,
      volumeRatio: 2.4, volumeThreshold: 2, slippageBps: 12, entryPrice: 110,
    });
  });

  const invalidCases: Array<[string, { signal?: Partial<FuturesSignal>; metrics?: Partial<FuturesMetrics> }]> = [
    ["short signal", { signal: { signalType: "SHORT_BUILDUP_CANDIDATE" } }],
    ["spot-backed metric", { metrics: { contractOnlyRisk: { level: "LOW", reason: "SPOT_BASE_ASSET_PRESENT" } } }],
    ["incomplete metric", { metrics: { dataCompleteness: "INCOMPLETE_CONTEXT" } }],
  ];
  it.each(invalidCases)("rejects %s", (_label, overrides) => {
    expect(toExecutionSignal({ ...signal, ...overrides.signal }, { ...metrics, ...overrides.metrics } as FuturesMetrics, candle, {
      futuresVolumeRatio5m: 2, futuresOiDelta5m: 0.05, futuresVolumeRatio15m: 1.5, futuresOiDelta15m: 0.08,
    }, 0)).toBeNull();
  });
});
