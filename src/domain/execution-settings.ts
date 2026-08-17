import { z } from "zod";

export interface TakeProfitLevel {
  /** 触发涨幅（百分比，正数，如 8 表示 +8%） */
  pricePercent: number;
  /** 触发时平掉当前剩余仓位的比例（0 < closeRatio <= 1），末级必须为 1 */
  closeRatio: number;
}

/** 低位启动（长期横盘后放量增仓）的宽松持仓参数 */
export interface BreakoutHoldSettings {
  stopLossPercent: number;
  maxHoldMinutes: number;
  takeProfitLevels: TakeProfitLevel[];
}

/** 埋伏开单：低位 + 空头燃料堆积时直接开单（不等放量确认），等庄家拉盘 */
export interface AmbushSettings {
  enabled: boolean;
  /** 空头燃料最低分数（0-15） */
  minShortFuelScore: number;
  /** 埋伏开单的独立评分门槛（低位横盘币异动评分天然偏低，默认 15） */
  minScore: number;
  /** 埋伏市值上限（M USD）：超过该市值的币不做埋伏（庄家难控盘），默认 20M */
  maxMarketCapM: number;
}

export interface ExecutionSettings {
  /** 杠杆倍数 1-125 */
  leverage: number;
  /** 开仓金额（USDT）10-100000 */
  notionalUsdt: number;
  /** STANDARD 放量确认模式的 OI 爆发阈值（小数，如 0.05 = OI 变化 5%）；评分不再单独拦截开单 */
  minOiBurstDelta: number;
  /** 最大同时持仓数 1-20 */
  maxOpenPositions: number;
  /** 分级止盈，1-5 级，按 pricePercent 升序，末级 closeRatio 必须为 1 */
  takeProfitLevels: TakeProfitLevel[];
  /** 止损率（百分比，正数，如 8 表示 -8%）0-50 */
  stopLossPercent: number;
  /** 第一级止盈后止损上移至保本的幅度（百分比）0-10 */
  breakevenPercent: number;
  /** 时间兜底（分钟）：持仓超过该时长仍未触达第一级止盈则平仓；0 表示关闭 */
  maxHoldMinutes: number;
  /** 5m 价格-OI 结构反转退出开关 */
  reversalExitEnabled: boolean;
  /** 数据流恢复后自动解除熔断开关 */
  circuitBreakerAutoReset: boolean;
  /** 低位启动场景（LOW_POSITION_BREAKOUT）的宽松持仓参数 */
  breakoutHold: BreakoutHoldSettings;
  /** 埋伏开单模式 */
  ambush: AmbushSettings;
  updatedAt?: number;
}

/** 存储层白名单：读取 DB 时只保留这些键，过滤掉旧版本遗留字段 */
export const EXECUTION_SETTINGS_KEYS: readonly (keyof ExecutionSettings)[] = [
  "leverage",
  "notionalUsdt",
  "minOiBurstDelta",
  "maxOpenPositions",
  "takeProfitLevels",
  "stopLossPercent",
  "breakevenPercent",
  "maxHoldMinutes",
  "reversalExitEnabled",
  "circuitBreakerAutoReset",
  "breakoutHold",
  "ambush",
];

export const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = {  leverage: 5,
  notionalUsdt: 500,
  minOiBurstDelta: 0.05,
  maxOpenPositions: 3,
  takeProfitLevels: [
    { pricePercent: 8, closeRatio: 1 / 3 },
    { pricePercent: 15, closeRatio: 1 / 3 },
    { pricePercent: 25, closeRatio: 1 },
  ],
  stopLossPercent: 8,
  breakevenPercent: 0.1,
  maxHoldMinutes: 120,
  reversalExitEnabled: true,
  circuitBreakerAutoReset: true,
  breakoutHold: {
    stopLossPercent: 12,
    maxHoldMinutes: 720,
    takeProfitLevels: [
      { pricePercent: 30, closeRatio: 1 / 3 },
      { pricePercent: 60, closeRatio: 1 / 3 },
      { pricePercent: 120, closeRatio: 1 },
    ],
  },
  ambush: {
    enabled: true,
    minShortFuelScore: 10,
    minScore: 15,
    maxMarketCapM: 20,
  },
};

