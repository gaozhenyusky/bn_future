import { describe, expect, it } from "vitest";

import { ExecutionEngine } from "../src/execution/execution-engine";
import { InMemoryPositionStore } from "../src/execution/position-store";
import { DemoExecutionRiskPolicy } from "../src/execution/risk-policy";
import { DEFAULT_EXECUTION_SETTINGS } from "../src/domain/execution-settings";
import type {
  AuditEvent,
  AuditPort,
  ExecutionAdapter,
  ExecutionMode,
  ExecutionOrder,
  ExecutionSignal,
  ManagedPosition,
  MarketUpdate,
} from "../src/execution/types";

class FakeAdapter implements ExecutionAdapter {
  public entryOrders: ExecutionOrder[] = [];
  public exitOrders: ExecutionOrder[] = [];
  public protectionOrders: ExecutionOrder[] = [];

  public constructor(private readonly options?: {
    entryStatus?: ExecutionOrder["status"];
    protectionStatus?: ExecutionOrder["status"];
    exitStatus?: ExecutionOrder["status"];
  }) {}

  async placeEntryOrder(input: {
    symbol: string;
    clientOrderId: string;
    quantity: number;
    entryPrice: number;
    leverage: number;
    notionalUsdt: number;
    marginUsdt: number;
    mode: ExecutionMode;
  }): Promise<ExecutionOrder> {
    const order: ExecutionOrder = {
      orderId: `entry-${this.entryOrders.length + 1}`,
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      side: "BUY",
      quantity: input.quantity,
      price: input.entryPrice,
      status: this.options?.entryStatus ?? "FILLED",
      reduceOnly: false,
      type: "ENTRY",
    };
    this.entryOrders.push(order);
    return order;
  }

  async placeReduceOnlyOrder(input: {
    symbol: string;
    clientOrderId: string;
    quantity: number;
    price: number;
    reason: "TAKE_PROFIT" | "STOP_LOSS" | "REVERSAL" | "MAX_HOLD_REACHED" | "CIRCUIT_BREAKER";
  }): Promise<ExecutionOrder> {
    const order: ExecutionOrder = {
      orderId: `exit-${this.exitOrders.length + 1}`,
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      side: "SELL",
      quantity: input.quantity,
      price: input.price,
      status: this.options?.exitStatus ?? "FILLED",
      reduceOnly: true,
      type: input.reason,
    };
    this.exitOrders.push(order);
    return order;
  }

  async placeProtectionOrder(input: {
    symbol: string;
    clientOrderId: string;
    quantity: number;
    stopPrice: number;
  }): Promise<ExecutionOrder> {
    const order: ExecutionOrder = {
      orderId: `protection-${this.protectionOrders.length + 1}`,
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      side: "SELL",
      quantity: input.quantity,
      price: input.stopPrice,
      status: this.options?.protectionStatus ?? "OPEN",
      reduceOnly: true,
      type: "PROTECTION",
    };
    this.protectionOrders.push(order);
    return order;
  }

  async replaceProtectionOrder(input: {
    symbol: string;
    oldOrderId: string;
    clientOrderId: string;
    quantity: number;
    stopPrice: number;
  }): Promise<ExecutionOrder> {
    return this.placeProtectionOrder({
      symbol: input.symbol,
      clientOrderId: input.clientOrderId,
      quantity: input.quantity,
      stopPrice: input.stopPrice,
    });
  }
}

class MemoryAuditPort implements AuditPort {
  public readonly events: AuditEvent[] = [];

  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

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

function createUpdate(overrides?: Partial<MarketUpdate>): MarketUpdate {
  return {
    symbol: overrides?.symbol ?? "BTCUSDT",
    interval: overrides?.interval ?? "5m",
    price: overrides?.price ?? 100,
    detectedAt: overrides?.detectedAt ?? 1_720_000_600_000,
    has5mReversal: overrides?.has5mReversal ?? false,
    dataStreamOk: overrides?.dataStreamOk ?? true,
    protectionOrderPresent: overrides?.protectionOrderPresent ?? true,
    orderStatusKnown: overrides?.orderStatusKnown ?? true,
  };
}

describe("ExecutionEngine", () => {
  it("信号满足全部门槛时开多，并挂出保护单", async () => {
    const adapter = new FakeAdapter();
    const audit = new MemoryAuditPort();
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit,
    });

    const result = await engine.handleSignal(createSignal());
    const position = await positions.getOpenPosition("BTCUSDT");

    expect(result.status).toBe("ENTRY_OPENED");
    expect(adapter.entryOrders).toHaveLength(1);
    expect(adapter.entryOrders[0]).toMatchObject({
      symbol: "BTCUSDT",
      side: "BUY",
      quantity: 5,
      price: 100,
      status: "FILLED",
    });
    expect(adapter.protectionOrders).toHaveLength(1);
    expect(adapter.protectionOrders[0]?.price).toBeCloseTo(92, 6);
    expect(position).toMatchObject({
      symbol: "BTCUSDT",
      entryPrice: 100,
      initialQuantity: 5,
      remainingQuantity: 5,
      marginUsdt: 100,
      leverage: 5,
      notionalUsdt: 500,
      protectionOrderId: "protection-1",
    });
    expect(audit.events.map((event) => event.type)).toContain("ENTRY_OPENED");
  });

