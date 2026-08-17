import { ProxyAgent, type Dispatcher } from "undici";
import type { GateShortFuelData } from "../analysis/short-fuel";

type FetchInit = RequestInit & { dispatcher?: Dispatcher };
type FetchLike = (input: RequestInfo | URL, init?: FetchInit) => Promise<Response>;

export class GateFuturesError extends Error {
  readonly status?: number;
  readonly path: string;

  constructor(message: string, path: string, status?: number) {
    super(message);
    this.name = "GateFuturesError";
    this.status = status;
    this.path = path;
  }
}

export interface GateFuturesRestClientOptions {
  baseUrl?: string;
  proxyUrl?: string;
  createProxyAgent?: (proxyUrl: string) => Dispatcher;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface GateContractStats {
  time: number;
  /** 多/空账户人数比 */
  lsrAccount?: number;
  /** 主动买卖比 */
  lsrTaker?: number;
  /** 大户账户多/空比 */
  topLsrAccount?: number;
  /** 大户多头账户数 */
  topLongAccount?: number;
  /** 大户空头账户数 */
  topShortAccount?: number;
  /** 空头爆仓额（USD，新口径） */
  shortLiqUsd?: number;
  /** 多头爆仓额（USD） */
  longLiqUsd?: number;
  /** OI 名义价值（USD） */
  openInterestUsd?: number;
  /** 空头账户数 */
  shortUsers?: number;
  /** 多头账户数 */
  longUsers?: number;
  /** 资金费率 */
  lastFundingRate?: string;
}

type GateContractStatsRow = {
  time?: number;
  lsr_account?: string | number;
  lsr_taker?: string | number;
  top_lsr_account?: string | number;
  top_long_account?: string | number;
  top_short_account?: string | number;
  short_liq_usd_new?: string | number;
  long_liq_usd_new?: string | number;
  open_interest_usd?: string | number;
  short_users?: string | number;
  long_users?: string | number;
  last_funding_rate?: string;
};

function toOptionalNumber(value: string | number | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapContractStats(row: GateContractStatsRow | undefined): GateContractStats | undefined {
  if (!row) return undefined;
  return {
    time: Number(row.time ?? 0),
    lsrAccount: toOptionalNumber(row.lsr_account),
    lsrTaker: toOptionalNumber(row.lsr_taker),
    topLsrAccount: toOptionalNumber(row.top_lsr_account),
    topLongAccount: toOptionalNumber(row.top_long_account),
    topShortAccount: toOptionalNumber(row.top_short_account),
    shortLiqUsd: toOptionalNumber(row.short_liq_usd_new),
    longLiqUsd: toOptionalNumber(row.long_liq_usd_new),
    openInterestUsd: toOptionalNumber(row.open_interest_usd),
    shortUsers: toOptionalNumber(row.short_users),
    longUsers: toOptionalNumber(row.long_users),
    lastFundingRate: row.last_funding_rate,
  };
}

/** Binance 合约 symbol（如 AKEUSDT）→ Gate 合约（如 AKE_USDT） */
export function toGateContract(symbol: string): string {
  if (symbol.endsWith("USDT")) {
    return `${symbol.slice(0, -4)}_USDT`;
  }
  return symbol;
}

export class GateFuturesRestClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: GateFuturesRestClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.gateio.ws").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 8_000;
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
  }

  /** 合约统计：多空账户比、大户多空、空头爆仓、OI（公开接口） */
  async getContractStats(symbol: string, limit = 1): Promise<GateContractStats | undefined> {
    const payload = await this.getJson<GateContractStatsRow[]>("/api/v4/futures/usdt/contract_stats", {
      contract: toGateContract(symbol),
      limit,
    });
    return mapContractStats(payload[0]);
  }

  /** 简化为空头燃料因子所需字段 */
  async getShortFuelData(symbol: string): Promise<GateShortFuelData | undefined> {
    const stats = await this.getContractStats(symbol, 1);
    if (!stats) return undefined;
    return {
      lsrAccount: numberOrUndefined(stats.lsrAccount),
      topLsrAccount: numberOrUndefined(stats.topLsrAccount),
      shortLiqUsd: numberOrUndefined(stats.shortLiqUsd),
      fundingRate: parseFundingRate(stats.lastFundingRate),
    };
  }

  private async getJson<T>(path: string, query: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: controller.signal });
    } catch {
      throw new GateFuturesError(`Gate Futures network failure for ${path}`, path);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new GateFuturesError(`Gate Futures rejected ${path} (HTTP ${response.status})`, path, response.status);
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new GateFuturesError(`Gate Futures returned invalid JSON for ${path}`, path);
    }
  }
}

function numberOrUndefined(value: number | string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFundingRate(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
