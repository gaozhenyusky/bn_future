import { describe, expect, it } from "vitest";

import type {
  ContractOnlyReason,
  FuturesCandle,
  FuturesMetrics,
  FuturesThresholds,
  MarketContext,
  OpenInterestSnapshot,
  TakerFlowSnapshot,
} from "../src/domain/futures";
import { computeFuturesMetrics } from "../src/analysis/futures-metrics";
import {
  aggregateFuturesSignals,
  classifyFuturesSignal,
  createFuturesThresholds,
} from "../src/analysis/futures-classifier";
import { storageKeys } from "../src/storage/futures-repository";

function createThresholds(overrides?: Partial<FuturesThresholds>): FuturesThresholds {
  return {
    volumeRatioThreshold: 2,
    oiDeltaThreshold: 0.05,
    flatOiDeltaTolerance: 0.01,
    takerConfirmationThreshold: 0.05,
    thresholdVersion: "test-v1",
    ...overrides,
  };
}

function createMetrics(overrides?: Partial<FuturesMetrics>): FuturesMetrics {
  return {
    symbol: "HEIUSDT",
    interval: "5m",
    candleOpenTime: 1_000,
    candleCloseTime: 301_000,
    volumeRatio: 3,
    volumePercentile: 1,
    oiValueDelta: 0.2,
    oiUnitDelta: 0.2,
    priceReturn: 0.08,
    takerImbalance: 0.2,
    liquidationRatio: 0.016,
    priceOiAlignment: "PRICE_UP_OI_UP",
    dataCompleteness: "COMPLETE",
    contractOnlyRisk: {
      level: "LOW",
      reason: "SPOT_BASE_ASSET_PRESENT",
    },
    ...overrides,
  };
}

function createCandle(options?: Partial<FuturesCandle>): FuturesCandle {
  return {
    symbol: "HEIUSDT",
    interval: "5m",
    openTime: 1_000,
    open: "10",
    high: "11",
    low: "9.5",
    close: "11",
    volume: "42",
    closeTime: 301_000,
    quoteAssetVolume: "420",
    tradeCount: 100,
    takerBuyBaseAssetVolume: "25",
    takerBuyQuoteAssetVolume: "250",
    isClosed: true,
    raw: [],
    ...options,
  };
}

function createOpenInterest(options?: Partial<OpenInterestSnapshot>): OpenInterestSnapshot {
  return {
    symbol: "HEIUSDT",
    sumOpenInterest: "120",
    sumOpenInterestValue: "180",
    timestamp: 301_000,
    ...options,
  };
}

function createTakerFlow(options?: Partial<TakerFlowSnapshot>): TakerFlowSnapshot {
  return {
    symbol: "HEIUSDT",
    buySellRatio: "1.5",
    buyVol: "150",
    sellVol: "50",
    timestamp: 301_000,
    ...options,
  };
}

function createContext(options?: Partial<MarketContext> & {
  previousOpenInterest?: OpenInterestSnapshot;
  isContractOnly?: boolean;
  contractOnlyReason?: ContractOnlyReason;
}): MarketContext {
  return {
    symbol: "HEIUSDT",
    interval: "5m",
    candleOpenTime: 1_000,
    candleCloseTime: 301_000,
    openInterest: createOpenInterest(),
    previousOpenInterest: createOpenInterest({
      sumOpenInterest: "100",
      sumOpenInterestValue: "150",
      timestamp: 1,
    }),
    takerFlow: createTakerFlow(),
    sourceTimestamp: 301_000,
    receivedTimestamp: 301_500,
    isComplete: true,
    missing: [],
    ...options,
  };
}

