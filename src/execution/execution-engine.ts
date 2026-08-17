import type {
  AuditPort,
  CircuitBreakerReason,
  ExecutionAdapter,
  ExecutionMode,
  ExecutionResult,
  ExecutionSignal,
  ManagedPosition,
  MarketUpdate,
  PositionPort,
} from "./types";
import type { ExecutionSettings, TakeProfitLevel } from "../domain/execution-settings";
import { DEFAULT_EXECUTION_SETTINGS } from "../domain/execution-settings";
import { DemoExecutionRiskPolicy } from "./risk-policy";
import { BinanceDemoExecutionError } from "./binance-demo-adapter";

type SettingsProvider = () => Promise<ExecutionSettings>;

type CloseReason = "TAKE_PROFIT" | "STOP_LOSS" | "REVERSAL" | "MAX_HOLD_REACHED";

// 浮点容差：entryPrice * 1.15 可能等于 114.99999999999999，恰好触价时比较失败。
const PRICE_EPSILON = 1e-9;

/** 熔断自动复位的最小熔断时长（5 分钟），防止瞬时故障后立即复位 */
const CIRCUIT_BREAKER_MIN_RESET_AGE_MS = 5 * 60 * 1000;

function roundQuantity(value: number): number {
  return Number(value.toFixed(6));
}

function stopLossPrice(entryPrice: number, stopLossPercent: number): number {
  return Number((entryPrice * (1 - stopLossPercent / 100)).toFixed(6));
}

function takeProfitPrice(entryPrice: number, pricePercent: number): number {
  return Number((entryPrice * (1 + pricePercent / 100)).toFixed(6));
}

function breakevenProtectionPrice(entryPrice: number, breakevenPercent: number): number {
  return Number((entryPrice * (1 + breakevenPercent / 100)).toFixed(6));
}

export class ExecutionEngine {
  public constructor(
    private readonly deps: {
      mode: ExecutionMode;
      adapter: ExecutionAdapter;
      riskPolicy: DemoExecutionRiskPolicy;
      positions: PositionPort;
      audit: AuditPort;
      settingsProvider?: SettingsProvider;
    },
  ) {}

