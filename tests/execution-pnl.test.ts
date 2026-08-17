import { describe, expect, it } from "vitest";

import {
  calculateCommission,
  calculateFundingFee,
  calculatePnl,
  calculatePnlBreakdown,
  estimateFundingPeriods,
} from "../src/domain/execution-pnl";

describe("execution PnL helpers", () => {
  it("计算多头平仓盈亏", () => {
    expect(calculatePnl(100, 108, 5)).toBe(40);
    expect(calculatePnl(100, 92, 5)).toBe(-40);
  });

  it("计算手续费与资金费", () => {
    expect(calculateCommission(500, 0.0005)).toBe(0.25);
    expect(calculateFundingFee(500, 0.0001, 3)).toBeCloseTo(0.15, 10);
  });

  it("资金费期数按 8 小时周期向下取整", () => {
    expect(estimateFundingPeriods(0)).toBe(0);
    expect(estimateFundingPeriods(7.9 * 60 * 60 * 1000)).toBe(0);
    expect(estimateFundingPeriods(8 * 60 * 60 * 1000)).toBe(1);
    expect(estimateFundingPeriods(25 * 60 * 60 * 1000)).toBe(3);
  });

  it("汇总：分级止盈全平后的 PnL 与费用", () => {
    const result = calculatePnlBreakdown({
      entryPrice: 100,
      entryQuantity: 5,
      exits: [
        { price: 108, quantity: 1.666667 },
        { price: 115, quantity: 1.111111 },
        { price: 125, quantity: 2.222222 },
      ],
      heldMs: 9 * 60 * 60 * 1000,
    });

    // 已实现盈亏：(108-100)*1.666667 + (115-100)*1.111111 + (125-100)*2.222222
    expect(result.realizedPnl).toBeCloseTo(13.333336 + 16.666665 + 55.55555, 5);
    expect(result.unrealizedPnl).toBe(0);
    // 开仓 500 + 卖出 180+127.7777+277.7777 = 1085.5555 × 0.0005
    expect(result.commission).toBeCloseTo(1085.55555 * 0.0005, 5);
    // 资金费：500 × 0.0001 × 1 期
    expect(result.fundingFee).toBeCloseTo(0.05, 5);
    expect(result.fundingPeriods).toBe(1);
    expect(result.totalPnl).toBeCloseTo(result.realizedPnl, 5);
    expect(result.netPnl).toBeCloseTo(result.realizedPnl - result.commission - result.fundingFee, 5);
  });

  it("未平仓部分计入浮动盈亏", () => {
    const result = calculatePnlBreakdown({
      entryPrice: 100,
      entryQuantity: 5,
      exits: [{ price: 108, quantity: 1.666667 }],
      heldMs: 1000,
      currentPrice: 110,
      remainingQuantity: 3.333333,
    });

    expect(result.realizedPnl).toBeCloseTo((108 - 100) * 1.666667, 5);
    expect(result.unrealizedPnl).toBeCloseTo((110 - 100) * 3.333333, 5);
    expect(result.totalPnl).toBeCloseTo(result.realizedPnl + result.unrealizedPnl, 5);
    expect(result.fundingPeriods).toBe(0);
  });

  it("亏损持仓的净 PnL 为负", () => {
    const result = calculatePnlBreakdown({
      entryPrice: 100,
      entryQuantity: 5,
      exits: [{ price: 92, quantity: 5 }],
      heldMs: 8 * 60 * 60 * 1000,
    });
    expect(result.realizedPnl).toBe(-40);
    expect(result.netPnl).toBeLessThan(0);
  });
});
