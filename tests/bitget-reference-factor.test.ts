import { describe, expect, it } from "vitest";

import {
  applyBitgetReference,
  calculateBitgetReference,
} from "../src/analysis/bitget-reference-factor";
import type {
  BitgetFundingRate,
  BitgetMarketCandle,
  BitgetOpenInterest,
  BitgetReferenceInput,
  BitgetReferenceThresholds,
} from "../src/domain/bitget-reference";
import type { FuturesSignal } from "../src/domain/futures";

const FIVE_MINUTES_MS = 300_000;

function createThresholds(overrides?: Partial<BitgetReferenceThresholds>): BitgetReferenceThresholds {
  return {
    directionalReturnThreshold: 0.001,
    oiDeltaThreshold: 0.02,
    priceGapThreshold: 0.003,
    confidenceAdjustmentCap: 0.1,
    ...overrides,
  };
}

function createCandle(options: {
  openTime: number;
  open: number;
  close: number;
  volumeQuote: number | undefined;
  symbol?: string;
  interval?: "5m" | "15m";
}): BitgetMarketCandle {
  return {
    symbol: options.symbol ?? "BTCUSDT",
    interval: options.interval ?? "5m",
    openTime: options.openTime,
    open: options.open,
    high: Math.max(options.open, options.close),
    low: Math.min(options.open, options.close),
    close: options.close,
    volumeBase: 10,
    volumeQuote: options.volumeQuote,
    sourceTimestamp: options.openTime,
    receivedTimestamp: options.openTime + FIVE_MINUTES_MS,
    raw: [options.openTime, options.open, options.close],
  };
}

function createOpenInterest(openInterest: number | undefined, sourceTimestamp = 1_700_000_300_000): BitgetOpenInterest {
  return {
    symbol: "BTCUSDT",
    openInterest,
    sourceTimestamp,
    receivedTimestamp: sourceTimestamp + 1_000,
  };
}

function createFundingRate(fundingRate: number | undefined): BitgetFundingRate {
  return {
    symbol: "BTCUSDT",
    productType: "usdt-futures",
    fundingRate,
    fundingRateIntervalHours: 8,
    nextUpdate: 1_700_000_600_000,
    minFundingRate: -0.003,
    maxFundingRate: 0.003,
    receivedTimestamp: 1_700_000_301_000,
  };
}

function createDirectionalSignal(overrides?: Partial<FuturesSignal>): FuturesSignal {
  return {
    signalType: "LONG_BUILDUP_CANDIDATE",
    severity: "WARNING",
    confidence: 0.55,
    explanation: "binance directional candidate",
    evidence: ["priceReturn=2.00%"],
    symbol: "BTCUSDT",
    interval: "5m",
    candleOpenTime: 1_700_000_000_000,
    thresholdVersion: "test-v1",
    ...overrides,
  };
}

function createInput(overrides?: Partial<BitgetReferenceInput>): BitgetReferenceInput {
  const candleOpenTime = 1_700_000_000_000;
  const alignedOpenTime = candleOpenTime;
  const previousStart = alignedOpenTime - FIVE_MINUTES_MS * 20;
  const previousVolumes = Array.from({ length: 20 }, (_, index) =>
    createCandle({
      openTime: previousStart + index * FIVE_MINUTES_MS,
      open: 100 + index,
      close: 100.5 + index,
      volumeQuote: 100 + index,
    }),
  );

  return {
    symbol: "BTCUSDT",
    interval: "5m",
    candleOpenTime,
    signalType: "LONG_BUILDUP_CANDIDATE",
    signalBias: "LONG",
    binanceOpen: 100,
    binanceClose: 101,
    binanceCloseTime: candleOpenTime + FIVE_MINUTES_MS,
    spotCandles: previousVolumes.concat(
      createCandle({
        openTime: alignedOpenTime,
        open: 100,
        close: 102,
        volumeQuote: 240,
      }),
    ),
    futuresCandles: previousVolumes.map((candle) =>
      createCandle({
        openTime: candle.openTime,
        open: (candle.open ?? 100) + 20,
        close: (candle.close ?? 100) + 20,
        volumeQuote: (candle.volumeQuote ?? 100) * 2,
      }),
    ).concat(
      createCandle({
        openTime: alignedOpenTime,
        open: 120,
        close: 123,
        volumeQuote: 460,
      }),
    ),
    openInterest: createOpenInterest(120),
    previousOpenInterest: createOpenInterest(100, 1_699_999_700_000),
    fundingRate: createFundingRate(0.0006),
    thresholds: createThresholds(),
    unavailable: [],
    ...overrides,
  };
}