  it("重复信号不会重复下单；未完成订单也保持幂等", async () => {
    const adapter = new FakeAdapter({ entryStatus: "OPEN" });
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "BINANCE_DEMO_TESTNET",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
    });

    const first = await engine.handleSignal(createSignal());
    const second = await engine.handleSignal(createSignal());
    const third = await engine.handleSignal(
      createSignal({
        signalId: "sig-2",
        dedupeKey: "BTCUSDT:5m:1720000000300",
      }),
    );

    expect(first.status).toBe("ENTRY_SUBMITTED");
    expect(second.status).toBe("DUPLICATE_SIGNAL_IGNORED");
    expect(third.status).toBe("ENTRY_REJECTED");
    expect(third.reasonCode).toBe("PENDING_ORDER_EXISTS");
    expect(adapter.entryOrders).toHaveLength(1);
  });

  it("拒单不会登记持仓，未知入场状态会熔断", async () => {
    const rejectedAdapter = new FakeAdapter({ entryStatus: "REJECTED" });
    const rejectedPositions = new InMemoryPositionStore();
    const rejectedEngine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter: rejectedAdapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions: rejectedPositions,
      audit: new MemoryAuditPort(),
    });

    const rejected = await rejectedEngine.handleSignal(createSignal());
    expect(rejected.status).toBe("ENTRY_REJECTED");
    expect(await rejectedPositions.getOpenPosition("BTCUSDT")).toBeUndefined();

    const unknownAdapter = new FakeAdapter({ entryStatus: "UNKNOWN" });
    const unknownPositions = new InMemoryPositionStore();
    const unknownEngine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter: unknownAdapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions: unknownPositions,
      audit: new MemoryAuditPort(),
    });

    const unknown = await unknownEngine.handleSignal(createSignal());
    expect(unknown.status).toBe("CIRCUIT_BREAKER_TRIPPED");
    expect(await unknownPositions.isCircuitBreakerActive()).toBe(true);
  });

  it("保护单未确认有效时熔断且不登记裸仓", async () => {
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "BINANCE_DEMO_TESTNET",
      adapter: new FakeAdapter({ protectionStatus: "REJECTED" }),
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
    });

    const result = await engine.handleSignal(createSignal());

    expect(result.status).toBe("CIRCUIT_BREAKER_TRIPPED");
    expect(result.reasonCode).toBe("PROTECTION_ORDER_MISSING");
    expect(await positions.getOpenPosition("BTCUSDT")).toBeUndefined();
  });

  it("浮盈达到第一级 +8% 时平掉剩余仓位 1/3，并把保护价抬到接近入场价", async () => {
    const adapter = new FakeAdapter();
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
    });

    await engine.handleSignal(createSignal());
    const result = await engine.handleMarketUpdate(
      createUpdate({
        price: 108,
      }),
    );
    const position = await positions.getOpenPosition("BTCUSDT");

    expect(result.status).toBe("POSITION_PARTIALLY_EXITED");
    expect(adapter.exitOrders).toHaveLength(1);
    expect(adapter.exitOrders[0]).toMatchObject({
      symbol: "BTCUSDT",
      quantity: 1.666667,
      type: "TAKE_PROFIT",
    });
    expect(adapter.protectionOrders).toHaveLength(2);
    expect(adapter.protectionOrders[1]?.price).toBeCloseTo(100.1, 6);
    expect(position).toMatchObject({
      remainingQuantity: 3.333333,
      partialTakeProfitDone: true,
      takeProfitLevelReached: 1,
      stopPrice: 100.1,
    });
  });

  it("浮盈达到第二级 +15% 时再平 1/3，保护价上移至第一级止盈价", async () => {
    const adapter = new FakeAdapter();
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
    });

    await engine.handleSignal(createSignal());
    await engine.handleMarketUpdate(createUpdate({ price: 108 }));
    const result = await engine.handleMarketUpdate(
      createUpdate({
        price: 115,
      }),
    );
    const position = await positions.getOpenPosition("BTCUSDT");

    expect(result.status).toBe("POSITION_PARTIALLY_EXITED");
    expect(adapter.exitOrders).toHaveLength(2);
    expect(adapter.exitOrders[1]).toMatchObject({
      symbol: "BTCUSDT",
      quantity: 1.111111,
      type: "TAKE_PROFIT",
    });
    expect(adapter.protectionOrders).toHaveLength(3);
    expect(adapter.protectionOrders[2]?.price).toBeCloseTo(108, 6);
    expect(position).toMatchObject({
      remainingQuantity: 2.222222,
      takeProfitLevelReached: 2,
      stopPrice: 108,
    });
  });

  it("浮盈达到末级 +25% 时全平", async () => {
    const adapter = new FakeAdapter();
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
    });

    await engine.handleSignal(createSignal());
    await engine.handleMarketUpdate(createUpdate({ price: 108 }));
    await engine.handleMarketUpdate(createUpdate({ price: 115 }));
    const result = await engine.handleMarketUpdate(
      createUpdate({
        price: 125,
      }),
    );
    const position = await positions.getOpenPosition("BTCUSDT");

    expect(result.status).toBe("POSITION_CLOSED");
    expect(adapter.exitOrders).toHaveLength(3);
    expect(adapter.exitOrders[2]).toMatchObject({
      symbol: "BTCUSDT",
      quantity: 2.222222,
      type: "TAKE_PROFIT",
    });
    expect(position).toBeUndefined();
  });

  it("未触达任何止盈级且持仓超过时间兜底上限时强制平仓", async () => {
    const adapter = new FakeAdapter();
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
    });

    await engine.handleSignal(createSignal());
    const result = await engine.handleMarketUpdate(
      createUpdate({
        price: 105,
        detectedAt: 1_720_000_000_000 + 121 * 60_000,
      }),
    );
    const position = await positions.getOpenPosition("BTCUSDT");

    expect(result.status).toBe("POSITION_CLOSED");
    expect(adapter.exitOrders[0]).toMatchObject({
      quantity: 5,
      type: "MAX_HOLD_REACHED",
    });
    expect(position).toBeUndefined();
  });

  it("未超时或时间兜底关闭时不平仓", async () => {
    const adapter = new FakeAdapter();
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
    });

    await engine.handleSignal(createSignal());
    const before = await engine.handleMarketUpdate(
      createUpdate({
        price: 105,
        detectedAt: 1_720_000_000_000 + 119 * 60_000,
      }),
    );
    expect(before.status).toBe("NO_ACTION");

    const disabledEngine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter: new FakeAdapter(),
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions: new InMemoryPositionStore(),
      audit: new MemoryAuditPort(),
      settingsProvider: async () => ({ ...DEFAULT_EXECUTION_SETTINGS, maxHoldMinutes: 0 }),
    });
    await disabledEngine.handleSignal(createSignal());
    const after = await disabledEngine.handleMarketUpdate(
      createUpdate({
        price: 105,
        detectedAt: 1_720_000_000_000 + 10_000 * 60_000,
      }),
    );
    expect(after.status).toBe("NO_ACTION");
  });

  it("熔断后数据恢复且开启自动复位时解除熔断并记录审计", async () => {
    const adapter = new FakeAdapter();
    const audit = new MemoryAuditPort();
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit,
    });

    await engine.handleSignal(createSignal());
    const tripped = await engine.handleMarketUpdate(createUpdate({ dataStreamOk: false }));
    expect(tripped.status).toBe("CIRCUIT_BREAKER_TRIPPED");
    expect(await positions.isCircuitBreakerActive()).toBe(true);

    const result = await engine.handleMarketUpdate(createUpdate({ price: 101, detectedAt: 1_720_000_000_000 + 3_600_000 }));
    expect(result.status).toBe("NO_ACTION");
    expect(await positions.isCircuitBreakerActive()).toBe(false);
    expect(audit.events.map((event) => event.type)).toContain("CIRCUIT_BREAKER_RESET");
  });

  it("无持仓时新信号也能解除旧熔断并正常开单", async () => {
    const adapter = new FakeAdapter();
    const audit = new MemoryAuditPort();
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit,
    });

    // 先熔断（数据流中断触发）
    await engine.handleSignal(createSignal());
    await engine.handleMarketUpdate(createUpdate({ dataStreamOk: false }));
    expect(await positions.isCircuitBreakerActive()).toBe(true);

    // 熔断后直接清仓（模拟人工处理），无持仓时新信号到达 → 熔断未满 5 分钟仍拒绝
    await positions.closePosition("BTCUSDT");
    const early = await engine.handleSignal(createSignal({
      signalId: "sig-early",
      dedupeKey: "BTCUSDT:5m:1720000200000",
      detectedAt: 1_720_000_200_000,
    }));
    expect(early.status).toBe("ENTRY_REJECTED");
    expect(early.reasonCode).toBe("CIRCUIT_BREAKER_ACTIVE");

    // 熔断超过 5 分钟后新信号到达 → 自动复位并正常开单
    (positions as unknown as { circuitBreakerTrippedAt: number }).circuitBreakerTrippedAt = Date.now() - 6 * 60 * 1000;
    const result = await engine.handleSignal(createSignal({
      signalId: "sig-after-reset",
      dedupeKey: "BTCUSDT:5m:1720000600000",
      detectedAt: 1_720_000_600_000,
    }));
    expect(result.status).toBe("ENTRY_OPENED");
    expect(await positions.isCircuitBreakerActive()).toBe(false);
    expect(audit.events.map((event) => event.type)).toContain("CIRCUIT_BREAKER_RESET");
  });

  it("关闭自动复位后熔断保持，直到人工处理", async () => {
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter: new FakeAdapter(),
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
      settingsProvider: async () => ({ ...DEFAULT_EXECUTION_SETTINGS, circuitBreakerAutoReset: false }),
    });

    await engine.handleSignal(createSignal());
    await engine.handleMarketUpdate(createUpdate({ dataStreamOk: false }));
    const result = await engine.handleMarketUpdate(createUpdate({ price: 101, detectedAt: 1_720_000_000_000 + 3_600_000 }));

    expect(result.status).toBe("NO_ACTION");
    expect(await positions.isCircuitBreakerActive()).toBe(true);
  });

  it("自定义止损率生效（-10% 触发全平）", async () => {
    const adapter = new FakeAdapter();
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
      settingsProvider: async () => ({ ...DEFAULT_EXECUTION_SETTINGS, stopLossPercent: 10 }),
    });

    await engine.handleSignal(createSignal());
    expect(adapter.protectionOrders[0]?.price).toBeCloseTo(90, 6);
    const result = await engine.handleMarketUpdate(createUpdate({ price: 90 }));
    expect(result.status).toBe("POSITION_CLOSED");
    expect(adapter.exitOrders[0]).toMatchObject({ type: "STOP_LOSS" });
  });

  it("低位启动（BREAKOUT）持仓使用宽松止损与放大的止盈分级", async () => {
    const adapter = new FakeAdapter();
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
    });

    // 场景 1 信号：低位启动
    await engine.handleSignal(createSignal({ breakoutContext: "LOW_POSITION_BREAKOUT" }));
    const position = await positions.getOpenPosition("BTCUSDT");

    // 大想象力止损 -12%（保护单 88）
    expect(position?.holdMode).toBe("BREAKOUT");
    expect(position?.stopPrice).toBeCloseTo(88, 6);

    // 第一级止盈放大到 +30%（默认 8% 不应触发）
    let result = await engine.handleMarketUpdate(createUpdate({ price: 108 }));
    expect(result.status).toBe("NO_ACTION");

    result = await engine.handleMarketUpdate(
      createUpdate({
        price: 130,
      }),
    );
    expect(result.status).toBe("POSITION_PARTIALLY_EXITED");
    expect(adapter.exitOrders[0]).toMatchObject({ quantity: 1.666667, type: "TAKE_PROFIT" });
  });

  it("低位启动（BREAKOUT）持仓的时间兜底放宽到 12 小时", async () => {
    const adapter = new FakeAdapter();
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
    });

    await engine.handleSignal(createSignal({ breakoutContext: "LOW_POSITION_BREAKOUT" }));

    // 240 分钟（默认时间兜底）不触发
    const held240 = await engine.handleMarketUpdate(
      createUpdate({ price: 105, detectedAt: 1_720_000_000_000 + 240 * 60_000 }),
    );
    expect(held240.status).toBe("NO_ACTION");

    // 721 分钟（超过 BREAKOUT 的 720 分钟）触发时间兜底
    const held721 = await engine.handleMarketUpdate(
      createUpdate({ price: 105, detectedAt: 1_720_000_000_000 + 721 * 60_000 }),
    );
    expect(held721.status).toBe("POSITION_CLOSED");
    expect(adapter.exitOrders[0]).toMatchObject({ type: "MAX_HOLD_REACHED" });
  });

  it("标准持仓在 +15% 前仍按默认 +8% 第一级止盈", async () => {
    const adapter = new FakeAdapter();
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
    });

    await engine.handleSignal(createSignal());
    const position = await positions.getOpenPosition("BTCUSDT");
    expect(position?.holdMode).toBe("STANDARD");
    expect(position?.stopPrice).toBeCloseTo(92, 6);

    const result = await engine.handleMarketUpdate(createUpdate({ price: 108 }));
    expect(result.status).toBe("POSITION_PARTIALLY_EXITED");
  });

  it("止盈订单未成交时不减少本地仓位，并进入熔断", async () => {
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter: new FakeAdapter({ exitStatus: "OPEN" }),
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
    });

    await engine.handleSignal(createSignal());
    const result = await engine.handleMarketUpdate(createUpdate({ price: 108 }));

    expect(result.status).toBe("CIRCUIT_BREAKER_TRIPPED");
    expect((await positions.getOpenPosition("BTCUSDT"))?.remainingQuantity).toBe(5);
  });

  it("亏损达到 -8% 时全平", async () => {
    const adapter = new FakeAdapter();
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
    });

    await engine.handleSignal(createSignal());
    const result = await engine.handleMarketUpdate(
      createUpdate({
        price: 92,
      }),
    );
    const position = await positions.getOpenPosition("BTCUSDT");

    expect(result.status).toBe("POSITION_CLOSED");
    expect(adapter.exitOrders).toHaveLength(1);
    expect(adapter.exitOrders[0]).toMatchObject({
      symbol: "BTCUSDT",
      quantity: 5,
      type: "STOP_LOSS",
    });
    expect(position).toBeUndefined();
  });

  it("平仓订单未成交时保留本地仓位并熔断", async () => {
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter: new FakeAdapter({ exitStatus: "REJECTED" }),
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
    });

    await engine.handleSignal(createSignal());
    const result = await engine.handleMarketUpdate(createUpdate({ price: 92 }));

    expect(result.status).toBe("CIRCUIT_BREAKER_TRIPPED");
    expect(await positions.getOpenPosition("BTCUSDT")).toBeDefined();
  });

  it("5m 反转时平掉剩余仓位，不加仓不滚仓", async () => {
    const adapter = new FakeAdapter();
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit: new MemoryAuditPort(),
    });

    await engine.handleSignal(createSignal());
    await engine.handleMarketUpdate(createUpdate({ price: 108 }));
    const result = await engine.handleMarketUpdate(
      createUpdate({
        price: 104,
        has5mReversal: true,
      }),
    );
    const position = await positions.getOpenPosition("BTCUSDT");

    expect(result.status).toBe("POSITION_CLOSED");
    expect(adapter.exitOrders).toHaveLength(2);
    expect(adapter.exitOrders[1]).toMatchObject({
      symbol: "BTCUSDT",
      quantity: 3.333333,
      type: "REVERSAL",
    });
    expect(position).toBeUndefined();
    expect(adapter.entryOrders).toHaveLength(1);
  });

  it.each([
    ["数据中断", createUpdate({ dataStreamOk: false }), "DATA_STREAM_INTERRUPTED"],
    ["订单状态不明", createUpdate({ orderStatusKnown: false }), "ORDER_STATUS_UNKNOWN"],
    ["保护单缺失", createUpdate({ protectionOrderPresent: false }), "PROTECTION_ORDER_MISSING"],
  ])("遇到%s会熔断并阻止后续新开仓", async (_title, update, expectedReason) => {
    const adapter = new FakeAdapter();
    const audit = new MemoryAuditPort();
    const positions = new InMemoryPositionStore();
    const engine = new ExecutionEngine({
      mode: "SIMULATION",
      adapter,
      riskPolicy: new DemoExecutionRiskPolicy(),
      positions,
      audit,
    });

    await engine.handleSignal(createSignal());
    const result = await engine.handleMarketUpdate(update);
    const afterCircuit = await engine.handleSignal(
      createSignal({
        symbol: "ETHUSDT",
        signalId: "sig-2",
        dedupeKey: "ETHUSDT:5m:1720000300000",
      }),
    );

    expect(result.status).toBe("CIRCUIT_BREAKER_TRIPPED");
    expect(result.reasonCode).toBe(expectedReason);
    expect(afterCircuit.status).toBe("ENTRY_REJECTED");
    expect(afterCircuit.reasonCode).toBe("CIRCUIT_BREAKER_ACTIVE");
    expect(audit.events.map((event) => event.type)).toContain("CIRCUIT_BREAKER_TRIPPED");
  });
});