describe("classifyFuturesSignal", () => {
  it("classifies positive price, positive OI, and high volume as a long buildup candidate", () => {
    const signal = classifyFuturesSignal(createMetrics(), createThresholds());

    expect(signal?.signalType).toBe("LONG_BUILDUP_CANDIDATE");
    expect(signal?.thresholdVersion).toBe("test-v1");
    expect(signal?.explanation).toContain("price");
  });

  it("classifies negative price, positive OI, and high volume as a short buildup candidate", () => {
    const signal = classifyFuturesSignal(
      createMetrics({
        priceReturn: -0.05,
        takerImbalance: -0.3,
        priceOiAlignment: "PRICE_DOWN_OI_UP",
      }),
      createThresholds(),
    );

    expect(signal?.signalType).toBe("SHORT_BUILDUP_CANDIDATE");
  });

  it("classifies positive price with negative OI as short covering", () => {
    const signal = classifyFuturesSignal(
      createMetrics({
        oiValueDelta: -0.1,
        oiUnitDelta: -0.12,
        priceOiAlignment: "PRICE_UP_OI_DOWN",
      }),
      createThresholds(),
    );

    expect(signal?.signalType).toBe("SHORT_COVERING");
  });

  it("classifies negative price with negative OI as long liquidation", () => {
    const signal = classifyFuturesSignal(
      createMetrics({
        priceReturn: -0.12,
        oiValueDelta: -0.15,
        oiUnitDelta: -0.15,
        takerImbalance: -0.25,
        priceOiAlignment: "PRICE_DOWN_OI_DOWN",
      }),
      createThresholds(),
    );

    expect(signal?.signalType).toBe("LONG_LIQUIDATION");
  });

  it("retains contract-only risk on a complete directional signal", () => {
    const signal = classifyFuturesSignal(
      createMetrics({
        contractOnlyRisk: {
          level: "HIGH",
          reason: "NO_ACTIVE_SPOT_BASE_ASSET",
        },
      }),
      createThresholds(),
    );

    expect(signal?.signalType).toBe("LONG_BUILDUP_CANDIDATE");
    expect(signal?.contractOnlyRisk).toEqual({
      level: "HIGH",
      reason: "NO_ACTIVE_SPOT_BASE_ASSET",
    });
    expect(signal?.evidence).toContain("contractOnlyReason=NO_ACTIVE_SPOT_BASE_ASSET");
  });

  it("emits a non-directional turnover explanation when volume is high but OI is flat", () => {
    const signal = classifyFuturesSignal(
      createMetrics({
        oiValueDelta: 0.002,
        oiUnitDelta: -0.001,
        priceOiAlignment: "FLAT_OI",
      }),
      createThresholds(),
    );

    expect(signal?.signalType).toBe("TURNOVER_ONLY");
    expect(signal?.explanation.toLowerCase()).toContain("turnover");
  });

  it("suppresses hot-direction signals when the baseline or context is incomplete", () => {
    expect(
      classifyFuturesSignal(
        createMetrics({
          dataCompleteness: "INSUFFICIENT_BASELINE",
        }),
        createThresholds(),
      ),
    ).toBeNull();

    expect(
      classifyFuturesSignal(
        createMetrics({
          dataCompleteness: "INCOMPLETE_CONTEXT",
        }),
        createThresholds(),
      ),
    ).toBeNull();
  });

  it("preserves contract-only risk on a directional signal when the baseline is normalized to the latest 20 earlier candles", () => {
    const candle = createCandle({
      openTime: 200,
      closeTime: 205,
      volume: "30",
    });
    const previousSameIntervalCandles = Array.from({ length: 25 }, (_, index) =>
      createCandle({
        openTime: 170 + index,
        closeTime: 171 + index,
        volume: String(index + 1),
      }),
    );
    const baseline = previousSameIntervalCandles
      .concat(
        createCandle({
          openTime: 200,
          closeTime: 205,
          volume: "400",
        }),
        createCandle({
          openTime: 206,
          closeTime: 211,
          volume: "500",
        }),
      )
      .reverse();
    const metrics = computeFuturesMetrics(
      candle,
      baseline,
      createContext({
        isContractOnly: true,
        contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
      }),
    );

    expect(metrics.volumeRatio).toBeCloseTo(30 / 15.5, 6);

    const signal = classifyFuturesSignal(
      metrics,
      createThresholds({
        volumeRatioThreshold: 1.9,
      }),
    );

    expect(signal?.signalType).toBe("LONG_BUILDUP_CANDIDATE");
    expect(signal?.contractOnlyRisk).toEqual({
      level: "HIGH",
      reason: "NO_ACTIVE_SPOT_BASE_ASSET",
    });
    expect(signal?.evidence).toContain("volumeRatio=1.94");
    expect(signal?.evidence).toContain("contractOnlyReason=NO_ACTIVE_SPOT_BASE_ASSET");
  });

  it("derives deterministic threshold versions from the effective config and changes signal keys when thresholds change", () => {
    const signalA = classifyFuturesSignal(
      createMetrics(),
      createFuturesThresholds(
        {
          futuresVolumeRatio5m: 2,
          futuresOiDelta5m: 0.05,
          futuresVolumeRatio15m: 1.5,
          futuresOiDelta15m: 0.08,
        },
        "5m",
      ),
    );
    const signalB = classifyFuturesSignal(
      createMetrics(),
      createFuturesThresholds(
        {
          futuresVolumeRatio5m: 2.25,
          futuresOiDelta5m: 0.07,
          futuresVolumeRatio15m: 1.5,
          futuresOiDelta15m: 0.08,
        },
        "5m",
      ),
    );

    expect(signalA?.thresholdVersion).toBe("cfg:5m:vr=2:oi=0.05:flat=0.01:taker=0.05");
    expect(signalB?.thresholdVersion).toBe("cfg:5m:vr=2.25:oi=0.07:flat=0.01:taker=0.05");
    expect(signalA?.thresholdVersion).not.toBe(signalB?.thresholdVersion);
    expect(storageKeys.createSignalKey(signalA!)).not.toBe(storageKeys.createSignalKey(signalB!));
  });
});

