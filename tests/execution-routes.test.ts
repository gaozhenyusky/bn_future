import { describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app";
import { MysqlExecutionRecordRepository } from "../src/storage/execution-repository";

const repository = {
  upsertContracts: async () => undefined,
  getClosedCandleBaseline: async () => [],
  saveCandle: async () => undefined,
  saveMarketContext: async () => undefined,
  saveMetrics: async () => undefined,
  saveSignal: async () => undefined,
  saveSignalIfNew: async () => true,
  saveSourceEvent: async () => undefined,
  getCheckpoint: async () => null,
  setCheckpoint: async () => undefined,
  listRadar: async () => [],
  listSignals: async () => [],
} as never;

const samplePosition = {
  symbol: "DEMOUSDT",
  entryPrice: 100,
  initialQuantity: 5,
  remainingQuantity: 0,
  marginUsdt: 100,
  leverage: 5,
  notionalUsdt: 500,
  stopPrice: 108,
  protectionOrderId: "p-1",
  partialTakeProfitDone: true,
  takeProfitLevelReached: 2,
  openedAt: 1_720_000_000_000,
};

function createRecordsRepo(overrides?: Partial<MysqlExecutionRecordRepository>) {
  const base: MysqlExecutionRecordRepository = {
    listRecords: async () => [{ symbol: "DEMOUSDT", status: "CLOSED", position: samplePosition, updatedAt: 1_720_000_900_000 }],
    getRecord: async () => undefined,
    listClosedAt: async () => ({ DEMOUSDT: 1_720_000_900_000 }),
    listAuditEvents: async (_symbol?: string) => {
      const symbol = "DEMOUSDT";
      return [
        { type: "ENTRY_REJECTED", symbol, reasonCode: "SCORE_BELOW_THRESHOLD", at: 1_719_999_000_000 },
        { type: "ENTRY_REJECTED", symbol, reasonCode: "PENDING_ORDER_EXISTS", at: 1_719_999_500_000 },
        { type: "ENTRY_OPENED", symbol, at: 1_720_000_000_000, details: { quantity: 5, entryPrice: 100 } },
        { type: "POSITION_PARTIALLY_EXITED", symbol, at: 1_720_000_300_000, details: { quantity: 1.666667, price: 108, level: 1 } },
        { type: "POSITION_PARTIALLY_EXITED", symbol, at: 1_720_000_600_000, details: { quantity: 1.111111, price: 115, level: 2 } },
        { type: "POSITION_CLOSED", symbol, reasonCode: "TAKE_PROFIT", at: 1_720_000_900_000, details: { quantity: 2.222222, price: 125 } },
      ];
    },
    ...overrides,
  } as never;
  return base;
}

describe("execution records routes", () => {
  it("返回持仓记录列表（含平仓时间与 PnL 汇总）", async () => {
    const app = buildApp({
      repository,
      health: { connectors: {} },
      executionRecords: createRecordsRepo(),
      latestPriceProvider: async () => undefined,
      fundingRateProvider: async () => 0.0001,
    });

    const response = await app.inject({ method: "GET", url: "/api/execution/records" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      symbol: "DEMOUSDT",
      status: "CLOSED",
      openCount: 1,
      closeCount: 1,
      entryPrice: 100,
      leverage: 5,
      notionalUsdt: 500,
      takeProfitLevelReached: 2,
      openedAt: 1_720_000_000_000,
      closedAt: 1_720_000_900_000,
    });
    const pnl = body.items[0].pnl;
    expect(pnl).toBeDefined();
    expect(pnl.realizedPnl).toBeGreaterThan(0);
    expect(pnl.unrealizedPnl).toBe(0);
    expect(pnl.commission).toBeGreaterThan(0);
    expect(pnl.fundingPeriods).toBe(0);
  });

  it("按 symbol 返回单笔明细与完整事件时间线（含 PnL）", async () => {
    const app = buildApp({
      repository,
      health: { connectors: {} },
      executionRecords: createRecordsRepo(),
    });

    const response = await app.inject({ method: "GET", url: "/api/execution/records?symbol=DEMOUSDT" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.item.symbol).toBe("DEMOUSDT");
    expect(body.item.pnl.realizedPnl).toBeCloseTo((108 - 100) * 1.666667 + (115 - 100) * 1.111111 + (125 - 100) * 2.222222, 3);
    expect(body.events).toHaveLength(4);
    expect(body.events[0].type).toBe("ENTRY_OPENED");
    expect(body.events[3].type).toBe("POSITION_CLOSED");
    expect(body.events[3].reasonCode).toBe("TAKE_PROFIT");
    // 入场被拒事件不进入操作时间线
    expect(body.events.some((event: { type: string }) => event.type === "ENTRY_REJECTED")).toBe(false);
  });

  it("持仓中的记录计算浮动盈亏", async () => {
    const app = buildApp({
      repository,
      health: { connectors: {} },
      executionRecords: createRecordsRepo({
        listRecords: async () => [{
          symbol: "OPENUSDT",
          status: "OPEN",
          position: { ...samplePosition, symbol: "OPENUSDT", remainingQuantity: 3.333333, takeProfitLevelReached: 1 },
          updatedAt: 1_720_000_300_000,
        }],
        listClosedAt: async () => ({}),
        listAuditEvents: async () => [
          { type: "ENTRY_OPENED", symbol: "OPENUSDT", at: 1_720_000_000_000, details: { quantity: 5, entryPrice: 100 } },
          { type: "POSITION_PARTIALLY_EXITED", symbol: "OPENUSDT", at: 1_720_000_300_000, details: { quantity: 1.666667, price: 108, level: 1 } },
        ],
      }),
      latestPriceProvider: async () => 110,
    });

    const response = await app.inject({ method: "GET", url: "/api/execution/records" });
    const item = response.json().items[0];

    expect(item.status).toBe("OPEN");
    expect(item.pnl.unrealizedPnl).toBeCloseTo((110 - 100) * 3.333333, 3);
    expect(item.pnl.realizedPnl).toBeCloseTo((108 - 100) * 1.666667, 3);
    expect(item.closedAt).toBeNull();
  });

  it("未知 symbol 返回 404", async () => {
    const app = buildApp({
      repository,
      health: { connectors: {} },
      executionRecords: createRecordsRepo({
        listRecords: async () => [],
        listClosedAt: async () => ({}),
        listAuditEvents: async () => [],
      }),
    });

    const response = await app.inject({ method: "GET", url: "/api/execution/records?symbol=NOPE" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("EXECUTION_RECORD_NOT_FOUND");
  });

  it("记录服务缺失时返回 503", async () => {
    const app = buildApp({ repository, health: { connectors: {} } });
    const response = await app.inject({ method: "GET", url: "/api/execution/records" });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("EXECUTION_RECORDS_UNAVAILABLE");
  });
});
