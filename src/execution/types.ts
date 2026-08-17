export type ExecutionMode = "SIMULATION" | "BINANCE_DEMO_TESTNET" | "BINANCE_PRODUCTION";

export type ExecutionInterval = "5m" | "15m";

export type ExecutionSide = "LONG" | "SHORT";

export type ExecutionPriceOiAlignment =
  | "PRICE_UP_OI_UP"
  | "PRICE_DOWN_OI_UP"
  | "PRICE_UP_OI_DOWN"
  | "PRICE_DOWN_OI_DOWN"
  | "FLAT_OI"
  | "FLAT_PRICE"
  | "UNAVAILABLE";

export type ExecutionDataCompleteness = "COMPLETE" | "INSUFFICIENT_BASELINE" | "INCOMPLETE_CONTEXT";

export type ExecutionContractOnlyReason = "NO_ACTIVE_SPOT_BASE_ASSET";

export type ExecutionBreakoutContext = "LOW_POSITION_BREAKOUT" | "HIGH_POSITION_RISK" | "NEUTRAL";

export interface ExecutionSignal {
  signalId: string;
  dedupeKey: string;
  symbol: string;
  interval: ExecutionInterval;
  detectedAt: number;
  side: ExecutionSide;
  isContractOnly: boolean;
  contractOnlyReason: ExecutionContractOnlyReason;
  anomalyScore: number;
  priceOiAlignment: ExecutionPriceOiAlignment;
  oiValueDelta: number;
  oiDeltaThreshold: number;
  volumeRatio: number;
  volumeThreshold: number;
  dataCompleteness: ExecutionDataCompleteness;
  activeBuyConfirmed: boolean;
  slippageBps: number;
  maxSlippageBps: number;
  referencePrice: number;
  entryPrice: number;
  /** 开仓场景：低位启动 / 高位风险 / 中性（由 1h K 线分析得出） */
  breakoutContext?: ExecutionBreakoutContext;
  positionPercentile?: number;
  move24h?: number;
  /** 开单模式：STANDARD 放量增仓确认；AMBUSH 低位空头燃料埋伏（放宽方向性门槛） */
  entryMode?: "STANDARD" | "AMBUSH";
  /** 跨交易所空头燃料分数（0-15） */
  shortFuelScore?: number;
}

export interface PendingOrder {
  symbol: string;
  clientOrderId: string;
  orderId?: string;
}

export interface ManagedPosition {
  symbol: string;
  entryPrice: number;
  initialQuantity: number;
  remainingQuantity: number;
  marginUsdt: number;
  leverage: number;
  notionalUsdt: number;
  stopPrice: number;
  protectionOrderId: string;
  partialTakeProfitDone: boolean;
  /** 已触达的分级止盈级别数（0=未触达；旧持仓行缺失时视为 0） */
  takeProfitLevelReached: number;
  /** 持仓参数模式：低位启动（BREAKOUT）使用宽松参数；旧持仓行缺失视为 STANDARD */
  holdMode?: "STANDARD" | "BREAKOUT";
  openedAt: number;
}

export interface ExecutionRiskContext {
  mode: ExecutionMode;
  openPositions: Array<Pick<ManagedPosition, "symbol"> & { quantity?: number }>;
  pendingOrders: PendingOrder[];
  circuitBreakerActive: boolean;
}

export interface EntryExecutionPlan {
  marginUsdt: number;
  leverage: number;
  notionalUsdt: number;
  side: "LONG";
  /** 低位启动场景使用宽松持仓参数（BREAKOUT） */
  holdMode?: "STANDARD" | "BREAKOUT";
}

export type ExecutionRejectReason =
  | "PRODUCTION_MODE_DISABLED"
  | "SHORT_DISABLED"
  | "CONTRACT_ONLY_REQUIRED"
  | "ENTRY_ORDER_NOT_FILLED"
  | "ANOMALY_SCORE_TOO_LOW"
  | "HIGH_POSITION_RISK"
  | "AMBUSH_CONTEXT_INVALID"
  | "PRICE_OI_ALIGNMENT_INVALID"
  | "OI_VOLUME_THRESHOLD_NOT_MET"
  | "DATA_COMPLETENESS_INVALID"
  | "ACTIVE_BUY_NOT_CONFIRMED"
  | "SLIPPAGE_TOO_HIGH"
  | "MAX_POSITIONS_REACHED"
  | "SYMBOL_POSITION_EXISTS"
  | "PENDING_ORDER_EXISTS"
  | "CIRCUIT_BREAKER_ACTIVE";