describe("calculateBitgetReference", () => {
  it("marks complete confirmation when both Bitget markets align with a Binance long signal and OI rises above threshold", () => {
    const factor = calculateBitgetReference(createInput());

    expect(factor.status).toBe("BITGET_CONFIRMED");
    expect(factor.completeness).toBe("COMPLETE");
    expect(factor.score).toBeGreaterThan(0);
    expect(factor.signalBias).toBe("LONG");
    expect(factor.spotPriceReturn).toBeCloseTo(0.02, 6);
    expect(factor.futuresPriceReturn).toBeCloseTo(0.025, 6);
    expect(factor.oiDelta).toBeCloseTo(0.2, 6);
    expect(factor.spotQuoteVolumeRatio).toBeCloseTo(240 / 109.5, 6);
    expect(factor.futuresQuoteVolumeRatio).toBeCloseTo(460 / 219, 6);
    expect(factor.missing).toEqual([]);
    expect(factor.evidence.join(" ")).toContain("Bitget现货方向一致");
    expect(factor.evidence.join(" ")).toContain("Bitget合约持仓变化");
  });

  it("marks contradiction when both Bitget markets move opposite to a Binance short signal", () => {
    const factor = calculateBitgetReference(
      createInput({
        signalType: "SHORT_BUILDUP_CANDIDATE",
        signalBias: "SHORT",
        binanceOpen: 100,
        binanceClose: 99,
        spotCandles: [
          createCandle({ openTime: 1_699_999_700_000, open: 100, close: 99.8, volumeQuote: 100 }),
          createCandle({ openTime: 1_700_000_000_000, open: 100, close: 101.5, volumeQuote: 150 }),
        ],
        futuresCandles: [
          createCandle({ openTime: 1_699_999_700_000, open: 120, close: 119.8, volumeQuote: 200 }),
          createCandle({ openTime: 1_700_000_000_000, open: 120, close: 123.2, volumeQuote: 260 }),
        ],
      }),
    );

    expect(factor.status).toBe("BITGET_CONTRADICTED");
    expect(factor.completeness).toBe("COMPLETE");
    expect(factor.score).toBeLessThan(0);
    expect(factor.signalBias).toBe("SHORT");
    expect(factor.evidence.join(" ")).toContain("Bitget现货方向相反");
    expect(factor.evidence.join(" ")).toContain("Bitget合约方向相反");
  });

  it("marks partial incomplete when spot is present but futures OI is missing without fabricating zero", () => {
    const factor = calculateBitgetReference(
      createInput({
        futuresCandles: [
          createCandle({ openTime: 1_699_999_700_000, open: 120, close: 120.5, volumeQuote: 200 }),
          createCandle({ openTime: 1_700_000_000_000, open: 120, close: 121.2, volumeQuote: 220 }),
        ],
        openInterest: undefined,
        previousOpenInterest: undefined,
      }),
    );

    expect(factor.status).toBe("BITGET_INCOMPLETE");
    expect(factor.completeness).toBe("PARTIAL");
    expect(factor.oiDelta).toBeUndefined();
    expect(factor.missing).toContain("openInterest");
    expect(factor.score).toBeGreaterThan(0);
    expect(factor.score).toBeLessThan(1);
  });

  it("treats an older closed Bitget candle as missing when the target Binance window does not match exactly", () => {
    const factor = calculateBitgetReference(
      createInput({
        spotCandles: [
          createCandle({ openTime: 1_699_999_700_000, open: 100, close: 102, volumeQuote: 240 }),
        ],
        futuresCandles: [
          createCandle({ openTime: 1_699_999_700_000, open: 120, close: 123, volumeQuote: 460 }),
        ],
      }),
    );

    expect(factor.status).toBe("BITGET_INCOMPLETE");
    expect(factor.completeness).toBe("PARTIAL");
    expect(factor.alignedSpotOpenTime).toBeUndefined();
    expect(factor.alignedFuturesOpenTime).toBeUndefined();
    expect(factor.spotPriceReturn).toBeUndefined();
    expect(factor.futuresPriceReturn).toBeUndefined();
    expect(factor.missing).toContain("spotCandles");
    expect(factor.missing).toContain("futuresCandles");
    expect(factor.score).toBe(0);
  });

  it("keeps missing funding data undefined and marks the factor incomplete when funding is absent or malformed", () => {
    const absentFunding = calculateBitgetReference(
      createInput({
        fundingRate: undefined,
      }),
    );

    expect(absentFunding.completeness).toBe("PARTIAL");
    expect(absentFunding.fundingRate).toBeUndefined();
    expect(absentFunding.missing).toContain("fundingRate");

    const malformedFunding = calculateBitgetReference(
      createInput({
        fundingRate: createFundingRate(undefined),
      }),
    );

    expect(malformedFunding.completeness).toBe("PARTIAL");
    expect(malformedFunding.fundingRate).toBeUndefined();
    expect(malformedFunding.missing).toContain("fundingRate");
  });

  it("marks missing unavailable when all Bitget providers are unavailable", () => {
    const factor = calculateBitgetReference(
      createInput({
        spotCandles: undefined,
        futuresCandles: undefined,
        openInterest: undefined,
        previousOpenInterest: undefined,
        fundingRate: undefined,
        unavailable: ["spotCandles", "futuresCandles", "openInterest", "fundingRate"],
      }),
    );
    const signal = createDirectionalSignal({ confidence: 0.61 });
    const adjusted = applyBitgetReference(signal, factor);

    expect(factor.status).toBe("BITGET_UNAVAILABLE");
    expect(factor.completeness).toBe("MISSING");
    expect(factor.score).toBe(0);
    expect(factor.missing).toEqual(["spotCandles", "futuresCandles", "openInterest", "fundingRate"]);
    expect(adjusted.confidence).toBe(0.61);
    expect(adjusted.severity).toBe("WARNING");
    expect(adjusted.evidence).toContain("bitgetStatus=BITGET_UNAVAILABLE");
  });

  it("marks mixed unavailable data as incomplete when funding remains valid", () => {
    const factor = calculateBitgetReference(
      createInput({
        spotCandles: undefined,
        futuresCandles: undefined,
        openInterest: undefined,
        previousOpenInterest: undefined,
        fundingRate: createFundingRate(0.0006),
        unavailable: ["spotCandles", "futuresCandles", "openInterest"],
      }),
    );

    expect(factor.status).toBe("BITGET_INCOMPLETE");
    expect(factor.completeness).toBe("PARTIAL");
    expect(factor.fundingRate).toBe(0.0006);
    expect(factor.evidence.join(" ")).toContain("Bitget资金费率=0.06%");
    expect(factor.missing).toContain("spotCandles");
    expect(factor.missing).toContain("futuresCandles");
    expect(factor.missing).toContain("openInterest");
    expect(factor.missing).not.toContain("fundingRate");
  });

  it("caps confidence adjustment at 0.10 and never promotes INFO severity", () => {
    const factor = calculateBitgetReference(
      createInput({
        spotCandles: [
          createCandle({ openTime: 1_699_999_700_000, open: 100, close: 100.1, volumeQuote: 80 }),
          createCandle({ openTime: 1_700_000_000_000, open: 100, close: 104, volumeQuote: 400 }),
        ],
        futuresCandles: [
          createCandle({ openTime: 1_699_999_700_000, open: 120, close: 120.1, volumeQuote: 100 }),
          createCandle({ openTime: 1_700_000_000_000, open: 120, close: 126, volumeQuote: 500 }),
        ],
        openInterest: createOpenInterest(150),
        previousOpenInterest: createOpenInterest(100, 1_699_999_700_000),
      }),
    );
    const infoSignal = createDirectionalSignal({
      severity: "INFO",
      confidence: 0.95,
    });

    const adjusted = applyBitgetReference(infoSignal, factor);

    expect(factor.status).toBe("BITGET_CONFIRMED");
    expect(factor.confidenceAdjustment).toBe(0.1);
    expect(adjusted.confidence).toBe(1);
    expect(adjusted.severity).toBe("INFO");
  });
});
