import { describe, expect, it } from "vitest";

import { FuturesPipeline, OiPoller } from "../src/ingest/futures-pipeline";
import { RateLimitedQueue } from "../src/ingest/rate-limited-queue";

function createClosedCandle(options: {
  symbol?: string;
  interval?: "5m" | "15m";
  openTime: number;
  closeTime: number;
}) {
  return {
    symbol: options.symbol ?? "HEIUSDT",
    interval: options.interval ?? "5m",
    openTime: options.openTime,
    open: "1.00",
    high: "1.10",
    low: "0.95",
    close: "1.05",
    volume: "1000",
    closeTime: options.closeTime,
    quoteAssetVolume: "1500",
    tradeCount: 100,
    takerBuyBaseAssetVolume: "450",
    takerBuyQuoteAssetVolume: "675",
    isClosed: true,
    raw: [],
  };
}

describe("RateLimitedQueue", () => {
  it("deduplicates queued work by key and respects the configured concurrency", async () => {
    const queue = new RateLimitedQueue({ concurrency: 2 });
    let inFlight = 0;
    let maxInFlight = 0;
    const release: Array<() => void> = [];

    const task = (label: string) =>
      queue.enqueue(label, async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => release.push(resolve));
        inFlight -= 1;
        return label;
      });

    const first = task("A");
    const duplicate = task("A");
    const second = task("B");
    const third = task("C");

    expect(maxInFlight).toBe(2);

    release.shift()?.();
    release.shift()?.();
    await Promise.all([first, duplicate, second]);
    release.shift()?.();

    expect(await third).toBe("C");
    expect(await first).toBe("A");
    expect(await duplicate).toBe("A");
    expect(await second).toBe("B");
    expect(queue.size).toBe(0);
  });

  it("deduplicates tasks still waiting in the pending queue", async () => {
    const queue = new RateLimitedQueue({ concurrency: 1 });
    let runs = 0;
    const release: Array<() => void> = [];

    const task = (label: string) =>
      queue.enqueue(label, async () => {
        runs += 1;
        await new Promise<void>((resolve) => release.push(resolve));
        return label;
      });

    const first = task("A");
    const queued = task("B");
    const duplicateB = task("B");

    // 同一 key 还在排队时再次入队返回同一个 promise，任务只执行一次。
    expect(duplicateB).toBe(queued);

    release.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    release.shift()?.();
    await Promise.all([first, queued, duplicateB]);

    expect(runs).toBe(2);
  });
});

