import { describe, expect, it } from "vitest";
import type { BitgetReferenceFactor } from "../src/domain/bitget-reference";
import type { FuturesMetrics, FuturesSignal, MarketContext, OpenInterestSnapshot, TakerFlowSnapshot } from "../src/domain/futures";
import { InMemoryFuturesRepository } from "../src/storage/in-memory-futures-repository";
import { MysqlQueryable } from "../src/storage/mysql-queryable";
import { PostgresFuturesRepository } from "../src/storage/futures-repository";

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
    thresholdVersion: "task-3-test",
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

function createBitgetReference(overrides?: Partial<BitgetReferenceFactor>): BitgetReferenceFactor {
  return {
    provider: "bitget",
    symbol: "HEIUSDT",
    interval: "5m",
    candleOpenTime: 0,
    signalType: "LONG_BUILDUP_CANDIDATE",
    signalBias: "LONG",
    status: "BITGET_CONFIRMED",
    completeness: "COMPLETE",
    score: 0.5,
    confidenceAdjustment: 0.1,
    missing: [],
    evidence: ["Bitget现货方向一致", "Bitget合约持仓变化一致"],
    alignedSpotOpenTime: 0,
    alignedFuturesOpenTime: 0,
    spotPriceReturn: 0.015,
    futuresPriceReturn: 0.02,
    spotQuoteVolumeRatio: 1.7,
    futuresQuoteVolumeRatio: 1.9,
    oiDelta: 0.12,
    fundingRate: 0.0004,
    basis: 0.0012,
    priceGap: -0.0008,
    observedAt: 300_123,
    ...overrides,
  };
}

