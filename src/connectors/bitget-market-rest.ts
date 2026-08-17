import type {
  BitgetFundingRate,
  BitgetFuturesContract,
  BitgetFuturesTicker,
  BitgetMarketCandle,
  BitgetMarketInterval,
  BitgetOpenInterest,
  BitgetSpotSymbol,
  BitgetTicker,
} from "../domain/bitget-reference";
import { BitgetHttpClient, type BitgetHttpClientOptions } from "./bitget-http";

type JsonRecord = Record<string, unknown>;
type NowFn = () => number;

const FUTURES_PRODUCT_TYPE = "usdt-futures";

export class BitgetResponseError extends Error {
  readonly path: string;
  readonly context: string;
  readonly code: "MALFORMED_PAYLOAD";
  readonly cause?: unknown;

  constructor(options: { path: string; context: string; cause?: unknown }) {
    super(`Bitget returned a malformed ${options.context} payload for ${options.path}`);
    this.name = "BitgetResponseError";
    this.path = options.path;
    this.context = options.context;
    this.code = "MALFORMED_PAYLOAD";
    this.cause = options.cause;
  }
}

export interface BitgetMarketRestClientOptions {
  baseUrl?: string;
  proxyUrl?: string;
  timeoutMs?: number;
  retry?: BitgetHttpClientOptions["retry"];
  fetchImpl?: typeof fetch;
  sleep?: BitgetHttpClientOptions["sleep"];
  now?: NowFn;
}

