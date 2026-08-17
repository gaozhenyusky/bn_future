import { describe, expect, it } from "vitest";
import {
  buildFuturesOiAnomalyFactors,
  calculateFuturesOiAnomalyScore,
} from "../src/analysis/futures-oi-factors";

const baseInput = {
  interval: "5m" as const,
  oiValueDelta: 0.05,
  volumeRatio: 2,
  priceReturn: 0.03,
  priceReturn5m: 0.03,
  takerImbalance: 0.05,
  priceOiAlignment: "PRICE_UP_OI_UP" as const,
  dataCompleteness: "COMPLETE" as const,
  isContractOnly: true,
};

describe("5m breakout score factor", () => {
  it("adds a positive 5m expansion factor and increases the score", () => {
    const breakoutFactors = buildFuturesOiAnomalyFactors(baseInput);
    const flatFactors = buildFuturesOiAnomalyFactors({
      ...baseInput,
      priceReturn: 0,
      priceReturn5m: 0,
      priceOiAlignment: "FLAT_PRICE",
    });

    expect(breakoutFactors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PRICE_5M_EXPANSION" }),
      ]),
    );
    expect(calculateFuturesOiAnomalyScore(baseInput)).toBeGreaterThan(
      calculateFuturesOiAnomalyScore({
        ...baseInput,
        priceReturn: 0,
        priceReturn5m: 0,
        priceOiAlignment: "FLAT_PRICE",
      }),
    );
    expect(flatFactors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PRICE_5M_EXPANSION" }),
      ]),
    );
  });

  it("does not reward a negative 5m return as an upward breakout", () => {
    const factors = buildFuturesOiAnomalyFactors({
      ...baseInput,
      priceReturn: -0.03,
      priceReturn5m: -0.03,
      priceOiAlignment: "PRICE_DOWN_OI_UP",
    });

    expect(factors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PRICE_5M_EXPANSION" }),
      ]),
    );
  });

  it("does not reward falling OI with a high anomaly score", () => {
    // OI 大幅下降（-10%）：不应再获得 OI 高分与增仓结构分。
    const fallingOi = calculateFuturesOiAnomalyScore({
      ...baseInput,
      oiValueDelta: -0.1,
      priceReturn: 0.03,
      priceOiAlignment: "PRICE_UP_OI_DOWN",
    });
    const risingOi = calculateFuturesOiAnomalyScore(baseInput);

    expect(fallingOi).toBeLessThan(risingOi);
    // OI 减少时：OI 0 分 + 成交量 15 + 5m 15 + 结构 0 + 主动盘 10 = 40 封顶
    expect(fallingOi).toBeLessThanOrEqual(40);
    // 同等幅度的 OI 增长应获得显著更高的分数
    expect(risingOi).toBeGreaterThanOrEqual(70);
  });

  it("adds a SHORT_FUEL factor and score when short positions pile up across exchanges", () => {
    const shortFuel = {
      score: 15,
      level: "HIGH" as const,
      evidence: ["币安空头账户占优（多/空 0.51）", "Gate 大户偏空（多/空 0.73）", "资金费率正溢价"],
      dataAvailable: true,
    };
    // 未饱和输入：OI 0.1（OI 50 分）+ 量 2（15）+ 5m 涨幅 0.03（15）+ 结构 10 + 主动盘 0 = 90
    const unsaturated = {
      ...baseInput,
      takerImbalance: 0,
    };
    const factors = buildFuturesOiAnomalyFactors({ ...unsaturated, shortFuel });

    expect(factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SHORT_FUEL", label: "空头燃料", severity: "HIGH" }),
      ]),
    );
    expect(calculateFuturesOiAnomalyScore({ ...unsaturated, shortFuel })).toBeGreaterThan(
      calculateFuturesOiAnomalyScore(unsaturated),
    );
    // 总分仍封顶 100
    expect(calculateFuturesOiAnomalyScore({ ...unsaturated, shortFuel })).toBeLessThanOrEqual(100);
  });

  it("ignores SHORT_FUEL when data is unavailable", () => {
    const factors = buildFuturesOiAnomalyFactors({
      ...baseInput,
      shortFuel: { score: 0, level: "NONE", evidence: [], dataAvailable: false },
    });

    expect(factors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SHORT_FUEL" }),
      ]),
    );
  });

  describe("OI accumulation (long-window capital pre-positioning)", () => {
    it("adds a HIGH OI_ACCUMULATION factor when long-window OI grows beyond threshold", () => {
      // GPS 回测场景：单根 K 线 OI 变化很小（不触发 OI_THRESHOLD_BREAK），但长窗口累计 +40%。
      const factors = buildFuturesOiAnomalyFactors({
        ...baseInput,
        oiValueDelta: 0.02,
        oiAccumulationDelta: 0.4,
        oiAccumulationWindowLabel: "45m (5m×9)",
      });

      expect(factors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "OI_ACCUMULATION", severity: "HIGH" }),
        ]),
      );
    });

    it("reports mild accumulation as INFO and missing data as no factor", () => {
      const mildFactors = buildFuturesOiAnomalyFactors({
        ...baseInput,
        oiValueDelta: 0.01,
        oiAccumulationDelta: 0.05,
        oiAccumulationWindowLabel: "45m (5m×9)",
      });
      expect(mildFactors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "OI_ACCUMULATION", severity: "INFO" }),
        ]),
      );

      const noDataFactors = buildFuturesOiAnomalyFactors(baseInput);
      expect(noDataFactors).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "OI_ACCUMULATION" }),
        ]),
      );
    });

    it("boosts the score when OI accumulates over the long window", () => {
      // 无积累：OI 0.05（50 分）+ 量 2（15）+ 5m 0.03（15）+ 结构 10 + 主动盘 10 = 100 已封顶，
      // 用低 OI/低量输入对比，确保积累分独立生效。
      const base = {
        ...baseInput,
        oiValueDelta: 0.05,
        volumeRatio: 1,
        priceReturn5m: 0.01,
        takerImbalance: 0,
      };
      const withoutAccumulation = calculateFuturesOiAnomalyScore(base);
      const withAccumulation = calculateFuturesOiAnomalyScore({
        ...base,
        oiAccumulationDelta: 0.5,
        oiAccumulationWindowLabel: "45m (5m×9)",
      });

      expect(withAccumulation).toBeGreaterThan(withoutAccumulation);
      expect(withAccumulation).toBeLessThanOrEqual(100);
    });
  });
});
