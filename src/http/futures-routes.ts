import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { HealthState } from "./app";
import type { FuturesRepository } from "../storage/futures-repository";
import type { BitgetReferenceFactor } from "../domain/bitget-reference";
import type { FuturesOiLeaderboardRow } from "../domain/futures";
import type { FuturesRadarRow } from "../storage/futures-repository";
import type { ExecutionSettingsService } from "../services/execution-settings-service";

const intervalSchema = z.enum(["5m", "15m"]);
const severitySchema = z.enum(["INFO", "WARNING", "HIGH"]);
const MAX_QUERY_LIMIT = 100;

const booleanQuerySchema = z.preprocess((value) => {
  if (value === undefined) {
    return undefined;
  }

  if (value === "true" || value === true) {
    return true;
  }

  if (value === "false" || value === false) {
    return false;
  }

  return value;
}, z.boolean().optional());

const integerQuerySchema = (defaultValue: number) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return defaultValue;
    }

    return Number(value);
  }, z.number().int().positive().max(MAX_QUERY_LIMIT, `limit must be less than or equal to ${MAX_QUERY_LIMIT}`));

const timestampQuerySchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return Number(value);
}, z.number().int().nonnegative().optional());

const radarQuerySchema = z.object({
  interval: intervalSchema.optional(),
  contractOnly: booleanQuerySchema,
  minSeverity: severitySchema.optional(),
  limit: integerQuerySchema(20),
});

const oiLeaderboardQuerySchema = z.object({
  interval: intervalSchema.default("5m"),
  limit: integerQuerySchema(20),
  scoreType: z.enum(["launch", "ambush"]).default("launch"),
});

const signalsQuerySchema = z.object({
  symbol: z.string().min(1).optional(),
  interval: intervalSchema.optional(),
  from: timestampQuerySchema,
  to: timestampQuerySchema,
  limit: integerQuerySchema(20),
}).superRefine((value, ctx) => {
  if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["from"],
      message: "from must be less than or equal to to",
    });
  }
});

function sendValidationError(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: "INVALID_QUERY",
    message: error.issues[0]?.message ?? "Invalid query",
  });
}

function serializeBitgetReference(factor: BitgetReferenceFactor) {
  return {
    status: factor.status,
    completeness: factor.completeness,
    factorScore: factor.score,
    confidenceAdjustment: factor.confidenceAdjustment,
    spotPriceReturn: factor.spotPriceReturn,
    futuresPriceReturn: factor.futuresPriceReturn,
    spotQuoteVolumeRatio: factor.spotQuoteVolumeRatio,
    futuresQuoteVolumeRatio: factor.futuresQuoteVolumeRatio,
    oiDelta: factor.oiDelta,
    fundingRate: factor.fundingRate,
    basis: factor.basis,
    priceGap: factor.priceGap,
    missing: [...factor.missing],
    evidence: [...factor.evidence],
  };
}

function serializeRadarRow(row: FuturesRadarRow) {
  return {
    symbol: row.symbol,
    interval: row.interval,
    signalType: row.signalType,
    severity: row.severity,
    confidence: row.confidence,
    explanation: row.explanation,
    evidence: [...row.evidence],
    thresholdVersion: row.thresholdVersion,
    candleOpenTime: row.candleOpenTime,
    isContractOnly: row.isContractOnly,
    contractOnlyReason: row.contractOnlyReason,
    dataCompleteness: row.dataCompleteness,
    priceReturn: row.priceReturn,
    volumeRatio: row.volumeRatio,
    oiValueDelta: row.oiValueDelta,
    takerImbalance: row.takerImbalance,
    contractOnlyRisk: row.contractOnlyRisk ? { ...row.contractOnlyRisk } : undefined,
    bitgetReference: row.bitgetReference ? serializeBitgetReference(row.bitgetReference) : undefined,
  };
}

function serializeOiLeaderboardRow(row: FuturesOiLeaderboardRow) {
  return {
    rank: row.rank,
    symbol: row.symbol,
    interval: row.interval,
    candleOpenTime: row.candleOpenTime,
    isContractOnly: row.isContractOnly,
    contractOnlyReason: row.contractOnlyReason,
    dataCompleteness: row.dataCompleteness,
    priceReturn: row.priceReturn,
    priceReturn5m: row.priceReturn5m,
    volumeRatio: row.volumeRatio,
    oiValueDelta: row.oiValueDelta,
    oiUnitDelta: row.oiUnitDelta,
    takerImbalance: row.takerImbalance,
    priceOiAlignment: row.priceOiAlignment,
    anomalyScore: row.anomalyScore,
    ambushScore: row.ambushScore,
    marketCapM: row.marketCapM,
    factors: row.factors.map((factor) => ({ ...factor })),
    signals: row.signals.map((signal) => ({
      signalType: signal.signalType,
      severity: signal.severity,
      confidence: signal.confidence,
      explanation: signal.explanation,
      evidence: [...signal.evidence],
      thresholdVersion: signal.thresholdVersion,
      candleOpenTime: signal.candleOpenTime,
    })),
  };
}

