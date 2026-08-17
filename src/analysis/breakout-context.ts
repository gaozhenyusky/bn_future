/**
 * 开仓场景分类：
 * - LOW_POSITION_BREAKOUT：长期横盘后的低位启动（健康，可宽松持仓等爆发走完）
 * - HIGH_POSITION_RISK：已大涨后处于高位（风险高，开仓前过滤）
 * - NEUTRAL：无法归类（默认参数）
 */

/** 场景分析只依赖 K 线的基础价格字段（1h K 线，不落库） */
export interface BreakoutCandle {
  openTime: number;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  closeTime: number;
}

export type BreakoutContextKind = "LOW_POSITION_BREAKOUT" | "HIGH_POSITION_RISK" | "NEUTRAL";

export interface BreakoutContext {
  kind: BreakoutContextKind;
  /** 当前价格在 30 天高低点区间的分位（0-1） */
  positionPercentile: number;
  /** 过去 24 小时涨幅（小数，如 0.25 = +25%） */
  move24h: number;
  /** 过去 48 小时涨幅 */
  move48h: number;
  /** 最近 7 天振幅（(max-min)/min） */
  sevenDayRange: number;
  /** 数据不足时无法判定 */
  dataSufficient: boolean;
}

export interface BreakoutContextOptions {
  highPositionPercentile?: number;
  highMove24h?: number;
  highMove48h?: number;
  lowPositionPercentile?: number;
  consolidationDays?: number;
  consolidationRange?: number;
}

export const DEFAULT_BREAKOUT_CONTEXT_OPTIONS: Required<BreakoutContextOptions> = {
  highPositionPercentile: 0.85,
  highMove24h: 0.25,
  highMove48h: 0.35,
  lowPositionPercentile: 0.6,
  consolidationDays: 7,
  consolidationRange: 0.2,
};

const HOUR_MS = 60 * 60 * 1000;

function toNumber(value: string | number | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** 从 1 小时 K 线序列计算开仓场景（K 线按时间升序，最后一根为最新） */
export function analyzeBreakoutContext(
  candles: readonly BreakoutCandle[],
  currentPrice: number,
  options: BreakoutContextOptions = {},
): BreakoutContext {
  const opts = { ...DEFAULT_BREAKOUT_CONTEXT_OPTIONS, ...options };
  const high = candles.map((candle) => toNumber(candle.high)).filter(Number.isFinite);
  const low = candles.map((candle) => toNumber(candle.low)).filter(Number.isFinite);
  const close = candles.map((candle) => toNumber(candle.close)).filter(Number.isFinite);

  // 至少需要 48 根（48 小时）才能判定涨幅与位置。
  if (candles.length < 48 || high.length === 0 || low.length === 0 || close.length === 0) {
    return {
      kind: "NEUTRAL",
      positionPercentile: 0.5,
      move24h: 0,
      move48h: 0,
      sevenDayRange: 0,
      dataSufficient: false,
    };
  }

  const maxHigh = Math.max(...high);
  const minLow = Math.min(...low);
  const range = maxHigh - minLow;
  const positionPercentile = range > 0 ? Math.min(1, Math.max(0, (currentPrice - minLow) / range)) : 0.5;

  const latestClose = close[close.length - 1];
  const close24hAgo = close[close.length - 1 - 24];
  const close48hAgo = close[close.length - 1 - 48];
  const move24h = close24hAgo > 0 ? latestClose / close24hAgo - 1 : 0;
  const move48h = close48hAgo > 0 ? latestClose / close48hAgo - 1 : 0;

  const consolidationBars = opts.consolidationDays * 24;
  const recentHigh = Math.max(...high.slice(-consolidationBars));
  const recentLow = Math.min(...low.slice(-consolidationBars));
  const sevenDayRange = recentLow > 0 ? (recentHigh - recentLow) / recentLow : 0;

  const isHighPosition =
    positionPercentile >= opts.highPositionPercentile &&
    (move24h > opts.highMove24h || move48h > opts.highMove48h);
  if (isHighPosition) {
    return {
      kind: "HIGH_POSITION_RISK",
      positionPercentile,
      move24h,
      move48h,
      sevenDayRange,
      dataSufficient: true,
    };
  }

  const isLowBreakout =
    positionPercentile < opts.lowPositionPercentile && sevenDayRange < opts.consolidationRange;
  if (isLowBreakout) {
    return {
      kind: "LOW_POSITION_BREAKOUT",
      positionPercentile,
      move24h,
      move48h,
      sevenDayRange,
      dataSufficient: true,
    };
  }

  return {
    kind: "NEUTRAL",
    positionPercentile,
    move24h,
    move48h,
    sevenDayRange,
    dataSufficient: true,
  };
}

/** 场景上下文的时间窗口（1 小时 K 线，30 天） */
export const BREAKOUT_CONTEXT_KLINES = { interval: "1h" as const, limit: 30 * 24 };

export function isKlineOlderThan(candle: BreakoutCandle, ageMs: number, now: number): boolean {
  return candle.closeTime <= now - ageMs;
}
