import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_SETTINGS,
  parseExecutionSettings,
  validateExecutionSettings,
} from "../src/domain/execution-settings";

describe("execution settings domain", () => {
  it("默认值为杠杆 5、开仓 500、评分门槛 80、三级止盈 8/15/25", () => {
    expect(DEFAULT_EXECUTION_SETTINGS).toMatchObject({
      leverage: 5,
      notionalUsdt: 500,
      minOiBurstDelta: 0.05,
      maxOpenPositions: 3,
      stopLossPercent: 8,
      breakevenPercent: 0.1,
      maxHoldMinutes: 120,
      reversalExitEnabled: true,
      circuitBreakerAutoReset: true,
    });
    expect(DEFAULT_EXECUTION_SETTINGS.takeProfitLevels).toEqual([
      { pricePercent: 8, closeRatio: 1 / 3 },
      { pricePercent: 15, closeRatio: 1 / 3 },
      { pricePercent: 25, closeRatio: 1 },
    ]);
  });

  it("低位启动（BREAKOUT）默认使用大想象力参数：止损 12%、时间兜底 12 小时、止盈 30/60/120", () => {
    expect(DEFAULT_EXECUTION_SETTINGS.breakoutHold).toEqual({
      stopLossPercent: 12,
      maxHoldMinutes: 720,
      takeProfitLevels: [
        { pricePercent: 30, closeRatio: 1 / 3 },
        { pricePercent: 60, closeRatio: 1 / 3 },
        { pricePercent: 120, closeRatio: 1 },
      ],
    });
    expect(DEFAULT_EXECUTION_SETTINGS.ambush).toEqual({
      enabled: true,
      minShortFuelScore: 10,
      minScore: 15,
      maxMarketCapM: 20,
    });
  });

  it("空输入使用默认值", () => {
    expect(parseExecutionSettings({})).toEqual(DEFAULT_EXECUTION_SETTINGS);
  });

  it("部分字段与默认值合并", () => {
    const settings = parseExecutionSettings({ leverage: 10, minOiBurstDelta: 0.05 });
    expect(settings.leverage).toBe(10);
    expect(settings.minOiBurstDelta).toBe(0.05);
    expect(settings.notionalUsdt).toBe(500);
    expect(settings.maxOpenPositions).toBe(3);
  });

  it("接受完整合法配置", () => {
    const settings = parseExecutionSettings({
      leverage: 3,
      notionalUsdt: 1000,
      minOiBurstDelta: 0.05,
      maxOpenPositions: 5,
      takeProfitLevels: [
        { pricePercent: 5, closeRatio: 0.5 },
        { pricePercent: 10, closeRatio: 1 },
      ],
      stopLossPercent: 10,
      breakevenPercent: 0.2,
      maxHoldMinutes: 60,
      reversalExitEnabled: false,
      circuitBreakerAutoReset: false,
    });
    expect(settings.leverage).toBe(3);
    expect(settings.takeProfitLevels).toEqual([
      { pricePercent: 5, closeRatio: 0.5 },
      { pricePercent: 10, closeRatio: 1 },
    ]);
    expect(settings.reversalExitEnabled).toBe(false);
  });

  it.each([
    ["杠杆超过上限", { leverage: 126 }, /杠杆/],
    ["杠杆低于下限", { leverage: 0 }, /杠杆/],
    ["开仓金额为负", { notionalUsdt: -1 }, /开仓金额/],
    ["OI 爆发阈值超上限", { minOiBurstDelta: 0.6 }, /OI 爆发/],
    ["最大持仓为 0", { maxOpenPositions: 0 }, /最大持仓/],
    ["止损率为负", { stopLossPercent: -1 }, /止损/],
    ["保本幅度过大", { breakevenPercent: 11 }, /保本/],
    ["时间兜底为负", { maxHoldMinutes: -5 }, /时间兜底/],
    ["止盈级别为空", { takeProfitLevels: [] }, /至少配置/],
    ["止盈级别超过 5 级", { takeProfitLevels: [1, 2, 3, 4, 5, 6].map((i) => ({ pricePercent: i * 5, closeRatio: 1 })) }, /最多 5 级/],
    ["止盈未按升序", { takeProfitLevels: [{ pricePercent: 10, closeRatio: 1 }, { pricePercent: 5, closeRatio: 1 }] }, /升序/],
    ["末级平仓比例不是 1", { takeProfitLevels: [{ pricePercent: 8, closeRatio: 0.5 }] }, /最后一级/],
    ["止盈涨幅为负", { takeProfitLevels: [{ pricePercent: -8, closeRatio: 1 }] }, /大于 0/],
    ["平仓比例超过 1", { takeProfitLevels: [{ pricePercent: 8, closeRatio: 1.5 }] }, /不能超过 1/],
  ])("拒绝非法配置：%s", (_title, input, pattern) => {
    expect(() => parseExecutionSettings(input)).toThrow(pattern);
  });

  it("validateExecutionSettings 返回错误消息而非抛错", () => {
    expect(validateExecutionSettings({ leverage: 0 })).toMatch(/杠杆/);
    expect(validateExecutionSettings(DEFAULT_EXECUTION_SETTINGS)).toBeNull();
  });
});
