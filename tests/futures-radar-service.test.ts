import { describe, expect, it } from "vitest";

import type { BitgetReferenceFactor } from "../src/domain/bitget-reference";
import type {
  ContractUniverseItem,
  FuturesCandle,
  FuturesKlineInterval,
  FuturesSignal,
  MarketContext,
} from "../src/domain/futures";
import { OiPoller } from "../src/ingest/futures-pipeline";
import { InMemoryFuturesRepository } from "../src/storage/in-memory-futures-repository";
import { FuturesRadarService } from "../src/services/futures-radar-service";

function createServiceConfig(overrides?: Partial<{
  futuresPollConcurrency: number;
  futuresVolumeRatio5m: number;
  futuresOiDelta5m: number;
  futuresVolumeRatio15m: number;
  futuresOiDelta15m: number;
}>) {
  return {
    futuresPollConcurrency: overrides?.futuresPollConcurrency ?? 1,
    futuresVolumeRatio5m: overrides?.futuresVolumeRatio5m ?? 2,
    futuresOiDelta5m: overrides?.futuresOiDelta5m ?? 0.05,
    futuresVolumeRatio15m: overrides?.futuresVolumeRatio15m ?? 1.5,
    futuresOiDelta15m: overrides?.futuresOiDelta15m ?? 0.08,
  };
}

function createClosedCandle(options?: Partial<FuturesCandle>): FuturesCandle {
  return {
    symbol: options?.symbol ?? "HEIUSDT",
    interval: options?.interval ?? "5m",
    openTime: options?.openTime ?? 1_720_000_000_000,
    open: options?.open ?? "1.00",
    high: options?.high ?? "1.12",
    low: options?.low ?? "0.99",
    close: options?.close ?? "1.10",
    volume: options?.volume ?? "250",
    closeTime: options?.closeTime ?? 1_720_000_300_000,
    quoteAssetVolume: options?.quoteAssetVolume ?? "275",
    tradeCount: options?.tradeCount ?? 120,
    takerBuyBaseAssetVolume: options?.takerBuyBaseAssetVolume ?? "150",
    takerBuyQuoteAssetVolume: options?.takerBuyQuoteAssetVolume ?? "165",
    isClosed: options?.isClosed ?? true,
    sourceTimestamp: options?.sourceTimestamp,
    receivedTimestamp: options?.receivedTimestamp,
    raw: options?.raw ?? { source: "test" },
  };
}

function createBaselineCandle(index: number, interval: FuturesKlineInterval = "5m"): FuturesCandle {
  const baseOpenTime = 1_719_994_000_000 + index * 300_000;

  return createClosedCandle({
    symbol: "HEIUSDT",
    interval,
    openTime: baseOpenTime,
    closeTime: baseOpenTime + 300_000,
    open: "1.00",
    high: "1.03",
    low: "0.99",
    close: "1.01",
    volume: "100",
    quoteAssetVolume: "101",
    tradeCount: 80,
    takerBuyBaseAssetVolume: "45",
    takerBuyQuoteAssetVolume: "46",
    sourceTimestamp: baseOpenTime + 300_000,
    receivedTimestamp: baseOpenTime + 300_100,
  });
}

function createUniverseItem(options?: Partial<ContractUniverseItem>): ContractUniverseItem {
  return {
    symbol: options?.symbol ?? "HEIUSDT",
    pair: options?.pair ?? "HEIUSDT",
    baseAsset: options?.baseAsset ?? "HEI",
    quoteAsset: options?.quoteAsset ?? "USDT",
    contractType: options?.contractType ?? "PERPETUAL",
    status: options?.status ?? "TRADING",
    onboardDate: options?.onboardDate ?? 1,
    deliveryDate: options?.deliveryDate,
    filters: options?.filters ?? [],
    isContractOnly: options?.isContractOnly ?? true,
    spotBaseAssetMatches: options?.spotBaseAssetMatches ?? [],
    contractOnlyReason: options?.contractOnlyReason ?? "NO_ACTIVE_SPOT_BASE_ASSET",
  };
}

function createBitgetReference(overrides?: Partial<BitgetReferenceFactor>): BitgetReferenceFactor {
  return {
    provider: "bitget",
    symbol: overrides?.symbol ?? "HEIUSDT",
    interval: overrides?.interval ?? "5m",
    candleOpenTime: overrides?.candleOpenTime ?? 1_720_000_000_000,
    signalType: overrides?.signalType ?? "LONG_BUILDUP_CANDIDATE",
    signalBias: overrides?.signalBias ?? "LONG",
    status: overrides?.status ?? "BITGET_CONFIRMED",
    completeness: overrides?.completeness ?? "COMPLETE",
    score: overrides?.score ?? 0.7,
    confidenceAdjustment: overrides?.confidenceAdjustment ?? 0.08,
    missing: overrides?.missing ?? [],
    evidence: overrides?.evidence ?? ["bitgetStatus=BITGET_CONFIRMED", "Bitget现货方向一致"],
    alignedSpotOpenTime: overrides?.alignedSpotOpenTime ?? 1_720_000_000_000,
    alignedFuturesOpenTime: overrides?.alignedFuturesOpenTime ?? 1_720_000_000_000,
    spotPriceReturn: overrides?.spotPriceReturn ?? 0.01,
    futuresPriceReturn: overrides?.futuresPriceReturn ?? 0.012,
    spotQuoteVolumeRatio: overrides?.spotQuoteVolumeRatio ?? 2.2,
    futuresQuoteVolumeRatio: overrides?.futuresQuoteVolumeRatio ?? 2.4,
    oiDelta: overrides?.oiDelta ?? 0.05,
    fundingRate: overrides?.fundingRate ?? 0.0001,
    basis: overrides?.basis ?? 0.001,
    priceGap: overrides?.priceGap ?? 0.002,
    observedAt: overrides?.observedAt ?? 1_720_000_300_000,
  };
}

type FakeStream = {
  handler?: (candle: FuturesCandle) => Promise<void>;
  startCalls: Array<{ symbols: string[]; intervals: readonly ["5m", "15m"] }>;
  stopCalls: number;
  onCandle(handler: (candle: FuturesCandle) => Promise<void>): void;
  start(symbols: string[], intervals: readonly ["5m", "15m"]): Promise<void>;
  stop(): Promise<void>;
};

