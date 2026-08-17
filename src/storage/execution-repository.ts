import type { AuditEvent, ManagedPosition, PendingOrder, PositionPort, CircuitBreakerReason } from "../execution/types";
import type { Queryable } from "./futures-repository";

function parsePayload<T>(payload: unknown): T {
  if (typeof payload !== "string") return payload as T;
  return JSON.parse(payload) as T;
}

/** 旧持仓行可能缺少 takeProfitLevelReached 字段，兼容为 0（未触达任何止盈级） */
function parsePosition(payload: unknown): ManagedPosition {
  const position = parsePayload<ManagedPosition>(payload);
  if (position.takeProfitLevelReached === undefined) {
    position.takeProfitLevelReached = 0;
  }
  return position;
}

export class MysqlExecutionPositionStore implements PositionPort {
  constructor(private readonly db: Queryable) {}

  async listOpenPositions(): Promise<ManagedPosition[]> {
    const result = await this.db.query<{ payload: unknown }>("SELECT payload FROM execution_positions WHERE status = 'OPEN'");
    return result.rows.map((row) => parsePosition(row.payload));
  }

  async getOpenPosition(symbol: string): Promise<ManagedPosition | undefined> {
    const result = await this.db.query<{ payload: unknown }>("SELECT payload FROM execution_positions WHERE symbol = $1 AND status = 'OPEN'", [symbol]);
    return result.rows[0] ? parsePosition(result.rows[0].payload) : undefined;
  }

  async saveOpenPosition(position: ManagedPosition): Promise<void> {
    await this.db.query(
      "INSERT INTO execution_positions (symbol, status, payload) VALUES ($1, 'OPEN', $2) ON CONFLICT (symbol) DO UPDATE SET status = 'OPEN', payload = EXCLUDED.payload",
      [position.symbol, position],
    );
  }

  async closePosition(symbol: string): Promise<void> {
    await this.db.query("UPDATE execution_positions SET status = 'CLOSED' WHERE symbol = $1", [symbol]);
    await this.clearPendingOrders(symbol);
  }

  async listPendingOrders(): Promise<PendingOrder[]> {
    const result = await this.db.query<{ payload: unknown }>("SELECT payload FROM execution_pending_orders WHERE status = 'OPEN'");
    return result.rows.map((row) => parsePayload<PendingOrder>(row.payload));
  }

  async savePendingOrder(order: PendingOrder): Promise<void> {
    await this.db.query(
      "INSERT INTO execution_pending_orders (symbol, client_order_id, status, payload) VALUES ($1, $2, 'OPEN', $3) ON CONFLICT (symbol) DO UPDATE SET client_order_id = EXCLUDED.client_order_id, status = 'OPEN', payload = EXCLUDED.payload",
      [order.symbol, order.clientOrderId, order],
    );
  }

  async clearPendingOrders(symbol: string): Promise<void> {
    await this.db.query("UPDATE execution_pending_orders SET status = 'CLOSED' WHERE symbol = $1", [symbol]);
  }

  async reserveEntry(dedupeKey: string, symbol: string): Promise<boolean> {
    const result = await this.db.query<{ created: number }>(
      "INSERT INTO execution_entry_reservations (dedupe_key, symbol) VALUES ($1, $2) ON CONFLICT (dedupe_key) DO NOTHING RETURNING 1 AS created",
      [dedupeKey, symbol],
    );
    return result.rows.length > 0;
  }

  async releaseEntryReservation(dedupeKey: string, symbol: string): Promise<void> {
    await this.db.query("DELETE FROM execution_entry_reservations WHERE dedupe_key = $1 AND symbol = $2", [dedupeKey, symbol]);
  }

  async hasProcessedSignal(dedupeKey: string): Promise<boolean> {
    const result = await this.db.query(
      "SELECT dedupe_key FROM execution_processed_signals WHERE dedupe_key = $1 UNION SELECT dedupe_key FROM execution_entry_reservations WHERE dedupe_key = $2",
      [dedupeKey, dedupeKey],
    );
    return result.rows.length > 0;
  }

  async markSignalProcessed(dedupeKey: string): Promise<void> {
    await this.db.query("INSERT INTO execution_processed_signals (dedupe_key) VALUES ($1) ON CONFLICT (dedupe_key) DO NOTHING", [dedupeKey]);
  }

  async isCircuitBreakerActive(): Promise<boolean> {
    const result = await this.db.query("SELECT reason_code FROM execution_circuit_breakers WHERE active = TRUE LIMIT 1");
    return result.rows.length > 0;
  }

