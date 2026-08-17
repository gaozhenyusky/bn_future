import type {
  FundingRateSnapshot,
  FuturesCandle,
  FuturesKlineInterval,
  FuturesSymbolInfo,
  LongShortRatioSnapshot,
  MarketKlineInterval,
  OpenInterestPeriod,
  OpenInterestSnapshot,
  SpotSymbolInfo,
  TakerFlowSnapshot,
} from "../domain/futures";
import { BinanceHttpClient, BinanceResponseError, type BinanceHttpClientOptions } from "./binance-http";
import {
  parseFundingRateHistory,
  parseFuturesExchangeInfo,
  parseKlines,
  parseLongShortRatio,
  parseOpenInterestHistory,
  parseSpotExchangeInfo,
  parseTakerLongShortRatio,
} from "./binance-response";

export interface BinanceFuturesRestClientOptions {
  futuresBaseUrl?: string;
  spotBaseUrl?: string;
  proxyUrl?: string;
  timeoutMs?: number;
  retry?: BinanceHttpClientOptions["retry"];
  fetchImpl?: typeof fetch;
  sleep?: BinanceHttpClientOptions["sleep"];
}

export class BinanceFuturesRestClient {
  private readonly futuresHttp: BinanceHttpClient;
  private readonly spotHttp: BinanceHttpClient;

  constructor(options: BinanceFuturesRestClientOptions = {}) {
    const shared = {
      fetchImpl: options.fetchImpl,
      proxyUrl: options.proxyUrl,
      timeoutMs: options.timeoutMs,
      retry: options.retry,
      sleep: options.sleep,
    };

    this.futuresHttp = new BinanceHttpClient({
      baseUrl: options.futuresBaseUrl ?? "https://fapi.binance.com",
      ...shared,
    });
    this.spotHttp = new BinanceHttpClient({
      baseUrl: options.spotBaseUrl ?? "https://api.binance.com",
      ...shared,
    });
  }

  async getFuturesExchangeInfo(): Promise<FuturesSymbolInfo[]> {
    return this.parseResponse("/fapi/v1/exchangeInfo", "futures exchange info", async () =>
      parseFuturesExchangeInfo(await this.futuresHttp.getJson("/fapi/v1/exchangeInfo", {})),
    );
  }

  async getSpotExchangeInfo(): Promise<SpotSymbolInfo[]> {
    return this.parseResponse("/api/v3/exchangeInfo", "spot exchange info", async () =>
      parseSpotExchangeInfo(await this.spotHttp.getJson("/api/v3/exchangeInfo", {})),
    );
  }

  async getKlines(symbol: string, interval: MarketKlineInterval, limit: number): Promise<FuturesCandle[]> {
    return this.parseResponse("/fapi/v1/klines", "klines", async () =>
      parseKlines(
        await this.futuresHttp.getJson("/fapi/v1/klines", {
          symbol,
          interval,
          limit,
        }),
      ),
    );
  }

  async getOpenInterestHistory(
    symbol: string,
    period: OpenInterestPeriod,
    limit: number,
  ): Promise<OpenInterestSnapshot[]> {
    return this.parseResponse("/futures/data/openInterestHist", "open interest history", async () =>
      parseOpenInterestHistory(
        await this.futuresHttp.getJson("/futures/data/openInterestHist", {
          symbol,
          period,
          limit,
        }),
      ),
    );
  }

  async getTakerLongShortRatio(
    symbol: string,
    period: OpenInterestPeriod,
    limit: number,
  ): Promise<TakerFlowSnapshot[]> {
    return this.parseResponse("/futures/data/takerlongshortRatio", "taker long-short ratio", async () =>
      parseTakerLongShortRatio(
        await this.futuresHttp.getJson("/futures/data/takerlongshortRatio", {
          symbol,
          period,
          limit,
        }),
      ),
    );
  }

  async getFundingRateHistory(symbol: string, limit: number): Promise<FundingRateSnapshot[]> {
    return this.parseResponse("/fapi/v1/fundingRate", "funding rate history", async () =>
      parseFundingRateHistory(
        await this.futuresHttp.getJson("/fapi/v1/fundingRate", {
          symbol,
          limit,
        }),
      ),
    );
  }

  /** 全市场多空持仓人数比（公开数据接口） */
  async getGlobalLongShortAccountRatio(symbol: string, period: "5m" | "15m" | "1h" | "4h", limit = 1): Promise<LongShortRatioSnapshot[]> {
    return this.parseResponse("/futures/data/globalLongShortAccountRatio", "global long/short account ratio", async () =>
      parseLongShortRatio(
        await this.futuresHttp.getJson("/futures/data/globalLongShortAccountRatio", {
          symbol,
          period,
          limit,
        }),
      ),
    );
  }

  /** 大户持仓多空比（公开数据接口） */
  async getTopLongShortPositionRatio(symbol: string, period: "5m" | "15m" | "1h" | "4h", limit = 1): Promise<LongShortRatioSnapshot[]> {
    return this.parseResponse("/futures/data/topLongShortPositionRatio", "top trader long/short position ratio", async () =>
      parseLongShortRatio(
        await this.futuresHttp.getJson("/futures/data/topLongShortPositionRatio", {
          symbol,
          period,
          limit,
        }),
      ),
    );
  }

  private async parseResponse<T>(path: string, context: string, parse: () => Promise<T> | T): Promise<T> {
    try {
      return await parse();
    } catch (error) {
      if (error instanceof BinanceResponseError) {
        throw error;
      }

      if (error instanceof TypeError) {
        throw new BinanceResponseError({
          path,
          context,
          cause: error,
        });
      }

      throw error;
    }
  }
}