function createFakeStream(): FakeStream {
  return {
    startCalls: [],
    stopCalls: 0,
    onCandle(handler) {
      this.handler = handler;
    },
    async start(symbols, intervals) {
      this.startCalls.push({
        symbols: [...symbols],
        intervals,
      });
    },
    async stop() {
      this.stopCalls += 1;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for test condition");
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("FuturesRadarService", () => {
  it("refreshes the universe before opening the stream and subscribes only contract-only symbols", async () => {
    const callOrder: string[] = [];
    const stream = createFakeStream();
    const repository = new InMemoryFuturesRepository();

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository,
      restClient: {
        async getFuturesExchangeInfo() {
          callOrder.push("rest:futures");
          return [
            createUniverseItem(),
            createUniverseItem({
              symbol: "BANKUSDT",
              pair: "BANKUSDT",
              baseAsset: "BANK",
              isContractOnly: false,
              contractOnlyReason: "SPOT_BASE_ASSET_PRESENT",
              spotBaseAssetMatches: ["BANK"],
            }),
          ];
        },
        async getSpotExchangeInfo() {
          callOrder.push("rest:spot");
          return [{ symbol: "BANKUSDT", baseAsset: "BANK", quoteAsset: "USDT", status: "TRADING" }];
        },
      },
      stream,
      oiPoller: {
        async pollClosedCandle() {
          throw new Error("should not poll during start");
        },
      },
      notifier: {
        async send() {
          throw new Error("should not notify during start");
        },
      },
      onUniverseRefreshed(items) {
        callOrder.push(`repo:${items.length}`);
      },
    });

    await service.start();

    expect(callOrder).toEqual(["rest:futures", "rest:spot", "repo:2"]);
    expect(stream.startCalls).toEqual([
      {
        symbols: ["HEIUSDT"],
        intervals: ["5m", "15m"],
      },
    ]);
  });

  it("keeps the read API alive and starts an empty stream when the initial public exchange fetch is unavailable", async () => {
    const stream = createFakeStream();
    const errors: Array<{ scope: string; message: string }> = [];
    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository: new InMemoryFuturesRepository(),
      restClient: {
        async getFuturesExchangeInfo() {
          throw new Error("Binance request failed with status 418");
        },
        async getSpotExchangeInfo() {
          throw new Error("spot fetch should not run after futures failure");
        },
      },
      stream,
      oiPoller: { async pollClosedCandle() { throw new Error("should not poll"); } },
      notifier: { async send() { return "skipped"; } },
      onError: (event) => errors.push(event),
    });

    await service.start();

    expect(errors).toEqual([{ scope: "initial-universe-refresh", message: "Binance request failed with status 418" }]);
    expect(stream.startCalls).toEqual([{ symbols: [], intervals: ["5m", "15m"] }]);
    await service.stop();
  });

  it("does not block service startup on a slow historical stream backfill", async () => {
    let resolveStreamStart!: () => void;
    const streamStart = new Promise<void>((resolve) => {
      resolveStreamStart = resolve;
    });
    const stream = createFakeStream();
    stream.start = async (symbols, intervals) => {
      stream.startCalls.push({ symbols: [...symbols], intervals });
      await streamStart;
    };
    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository: new InMemoryFuturesRepository(),
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream,
      oiPoller: { async pollClosedCandle() { throw new Error("should not poll during start"); } },
      notifier: { async send() { return "skipped"; } },
    });

    const startup = service.start().then(() => "started");
    const result = await Promise.race([
      startup,
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ]);

    expect(result).toBe("started");
    resolveStreamStart();
    await service.stop();
  });

  it("stores historical backfill candles without polling OI or publishing signals", async () => {
    const repository = new InMemoryFuturesRepository();
    const stream = createFakeStream();
    let pollCount = 0;
    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream,
      oiPoller: {
        async pollClosedCandle() {
          pollCount += 1;
          throw new Error("historical backfill must not poll OI");
        },
      },
      notifier: { async send() { return "skipped"; } },
    });

    await service.handleCandle({
      ...createClosedCandle(),
      isBackfill: true,
    } as FuturesCandle & { isBackfill: true });

    expect(await repository.getClosedCandleBaseline("HEIUSDT", "5m", 1)).toHaveLength(1);
    expect(pollCount).toBe(0);
    await service.stop();
  });

  it("processes the latest startup backfill snapshot without replaying a stale checkpoint gap", async () => {
    const repository = new InMemoryFuturesRepository();
    await repository.upsertContracts([createUniverseItem()]);
    for (let index = 0; index < 21; index += 1) {
      await repository.saveCandle(createBaselineCandle(index));
    }

    let pollCount = 0;
    const latest = createClosedCandle({
      openTime: 1_720_000_300_000,
      closeTime: 1_720_000_600_000,
      sourceTimestamp: 1_720_000_600_000,
      receivedTimestamp: 1_720_000_600_100,
    });
    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          pollCount += 1;
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            openInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1100",
              sumOpenInterestValue: "1100",
              timestamp: candle.closeTime,
            },
            previousOpenInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1000",
              sumOpenInterestValue: "1000",
              timestamp: candle.openTime,
            },
            takerFlow: {
              symbol: candle.symbol!,
              buySellRatio: "3",
              buyVol: "150",
              sellVol: "50",
              timestamp: candle.closeTime,
            },
            fundingRate: {
              symbol: candle.symbol!,
              fundingRate: "0.0001",
              fundingTime: candle.closeTime,
            },
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.receivedTimestamp ?? candle.closeTime,
            openInterestTimestamp: candle.closeTime,
            takerFlowTimestamp: candle.closeTime,
            fundingRateTimestamp: candle.closeTime,
            isComplete: true,
            missing: [],
          };
        },
      },
      notifier: { async send() { return "skipped"; } },
    });

    await service.refreshUniverse();
    await service.handleCandle({ ...latest, isBackfill: true });
    await service.handleCandle({ ...latest, isBackfill: true, isStartupSnapshot: true } as FuturesCandle & { isStartupSnapshot: true });

    const rows = await repository.listOiLeaderboard({ interval: "5m", limit: 10 });
    expect(pollCount).toBe(1);
    expect(rows[0]?.candleOpenTime).toBe(latest.openTime);
  });

  it("persists, enriches, scores, advances the checkpoint, and skips replayed candles ahead of the checkpoint", async () => {
    const repository = new InMemoryFuturesRepository();
    const stream = createFakeStream();
    const sentSignals: FuturesSignal[] = [];
    const checkpointWrites: number[] = [];
    let checkpoint: number | null = null;
    let pollCount = 0;

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(createBaselineCandle(index));
    }

    const durableRepository = Object.assign(Object.create(Object.getPrototypeOf(repository)), repository, {
      async getCheckpoint() {
        return checkpoint;
      },
      async setCheckpoint(_stream: string, timestamp: number) {
        checkpoint = timestamp;
        checkpointWrites.push(timestamp);
      },
    });

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository: durableRepository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream,
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          pollCount += 1;
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            openInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1100",
              sumOpenInterestValue: "1100",
              timestamp: candle.closeTime,
            },
            previousOpenInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1000",
              sumOpenInterestValue: "1000",
              timestamp: candle.openTime,
            },
            takerFlow: {
              symbol: candle.symbol!,
              buySellRatio: "3",
              buyVol: "150",
              sellVol: "50",
              timestamp: candle.closeTime,
            },
            fundingRate: {
              symbol: candle.symbol!,
              fundingRate: "0.0001",
              fundingTime: candle.closeTime,
            },
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 100,
            openInterestTimestamp: candle.closeTime,
            takerFlowTimestamp: candle.closeTime,
            fundingRateTimestamp: candle.closeTime,
            isComplete: true,
            missing: [],
          };
        },
      },
      notifier: {
        async send(signal) {
          sentSignals.push(signal);
          return "sent";
        },
      },
    });

    await service.refreshUniverse();

    const candle = createClosedCandle();
    await service.handleClosedCandle(candle);
    await service.handleClosedCandle(candle);

    const radarRows = await repository.listRadar({
      contractOnly: true,
      limit: 10,
    });
    const signals = await repository.listSignals({
      symbol: "HEIUSDT",
      interval: "5m",
      limit: 10,
    });

    expect(radarRows).toHaveLength(1);
    expect(radarRows[0]).toMatchObject({
      symbol: "HEIUSDT",
      interval: "5m",
      signalType: "LONG_BUILDUP_CANDIDATE",
      dataCompleteness: "COMPLETE",
      isContractOnly: true,
      contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
    });
    expect(radarRows[0]?.volumeRatio).toBeCloseTo(2.5, 6);
    expect(radarRows[0]?.oiValueDelta).toBeCloseTo(0.1, 6);
    expect(radarRows[0]?.priceReturn).toBeCloseTo(0.1, 6);
    expect(radarRows[0]?.takerImbalance).toBeCloseTo(0.5, 6);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.evidence).toEqual(
      expect.arrayContaining([
        "priceReturn=10.00%",
        "oiValueDelta=10.00%",
        "volumeRatio=2.50",
        "takerImbalance=50.00%",
        "contractOnlyReason=NO_ACTIVE_SPOT_BASE_ASSET",
      ]),
    );
    expect(pollCount).toBe(1);
    expect(checkpointWrites).toEqual([candle.closeTime]);
    expect(checkpoint).toBe(candle.closeTime);
    expect(sentSignals).toHaveLength(1);
    expect(sentSignals[0]?.signalType).toBe("LONG_BUILDUP_CANDIDATE");
  });

  it("invokes Bitget only for a Binance candidate, saves one factor, and publishes the adjusted signal before checkpoint advancement", async () => {
    const repository = new InMemoryFuturesRepository();
    const stream = createFakeStream();
    const sentSignals: FuturesSignal[] = [];
    const savedFactors: BitgetReferenceFactor[] = [];

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(createBaselineCandle(index));
    }

    const durableRepository = Object.assign(Object.create(Object.getPrototypeOf(repository)), repository, {
      async saveBitgetReference(factor: BitgetReferenceFactor) {
        savedFactors.push(structuredClone(factor));
        await repository.saveBitgetReference(factor);
      },
    });

    const referenceCalls: Array<{ symbol: string; interval: "5m" | "15m"; candleOpenTime: number }> = [];
    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository: durableRepository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream,
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            openInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1100",
              sumOpenInterestValue: "1100",
              timestamp: candle.closeTime,
            },
            previousOpenInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1000",
              sumOpenInterestValue: "1000",
              timestamp: candle.openTime,
            },
            takerFlow: {
              symbol: candle.symbol!,
              buySellRatio: "3",
              buyVol: "150",
              sellVol: "50",
              timestamp: candle.closeTime,
            },
            fundingRate: {
              symbol: candle.symbol!,
              fundingRate: "0.0001",
              fundingTime: candle.closeTime,
            },
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 100,
            openInterestTimestamp: candle.closeTime,
            takerFlowTimestamp: candle.closeTime,
            fundingRateTimestamp: candle.closeTime,
            isComplete: true,
            missing: [],
          };
        },
      },
      notifier: {
        async send(signal) {
          sentSignals.push(signal);
          return "sent";
        },
      },
      referenceService: {
        async evaluate(input) {
          referenceCalls.push({
            symbol: input.symbol,
            interval: input.interval,
            candleOpenTime: input.candleOpenTime,
          });
          return createBitgetReference({
            symbol: input.symbol,
            interval: input.interval,
            candleOpenTime: input.candleOpenTime,
            signalType: input.signalType,
          });
        },
      },
    });

    await service.refreshUniverse();
    await service.handleClosedCandle(createClosedCandle());

    expect(referenceCalls).toEqual([
      {
        symbol: "HEIUSDT",
        interval: "5m",
        candleOpenTime: 1_720_000_000_000,
      },
    ]);
    expect(savedFactors).toHaveLength(1);
    expect(sentSignals).toHaveLength(1);
    expect(sentSignals[0]?.confidence).toBeGreaterThan(0.78);
    expect(sentSignals[0]?.evidence).toEqual(expect.arrayContaining(["bitgetStatus=BITGET_CONFIRMED"]));
    const radarRows = await repository.listRadar({ contractOnly: true, limit: 10 });
    expect(radarRows[0]?.bitgetReference).toMatchObject({
      provider: "bitget",
      status: "BITGET_CONFIRMED",
    });
  });

  it("does not invoke Bitget for a non-candidate Binance signal", async () => {
    const repository = new InMemoryFuturesRepository();
    const referenceCalls: Array<unknown> = [];

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(createBaselineCandle(index));
    }

    const service = new FuturesRadarService({
      config: createServiceConfig({
        futuresVolumeRatio5m: 3,
        futuresOiDelta5m: 0.2,
      }),
      repository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            openInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1010",
              sumOpenInterestValue: "1010",
              timestamp: candle.closeTime,
            },
            previousOpenInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1000",
              sumOpenInterestValue: "1000",
              timestamp: candle.openTime,
            },
            takerFlow: {
              symbol: candle.symbol!,
              buySellRatio: "1.1",
              buyVol: "110",
              sellVol: "100",
              timestamp: candle.closeTime,
            },
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 100,
            openInterestTimestamp: candle.closeTime,
            takerFlowTimestamp: candle.closeTime,
            isComplete: true,
            missing: ["fundingRate"],
          };
        },
      },
      notifier: {
        async send() {
          return "skipped";
        },
      },
      referenceService: {
        async evaluate(input) {
          referenceCalls.push(input);
          return createBitgetReference();
        },
      },
    });

    await service.refreshUniverse();
    await service.handleClosedCandle(createClosedCandle());

    expect(referenceCalls).toEqual([]);
  });

  it("preserves the Binance signal and checkpoint when Bitget is unavailable", async () => {
    const repository = new InMemoryFuturesRepository();
    const sentSignals: FuturesSignal[] = [];
    let checkpoint: number | null = null;

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(createBaselineCandle(index));
    }

    const durableRepository = Object.assign(Object.create(Object.getPrototypeOf(repository)), repository, {
      async getCheckpoint() {
        return checkpoint;
      },
      async setCheckpoint(_stream: string, timestamp: number) {
        checkpoint = timestamp;
      },
    });

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository: durableRepository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            openInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1100",
              sumOpenInterestValue: "1100",
              timestamp: candle.closeTime,
            },
            previousOpenInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1000",
              sumOpenInterestValue: "1000",
              timestamp: candle.openTime,
            },
            takerFlow: {
              symbol: candle.symbol!,
              buySellRatio: "3",
              buyVol: "150",
              sellVol: "50",
              timestamp: candle.closeTime,
            },
            fundingRate: {
              symbol: candle.symbol!,
              fundingRate: "0.0001",
              fundingTime: candle.closeTime,
            },
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 100,
            openInterestTimestamp: candle.closeTime,
            takerFlowTimestamp: candle.closeTime,
            fundingRateTimestamp: candle.closeTime,
            isComplete: true,
            missing: [],
          };
        },
      },
      notifier: {
        async send(signal) {
          sentSignals.push(signal);
          return "sent";
        },
      },
      referenceService: {
        async evaluate(input) {
          return createBitgetReference({
            symbol: input.symbol,
            interval: input.interval,
            candleOpenTime: input.candleOpenTime,
            signalType: input.signalType,
            status: "BITGET_UNAVAILABLE",
            completeness: "MISSING",
            score: 0,
            confidenceAdjustment: 0,
            evidence: ["bitgetStatus=BITGET_UNAVAILABLE"],
            missing: ["spotCandles", "futuresCandles", "openInterest", "fundingRate"],
            spotPriceReturn: undefined,
            futuresPriceReturn: undefined,
            spotQuoteVolumeRatio: undefined,
            futuresQuoteVolumeRatio: undefined,
            oiDelta: undefined,
            fundingRate: undefined,
            basis: undefined,
            priceGap: undefined,
          });
        },
      },
    });

    await service.refreshUniverse();
    const candle = createClosedCandle();
    await expect(service.handleClosedCandle(candle)).resolves.toBeUndefined();

    expect(sentSignals).toHaveLength(1);
    expect(sentSignals[0]?.signalType).toBe("LONG_BUILDUP_CANDIDATE");
    expect(sentSignals[0]?.evidence).not.toContain("bitgetStatus=BITGET_UNAVAILABLE");
    expect(checkpoint).toBe(candle.closeTime);
    const signals = await repository.listSignals({ symbol: "HEIUSDT", interval: "5m", limit: 10 });
    expect(signals).toHaveLength(1);
  });

  it("keeps Binance progression non-blocking when Bitget evaluation fails before persistence", async () => {
    const repository = new InMemoryFuturesRepository();
    const sentSignals: FuturesSignal[] = [];
    let checkpoint: number | null = null;

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(createBaselineCandle(index));
    }

    const durableRepository = Object.assign(Object.create(Object.getPrototypeOf(repository)), repository, {
      async getCheckpoint() {
        return checkpoint;
      },
      async setCheckpoint(_stream: string, timestamp: number) {
        checkpoint = timestamp;
      },
    });

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository: durableRepository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            openInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1100",
              sumOpenInterestValue: "1100",
              timestamp: candle.closeTime,
            },
            previousOpenInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1000",
              sumOpenInterestValue: "1000",
              timestamp: candle.openTime,
            },
            takerFlow: {
              symbol: candle.symbol!,
              buySellRatio: "3",
              buyVol: "150",
              sellVol: "50",
              timestamp: candle.closeTime,
            },
            fundingRate: {
              symbol: candle.symbol!,
              fundingRate: "0.0001",
              fundingTime: candle.closeTime,
            },
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 100,
            openInterestTimestamp: candle.closeTime,
            takerFlowTimestamp: candle.closeTime,
            fundingRateTimestamp: candle.closeTime,
            isComplete: true,
            missing: [],
          };
        },
      },
      notifier: {
        async send(signal) {
          sentSignals.push(signal);
          return "sent";
        },
      },
      referenceService: {
        async evaluate() {
          throw new Error("bitget provider timeout");
        },
      },
    });

    await service.refreshUniverse();
    const candle = createClosedCandle();
    await expect(service.handleClosedCandle(candle)).resolves.toBeUndefined();

    expect(sentSignals).toHaveLength(1);
    expect(sentSignals[0]?.signalType).toBe("LONG_BUILDUP_CANDIDATE");
    expect(checkpoint).toBe(candle.closeTime);
    const factor = await repository.getBitgetReference("HEIUSDT", "5m", candle.openTime);
    expect(factor).toBeUndefined();
  });

  it("surfaces Bitget reference persistence failures instead of swallowing them as provider failures", async () => {
    const repository = new InMemoryFuturesRepository();
    const sentSignals: FuturesSignal[] = [];
    let checkpoint: number | null = null;

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(createBaselineCandle(index));
    }

    const durableRepository = Object.assign(Object.create(Object.getPrototypeOf(repository)), repository, {
      async getCheckpoint() {
        return checkpoint;
      },
      async setCheckpoint(_stream: string, timestamp: number) {
        checkpoint = timestamp;
      },
      async saveBitgetReference() {
        throw new Error("mysql insert failed");
      },
    });

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository: durableRepository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            openInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1100",
              sumOpenInterestValue: "1100",
              timestamp: candle.closeTime,
            },
            previousOpenInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1000",
              sumOpenInterestValue: "1000",
              timestamp: candle.openTime,
            },
            takerFlow: {
              symbol: candle.symbol!,
              buySellRatio: "3",
              buyVol: "150",
              sellVol: "50",
              timestamp: candle.closeTime,
            },
            fundingRate: {
              symbol: candle.symbol!,
              fundingRate: "0.0001",
              fundingTime: candle.closeTime,
            },
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 100,
            openInterestTimestamp: candle.closeTime,
            takerFlowTimestamp: candle.closeTime,
            fundingRateTimestamp: candle.closeTime,
            isComplete: true,
            missing: [],
          };
        },
      },
      notifier: {
        async send(signal) {
          sentSignals.push(signal);
          return "sent";
        },
      },
      referenceService: {
        async evaluate(input) {
          return createBitgetReference({
            symbol: input.symbol,
            interval: input.interval,
            candleOpenTime: input.candleOpenTime,
            signalType: input.signalType,
          });
        },
      },
    });

    await service.refreshUniverse();
    const candle = createClosedCandle();

    await expect(service.handleClosedCandle(candle)).rejects.toThrow("mysql insert failed");
    expect(sentSignals).toHaveLength(0);
    expect(checkpoint).toBeNull();
  });

  it("produces complete metrics and a directional signal through the real OiPoller shaping path", async () => {
    const repository = new InMemoryFuturesRepository();

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(createBaselineCandle(index));
    }

    const sentSignals: FuturesSignal[] = [];
    const candle = createClosedCandle({
      openTime: 1_720_010_200_000,
      closeTime: 1_720_010_500_000,
      volume: "250",
      open: "1.00",
      close: "1.10",
    });

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream: createFakeStream(),
      oiPoller: new OiPoller({
        restClient: {
          async getOpenInterestHistory() {
            return [
              {
                symbol: "HEIUSDT",
                sumOpenInterest: "1100",
                sumOpenInterestValue: "1100",
                timestamp: candle.closeTime,
              },
              {
                symbol: "HEIUSDT",
                sumOpenInterest: "1000",
                sumOpenInterestValue: "1000",
                timestamp: candle.openTime - 300_000,
              },
            ];
          },
          async getTakerLongShortRatio() {
            return [
              {
                symbol: "HEIUSDT",
                buySellRatio: "3",
                buyVol: "150",
                sellVol: "50",
                timestamp: candle.closeTime,
              },
            ];
          },
          async getFundingRateHistory() {
            return [{ symbol: "HEIUSDT", fundingRate: "0.0001", fundingTime: candle.closeTime - 60_000 }];
          },
        },
        now: () => candle.closeTime + 100,
      }),
      notifier: {
        async send(signal) {
          sentSignals.push(signal);
          return "sent";
        },
      },
    });

    await service.refreshUniverse();
    await service.handleClosedCandle(candle);

    const radarRows = await repository.listRadar({
      contractOnly: true,
      limit: 10,
    });

    expect(radarRows).toHaveLength(1);
    expect(radarRows[0]).toMatchObject({
      signalType: "LONG_BUILDUP_CANDIDATE",
      dataCompleteness: "COMPLETE",
      interval: "5m",
    });
    expect(sentSignals).toHaveLength(1);
    expect(sentSignals[0]?.signalType).toBe("LONG_BUILDUP_CANDIDATE");
    expect(repository.debugSnapshot().oiSnapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ timestamp: candle.closeTime, sumOpenInterest: "1100" }),
        expect.objectContaining({ timestamp: candle.openTime - 300_000, sumOpenInterest: "1000" }),
      ]),
    );
  });

  it("skips replayed candles before OI polling when the repository checkpoint is already ahead", async () => {
    const repository = new InMemoryFuturesRepository();
    let checkpoint = 1_720_000_300_000;
    let pollCount = 0;
    let checkpointWrites = 0;

    const durableRepository = Object.assign(Object.create(Object.getPrototypeOf(repository)), repository, {
      async getCheckpoint() {
        return checkpoint;
      },
      async setCheckpoint(_stream: string, timestamp: number) {
        checkpoint = timestamp;
        checkpointWrites += 1;
      },
    });

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository: durableRepository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle() {
          pollCount += 1;
          throw new Error("should have skipped before polling");
        },
      },
      notifier: {
        async send() {
          throw new Error("should have skipped before notifying");
        },
      },
    });

    await service.refreshUniverse();
    await service.handleClosedCandle(
      createClosedCandle({
        closeTime: checkpoint,
      }),
    );

    expect(pollCount).toBe(0);
    expect(checkpointWrites).toBe(0);
    expect(await repository.getClosedCandleBaseline("HEIUSDT", "5m", 10)).toEqual([]);
  });

  it("allows retry after a failed poll and advances the checkpoint only after the successful retry", async () => {
    const repository = new InMemoryFuturesRepository();
    let checkpoint: number | null = null;
    const checkpointWrites: number[] = [];
    let attempts = 0;

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(createBaselineCandle(index));
    }

    const durableRepository = Object.assign(Object.create(Object.getPrototypeOf(repository)), repository, {
      async getCheckpoint() {
        return checkpoint;
      },
      async setCheckpoint(_stream: string, timestamp: number) {
        checkpoint = timestamp;
        checkpointWrites.push(timestamp);
      },
    });

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository: durableRepository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("temporary poll failure");
          }

          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            openInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1100",
              sumOpenInterestValue: "1100",
              timestamp: candle.closeTime,
            },
            previousOpenInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1000",
              sumOpenInterestValue: "1000",
              timestamp: candle.openTime,
            },
            takerFlow: {
              symbol: candle.symbol!,
              buySellRatio: "3",
              buyVol: "150",
              sellVol: "50",
              timestamp: candle.closeTime,
            },
            fundingRate: {
              symbol: candle.symbol!,
              fundingRate: "0.0001",
              fundingTime: candle.closeTime,
            },
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 100,
            openInterestTimestamp: candle.closeTime,
            takerFlowTimestamp: candle.closeTime,
            fundingRateTimestamp: candle.closeTime,
            isComplete: true,
            missing: [],
          };
        },
      },
      notifier: {
        async send() {
          return "sent";
        },
      },
    });

    await service.refreshUniverse();

    const candle = createClosedCandle({
      openTime: 1_720_001_000_000,
      closeTime: 1_720_001_300_000,
    });

    await expect(service.handleClosedCandle(candle)).rejects.toThrow("temporary poll failure");
    expect(checkpoint).toBeNull();
    expect(checkpointWrites).toEqual([]);

    await service.handleClosedCandle(candle);

    expect(attempts).toBe(2);
    expect(checkpointWrites).toEqual([candle.closeTime]);
    expect(checkpoint).toBe(candle.closeTime);
  });

  it("emits a conflict publication when 5m and 15m directional candidates oppose within the same 15m bucket", async () => {
    const repository = new InMemoryFuturesRepository();
    const sentSignals: FuturesSignal[] = [];

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(createBaselineCandle(index, "5m"));
      await repository.saveCandle(createBaselineCandle(index, "15m"));
    }

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          const short = candle.interval === "15m";
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            openInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: short ? "1100" : "1200",
              sumOpenInterestValue: short ? "1100" : "1200",
              timestamp: candle.closeTime,
            },
            previousOpenInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1000",
              sumOpenInterestValue: "1000",
              timestamp: candle.openTime - (candle.interval === "15m" ? 900_000 : 300_000),
            },
            takerFlow: {
              symbol: candle.symbol!,
              buySellRatio: short ? "0.4" : "3",
              buyVol: short ? "40" : "150",
              sellVol: short ? "160" : "50",
              timestamp: candle.closeTime,
            },
            fundingRate: {
              symbol: candle.symbol!,
              fundingRate: "0.0001",
              fundingTime: candle.closeTime,
            },
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 50,
            openInterestTimestamp: candle.closeTime,
            takerFlowTimestamp: candle.closeTime,
            fundingRateTimestamp: candle.closeTime,
            isComplete: true,
            missing: [],
          };
        },
      },
      notifier: {
        async send(signal) {
          sentSignals.push(signal);
          return "sent";
        },
      },
    });

    await service.refreshUniverse();

    const firstFiveMinute = createClosedCandle({
      interval: "5m",
      openTime: 1_720_020_900_000,
      closeTime: 1_720_021_200_000,
      close: "1.10",
    });
    const fifteenMinute = createClosedCandle({
      interval: "15m",
      openTime: 1_720_020_600_000,
      closeTime: 1_720_021_500_000,
      close: "0.90",
      volume: "180",
      quoteAssetVolume: "198",
    });

    await service.handleClosedCandle(firstFiveMinute);
    await service.handleClosedCandle(fifteenMinute);

    const signals = await repository.listSignals({
      symbol: "HEIUSDT",
      limit: 10,
    });

    expect(sentSignals.map((signal) => signal.signalType)).toEqual([
      "LONG_BUILDUP_CANDIDATE",
      "FUTURES_OI_CONFLICT",
    ]);
    expect(sentSignals.some((signal) => signal.signalType === "SHORT_BUILDUP_CANDIDATE")).toBe(false);
    expect(signals.some((signal) => signal.signalType === "FUTURES_OI_CONFLICT")).toBe(true);
  });

  it("keeps one conflict key and one notification when the replay order is reversed", async () => {
    const repository = new InMemoryFuturesRepository();
    const sentSignals: FuturesSignal[] = [];

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(createBaselineCandle(index, "5m"));
      await repository.saveCandle(createBaselineCandle(index, "15m"));
    }

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          const short = candle.interval === "15m";
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            openInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: short ? "1100" : "1200",
              sumOpenInterestValue: short ? "1100" : "1200",
              timestamp: candle.closeTime,
            },
            previousOpenInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1000",
              sumOpenInterestValue: "1000",
              timestamp: candle.openTime - (candle.interval === "15m" ? 900_000 : 300_000),
            },
            takerFlow: {
              symbol: candle.symbol!,
              buySellRatio: short ? "0.4" : "3",
              buyVol: short ? "40" : "150",
              sellVol: short ? "160" : "50",
              timestamp: candle.closeTime,
            },
            fundingRate: {
              symbol: candle.symbol!,
              fundingRate: "0.0001",
              fundingTime: candle.closeTime,
            },
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 50,
            openInterestTimestamp: candle.closeTime,
            takerFlowTimestamp: candle.closeTime,
            fundingRateTimestamp: candle.closeTime,
            isComplete: true,
            missing: [],
          };
        },
      },
      notifier: {
        async send(signal) {
          sentSignals.push(signal);
          return "sent";
        },
      },
    });

    await service.refreshUniverse();

    const fifteenMinute = createClosedCandle({
      interval: "15m",
      openTime: 1_720_020_600_000,
      closeTime: 1_720_021_500_000,
      close: "0.90",
      volume: "180",
      quoteAssetVolume: "198",
    });
    const firstFiveMinute = createClosedCandle({
      interval: "5m",
      openTime: 1_720_020_900_000,
      closeTime: 1_720_021_200_000,
      close: "1.10",
    });

    await service.handleClosedCandle(fifteenMinute);
    await service.handleClosedCandle(firstFiveMinute);

    const signals = await repository.listSignals({
      symbol: "HEIUSDT",
      limit: 10,
    });
    const conflictSignals = signals.filter((signal) => signal.signalType === "FUTURES_OI_CONFLICT");

    expect(conflictSignals).toHaveLength(1);
    expect(conflictSignals[0]?.thresholdVersion).toBe(
      "cfg:5m:vr=2:oi=0.05:flat=0.01:taker=0.05|cfg:15m:vr=1.5:oi=0.08:flat=0.01:taker=0.05",
    );
    expect(sentSignals.map((signal) => signal.signalType)).toEqual([
      "SHORT_BUILDUP_CANDIDATE",
      "FUTURES_OI_CONFLICT",
    ]);
  });

  it("serializes overlapping duplicate deliveries and notifies exactly once for one deterministic signal key", async () => {
    const repository = new InMemoryFuturesRepository();
    const sentSignals: FuturesSignal[] = [];
    let pollCount = 0;
    let releasePoll: (() => void) | undefined;

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(createBaselineCandle(index));
    }

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          pollCount += 1;
          await new Promise<void>((resolve) => {
            releasePoll = resolve;
          });

          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            openInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1100",
              sumOpenInterestValue: "1100",
              timestamp: candle.closeTime,
            },
            previousOpenInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1000",
              sumOpenInterestValue: "1000",
              timestamp: candle.openTime,
            },
            takerFlow: {
              symbol: candle.symbol!,
              buySellRatio: "3",
              buyVol: "150",
              sellVol: "50",
              timestamp: candle.closeTime,
            },
            fundingRate: {
              symbol: candle.symbol!,
              fundingRate: "0.0001",
              fundingTime: candle.closeTime,
            },
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 100,
            openInterestTimestamp: candle.closeTime,
            takerFlowTimestamp: candle.closeTime,
            fundingRateTimestamp: candle.closeTime,
            isComplete: true,
            missing: [],
          };
        },
      },
      notifier: {
        async send(signal) {
          sentSignals.push(signal);
          return "sent";
        },
      },
    });

    await service.refreshUniverse();

    const candle = createClosedCandle({
      openTime: 1_720_002_000_000,
      closeTime: 1_720_002_300_000,
    });

    const first = service.handleClosedCandle(candle);
    const second = service.handleClosedCandle(candle);
    await waitFor(() => releasePoll !== undefined);
    releasePoll?.();
    await Promise.all([first, second]);

    expect(pollCount).toBe(1);
    expect(sentSignals).toHaveLength(1);
  });

  it("does not notify when replaying a deterministic signal key that already exists", async () => {
    const repository = new InMemoryFuturesRepository();
    const sentSignals: FuturesSignal[] = [];

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(createBaselineCandle(index));
    }

    await repository.saveSignal({
      symbol: "HEIUSDT",
      interval: "5m",
      candleOpenTime: 1_720_030_000_000,
      signalType: "LONG_BUILDUP_CANDIDATE",
      severity: "HIGH",
      confidence: 0.9,
      explanation: "preseeded replay signal",
      evidence: ["seeded=true"],
      thresholdVersion: "cfg:5m:vr=2:oi=0.05:flat=0.01:taker=0.05",
    });

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            openInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1100",
              sumOpenInterestValue: "1100",
              timestamp: candle.closeTime,
            },
            previousOpenInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1000",
              sumOpenInterestValue: "1000",
              timestamp: candle.openTime - 300_000,
            },
            takerFlow: {
              symbol: candle.symbol!,
              buySellRatio: "3",
              buyVol: "150",
              sellVol: "50",
              timestamp: candle.closeTime,
            },
            fundingRate: {
              symbol: candle.symbol!,
              fundingRate: "0.0001",
              fundingTime: candle.closeTime,
            },
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 100,
            openInterestTimestamp: candle.closeTime,
            takerFlowTimestamp: candle.closeTime,
            fundingRateTimestamp: candle.closeTime,
            isComplete: true,
            missing: [],
          };
        },
      },
      notifier: {
        async send(signal) {
          sentSignals.push(signal);
          return "sent";
        },
      },
    });

    await service.refreshUniverse();
    await service.handleClosedCandle(
      createClosedCandle({
        openTime: 1_720_030_000_000,
        closeTime: 1_720_030_300_000,
      }),
    );

    expect(sentSignals).toEqual([]);
  });

  it("does not re-notify a deterministic signal key after a notifier failure on the first attempt", async () => {
    const repository = new InMemoryFuturesRepository();
    let sendAttempts = 0;

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(createBaselineCandle(index));
    }

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            openInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1100",
              sumOpenInterestValue: "1100",
              timestamp: candle.closeTime,
            },
            previousOpenInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1000",
              sumOpenInterestValue: "1000",
              timestamp: candle.openTime - 300_000,
            },
            takerFlow: {
              symbol: candle.symbol!,
              buySellRatio: "3",
              buyVol: "150",
              sellVol: "50",
              timestamp: candle.closeTime,
            },
            fundingRate: {
              symbol: candle.symbol!,
              fundingRate: "0.0001",
              fundingTime: candle.closeTime,
            },
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 100,
            openInterestTimestamp: candle.closeTime,
            takerFlowTimestamp: candle.closeTime,
            fundingRateTimestamp: candle.closeTime,
            isComplete: true,
            missing: [],
          };
        },
      },
      notifier: {
        async send() {
          sendAttempts += 1;
          if (sendAttempts === 1) {
            throw new Error("temporary notifier failure");
          }

          return "sent";
        },
      },
    });

    await service.refreshUniverse();
    const candle = createClosedCandle({
      openTime: 1_720_031_000_000,
      closeTime: 1_720_031_300_000,
    });

    await expect(service.handleClosedCandle(candle)).rejects.toThrow("temporary notifier failure");
    await service.handleClosedCandle(candle);

    expect(sendAttempts).toBe(1);
  });

  it("saves degraded context without emitting a directional signal", async () => {
    const repository = new InMemoryFuturesRepository();

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(
        createBaselineCandle(index, "5m"),
      );
    }

    let marketContextWrites = 0;
    const savingRepository = Object.assign(Object.create(Object.getPrototypeOf(repository)), repository, {
      async saveMarketContext(context: MarketContext) {
        marketContextWrites += 1;
        return repository.saveMarketContext(context);
      },
    });

    const sentSignals: FuturesSignal[] = [];
    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository: savingRepository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [
            createUniverseItem({
              symbol: "BANKUSDT",
              pair: "BANKUSDT",
              baseAsset: "BANK",
              isContractOnly: false,
              contractOnlyReason: "SPOT_BASE_ASSET_PRESENT",
              spotBaseAssetMatches: ["BANK"],
            }),
          ];
        },
        async getSpotExchangeInfo() {
          return [{ symbol: "BANKUSDT", baseAsset: "BANK", quoteAsset: "USDT", status: "TRADING" }];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 50,
            isComplete: false,
            missing: ["openInterest", "takerFlow"],
          };
        },
      },
      notifier: {
        async send(signal) {
          sentSignals.push(signal);
          return "sent";
        },
      },
    });

    await service.refreshUniverse();
    await service.handleClosedCandle(
      createClosedCandle({
        symbol: "BANKUSDT",
      }),
    );

    const savedCandles = await repository.getClosedCandleBaseline("BANKUSDT", "5m", 25);
    const signals = await repository.listSignals({
      symbol: "BANKUSDT",
      interval: "5m",
      limit: 10,
    });

    expect(savedCandles).toHaveLength(1);
    expect(marketContextWrites).toBe(1);
    expect(signals).toEqual([]);
    expect(sentSignals).toEqual([]);
  });

  it("uses the configured futures poll concurrency to cap simultaneous closed-candle processing", async () => {
    const repository = new InMemoryFuturesRepository();
    let inflight = 0;
    let maxInflight = 0;
    const releases: Array<() => void> = [];

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(createBaselineCandle(index));
      await repository.saveCandle(createBaselineCandle(index, "15m"));
    }

    const service = new FuturesRadarService({
      config: createServiceConfig({
        futuresPollConcurrency: 2,
      }),
      repository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          inflight += 1;
          maxInflight = Math.max(maxInflight, inflight);

          await new Promise<void>((resolve) => releases.push(resolve));

          inflight -= 1;

          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 50,
            isComplete: false,
            missing: ["openInterest", "takerFlow"],
          };
        },
      },
      notifier: {
        async send() {
          return "sent";
        },
      },
    });

    await service.refreshUniverse();

    const first = service.handleClosedCandle(
      createClosedCandle({
        openTime: 1_720_003_000_000,
        closeTime: 1_720_003_300_000,
      }),
    );
    const second = service.handleClosedCandle(
      createClosedCandle({
        openTime: 1_720_003_600_000,
        closeTime: 1_720_003_900_000,
      }),
    );
    const third = service.handleClosedCandle(
      createClosedCandle({
        openTime: 1_720_004_200_000,
        closeTime: 1_720_004_500_000,
      }),
    );

    await waitFor(() => maxInflight === 2);
    expect(maxInflight).toBe(2);

    releases.shift()?.();
    releases.shift()?.();
    await Promise.all([first, second]);
    releases.shift()?.();
    await third;

    expect(maxInflight).toBe(2);
  });

  it("requests REST backfill when the checkpoint lags by more than one interval and processes the missing closed candles before the incoming candle", async () => {
    const repository = new InMemoryFuturesRepository();
    const processedOpenTimes: number[] = [];
    const checkpointWrites: number[] = [];
    const backfillCalls: Array<{ symbol: string; interval: "5m" | "15m"; limit: number }> = [];
    let checkpoint: number | null = 1_200_000;

    const durableRepository = Object.assign(Object.create(Object.getPrototypeOf(repository)), repository, {
      async getCheckpoint() {
        return checkpoint;
      },
      async setCheckpoint(_stream: string, timestamp: number) {
        checkpoint = timestamp;
        checkpointWrites.push(timestamp);
      },
    });

    const incoming = createClosedCandle({
      openTime: 1_800_000,
      closeTime: 2_100_000,
      sourceTimestamp: 2_100_000,
      receivedTimestamp: 2_100_050,
    });

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository: durableRepository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
        async getKlines(symbol: string, interval: "5m" | "15m" | "1h", limit: number) {
          if (interval === "1h") {
            return [];
          }
          backfillCalls.push({ symbol, interval, limit });
          return [
            createClosedCandle({
              symbol,
              interval,
              openTime: 1_200_000,
              closeTime: 1_500_000,
              sourceTimestamp: 1_500_000,
            }),
            createClosedCandle({
              symbol,
              interval,
              openTime: 1_500_000,
              closeTime: 1_800_000,
              sourceTimestamp: 1_800_000,
            }),
            incoming,
          ];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          processedOpenTimes.push(candle.openTime);
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 100,
            isComplete: false,
            missing: ["openInterest", "takerFlow"],
          };
        },
      },
      notifier: {
        async send() {
          return "sent";
        },
      },
    });

    await service.refreshUniverse();
    await service.handleClosedCandle(incoming);

    expect(backfillCalls).toEqual([{ symbol: "HEIUSDT", interval: "5m", limit: 50 }]);
    expect(processedOpenTimes).toEqual([1_200_000, 1_500_000, 1_800_000]);
    expect(checkpointWrites).toEqual([1_500_000, 1_800_000, 2_100_000]);
    expect(checkpoint).toBe(2_100_000);
  });

  it("saves live stream candles as updates and never classifies them", async () => {
    const repository = new InMemoryFuturesRepository();
    const stream = createFakeStream();
    let pollCount = 0;
    const sentSignals: FuturesSignal[] = [];

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream,
      oiPoller: {
        async pollClosedCandle() {
          pollCount += 1;
          throw new Error("live candles should not poll");
        },
      },
      notifier: {
        async send(signal) {
          sentSignals.push(signal);
          return "sent";
        },
      },
    });

    await service.refreshUniverse();
    await stream.handler?.(
      createClosedCandle({
        isClosed: false,
      }),
    );

    expect(pollCount).toBe(0);
    expect(sentSignals).toEqual([]);
    expect(repository.debugSnapshot().candles).toEqual([
      expect.objectContaining({
        openTime: 1_720_000_000_000,
        closeTime: 1_720_000_300_000,
        isClosed: false,
      }),
    ]);
  });

  it("catches background stream-processing failures, reports a sanitized error, and keeps the handler resolved", async () => {
    const repository = new InMemoryFuturesRepository();
    const stream = createFakeStream();
    const backgroundErrors: Array<{ scope: string; message: string }> = [];

    for (let index = 0; index < 20; index += 1) {
      await repository.saveCandle(createBaselineCandle(index));
    }

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream,
      oiPoller: {
        async pollClosedCandle(candle): Promise<MarketContext> {
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            openInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1100",
              sumOpenInterestValue: "1100",
              timestamp: candle.closeTime,
            },
            previousOpenInterest: {
              symbol: candle.symbol!,
              sumOpenInterest: "1000",
              sumOpenInterestValue: "1000",
              timestamp: candle.openTime - 300_000,
            },
            takerFlow: {
              symbol: candle.symbol!,
              buySellRatio: "3",
              buyVol: "150",
              sellVol: "50",
              timestamp: candle.closeTime,
            },
            fundingRate: {
              symbol: candle.symbol!,
              fundingRate: "0.0001",
              fundingTime: candle.closeTime,
            },
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 100,
            openInterestTimestamp: candle.closeTime,
            takerFlowTimestamp: candle.closeTime,
            fundingRateTimestamp: candle.closeTime,
            isComplete: true,
            missing: [],
          };
        },
      },
      notifier: {
        async send() {
          throw new Error("notify token=secret");
        },
      },
      onError(event) {
        backgroundErrors.push({
          scope: event.scope,
          message: event.message,
        });
      },
    });

    await service.refreshUniverse();

    await stream.handler?.(
      createClosedCandle({
        openTime: 1_720_050_000_000,
        closeTime: 1_720_050_300_000,
      }),
    );

    expect(backgroundErrors).toEqual([
      {
        scope: "stream-candle-processing",
        message: "notify token=REDACTED",
      },
    ]);
  });

  it("catches refresh-timer failures, reports a sanitized error, and leaves the service running", async () => {
    const stream = createFakeStream();
    const backgroundErrors: Array<{ scope: string; message: string }> = [];
    let refreshAttempts = 0;
    let intervalCallback: (() => void) | undefined;

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository: new InMemoryFuturesRepository(),
      restClient: {
        async getFuturesExchangeInfo() {
          refreshAttempts += 1;
          if (refreshAttempts > 1) {
            throw new Error("refresh token=secret");
          }

          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream,
      oiPoller: {
        async pollClosedCandle() {
          throw new Error("should not poll during timer test");
        },
      },
      notifier: {
        async send() {
          throw new Error("should not notify during timer test");
        },
      },
      setIntervalFn(callback) {
        intervalCallback = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn() {},
      onError(event) {
        backgroundErrors.push({
          scope: event.scope,
          message: event.message,
        });
      },
    });

    await service.start();
    intervalCallback?.();
    await waitFor(() => backgroundErrors.length === 1);

    expect(stream.startCalls).toHaveLength(1);
    expect(backgroundErrors).toEqual([
      {
        scope: "refresh-timer",
        message: "refresh token=REDACTED",
      },
    ]);

    await service.stop();
  });

  it("stops the stream, closes supported repository resources, and avoids duplicate stream wiring on refresh", async () => {
    const stream = createFakeStream();
    let intervalCallback: (() => Promise<void> | void) | undefined;
    let clearIntervalCalls = 0;
    let repositoryClosed = 0;

    const baseRepository = new InMemoryFuturesRepository();
    const repository = Object.assign(Object.create(Object.getPrototypeOf(baseRepository)), baseRepository, {
      async close() {
        repositoryClosed += 1;
      },
    });

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [createUniverseItem()];
        },
        async getSpotExchangeInfo() {
          return [];
        },
      },
      stream,
      oiPoller: {
        async pollClosedCandle() {
          throw new Error("not expected");
        },
      },
      notifier: {
        async send() {
          throw new Error("not expected");
        },
      },
      setIntervalFn(callback) {
        intervalCallback = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn() {
        clearIntervalCalls += 1;
      },
      refreshIntervalMs: 30_000,
    });

    await service.start();
    await intervalCallback?.();
    await service.refreshUniverse();
    await service.stop();

    expect(stream.handler).toBeTypeOf("function");
    expect(stream.startCalls).toHaveLength(1);
    expect(stream.stopCalls).toBe(1);
    expect(repositoryClosed).toBe(1);
    expect(clearIntervalCalls).toBe(1);
  });

  it("records excluded futures and spot symbols as normalized universe-refresh audit events", async () => {
    const repository = new InMemoryFuturesRepository();

    const service = new FuturesRadarService({
      config: createServiceConfig(),
      repository,
      restClient: {
        async getFuturesExchangeInfo() {
          return [
            createUniverseItem(),
            createUniverseItem({
              symbol: "HEIUSD_240927",
              pair: "HEIUSD",
              quoteAsset: "USD",
              contractType: "CURRENT_QUARTER",
            }),
            createUniverseItem({
              symbol: "PAUSEUSDT",
              pair: "PAUSEUSDT",
              baseAsset: "PAUSE",
              status: "BREAK",
            }),
          ];
        },
        async getSpotExchangeInfo() {
          return [
            { symbol: "HEIUSDT", baseAsset: "HEI", quoteAsset: "USDT", status: "TRADING" },
            { symbol: "PAUSEUSDT", baseAsset: "PAUSE", quoteAsset: "USDT", status: "BREAK" },
          ];
        },
      },
      stream: createFakeStream(),
      oiPoller: {
        async pollClosedCandle() {
          throw new Error("not expected");
        },
      },
      notifier: {
        async send() {
          throw new Error("not expected");
        },
      },
      now: () => 1_720_040_000_000,
    });

    await service.refreshUniverse();

    expect(repository.debugSnapshot().sourceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "universe_symbol_excluded",
          symbol: "HEIUSD_240927",
          payload: expect.objectContaining({
            scope: "futures",
            exclusionReason: "NON_USDT_OR_NON_PERPETUAL",
          }),
        }),
        expect.objectContaining({
          eventType: "universe_symbol_excluded",
          symbol: "PAUSEUSDT",
          payload: expect.objectContaining({
            scope: "futures",
            exclusionReason: "STATUS_BREAK",
          }),
        }),
        expect.objectContaining({
          eventType: "universe_symbol_excluded",
          symbol: "PAUSEUSDT",
          payload: expect.objectContaining({
            scope: "spot",
            exclusionReason: "STATUS_BREAK",
          }),
        }),
      ]),
    );
  });
});