export interface EntryRiskDecision {
  allowed: boolean;
  reasonCode?: ExecutionRejectReason;
  plan?: EntryExecutionPlan;
}

export interface ExecutionOrder {
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  status: "OPEN" | "FILLED" | "CANCELED" | "REJECTED" | "UNKNOWN";
  reduceOnly: boolean;
  type: "ENTRY" | "PROTECTION" | "TAKE_PROFIT" | "STOP_LOSS" | "REVERSAL" | "MAX_HOLD_REACHED" | "CIRCUIT_BREAKER";
}

export interface ExecutionAdapter {
  placeEntryOrder(input: {
    symbol: string;
    clientOrderId: string;
    quantity: number;
    entryPrice: number;
    leverage: number;
    notionalUsdt: number;
    marginUsdt: number;
    mode: ExecutionMode;
  }): Promise<ExecutionOrder>;
  placeReduceOnlyOrder(input: {
    symbol: string;
    clientOrderId: string;
    quantity: number;
    price: number;
    reason: "TAKE_PROFIT" | "STOP_LOSS" | "REVERSAL" | "MAX_HOLD_REACHED" | "CIRCUIT_BREAKER";
  }): Promise<ExecutionOrder>;
  placeProtectionOrder(input: {
    symbol: string;
    clientOrderId: string;
    quantity: number;
    stopPrice: number;
  }): Promise<ExecutionOrder>;
  replaceProtectionOrder(input: {
    symbol: string;
    oldOrderId: string;
    clientOrderId: string;
    quantity: number;
    stopPrice: number;
  }): Promise<ExecutionOrder>;
}

export interface PositionPort {
  listOpenPositions(): Promise<ManagedPosition[]>;
  getOpenPosition(symbol: string): Promise<ManagedPosition | undefined>;
  saveOpenPosition(position: ManagedPosition): Promise<void>;
  closePosition(symbol: string): Promise<void>;
  listPendingOrders(): Promise<PendingOrder[]>;
  savePendingOrder(order: PendingOrder): Promise<void>;
  clearPendingOrders(symbol: string): Promise<void>;
  reserveEntry(dedupeKey: string, symbol: string): Promise<boolean>;
  releaseEntryReservation(dedupeKey: string, symbol: string): Promise<void>;
  hasProcessedSignal(dedupeKey: string): Promise<boolean>;
  markSignalProcessed(dedupeKey: string): Promise<void>;
  isCircuitBreakerActive(): Promise<boolean>;
  tripCircuit(reasonCode: CircuitBreakerReason): Promise<void>;
  clearCircuitBreaker(): Promise<void>;
  getCircuitBreakerReason(): Promise<CircuitBreakerReason | undefined>;
  /** 熔断触发时间（毫秒时间戳），用于自动复位的最小熔断时长判断 */
  getCircuitBreakerTrippedAt(): Promise<number | undefined>;
}

export interface AuditEvent {
  type:
    | "ENTRY_OPENED"
    | "ENTRY_SUBMITTED"
    | "ENTRY_REJECTED"
    | "DUPLICATE_SIGNAL_IGNORED"
    | "POSITION_PARTIALLY_EXITED"
    | "POSITION_CLOSED"
    | "CIRCUIT_BREAKER_TRIPPED"
    | "CIRCUIT_BREAKER_RESET";
  symbol?: string;
  signalId?: string;
  reasonCode?: string;
  at: number;
  details?: Record<string, unknown>;
}

export interface AuditPort {
  record(event: AuditEvent): Promise<void>;
}

export interface MarketUpdate {
  symbol: string;
  interval: ExecutionInterval;
  price: number;
  detectedAt: number;
  has5mReversal: boolean;
  dataStreamOk: boolean;
  protectionOrderPresent: boolean;
  orderStatusKnown: boolean;
}

export type CircuitBreakerReason =
  | "DATA_STREAM_INTERRUPTED"
  | "ORDER_STATUS_UNKNOWN"
  | "PROTECTION_ORDER_MISSING";

export interface ExecutionResult {
  status:
    | "ENTRY_OPENED"
    | "ENTRY_SUBMITTED"
    | "ENTRY_REJECTED"
    | "DUPLICATE_SIGNAL_IGNORED"
    | "POSITION_PARTIALLY_EXITED"
    | "POSITION_CLOSED"
    | "CIRCUIT_BREAKER_TRIPPED"
    | "NO_ACTION";
  reasonCode?: ExecutionRejectReason | CircuitBreakerReason;
}
