import { createHmac } from "node:crypto";
import { ProxyAgent, type Dispatcher } from "undici";
import type { ExecutionAdapter, ExecutionMode, ExecutionOrder } from "./types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>;

type BinanceOrderPayload = {
  orderId?: number | string;
  clientOrderId?: string;
  symbol?: string;
  side?: "BUY" | "SELL";
  origQty?: string;
  executedQty?: string;
  avgPrice?: string;
  price?: string;
  status?: string;
};

export class BinanceDemoExecutionError extends Error {
  constructor(
    message: string,
    readonly unknownStatus = false,
    /** 合约在当前环境不存在：调用方应温和拒绝而不熔断 */
    readonly notListed = false,
    /** 温和拒绝（如实盘可用余额不足）：不熔断，等待后续信号 */
    readonly gentle = false,
  ) {
    super(message);
    this.name = "BinanceDemoExecutionError";
  }
}

function mapStatus(status: string | undefined): ExecutionOrder["status"] {
  switch (status) {
    case "FILLED":
      return "FILLED";
    case "NEW":
      return "OPEN";
    case "CANCELED":
    case "EXPIRED":
    case "EXPIRED_IN_MATCH":
      return "CANCELED";
    case "REJECTED":
      return "REJECTED";
    default:
      return "UNKNOWN";
  }
}

function mapOrder(
  payload: BinanceOrderPayload,
  input: {
    symbol: string;
    clientOrderId: string;
    quantity: number;
    price: number;
    side: "BUY" | "SELL";
    reduceOnly: boolean;
    type: ExecutionOrder["type"];
  },
): ExecutionOrder {
  return {
    orderId: String(payload.orderId ?? `unknown:${input.clientOrderId}`),
    clientOrderId: payload.clientOrderId ?? input.clientOrderId,
    symbol: payload.symbol ?? input.symbol,
    side: payload.side ?? input.side,
    quantity: Number(payload.executedQty ?? payload.origQty ?? input.quantity),
    price: Number(payload.avgPrice ?? payload.price ?? input.price),
    status: mapStatus(payload.status),
    reduceOnly: input.reduceOnly,
    type: input.type,
  };
}

export interface BinanceDemoExecutionAdapterOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  fetchImpl?: FetchLike;
  proxyUrl?: string;
  createProxyAgent?: (proxyUrl: string) => Dispatcher;
  recvWindowMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Signed USDⓈ-M Futures adapter for a configured Binance Demo/Testnet base.
 * The base URL is deliberately injected instead of guessed so a production
 * endpoint cannot be reached by merely selecting the demo mode.
 */
export class BinanceDemoExecutionAdapter implements ExecutionAdapter {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly recvWindowMs: number;
  private readonly timeoutMs: number;
  protected readonly now: () => number;
  private readonly lotSizeBySymbol = new Map<string, { step: number; minQty: number; maxQty: number }>();
  private readonly testnetPriceCache = new Map<string, { price: number; at: number }>();
  private listedSymbols?: Set<string>;
  // demo-fapi.binance.com 不支持 STOP_MARKET 条件单（返回 "Order type not
  // supported ... use the Algo Order API"），止损保护由引擎侧 K 线收盘检查
  // 兜底。这里把保护单登记为本地状态，保持引擎的保护单校验逻辑不变。
  private readonly localProtectionOrders = new Map<string, { orderId: string; stopPrice: number; quantity: number }>();
  private localProtectionSequence = 0;

