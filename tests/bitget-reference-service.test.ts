import { describe, expect, it, vi } from "vitest";

import type {
  BitgetFundingRate,
  BitgetFuturesContract,
  BitgetMarketCandle,
  BitgetOpenInterest,
  BitgetSpotSymbol,
} from "../src/domain/bitget-reference";
import { BitgetHttpError } from "../src/connectors/bitget-http";
import { BitgetReferenceService } from "../src/services/bitget-reference-service";

function createCandle(
  market: "spot" | "futures",
  openTime: number,
  options?: Partial<BitgetMarketCandle>,
): BitgetMarketCandle {
  return {
    symbol: options?.symbol ?? "BTCUSDT",
    interval: options?.interval ?? "5m",
    openTime,
    open: options?.open ?? 100,
    high: options?.high ?? 102,
    low: options?.low ?? 99,
    close: options?.close ?? 101,
    volumeBase: options?.volumeBase ?? 10,
    volumeQuote: options?.volumeQuote ?? 1_000 + (market === "futures" ? 100 : 0),
    sourceTimestamp: options?.sourceTimestamp ?? openTime + 300_000,
    receivedTimestamp: options?.receivedTimestamp ?? openTime + 300_100,
    raw: options?.raw ?? { market },
  };
}

function createHistory(
  market: "spot" | "futures",
  targetOpenTime: number,
  alignedClose: number,
): BitgetMarketCandle[] {
  const candles: BitgetMarketCandle[] = [];

  for (let index = 20; index >= 1; index -= 1) {
    candles.push(
      createCandle(market, targetOpenTime - index * 300_000, {
        close: 100,
        volumeQuote: 1_000,
      }),
    );
  }

  candles.push(
    createCandle(market, targetOpenTime, {
      close: alignedClose,
      volumeQuote: 2_200,
    }),
  );

  return candles;
}

function createIntervalHistory(
  market: "spot" | "futures",
  interval: "5m" | "15m",
  targetOpenTime: number,
  alignedClose: number,
): BitgetMarketCandle[] {
  const intervalMs = interval === "5m" ? 300_000 : 900_000;
  const candles: BitgetMarketCandle[] = [];

  for (let index = 20; index >= 1; index -= 1) {
    candles.push(
      createCandle(market, targetOpenTime - index * intervalMs, {
        interval,
        close: 100,
        volumeQuote: 1_000,
        sourceTimestamp: targetOpenTime - index * intervalMs + intervalMs,
        receivedTimestamp: targetOpenTime - index * intervalMs + intervalMs + 100,
      }),
    );
  }

  candles.push(
    createCandle(market, targetOpenTime, {
      interval,
      close: alignedClose,
      volumeQuote: 2_200,
      sourceTimestamp: targetOpenTime + intervalMs,
      receivedTimestamp: targetOpenTime + intervalMs + 100,
    }),
  );

  return candles;
}

function createOpenInterest(openInterest: number, timestamp = 1_720_000_300_000): BitgetOpenInterest {
  return {
    symbol: "BTCUSDT",
    openInterest,
    sourceTimestamp: timestamp,
    receivedTimestamp: timestamp + 100,
  };
}

function createFundingRate(timestamp = 1_720_000_300_000): BitgetFundingRate {
  return {
    symbol: "BTCUSDT",
    productType: "usdt-futures",
    fundingRate: 0.0001,
    fundingRateIntervalHours: 8,
    nextUpdate: timestamp + 28_800_000,
    minFundingRate: -0.003,
    maxFundingRate: 0.003,
    receivedTimestamp: timestamp + 100,
  };
}

