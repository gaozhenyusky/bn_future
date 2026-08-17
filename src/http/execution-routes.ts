import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MysqlExecutionRecordRepository, ExecutionRecordRow } from "../storage/execution-repository";
import type { AuditEvent } from "../execution/types";
import { calculatePnlBreakdown, DEFAULT_FUNDING_RATE, type PnlExit } from "../domain/execution-pnl";

const querySchema = z.object({
  symbol: z.string().min(1).max(64).optional(),
});

function sendValidationError(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, error: z.ZodError) {
  return reply.code(400).send({
    error: "INVALID_QUERY",
    message: error.issues.map((issue) => issue.message).join("；"),
  });
}

function extractExits(events: AuditEvent[]): PnlExit[] {
  return events
    .filter((event) => event.type === "POSITION_PARTIALLY_EXITED" || event.type === "POSITION_CLOSED")
    .flatMap((event) => {
      const quantity = Number(event.details?.quantity);
      const price = Number(event.details?.price);
      return Number.isFinite(quantity) && Number.isFinite(price) && quantity > 0 && price > 0
        ? [{ price, quantity }]
        : [];
    });
}

export interface ExecutionPnlDeps {
  executionRecords?: MysqlExecutionRecordRepository;
  /** 提供当前价格（浮动盈亏用）；失败时返回 undefined */
  latestPriceProvider?: (symbol: string) => Promise<number | undefined>;
  /** 提供当前资金费率；失败时回退默认值 */
  fundingRateProvider?: (symbol: string) => Promise<number>;
}

export function registerExecutionRoutes(app: FastifyInstance, deps: ExecutionPnlDeps) {
  app.get("/api/execution/records", async (request, reply) => {
    if (!deps.executionRecords) {
      return reply.code(503).send({
        error: "EXECUTION_RECORDS_UNAVAILABLE",
        message: "交易记录服务尚未配置",
        items: [],
      });
    }

    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return sendValidationError(reply, parsed.error);

    const records = await deps.executionRecords.listRecords();
    const closedAt = await deps.executionRecords.listClosedAt();
    const events = await deps.executionRecords.listAuditEvents();
    const eventsBySymbol = new Map<string, AuditEvent[]>();
    for (const event of events) {
      if (!event.symbol) continue;
      // 入场被拒不进入操作时间线（兼容历史遗留数据）。
      if (event.type === "ENTRY_REJECTED") continue;
      const list = eventsBySymbol.get(event.symbol) ?? [];
      list.push(event);
      eventsBySymbol.set(event.symbol, list);
    }

    const now = Date.now();
    const items: unknown[] = [];
    for (const record of records) {
      items.push(await serializeRecordWithPnl(record, closedAt[record.symbol] ?? null, eventsBySymbol.get(record.symbol) ?? [], now, deps));
    }

    if (parsed.data.symbol !== undefined) {
      const detail = items.find((item) => (item as { symbol: string }).symbol === parsed.data.symbol);
      if (!detail) {
        return reply.code(404).send({
          error: "EXECUTION_RECORD_NOT_FOUND",
          message: `未找到交易记录：${parsed.data.symbol}`,
        });
      }
      const recordEvents = eventsBySymbol.get(parsed.data.symbol) ?? [];
      return { item: detail, events: recordEvents };
    }

    return { items };
  });
}

async function serializeRecordWithPnl(
  record: ExecutionRecordRow,
  recordClosedAt: number | null,
  recordEvents: AuditEvent[],
  now: number,
  deps: ExecutionPnlDeps,
): Promise<unknown> {
  const position = record.position;
  const closedAt = recordClosedAt;
  const heldMs = (closedAt ?? now) - position.openedAt;
  const currentPrice =
    record.status === "OPEN" && deps.latestPriceProvider
      ? await deps.latestPriceProvider(record.symbol).catch(() => undefined)
      : undefined;
  const fundingRate =
    deps.fundingRateProvider
      ? await deps.fundingRateProvider(record.symbol).catch(() => DEFAULT_FUNDING_RATE)
      : DEFAULT_FUNDING_RATE;

  const pnl = calculatePnlBreakdown({
    entryPrice: position.entryPrice,
    entryQuantity: position.initialQuantity,
    exits: extractExits(recordEvents),
    heldMs,
    currentPrice,
    remainingQuantity: record.status === "OPEN" ? position.remainingQuantity : 0,
    fundingRate,
  });

  return {
    symbol: record.symbol,
    status: record.status,
    openCount: recordEvents.filter((event) => event.type === "ENTRY_OPENED").length,
    closeCount: recordEvents.filter((event) => event.type === "POSITION_CLOSED").length,
    entryPrice: position.entryPrice,
    initialQuantity: position.initialQuantity,
    remainingQuantity: position.remainingQuantity,
    marginUsdt: position.marginUsdt,
    leverage: position.leverage,
    notionalUsdt: position.notionalUsdt,
    stopPrice: position.stopPrice,
    takeProfitLevelReached: position.takeProfitLevelReached,
    openedAt: position.openedAt,
    closedAt,
    updatedAt: record.updatedAt,
    pnl: {
      realizedPnl: pnl.realizedPnl,
      unrealizedPnl: pnl.unrealizedPnl,
      totalPnl: pnl.totalPnl,
      commission: pnl.commission,
      fundingFee: pnl.fundingFee,
      netPnl: pnl.netPnl,
      fundingPeriods: pnl.fundingPeriods,
    },
  };
}
