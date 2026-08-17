import { describe, expect, it } from "vitest";
import { FuturesRetentionService } from "../src/services/futures-retention-service";
import type { FuturesCleanupInput, FuturesCleanupStats } from "../src/storage/futures-repository";

const DAY_MS = 24 * 60 * 60 * 1_000;

describe("FuturesRetentionService", () => {
  it("runs an initial cleanup with configured cutoffs and schedules the next cleanup", async () => {
    const now = 1_800_000_000_000;
    const calls: FuturesCleanupInput[] = [];
    let scheduledCallback: (() => void) | undefined;
    let scheduledDelay = 0;
    let clearedTimer: unknown;
    const repository = {
      async cleanupHistoricalData(input: FuturesCleanupInput): Promise<FuturesCleanupStats> {
        calls.push(input);
        return {
          candles: 0,
          openInterest: 0,
          metrics: 0,
          references: 0,
          signals: 0,
          sourceEvents: 0,
        };
      },
    };

    const service = new FuturesRetentionService({
      repository,
      now: () => now,
      retention: {
        hotRetentionDays: 30,
        signalRetentionDays: 180,
        sourceEventRetentionDays: 14,
        cleanupIntervalMs: 21_600_000,
        cleanupBatchSize: 5_000,
      },
      setIntervalFn(callback, delay) {
        scheduledCallback = callback;
        scheduledDelay = delay;
        return 7;
      },
      clearIntervalFn(timer) {
        clearedTimer = timer;
      },
    });

    await service.start();

    expect(calls).toEqual([
      {
        hotCutoff: now - 30 * DAY_MS,
        signalCutoff: now - 180 * DAY_MS,
        sourceEventCutoff: now - 14 * DAY_MS,
        batchSize: 5_000,
      },
    ]);
    expect(scheduledDelay).toBe(21_600_000);
    expect(scheduledCallback).toBeTypeOf("function");

    await service.stop();

    expect(clearedTimer).toBe(7);
  });
});