  async handleSignal(signal: ExecutionSignal): Promise<ExecutionResult> {
    if (await this.deps.positions.hasProcessedSignal(signal.dedupeKey)) {
      await this.deps.audit.record({
        type: "DUPLICATE_SIGNAL_IGNORED",
        symbol: signal.symbol,
        signalId: signal.signalId,
        at: signal.detectedAt,
      });
      return { status: "DUPLICATE_SIGNAL_IGNORED" };
    }

    // 熔断自动复位：能产生新信号说明数据流已恢复，且熔断已超过最小时长时
    // 解除旧熔断（此前复位只发生在有持仓的行情更新里，无持仓时熔断会永久卡死）。
    // 实盘模式强制关闭自动复位：异常恢复后必须人工确认才重新开仓。
    const settings = await this.loadSettings();
    if (this.effectiveCircuitBreakerAutoReset(settings) && await this.deps.positions.isCircuitBreakerActive()) {
      const trippedAt = await this.deps.positions.getCircuitBreakerTrippedAt();
      if (trippedAt !== undefined && Date.now() - trippedAt >= CIRCUIT_BREAKER_MIN_RESET_AGE_MS) {
        await this.deps.positions.clearCircuitBreaker();
        await this.deps.audit.record({
          type: "CIRCUIT_BREAKER_RESET",
          symbol: signal.symbol,
          signalId: signal.signalId,
          at: signal.detectedAt,
        });
      }
    }

    const decision = await this.deps.riskPolicy.evaluateEntry(signal, {
      mode: this.deps.mode,
      openPositions: await this.deps.positions.listOpenPositions(),
      pendingOrders: await this.deps.positions.listPendingOrders(),
      circuitBreakerActive: await this.deps.positions.isCircuitBreakerActive(),
    });

    if (!decision.allowed || !decision.plan) {
      // 入场被拒不写入审计时间线（仅返回状态，供调用方/日志消费）。
      return {
        status: "ENTRY_REJECTED",
        reasonCode: decision.reasonCode,
      };
    }

    if (!(await this.deps.positions.reserveEntry(signal.dedupeKey, signal.symbol))) {
      return { status: "ENTRY_REJECTED", reasonCode: "PENDING_ORDER_EXISTS" };
    }

    const holdMode = decision.plan.holdMode ?? "STANDARD";
    const hold = this.resolveHoldSettings(holdMode, settings);

    const quantity = roundQuantity(decision.plan.notionalUsdt / signal.entryPrice);
    let entryOrder;
    try {
      entryOrder = await this.deps.adapter.placeEntryOrder({
        symbol: signal.symbol,
        clientOrderId: `e:${signal.signalId}`,
        quantity,
        entryPrice: signal.entryPrice,
        leverage: decision.plan.leverage,
        notionalUsdt: decision.plan.notionalUsdt,
        marginUsdt: decision.plan.marginUsdt,
        mode: this.deps.mode,
      });
    } catch (error) {
      // 温和拒绝（合约未上架 / 实盘可用保证金不足）：不触发熔断。
      if (error instanceof BinanceDemoExecutionError && (error.notListed || error.gentle)) {
        await this.deps.positions.releaseEntryReservation(signal.dedupeKey, signal.symbol);
        return { status: "ENTRY_REJECTED", reasonCode: "ENTRY_ORDER_NOT_FILLED" };
      }
      return this.tripCircuitForSignal(signal, "ORDER_STATUS_UNKNOWN");
    }
    if (entryOrder.status === "OPEN") {
      await this.deps.positions.savePendingOrder({
        symbol: signal.symbol,
        clientOrderId: entryOrder.clientOrderId,
        orderId: entryOrder.orderId,
      });
      await this.deps.audit.record({
        type: "ENTRY_SUBMITTED",
        symbol: signal.symbol,
        signalId: signal.signalId,
        at: signal.detectedAt,
      });
      return { status: "ENTRY_SUBMITTED" };
    }

    if (entryOrder.status === "CANCELED" || entryOrder.status === "REJECTED") {
      await this.deps.positions.releaseEntryReservation(signal.dedupeKey, signal.symbol);
      return { status: "ENTRY_REJECTED", reasonCode: "ENTRY_ORDER_NOT_FILLED" };
    }

    if (entryOrder.status !== "FILLED") {
      return this.tripCircuitForSignal(signal, "ORDER_STATUS_UNKNOWN");
    }

    // 使用 adapter 返回的实际成交数量（demo 测试网按测试网价格重算过），
    // 保证保护单与后续平仓数量与交易所持仓一致。
    const filledQuantity = entryOrder.quantity > 0 ? entryOrder.quantity : quantity;
    const entryStopPrice = stopLossPrice(signal.entryPrice, hold.stopLossPercent);
    let protectionOrder;
    try {
      protectionOrder = await this.deps.adapter.placeProtectionOrder({
        symbol: signal.symbol,
        clientOrderId: `p:${signal.signalId}`,
        quantity: filledQuantity,
        stopPrice: entryStopPrice,
      });
    } catch {
      return this.tripCircuitForSignal(signal, "PROTECTION_ORDER_MISSING");
    }
    if (protectionOrder.status !== "OPEN" && protectionOrder.status !== "FILLED") {
      return this.tripCircuitForSignal(signal, "PROTECTION_ORDER_MISSING");
    }
    await this.deps.positions.markSignalProcessed(signal.dedupeKey);
    await this.deps.positions.releaseEntryReservation(signal.dedupeKey, signal.symbol);
    await this.deps.positions.clearPendingOrders(signal.symbol);
    await this.deps.positions.saveOpenPosition({
      symbol: signal.symbol,
      entryPrice: signal.entryPrice,
      initialQuantity: filledQuantity,
      remainingQuantity: filledQuantity,
      marginUsdt: decision.plan.marginUsdt,
      leverage: decision.plan.leverage,
      notionalUsdt: decision.plan.notionalUsdt,
      stopPrice: entryStopPrice,
      protectionOrderId: protectionOrder.orderId,
      partialTakeProfitDone: false,
      takeProfitLevelReached: 0,
      holdMode,
      openedAt: signal.detectedAt,
    });
    await this.deps.audit.record({
      type: "ENTRY_OPENED",
      symbol: signal.symbol,
      signalId: signal.signalId,
      at: signal.detectedAt,
      details: { quantity: filledQuantity, entryPrice: signal.entryPrice, stopLossPercent: hold.stopLossPercent, holdMode },
    });
    return { status: "ENTRY_OPENED" };
  }

