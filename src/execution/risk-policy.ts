import type { EntryExecutionPlan, EntryRiskDecision, ExecutionRiskContext, ExecutionSignal } from "./types";
import type { ExecutionSettings } from "../domain/execution-settings";
import { DEFAULT_EXECUTION_SETTINGS } from "../domain/execution-settings";

type SettingsProvider = () => Promise<ExecutionSettings>;

export class DemoExecutionRiskPolicy {
  private readonly thresholds: Readonly<Record<"5m" | "15m", { oiDelta: number; volumeRatio: number }>>;
  private readonly maxSlippageBps: number;
  private readonly settingsProvider?: SettingsProvider;

  constructor(options?: {
    thresholds?: Partial<Record<"5m" | "15m", { oiDelta: number; volumeRatio: number }>>;
    maxSlippageBps?: number;
    settingsProvider?: SettingsProvider;
  }) {
    this.thresholds = {
      "5m": { oiDelta: options?.thresholds?.["5m"]?.oiDelta ?? 0.05, volumeRatio: options?.thresholds?.["5m"]?.volumeRatio ?? 2 },
      "15m": { oiDelta: options?.thresholds?.["15m"]?.oiDelta ?? 0.08, volumeRatio: options?.thresholds?.["15m"]?.volumeRatio ?? 1.5 },
    };
    this.maxSlippageBps = options?.maxSlippageBps ?? 15;
    this.settingsProvider = options?.settingsProvider;
  }

  async evaluateEntry(signal: ExecutionSignal, context: ExecutionRiskContext): Promise<EntryRiskDecision> {
    if (context.mode !== "SIMULATION" && context.mode !== "BINANCE_DEMO_TESTNET") {
      return { allowed: false, reasonCode: "PRODUCTION_MODE_DISABLED" };
    }

    if (context.circuitBreakerActive) {
      return { allowed: false, reasonCode: "CIRCUIT_BREAKER_ACTIVE" };
    }

    if (signal.side !== "LONG") {
      return { allowed: false, reasonCode: "SHORT_DISABLED" };
    }

    if (!signal.isContractOnly || signal.contractOnlyReason !== "NO_ACTIVE_SPOT_BASE_ASSET") {
      return { allowed: false, reasonCode: "CONTRACT_ONLY_REQUIRED" };
    }

    // 执行设置读取失败时 fail-safe 回退默认值，不阻断监控。
    const settings = await this.loadSettings();

    // 高位风险过滤：已大涨两天后处于区间高位的标的直接拒绝开仓（场景 2）。
    if (signal.breakoutContext === "HIGH_POSITION_RISK") {
      return { allowed: false, reasonCode: "HIGH_POSITION_RISK" };
    }

    // 埋伏开单：低位 + 空头燃料堆积时放宽方向性门槛（不等放量确认），等庄家拉盘爆空。
    // 埋伏不看评分与 OI 爆发 —— 那属于“已经爆发的币”，埋伏要的是还没动的低位横盘。
    const isAmbush = signal.entryMode === "AMBUSH" && settings.ambush.enabled;
    if (isAmbush) {
      if (
        signal.breakoutContext !== "LOW_POSITION_BREAKOUT" ||
        (signal.shortFuelScore ?? 0) < settings.ambush.minShortFuelScore
      ) {
        return { allowed: false, reasonCode: "AMBUSH_CONTEXT_INVALID" };
      }
    } else {
      // STANDARD 模式开单主门槛：OI 爆发（增量资金进场）。评分是异动强度参考，
      // 不再单独拦截开单 —— 评分高但 OI 未爆发的标的不是“准备爆发的币”。
      if (signal.oiValueDelta < settings.minOiBurstDelta) {
        return { allowed: false, reasonCode: "OI_VOLUME_THRESHOLD_NOT_MET" };
      }

      if (signal.priceOiAlignment !== "PRICE_UP_OI_UP") {
        return { allowed: false, reasonCode: "PRICE_OI_ALIGNMENT_INVALID" };
      }

      const threshold = this.thresholds[signal.interval];
      if (Math.abs(signal.oiValueDelta) < threshold.oiDelta || signal.volumeRatio < threshold.volumeRatio) {
        return { allowed: false, reasonCode: "OI_VOLUME_THRESHOLD_NOT_MET" };
      }

      if (signal.dataCompleteness !== "COMPLETE") {
        return { allowed: false, reasonCode: "DATA_COMPLETENESS_INVALID" };
      }

      if (!signal.activeBuyConfirmed) {
        return { allowed: false, reasonCode: "ACTIVE_BUY_NOT_CONFIRMED" };
      }
    }

    if (signal.slippageBps > this.maxSlippageBps) {
      return { allowed: false, reasonCode: "SLIPPAGE_TOO_HIGH" };
    }

    if (context.openPositions.length >= settings.maxOpenPositions) {
      return { allowed: false, reasonCode: "MAX_POSITIONS_REACHED" };
    }

    if (context.openPositions.some((position) => position.symbol === signal.symbol)) {
      return { allowed: false, reasonCode: "SYMBOL_POSITION_EXISTS" };
    }

    if (context.pendingOrders.some((order) => order.symbol === signal.symbol)) {
      return { allowed: false, reasonCode: "PENDING_ORDER_EXISTS" };
    }

    const plan: EntryExecutionPlan = {
      marginUsdt: Number((settings.notionalUsdt / settings.leverage).toFixed(2)),
      leverage: settings.leverage,
      notionalUsdt: settings.notionalUsdt,
      side: "LONG",
      holdMode: signal.breakoutContext === "LOW_POSITION_BREAKOUT" ? "BREAKOUT" : "STANDARD",
    };

    return {
      allowed: true,
      plan,
    };
  }

  private async loadSettings(): Promise<ExecutionSettings> {
    if (!this.settingsProvider) return { ...DEFAULT_EXECUTION_SETTINGS };
    try {
      return await this.settingsProvider();
    } catch {
      return { ...DEFAULT_EXECUTION_SETTINGS };
    }
  }
}
