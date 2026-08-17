/**
 * 空头燃料因子：跨交易所（Binance / Gate / Bitget）合约持仓结构聚合。
 * 庄家吸筹期（横盘）吸引空单堆积，拉盘时空头止损/爆仓成为燃料：
 * - 空头账户占比高（多/空人数比 < 1）
 * - 大户持仓偏空
 * - 资金费率为显著正溢价（空头付费）
 * - Gate 出现空头爆仓额（燃料已被点燃）
 */

export interface BinanceShortFuelData {
  /** 多/空账户人数比（<1 表示空头账户更多） */
  longShortRatio?: number;
  /** 大户持仓多/空比（<1 表示大户偏空） */
  topPositionRatio?: number;
  /** 资金费率（如 0.0002 = 0.02%） */
  fundingRate?: number;
}

export interface GateShortFuelData {
  /** 多/空账户比（<1 表示空头账户更多） */
  lsrAccount?: number;
  /** 大户账户多/空比（<1 表示大户偏空） */
  topLsrAccount?: number;
  /** 空头爆仓额（USD，最近周期） */
  shortLiqUsd?: number;
  /** 资金费率 */
  fundingRate?: number;
}

export interface ShortFuelInput {
  binance?: BinanceShortFuelData;
  gate?: GateShortFuelData;
}

export type ShortFuelLevel = "HIGH" | "WARNING" | "INFO" | "NONE";

export interface ShortFuelFactor {
  /** 0-15 分 */
  score: number;
  level: ShortFuelLevel;
  /** 每条证据：交易所 + 指标 + 数值 */
  evidence: string[];
  /** 是否有任一交易所数据可用 */
  dataAvailable: boolean;
}

/** 空头账户拥挤阈值（多/空人数比低于该值视为空头拥挤） */
export const SHORT_ACCOUNT_RATIO_THRESHOLD = 0.6;
/** 大户偏空阈值（多/空持仓比低于该值视为大户偏空） */
export const TOP_SHORT_RATIO_THRESHOLD = 0.85;
/** 资金费率正溢价阈值（高于该值视为空头付费） */
export const FUNDING_PREMIUM_THRESHOLD = 0.0002;
/** 空头爆仓燃料阈值（USD，Gate 单周期） */
export const SHORT_LIQ_FUEL_USD = 10_000;

function scoreAllocation(score: number): ShortFuelLevel {
  if (score >= 10) return "HIGH";
  if (score >= 5) return "WARNING";
  if (score > 0) return "INFO";
  return "NONE";
}

/** 聚合计算空头燃料因子（0-15 分） */
export function calculateShortFuel(input: ShortFuelInput): ShortFuelFactor {
  const evidence: string[] = [];
  let score = 0;

  // 1. 空头账户拥挤（Binance 或 Gate 任一）
  const binanceShortHeavy =
    input.binance?.longShortRatio !== undefined && input.binance.longShortRatio < SHORT_ACCOUNT_RATIO_THRESHOLD;
  const gateShortHeavy = input.gate?.lsrAccount !== undefined && input.gate.lsrAccount < SHORT_ACCOUNT_RATIO_THRESHOLD;
  if (binanceShortHeavy) {
    score += 5;
    evidence.push(`币安空头账户占优（多/空 ${input.binance!.longShortRatio!.toFixed(2)}）`);
  }
  if (gateShortHeavy) {
    score += 5;
    evidence.push(`Gate 空头账户占优（多/空 ${input.gate!.lsrAccount!.toFixed(2)}）`);
  }

  // 2. 大户偏空（任一交易所）
  const binanceTopShort =
    input.binance?.topPositionRatio !== undefined && input.binance.topPositionRatio < TOP_SHORT_RATIO_THRESHOLD;
  const gateTopShort =
    input.gate?.topLsrAccount !== undefined && input.gate.topLsrAccount < TOP_SHORT_RATIO_THRESHOLD;
  if (binanceTopShort) {
    score += 5;
    evidence.push(`币安大户偏空（多/空 ${input.binance!.topPositionRatio!.toFixed(2)}）`);
  }
  if (gateTopShort) {
    score += 5;
    evidence.push(`Gate 大户偏空（多/空 ${input.gate!.topLsrAccount!.toFixed(2)}）`);
  }

  // 3. 资金费率正溢价（空头付费，任一交易所）
  const binanceFundingPremium =
    input.binance?.fundingRate !== undefined && input.binance.fundingRate > FUNDING_PREMIUM_THRESHOLD;
  const gateFundingPremium =
    input.gate?.fundingRate !== undefined && input.gate.fundingRate > FUNDING_PREMIUM_THRESHOLD;
  if (binanceFundingPremium) {
    score += 5;
    evidence.push(`币安资金费率 ${(input.binance!.fundingRate! * 100).toFixed(4)}%（空头付费）`);
  }
  if (gateFundingPremium) {
    score += 5;
    evidence.push(`Gate 资金费率 ${(input.gate!.fundingRate! * 100).toFixed(4)}%（空头付费）`);
  }

  // 4. Gate 空头爆仓燃料（已点燃，作为信息级证据，不计分）
  if (input.gate?.shortLiqUsd !== undefined && input.gate.shortLiqUsd >= SHORT_LIQ_FUEL_USD) {
    evidence.push(`Gate 空头爆仓 $${Math.round(input.gate.shortLiqUsd).toLocaleString()}`);
  }

  const dataAvailable = input.binance !== undefined || input.gate !== undefined;
  return {
    score: Math.min(15, score),
    level: scoreAllocation(score),
    evidence,
    dataAvailable,
  };
}
