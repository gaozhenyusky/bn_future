import { describe, expect, it } from "vitest";

import { DemoExecutionRiskPolicy } from "../src/execution/risk-policy";
import { DEFAULT_EXECUTION_SETTINGS, type ExecutionSettings } from "../src/domain/execution-settings";
import type { ExecutionRiskContext, ExecutionSignal } from "../src/execution/types";

function createSignal(overrides?: Partial<ExecutionSignal>): ExecutionSignal {
  return {
    signalId: overrides?.signalId ?? "sig-1",
    dedupeKey: overrides?.dedupeKey ?? "BTCUSDT:5m:1720000000000",
    symbol: overrides?.symbol ?? "BTCUSDT",
    interval: overrides?.interval ?? "5m",
    detectedAt: overrides?.detectedAt ?? 1_720_000_000_000,
    side: overrides?.side ?? "LONG",
    isContractOnly: overrides?.isContractOnly ?? true,
    contractOnlyReason: overrides?.contractOnlyReason ?? "NO_ACTIVE_SPOT_BASE_ASSET",
    anomalyScore: overrides?.anomalyScore ?? 88,
    priceOiAlignment: overrides?.priceOiAlignment ?? "PRICE_UP_OI_UP",
    oiValueDelta: overrides?.oiValueDelta ?? 0.11,
    oiDeltaThreshold: overrides?.oiDeltaThreshold ?? 0.05,
    volumeRatio: overrides?.volumeRatio ?? 2.4,
    volumeThreshold: overrides?.volumeThreshold ?? 2,
    dataCompleteness: overrides?.dataCompleteness ?? "COMPLETE",
    activeBuyConfirmed: overrides?.activeBuyConfirmed ?? true,
    slippageBps: overrides?.slippageBps ?? 10,
    maxSlippageBps: overrides?.maxSlippageBps ?? 15,
    referencePrice: overrides?.referencePrice ?? 100,
    entryPrice: overrides?.entryPrice ?? 100,
    breakoutContext: overrides?.breakoutContext,
    entryMode: overrides?.entryMode,
    shortFuelScore: overrides?.shortFuelScore,
  };
}

function createRiskContext(overrides?: Partial<ExecutionRiskContext>): ExecutionRiskContext {
  return {
    mode: overrides?.mode ?? "SIMULATION",
    openPositions: overrides?.openPositions ?? [],
    pendingOrders: overrides?.pendingOrders ?? [],
    circuitBreakerActive: overrides?.circuitBreakerActive ?? false,
  };
}

function settingsProviderOf(overrides: Partial<ExecutionSettings>) {
  return async () => ({ ...DEFAULT_EXECUTION_SETTINGS, ...overrides });
}