const takeProfitLevelSchema = z
  .object({
    pricePercent: z.number().positive("止盈涨幅必须大于 0"),
    closeRatio: z.number().gt(0, "平仓比例必须大于 0").lte(1, "平仓比例不能超过 1"),
  })
  .strict();

const ambushSchema = z
  .object({
    enabled: z.boolean(),
    minShortFuelScore: z.number().min(0, "空头燃料阈值最小 0").max(15, "空头燃料阈值最大 15"),
    minScore: z.number().min(0, "埋伏评分门槛最小 0").max(100, "埋伏评分门槛最大 100"),
    maxMarketCapM: z.number().min(1, "市值上限最小 1M").max(10_000, "市值上限最大 10000M"),
  })
  .strict();

const breakoutHoldSchema = z
  .object({
    stopLossPercent: z.number().min(0, "止损率最小 0").max(50, "止损率最大 50"),
    maxHoldMinutes: z.number().int().min(0, "时间兜底不能为负数").max(100_000, "时间兜底最大 100000 分钟"),
    takeProfitLevels: z
      .array(takeProfitLevelSchema)
      .min(1, "至少配置一级止盈")
      .max(5, "止盈级别最多 5 级")
      .refine((levels) => levels.every((level, index) => index === 0 || level.pricePercent > levels[index - 1].pricePercent), {
        message: "止盈级别必须按涨幅升序排列",
      })
      .refine((levels) => levels.length === 0 || levels[levels.length - 1].closeRatio === 1, {
        message: "最后一级止盈的平仓比例必须为 1",
      }),
  })
  .strict();

export const executionSettingsSchema = z
  .object({
    leverage: z.number().int().min(1, "杠杆倍数最小 1").max(125, "杠杆倍数最大 125"),
    notionalUsdt: z.number().min(10, "开仓金额最小 10").max(100_000, "开仓金额最大 100000"),
    minOiBurstDelta: z.number().min(0.01, "OI 爆发阈值最小 1%").max(0.5, "OI 爆发阈值最大 50%"),
    maxOpenPositions: z.number().int().min(1, "最大持仓数最小 1").max(20, "最大持仓数最大 20"),
    takeProfitLevels: z
      .array(takeProfitLevelSchema)
      .min(1, "至少配置一级止盈")
      .max(5, "止盈级别最多 5 级")
      .refine((levels) => levels.every((level, index) => index === 0 || level.pricePercent > levels[index - 1].pricePercent), {
        message: "止盈级别必须按涨幅升序排列",
      })
      .refine((levels) => levels.length === 0 || levels[levels.length - 1].closeRatio === 1, {
        message: "最后一级止盈的平仓比例必须为 1",
      }),
    stopLossPercent: z.number().min(0, "止损率最小 0").max(50, "止损率最大 50"),
    breakevenPercent: z.number().min(0, "保本幅度最小 0").max(10, "保本幅度最大 10"),
    maxHoldMinutes: z.number().int().min(0, "时间兜底不能为负数").max(100_000, "时间兜底最大 100000 分钟"),
    reversalExitEnabled: z.boolean(),
    circuitBreakerAutoReset: z.boolean(),
    breakoutHold: breakoutHoldSchema,
    ambush: ambushSchema,
    updatedAt: z.number().int().optional(),
  })
  .strict();

/** 校验用户输入（允许部分字段，缺失时用默认值补齐）；失败时抛出带中文消息的 Error */
export function parseExecutionSettings(input: unknown): ExecutionSettings {
  const merged = {
    ...DEFAULT_EXECUTION_SETTINGS,
    ...(isRecord(input) ? input : {}),
  };
  const parsed = executionSettingsSchema.safeParse(merged);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join("；");
    throw new Error(message || "执行设置校验失败");
  }
  return parsed.data;
}

/** 校验完整对象并返回错误消息（无错误时返回 null），用于不需要抛错的场景 */
export function validateExecutionSettings(settings: unknown): string | null {
  const parsed = executionSettingsSchema.safeParse(settings);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => issue.message).join("；");
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
