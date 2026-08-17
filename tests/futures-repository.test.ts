import { describe, expect, it } from "vitest";
import type {
  ContractUniverseItem,
  FuturesCandle,
  FuturesMetrics,
  FuturesSignal,
  MarketContext,
  OpenInterestSnapshot,
  TakerFlowSnapshot,
} from "../src/domain/futures";
import { InMemoryFuturesRepository } from "../src/storage/in-memory-futures-repository";
import { PostgresFuturesRepository, type Queryable } from "../src/storage/futures-repository";

function createContract(overrides?: Partial<ContractUniverseItem>): ContractUniverseItem {
  return {
    symbol: "HEIUSDT",
    pair: "HEIUSDT",
    baseAsset: "HEI",
    quoteAsset: "USDT",
    contractType: "PERPETUAL",
    status: "TRADING",
    onboardDate: 1,
    isContractOnly: true,
    spotBaseAssetMatches: [],
    contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
    ...overrides,
  };
}

function createCandle(overrides?: Partial<FuturesCandle>): FuturesCandle {
  return {
    symbol: "HEIUSDT",
    interval: "5m",
    openTime: 0,
    open: "1.0",
    high: "1.2",
    low: "0.9",
    close: "1.1",
    volume: "100",
    closeTime: 300_000,
    quoteAssetVolume: "110",
    tradeCount: 10,
    takerBuyBaseAssetVolume: "55",
    takerBuyQuoteAssetVolume: "60",
    isClosed: true,
    sourceTimestamp: 300_000,
    receivedTimestamp: 300_321,
    raw: { stream: "kline" },
    ...overrides,
  };
}

function createSignal(overrides?: Partial<FuturesSignal>): FuturesSignal {
  return {
    signalType: "LONG_BUILDUP_CANDIDATE",
    severity: "HIGH",
    confidence: 0.81,
    explanation: "price rose while open interest expanded",
    evidence: ["priceReturn=8.00%", "oiValueDelta=11.00%"],
    symbol: "HEIUSDT",
    interval: "5m",
    candleOpenTime: 0,
    thresholdVersion: "task-6-test",
    ...overrides,
  };
}

function createOpenInterestSnapshot(overrides?: Partial<OpenInterestSnapshot>): OpenInterestSnapshot {
  return {
    symbol: "HEIUSDT",
    sumOpenInterest: "1200",
    sumOpenInterestValue: "2400",
    timestamp: 300_000,
    ...overrides,
  };
}

function createTakerFlowSnapshot(overrides?: Partial<TakerFlowSnapshot>): TakerFlowSnapshot {
  return {
    symbol: "HEIUSDT",
    buySellRatio: "1.4",
    buyVol: "140",
    sellVol: "100",
    timestamp: 300_000,
    ...overrides,
  };
}

function createMarketContext(overrides?: Partial<MarketContext>): MarketContext {
  return {
    symbol: "HEIUSDT",
    interval: "5m",
    candleOpenTime: 0,
    candleCloseTime: 300_000,
    openInterest: createOpenInterestSnapshot(),
    previousOpenInterest: createOpenInterestSnapshot({
      sumOpenInterest: "1000",
      sumOpenInterestValue: "2000",
      timestamp: 0,
    }),
    takerFlow: createTakerFlowSnapshot(),
    fundingRate: {
      symbol: "HEIUSDT",
      fundingRate: "0.0001",
      fundingTime: 240_000,
    },
    isContractOnly: true,
    contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
    spotBaseAssetMatches: [],
    sourceTimestamp: 300_000,
    receivedTimestamp: 300_555,
    openInterestTimestamp: 300_000,
    takerFlowTimestamp: 300_000,
    fundingRateTimestamp: 240_000,
    isComplete: true,
    missing: [],
    ...overrides,
  };
}

function createMetrics(overrides?: Partial<FuturesMetrics>): FuturesMetrics {
  return {
    symbol: "HEIUSDT",
    interval: "5m",
    candleOpenTime: 0,
    candleCloseTime: 300_000,
    volumeRatio: 2.4,
    volumePercentile: 0.95,
    oiValueDelta: 0.2,
    oiUnitDelta: 0.15,
    priceReturn: 0.08,
    takerImbalance: 0.18,
    liquidationRatio: 0.012,
    priceOiAlignment: "PRICE_UP_OI_UP",
    dataCompleteness: "COMPLETE",
    contractOnlyRisk: {
      level: "HIGH",
      reason: "NO_ACTIVE_SPOT_BASE_ASSET",
    },
    ...overrides,
  };
}

