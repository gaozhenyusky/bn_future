import { describe, expect, it } from "vitest";
import type { BitgetReferenceFactor } from "../src/domain/bitget-reference";
import type { FuturesMetrics, FuturesOiLeaderboardRow, FuturesSignal, MarketContext } from "../src/domain/futures";
import { InMemoryFuturesRepository } from "../src/storage/in-memory-futures-repository";
import type { FuturesRepository } from "../src/storage/futures-repository";
import { buildApp, type HealthState } from "../src/http/app";
import { InMemoryExecutionSettingsRepository } from "../src/storage/execution-settings-repository";
import { ExecutionSettingsService } from "../src/services/execution-settings-service";

type RadarRow = {
  symbol: string;
  interval: "5m" | "15m";
  signalType: string;
  severity: "INFO" | "WARNING" | "HIGH";
  confidence: number;
  explanation: string;
  evidence: string[];
  thresholdVersion: string;
  candleOpenTime: number;
  isContractOnly: boolean;
  contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET" | "SPOT_BASE_ASSET_PRESENT";
  dataCompleteness: "COMPLETE" | "INCOMPLETE_CONTEXT" | "INSUFFICIENT_BASELINE";
  priceReturn: number;
  volumeRatio: number;
  oiValueDelta: number;
  takerImbalance: number;
};

function createRepository(options?: {
  radarRows?: RadarRow[];
  signals?: Array<{
    symbol: string;
    interval: "5m" | "15m";
    signalType: string;
    severity: "INFO" | "WARNING" | "HIGH";
    confidence: number;
    explanation: string;
    evidence: string[];
    thresholdVersion: string;
    candleOpenTime: number;
  }>;
  leaderboardRows?: FuturesOiLeaderboardRow[];
}): FuturesRepository {
  const severityRank = {
    HIGH: 0,
    WARNING: 1,
    INFO: 2,
  } as const;

  return {
    upsertContracts: async () => undefined,
    updateMarketCaps: async () => undefined,
    getClosedCandleBaseline: async () => [],
    saveCandle: async () => undefined,
    saveMarketContext: async () => undefined,
    saveMetrics: async () => undefined,
    saveSignal: async () => undefined,
    saveSignalIfNew: async () => true,
    saveBitgetReference: async (_factor: BitgetReferenceFactor) => undefined,
    getBitgetReference: async () => undefined,
    saveSourceEvent: async () => undefined,
    getCheckpoint: async () => null,
    setCheckpoint: async () => undefined,
    listOiLeaderboard: async () => options?.leaderboardRows ?? [],
    listRadar: async (query) =>
      (options?.radarRows ?? [])
        .filter((row) => (query.interval ? row.interval === query.interval : true))
        .filter((row) => (query.contractOnly === undefined ? true : row.isContractOnly === query.contractOnly))
        .filter((row) => {
          if (query.minSeverity === "HIGH") {
            return row.severity === "HIGH";
          }

          if (query.minSeverity === "WARNING") {
            return row.severity === "HIGH" || row.severity === "WARNING";
          }

          return true;
        })
        .sort((left, right) => {
          const severityOrder = severityRank[left.severity] - severityRank[right.severity];
          if (severityOrder !== 0) {
            return severityOrder;
          }

          return right.candleOpenTime - left.candleOpenTime;
        })
        .slice(0, query.limit),
    listSignals: async (query) =>
      (options?.signals ?? [])
        .filter((signal) => (query.symbol ? signal.symbol === query.symbol : true))
        .filter((signal) => (query.interval ? signal.interval === query.interval : true))
        .filter((signal) => (query.from !== undefined ? signal.candleOpenTime >= query.from : true))
        .filter((signal) => (query.to !== undefined ? signal.candleOpenTime <= query.to : true))
        .slice(0, query.limit),
  } as FuturesRepository;
}

function createHealthState(overrides?: Partial<HealthState>): HealthState {
  return {
    connectors: {
      futuresStream: {
        status: "connected",
      },
      ...overrides?.connectors,
    },
  };
}

