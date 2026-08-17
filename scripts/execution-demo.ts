// 自动模拟开平仓演示：注入一个满足全部开仓条件的测试信号，驱动执行引擎
// 完整跑通：开仓 → 分级止盈（+8% 平1/3 → +15% 平1/3）→ 末级 +25% 全平。
// 使用真实 MySQL 持久化（simulation 模式），记录保留在库中供前端展示。
import type {
  AuditEvent,
  AuditPort,
  ExecutionAdapter,
  ExecutionMode,
  ExecutionOrder,
  ExecutionSignal,
  MarketUpdate,
} from "../src/execution/types";
import { ExecutionEngine } from "../src/execution/execution-engine";
import { DemoExecutionRiskPolicy } from "../src/execution/risk-policy";
import { BinanceDemoExecutionAdapter } from "../src/execution/binance-demo-adapter";
import { BinanceFuturesRestClient } from "../src/connectors/binance-futures-rest";
import { MysqlExecutionPositionStore, MysqlExecutionAuditRepository } from "../src/storage/execution-repository";
import { MysqlExecutionSettingsRepository } from "../src/storage/execution-settings-repository";
import { ExecutionSettingsService } from "../src/services/execution-settings-service";
import { createMysqlPool } from "../src/storage/db";

// 每次运行生成唯一标的与时间戳，避免与历史演示记录冲突。
const T0 = Date.now() - 3_600_000;
const SYMBOL = `DEMO${String(T0 % 100_000).padStart(5, "0")}USDT`;
const DEDUPE_KEY = `${SYMBOL}:5m:${T0}`;

// 跟随 .env 执行模式：SIMULATION 纯内存模拟；BINANCE_DEMO_TESTNET 走币安官方测试网真实下单。
const EXECUTION_MODE = process.env.BINANCE_EXECUTION_MODE === "BINANCE_DEMO_TESTNET" ? "BINANCE_DEMO_TESTNET" : "SIMULATION";

// 仅允许白名单内的币安测试网域名，防止被引导到其它地址。
const ALLOWED_DEMO_BASE_URLS = new Set([
  "https://demo-fapi.binance.com",
  "https://testnet.binancefuture.com",
]);
function resolveDemoBaseUrl(): string {
  const baseUrl = (process.env.BINANCE_DEMO_FUTURES_REST_BASE_URL ?? "https://demo-fapi.binance.com").replace(/\/+$/, "");
  if (!ALLOWED_DEMO_BASE_URLS.has(baseUrl)) {
    throw new Error(`拒绝非白名单测试网地址：${baseUrl}`);
  }
  return baseUrl;
}

// 测试网模式必须使用测试网真实存在的合约（BTCUSDT），模拟模式用随机标的避免冲突。
const RUN_SYMBOL = EXECUTION_MODE === "BINANCE_DEMO_TESTNET" ? "BTCUSDT" : SYMBOL;
const RUN_DEDUPE_KEY = `${RUN_SYMBOL}:5m:${T0}`;

// 测试网模式使用真实价格计算数量；模拟模式固定 100。
let ENTRY_PRICE = 100;

class SimulationAdapter implements ExecutionAdapter {
  private sequence = 0;
  private order(input: Omit<ExecutionOrder, "orderId">): ExecutionOrder {
    this.sequence += 1;
    return { ...input, orderId: `simulation-${this.sequence}` };
  }
  async placeEntryOrder(input: {
    symbol: string; clientOrderId: string; quantity: number; entryPrice: number;
    leverage: number; notionalUsdt: number; marginUsdt: number; mode: ExecutionMode;
  }): Promise<ExecutionOrder> {
    return this.order({ symbol: input.symbol, clientOrderId: input.clientOrderId, quantity: input.quantity, price: input.entryPrice, status: "FILLED", side: "BUY", reduceOnly: false, type: "ENTRY" });
  }
  async placeReduceOnlyOrder(input: {
    symbol: string; clientOrderId: string; quantity: number; price: number;
    reason: "TAKE_PROFIT" | "STOP_LOSS" | "REVERSAL" | "MAX_HOLD_REACHED" | "CIRCUIT_BREAKER";
  }): Promise<ExecutionOrder> {
    return this.order({ symbol: input.symbol, clientOrderId: input.clientOrderId, quantity: input.quantity, price: input.price, status: "FILLED", side: "SELL", reduceOnly: true, type: input.reason });
  }
  async placeProtectionOrder(input: { symbol: string; clientOrderId: string; quantity: number; stopPrice: number }): Promise<ExecutionOrder> {
    return this.order({ symbol: input.symbol, clientOrderId: input.clientOrderId, quantity: input.quantity, price: input.stopPrice, status: "OPEN", side: "SELL", reduceOnly: true, type: "PROTECTION" });
  }
  async replaceProtectionOrder(input: { symbol: string; oldOrderId: string; clientOrderId: string; quantity: number; stopPrice: number }): Promise<ExecutionOrder> {
    return this.placeProtectionOrder(input);
  }
}