  async handleMarketUpdate(update: MarketUpdate): Promise<ExecutionResult> {
    const position = await this.deps.positions.getOpenPosition(update.symbol);
    if (!position) {
      return { status: "NO_ACTION" };
    }

    if (!update.dataStreamOk) {
      return this.tripCircuit(update, "DATA_STREAM_INTERRUPTED");
    }

    if (!update.orderStatusKnown) {
      return this.tripCircuit(update, "ORDER_STATUS_UNKNOWN");
    }

    if (!update.protectionOrderPresent) {
      return this.tripCircuit(update, "PROTECTION_ORDER_MISSING");
    }

    const settings = await this.loadSettings();
    const hold = this.resolveHoldSettings(position.holdMode ?? "STANDARD", settings);

    // 熔断自动复位：数据流、订单状态、保护单全部恢复正常时解除熔断，继续正常管理持仓。
    // 实盘模式强制关闭自动复位（人工确认恢复后才开仓）。
    const circuitBreakerActive = await this.deps.positions.isCircuitBreakerActive();
    if (circuitBreakerActive && this.effectiveCircuitBreakerAutoReset(settings)) {
      await this.deps.positions.clearCircuitBreaker();
      await this.deps.audit.record({
        type: "CIRCUIT_BREAKER_RESET",
        symbol: update.symbol,
        at: update.detectedAt,
      });
    }

    if (update.price <= stopLossPrice(position.entryPrice, hold.stopLossPercent) + PRICE_EPSILON) {
      return this.closePosition(position, update, "STOP_LOSS");
    }

    const nextLevelIndex = position.takeProfitLevelReached;
    const nextLevel = hold.takeProfitLevels[nextLevelIndex];
    if (nextLevel && update.price >= takeProfitPrice(position.entryPrice, nextLevel.pricePercent) - PRICE_EPSILON) {
      if (nextLevelIndex === hold.takeProfitLevels.length - 1) {
        return this.closePosition(position, update, "TAKE_PROFIT");
      }
      return this.partialTakeProfit(position, update, hold.takeProfitLevels, nextLevelIndex, nextLevel, settings);
    }

    // 时间兜底：持仓超过配置时长仍未触达第一级止盈则平仓，避免僵尸持仓。
    if (
      update.interval === "5m" &&
      position.takeProfitLevelReached === 0 &&
      hold.maxHoldMinutes > 0 &&
      update.detectedAt - position.openedAt >= hold.maxHoldMinutes * 60_000
    ) {
      return this.closePosition(position, update, "MAX_HOLD_REACHED");
    }

    if (settings.reversalExitEnabled && update.interval === "5m" && update.has5mReversal) {
      return this.closePosition(position, update, "REVERSAL");
    }

    return { status: "NO_ACTION" };
  }

  private async partialTakeProfit(
    position: ManagedPosition,
    update: MarketUpdate,
    levels: readonly TakeProfitLevel[],
    levelIndex: number,
    level: TakeProfitLevel,
    settings: ExecutionSettings,
  ): Promise<ExecutionResult> {
    const quantity = roundQuantity(position.remainingQuantity * level.closeRatio);
    const remainingQuantity = roundQuantity(position.remainingQuantity - quantity);
    // 第 1 级后止损上移至保本价；第 k 级（k>1）后上移至上一级止盈价，锁定已实现利润。
    const newStopPrice =
      levelIndex === 0
        ? breakevenProtectionPrice(position.entryPrice, settings.breakevenPercent)
        : takeProfitPrice(position.entryPrice, levels[levelIndex - 1].pricePercent);

    let takeProfitOrder;
    try {
      takeProfitOrder = await this.deps.adapter.placeReduceOnlyOrder({
        symbol: position.symbol,
        clientOrderId: `tp:${position.symbol}:${update.detectedAt}:${levelIndex + 1}`,
        quantity,
        price: update.price,
        reason: "TAKE_PROFIT",
      });
    } catch {
      return this.tripCircuit(update, "ORDER_STATUS_UNKNOWN");
    }
    if (takeProfitOrder.status !== "FILLED") {
      return this.tripCircuit(update, "ORDER_STATUS_UNKNOWN");
    }
    let protectionOrder;
    try {
      protectionOrder = await this.deps.adapter.replaceProtectionOrder({
        symbol: position.symbol,
        oldOrderId: position.protectionOrderId,
        clientOrderId: `be:${position.symbol}:${update.detectedAt}:${levelIndex + 1}`,
        quantity: remainingQuantity,
        stopPrice: newStopPrice,
      });
    } catch {
      return this.tripCircuit(update, "PROTECTION_ORDER_MISSING");
    }
    if (protectionOrder.status !== "OPEN" && protectionOrder.status !== "FILLED") {
      return this.tripCircuit(update, "PROTECTION_ORDER_MISSING");
    }

    await this.deps.positions.saveOpenPosition({
      ...position,
      remainingQuantity,
      partialTakeProfitDone: true,
      takeProfitLevelReached: levelIndex + 1,
      stopPrice: newStopPrice,
      protectionOrderId: protectionOrder.orderId,
    });
    await this.deps.audit.record({
      type: "POSITION_PARTIALLY_EXITED",
      symbol: position.symbol,
      at: update.detectedAt,
      details: { quantity, remainingQuantity, level: levelIndex + 1, stopPrice: newStopPrice, price: update.price },
    });
    return { status: "POSITION_PARTIALLY_EXITED" };
  }

