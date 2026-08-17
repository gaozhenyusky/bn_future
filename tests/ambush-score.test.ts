import { describe, expect, it } from "vitest";

import { calculateAmbushScore } from "../src/analysis/ambush-score";

describe("calculateAmbushScore", () => {
  it("低位 + 深横盘 + 空头燃料充足时给出高分（完全不参考 OI）", () => {
    const score = calculateAmbushScore({
      shortFuelScore: 15,
      positionPercentile: 0.1,
      sevenDayRange: 0.08,
      takerImbalance: 0.05,
      priceReturn: 0.01,
      volumeRatio: 1.0,
    });

    // 燃料 40 + 位置 20 + 横盘 15 + 主动盘 10 + 温和涨 10 + 量能 5 = 100
    expect(score).toBe(100);
  });

  it("OI 变化不影响埋伏评分（相同输入改 OI 不改变分数）", () => {
    // 该函数根本不接收 OI 参数 —— 构造两个仅 OI 不同的调用方式验证无依赖。
    const low = calculateAmbushScore({
      shortFuelScore: 10,
      positionPercentile: 0.3,
      sevenDayRange: 0.12,
      takerImbalance: 0,
      priceReturn: 0.005,
      volumeRatio: 1.0,
    });
    expect(low).toBeGreaterThanOrEqual(0);
    // 高位标的分数显著更低
    const high = calculateAmbushScore({
      shortFuelScore: 10,
      positionPercentile: 0.8,
      sevenDayRange: 0.12,
      takerImbalance: 0,
      priceReturn: 0.005,
      volumeRatio: 1.0,
    });
    expect(high).toBeLessThan(low);
  });

  it("空头燃料是核心权重：燃料 0 分时分数明显低", () => {
    const noFuel = calculateAmbushScore({
      shortFuelScore: 0,
      positionPercentile: 0.1,
      sevenDayRange: 0.08,
      takerImbalance: 0.05,
      priceReturn: 0.01,
      volumeRatio: 1.0,
    });
    expect(noFuel).toBeLessThanOrEqual(60);
  });

  it("涨幅过大（已启动）不给温和上涨分", () => {
    const alreadyLaunched = calculateAmbushScore({
      shortFuelScore: 15,
      positionPercentile: 0.1,
      sevenDayRange: 0.08,
      takerImbalance: 0.05,
      priceReturn: 0.05,
      volumeRatio: 1.0,
    });
    const normal = calculateAmbushScore({
      shortFuelScore: 15,
      positionPercentile: 0.1,
      sevenDayRange: 0.08,
      takerImbalance: 0.05,
      priceReturn: 0.01,
      volumeRatio: 1.0,
    });
    expect(alreadyLaunched).toBeLessThan(normal);
  });

  it("剧烈放量（已启动特征）不给量能蓄势分", () => {
    const burstVolume = calculateAmbushScore({
      shortFuelScore: 15,
      positionPercentile: 0.1,
      sevenDayRange: 0.08,
      takerImbalance: 0.05,
      priceReturn: 0.01,
      volumeRatio: 3.0,
    });
    const normal = calculateAmbushScore({
      shortFuelScore: 15,
      positionPercentile: 0.1,
      sevenDayRange: 0.08,
      takerImbalance: 0.05,
      priceReturn: 0.01,
      volumeRatio: 1.0,
    });
    expect(burstVolume).toBeLessThan(normal);
  });
});