describe("OiPoller", () => {
  it("marks context incomplete when the current OI snapshot exists but the preceding OI snapshot is missing", async () => {
    const candle = createClosedCandle({
      interval: "5m",
      openTime: 300_000,
      closeTime: 600_000,
    });

    const poller = new OiPoller({
      restClient: {
        async getOpenInterestHistory() {
          return [{ symbol: "HEIUSDT", sumOpenInterest: "1100", sumOpenInterestValue: "1100", timestamp: 600_000 }];
        },
        async getTakerLongShortRatio() {
          return [{ symbol: "HEIUSDT", buySellRatio: "2", buyVol: "120", sellVol: "60", timestamp: 600_000 }];
        },
        async getFundingRateHistory() {
          return [{ symbol: "HEIUSDT", fundingRate: "0.0001", fundingTime: 590_000 }];
        },
      },
      sleep: async () => {},
      now: () => 601_000,
    });

    const context = await poller.pollClosedCandle(candle);

    expect(context.openInterest?.timestamp).toBe(600_000);
    expect(context.previousOpenInterest).toBeUndefined();
    expect(context.isComplete).toBe(false);
    expect(context.missing).toEqual(["previousOpenInterest"]);
  });

  it("keeps OI and funding data when the public taker-flow endpoint is malformed", async () => {
    const candle = createClosedCandle({
      interval: "5m",
      openTime: 300_000,
      closeTime: 600_000,
    });

    const poller = new OiPoller({
      restClient: {
        async getOpenInterestHistory() {
          return [
            { symbol: "HEIUSDT", sumOpenInterest: "1000", sumOpenInterestValue: "1000", timestamp: 300_000 },
            { symbol: "HEIUSDT", sumOpenInterest: "1100", sumOpenInterestValue: "1100", timestamp: 600_000 },
          ];
        },
        async getTakerLongShortRatio() {
          throw new Error("malformed public taker-flow payload");
        },
        async getFundingRateHistory() {
          return [{ symbol: "HEIUSDT", fundingRate: "0.0001", fundingTime: 590_000 }];
        },
      },
      sleep: async () => {},
      now: () => 601_000,
    });

    const context = await poller.pollClosedCandle(candle);

    expect(context.openInterest?.timestamp).toBe(600_000);
    expect(context.previousOpenInterest?.timestamp).toBe(300_000);
    expect(context.fundingRate?.fundingRate).toBe("0.0001");
    expect(context.takerFlow).toBeUndefined();
    expect(context.missing).toEqual(["takerFlow"]);
    expect(context.isComplete).toBe(false);
  });

  it("retries missing latest OI and taker context twice, then returns an incomplete context without fabricating values", async () => {
    const delays: number[] = [];
    const candle = createClosedCandle({
      interval: "15m",
      openTime: 900_000,
      closeTime: 1_800_000,
    });

    const poller = new OiPoller({
      restClient: {
        async getOpenInterestHistory() {
          return [];
        },
        async getTakerLongShortRatio() {
          return [];
        },
        async getFundingRateHistory() {
          return [{ symbol: "HEIUSDT", fundingRate: "0.0001", fundingTime: 1_700_000 }];
        },
      },
      sleep: async (delayMs: number) => {
        delays.push(delayMs);
      },
      now: () => 1_900_000,
    });

    const context = await poller.pollClosedCandle(candle);

    expect(delays).toEqual([2_000, 5_000]);
    expect(context.symbol).toBe("HEIUSDT");
    expect(context.interval).toBe("15m");
    expect(context.candleOpenTime).toBe(900_000);
    expect(context.openInterest).toBeUndefined();
    expect(context.takerFlow).toBeUndefined();
    expect(context.fundingRate?.fundingRate).toBe("0.0001");
    expect(context.isComplete).toBe(false);
    expect(context.missing).toEqual(["openInterest", "takerFlow"]);
  });

  it("chooses the latest taker snapshot within the candle window even when the snapshots arrive unordered", async () => {
    const candle = createClosedCandle({
      interval: "5m",
      openTime: 300_000,
      closeTime: 600_000,
    });

    const poller = new OiPoller({
      restClient: {
        async getOpenInterestHistory() {
          return [{ symbol: "HEIUSDT", sumOpenInterest: "1100", sumOpenInterestValue: "1100", timestamp: 600_000 }];
        },
        async getTakerLongShortRatio() {
          return [
            { symbol: "HEIUSDT", buySellRatio: "1.2", buyVol: "90", sellVol: "75", timestamp: 540_000 },
            { symbol: "HEIUSDT", buySellRatio: "1.5", buyVol: "150", sellVol: "100", timestamp: 600_000 },
            { symbol: "HEIUSDT", buySellRatio: "1.1", buyVol: "55", sellVol: "50", timestamp: 480_000 },
          ];
        },
        async getFundingRateHistory() {
          return [{ symbol: "HEIUSDT", fundingRate: "0.0001", fundingTime: 590_000 }];
        },
      },
      sleep: async () => {},
      now: () => 601_000,
    });

    const context = await poller.pollClosedCandle(candle);

    expect(context.takerFlow?.timestamp).toBe(600_000);
    expect(context.takerFlow?.buySellRatio).toBe("1.5");
    expect(context.takerFlowTimestamp).toBe(600_000);
  });

  it("chooses the latest funding snapshot at or before candle close and falls back to the newest sorted snapshot when none qualify", async () => {
    const candle = createClosedCandle({
      interval: "15m",
      openTime: 900_000,
      closeTime: 1_800_000,
    });

    const qualifiedPoller = new OiPoller({
      restClient: {
        async getOpenInterestHistory() {
          return [{ symbol: "HEIUSDT", sumOpenInterest: "1100", sumOpenInterestValue: "1100", timestamp: 1_800_000 }];
        },
        async getTakerLongShortRatio() {
          return [{ symbol: "HEIUSDT", buySellRatio: "2", buyVol: "120", sellVol: "60", timestamp: 1_800_000 }];
        },
        async getFundingRateHistory() {
          return [
            { symbol: "HEIUSDT", fundingRate: "0.0003", fundingTime: 2_400_000 },
            { symbol: "HEIUSDT", fundingRate: "0.0002", fundingTime: 1_700_000 },
            { symbol: "HEIUSDT", fundingRate: "0.0001", fundingTime: 1_200_000 },
          ];
        },
      },
      sleep: async () => {},
      now: () => 1_801_000,
    });

    const qualifiedContext = await qualifiedPoller.pollClosedCandle(candle);

    expect(qualifiedContext.fundingRate?.fundingTime).toBe(1_700_000);
    expect(qualifiedContext.fundingRate?.fundingRate).toBe("0.0002");
    expect(qualifiedContext.fundingRateTimestamp).toBe(1_700_000);

    const fallbackPoller = new OiPoller({
      restClient: {
        async getOpenInterestHistory() {
          return [{ symbol: "HEIUSDT", sumOpenInterest: "1100", sumOpenInterestValue: "1100", timestamp: 1_800_000 }];
        },
        async getTakerLongShortRatio() {
          return [{ symbol: "HEIUSDT", buySellRatio: "2", buyVol: "120", sellVol: "60", timestamp: 1_800_000 }];
        },
        async getFundingRateHistory() {
          return [
            { symbol: "HEIUSDT", fundingRate: "0.0003", fundingTime: 2_400_000 },
            { symbol: "HEIUSDT", fundingRate: "0.0002", fundingTime: 2_100_000 },
            { symbol: "HEIUSDT", fundingRate: "0.0001", fundingTime: 2_700_000 },
          ];
        },
      },
      sleep: async () => {},
      now: () => 1_801_000,
    });

    const fallbackContext = await fallbackPoller.pollClosedCandle(candle);

    expect(fallbackContext.fundingRate?.fundingTime).toBe(2_700_000);
    expect(fallbackContext.fundingRate?.fundingRate).toBe("0.0001");
    expect(fallbackContext.fundingRateTimestamp).toBe(2_700_000);
  });
});

