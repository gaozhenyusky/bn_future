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

interface RoundInput {
  entryPrice: number;
  entryQuantity: number;
  exits: PnlExit[];
  openedAt: number;
  closedAt: number | null;
}

/**
 * 把审计事件逐轮配对：每一条 ENTRY_OPENED 与其后（直到下一条 ENTRY_OPENED 之前）的
 * 部分止盈/平仓事件归为一轮。同一 symbol 反复开仓时，execution_positions 只保留最新
 * 一条记录，若把所有平仓都挂在最新开仓价下计算，PnL 会严重失真。
 * 事件按 occurred_at 升序传入。
 */
function groupRounds(events: AuditEvent[], fallbackEntryPrice: number, fallbackQuantity: number): RoundInput[] {
  const rounds: RoundInput[] = [];
  let current: RoundInput | null = null;

  for (const event of events) {
    if (event.type === "ENTRY_OPENED") {
      if (current) rounds.push(current);
      const qty = Number(event.details?.quantity);
      const price = Number(event.details?.entryPrice);
      current = {
        entryPrice: Number.isFinite(price) && price > 0 ? price : fallbackEntryPrice,
        entryQuantity: Number.isFinite(qty) && qty > 0 ? qty : fallbackQuantity,
        exits: [],
        openedAt: event.at,
        closedAt: null,
      };
    } else if (current && (event.type === "POSITION_PARTIALLY_EXITED" || event.type === "POSITION_CLOSED")) {
      const quantity = Number(event.details?.quantity);
      const price = Number(event.details?.price);
      if (Number.isFinite(quantity) && Number.isFinite(price) && quantity > 0 && price > 0) {
        current.exits.push({ price, quantity });
      }
      if (event.type === "POSITION_CLOSED") {
        current.closedAt = event.at;
        rounds.push(current);
        current = null;
      }
    }
  }
  if (current) rounds.push(current); // 仍未平仓的最后一轮
  return rounds;
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
  const currentPrice =
    record.status === "OPEN" && deps.latestPriceProvider
      ? await deps.latestPriceProvider(record.symbol).catch(() => undefined)
      : undefined;
  const fundingRate =
    deps.fundingRateProvider
      ? await deps.fundingRateProvider(record.symbol).catch(() => DEFAULT_FUNDING_RATE)
      : DEFAULT_FUNDING_RATE;

  // 逐轮配对：同一 symbol 反复开仓时按事件逐轮计算盈亏再汇总，避免所有平仓
  // 都挂在最新一轮开仓价下导致 PnL 失真。
  const rounds = groupRounds(recordEvents, position.entryPrice, position.initialQuantity);
  let realizedPnl = 0;
  let unrealizedPnl = 0;
  let commission = 0;
  let fundingFee = 0;
  let fundingPeriods = 0;

  for (const round of rounds) {
    const isOpen = round.closedAt === null;
    const heldMs = (round.closedAt ?? now) - round.openedAt;
    const breakdown = calculatePnlBreakdown({
      entryPrice: round.entryPrice,
      entryQuantity: round.entryQuantity,
      exits: round.exits,
      heldMs,
      currentPrice: isOpen ? currentPrice : undefined,
      remainingQuantity: isOpen ? position.remainingQuantity : 0,
      fundingRate,
    });
    realizedPnl += breakdown.realizedPnl;
    unrealizedPnl += breakdown.unrealizedPnl;
    commission += breakdown.commission;
    fundingFee += breakdown.fundingFee;
    fundingPeriods += breakdown.fundingPeriods;
  }

  const pnl = {
    realizedPnl,
    unrealizedPnl,
    totalPnl: realizedPnl + unrealizedPnl,
    commission,
    fundingFee,
    netPnl: realizedPnl + unrealizedPnl - commission - fundingFee,
    fundingPeriods,
  };

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