describe("DemoExecutionRiskPolicy", () => {
  it("只允许 simulation 与 demo testnet，默认禁止生产模式", async () => {
    const policy = new DemoExecutionRiskPolicy();

    const decision = await policy.evaluateEntry(
      createSignal(),
      createRiskContext({
        mode: "BINANCE_PRODUCTION",
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("PRODUCTION_MODE_DISABLED");
  });

  it("全部硬门槛满足时才允许入场，并给出默认仓位计划", async () => {
    const policy = new DemoExecutionRiskPolicy();

    const decision = await policy.evaluateEntry(createSignal(), createRiskContext());

    expect(decision.allowed).toBe(true);
    expect(decision.plan).toEqual({
      marginUsdt: 100,
      leverage: 5,
      notionalUsdt: 500,
      side: "LONG",
      holdMode: "STANDARD",
    });
  });

  it("使用可视化配置中的杠杆与开仓金额生成仓位计划", async () => {
    const policy = new DemoExecutionRiskPolicy({
      settingsProvider: settingsProviderOf({ leverage: 10, notionalUsdt: 2000 }),
    });

    const decision = await policy.evaluateEntry(createSignal(), createRiskContext());

    expect(decision.allowed).toBe(true);
    expect(decision.plan).toEqual({
      marginUsdt: 200,
      leverage: 10,
      notionalUsdt: 2000,
      side: "LONG",
      holdMode: "STANDARD",
    });
  });

  it("低位启动场景标记为 BREAKOUT 宽松持仓模式", async () => {
    const policy = new DemoExecutionRiskPolicy();

    const decision = await policy.evaluateEntry(
      createSignal({ breakoutContext: "LOW_POSITION_BREAKOUT" }),
      createRiskContext(),
    );

    expect(decision.allowed).toBe(true);
    expect(decision.plan?.holdMode).toBe("BREAKOUT");
  });

  it("高位风险场景直接拒绝开仓", async () => {
    const policy = new DemoExecutionRiskPolicy();

    const decision = await policy.evaluateEntry(
      createSignal({ breakoutContext: "HIGH_POSITION_RISK", anomalyScore: 95 }),
      createRiskContext(),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("HIGH_POSITION_RISK");
  });

  it("AMBUSH 埋伏开单放宽方向性门槛（低位 + 空头燃料充足即可开单）", async () => {
    const policy = new DemoExecutionRiskPolicy();

    // 数据不完整、无主动买盘、结构非上涨，但低位 + 空头燃料 15 分 → 允许。
    const decision = await policy.evaluateEntry(
      createSignal({
        entryMode: "AMBUSH",
        breakoutContext: "LOW_POSITION_BREAKOUT",
        shortFuelScore: 15,
        dataCompleteness: "INCOMPLETE_CONTEXT",
        activeBuyConfirmed: false,
        priceOiAlignment: "PRICE_DOWN_OI_UP",
        oiValueDelta: 0.01,
        volumeRatio: 1.1,
        anomalyScore: 85,
      }),
      createRiskContext(),
    );

    expect(decision.allowed).toBe(true);
    expect(decision.plan?.holdMode).toBe("BREAKOUT");
  });

  it("AMBUSH 但空头燃料不足时拒绝", async () => {
    const policy = new DemoExecutionRiskPolicy();

    const decision = await policy.evaluateEntry(
      createSignal({
        entryMode: "AMBUSH",
        breakoutContext: "LOW_POSITION_BREAKOUT",
        shortFuelScore: 5,
        anomalyScore: 95,
      }),
      createRiskContext(),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("AMBUSH_CONTEXT_INVALID");
  });

  it("AMBUSH 但非低位启动场景时拒绝", async () => {
    const policy = new DemoExecutionRiskPolicy();

    const decision = await policy.evaluateEntry(
      createSignal({
        entryMode: "AMBUSH",
        breakoutContext: "NEUTRAL",
        shortFuelScore: 15,
        anomalyScore: 95,
      }),
      createRiskContext(),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("AMBUSH_CONTEXT_INVALID");
  });

  it("关闭埋伏开单后 AMBUSH 信号走标准门槛", async () => {
    const policy = new DemoExecutionRiskPolicy({
      settingsProvider: settingsProviderOf({ ambush: { enabled: false, minShortFuelScore: 10, minScore: 30, maxMarketCapM: 20 } }),
    });

    const decision = await policy.evaluateEntry(
      createSignal({
        entryMode: "AMBUSH",
        breakoutContext: "LOW_POSITION_BREAKOUT",
        shortFuelScore: 15,
        dataCompleteness: "INCOMPLETE_CONTEXT",
        anomalyScore: 95,
      }),
      createRiskContext(),
    );

    // 关闭后按标准模式检查：数据不完整 → 拒绝。
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("DATA_COMPLETENESS_INVALID");
  });

  it("STANDARD 模式按 OI 爆发阈值判定开单（评分高但 OI 未爆发则拒绝）", async () => {
    const policy = new DemoExecutionRiskPolicy({
      settingsProvider: settingsProviderOf({ minOiBurstDelta: 0.1 }),
    });

    // 评分很高但 OI 只涨 3%（低于爆发阈值 10%）→ 拒绝。
    const decision = await policy.evaluateEntry(
      createSignal({ anomalyScore: 95, oiValueDelta: 0.03 }),
      createRiskContext(),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("OI_VOLUME_THRESHOLD_NOT_MET");
  });

  it("AMBUSH 埋伏开单不受 OI 爆发阈值限制", async () => {
    const policy = new DemoExecutionRiskPolicy({
      settingsProvider: settingsProviderOf({ minOiBurstDelta: 0.1 }),
    });

    const decision = await policy.evaluateEntry(
      createSignal({
        entryMode: "AMBUSH",
        breakoutContext: "LOW_POSITION_BREAKOUT",
        shortFuelScore: 15,
        oiValueDelta: 0.001,
        anomalyScore: 20,
      }),
      createRiskContext(),
    );

    expect(decision.allowed).toBe(true);
  });

  it("持仓数量达到可视化配置上限时拒绝入场", async () => {
    const policy = new DemoExecutionRiskPolicy({
      settingsProvider: settingsProviderOf({ maxOpenPositions: 2 }),
    });

    const decision = await policy.evaluateEntry(
      createSignal(),
      createRiskContext({
        openPositions: [
          { symbol: "ETHUSDT", quantity: 1 },
          { symbol: "SOLUSDT", quantity: 1 },
        ],
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("MAX_POSITIONS_REACHED");
  });

  it("设置读取失败时 fail-safe 使用默认值（评分不再拦截，走 OI 爆发门槛）", async () => {
    const policy = new DemoExecutionRiskPolicy({
      settingsProvider: async () => {
        throw new Error("db down");
      },
    });

    const decision = await policy.evaluateEntry(createSignal({ anomalyScore: 79, oiValueDelta: 0.03 }), createRiskContext());

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("OI_VOLUME_THRESHOLD_NOT_MET");
  });

  it.each([
    ["方向不是只做多", createSignal({ side: "SHORT" }), createRiskContext(), "SHORT_DISABLED"],
    ["有现货对应标的", createSignal({ isContractOnly: false }), createRiskContext(), "CONTRACT_ONLY_REQUIRED"],
    ["OI 未达爆发阈值", createSignal({ oiValueDelta: 0.03 }), createRiskContext(), "OI_VOLUME_THRESHOLD_NOT_MET"],
    ["价格和 OI 不是同向上涨", createSignal({ priceOiAlignment: "PRICE_DOWN_OI_UP" }), createRiskContext(), "PRICE_OI_ALIGNMENT_INVALID"],
    ["OI 未达到阈值", createSignal({ oiValueDelta: 0.049 }), createRiskContext(), "OI_VOLUME_THRESHOLD_NOT_MET"],
    ["成交量未达到阈值", createSignal({ volumeRatio: 1.99 }), createRiskContext(), "OI_VOLUME_THRESHOLD_NOT_MET"],
    ["数据完整性不是 COMPLETE", createSignal({ dataCompleteness: "INCOMPLETE_CONTEXT" }), createRiskContext(), "DATA_COMPLETENESS_INVALID"],
    ["主动买盘未确认", createSignal({ activeBuyConfirmed: false }), createRiskContext(), "ACTIVE_BUY_NOT_CONFIRMED"],
    ["滑点超限", createSignal({ slippageBps: 16 }), createRiskContext(), "SLIPPAGE_TOO_HIGH"],
    [
      "持仓达到上限",
      createSignal(),
      createRiskContext({
        openPositions: [
          { symbol: "BTCUSDT", quantity: 1 },
          { symbol: "ETHUSDT", quantity: 1 },
          { symbol: "SOLUSDT", quantity: 1 },
        ],
      }),
      "MAX_POSITIONS_REACHED",
    ],
    [
      "同标的已有持仓",
      createSignal(),
      createRiskContext({
        openPositions: [{ symbol: "BTCUSDT", quantity: 1 }],
      }),
      "SYMBOL_POSITION_EXISTS",
    ],
    [
      "同标的已有未完成订单",
      createSignal(),
      createRiskContext({
        pendingOrders: [{ symbol: "BTCUSDT", clientOrderId: "pending-1" }],
      }),
      "PENDING_ORDER_EXISTS",
    ],
    ["熔断中", createSignal(), createRiskContext({ circuitBreakerActive: true }), "CIRCUIT_BREAKER_ACTIVE"],
  ])("会拒绝入场：%s", async (_title, signal, context, expectedReason) => {
    const policy = new DemoExecutionRiskPolicy();

    const decision = await policy.evaluateEntry(signal, context);

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(expectedReason);
  });
});
