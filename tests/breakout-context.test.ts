import { describe, expect, it } from "vitest";

import { analyzeBreakoutContext, type BreakoutCandle } from "../src/analysis/breakout-context";

const HOUR_MS = 60 * 60 * 1000;

function makeCandle(openTime: number, open: number, high: number, low: number, close: number): BreakoutCandle {
  return {
    openTime,
    open: String(open),
    high: String(high),
    low: String(low),
    close: String(close),
    closeTime: openTime + HOUR_MS - 1,
  };
}

/** 生成一段 K 线：base 价格围绕 center 震荡（振幅 rangePct），最后 jumpTo 结尾 */
function buildCandles(total: number, center: number, rangePct: number, jumpTo?: number): BreakoutCandle[] {
  const start = 1_700_000_000_000;
  const candles: BreakoutCandle[] = [];
  for (let index = 0; index < total; index += 1) {
    const open = center * (1 + (index % 4) * 0.001);
    const high = open * (1 + rangePct / 2);
    const low = open * (1 - rangePct / 2);
    const close = index === total - 1 && jumpTo !== undefined ? jumpTo : open;
    candles.push(makeCandle(start + index * HOUR_MS, open, high, low, close));
  }
  return candles;
}

describe("analyzeBreakoutContext", () => {
  it("长期横盘后的低位启动判定为 LOW_POSITION_BREAKOUT", () => {
    // 30 天围绕 100 横盘（振幅 ~4%，区间约 98-102.3），当前价格 99（低位）。
    const candles = buildCandles(30 * 24, 100, 0.04);
    const context = analyzeBreakoutContext(candles, 99);

    expect(context.kind).toBe("LOW_POSITION_BREAKOUT");
    expect(context.dataSufficient).toBe(true);
    expect(context.positionPercentile).toBeLessThan(0.6);
    expect(context.sevenDayRange).toBeLessThan(0.2);
    expect(Math.abs(context.move24h)).toBeLessThan(0.02);
  });

  it("大涨两天后处于高位的判定为 HIGH_POSITION_RISK", () => {
    // 28 天横盘（区间约 97-103），最后 48 小时拉涨到 137，当前价格 137 处于区间顶部。
    const candles = buildCandles(28 * 24, 100, 0.06);
    for (let index = 0; index < 48; index += 1) {
      const progress = (index + 1) / 48;
      const price = 100 * (1 + progress * 0.37);
      candles.push(makeCandle(candles[candles.length - 1].openTime + HOUR_MS, price, price * 1.01, price * 0.995, price));
    }
    const context = analyzeBreakoutContext(candles, 137);

    expect(context.kind).toBe("HIGH_POSITION_RISK");
    expect(context.positionPercentile).toBeGreaterThanOrEqual(0.85);
    expect(context.move48h).toBeGreaterThan(0.35);
  });

  it("涨幅不足或位置不高时判定为 NEUTRAL", () => {
    // 价格从 100 涨到 115（48h +15%），区间 90-130 → 分位 ~0.63，不足高位条件。
    const candles = buildCandles(30 * 24, 100, 0.08);
    for (let index = 0; index < 48; index += 1) {
      const progress = (index + 1) / 48;
      const price = 100 * (1 + progress * 0.15);
      candles.push(makeCandle(candles[candles.length - 1].openTime + HOUR_MS, price, price * 1.01, price * 0.995, price));
    }
    const context = analyzeBreakoutContext(candles, 115);

    expect(context.kind).toBe("NEUTRAL");
  });

  it("数据不足时判定为 NEUTRAL 且 dataSufficient=false", () => {
    const context = analyzeBreakoutContext(buildCandles(20, 100, 0.05), 101);
    expect(context.kind).toBe("NEUTRAL");
    expect(context.dataSufficient).toBe(false);
  });

  it("自定义阈值生效", () => {
    const candles = buildCandles(30 * 24, 100, 0.04);
    // 更严格的高位条件：+10% 涨幅即视为高位风险
    for (let index = 0; index < 48; index += 1) {
      const progress = (index + 1) / 48;
      const price = 100 * (1 + progress * 0.12);
      candles.push(makeCandle(candles[candles.length - 1].openTime + HOUR_MS, price, price * 1.01, price * 0.995, price));
    }
    const strict = analyzeBreakoutContext(candles, 112, { highMove48h: 0.1 });
    const defaultOptions = analyzeBreakoutContext(candles, 112);

    expect(strict.kind).toBe("HIGH_POSITION_RISK");
    expect(defaultOptions.kind).toBe("NEUTRAL");
  });
});