function createSignal(overrides?: Partial<FuturesSignal>): FuturesSignal {
  return {
    symbol: "HEIUSDT",
    interval: "5m",
    signalType: "LONG_BUILDUP_CANDIDATE",
    severity: "HIGH",
    confidence: 0.81,
    explanation: "price rose while open interest expanded on elevated volume",
    evidence: [
      "priceReturn=8.00%",
      "volumeRatio=2.40",
      "oiValueDelta=11.00%",
      "takerImbalance=18.00%",
      "dataCompleteness=COMPLETE",
      "contractOnlyReason=NO_ACTIVE_SPOT_BASE_ASSET",
    ],
    thresholdVersion: "task-7-thresholds",
    candleOpenTime: 1_720_000_000_000,
    contractOnlyRisk: {
      level: "HIGH",
      reason: "NO_ACTIVE_SPOT_BASE_ASSET",
    },
    ...overrides,
  };
}

function createMarketContext(overrides?: Partial<MarketContext>): MarketContext {
  return {
    symbol: "HEIUSDT",
    interval: "5m",
    candleOpenTime: 1_720_000_000_000,
    candleCloseTime: 1_720_000_300_000,
    sourceTimestamp: 1_720_000_300_000,
    receivedTimestamp: 1_720_000_300_123,
    isContractOnly: true,
    contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
    spotBaseAssetMatches: [],
    isComplete: true,
    missing: [],
    ...overrides,
  };
}

function createMetrics(overrides?: Partial<FuturesMetrics>): FuturesMetrics {
  return {
    symbol: "HEIUSDT",
    interval: "5m",
    candleOpenTime: 1_720_000_000_000,
    candleCloseTime: 1_720_000_300_000,
    volumeRatio: 2.4,
    volumePercentile: 0.95,
    oiValueDelta: 0.11,
    oiUnitDelta: 0.09,
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
    candleOpenTime: 1_720_000_000_000,
    signalType: "LONG_BUILDUP_CANDIDATE",
    signalBias: "LONG",
    status: "BITGET_CONFIRMED",
    completeness: "COMPLETE",
    score: 0.82,
    confidenceAdjustment: 0.08,
    missing: [],
    evidence: ["Bitget 现货与合约同向", "持仓增幅与 Binance 信号一致"],
    alignedSpotOpenTime: 1_720_000_000_000,
    alignedFuturesOpenTime: 1_720_000_000_000,
    spotPriceReturn: 0.034,
    futuresPriceReturn: 0.037,
    spotQuoteVolumeRatio: 1.4,
    futuresQuoteVolumeRatio: 1.7,
    oiDelta: 0.12,
    fundingRate: 0.0004,
    basis: 0.0012,
    priceGap: -0.0008,
    observedAt: 1_720_000_300_123,
    ...overrides,
  };
}

async function seedRadarRecord(
  repository: InMemoryFuturesRepository,
  options: {
    symbol: string;
    interval: "5m" | "15m";
    severity: "INFO" | "WARNING" | "HIGH";
    signalType: FuturesSignal["signalType"];
    candleOpenTime: number;
    thresholdVersion?: string;
    isContractOnly: boolean;
    contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET" | "SPOT_BASE_ASSET_PRESENT";
    dataCompleteness: "COMPLETE" | "INCOMPLETE_CONTEXT" | "INSUFFICIENT_BASELINE";
    priceReturn: number;
    volumeRatio: number;
    oiValueDelta: number;
    takerImbalance: number;
  },
) {
  await repository.upsertContracts([{
    symbol: options.symbol,
    pair: options.symbol,
    baseAsset: options.symbol.replace("USDT", ""),
    quoteAsset: "USDT",
    contractType: "PERPETUAL",
    status: "TRADING",
    onboardDate: 1,
    filters: [],
    isContractOnly: options.isContractOnly,
    spotBaseAssetMatches: options.isContractOnly ? [] : [options.symbol.replace("USDT", "")],
    contractOnlyReason: options.contractOnlyReason,
  }]);

  await repository.saveMarketContext(
    createMarketContext({
      symbol: options.symbol,
      interval: options.interval,
      candleOpenTime: options.candleOpenTime,
      candleCloseTime: options.candleOpenTime + 300_000,
      sourceTimestamp: options.candleOpenTime + 300_000,
      receivedTimestamp: options.candleOpenTime + 300_123,
      isContractOnly: options.isContractOnly,
      contractOnlyReason: options.contractOnlyReason,
      spotBaseAssetMatches: options.isContractOnly ? [] : [options.symbol.replace("USDT", "")],
      isComplete: options.dataCompleteness === "COMPLETE",
      missing: options.dataCompleteness === "COMPLETE" ? [] : ["openInterest"],
    }),
  );

  await repository.saveMetrics(
    createMetrics({
      symbol: options.symbol,
      interval: options.interval,
      candleOpenTime: options.candleOpenTime,
      candleCloseTime: options.candleOpenTime + 300_000,
      dataCompleteness: options.dataCompleteness,
      priceReturn: options.priceReturn,
      volumeRatio: options.volumeRatio,
      oiValueDelta: options.oiValueDelta,
      takerImbalance: options.takerImbalance,
      contractOnlyRisk: {
        level: options.isContractOnly ? "HIGH" : "LOW",
        reason: options.contractOnlyReason,
      },
    }),
  );

  await repository.saveSignal(
    createSignal({
      symbol: options.symbol,
      interval: options.interval,
      signalType: options.signalType,
      severity: options.severity,
      candleOpenTime: options.candleOpenTime,
      thresholdVersion: options.thresholdVersion ?? "task-7-thresholds",
      evidence: [
        `priceReturn=${(options.priceReturn * 100).toFixed(2)}%`,
        `volumeRatio=${options.volumeRatio.toFixed(2)}`,
        `oiValueDelta=${(options.oiValueDelta * 100).toFixed(2)}%`,
        `takerImbalance=${(options.takerImbalance * 100).toFixed(2)}%`,
        `dataCompleteness=${options.dataCompleteness}`,
        `contractOnlyReason=${options.contractOnlyReason}`,
      ],
      contractOnlyRisk: options.isContractOnly
        ? {
            level: "HIGH",
            reason: options.contractOnlyReason,
          }
        : undefined,
    }),
  );
}