function createService(overrides?: {
  marketClient?: Partial<{
    getSpotSymbols(): Promise<BitgetSpotSymbol[]>;
    getFuturesContracts(): Promise<BitgetFuturesContract[]>;
    getSpotCandles(symbol: string, interval: "5m" | "15m", limit: number): Promise<BitgetMarketCandle[]>;
    getFuturesCandles(symbol: string, interval: "5m" | "15m", limit: number): Promise<BitgetMarketCandle[]>;
    getOpenInterest(symbol: string): Promise<BitgetOpenInterest | undefined>;
    getFundingRate(symbol: string): Promise<BitgetFundingRate | undefined>;
  }>;
  now?: () => number;
  onHealthChange?: (status: "connected" | "degraded" | "disconnected", message?: string) => void;
}) {
  const targetOpenTime = 1_720_000_000_000;
  const marketClient = {
    getSpotSymbols: vi.fn(async () => [{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "online" }]),
    getFuturesContracts: vi.fn(async () => [
      {
        symbol: "BTCUSDT",
        baseCoin: "BTC",
        quoteCoin: "USDT",
        productType: "usdt-futures" as const,
        status: "normal",
      },
    ]),
    getSpotCandles: vi.fn(async () => createHistory("spot", targetOpenTime, 101)),
    getFuturesCandles: vi.fn(async () => createHistory("futures", targetOpenTime, 101.4)),
    getOpenInterest: vi.fn(async () => createOpenInterest(1_050)),
    getFundingRate: vi.fn(async () => createFundingRate()),
    ...overrides?.marketClient,
  };

  const service = new BitgetReferenceService({
    marketClient,
    cacheMs: 300_000,
    concurrency: 3,
    thresholds: {
      directionalReturnThreshold: 0.001,
      oiDeltaThreshold: 0.02,
      priceGapThreshold: 0.003,
      confidenceAdjustmentCap: 0.1,
    },
    now: overrides?.now ?? (() => targetOpenTime + 300_000),
    onHealthChange: overrides?.onHealthChange,
  });

  return { service, marketClient, targetOpenTime };
}