  async tripCircuit(reasonCode: CircuitBreakerReason): Promise<void> {
    await this.db.query("INSERT INTO execution_circuit_breakers (reason_code, active) VALUES ($1, TRUE) ON CONFLICT (reason_code) DO UPDATE SET active = TRUE", [reasonCode]);
  }

  async clearCircuitBreaker(): Promise<void> {
    await this.db.query("UPDATE execution_circuit_breakers SET active = FALSE WHERE active = TRUE");
  }

  async getCircuitBreakerReason(): Promise<CircuitBreakerReason | undefined> {
    const result = await this.db.query<{ reason_code: CircuitBreakerReason }>("SELECT reason_code FROM execution_circuit_breakers WHERE active = TRUE ORDER BY id DESC LIMIT 1");
    return result.rows[0]?.reason_code;
  }

  async getCircuitBreakerTrippedAt(): Promise<number | undefined> {
    const result = await this.db.query<{ created_at: unknown }>("SELECT created_at FROM execution_circuit_breakers WHERE active = TRUE ORDER BY id DESC LIMIT 1");
    const value = result.rows[0]?.created_at;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}

export class MysqlExecutionAuditRepository {
  constructor(private readonly db: Queryable) {}

  async record(event: AuditEvent): Promise<void> {
    await this.db.query(
      "INSERT INTO execution_audit_events (event_type, symbol, reason_code, occurred_at, details) VALUES ($1, $2, $3, $4, $5)",
      [event.type, event.symbol ?? null, event.reasonCode ?? null, event.at, event.details ?? {}],
    );
  }
}

export interface ExecutionRecordRow {
  symbol: string;
  status: "OPEN" | "CLOSED";
  position: ManagedPosition;
  updatedAt: number;
}

function toTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 只读查询：供交易记录 API 展示开平仓历史与审计明细 */
export class MysqlExecutionRecordRepository {
  constructor(private readonly db: Queryable) {}

  async listRecords(): Promise<ExecutionRecordRow[]> {
    const result = await this.db.query<{ symbol: string; status: string; payload: unknown; updated_at: unknown }>(
      "SELECT symbol, status, payload, updated_at FROM execution_positions ORDER BY updated_at DESC",
    );
    return result.rows.map((row) => ({
      symbol: row.symbol,
      status: row.status === "OPEN" ? "OPEN" : "CLOSED",
      position: parsePosition(row.payload),
      updatedAt: toTimestamp(row.updated_at),
    }));
  }

  async getRecord(symbol: string): Promise<ExecutionRecordRow | undefined> {
    const result = await this.db.query<{ symbol: string; status: string; payload: unknown; updated_at: unknown }>(
      "SELECT symbol, status, payload, updated_at FROM execution_positions WHERE symbol = $1",
      [symbol],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      symbol: row.symbol,
      status: row.status === "OPEN" ? "OPEN" : "CLOSED",
      position: parsePosition(row.payload),
      updatedAt: toTimestamp(row.updated_at),
    };
  }

  /** 每笔平仓时间（毫秒时间戳），来自 POSITION_CLOSED 审计事件 */
  async listClosedAt(): Promise<Record<string, number>> {
    const result = await this.db.query<{ symbol: string; closed_at: number }>(
      "SELECT symbol, MAX(occurred_at) AS closed_at FROM execution_audit_events WHERE event_type = 'POSITION_CLOSED' GROUP BY symbol",
    );
    return Object.fromEntries(result.rows.map((row) => [row.symbol, Number(row.closed_at)]));
  }

  /** 单笔的完整事件时间线（开仓/部分止盈/平仓/熔断等），按时间升序 */
  async listAuditEvents(symbol?: string): Promise<AuditEvent[]> {
    const result = symbol === undefined
      ? await this.db.query<{ event_type: string; symbol: string | null; reason_code: string | null; occurred_at: number; details: unknown }>(
          "SELECT event_type, symbol, reason_code, occurred_at, details FROM execution_audit_events ORDER BY occurred_at ASC, id ASC",
        )
      : await this.db.query<{ event_type: string; symbol: string | null; reason_code: string | null; occurred_at: number; details: unknown }>(
          "SELECT event_type, symbol, reason_code, occurred_at, details FROM execution_audit_events WHERE symbol = $1 ORDER BY occurred_at ASC, id ASC",
          [symbol],
        );
    return result.rows.map((row) => ({
      type: row.event_type as AuditEvent["type"],
      symbol: row.symbol ?? undefined,
      reasonCode: row.reason_code ?? undefined,
      at: Number(row.occurred_at),
      details: typeof row.details === "string" ? JSON.parse(row.details) : row.details,
    }));
  }
}