  private shortCloseReason(reason: CloseReason): string {
    switch (reason) {
      case "TAKE_PROFIT": return "T";
      case "STOP_LOSS": return "S";
      case "REVERSAL": return "R";
      case "MAX_HOLD_REACHED": return "H";
    }
  }

  private async closePosition(
    position: ManagedPosition,
    update: MarketUpdate,
    reason: CloseReason,
  ): Promise<ExecutionResult> {
    let closeOrder;
    try {
      closeOrder = await this.deps.adapter.placeReduceOnlyOrder({
        symbol: position.symbol,
        clientOrderId: `c:${position.symbol}:${update.detectedAt}:${this.shortCloseReason(reason)}`,
        quantity: position.remainingQuantity,
        price: update.price,
        reason,
      });
    } catch {
      return this.tripCircuit(update, "ORDER_STATUS_UNKNOWN");
    }
    if (closeOrder.status !== "FILLED") {
      return this.tripCircuit(update, "ORDER_STATUS_UNKNOWN");
    }
    await this.deps.positions.closePosition(position.symbol);
    await this.deps.audit.record({
      type: "POSITION_CLOSED",
      symbol: position.symbol,
      at: update.detectedAt,
      reasonCode: reason,
      details: { quantity: position.remainingQuantity, price: update.price },
    });
    return { status: "POSITION_CLOSED" };
  }

  private async loadSettings(): Promise<ExecutionSettings> {
    if (!this.deps.settingsProvider) return { ...DEFAULT_EXECUTION_SETTINGS };
    try {
      return await this.deps.settingsProvider();
    } catch {
      return { ...DEFAULT_EXECUTION_SETTINGS };
    }
  }

  /** 实盘模式强制关闭熔断自动复位：异常后必须人工确认（前端/接口复位）才恢复开仓 */
  private effectiveCircuitBreakerAutoReset(settings: ExecutionSettings): boolean {
    return this.deps.mode !== "BINANCE_PRODUCTION" && settings.circuitBreakerAutoReset;
  }

  /** 按持仓模式解析生效的止损/时间兜底/止盈分级参数 */
  private resolveHoldSettings(
    holdMode: "STANDARD" | "BREAKOUT",
    settings: ExecutionSettings,
  ): { stopLossPercent: number; maxHoldMinutes: number; takeProfitLevels: TakeProfitLevel[] } {
    if (holdMode === "BREAKOUT" && settings.breakoutHold) {
      return {
        stopLossPercent: settings.breakoutHold.stopLossPercent,
        maxHoldMinutes: settings.breakoutHold.maxHoldMinutes,
        takeProfitLevels: settings.breakoutHold.takeProfitLevels,
      };
    }
    return {
      stopLossPercent: settings.stopLossPercent,
      maxHoldMinutes: settings.maxHoldMinutes,
      takeProfitLevels: settings.takeProfitLevels,
    };
  }

  private async tripCircuit(update: MarketUpdate, reasonCode: CircuitBreakerReason): Promise<ExecutionResult> {
    await this.deps.positions.tripCircuit(reasonCode);
    await this.deps.audit.record({
      type: "CIRCUIT_BREAKER_TRIPPED",
      symbol: update.symbol,
      reasonCode,
      at: update.detectedAt,
    });
    return {
      status: "CIRCUIT_BREAKER_TRIPPED",
      reasonCode,
    };
  }

  private async tripCircuitForSignal(signal: ExecutionSignal, reasonCode: CircuitBreakerReason): Promise<ExecutionResult> {
    // 释放入场 reservation：熔断后不残留占位，否则该 symbol 会永久 PENDING_ORDER_EXISTS。
    await this.deps.positions.releaseEntryReservation(signal.dedupeKey, signal.symbol);
    await this.deps.positions.tripCircuit(reasonCode);
    await this.deps.audit.record({
      type: "CIRCUIT_BREAKER_TRIPPED",
      symbol: signal.symbol,
      signalId: signal.signalId,
      reasonCode,
      at: signal.detectedAt,
    });
    return { status: "CIRCUIT_BREAKER_TRIPPED", reasonCode };
  }
}