function createSignal(): ExecutionSignal {
  return {
    signalId: "demo-signal-1",
    dedupeKey: RUN_DEDUPE_KEY,
    symbol: RUN_SYMBOL,
    interval: "5m",
    detectedAt: T0,
    side: "LONG",
    isContractOnly: true,
    contractOnlyReason: "NO_ACTIVE_SPOT_BASE_ASSET",
    anomalyScore: 88,
    priceOiAlignment: "PRICE_UP_OI_UP",
    oiValueDelta: 0.11,
    oiDeltaThreshold: 0.05,
    volumeRatio: 2.4,
    volumeThreshold: 2,
    dataCompleteness: "COMPLETE",
    activeBuyConfirmed: true,
    slippageBps: 10,
    maxSlippageBps: 15,
    referencePrice: ENTRY_PRICE,
    entryPrice: ENTRY_PRICE,
  };
}

function createUpdate(overrides?: Partial<MarketUpdate>): MarketUpdate {
  return {
    symbol: RUN_SYMBOL,
    interval: "5m",
    price: 100,
    detectedAt: T0 + 300_000,
    has5mReversal: false,
    dataStreamOk: true,
    protectionOrderPresent: true,
    orderStatusKnown: true,
    ...overrides,
  };
}

const pool = createMysqlPool();
const db = pool as unknown as { query<T = { rows: never[] }>(text: string, values?: readonly unknown[]): Promise<T> };
const store = new MysqlExecutionPositionStore(db as never);
const mysqlAudit = new MysqlExecutionAuditRepository(db as never);
// 审计同时打印并写入 MySQL，保证前端时间线有完整明细。
const audit: AuditPort = {
  async record(event: AuditEvent): Promise<void> {
    const details = event.details ? ` ${JSON.stringify(event.details)}` : "";
    console.log(`  [audit] ${event.type}${event.reasonCode ? ` (${event.reasonCode})` : ""}${details}`);
    await mysqlAudit.record(event);
  },
};
const settingsService = new ExecutionSettingsService(new MysqlExecutionSettingsRepository(db as never));

function buildAdapter(): ExecutionAdapter {
  const base = EXECUTION_MODE === "BINANCE_DEMO_TESTNET"
    ? new BinanceDemoExecutionAdapter({
        apiKey: process.env.BINANCE_DEMO_API_KEY ?? "",
        apiSecret: process.env.BINANCE_DEMO_API_SECRET ?? "",
        baseUrl: process.env.BINANCE_DEMO_FUTURES_REST_BASE_URL ?? "https://demo-fapi.binance.com",
        proxyUrl: process.env.BINANCE_HTTP_PROXY,
      })
    : new SimulationAdapter();

  // 包装下单方法：失败时打印真实错误（定位用）。
  return new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args);
        } catch (error) {
          console.error(`  [adapter] ${String(prop)} 失败:`, error instanceof Error ? error.message : String(error));
          throw error;
        }
      };
    },
  });
}

const engine = new ExecutionEngine({
  mode: EXECUTION_MODE,
  adapter: buildAdapter(),
  riskPolicy: new DemoExecutionRiskPolicy({
    settingsProvider: () => settingsService.get(),
  }),
  positions: store,
  audit,
  settingsProvider: () => settingsService.get(),
});