describe("aggregateFuturesSignals", () => {
  it("represents conflicting 5m and 15m directional signals as FUTURES_OI_CONFLICT", () => {
    const longSignal = classifyFuturesSignal(
      createMetrics({
        interval: "5m",
      }),
      createThresholds(),
    );
    const shortSignal = classifyFuturesSignal(
      createMetrics({
        interval: "15m",
        priceReturn: -0.1,
        oiValueDelta: -0.12,
        oiUnitDelta: -0.11,
        takerImbalance: -0.2,
        priceOiAlignment: "PRICE_DOWN_OI_DOWN",
      }),
      createThresholds({
        thresholdVersion: "test-v1-15m",
      }),
    );

    const aggregate = aggregateFuturesSignals([longSignal, shortSignal].filter(Boolean));

    expect(aggregate?.signalType).toBe("FUTURES_OI_CONFLICT");
    expect(aggregate?.evidence.join(" ")).toContain("5m");
    expect(aggregate?.evidence.join(" ")).toContain("15m");
  });

  it("canonicalizes reversed conflicting input order into the same conflict key and threshold version", () => {
    const fiveMinuteConflict = classifyFuturesSignal(
      createMetrics({
        interval: "5m",
      }),
      createThresholds({
        thresholdVersion: "cfg:5m:vr=2:oi=0.05:flat=0.01:taker=0.05",
      }),
    );
    const fifteenMinuteConflict = classifyFuturesSignal(
      createMetrics({
        interval: "15m",
        candleOpenTime: 1_000 + 900_000,
        candleCloseTime: 1_000 + 900_000 + 300_000,
        priceReturn: -0.1,
        oiValueDelta: -0.12,
        oiUnitDelta: -0.11,
        takerImbalance: -0.2,
        priceOiAlignment: "PRICE_DOWN_OI_DOWN",
      }),
      createThresholds({
        thresholdVersion: "cfg:15m:vr=2:oi=0.05:flat=0.01:taker=0.05",
      }),
    );

    const forwardAggregate = aggregateFuturesSignals([fiveMinuteConflict, fifteenMinuteConflict]);
    const reversedAggregate = aggregateFuturesSignals([fifteenMinuteConflict, fiveMinuteConflict]);

    expect(forwardAggregate).toEqual(reversedAggregate);
    expect(forwardAggregate?.evidence).toEqual([
      "5m:LONG_BUILDUP_CANDIDATE",
      "15m:LONG_LIQUIDATION",
    ]);
    expect(forwardAggregate?.thresholdVersion).toBe(
      "cfg:5m:vr=2:oi=0.05:flat=0.01:taker=0.05|cfg:15m:vr=2:oi=0.05:flat=0.01:taker=0.05",
    );
    expect(reversedAggregate?.thresholdVersion).toBe(forwardAggregate?.thresholdVersion);
  });
});
