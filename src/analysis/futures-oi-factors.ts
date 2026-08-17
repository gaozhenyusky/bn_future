import type {
  FuturesDataCompleteness,
  FuturesKlineInterval,
  FuturesOiAnomalyFactor,
  FuturesPriceOiAlignment,
} from "../domain/futures";
import type { ShortFuelFactor } from "./short-fuel";

export type FuturesOiFactorThresholds = Readonly<
  Record<FuturesKlineInterval, { oi: number; volume: number; price5m: number; oiAccumulation: number }>
>;

export const DEFAULT_FUTURES_OI_FACTOR_THRESHOLDS: FuturesOiFactorThresholds = {
  "5m": { oi: 0.05, volume: 2, price5m: 0.03, oiAccumulation: 0.3 },
  "15m": { oi: 0.08, volume: 1.5, price5m: 0.03, oiAccumulation: 0.3 },
} as const;

type OiFactorInput = {
  interval: FuturesKlineInterval;
  oiValueDelta: number;
  /** 长窗口 OI 累计变化率（如过去 30-90 分钟，GPS 回测启发：资金提前布局） */
  oiAccumulationDelta?: number;
  oiAccumulationWindowLabel?: string;
  volumeRatio: number;
  priceReturn: number;
  priceReturn5m: number;
  takerImbalance: number;
  priceOiAlignment: FuturesPriceOiAlignment;
  dataCompleteness: FuturesDataCompleteness;
  isContractOnly: boolean;
  /** 跨交易所空头燃料（Binance/Gate 合约持仓结构），可选 */
  shortFuel?: ShortFuelFactor;
};

export function deriveFuturesOiValueAlignment(
  priceReturn: number,
  oiValueDelta: number,
): FuturesPriceOiAlignment {
  if (priceReturn === 0) return "FLAT_PRICE";
  if (oiValueDelta === 0) return "FLAT_OI";
  if (priceReturn > 0 && oiValueDelta > 0) return "PRICE_UP_OI_UP";
  if (priceReturn < 0 && oiValueDelta > 0) return "PRICE_DOWN_OI_UP";
  if (priceReturn > 0 && oiValueDelta < 0) return "PRICE_UP_OI_DOWN";
  if (priceReturn < 0 && oiValueDelta < 0) return "PRICE_DOWN_OI_DOWN";
  return "UNAVAILABLE";
}

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function alignmentLabel(alignment: FuturesPriceOiAlignment): string {
  switch (alignment) {
    case "PRICE_UP_OI_UP":
      return "价格上涨 + OI 增加，多头增仓候选";
    case "PRICE_DOWN_OI_UP":
      return "价格下跌 + OI 增加，空头增仓候选";
    case "PRICE_UP_OI_DOWN":
      return "价格上涨 + OI 减少，空头回补候选";
    case "PRICE_DOWN_OI_DOWN":
      return "价格下跌 + OI 减少，多头平仓候选";
    default:
      return "价格与 OI 方向不完整";
  }
}