describe("FuturesPipeline", () => {
  it("stores live candles as updates but polls closed candles only once per symbol, interval, and openTime", async () => {
    const saved: Array<{ symbol: string; interval: string; openTime: number; isClosed?: boolean }> = [];
    const polled: Array<{ symbol: string; interval: string; openTime: number }> = [];
    let checkpoint: number | null = null;

    const pipeline = new FuturesPipeline({
      repository: {
        async saveCandle(candle) {
          saved.push({
            symbol: candle.symbol!,
            interval: candle.interval!,
            openTime: candle.openTime,
            isClosed: candle.isClosed,
          });
        },
        async getCheckpoint() {
          return checkpoint;
        },
        async setCheckpoint(_stream, timestamp) {
          checkpoint = timestamp;
        },
      },
      oiPoller: {
        async pollClosedCandle(candle) {
          polled.push({
            symbol: candle.symbol!,
            interval: candle.interval!,
            openTime: candle.openTime,
          });
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime,
            isComplete: true,
            missing: [],
          };
        },
      },
      queue: new RateLimitedQueue({ concurrency: 2 }),
    });

    const live = {
      ...createClosedCandle({
        openTime: 1_000,
        closeTime: 301_000,
      }),
      isClosed: false,
    };
    const closed = createClosedCandle({
      openTime: 1_000,
      closeTime: 301_000,
    });

    await pipeline.handleCandle(live);
    await pipeline.handleCandle(closed);
    await pipeline.handleCandle(closed);

    expect(saved).toEqual([
      { symbol: "HEIUSDT", interval: "5m", openTime: 1_000, isClosed: false },
      { symbol: "HEIUSDT", interval: "5m", openTime: 1_000, isClosed: true },
      { symbol: "HEIUSDT", interval: "5m", openTime: 1_000, isClosed: true },
    ]);
    expect(polled).toEqual([{ symbol: "HEIUSDT", interval: "5m", openTime: 1_000 }]);
  });

  it("requests a REST backfill when the persisted close time lags by more than one interval and processes missing candles in order", async () => {
    const processed: number[] = [];
    const checkpoints: number[] = [];
    const backfillCalls: Array<{ symbol: string; interval: "5m" | "15m"; limit: number }> = [];
    const incoming = createClosedCandle({
      openTime: 1_800_000,
      closeTime: 2_100_000,
    });

    const pipeline = new FuturesPipeline({
      repository: {
        async saveCandle() {},
        async getCheckpoint() {
          return 1_200_000;
        },
        async setCheckpoint(_stream, timestamp) {
          checkpoints.push(timestamp);
        },
      },
      restClient: {
        async getKlines(symbol: string, interval: "5m" | "15m", limit: number) {
          backfillCalls.push({ symbol, interval, limit });
          return [
            createClosedCandle({
              symbol,
              interval,
              openTime: 1_200_000,
              closeTime: 1_500_000,
            }),
            createClosedCandle({
              symbol,
              interval,
              openTime: 1_500_000,
              closeTime: 1_800_000,
            }),
            incoming,
          ];
        },
      },
      oiPoller: {
        async pollClosedCandle(candle) {
          processed.push(candle.openTime);
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime,
            isComplete: true,
            missing: [],
          };
        },
      },
      queue: new RateLimitedQueue({ concurrency: 1 }),
    });

    await pipeline.handleCandle(incoming);

    expect(backfillCalls).toEqual([{ symbol: "HEIUSDT", interval: "5m", limit: 50 }]);
    expect(processed).toEqual([1_200_000, 1_500_000, 1_800_000]);
    expect(checkpoints).toEqual([1_500_000, 1_800_000, 2_100_000]);
  });

  it("skips closed candles that are already behind the persisted checkpoint and does not regress the checkpoint", async () => {
    let checkpoint = 2_400_000;
    let pollCount = 0;
    let setCheckpointCount = 0;
    let backfillCount = 0;

    const pipeline = new FuturesPipeline({
      repository: {
        async saveCandle() {},
        async getCheckpoint() {
          return checkpoint;
        },
        async setCheckpoint(_stream, timestamp) {
          checkpoint = timestamp;
          setCheckpointCount += 1;
        },
      },
      restClient: {
        async getKlines() {
          backfillCount += 1;
          return [];
        },
      },
      oiPoller: {
        async pollClosedCandle() {
          pollCount += 1;
          return {
            symbol: "HEIUSDT",
            interval: "5m",
            candleOpenTime: 1_800_000,
            candleCloseTime: 2_100_000,
            sourceTimestamp: 2_100_000,
            receivedTimestamp: 2_100_100,
            isComplete: true,
            missing: [],
          };
        },
      },
      queue: new RateLimitedQueue({ concurrency: 1 }),
    });

    await pipeline.handleCandle(
      createClosedCandle({
        openTime: 1_800_000,
        closeTime: 2_100_000,
      }),
    );

    expect(backfillCount).toBe(0);
    expect(pollCount).toBe(0);
    expect(setCheckpointCount).toBe(0);
    expect(checkpoint).toBe(2_400_000);
  });

  it("allows a failed closed-candle poll to be retried and only advances the checkpoint after the successful retry", async () => {
    let checkpoint: number | null = null;
    let attempts = 0;

    const pipeline = new FuturesPipeline({
      repository: {
        async saveCandle() {},
        async getCheckpoint() {
          return checkpoint;
        },
        async setCheckpoint(_stream, timestamp) {
          checkpoint = timestamp;
        },
      },
      oiPoller: {
        async pollClosedCandle(candle) {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("temporary poll failure");
          }

          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            sourceTimestamp: candle.closeTime,
            receivedTimestamp: candle.closeTime + 1,
            isComplete: true,
            missing: [],
          };
        },
      },
      queue: new RateLimitedQueue({ concurrency: 1 }),
    });

    const candle = createClosedCandle({
      openTime: 1_000,
      closeTime: 301_000,
    });

    await expect(pipeline.handleCandle(candle)).rejects.toThrow("temporary poll failure");
    expect(checkpoint).toBeNull();

    await pipeline.handleCandle(candle);

    expect(attempts).toBe(2);
    expect(checkpoint).toBe(301_000);
  });

  it("stamps received timestamps at pipeline ingress without overwriting the source timestamp", async () => {
    const saved: Array<{ sourceTimestamp?: number; receivedTimestamp?: number }> = [];

    const options: any = {
      now: () => 7_777,
      repository: {
        async saveCandle(candle: { sourceTimestamp?: number; receivedTimestamp?: number }) {
          saved.push({
            sourceTimestamp: candle.sourceTimestamp,
            receivedTimestamp: candle.receivedTimestamp,
          });
        },
        async getCheckpoint() {
          return null;
        },
        async setCheckpoint() {},
      },
      oiPoller: {
        async pollClosedCandle(candle: { symbol?: string; interval?: "5m" | "15m"; openTime: number; closeTime: number }) {
          return {
            symbol: candle.symbol!,
            interval: candle.interval!,
            candleOpenTime: candle.openTime,
            candleCloseTime: candle.closeTime,
            sourceTimestamp: 3_333,
            receivedTimestamp: 7_777,
            isComplete: true,
            missing: [],
          };
        },
      },
      queue: new RateLimitedQueue({ concurrency: 1 }),
    };

    const pipeline = new FuturesPipeline(options);
    await pipeline.handleCandle({
      ...createClosedCandle({
        openTime: 10_000,
        closeTime: 310_000,
      }),
      sourceTimestamp: 3_333,
      receivedTimestamp: undefined,
    });

    expect(saved).toEqual([
      {
        sourceTimestamp: 3_333,
        receivedTimestamp: 7_777,
      },
    ]);
  });
});
