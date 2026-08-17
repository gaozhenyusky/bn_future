/** 模拟执行 PnL 与费用估算的纯函数集合（多头持仓） */

export const DEFAULT_TAKER_FEE_RATE = 0.0005; // 0.05% taker 手续费
export const DEFAULT_FUNDING_RATE = 0.0001; // 每 8 小时 0.01% 资金费率（默认估算值）
export const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000; // 资金费结算周期 8 小时

export interface PnlExit {
  price: number;
  quantity: number;
}

export interface PnlCalculationInput {
  entryPrice: number;
  entryQuantity: number;
  exits: PnlExit[];
  heldMs: number;
  currentPrice?: number;
  remainingQuantity?: number;
  takerFeeRate?: number;
  fundingRate?: number;
}

export interface PnlBreakdown {
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  commission: number;
  fundingFee: number;
  netPnl: number;
  /** 资金费估算的结算周期数（不足一个 8h 周期计 0） */
  fundingPeriods: number;
}

/** 多头平仓盈亏：(exit - entry) × quantity */
export function calculatePnl(entryPrice: number, exitPrice: number, quantity: number): number {
  return (exitPrice - entryPrice) * quantity;
}

/** 手续费：成交额 × 费率 */
export function calculateCommission(notionalUsdt: number, feeRate: number): number {
  return notionalUsdt * feeRate;
}

/** 资金费：名义价值 × 每期费率 × 期数 */
export function calculateFundingFee(notionalUsdt: number, fundingRate: number, periods: number): number {
  return notionalUsdt * fundingRate * periods;
}

/** 持仓时长对应的资金费结算期数（不足一个周期计 0） */
export function estimateFundingPeriods(heldMs: number, intervalMs: number = FUNDING_INTERVAL_MS): number {
  if (!Number.isFinite(heldMs) || heldMs <= 0 || intervalMs <= 0) return 0;
  return Math.floor(heldMs / intervalMs);
}

/** 汇总一笔持仓的 PnL 与费用（含未平仓部分的浮动盈亏） */
export function calculatePnlBreakdown(input: PnlCalculationInput): PnlBreakdown {
  const takerFeeRate = input.takerFeeRate ?? DEFAULT_TAKER_FEE_RATE;
  const fundingRate = input.fundingRate ?? DEFAULT_FUNDING_RATE;

  let realizedPnl = 0;
  let commission = 0;

  // 开仓手续费
  commission += calculateCommission(input.entryPrice * input.entryQuantity, takerFeeRate);

  // 逐笔平仓
  for (const exit of input.exits) {
    realizedPnl += calculatePnl(input.entryPrice, exit.price, exit.quantity);
    commission += calculateCommission(exit.price * exit.quantity, takerFeeRate);
  }

  const unrealizedPnl =
    input.currentPrice !== undefined && input.remainingQuantity !== undefined
      ? calculatePnl(input.entryPrice, input.currentPrice, input.remainingQuantity)
      : 0;

  const fundingPeriods = estimateFundingPeriods(input.heldMs);
  const fundingFee = calculateFundingFee(input.entryPrice * input.entryQuantity, fundingRate, fundingPeriods);

  const totalPnl = realizedPnl + unrealizedPnl;
  return {
    realizedPnl,
    unrealizedPnl,
    totalPnl,
    commission,
    fundingFee,
    netPnl: totalPnl - commission - fundingFee,
    fundingPeriods,
  };
}