describe("InMemoryFuturesRepository", () => {
  it("sorts the contract-only leaderboard by anomaly score before OI magnitude", async () => {
    const repository = new InMemoryFuturesRepository();

    await repository.upsertContracts([
      createContract({ symbol: "HIGHSCORERUSDT", baseAsset: "HIGHSCORER" }),
      createContract({ symbol: "BIGOIUSDT", baseAsset: "BIGOI" }),
    ]);

    await repository.saveMarketContext(createMarketContext({
      symbol: "HIGHSCORERUSDT",
      isContractOnly: true,
      contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
      spotBaseAssetMatches: [],
    }));
    await repository.saveMetrics(createMetrics({
      symbol: "HIGHSCORERUSDT",
      oiValueDelta: 0.11,
      oiUnitDelta: 0.11,
      priceReturn: 0.08,
      volumeRatio: 2.4,
      takerImbalance: 0.18,
      priceOiAlignment: "PRICE_UP_OI_UP",
      dataCompleteness: "COMPLETE",
    }));

    await repository.saveMarketContext(createMarketContext({
      symbol: "BIG OIUSDT".replace(" ", ""),
      isContractOnly: true,
      contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
      spotBaseAssetMatches: [],
    }));
    await repository.saveMetrics(createMetrics({
      symbol: "BIGOIUSDT",
      oiValueDelta: 0.30,
      oiUnitDelta: 0.30,
      priceReturn: 0,
      volumeRatio: 0.1,
      takerImbalance: 0,
      priceOiAlignment: "FLAT_PRICE",
      dataCompleteness: "COMPLETE",
    }));

    const rows = await repository.listOiLeaderboard({ interval: "5m", limit: 10 });

    expect(rows.map((row) => row.symbol)).toEqual(["HIGHSCORERUSDT", "BIGOIUSDT"]);
    expect(rows[0]?.anomalyScore).toBeGreaterThan(rows[1]?.anomalyScore ?? 0);
    expect(rows.map((row) => row.rank)).toEqual([1, 2]);
  });

  it("excludes contracts above the ambush market-cap limit when maxMarketCapM is set", async () => {
    const repository = new InMemoryFuturesRepository();

    await repository.upsertContracts([
      createContract({ symbol: "SMALLCAPUSDT", baseAsset: "SMALLCAP" }),
      createContract({ symbol: "BIGCAPUSDT", baseAsset: "BIGCAP" }),
    ]);
    await repository.updateMarketCaps(new Map([
      ["SMALLCAPUSDT", 12],
      ["BIGCAPUSDT", 80],
    ]));
    for (const symbol of ["SMALLCAPUSDT", "BIGCAPUSDT"]) {
      await repository.saveMarketContext(createMarketContext({
        symbol,
        isContractOnly: true,
        contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
        spotBaseAssetMatches: [],
      }));
      await repository.saveMetrics(createMetrics({
        symbol,
        oiValueDelta: 0.05,
        oiUnitDelta: 0.05,
        priceReturn: 0.01,
        volumeRatio: 1.2,
        takerImbalance: 0.05,
        priceOiAlignment: "PRICE_UP_OI_UP",
        dataCompleteness: "COMPLETE",
      }));
    }

    // 无上限时不排除
    const all = await repository.listOiLeaderboard({ interval: "5m", limit: 10, scoreType: "ambush" });
    expect(all.map((row) => row.symbol).sort()).toEqual(["BIGCAPUSDT", "SMALLCAPUSDT"]);

    // 设置上限 20M 后，80M 的 BIGCAPUSDT 被排除
    const filtered = await repository.listOiLeaderboard({
      interval: "5m",
      limit: 10,
      scoreType: "ambush",
      maxMarketCapM: 20,
    });
    expect(filtered.map((row) => row.symbol)).toEqual(["SMALLCAPUSDT"]);
  });

  it("upserts contracts by symbol", async () => {
    const repository = new InMemoryFuturesRepository();

    await repository.upsertContracts([
      createContract(),
      createContract({
        symbol: "HEIUSDT",
        contractOnlyReason: "SPOT_BASE_ASSET_PRESENT",
        isContractOnly: false,
        spotBaseAssetMatches: ["HEI"],
      }),
    ]);

    expect(repository.debugSnapshot().contracts).toEqual([
      expect.objectContaining({
        symbol: "HEIUSDT",
        isContractOnly: false,
        contractOnlyReason: "SPOT_BASE_ASSET_PRESENT",
        spotBaseAssetMatches: ["HEI"],
      }),
    ]);
  });

  it("does not duplicate the same candle and preserves source and received timestamps separately", async () => {
    const repository = new InMemoryFuturesRepository();
    const candle = createCandle();

    await repository.saveCandle(candle);
    await repository.saveCandle(candle);

    const baseline = await repository.getClosedCandleBaseline("HEIUSDT", "5m", 10);

    expect(baseline).toHaveLength(1);
    expect(baseline[0]?.sourceTimestamp).toBe(300_000);
    expect(baseline[0]?.receivedTimestamp).toBe(300_321);
    expect(baseline[0]?.receivedTimestamp).not.toBe(baseline[0]?.sourceTimestamp);
  });

  it("returns only closed candles for the requested symbol and interval in chronological order", async () => {
    const repository = new InMemoryFuturesRepository();

    await repository.saveCandle(createCandle({ openTime: 600_000, closeTime: 900_000, sourceTimestamp: 900_000 }));
    await repository.saveCandle(createCandle({ openTime: 0, closeTime: 300_000, sourceTimestamp: 300_000 }));
    await repository.saveCandle(
      createCandle({
        symbol: "BANKUSDT",
        openTime: 300_000,
        closeTime: 600_000,
        sourceTimestamp: 600_000,
      }),
    );
    await repository.saveCandle(
      createCandle({
        symbol: "HEIUSDT",
        interval: "15m",
        openTime: 900_000,
        closeTime: 1_800_000,
        sourceTimestamp: 1_800_000,
      }),
    );
    await repository.saveCandle(
      createCandle({
        symbol: "HEIUSDT",
        openTime: 300_000,
        closeTime: 600_000,
        sourceTimestamp: 600_000,
        isClosed: false,
      }),
    );

    const baseline = await repository.getClosedCandleBaseline("HEIUSDT", "5m", 5);

    expect(baseline.map((candle) => candle.openTime)).toEqual([0, 600_000]);
    expect(baseline.every((candle) => candle.symbol === "HEIUSDT" && candle.interval === "5m" && candle.isClosed)).toBe(
      true,
    );
  });

  it("deduplicates signals by deterministic signal key", async () => {
    const repository = new InMemoryFuturesRepository();

    await repository.saveSignal(createSignal());
    await repository.saveSignal(createSignal({ explanation: "updated explanation" }));

    expect(repository.debugSnapshot().signals).toHaveLength(1);
    expect(repository.debugSnapshot().signals[0]).toEqual(
      expect.objectContaining({
        symbol: "HEIUSDT",
        interval: "5m",
        candleOpenTime: 0,
        signalType: "LONG_BUILDUP_CANDIDATE",
        thresholdVersion: "task-6-test",
      }),
    );
  });

  it("returns false from saveSignalIfNew when the deterministic signal key already exists", async () => {
    const repository = new InMemoryFuturesRepository();

    expect(await repository.saveSignalIfNew(createSignal())).toBe(true);
    expect(await repository.saveSignalIfNew(createSignal({ explanation: "updated explanation" }))).toBe(false);
    expect(repository.debugSnapshot().signals).toHaveLength(1);
  });

  it("persists checkpoints across a read write cycle", async () => {
    const repository = new InMemoryFuturesRepository();

    expect(await repository.getCheckpoint("HEIUSDT:5m")).toBeNull();

    await repository.setCheckpoint("HEIUSDT:5m", 900_000);

    expect(await repository.getCheckpoint("HEIUSDT:5m")).toBe(900_000);
  });

  it("keeps checkpoints monotonic for lower and equal writes", async () => {
    const repository = new InMemoryFuturesRepository();

    await repository.setCheckpoint("HEIUSDT:5m", 900_000);
    expect(await repository.getCheckpoint("HEIUSDT:5m")).toBe(900_000);

    await repository.setCheckpoint("HEIUSDT:5m", 900_000);
    expect(await repository.getCheckpoint("HEIUSDT:5m")).toBe(900_000);

    await repository.setCheckpoint("HEIUSDT:5m", 600_000);
    expect(await repository.getCheckpoint("HEIUSDT:5m")).toBe(900_000);

    await repository.setCheckpoint("HEIUSDT:5m", 1_200_000);

    expect(await repository.getCheckpoint("HEIUSDT:5m")).toBe(1_200_000);
    expect(repository.debugSnapshot().checkpoints).toEqual({
      "HEIUSDT:5m": 1_200_000,
    });
  });

  it("stores market context with OI snapshots and distinct source versus received timestamps", async () => {
    const repository = new InMemoryFuturesRepository();

    await repository.saveMarketContext(createMarketContext());

    const snapshot = repository.debugSnapshot();

    expect(snapshot.flowMetrics).toEqual([
      expect.objectContaining({
        symbol: "HEIUSDT",
        interval: "5m",
        candleOpenTime: 0,
        candleCloseTime: 300_000,
        sourceTimestamp: 300_000,
        receivedTimestamp: 300_555,
        fundingRateRaw: "0.0001",
        fundingRateTimestamp: 240_000,
        isComplete: true,
      }),
    ]);
    expect(snapshot.flowMetrics[0]?.receivedTimestamp).not.toBe(snapshot.flowMetrics[0]?.sourceTimestamp);
    expect(snapshot.oiSnapshots).toEqual([
      expect.objectContaining({
        symbol: "HEIUSDT",
        interval: "5m",
        timestamp: 0,
        sourceTimestamp: 0,
        receivedTimestamp: 300_555,
        sumOpenInterest: "1000",
      }),
      expect.objectContaining({
        symbol: "HEIUSDT",
        interval: "5m",
        timestamp: 300_000,
        sourceTimestamp: 300_000,
        receivedTimestamp: 300_555,
        sumOpenInterest: "1200",
      }),
    ]);
    expect(snapshot.sourceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "open_interest_snapshot",
          sourceTimestamp: 300_000,
          receivedTimestamp: 300_555,
        }),
        expect.objectContaining({
          eventType: "taker_flow_snapshot",
          sourceTimestamp: 300_000,
          receivedTimestamp: 300_555,
        }),
        expect.objectContaining({
          eventType: "funding_rate_snapshot",
          sourceTimestamp: 240_000,
          receivedTimestamp: 300_555,
        }),
      ]),
    );
  });

  it("stores derived metrics alongside the same candle identity", async () => {
    const repository = new InMemoryFuturesRepository();

    await repository.saveMetrics(createMetrics());

    expect(repository.debugSnapshot().flowMetrics).toEqual([
      expect.objectContaining({
        symbol: "HEIUSDT",
        interval: "5m",
        candleOpenTime: 0,
        candleCloseTime: 300_000,
        volumeRatio: 2.4,
        oiValueDelta: 0.2,
        oiUnitDelta: 0.15,
        takerImbalance: 0.18,
        priceOiAlignment: "PRICE_UP_OI_UP",
        dataCompleteness: "COMPLETE",
        contractOnlyRiskLevel: "HIGH",
        contractOnlyRiskReason: "NO_ACTIVE_SPOT_BASE_ASSET",
      }),
    ]);
  });

  it("matches PostgreSQL radar ordering tie-breakers through interval when severity, candle, and symbol tie", async () => {
    const repository = new InMemoryFuturesRepository();

    await repository.saveMarketContext(
      createMarketContext({
        interval: "15m",
        candleOpenTime: 600_000,
      }),
    );
    await repository.saveMetrics(
      createMetrics({
        interval: "15m",
        candleOpenTime: 600_000,
        candleCloseTime: 1_500_000,
      }),
    );
    await repository.saveSignal(
      createSignal({
        interval: "15m",
        candleOpenTime: 600_000,
      }),
    );
    await repository.saveMarketContext(
      createMarketContext({
        interval: "5m",
        candleOpenTime: 600_000,
      }),
    );
    await repository.saveMetrics(
      createMetrics({
        interval: "5m",
        candleOpenTime: 600_000,
        candleCloseTime: 900_000,
      }),
    );
    await repository.saveSignal(
      createSignal({
        interval: "5m",
        candleOpenTime: 600_000,
      }),
    );

    const rows = await repository.listRadar({
      limit: 10,
    });

    expect(rows.map((row) => `${row.symbol}:${row.interval}`)).toEqual(["HEIUSDT:15m", "HEIUSDT:5m"]);
  });

  it("matches PostgreSQL signal ordering tie-breakers through interval, signal type, and threshold version", async () => {
    const repository = new InMemoryFuturesRepository();

    await repository.saveSignal(
      createSignal({
        interval: "15m",
        candleOpenTime: 900_000,
        signalType: "SHORT_BUILDUP_CANDIDATE",
        thresholdVersion: "z-v2",
      }),
    );
    await repository.saveSignal(
      createSignal({
        interval: "5m",
        candleOpenTime: 900_000,
        signalType: "SHORT_BUILDUP_CANDIDATE",
        thresholdVersion: "z-v2",
      }),
    );
    await repository.saveSignal(
      createSignal({
        interval: "5m",
        candleOpenTime: 900_000,
        signalType: "LONG_BUILDUP_CANDIDATE",
        thresholdVersion: "z-v2",
      }),
    );
    await repository.saveSignal(
      createSignal({
        interval: "5m",
        candleOpenTime: 900_000,
        signalType: "LONG_BUILDUP_CANDIDATE",
        thresholdVersion: "a-v1",
      }),
    );

    const signals = await repository.listSignals({
      limit: 10,
    });

    expect(signals.map((signal) => `${signal.interval}:${signal.signalType}:${signal.thresholdVersion}`)).toEqual([
      "15m:SHORT_BUILDUP_CANDIDATE:z-v2",
      "5m:LONG_BUILDUP_CANDIDATE:a-v1",
      "5m:LONG_BUILDUP_CANDIDATE:z-v2",
      "5m:SHORT_BUILDUP_CANDIDATE:z-v2",
    ]);
  });
});