export function registerFuturesRoutes(
  app: FastifyInstance,
  deps: {
    repository: FuturesRepository;
    health: HealthState;
    settingsService?: ExecutionSettingsService;
    /** 后台主动刷新：universe（交易所信息）+ Alpha 板块（可选项） */
    refreshHandlers?: {
      refreshUniverse: () => Promise<void>;
      refreshAlpha?: () => Promise<void>;
    };
  },
) {
  app.get("/api/futures/radar", async (request, reply) => {
    const parsed = radarQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error);
    }

    const items = (await deps.repository.listRadar(parsed.data)).map(serializeRadarRow);
    return { items };
  });

  app.get("/api/futures/oi-leaderboard", async (request, reply) => {
    const parsed = oiLeaderboardQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error);
    }

    // 埋伏段只展示市值不超过配置上限的合约；启动段不过滤。
    const settings = await deps.settingsService?.get();
    const maxMarketCapM =
      parsed.data.scoreType === "ambush" ? settings?.ambush?.maxMarketCapM : undefined;

    const items = (
      await deps.repository.listOiLeaderboard({ ...parsed.data, maxMarketCapM })
    ).map(serializeOiLeaderboardRow);
    return {
      interval: parsed.data.interval,
      scoreType: parsed.data.scoreType,
      items,
      generatedAt: Date.now(),
    };
  });

  /**
   * 可开单候选：当前满足开单条件的合约。
   * - scoreType=launch：仅 STANDARD（OI 爆发放量确认）
   * - scoreType=ambush：仅 AMBUSH（低位 + 空头燃料堆积 + 市值上限内）
   */
  app.get("/api/futures/openable", async (request, reply) => {
    const parsed = oiLeaderboardQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error);
    }

    const settings = await deps.settingsService?.get();
    if (!settings) {
      return reply.code(503).send({
        error: "SETTINGS_UNAVAILABLE",
        message: "执行设置不可用，无法计算可开单条件",
        items: [],
      });
    }

    const rows = await deps.repository.listOiLeaderboard({
      ...parsed.data,
      limit: Math.max(parsed.data.limit ?? 50, 50),
    });
    const items: Array<{
      symbol: string;
      marketCapM?: number;
      anomalyScore: number;
      ambushScore?: number;
      mode: "STANDARD" | "AMBUSH";
      dataCompleteness: string;
      reasons: string[];
    }> = [];

    for (const row of rows) {
      const reasons: string[] = [];
      let mode: "STANDARD" | "AMBUSH" | undefined;

      // 启动段只展示 STANDARD 候选，埋伏段只展示 AMBUSH 候选。
      if (parsed.data.scoreType !== "ambush") {
        const hasDirectionalSignal = row.signals.some((signal) => signal.signalType === "LONG_BUILDUP_CANDIDATE");
        if (hasDirectionalSignal && row.oiValueDelta >= settings.minOiBurstDelta && row.breakoutContext !== "HIGH_POSITION_RISK") {
          mode = "STANDARD";
          reasons.push(`放量增仓信号 · OI 爆发 ${(row.oiValueDelta * 100).toFixed(1)}% ≥ ${(settings.minOiBurstDelta * 100).toFixed(0)}%`);
        }
      }

      if (parsed.data.scoreType !== "launch") {
        const shortFuelScore = row.factors.find((factor) => factor.code === "SHORT_FUEL")?.value ?? 0;
        if (
          row.breakoutContext === "LOW_POSITION_BREAKOUT" &&
          shortFuelScore >= settings.ambush.minShortFuelScore &&
          (row.ambushScore ?? 0) >= settings.ambush.minScore &&
          (row.marketCapM === undefined || row.marketCapM <= settings.ambush.maxMarketCapM) &&
          row.priceReturn >= -0.01
        ) {
          mode = "AMBUSH";
          reasons.push(
            `低位启动 · 空头燃料 ${shortFuelScore} ≥ ${settings.ambush.minShortFuelScore} · 埋伏评分 ${row.ambushScore ?? 0} ≥ ${settings.ambush.minScore} · 市值 ${row.marketCapM !== undefined ? `${row.marketCapM.toFixed(1)}M` : "?"} ≤ ${settings.ambush.maxMarketCapM}M`,
          );
        }
      }

      if (mode !== undefined) {
        items.push({
          symbol: row.symbol,
          marketCapM: row.marketCapM,
          anomalyScore: row.anomalyScore,
          ambushScore: row.ambushScore,
          mode,
          dataCompleteness: row.dataCompleteness,
          reasons,
        });
      }
    }

    return {
      interval: parsed.data.interval,
      scoreType: parsed.data.scoreType,
      items: items.slice(0, parsed.data.limit ?? 20),
      generatedAt: Date.now(),
    };
  });

  /**
   * 后台主动刷新：电脑睡眠/断线恢复后，点击刷新即可强制重拉交易所信息与
   * Alpha 板块，让 universe、市值与数据完整性尽快对齐当前时间。
   */
  app.post("/api/futures/refresh", async (_request, reply) => {
    if (!deps.refreshHandlers) {
      return reply.code(503).send({
        error: "REFRESH_UNAVAILABLE",
        message: "后台刷新能力未配置",
      });
    }

    const startedAt = Date.now();
    await Promise.all([
      deps.refreshHandlers.refreshUniverse().catch(() => undefined),
      deps.refreshHandlers.refreshAlpha?.().catch(() => undefined),
    ]);
    return {
      refreshed: true,
      at: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  });

  app.get("/api/futures/signals", async (request, reply) => {
    const parsed = signalsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error);
    }

    const items = await deps.repository.listSignals({
      ...parsed.data,
      symbol: parsed.data.symbol?.toUpperCase(),
    });

    return { items };
  });
}
