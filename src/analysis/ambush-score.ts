/**
 * 埋伏评分：与启动评分（OI 变化为主）完全独立的一套评分。
 * 埋伏要的是"还没动的低位横盘 + 空头堆积"，因此**不参考 OI 变化**，
 * 权重集中在：空头燃料（核心）、低位位置、横盘程度、主动盘、温和上涨、量能蓄势。
 */

export interface AmbushScoreInput {
  /** 跨交易所空头燃料（0-15） */
  shortFuelScore: number;
  /** 当前价在 30 天区间的位置（0-1，越小越低位） */
  positionPercentile: number;
  /** 最近 7 天振幅（0-1） */
  sevenDayRange: number;
  /** 主动成交失衡（-1 ~ 1） */
  takerImbalance: number;
  /** 5m 涨幅（小数，如 0.01 = +1%） */
  priceReturn: number;
  /** 成交量比（相对 20 根基线中位数） */
  volumeRatio: number;
}

/** 低位位置得分：越接近区间底部越高 */
function positionScore(percentile: number): number {
  if (percentile < 0.2) return 20;
  if (percentile < 0.4) return 12;
  if (percentile < 0.6) return 6;
  return 0;
}

/** 横盘得分：振幅越小（横盘越久）越高 */
function consolidationScore(range: number): number {
  if (range < 0.1) return 15;
  if (range < 0.15) return 10;
  if (range < 0.2) return 5;
  return 0;
}

/** 温和上涨得分：埋伏阶段涨幅过大属于"已经启动"，不给分 */
function priceScore(priceReturn: number): number {
  if (priceReturn >= 0.03) return 0;
  if (priceReturn >= 0.005) return 10;
  if (priceReturn >= -0.01) return 5;
  return 0;
}

/** 量能蓄势：0.5-1.5x 的温和量能是吸筹迹象；放量或缩量都不加分 */
function volumeScore(volumeRatio: number): number {
  return volumeRatio >= 0.5 && volumeRatio <= 1.5 ? 5 : 0;
}

/** 计算埋伏评分（0-100） */
export function calculateAmbushScore(input: AmbushScoreInput): number {
  const fuelScore = Math.min(40, (Math.max(0, input.shortFuelScore) / 15) * 40);
  const takerScore = Math.min(10, (Math.abs(input.takerImbalance) / 0.05) * 10);

  return Math.round(
    Math.min(
      100,
      fuelScore +
        positionScore(input.positionPercentile) +
        consolidationScore(input.sevenDayRange) +
        takerScore +
        priceScore(input.priceReturn) +
        volumeScore(input.volumeRatio),
    ),
  );
}