describe("Mysql Bitget reference persistence", () => {
  it("upserts a Bitget factor into futures_reference_factors with JSON arrays, NULL numerics, and the full conflict key", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const repository = new PostgresFuturesRepository(
      new MysqlQueryable({
        async query(text, values) {
          calls.push({ text, values: values ?? [] });
          return [{ affectedRows: 1 }, []];
        },
      }),
    ) as PostgresFuturesRepository & {
      saveBitgetReference(factor: BitgetReferenceFactor): Promise<void>;
    };

    await repository.saveBitgetReference(
      createBitgetReference({
        missing: ["openInterest", "priceGap"],
        evidence: ["provider=bitget", "openInterest missing"],
        alignedSpotOpenTime: undefined,
        spotPriceReturn: undefined,
        spotQuoteVolumeRatio: undefined,
        oiDelta: undefined,
        fundingRate: undefined,
        basis: undefined,
        priceGap: undefined,
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("INSERT INTO futures_reference_factors");
    expect(calls[0]?.text).toContain("interval_name");
    expect(calls[0]?.text).toContain("ON DUPLICATE KEY UPDATE");
    expect(calls[0]?.text).toContain("provider = VALUES(provider)");
    expect(calls[0]?.text).toContain("missing = VALUES(missing)");
    expect(calls[0]?.text).toContain("evidence = VALUES(evidence)");
    expect(calls[0]?.values).toEqual([
      "HEIUSDT",
      "5m",
      0,
      "bitget",
      "LONG_BUILDUP_CANDIDATE",
      "LONG",
      "BITGET_CONFIRMED",
      "COMPLETE",
      0.5,
      0.1,
      JSON.stringify(["openInterest", "priceGap"]),
      JSON.stringify(["provider=bitget", "openInterest missing"]),
      null,
      0,
      null,
      0.02,
      null,
      1.9,
      null,
      null,
      null,
      null,
      300_123,
    ]);
  });

  it("loads a stored Bitget factor and maps malformed JSON arrays to empty arrays without zero-filling missing numerics", async () => {
    const repository = new PostgresFuturesRepository({
      async query<Row extends Record<string, unknown>>() {
        return {
          rows: [
            {
              symbol: "HEIUSDT",
              interval: "5m",
              candle_open_time: 0,
              provider: "bitget",
              signal_type: "LONG_BUILDUP_CANDIDATE",
              signal_bias: "LONG",
              status: "BITGET_INCOMPLETE",
              completeness: "PARTIAL",
              score: 0.05,
              confidence_adjustment: 0,
              missing: "{not-json",
              evidence: 42,
              aligned_spot_open_time: null,
              aligned_futures_open_time: 0,
              spot_price_return: null,
              futures_price_return: -0.01,
              spot_quote_volume_ratio: null,
              futures_quote_volume_ratio: 1.1,
              oi_delta: null,
              funding_rate: null,
              basis: null,
              price_gap: null,
              observed_at: 300_123,
            },
          ] as unknown as Row[],
        };
      },
    }) as PostgresFuturesRepository & {
      getBitgetReference(symbol: string, interval: "5m" | "15m", candleOpenTime: number): Promise<BitgetReferenceFactor | undefined>;
    };

    const factor = await repository.getBitgetReference("HEIUSDT", "5m", 0);

    expect(factor).toEqual({
      provider: "bitget",
      symbol: "HEIUSDT",
      interval: "5m",
      candleOpenTime: 0,
      signalType: "LONG_BUILDUP_CANDIDATE",
      signalBias: "LONG",
      status: "BITGET_INCOMPLETE",
      completeness: "PARTIAL",
      score: 0.05,
      confidenceAdjustment: 0,
      missing: [],
      evidence: [],
      alignedSpotOpenTime: undefined,
      alignedFuturesOpenTime: 0,
      spotPriceReturn: undefined,
      futuresPriceReturn: -0.01,
      spotQuoteVolumeRatio: undefined,
      futuresQuoteVolumeRatio: 1.1,
      oiDelta: undefined,
      fundingRate: undefined,
      basis: undefined,
      priceGap: undefined,
      observedAt: 300_123,
    });
  });

  it("loads a stored Bitget factor from a raw MySQL-shaped row with interval_name", async () => {
    const repository = new PostgresFuturesRepository(
      new MysqlQueryable({
        async query() {
          return [
            [
              {
                symbol: "HEIUSDT",
                interval_name: "5m",
                candle_open_time: 0,
                provider: "bitget",
                signal_type: "LONG_BUILDUP_CANDIDATE",
                signal_bias: "LONG",
                status: "BITGET_CONFIRMED",
                completeness: "COMPLETE",
                score: 0.5,
                confidence_adjustment: 0.1,
                missing: JSON.stringify(["priceGap"]),
                evidence: JSON.stringify(["Bitget现货方向一致"]),
                aligned_spot_open_time: 0,
                aligned_futures_open_time: 0,
                spot_price_return: 0.015,
                futures_price_return: 0.02,
                spot_quote_volume_ratio: 1.7,
                futures_quote_volume_ratio: 1.9,
                oi_delta: 0.12,
                funding_rate: 0.0004,
                basis: 0.0012,
                price_gap: -0.0008,
                observed_at: 300_123,
              },
            ],
            [],
          ];
        },
      }),
    ) as PostgresFuturesRepository & {
      getBitgetReference(symbol: string, interval: "5m" | "15m", candleOpenTime: number): Promise<BitgetReferenceFactor | undefined>;
    };

    const factor = await repository.getBitgetReference("HEIUSDT", "5m", 0);

    expect(factor?.interval).toBe("5m");
    expect(factor?.missing).toEqual(["priceGap"]);
    expect(factor?.evidence).toEqual(["Bitget现货方向一致"]);
  });

  it("maps an optional Bitget factor onto radar rows without changing rows that do not have one", async () => {
    const repository = new PostgresFuturesRepository({
      async query<Row extends Record<string, unknown>>() {
        return {
          rows: [
            {
              symbol: "ALPHAUSDT",
              interval: "5m",
              candle_open_time: 600_000,
              signal_type: "LONG_BUILDUP_CANDIDATE",
              severity: "HIGH",
              confidence: 0.88,
              explanation: "alpha explanation",
              evidence: ["alpha"],
              threshold_version: "task-3-test",
              contract_only_risk_level: null,
              contract_only_risk_reason: null,
              is_contract_only: false,
              contract_only_reason: "SPOT_BASE_ASSET_PRESENT",
              data_completeness: "COMPLETE",
              price_return: 0.12,
              volume_ratio: 3.1,
              oi_value_delta: 0.21,
              taker_imbalance: 0.19,
              factor_provider: null,
              factor_signal_type: null,
              factor_signal_bias: null,
              factor_status: null,
              factor_completeness: null,
              factor_score: null,
              factor_confidence_adjustment: null,
              factor_missing: null,
              factor_evidence: null,
              factor_aligned_spot_open_time: null,
              factor_aligned_futures_open_time: null,
              factor_spot_price_return: null,
              factor_futures_price_return: null,
              factor_spot_quote_volume_ratio: null,
              factor_futures_quote_volume_ratio: null,
              factor_oi_delta: null,
              factor_funding_rate: null,
              factor_basis: null,
              factor_price_gap: null,
              factor_observed_at: null,
            },
            {
              symbol: "HEIUSDT",
              interval: "5m",
              candle_open_time: 0,
              signal_type: "LONG_BUILDUP_CANDIDATE",
              severity: "HIGH",
              confidence: 0.81,
              explanation: "hei explanation",
              evidence: ["hei"],
              threshold_version: "task-3-test",
              contract_only_risk_level: "HIGH",
              contract_only_risk_reason: "NO_ACTIVE_SPOT_BASE_ASSET",
              is_contract_only: true,
              contract_only_reason: "NO_ACTIVE_SPOT_BASE_ASSET",
              data_completeness: "COMPLETE",
              price_return: 0.08,
              volume_ratio: 2.4,
              oi_value_delta: 0.2,
              taker_imbalance: 0.18,
              factor_provider: "bitget",
              factor_signal_type: "LONG_BUILDUP_CANDIDATE",
              factor_signal_bias: "LONG",
              factor_status: "BITGET_CONFIRMED",
              factor_completeness: "COMPLETE",
              factor_score: 0.5,
              factor_confidence_adjustment: 0.1,
              factor_missing: ["priceGap"],
              factor_evidence: ["Bitget现货方向一致"],
              factor_aligned_spot_open_time: 0,
              factor_aligned_futures_open_time: 0,
              factor_spot_price_return: 0.015,
              factor_futures_price_return: 0.02,
              factor_spot_quote_volume_ratio: 1.7,
              factor_futures_quote_volume_ratio: 1.9,
              factor_oi_delta: 0.12,
              factor_funding_rate: 0.0004,
              factor_basis: 0.0012,
              factor_price_gap: -0.0008,
              factor_observed_at: 300_123,
            },
          ] as unknown as Row[],
        };
      },
    });

    const rows = await repository.listRadar({ limit: 10 });

    expect((rows[0] as any).bitgetReference).toBeUndefined();
    expect((rows[1] as any).bitgetReference).toEqual(
      expect.objectContaining({
        provider: "bitget",
        symbol: "HEIUSDT",
        interval: "5m",
        candleOpenTime: 0,
        missing: ["priceGap"],
        evidence: ["Bitget现货方向一致"],
      }),
    );
  });
});

describe("InMemoryFuturesRepository Bitget reference persistence", () => {
  it("stores factors by composite key, returns cloned objects, and leaves radar rows without factors unchanged", async () => {
    const repository = new InMemoryFuturesRepository() as InMemoryFuturesRepository & {
      saveBitgetReference(factor: BitgetReferenceFactor): Promise<void>;
      getBitgetReference(symbol: string, interval: "5m" | "15m", candleOpenTime: number): Promise<BitgetReferenceFactor | undefined>;
    };

    await repository.saveSignal(createSignal({ symbol: "ALPHAUSDT", candleOpenTime: 600_000, explanation: "alpha" }));
    await repository.saveMarketContext(createMarketContext({ symbol: "ALPHAUSDT", candleOpenTime: 600_000 }));
    await repository.saveMetrics(createMetrics({ symbol: "ALPHAUSDT", candleOpenTime: 600_000 }));

    await repository.saveSignal(createSignal());
    await repository.saveMarketContext(createMarketContext());
    await repository.saveMetrics(createMetrics());
    await repository.saveBitgetReference(createBitgetReference());

    const loaded = await repository.getBitgetReference("HEIUSDT", "5m", 0);
    loaded?.missing.slice();
    const loadedMutable = loaded as BitgetReferenceFactor | undefined;
    if (loadedMutable) {
      (loadedMutable.missing as string[]).push("priceGap");
      (loadedMutable.evidence as string[]).push("mutated");
    }

    const reloaded = await repository.getBitgetReference("HEIUSDT", "5m", 0);
    const rows = await repository.listRadar({ limit: 10 });

    expect(reloaded?.missing).toEqual([]);
    expect(reloaded?.evidence).toEqual(["Bitget现货方向一致", "Bitget合约持仓变化一致"]);
    expect((rows.find((row) => row.symbol === "ALPHAUSDT") as any)?.bitgetReference).toBeUndefined();
    expect((rows.find((row) => row.symbol === "HEIUSDT") as any)?.bitgetReference).toEqual(
      expect.objectContaining({
        provider: "bitget",
        symbol: "HEIUSDT",
        interval: "5m",
        candleOpenTime: 0,
      }),
    );
  });
});
