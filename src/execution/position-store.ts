import type { CircuitBreakerReason, ManagedPosition, PendingOrder, PositionPort } from "./types";

export class InMemoryPositionStore implements PositionPort {
  private readonly openPositions = new Map<string, ManagedPosition>();
  private readonly pendingOrders = new Map<string, PendingOrder>();
  private readonly processedSignals = new Set<string>();
  private readonly entryReservations = new Map<string, string>();
  private circuitBreakerReason?: CircuitBreakerReason;
  private circuitBreakerTrippedAt?: number;

  async listOpenPositions(): Promise<ManagedPosition[]> {
    return [...this.openPositions.values()];
  }

  async getOpenPosition(symbol: string): Promise<ManagedPosition | undefined> {
    return this.openPositions.get(symbol);
  }

  async saveOpenPosition(position: ManagedPosition): Promise<void> {
    this.openPositions.set(position.symbol, position);
  }

  async closePosition(symbol: string): Promise<void> {
    this.openPositions.delete(symbol);
    this.pendingOrders.delete(symbol);
  }

  async listPendingOrders(): Promise<PendingOrder[]> {
    return [...this.pendingOrders.values()];
  }

  async savePendingOrder(order: PendingOrder): Promise<void> {
    this.pendingOrders.set(order.symbol, order);
  }

  async clearPendingOrders(symbol: string): Promise<void> {
    this.pendingOrders.delete(symbol);
  }

  async reserveEntry(dedupeKey: string, symbol: string): Promise<boolean> {
    const existingSymbol = this.entryReservations.get(dedupeKey);
    if (existingSymbol !== undefined) {
      return false;
    }

    if ([...this.entryReservations.values()].some((reservedSymbol) => reservedSymbol === symbol)) {
      return false;
    }

    this.entryReservations.set(dedupeKey, symbol);
    return true;
  }

  async releaseEntryReservation(dedupeKey: string, symbol: string): Promise<void> {
    if (this.entryReservations.get(dedupeKey) === symbol) {
      this.entryReservations.delete(dedupeKey);
    }
  }

  async hasProcessedSignal(dedupeKey: string): Promise<boolean> {
    return this.processedSignals.has(dedupeKey) || this.entryReservations.has(dedupeKey);
  }

  async markSignalProcessed(dedupeKey: string): Promise<void> {
    this.processedSignals.add(dedupeKey);
  }

  async isCircuitBreakerActive(): Promise<boolean> {
    return this.circuitBreakerReason !== undefined;
  }

  async tripCircuit(reasonCode: CircuitBreakerReason): Promise<void> {
    this.circuitBreakerReason = reasonCode;
    this.circuitBreakerTrippedAt = Date.now();
  }

  async clearCircuitBreaker(): Promise<void> {
    this.circuitBreakerReason = undefined;
    this.circuitBreakerTrippedAt = undefined;
  }

  async getCircuitBreakerReason(): Promise<CircuitBreakerReason | undefined> {
    return this.circuitBreakerReason;
  }

  async getCircuitBreakerTrippedAt(): Promise<number | undefined> {
    return this.circuitBreakerTrippedAt;
  }
}