  constructor(options: BinanceDemoExecutionAdapterOptions) {
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    const baseFetch = options.fetchImpl ?? fetch;
    const proxyUrl = options.proxyUrl?.trim();
    if (proxyUrl) {
      const createProxyAgent = options.createProxyAgent ?? ((value: string) => new ProxyAgent(value));
      const dispatcher = createProxyAgent(proxyUrl);
      this.fetchImpl = (input, init = {}) =>
        baseFetch(input, {
          ...init,
          dispatcher,
        });
    } else {
      this.fetchImpl = baseFetch;
    }
    this.recvWindowMs = options.recvWindowMs ?? 5_000;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.now = options.now ?? (() => Date.now());
  }

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
    await this.ensureSymbolListed(input.symbol);
    await this.request("POST", "/fapi/v1/leverage", {
      symbol: input.symbol,
      leverage: input.leverage,
    });
    // 测试网价格体系与主网不同（如主网 0.0001 级的币在测试网 minPrice 261），
    // 主网信号价算出的数量会超出测试网 LOT_SIZE。开仓数量按当前环境实时价格
    // 重算（保持 notional 语义），并按 step/min/max 调整。
    const marketPrice = await this.getMarketPrice(input.symbol);
    const targetQuantity = marketPrice > 0 ? input.notionalUsdt / marketPrice : input.quantity;
    const quantity = await this.adjustQuantity(input.symbol, targetQuantity);
    const payload = await this.request<BinanceOrderPayload>("POST", "/fapi/v1/order", {
      symbol: input.symbol,
      side: "BUY",
      positionSide: "BOTH",
      type: "MARKET",
      quantity,
      newClientOrderId: input.clientOrderId,
      newOrderRespType: "RESULT",
    });
    return mapOrder(payload, {
      symbol: input.symbol,
      clientOrderId: input.clientOrderId,
      quantity,
      price: input.entryPrice,
      side: "BUY",
      reduceOnly: false,
      type: "ENTRY",
    });
  }

  async placeReduceOnlyOrder(input: {
    symbol: string;
    clientOrderId: string;
    quantity: number;
    price: number;
    reason: "TAKE_PROFIT" | "STOP_LOSS" | "REVERSAL" | "CIRCUIT_BREAKER";
  }): Promise<ExecutionOrder> {
    const quantity = await this.adjustQuantity(input.symbol, input.quantity);
    const payload = await this.request<BinanceOrderPayload>("POST", "/fapi/v1/order", {
      symbol: input.symbol,
      side: "SELL",
      positionSide: "BOTH",
      type: "MARKET",
      quantity,
      reduceOnly: "true",
      newClientOrderId: input.clientOrderId,
      newOrderRespType: "RESULT",
    });
    return mapOrder(payload, {
      symbol: input.symbol,
      clientOrderId: input.clientOrderId,
      quantity,
      price: input.price,
      side: "SELL",
      reduceOnly: true,
      type: input.reason,
    });
  }

  async placeProtectionOrder(input: {
    symbol: string;
    clientOrderId: string;
    quantity: number;
    stopPrice: number;
  }): Promise<ExecutionOrder> {
    const quantity = await this.adjustQuantity(input.symbol, input.quantity);
    // Demo 环境不支持交易所止损单；本地登记保护价，引擎侧止损检查继续生效。
    this.localProtectionSequence += 1;
    const orderId = `local-protection:${this.localProtectionSequence}`;
    this.localProtectionOrders.set(input.symbol, { orderId, stopPrice: input.stopPrice, quantity });
    return {
      orderId,
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      side: "SELL",
      quantity,
      price: input.stopPrice,
      status: "OPEN",
      reduceOnly: true,
      type: "PROTECTION",
    };
  }

  async replaceProtectionOrder(input: {
    symbol: string;
    oldOrderId: string;
    clientOrderId: string;
    quantity: number;
    stopPrice: number;
  }): Promise<ExecutionOrder> {
    // 与 placeProtectionOrder 一致：本地替换保护价登记。
    this.localProtectionOrders.delete(input.symbol);
    return this.placeProtectionOrder(input);
  }

  /** 按 LOT_SIZE step/min/max 调整数量：向下取整到 step，并夹在 [minQty, maxQty] */
  protected async adjustQuantity(symbol: string, quantity: number): Promise<number> {
    let lot = this.lotSizeBySymbol.get(symbol);
    if (!lot) {
      lot = await this.loadLotSize(symbol);
      this.lotSizeBySymbol.set(symbol, lot);
    }
    const decimals = Math.max(0, Math.min(8, String(lot.step).split(".")[1]?.length ?? 0));
    const floored = Math.floor(quantity / lot.step) * lot.step;
    const clamped = Math.min(Math.max(floored, lot.minQty), lot.maxQty);
    return Number(clamped.toFixed(decimals));
  }

  /** 从公开 exchangeInfo 读取 LOT_SIZE（失败时回退宽松默认，不阻断下单） */
  private async loadLotSize(symbol: string): Promise<{ step: number; minQty: number; maxQty: number }> {
    try {
      const body = await this.request<{ symbols?: Array<{ symbol: string; filters?: Array<{ filterType?: string; stepSize?: string; minQty?: string; maxQty?: string }> }> }>("GET", "/fapi/v1/exchangeInfo", { symbol });
      const lotSize = body.symbols?.[0]?.filters?.find((filter) => filter.filterType === "LOT_SIZE");
      const step = Number(lotSize?.stepSize);
      const minQty = Number(lotSize?.minQty);
      const maxQty = Number(lotSize?.maxQty);
      return {
        step: Number.isFinite(step) && step > 0 ? step : 0.000001,
        minQty: Number.isFinite(minQty) && minQty > 0 ? minQty : 0.000001,
        maxQty: Number.isFinite(maxQty) && maxQty > 0 ? maxQty : Number.MAX_SAFE_INTEGER,
      };
    } catch {
      return { step: 0.000001, minQty: 0.000001, maxQty: Number.MAX_SAFE_INTEGER };
    }
  }

  /** 当前环境实时价格（10 秒缓存）；失败返回 0 由调用方回退信号价数量 */
  protected async getMarketPrice(symbol: string): Promise<number> {
    const cached = this.testnetPriceCache.get(symbol);
    if (cached && this.now() - cached.at < 10_000) {
      return cached.price;
    }
    try {
      const body = await this.request<{ price?: string }>("GET", "/fapi/v1/ticker/price", { symbol });
      const price = Number(body.price);
      if (Number.isFinite(price) && price > 0) {
        this.testnetPriceCache.set(symbol, { price, at: this.now() });
        return price;
      }
    } catch {
      // 忽略：调用方回退主网价数量。
    }
    return 0;
  }

  /** 合约必须存在于当前环境；不存在的合约温和拒绝，不熔断 */
  protected async ensureSymbolListed(symbol: string): Promise<void> {
    if (!this.listedSymbols) {
      try {
        const body = await this.request<{ symbols?: Array<{ symbol: string }> }>("GET", "/fapi/v1/exchangeInfo", {});
        this.listedSymbols = new Set(body.symbols?.map((item) => item.symbol) ?? []);
      } catch {
        // 拉取失败时不做存在性拦截（让真实下单决定结果）。
        return;
      }
    }
    if (this.listedSymbols.size > 0 && !this.listedSymbols.has(symbol)) {
      throw new BinanceDemoExecutionError(`Contract ${symbol} is not listed on this exchange`, false, true);
    }
  }

  protected async request<T = unknown>(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, unknown>): Promise<T> {
    // Binance 限制 clientOrderId < 36 字符；防御性截断（尾部保留区分度）。
    const safeParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      safeParams[key] = typeof value === "string" && key === "newClientOrderId" && value.length >= 36
        ? value.slice(0, 35)
        : value;
    }
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...safeParams, recvWindow: this.recvWindowMs, timestamp: this.now() })) {
      if (value !== undefined) query.set(key, String(value));
    }
    const payload = query.toString();
    const signature = createHmac("sha256", this.apiSecret).update(payload).digest("hex");
    // 超时保护：请求挂起时不能无限占用执行队列的并发槽位。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const response = await this.fetchImpl(`${this.baseUrl}${path}?${payload}&signature=${signature}`, {
      method,
      headers: {
        "X-MBX-APIKEY": this.apiKey,
      },
      signal: controller.signal,
    }).catch((error) => {
      throw new BinanceDemoExecutionError(`Binance network failure for ${path}`, true);
    }).finally(() => {
      clearTimeout(timer);
    });

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new BinanceDemoExecutionError(`Binance returned invalid JSON for ${path}`, true);
    }
    if (!response.ok) {
      const message = body && typeof body === "object" && "msg" in body && typeof body.msg === "string" ? body.msg : "request rejected";
      throw new BinanceDemoExecutionError(`Binance rejected ${path}: ${message}`, response.status >= 500);
    }
    return body as T;
  }
}

export interface BinanceProductionExecutionAdapterOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  fetchImpl?: FetchLike;
  proxyUrl?: string;
  createProxyAgent?: (proxyUrl: string) => Dispatcher;
  recvWindowMs?: number;
  timeoutMs?: number;
  now?: () => number;
  /** 开仓前要求可用保证金 ≥ 本次保证金 × 该倍数（默认 1.2），不足则温和拒绝 */
  minFreeMarginMultiplier?: number;
}

/**
 * Binance 实盘 USDⓈ-M adapter（BINANCE_PRODUCTION）。
 * 与 demo 子类的关键差异：
 * - 保护单为真实 STOP_MARKET reduce-only 挂单，挂不上即拒绝开仓；
 * - 开仓前校验可用保证金（可配倍数），不足时温和拒绝（不熔断）；
 * - 替换保护单会先在交易所撤销旧单再挂新单。
 * baseUrl 由调用方注入，main.ts 强制校验为 fapi.binance.com。
 */
export class BinanceProductionExecutionAdapter extends BinanceDemoExecutionAdapter {
  private readonly minFreeMarginMultiplier: number;
  private availableBalanceCache = new Map<string, { balance: number; at: number }>();

  constructor(options: BinanceProductionExecutionAdapterOptions) {
    super(options);
    this.minFreeMarginMultiplier = options.minFreeMarginMultiplier ?? 1.2;
  }