describe("BitgetReferenceService", () => {
  it("de-duplicates concurrent evaluations for the same symbol interval and candleOpenTime and caches metadata for five minutes", async () => {
    let resolveOpenInterest!: (value: BitgetOpenInterest | undefined) => void;
    const openInterestPromise = new Promise<BitgetOpenInterest | undefined>((resolve) => {
      resolveOpenInterest = resolve;
    });
    const { service, marketClient, targetOpenTime } = createService({
      marketClient: {
        getOpenInterest: vi.fn(async () => openInterestPromise),
      },
    });

    const first = service.evaluate({
      symbol: "BTCUSDT",
      interval: "5m",
      candleOpenTime: targetOpenTime,
      signalType: "LONG_BUILDUP_CANDIDATE",
      binanceOpen: 100,
      binanceClose: 101,
      binanceCloseTime: targetOpenTime + 300_000,
    });
    const second = service.evaluate({
      symbol: "BTCUSDT",
      interval: "5m",
      candleOpenTime: targetOpenTime,
      signalType: "LONG_BUILDUP_CANDIDATE",
      binanceOpen: 100,
      binanceClose: 101,
      binanceCloseTime: targetOpenTime + 300_000,
    });

    resolveOpenInterest(createOpenInterest(1_050));

    const [left, right] = await Promise.all([first, second]);

    expect(left).toEqual(right);
    expect(marketClient.getSpotSymbols).toHaveBeenCalledTimes(1);
    expect(marketClient.getFuturesContracts).toHaveBeenCalledTimes(1);
    expect(marketClient.getSpotCandles).toHaveBeenCalledTimes(1);
    expect(marketClient.getFuturesCandles).toHaveBeenCalledTimes(1);
    expect(marketClient.getOpenInterest).toHaveBeenCalledTimes(1);

    await service.evaluate({
      symbol: "BTCUSDT",
      interval: "5m",
      candleOpenTime: targetOpenTime + 300_000,
      signalType: "LONG_BUILDUP_CANDIDATE",
      binanceOpen: 101,
      binanceClose: 102,
      binanceCloseTime: targetOpenTime + 600_000,
    });

    expect(marketClient.getSpotSymbols).toHaveBeenCalledTimes(1);
    expect(marketClient.getFuturesContracts).toHaveBeenCalledTimes(1);
  });

  it("returns a partial factor when one core candle endpoint fails but surviving futures and derivatives inputs remain", async () => {
    const healthEvents: Array<{ status: "connected" | "degraded" | "disconnected"; message?: string }> = [];
    const { service, targetOpenTime } = createService({
      marketClient: {
        getSpotCandles: vi.fn(async () => {
          throw new BitgetHttpError({
            message: "Bitget request timed out for /api/v2/spot/market/candles",
            code: "TIMEOUT",
            path: "/api/v2/spot/market/candles",
          });
        }),
      },
      onHealthChange(status, message) {
        healthEvents.push({ status, message });
      },
    });

    const factor = await service.evaluate({
      symbol: "BTCUSDT",
      interval: "5m",
      candleOpenTime: targetOpenTime,
      signalType: "LONG_BUILDUP_CANDIDATE",
      binanceOpen: 100,
      binanceClose: 101,
      binanceCloseTime: targetOpenTime + 300_000,
    });

    expect(factor).toMatchObject({
      provider: "bitget",
      status: "BITGET_INCOMPLETE",
      completeness: "PARTIAL",
      confidenceAdjustment: 0,
      spotPriceReturn: undefined,
      futuresPriceReturn: expect.any(Number),
      oiDelta: undefined,
      fundingRate: 0.0001,
    });

    expect(factor.spotQuoteVolumeRatio).toBeUndefined();
    expect(factor.futuresQuoteVolumeRatio).toBeDefined();
    expect(factor.missing).toContain("spotCandles");
    expect(factor.missing).toContain("spotDirection");
    expect(healthEvents.at(-1)).toMatchObject({
      status: "degraded",
    });
  });

  it("returns BITGET_UNAVAILABLE and marks health disconnected when all provider inputs are unavailable", async () => {
    const healthEvents: Array<{ status: "connected" | "degraded" | "disconnected"; message?: string }> = [];
    const { service, targetOpenTime } = createService({
      marketClient: {
        getSpotCandles: vi.fn(async () => {
          throw new BitgetHttpError({
            message: "Bitget request timed out for /api/v2/spot/market/candles",
            code: "TIMEOUT",
            path: "/api/v2/spot/market/candles",
          });
        }),
        getFuturesCandles: vi.fn(async () => {
          throw new BitgetHttpError({
            message: "Bitget request timed out for /api/v2/mix/market/candles",
            code: "TIMEOUT",
            path: "/api/v2/mix/market/candles",
          });
        }),
        getOpenInterest: vi.fn(async () => {
          throw new BitgetHttpError({
            message: "Bitget request timed out for /api/v2/mix/market/open-interest",
            code: "TIMEOUT",
            path: "/api/v2/mix/market/open-interest",
          });
        }),
        getFundingRate: vi.fn(async () => {
          throw new BitgetHttpError({
            message: "Bitget request timed out for /api/v2/mix/market/current-fund-rate",
            code: "TIMEOUT",
            path: "/api/v2/mix/market/current-fund-rate",
          });
        }),
      },
      onHealthChange(status, message) {
        healthEvents.push({ status, message });
      },
    });

    await expect(
      service.evaluate({
        symbol: "BTCUSDT",
        interval: "5m",
        candleOpenTime: targetOpenTime,
        signalType: "LONG_BUILDUP_CANDIDATE",
        binanceOpen: 100,
        binanceClose: 101,
        binanceCloseTime: targetOpenTime + 300_000,
      }),
    ).resolves.toMatchObject({
      provider: "bitget",
      status: "BITGET_UNAVAILABLE",
      completeness: "MISSING",
      confidenceAdjustment: 0,
    });

    expect(healthEvents.at(-1)).toMatchObject({
      status: "disconnected",
    });
  });

  it("does not emit stale disconnected health after stop when a core candle request fails late", async () => {
    let resolveSpotSymbols!: (symbols: BitgetSpotSymbol[]) => void;
    let resolveFuturesContracts!: (contracts: BitgetFuturesContract[]) => void;
    let rejectSpotCandles!: (reason?: unknown) => void;
    let markSpotCandlesRequested!: () => void;
    const healthEvents: Array<{ status: "connected" | "degraded" | "disconnected"; message?: string }> = [];

    const spotSymbolsPromise = new Promise<BitgetSpotSymbol[]>((resolve) => {
      resolveSpotSymbols = resolve;
    });
    const futuresContractsPromise = new Promise<BitgetFuturesContract[]>((resolve) => {
      resolveFuturesContracts = resolve;
    });
    const spotCandlesRequested = new Promise<void>((resolve) => {
      markSpotCandlesRequested = resolve;
    });
    const spotCandlesPromise = new Promise<BitgetMarketCandle[]>((_, reject) => {
      rejectSpotCandles = reject;
    });

    const { service, targetOpenTime } = createService({
      marketClient: {
        getSpotSymbols: vi.fn(async () => spotSymbolsPromise),
        getFuturesContracts: vi.fn(async () => futuresContractsPromise),
        getSpotCandles: vi.fn(async () => {
          markSpotCandlesRequested();
          return spotCandlesPromise;
        }),
      },
      onHealthChange(status, message) {
        healthEvents.push({ status, message });
      },
    });

    const evaluation = service.evaluate({
      symbol: "BTCUSDT",
      interval: "5m",
      candleOpenTime: targetOpenTime,
      signalType: "LONG_BUILDUP_CANDIDATE",
      binanceOpen: 100,
      binanceClose: 101,
      binanceCloseTime: targetOpenTime + 300_000,
    });

    resolveSpotSymbols([{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "online" }]);
    resolveFuturesContracts([
      {
        symbol: "BTCUSDT",
        baseCoin: "BTC",
        quoteCoin: "USDT",
        productType: "usdt-futures",
        status: "normal",
      },
    ]);

    await spotCandlesRequested;
    await service.stop();

    rejectSpotCandles(
      new BitgetHttpError({
        message: "Bitget request timed out for /api/v2/spot/market/candles",
        code: "TIMEOUT",
        path: "/api/v2/spot/market/candles",
      }),
    );

    await expect(evaluation).resolves.toMatchObject({
      provider: "bitget",
      status: "BITGET_INCOMPLETE",
      completeness: "PARTIAL",
      confidenceAdjustment: 0,
    });
    expect(healthEvents).toEqual([]);
  });

  it("converts metadata fetch failures into BITGET_UNAVAILABLE and marks health disconnected", async () => {
    const healthEvents: Array<{ status: "connected" | "degraded" | "disconnected"; message?: string }> = [];
    const { service, targetOpenTime } = createService({
      marketClient: {
        getSpotSymbols: vi.fn(async () => {
          throw new BitgetHttpError({
            message: "Bitget request timed out for /api/v2/spot/public/symbols",
            code: "TIMEOUT",
            path: "/api/v2/spot/public/symbols",
          });
        }),
      },
      onHealthChange(status, message) {
        healthEvents.push({ status, message });
      },
    });

    await expect(
      service.evaluate({
        symbol: "BTCUSDT",
        interval: "5m",
        candleOpenTime: targetOpenTime,
        signalType: "LONG_BUILDUP_CANDIDATE",
        binanceOpen: 100,
        binanceClose: 101,
        binanceCloseTime: targetOpenTime + 300_000,
      }),
    ).resolves.toMatchObject({
      provider: "bitget",
      status: "BITGET_UNAVAILABLE",
      completeness: "MISSING",
      confidenceAdjustment: 0,
      spotPriceReturn: undefined,
      futuresPriceReturn: undefined,
      oiDelta: undefined,
      fundingRate: undefined,
    });

    expect(healthEvents.at(-1)).toMatchObject({
      status: "disconnected",
    });
  });

  it("marks unsupported Bitget symbols as fully unavailable instead of incomplete", async () => {
    const healthEvents: Array<{ status: "connected" | "degraded" | "disconnected"; message?: string }> = [];
    const { service, marketClient, targetOpenTime } = createService({
      marketClient: {
        getSpotSymbols: vi.fn(async () => [{ symbol: "ETHUSDT", baseCoin: "ETH", quoteCoin: "USDT", status: "online" }]),
        getFuturesContracts: vi.fn(async () => [
          {
            symbol: "ETHUSDT",
            baseCoin: "ETH",
            quoteCoin: "USDT",
            productType: "usdt-futures" as const,
            status: "normal",
          },
        ]),
      },
      onHealthChange(status, message) {
        healthEvents.push({ status, message });
      },
    });

    const factor = await service.evaluate({
      symbol: "BTCUSDT",
      interval: "5m",
      candleOpenTime: targetOpenTime,
      signalType: "LONG_BUILDUP_CANDIDATE",
      binanceOpen: 100,
      binanceClose: 101,
      binanceCloseTime: targetOpenTime + 300_000,
    });

    expect(factor.status).toBe("BITGET_UNAVAILABLE");
    expect(factor.completeness).toBe("MISSING");
    expect(factor.missing).toEqual(["spotCandles", "futuresCandles", "openInterest", "fundingRate"]);
    expect(factor.spotPriceReturn).toBeUndefined();
    expect(factor.futuresPriceReturn).toBeUndefined();
    expect(factor.oiDelta).toBeUndefined();
    expect(factor.fundingRate).toBeUndefined();
    expect(marketClient.getSpotCandles).not.toHaveBeenCalled();
    expect(marketClient.getFuturesCandles).not.toHaveBeenCalled();
    expect(marketClient.getOpenInterest).not.toHaveBeenCalled();
    expect(marketClient.getFundingRate).not.toHaveBeenCalled();
    expect(healthEvents.at(-1)).toMatchObject({
      status: "disconnected",
    });
  });

  it("returns a partial factor and marks health degraded when a non-critical provider call fails", async () => {
    const healthEvents: Array<{ status: "connected" | "degraded" | "disconnected"; message?: string }> = [];
    const { service, targetOpenTime } = createService({
      marketClient: {
        getFundingRate: vi.fn(async () => {
          throw new Error("malformed funding payload");
        }),
      },
      onHealthChange(status, message) {
        healthEvents.push({ status, message });
      },
    });

    const factor = await service.evaluate({
      symbol: "BTCUSDT",
      interval: "5m",
      candleOpenTime: targetOpenTime,
      signalType: "LONG_BUILDUP_CANDIDATE",
      binanceOpen: 100,
      binanceClose: 101,
      binanceCloseTime: targetOpenTime + 300_000,
    });

    expect(factor.status).toBe("BITGET_INCOMPLETE");
    expect(factor.completeness).toBe("PARTIAL");
    expect(factor.fundingRate).toBeUndefined();
    expect(factor.missing).toContain("fundingRate");
    expect(healthEvents.at(-1)).toMatchObject({
      status: "degraded",
    });
  });

  it("clears metadata cache and in-flight state on stop without touching shared storage resources", async () => {
    const { service, marketClient, targetOpenTime } = createService();

    await service.evaluate({
      symbol: "BTCUSDT",
      interval: "5m",
      candleOpenTime: targetOpenTime,
      signalType: "LONG_BUILDUP_CANDIDATE",
      binanceOpen: 100,
      binanceClose: 101,
      binanceCloseTime: targetOpenTime + 300_000,
    });

    expect(marketClient.getSpotSymbols).toHaveBeenCalledTimes(1);
    await service.stop();

    await service.evaluate({
      symbol: "BTCUSDT",
      interval: "5m",
      candleOpenTime: targetOpenTime + 300_000,
      signalType: "LONG_BUILDUP_CANDIDATE",
      binanceOpen: 101,
      binanceClose: 102,
      binanceCloseTime: targetOpenTime + 600_000,
    });

    expect(marketClient.getSpotSymbols).toHaveBeenCalledTimes(2);
    expect(marketClient.getFuturesContracts).toHaveBeenCalledTimes(2);
  });

  it("ignores stale pre-stop completions so they cannot repopulate metadata cache, previous OI state, or health", async () => {
    let resolveSpotSymbols!: (symbols: BitgetSpotSymbol[]) => void;
    let resolveFuturesContracts!: (contracts: BitgetFuturesContract[]) => void;
    const healthEvents: Array<{ status: "connected" | "degraded" | "disconnected"; message?: string }> = [];
    let now = 1_720_000_300_000;

    const spotSymbolsPromise = new Promise<BitgetSpotSymbol[]>((resolve) => {
      resolveSpotSymbols = resolve;
    });
    const futuresContractsPromise = new Promise<BitgetFuturesContract[]>((resolve) => {
      resolveFuturesContracts = resolve;
    });

    const { service, marketClient, targetOpenTime } = createService({
      marketClient: {
        getSpotSymbols: vi.fn(async () => spotSymbolsPromise),
        getFuturesContracts: vi.fn(async () => futuresContractsPromise),
        getOpenInterest: vi
          .fn()
          .mockImplementationOnce(async () => createOpenInterest(1_050))
          .mockImplementationOnce(async () => createOpenInterest(1_100, targetOpenTime + 300_000)),
      },
      now: () => now,
      onHealthChange(status, message) {
        healthEvents.push({ status, message });
      },
    });

    const staleEvaluation = service.evaluate({
      symbol: "BTCUSDT",
      interval: "5m",
      candleOpenTime: targetOpenTime,
      signalType: "LONG_BUILDUP_CANDIDATE",
      binanceOpen: 100,
      binanceClose: 101,
      binanceCloseTime: targetOpenTime + 300_000,
    });

    await service.stop();

    resolveSpotSymbols([{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", status: "online" }]);
    resolveFuturesContracts([
      {
        symbol: "BTCUSDT",
        baseCoin: "BTC",
        quoteCoin: "USDT",
        productType: "usdt-futures",
        status: "normal",
      },
    ]);

    await staleEvaluation;

    expect(healthEvents).toEqual([]);

    now += 300_000;
    const nextFactor = await service.evaluate({
      symbol: "BTCUSDT",
      interval: "5m",
      candleOpenTime: targetOpenTime + 300_000,
      signalType: "LONG_BUILDUP_CANDIDATE",
      binanceOpen: 101,
      binanceClose: 102,
      binanceCloseTime: targetOpenTime + 600_000,
    });

    expect(marketClient.getSpotSymbols).toHaveBeenCalledTimes(2);
    expect(marketClient.getFuturesContracts).toHaveBeenCalledTimes(2);
    expect(nextFactor.oiDelta).toBeUndefined();
    expect(nextFactor.missing).toContain("previousOpenInterest");
    expect(healthEvents.at(-1)).toMatchObject({
      status: "degraded",
    });
  });

  it("does not reuse a 5m open-interest snapshot as the baseline for a later 15m evaluation of the same symbol", async () => {
    const healthEvents: Array<{ status: "connected" | "degraded" | "disconnected"; message?: string }> = [];
    const { service, targetOpenTime } = createService({
      marketClient: {
        getSpotCandles: vi.fn(async (_symbol, interval) =>
          interval === "5m"
            ? createIntervalHistory("spot", "5m", targetOpenTime, 101)
            : createIntervalHistory("spot", "15m", targetOpenTime + 900_000, 102),
        ),
        getFuturesCandles: vi.fn(async (_symbol, interval) =>
          interval === "5m"
            ? createIntervalHistory("futures", "5m", targetOpenTime, 101.4)
            : createIntervalHistory("futures", "15m", targetOpenTime + 900_000, 102.5),
        ),
        getOpenInterest: vi
          .fn()
          .mockImplementationOnce(async () => createOpenInterest(1_050, targetOpenTime + 300_000))
          .mockImplementationOnce(async () => createOpenInterest(1_100, targetOpenTime + 1_800_000)),
      },
      onHealthChange(status, message) {
        healthEvents.push({ status, message });
      },
    });

    const fiveMinuteFactor = await service.evaluate({
      symbol: "BTCUSDT",
      interval: "5m",
      candleOpenTime: targetOpenTime,
      signalType: "LONG_BUILDUP_CANDIDATE",
      binanceOpen: 100,
      binanceClose: 101,
      binanceCloseTime: targetOpenTime + 300_000,
    });

    const fifteenMinuteFactor = await service.evaluate({
      symbol: "BTCUSDT",
      interval: "15m",
      candleOpenTime: targetOpenTime + 900_000,
      signalType: "LONG_BUILDUP_CANDIDATE",
      binanceOpen: 100,
      binanceClose: 102,
      binanceCloseTime: targetOpenTime + 1_800_000,
    });

    expect(fiveMinuteFactor.oiDelta).toBeUndefined();
    expect(fiveMinuteFactor.missing).toContain("previousOpenInterest");
    expect(fifteenMinuteFactor.oiDelta).toBeUndefined();
    expect(fifteenMinuteFactor.missing).toContain("previousOpenInterest");
    expect(healthEvents.at(-1)).toMatchObject({
      status: "degraded",
    });
  });
});