describe("buildApp", () => {
  it("returns degraded health when the futures stream is disconnected", async () => {
    const app = buildApp({
      repository: createRepository(),
      health: createHealthState({
        connectors: {
          futuresStream: {
            status: "disconnected",
          },
        },
      }),
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "degraded",
        connectors: {
          futuresStream: {
            status: "disconnected",
          },
        },
      });
    } finally {
      await app.close();
    }
  });

  it("rejects unsupported intervals, negative limits, and oversized limits for radar queries", async () => {
    const app = buildApp({
      repository: createRepository(),
      health: createHealthState(),
    });
    try {
      const badIntervalResponse = await app.inject({
        method: "GET",
        url: "/api/futures/radar?interval=1h",
      });
      const badLimitResponse = await app.inject({
        method: "GET",
        url: "/api/futures/radar?limit=-1",
      });
      const hugeLimitResponse = await app.inject({
        method: "GET",
        url: "/api/futures/radar?limit=999999",
      });

      expect(badIntervalResponse.statusCode).toBe(400);
      expect(badLimitResponse.statusCode).toBe(400);
      expect(hugeLimitResponse.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("returns contract-only radar rows in stable severity order from the repository-backed read model", async () => {
    const repository = new InMemoryFuturesRepository();
    await seedRadarRecord(repository, {
      symbol: "HEIUSDT",
      interval: "5m",
      signalType: "CONTRACT_ONLY_RISK",
      severity: "WARNING",
      candleOpenTime: 1_000,
      isContractOnly: true,
      contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
      dataCompleteness: "INCOMPLETE_CONTEXT",
      priceReturn: 0.01,
      volumeRatio: 1.3,
      oiValueDelta: 0.04,
      takerImbalance: 0.03,
    });
    await seedRadarRecord(repository, {
      symbol: "BANKUSDT",
      interval: "5m",
      signalType: "LONG_BUILDUP_CANDIDATE",
      severity: "HIGH",
      candleOpenTime: 2_000,
      isContractOnly: false,
      contractOnlyReason: "SPOT_BASE_ASSET_PRESENT",
      dataCompleteness: "COMPLETE",
      priceReturn: 0.08,
      volumeRatio: 2.2,
      oiValueDelta: 0.13,
      takerImbalance: 0.19,
    });
    await seedRadarRecord(repository, {
      symbol: "MOONUSDT",
      interval: "15m",
      signalType: "SHORT_BUILDUP_CANDIDATE",
      severity: "HIGH",
      candleOpenTime: 3_000,
      isContractOnly: true,
      contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
      dataCompleteness: "COMPLETE",
      priceReturn: -0.05,
      volumeRatio: 2.9,
      oiValueDelta: 0.16,
      takerImbalance: -0.21,
    });
    await seedRadarRecord(repository, {
      symbol: "NOISEUSDT",
      interval: "5m",
      signalType: "TURNOVER_ONLY",
      severity: "INFO",
      candleOpenTime: 4_000,
      isContractOnly: true,
      contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
      dataCompleteness: "COMPLETE",
      priceReturn: 0.02,
      volumeRatio: 1.4,
      oiValueDelta: 0.01,
      takerImbalance: 0.01,
    });

    const app = buildApp({
      repository,
      health: createHealthState(),
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/futures/radar?contractOnly=true&minSeverity=WARNING&limit=100",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        items: [
          expect.objectContaining({
            symbol: "MOONUSDT",
            severity: "HIGH",
            isContractOnly: true,
          }),
          expect.objectContaining({
            symbol: "HEIUSDT",
            severity: "WARNING",
            isContractOnly: true,
          }),
        ],
      });
      expect(response.json().items).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("serializes optional bitget reference factors on radar rows without adding empty objects", async () => {
    const repository = new InMemoryFuturesRepository();
    await seedRadarRecord(repository, {
      symbol: "HEIUSDT",
      interval: "5m",
      signalType: "LONG_BUILDUP_CANDIDATE",
      severity: "HIGH",
      candleOpenTime: 10_000,
      isContractOnly: true,
      contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
      dataCompleteness: "COMPLETE",
      priceReturn: 0.08,
      volumeRatio: 2.2,
      oiValueDelta: 0.13,
      takerImbalance: 0.19,
    });
    await repository.saveBitgetReference(
      createBitgetReference({
        symbol: "HEIUSDT",
        interval: "5m",
        candleOpenTime: 10_000,
        status: "BITGET_CONFIRMED",
        completeness: "COMPLETE",
        score: 0.76,
        confidenceAdjustment: 0.06,
        spotPriceReturn: 0.041,
        futuresPriceReturn: 0.039,
        oiDelta: 0.14,
        fundingRate: 0.0005,
        basis: 0.0011,
        missing: ["priceGap"],
        evidence: ["Bitget 参考确认上涨方向"],
      }),
    );

    await seedRadarRecord(repository, {
      symbol: "ALPHAUSDT",
      interval: "5m",
      signalType: "TURNOVER_ONLY",
      severity: "INFO",
      candleOpenTime: 9_000,
      isContractOnly: true,
      contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
      dataCompleteness: "INCOMPLETE_CONTEXT",
      priceReturn: 0.01,
      volumeRatio: 1.4,
      oiValueDelta: 0.01,
      takerImbalance: 0.02,
    });

    const app = buildApp({
      repository,
      health: createHealthState(),
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/futures/radar?interval=5m&contractOnly=true&limit=10",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        items: [
          expect.objectContaining({
            symbol: "HEIUSDT",
            bitgetReference: {
              status: "BITGET_CONFIRMED",
              completeness: "COMPLETE",
              factorScore: 0.76,
              confidenceAdjustment: 0.06,
              spotPriceReturn: 0.041,
              futuresPriceReturn: 0.039,
              spotQuoteVolumeRatio: 1.4,
              futuresQuoteVolumeRatio: 1.7,
              oiDelta: 0.14,
              fundingRate: 0.0005,
              basis: 0.0011,
              priceGap: -0.0008,
              missing: ["priceGap"],
              evidence: ["Bitget 参考确认上涨方向"],
            },
          }),
          expect.objectContaining({
            symbol: "ALPHAUSDT",
          }),
        ],
      });
      expect(response.json().items[1].bitgetReference).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("rejects oversized limits and inverted time bounds for signals queries", async () => {
    const app = buildApp({
      repository: createRepository(),
      health: createHealthState(),
    });
    try {
      const hugeLimitResponse = await app.inject({
        method: "GET",
        url: "/api/futures/signals?limit=999999",
      });
      const invertedBoundsResponse = await app.inject({
        method: "GET",
        url: "/api/futures/signals?from=200&to=100",
      });

      expect(hugeLimitResponse.statusCode).toBe(400);
      expect(invertedBoundsResponse.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("returns signal evidence and threshold versions from repository-backed filtering", async () => {
    const repository = new InMemoryFuturesRepository();
    await repository.saveSignal(
      createSignal({
        symbol: "HEIUSDT",
        interval: "5m",
        thresholdVersion: "task-7-thresholds-old",
        candleOpenTime: 1_000,
      }),
    );
    await repository.saveSignal(
      createSignal({
        symbol: "HEIUSDT",
        interval: "5m",
        thresholdVersion: "task-7-thresholds",
        candleOpenTime: 2_000,
      }),
    );
    await repository.saveSignal(
      createSignal({
        symbol: "HEIUSDT",
        interval: "15m",
        thresholdVersion: "task-7-thresholds-15m",
        candleOpenTime: 2_500,
      }),
    );
    await repository.saveSignal(
      createSignal({
        symbol: "BANKUSDT",
        interval: "5m",
        thresholdVersion: "task-7-thresholds-bank",
        candleOpenTime: 2_200,
      }),
    );

    const app = buildApp({
      repository,
      health: createHealthState(),
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/futures/signals?symbol=HEIUSDT&interval=5m&from=1500&to=2500&limit=100",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        items: [
          expect.objectContaining({
            symbol: "HEIUSDT",
            evidence: expect.arrayContaining(["priceReturn=8.00%", "oiValueDelta=11.00%"]),
            thresholdVersion: "task-7-thresholds",
          }),
        ],
      });
      expect(response.json().items).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("serializes bitget reference health states on the health endpoint", async () => {
    const degradedApp = buildApp({
      repository: createRepository(),
      health: {
        connectors: {
          futuresStream: {
            status: "connected",
          },
          bitgetReference: {
            status: "degraded",
            message: "Bitget returned partial data",
            updatedAt: 123,
          },
        },
      },
    });

    const disconnectedApp = buildApp({
      repository: createRepository(),
      health: {
        connectors: {
          futuresStream: {
            status: "connected",
          },
          bitgetReference: {
            status: "disconnected",
            message: "Bitget reference unavailable",
            updatedAt: 456,
          },
        },
      },
    });

    try {
      const degradedResponse = await degradedApp.inject({
        method: "GET",
        url: "/health",
      });
      const disconnectedResponse = await disconnectedApp.inject({
        method: "GET",
        url: "/health",
      });

      expect(degradedResponse.statusCode).toBe(200);
      expect(degradedResponse.json()).toEqual({
        status: "degraded",
        connectors: {
          futuresStream: {
            status: "connected",
          },
          bitgetReference: {
            status: "degraded",
            message: "Bitget returned partial data",
            updatedAt: 123,
          },
        },
      });

      expect(disconnectedResponse.statusCode).toBe(200);
      expect(disconnectedResponse.json()).toEqual({
        status: "degraded",
        connectors: {
          futuresStream: {
            status: "connected",
          },
          bitgetReference: {
            status: "disconnected",
            message: "Bitget reference unavailable",
            updatedAt: 456,
          },
        },
      });
    } finally {
      await degradedApp.close();
      await disconnectedApp.close();
    }
  });

  it("returns the latest contract-only OI leaderboard with triggered factors", async () => {
    const repository = new InMemoryFuturesRepository();
    await seedRadarRecord(repository, {
      symbol: "HEIUSDT",
      interval: "5m",
      signalType: "LONG_BUILDUP_CANDIDATE",
      severity: "HIGH",
      candleOpenTime: 10_000,
      isContractOnly: true,
      contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
      dataCompleteness: "COMPLETE",
      priceReturn: 0.08,
      volumeRatio: 2.4,
      oiValueDelta: 0.11,
      takerImbalance: 0.18,
    });
    await seedRadarRecord(repository, {
      symbol: "BANKUSDT",
      interval: "5m",
      signalType: "SHORT_BUILDUP_CANDIDATE",
      severity: "HIGH",
      candleOpenTime: 11_000,
      isContractOnly: true,
      contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
      dataCompleteness: "INCOMPLETE_CONTEXT",
      priceReturn: -0.03,
      volumeRatio: 1.2,
      oiValueDelta: -0.06,
      takerImbalance: 0,
    });

    const app = buildApp({ repository, health: createHealthState() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/futures/oi-leaderboard?interval=5m&limit=10",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        interval: "5m",
        scoreType: "launch",
        generatedAt: expect.any(Number),
        items: [
          expect.objectContaining({
            rank: 1,
            symbol: "HEIUSDT",
            factors: expect.arrayContaining([
              expect.objectContaining({ code: "OI_THRESHOLD_BREAK", label: "OI 阈值突破" }),
              expect.objectContaining({ code: "VOLUME_EXPANSION", label: "成交量放大" }),
              expect.objectContaining({ code: "TAKER_CONFIRMATION", label: "主动买盘确认" }),
              expect.objectContaining({ code: "CONTRACT_ONLY_RISK", label: "仅合约风险" }),
            ]),
            signals: [expect.objectContaining({ signalType: "LONG_BUILDUP_CANDIDATE" })],
          }),
          expect.objectContaining({ rank: 2, symbol: "BANKUSDT" }),
        ],
      });
    } finally {
      await app.close();
    }
  });

  it("openable 接口返回 STANDARD 与 AMBUSH 可开单候选", async () => {
    const baseRow = {
      rank: 1,
      interval: "5m" as const,
      candleOpenTime: 1_700_000_000_000,
      isContractOnly: true,
      contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET" as const,
      dataCompleteness: "COMPLETE" as const,
      priceReturn: 0.03,
      priceReturn5m: 0.03,
      volumeRatio: 3,
      oiValueDelta: 0.08,
      oiUnitDelta: 0.08,
      takerImbalance: 0.06,
      priceOiAlignment: "PRICE_UP_OI_UP" as const,
      factors: [],
      signals: [],
    };
    const leaderboardRows: FuturesOiLeaderboardRow[] = [
      {
        ...baseRow,
        symbol: "AMBUSHUSDT",
        anomalyScore: 85,
        ambushScore: 60,
        marketCapM: 10,
        breakoutContext: "LOW_POSITION_BREAKOUT",
        positionPercentile: 0.3,
        factors: [{ code: "SHORT_FUEL", label: "空头燃料", severity: "HIGH", detail: "", value: 15 }],
      },
      {
        ...baseRow,
        symbol: "STANDARDUSDT",
        anomalyScore: 82,
        marketCapM: 100,
        breakoutContext: "NEUTRAL",
        signals: [{ symbol: "STANDARDUSDT", interval: "5m", signalType: "LONG_BUILDUP_CANDIDATE", severity: "WARNING", confidence: 0.7, explanation: "", evidence: [], thresholdVersion: "v1", candleOpenTime: 1_700_000_000_000 }],
      },
      {
        ...baseRow,
        symbol: "NOTREADYUSDT",
        anomalyScore: 40,
        breakoutContext: "LOW_POSITION_BREAKOUT",
        factors: [{ code: "SHORT_FUEL", label: "空头燃料", severity: "WARNING", detail: "", value: 5 }],
      },
    ];

    const app = buildApp({
      repository: createRepository({ leaderboardRows }),
      health: { connectors: {} },
      settingsService: new ExecutionSettingsService(new InMemoryExecutionSettingsRepository()),
    });

    try {
      // 埋伏段：只返回 AMBUSH 候选
      const ambushResponse = await app.inject({ method: "GET", url: "/api/futures/openable?interval=5m&scoreType=ambush" });
      expect(ambushResponse.statusCode).toBe(200);
      const ambushBody = ambushResponse.json();
      const ambushSymbols = ambushBody.items.map((item: { symbol: string }) => item.symbol);
      expect(ambushSymbols).toContain("AMBUSHUSDT");
      expect(ambushSymbols).not.toContain("STANDARDUSDT");
      expect(ambushSymbols).not.toContain("NOTREADYUSDT");
      const ambush = ambushBody.items.find((item: { symbol: string }) => item.symbol === "AMBUSHUSDT");
      expect(ambush.mode).toBe("AMBUSH");

      // 启动段：只返回 STANDARD 候选
      const launchResponse = await app.inject({ method: "GET", url: "/api/futures/openable?interval=5m&scoreType=launch" });
      const launchBody = launchResponse.json();
      const launchSymbols = launchBody.items.map((item: { symbol: string }) => item.symbol);
      expect(launchSymbols).toContain("STANDARDUSDT");
      expect(launchSymbols).not.toContain("AMBUSHUSDT");
      const standard = launchBody.items.find((item: { symbol: string }) => item.symbol === "STANDARDUSDT");
      expect(standard.mode).toBe("STANDARD");
    } finally {
      await app.close();
    }
  });
});