export function buildFuturesOiAnomalyFactors(
  input: OiFactorInput,
  thresholdConfig: FuturesOiFactorThresholds = DEFAULT_FUTURES_OI_FACTOR_THRESHOLDS,
): FuturesOiAnomalyFactor[] {
  const thresholds = thresholdConfig[input.interval];
  const factors: FuturesOiAnomalyFactor[] = [];

  if (input.oiValueDelta > 0) {
    factors.push({
      code: "OI_DIRECTION",
      label: "OI 增加",
      severity: "INFO",
      detail: `OI 变化 ${formatPercent(input.oiValueDelta)}`,
      value: input.oiValueDelta,
    });
  } else if (input.oiValueDelta < 0) {
    factors.push({
      code: "OI_DIRECTION",
      label: "OI 减少",
      severity: "INFO",
      detail: `OI 变化 ${formatPercent(input.oiValueDelta)}`,
      value: input.oiValueDelta,
    });
  }

  if (Math.abs(input.oiValueDelta) >= thresholds.oi) {
    factors.push({
      code: "OI_THRESHOLD_BREAK",
      label: "OI 阈值突破",
      severity: "HIGH",
      detail: `绝对 OI 变化 ${formatPercent(Math.abs(input.oiValueDelta))} ≥ ${formatPercent(thresholds.oi)}`,
      value: input.oiValueDelta,
    });
  }

  // 长窗口 OI 积累：资金提前数小时布局的信号（GPS 回测：OI 翻倍后放量启动）。
  if (input.oiAccumulationDelta !== undefined) {
    const window = input.oiAccumulationWindowLabel ?? "长窗口";
    if (input.oiAccumulationDelta >= thresholds.oiAccumulation) {
      factors.push({
        code: "OI_ACCUMULATION",
        label: "OI 持续积累",
        severity: "HIGH",
        detail: `${window} OI 累计 ${formatPercent(input.oiAccumulationDelta)} ≥ ${formatPercent(thresholds.oiAccumulation)}，资金提前布局`,
        value: input.oiAccumulationDelta,
      });
    } else if (input.oiAccumulationDelta > 0) {
      factors.push({
        code: "OI_ACCUMULATION",
        label: "OI 温和积累",
        severity: "INFO",
        detail: `${window} OI 累计 ${formatPercent(input.oiAccumulationDelta)}`,
        value: input.oiAccumulationDelta,
      });
    }
  }

  if (input.volumeRatio >= thresholds.volume) {
    factors.push({
      code: "VOLUME_EXPANSION",
      label: "成交量放大",
      severity: "WARNING",
      detail: `成交量比 ${input.volumeRatio.toFixed(2)}x ≥ ${thresholds.volume.toFixed(2)}x`,
      value: input.volumeRatio,
    });
  }

  if (input.interval === "5m" && input.priceReturn5m > 0) {
    const isBreakout = input.priceReturn5m >= thresholds.price5m;
    factors.push({
      code: "PRICE_5M_EXPANSION",
      label: isBreakout ? "5分钟爆发" : "5分钟上涨",
      severity: isBreakout ? "HIGH" : "WARNING",
      detail: `5分钟涨幅 ${formatPercent(input.priceReturn5m)}${isBreakout ? ` ≥ ${formatPercent(thresholds.price5m)}` : ""}`,
      value: input.priceReturn5m,
    });
  }

  if (input.priceOiAlignment !== "UNAVAILABLE" && input.priceOiAlignment !== "FLAT_OI" && input.priceOiAlignment !== "FLAT_PRICE") {
    factors.push({
      code: "PRICE_OI_ALIGNMENT",
      label: "价格-OI 结构",
      severity: "WARNING",
      detail: alignmentLabel(input.priceOiAlignment),
    });
  }

  if (Math.abs(input.takerImbalance) >= 0.05) {
    factors.push({
      code: "TAKER_CONFIRMATION",
      label: input.takerImbalance > 0 ? "主动买盘确认" : "主动卖盘确认",
      severity: "WARNING",
      detail: `主动成交失衡 ${formatPercent(input.takerImbalance)}`,
      value: input.takerImbalance,
    });
  }

  if (input.isContractOnly) {
    factors.push({
      code: "CONTRACT_ONLY_RISK",
      label: "仅合约风险",
      severity: "WARNING",
      detail: "未匹配到活跃现货基准，方向判断只作合约侧参考",
    });
  }

  if (input.dataCompleteness !== "COMPLETE") {
    factors.push({
      code: "DATA_INCOMPLETE",
      label: "数据不完整",
      severity: "INFO",
      detail: `当前上下文状态：${input.dataCompleteness}`,
    });
  }

  if (input.shortFuel && input.shortFuel.dataAvailable && input.shortFuel.score > 0) {
    const severity = input.shortFuel.level === "HIGH" ? "HIGH" : input.shortFuel.level === "WARNING" ? "WARNING" : "INFO";
    factors.push({
      code: "SHORT_FUEL",
      label: "空头燃料",
      severity,
      detail: input.shortFuel.evidence.join("；"),
      value: input.shortFuel.score,
    });
  }

  return factors;
}

export function calculateFuturesOiAnomalyScore(
  input: OiFactorInput,
  thresholdConfig: FuturesOiFactorThresholds = DEFAULT_FUTURES_OI_FACTOR_THRESHOLDS,
): number {
  const thresholds = thresholdConfig[input.interval];
  // OI 分数只奖励增仓（放量增仓雷达的定位）；OI 减少是去杠杆/平仓结构，
  // 由分类器给出 SHORT_COVERING / LONG_LIQUIDATION 等信号，不再贡献高分。
  const oiScore =
    input.oiValueDelta > 0
      ? Math.min(50, (input.oiValueDelta / thresholds.oi) * 50)
      : 0;
  // 长窗口 OI 积累加分（上限 20）：50% 累计增长拿满，与单周期 oiScore 互补。
  const oiAccumulationScore =
    input.oiAccumulationDelta !== undefined && input.oiAccumulationDelta > 0
      ? Math.min(20, (input.oiAccumulationDelta / 0.5) * 20)
      : 0;
  const volumeScore = Math.min(15, (input.volumeRatio / thresholds.volume) * 15);
  const price5mScore =
    input.interval === "5m" && input.priceReturn5m > 0
      ? Math.min(15, (input.priceReturn5m / thresholds.price5m) * 15)
      : 0;
  // 结构分只奖励与增仓一致的上涨/下跌增仓结构；OI 减少结构不给结构分。
  const alignmentScore =
    input.priceOiAlignment === "PRICE_UP_OI_UP" || input.priceOiAlignment === "PRICE_DOWN_OI_UP"
      ? 10
      : 0;
  const takerScore = Math.min(10, (Math.abs(input.takerImbalance) / 0.05) * 10);
  // 跨交易所空头燃料：上方空单堆积/空头付费时加分（上限 15，总分仍封顶 100）。
  const shortFuelScore = input.shortFuel?.dataAvailable ? Math.min(15, input.shortFuel.score) : 0;
  return Math.round(
    Math.min(100, oiScore + oiAccumulationScore + volumeScore + price5mScore + alignmentScore + takerScore + shortFuelScore),
  );
}