async function main() {
  console.log(`\n=== 自动模拟开平仓演示（${RUN_SYMBOL} · ${EXECUTION_MODE}）===\n`);

  if (EXECUTION_MODE === "BINANCE_DEMO_TESTNET") {
    // 测试网模式：取真实价格计算数量，并清理该合约上一次演示的残留记录。
    await db.query("DELETE FROM execution_positions WHERE symbol = $1", [RUN_SYMBOL]);
    await db.query("DELETE FROM execution_audit_events WHERE symbol = $1", [RUN_SYMBOL]);
    await db.query("DELETE FROM execution_processed_signals WHERE dedupe_key = $1", [RUN_DEDUPE_KEY]);
    // 保留表对 symbol 有唯一约束，历史失败运行的残留行也需按 symbol 清理。
    await db.query("DELETE FROM execution_entry_reservations WHERE symbol = $1 OR dedupe_key = $2", [RUN_SYMBOL, RUN_DEDUPE_KEY]);
    // 测试网行情与主网一致，用公开行情客户端取最近收盘价用于计算下单数量。
    const marketClient = new BinanceFuturesRestClient({
      futuresBaseUrl: "https://fapi.binance.com",
      proxyUrl: process.env.BINANCE_HTTP_PROXY,
    });
    const candles = await marketClient.getKlines(RUN_SYMBOL, "5m", 1);
    ENTRY_PRICE = Number(candles[candles.length - 1]?.close ?? 100);
    console.log(`测试网实时价格：${RUN_SYMBOL} = ${ENTRY_PRICE} USDT`);
  }

  const settings = await settingsService.get();
  console.log(`当前执行设置：杠杆 ${settings.leverage}x · 开仓 ${settings.notionalUsdt} USDT · 评分门槛 ${settings.minEntryScore}`);
  console.log(`止盈分级：${settings.takeProfitLevels.map((l) => `+${l.pricePercent}% 平 ${(l.closeRatio * 100).toFixed(0)}%`).join(" → ")}`);
  console.log(`止损 -${settings.stopLossPercent}% · 时间兜底 ${settings.maxHoldMinutes} 分钟\n`);

  const tp1 = ENTRY_PRICE * 1.08;
  const tp2 = ENTRY_PRICE * 1.15;
  const tp3 = ENTRY_PRICE * 1.25;

  console.log("1️⃣ 注入合格信号（评分 88 ≥ 80、价格涨+OI 涨、主动买盘确认）");
  const open = await engine.handleSignal(createSignal());
  console.log(`   开仓结果：${open.status}`);
  const position = await store.getOpenPosition(RUN_SYMBOL);
  if (!position) {
    console.log("   未生成持仓，演示终止");
    return;
  }
  console.log(`   持仓：入场价 ${position.entryPrice} · 数量 ${position.initialQuantity} · 杠杆 ${position.leverage}x · 名义 ${position.notionalUsdt} USDT · 保护止损 ${position.stopPrice}`);

  console.log(`\n2️⃣ 价格涨到 ${tp1.toFixed(2)}（+8%），触发第一级止盈`);
  let result = await engine.handleMarketUpdate(createUpdate({ price: tp1, detectedAt: T0 + 300_000 }));
  console.log(`   结果：${result.status}`);
  let current = await store.getOpenPosition(RUN_SYMBOL);
  console.log(`   剩余 ${current?.remainingQuantity} · 止损上移至 ${current?.stopPrice} · 已触达止盈级 ${current?.takeProfitLevelReached}`);

  console.log(`\n3️⃣ 价格涨到 ${tp2.toFixed(2)}（+15%），触发第二级止盈`);
  result = await engine.handleMarketUpdate(createUpdate({ price: tp2, detectedAt: T0 + 600_000 }));
  console.log(`   结果：${result.status}`);
  current = await store.getOpenPosition(RUN_SYMBOL);
  console.log(`   剩余 ${current?.remainingQuantity} · 止损上移至 ${current?.stopPrice} · 已触达止盈级 ${current?.takeProfitLevelReached}`);

  console.log(`\n4️⃣ 价格涨到 ${tp3.toFixed(2)}（+25%），触发末级止盈，全部平仓`);
  result = await engine.handleMarketUpdate(createUpdate({ price: tp3, detectedAt: T0 + 900_000 }));
  console.log(`   结果：${result.status}`);
  console.log(`   持仓状态：${(await store.getOpenPosition(RUN_SYMBOL)) === undefined ? "已清仓" : "仍在持仓"}`);

  console.log("\n=== 演示结束 ===");
  console.log(`交易记录已保存到 MySQL（${RUN_SYMBOL}），可在前端「交易记录」页查看。\n`);
  await pool.end();
}

await main();