function asObject(value: unknown, context: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object`);
  }

  return value as JsonRecord;
}

function asArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${context} must be an array`);
  }

  return value;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${context} must be a string`);
  }

  return value;
}

function parseFiniteNumber(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  const timestamp = parseFiniteNumber(value);
  return timestamp !== undefined ? timestamp : undefined;
}

function normalizeProductType(value: unknown): "usdt-futures" {
  if (typeof value !== "string" || value.toLowerCase() !== FUTURES_PRODUCT_TYPE) {
    throw new TypeError("futures contract productType must be USDT-FUTURES");
  }

  return FUTURES_PRODUCT_TYPE;
}

function intervalToMs(interval: BitgetMarketInterval): number {
  return interval === "5m" ? 300_000 : 900_000;
}

function toSpotGranularity(interval: BitgetMarketInterval): "5min" | "15min" {
  return interval === "5m" ? "5min" : "15min";
}

function toFuturesGranularity(interval: BitgetMarketInterval): BitgetMarketInterval {
  return interval;
}

function parseSpotSymbols(payload: unknown): BitgetSpotSymbol[] {
  return asArray(payload, "spot symbols").map((entry, index) => {
    const item = asObject(entry, `spot symbol ${index}`);
    return {
      symbol: asString(item.symbol, `spot symbol ${index}.symbol`),
      baseCoin: asString(item.baseCoin, `spot symbol ${index}.baseCoin`),
      quoteCoin: asString(item.quoteCoin, `spot symbol ${index}.quoteCoin`),
      status: asString(item.status, `spot symbol ${index}.status`),
    };
  });
}

function parseFuturesContracts(payload: unknown): BitgetFuturesContract[] {
  return asArray(payload, "futures contracts").map((entry, index) => {
    const item = asObject(entry, `futures contract ${index}`);
    return {
      symbol: asString(item.symbol, `futures contract ${index}.symbol`),
      baseCoin: asString(item.baseCoin, `futures contract ${index}.baseCoin`),
      quoteCoin: asString(item.quoteCoin, `futures contract ${index}.quoteCoin`),
      productType: normalizeProductType(item.productType),
      status: typeof item.status === "string" ? item.status : undefined,
      symbolType: typeof item.symbolType === "string" ? item.symbolType : undefined,
    };
  });
}

function parseCandleRows(
  payload: unknown,
  options: {
    context: string;
    symbol: string;
    interval: BitgetMarketInterval;
    receivedTimestamp: number;
    quoteVolumeIndex: number | ((row: unknown[], index: number) => number);
  },
): BitgetMarketCandle[] {
  const rows = asArray(payload, options.context);
  const closeWindowMs = intervalToMs(options.interval);

  return rows
    .map((entry, index) => {
      const row = asArray(entry, `${options.context} ${index}`);
      const quoteVolumeIndex =
        typeof options.quoteVolumeIndex === "function" ? options.quoteVolumeIndex(row, index) : options.quoteVolumeIndex;
      if (row.length <= quoteVolumeIndex) {
        throw new TypeError(`${options.context} ${index} must include at least ${quoteVolumeIndex + 1} fields`);
      }

      const openTime = parseTimestamp(row[0]);
      if (openTime === undefined) {
        throw new TypeError(`${options.context} ${index}.openTime must be a finite timestamp`);
      }

      return {
        symbol: options.symbol,
        interval: options.interval,
        openTime,
        open: parseFiniteNumber(row[1]),
        high: parseFiniteNumber(row[2]),
        low: parseFiniteNumber(row[3]),
        close: parseFiniteNumber(row[4]),
        volumeBase: parseFiniteNumber(row[5]),
        volumeQuote: parseFiniteNumber(row[quoteVolumeIndex]),
        sourceTimestamp: openTime,
        receivedTimestamp: options.receivedTimestamp,
        raw: row,
      };
    })
    .filter((candle) => candle.openTime + closeWindowMs <= options.receivedTimestamp);
}

function resolveSpotQuoteVolumeIndex(row: unknown[], index: number): number {
  if (row.length >= 8) {
    return 7;
  }

  if (row.length >= 7) {
    return 6;
  }

  throw new TypeError(`spot candles ${index} must include at least 7 fields`);
}

function parseSpotTicker(payload: unknown, symbol: string, receivedTimestamp: number): BitgetTicker | undefined {
  const item = asArray(payload, "spot ticker")
    .map((entry, index) => asObject(entry, `spot ticker ${index}`))
    .find((entry) => entry.symbol === symbol);

  if (!item) {
    return undefined;
  }

  return {
    symbol,
    lastPrice: parseFiniteNumber(item.lastPr),
    bidPrice: parseFiniteNumber(item.bidPr),
    askPrice: parseFiniteNumber(item.askPr),
    quoteVolume: parseFiniteNumber(item.usdtVolume) ?? parseFiniteNumber(item.quoteVolume),
    sourceTimestamp: parseTimestamp(item.ts),
    receivedTimestamp,
  };
}

function parseFuturesTicker(payload: unknown, symbol: string, receivedTimestamp: number): BitgetFuturesTicker | undefined {
  const item = asArray(payload, "futures ticker")
    .map((entry, index) => asObject(entry, `futures ticker ${index}`))
    .find((entry) => entry.symbol === symbol);

  if (!item) {
    return undefined;
  }

  return {
    symbol,
    lastPrice: parseFiniteNumber(item.lastPr),
    bidPrice: parseFiniteNumber(item.bidPr),
    askPrice: parseFiniteNumber(item.askPr),
    quoteVolume: parseFiniteNumber(item.quoteVolume) ?? parseFiniteNumber(item.usdtVolume),
    indexPrice: parseFiniteNumber(item.indexPrice),
    fundingRate: parseFiniteNumber(item.fundingRate),
    holdingAmount: parseFiniteNumber(item.holdingAmount),
    markPrice: parseFiniteNumber(item.markPrice),
    sourceTimestamp: parseTimestamp(item.ts),
    receivedTimestamp,
  };
}

function parseOpenInterest(payload: unknown, symbol: string, receivedTimestamp: number): BitgetOpenInterest | undefined {
  const root = asObject(payload, "open interest");
  const item = asArray(root.openInterestList, "open interest list")
    .map((entry, index) => asObject(entry, `open interest ${index}`))
    .find((entry) => entry.symbol === symbol);

  if (!item) {
    return undefined;
  }

  return {
    symbol,
    openInterest: parseFiniteNumber(item.size),
    sourceTimestamp: parseTimestamp(root.ts),
    receivedTimestamp,
  };
}

function parseFundingRate(payload: unknown, symbol: string, receivedTimestamp: number): BitgetFundingRate | undefined {
  const item = asArray(payload, "funding rate")
    .map((entry, index) => asObject(entry, `funding rate ${index}`))
    .find((entry) => entry.symbol === symbol);

  if (!item) {
    return undefined;
  }

  return {
    symbol,
    productType: FUTURES_PRODUCT_TYPE,
    fundingRate: parseFiniteNumber(item.fundingRate),
    fundingRateIntervalHours: parseFiniteNumber(item.fundingRateInterval),
    nextUpdate: parseTimestamp(item.nextUpdate),
    minFundingRate: parseFiniteNumber(item.minFundingRate),
    maxFundingRate: parseFiniteNumber(item.maxFundingRate),
    receivedTimestamp,
  };
}

export class BitgetMarketRestClient {
  private readonly http: BitgetHttpClient;
  private readonly now: NowFn;

  constructor(options: BitgetMarketRestClientOptions = {}) {
    this.http = new BitgetHttpClient({
      baseUrl: options.baseUrl,
      proxyUrl: options.proxyUrl,
      timeoutMs: options.timeoutMs,
      retry: options.retry,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
    });
    this.now = options.now ?? (() => Date.now());
  }

  async getSpotSymbols(): Promise<BitgetSpotSymbol[]> {
    return this.parseResponse("/api/v2/spot/public/symbols", "spot symbols", async () =>
      parseSpotSymbols(await this.http.getJson("/api/v2/spot/public/symbols", {})),
    );
  }

  async getFuturesContracts(): Promise<BitgetFuturesContract[]> {
    return this.parseResponse("/api/v2/mix/market/contracts", "futures contracts", async () =>
      parseFuturesContracts(
        await this.http.getJson("/api/v2/mix/market/contracts", {
          productType: FUTURES_PRODUCT_TYPE,
        }),
      ),
    );
  }

  async getSpotCandles(
    symbol: string,
    interval: BitgetMarketInterval,
    limit: number,
  ): Promise<BitgetMarketCandle[]> {
    const receivedTimestamp = this.now();
    return this.parseResponse("/api/v2/spot/market/candles", "spot candles", async () =>
      parseCandleRows(
        await this.http.getJson("/api/v2/spot/market/candles", {
          symbol,
          granularity: toSpotGranularity(interval),
          limit,
        }),
        {
          context: "spot candles",
          symbol,
          interval,
          receivedTimestamp,
          quoteVolumeIndex: resolveSpotQuoteVolumeIndex,
        },
      ),
    );
  }

  async getFuturesCandles(
    symbol: string,
    interval: BitgetMarketInterval,
    limit: number,
  ): Promise<BitgetMarketCandle[]> {
    const receivedTimestamp = this.now();
    return this.parseResponse("/api/v2/mix/market/candles", "futures candles", async () =>
      parseCandleRows(
        await this.http.getJson("/api/v2/mix/market/candles", {
          symbol,
          productType: FUTURES_PRODUCT_TYPE,
          granularity: toFuturesGranularity(interval),
          limit,
        }),
        {
          context: "futures candles",
          symbol,
          interval,
          receivedTimestamp,
          quoteVolumeIndex: 6,
        },
      ),
    );
  }

  async getSpotTicker(symbol: string): Promise<BitgetTicker | undefined> {
    const receivedTimestamp = this.now();
    return this.parseResponse("/api/v2/spot/market/tickers", "spot ticker", async () =>
      parseSpotTicker(
        await this.http.getJson("/api/v2/spot/market/tickers", {
          symbol,
        }),
        symbol,
        receivedTimestamp,
      ),
    );
  }

  async getFuturesTicker(symbol: string): Promise<BitgetFuturesTicker | undefined> {
    const receivedTimestamp = this.now();
    return this.parseResponse("/api/v2/mix/market/ticker", "futures ticker", async () =>
      parseFuturesTicker(
        await this.http.getJson("/api/v2/mix/market/ticker", {
          symbol,
          productType: FUTURES_PRODUCT_TYPE,
        }),
        symbol,
        receivedTimestamp,
      ),
    );
  }

  async getOpenInterest(symbol: string): Promise<BitgetOpenInterest | undefined> {
    const receivedTimestamp = this.now();
    return this.parseResponse("/api/v2/mix/market/open-interest", "open interest", async () =>
      parseOpenInterest(
        await this.http.getJson("/api/v2/mix/market/open-interest", {
          symbol,
          productType: FUTURES_PRODUCT_TYPE,
        }),
        symbol,
        receivedTimestamp,
      ),
    );
  }

  async getFundingRate(symbol: string): Promise<BitgetFundingRate | undefined> {
    const receivedTimestamp = this.now();
    return this.parseResponse("/api/v2/mix/market/current-fund-rate", "funding rate", async () =>
      parseFundingRate(
        await this.http.getJson("/api/v2/mix/market/current-fund-rate", {
          symbol,
          productType: FUTURES_PRODUCT_TYPE,
        }),
        symbol,
        receivedTimestamp,
      ),
    );
  }

  private async parseResponse<T>(path: string, context: string, parse: () => Promise<T> | T): Promise<T> {
    try {
      return await parse();
    } catch (error) {
      if (error instanceof BitgetResponseError) {
        throw error;
      }

      if (error instanceof TypeError) {
        throw new BitgetResponseError({
          path,
          context,
          cause: error,
        });
      }

      throw error;
    }
  }
}
