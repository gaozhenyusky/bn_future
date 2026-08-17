import { describe, expect, it } from "vitest";

import type { ContractOnlyReason, FuturesCandle, MarketContext, OpenInterestSnapshot, TakerFlowSnapshot } from "../src/domain/futures";
import { computeFuturesMetrics } from "../src/analysis/futures-metrics";

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

describe("computeFuturesMetrics", () => {
  it("computes volume ratio against the median of the previous 20 same-interval candles", () => {
    const candle = createCandle({
      interval: "5m",
      volume: "42",
    });
    const baseline = Array.from({ length: 20 }, (_, index) =>
      createCandle({
        openTime: index,
        closeTime: index + 1,
        volume: String(index + 1),
        interval: "5m",
      }),
    ).concat(
      createCandle({
        openTime: 999,
        closeTime: 1_000,
        volume: "999",
        interval: "15m",
      }),
    );

    const metrics = computeFuturesMetrics(candle, baseline, createContext());

    expect(metrics.volumeRatio).toBeCloseTo(4, 6);
    expect(metrics.volumePercentile).toBeCloseTo(1, 6);
    expect(metrics.dataCompleteness).toBe("COMPLETE");
  });

  it("orders same-interval candles by openTime and uses only the latest 20 candles before the target", () => {
    const candle = createCandle({
      openTime: 200,
      closeTime: 205,
      interval: "5m",
      volume: "18",
    });
    const previousSameIntervalCandles = Array.from({ length: 25 }, (_, index) =>
      createCandle({
        openTime: 170 + index,
        closeTime: 171 + index,
        volume: String(index + 1),
        interval: "5m",
      }),
    );
    const baseline = previousSameIntervalCandles
      .concat(
        createCandle({
          openTime: 200,
          closeTime: 205,
          volume: "400",
          interval: "5m",
        }),
        createCandle({
          openTime: 206,
          closeTime: 211,
          volume: "500",
          interval: "5m",
        }),
        createCandle({
          openTime: 199,
          closeTime: 214,
          volume: "999",
          interval: "15m",
        }),
      )
      .reverse();

    const metrics = computeFuturesMetrics(candle, baseline, createContext());

    expect(metrics.volumeRatio).toBeCloseTo(18 / 15.5, 6);
    expect(metrics.volumePercentile).toBeCloseTo(13 / 20, 6);
    expect(metrics.dataCompleteness).toBe("COMPLETE");
  });

  it("marks zero baseline volume as insufficient baseline", () => {
    const baseline = Array.from({ length: 20 }, (_, index) =>
      createCandle({
        openTime: index,
        closeTime: index + 1,
        volume: "0",
      }),
    );

    const metrics = computeFuturesMetrics(createCandle(), baseline, createContext());

    expect(metrics.volumeRatio).toBe(0);
    expect(metrics.dataCompleteness).toBe("INSUFFICIENT_BASELINE");
  });

  it("computes OI value delta, unit delta, and price return", () => {
    const metrics = computeFuturesMetrics(
      createCandle({
        open: "10",
        close: "11",
      }),
      Array.from({ length: 20 }, (_, index) =>
        createCandle({
          openTime: index,
          closeTime: index + 1,
          volume: "10",
        }),
      ),
      createContext(),
    );

    expect(metrics.oiValueDelta).toBeCloseTo(0.2, 6);
    expect(metrics.oiUnitDelta).toBeCloseTo(0.2, 6);
    expect(metrics.priceReturn).toBeCloseTo(0.1, 6);
    expect(metrics.priceOiAlignment).toBe("PRICE_UP_OI_UP");
  });

  it("returns zero taker imbalance when buy and sell flow sum to zero", () => {
    const metrics = computeFuturesMetrics(
      createCandle(),
      Array.from({ length: 20 }, (_, index) =>
        createCandle({
          openTime: index,
          closeTime: index + 1,
          volume: "10",
        }),
      ),
      createContext({
        takerFlow: createTakerFlow({
          buyVol: "0",
          sellVol: "0",
        }),
      }),
    );

    expect(metrics.takerImbalance).toBe(0);
  });

  it("marks contract-only risk high when no Spot base asset exists", () => {
    const metrics = computeFuturesMetrics(
      createCandle(),
      Array.from({ length: 20 }, (_, index) =>
        createCandle({
          openTime: index,
          closeTime: index + 1,
          volume: "10",
        }),
      ),
      createContext({
        isContractOnly: true,
        contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
      }),
    );

    expect(metrics.contractOnlyRisk.level).toBe("HIGH");
    expect(metrics.contractOnlyRisk.reason).toBe("NO_ACTIVE_SPOT_BASE_ASSET");
  });

  it("marks the data incomplete when OI or taker context is absent", () => {
    const metrics = computeFuturesMetrics(
      createCandle(),
      Array.from({ length: 20 }, (_, index) =>
        createCandle({
          openTime: index,
          closeTime: index + 1,
          volume: "10",
        }),
      ),
      createContext({
        openInterest: undefined,
        previousOpenInterest: undefined,
        takerFlow: undefined,
      }),
    );

    expect(metrics.dataCompleteness).toBe("INCOMPLETE_CONTEXT");
  });
});