describe("PostgresFuturesRepository historical cleanup", () => {
  it("deletes each historical table in bounded batches", async () => {
    const deleteCalls = new Map<string, number>();
    const statements: string[] = [];
    const db: Queryable = {
      async query(text, values) {
        if (!text.startsWith("DELETE FROM")) {
          return { rows: [] };
        }

        const table = text.split(" ")[2] ?? "unknown";
        const calls = (deleteCalls.get(table) ?? 0) + 1;
        deleteCalls.set(table, calls);
        statements.push(`${table}:${String(values?.[0])}:${String(values?.[1])}`);
        return { rows: [], affectedRows: calls === 1 ? 2 : 0 };
      },
    };

    const repository = new PostgresFuturesRepository(db);
    const result = await repository.cleanupHistoricalData({
      hotCutoff: 1_000,
      signalCutoff: 2_000,
      sourceEventCutoff: 3_000,
      batchSize: 2,
    });

    expect(result).toEqual({
      candles: 2,
      openInterest: 2,
      metrics: 2,
      references: 2,
      signals: 2,
      sourceEvents: 2,
    });
    expect(statements).toHaveLength(12);
    expect(statements).toContain("futures_candles:1000:2");
    expect(statements).toContain("futures_signals:2000:2");
    expect(statements).toContain("source_events:3000:2");
  });
});

describe("PostgresFuturesRepository", () => {
  it("uses INSERT ... ON CONFLICT DO NOTHING RETURNING for saveSignalIfNew", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const repository = new PostgresFuturesRepository({
      async query(text, values) {
        queries.push({ text, values });
        return { rows: [{ created: 1 }] as any };
      },
    });

    const created = await repository.saveSignalIfNew(createSignal());

    expect(created).toBe(true);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("ON CONFLICT (symbol, interval, candle_open_time, signal_type, threshold_version) DO NOTHING");
    expect(queries[0]?.text).toContain("RETURNING 1 AS created");
  });

  it("uses a monotonic checkpoint upsert condition", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const repository = new PostgresFuturesRepository({
      async query(text, values) {
        queries.push({ text, values });
        return { rows: [] };
      },
    });

    await repository.setCheckpoint("HEIUSDT:5m", 900_000);

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("ON CONFLICT (stream) DO UPDATE");
    expect(queries[0]?.text).toContain("WHERE EXCLUDED.timestamp > connector_checkpoints.timestamp");
    expect(queries[0]?.values).toEqual(["HEIUSDT:5m", 900_000]);
  });
});