  override async placeEntryOrder(input: {
    symbol: string;
    clientOrderId: string;
    quantity: number;
    entryPrice: number;
    leverage: number;
    notionalUsdt: number;
    marginUsdt: number;
    mode: ExecutionMode;
  }): Promise<ExecutionOrder> {
    await this.ensureSymbolListed(input.symbol);
    // 实盘资金保护：可用保证金不足时温和拒绝，避免保证金不足导致下单被拒或爆仓。
    const available = await this.getAvailableUsdtBalance();
    const required = input.marginUsdt * this.minFreeMarginMultiplier;
    if (available !== undefined && available < required) {
      throw new BinanceDemoExecutionError(
        `Insufficient available USDT margin ${available.toFixed(2)} < required ${required.toFixed(2)}`,
        false,
        false,
        true,
      );
    }
    return super.placeEntryOrder(input);
  }

  override async placeProtectionOrder(input: {
    symbol: string;
    clientOrderId: string;
    quantity: number;
    stopPrice: number;
  }): Promise<ExecutionOrder> {
    const quantity = await this.adjustQuantity(input.symbol, input.quantity);
    const payload = await this.request<BinanceOrderPayload>("POST", "/fapi/v1/order", {
      symbol: input.symbol,
      side: "SELL",
      positionSide: "BOTH",
      type: "STOP_MARKET",
      stopPrice: input.stopPrice,
      quantity,
      reduceOnly: "true",
      newClientOrderId: input.clientOrderId,
      newOrderRespType: "RESULT",
    });
    const order = mapOrder(payload, {
      symbol: input.symbol,
      clientOrderId: input.clientOrderId,
      quantity,
      price: input.stopPrice,
      side: "SELL",
      reduceOnly: true,
      type: "PROTECTION",
    });
    // 保护单未挂上（NEW/REJECTED/未知）→ 抛错让引擎拒绝开仓并熔断。
    if (order.status !== "OPEN" && order.status !== "FILLED") {
      throw new BinanceDemoExecutionError(`Protection order not accepted (${order.status}) for ${input.symbol}`, true);
    }
    return order;
  }

  override async replaceProtectionOrder(input: {
    symbol: string;
    oldOrderId: string;
    clientOrderId: string;
    quantity: number;
    stopPrice: number;
  }): Promise<ExecutionOrder> {
    if (!input.oldOrderId.startsWith("local-protection:")) {
      // 真实挂单：先撤销旧保护单再挂新保护单；撤销失败视为未知状态（熔断兜底）。
      await this.request("DELETE", "/fapi/v1/order", {
        symbol: input.symbol,
        orderId: input.oldOrderId,
      });
    }
    return this.placeProtectionOrder(input);
  }

  /** 实盘可用保证金（USDT，10 秒缓存）；查询失败返回 undefined 由调用方跳过余额校验 */
  protected async getAvailableUsdtBalance(): Promise<number | undefined> {
    const cached = this.availableBalanceCache.get("USDT");
    if (cached && this.now() - cached.at < 10_000) {
      return cached.balance;
    }
    try {
      const body = await this.request<{ assets?: Array<{ asset?: string; availableBalance?: string }> }>("GET", "/fapi/v2/balance", {});
      const asset = body.assets?.find((item) => item.asset === "USDT");
      const balance = Number(asset?.availableBalance);
      if (Number.isFinite(balance)) {
        this.availableBalanceCache.set("USDT", { balance, at: this.now() });
        return balance;
      }
    } catch {
      // 忽略：跳过余额校验（让真实下单决定结果）。
    }
    return undefined;
  }
}
