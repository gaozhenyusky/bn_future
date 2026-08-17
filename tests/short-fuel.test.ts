import { describe, expect, it } from "vitest";

import { calculateShortFuel } from "../src/analysis/short-fuel";

describe("calculateShortFuel", () => {
  it("空头账户占优 + 大户偏空 + 资金费率正溢价时给出高分", () => {
    const result = calculateShortFuel({
      binance: {
        longShortRatio: 0.51,
        topPositionRatio: 0.81,
        fundingRate: 0.0005,
      },
      gate: {
        lsrAccount: 0.41,
        topLsrAccount: 0.73,
        shortLiqUsd: 858_000,
        fundingRate: 0.00005,
      },
    });

    expect(result.score).toBe(15);
    expect(result.level).toBe("HIGH");
    expect(result.evidence.some((item) => item.includes("币安空头账户占优"))).toBe(true);
    expect(result.evidence.some((item) => item.includes("Gate 大户偏空"))).toBe(true);
    expect(result.evidence.some((item) => item.includes("空头爆仓"))).toBe(true);
  });

  it("多空均衡且费率中性时不给分", () => {
    const result = calculateShortFuel({
      binance: { longShortRatio: 1.2, topPositionRatio: 1.1, fundingRate: 0.00001 },
      gate: { lsrAccount: 1.3, topLsrAccount: 1.2, fundingRate: 0.00001 },
    });

    expect(result.score).toBe(0);
    expect(result.level).toBe("NONE");
    expect(result.evidence).toHaveLength(0);
  });

  it("部分交易所数据缺失时仍按可用数据计算", () => {
    const result = calculateShortFuel({
      binance: { longShortRatio: 0.4, topPositionRatio: 0.9, fundingRate: 0.0001 },
    });

    expect(result.score).toBe(5);
    expect(result.level).toBe("WARNING");
    expect(result.dataAvailable).toBe(true);
  });

  it("无任何数据时标记不可用", () => {
    const result = calculateShortFuel({});
    expect(result.score).toBe(0);
    expect(result.dataAvailable).toBe(false);
    expect(result.level).toBe("NONE");
  });

  it("空头爆仓额超过阈值作为信息级证据但不单独计分", () => {
    const result = calculateShortFuel({
      gate: { lsrAccount: 1.5, topLsrAccount: 1.5, shortLiqUsd: 50_000, fundingRate: 0.00001 },
    });

    expect(result.score).toBe(0);
    expect(result.evidence.some((item) => item.includes("空头爆仓 $50,000"))).toBe(true);
  });

  it("分数封顶 15", () => {
    const result = calculateShortFuel({
      binance: { longShortRatio: 0.3, topPositionRatio: 0.3, fundingRate: 0.001 },
      gate: { lsrAccount: 0.3, topLsrAccount: 0.3, fundingRate: 0.001 },
    });

    expect(result.score).toBe(15);
  });
});
