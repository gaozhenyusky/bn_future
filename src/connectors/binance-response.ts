import type {
  FundingRateSnapshot,
  FuturesCandle,
  FuturesFilter,
  FuturesSymbolInfo,
  LongShortRatioSnapshot,
  OpenInterestSnapshot,
  SpotSymbolInfo,
  TakerFlowSnapshot,
} from "../domain/futures";

type JsonRecord = Record<string, unknown>;

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

function asNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${context} must be a finite number`);
  }

  return value;
}

export function parseFuturesExchangeInfo(payload: unknown): FuturesSymbolInfo[] {
  const root = asObject(payload, "futures exchange info");
  return asArray(root.symbols, "futures exchange info symbols").map((entry, index) => {
    const symbol = asObject(entry, `futures symbol ${index}`);
    return {
      symbol: asString(symbol.symbol, `futures symbol ${index}.symbol`),
      pair: asString(symbol.pair, `futures symbol ${index}.pair`),
      baseAsset: asString(symbol.baseAsset, `futures symbol ${index}.baseAsset`),
      quoteAsset: asString(symbol.quoteAsset, `futures symbol ${index}.quoteAsset`),
      contractType: asString(symbol.contractType, `futures symbol ${index}.contractType`),
      status: asString(symbol.status, `futures symbol ${index}.status`),
      onboardDate: asNumber(symbol.onboardDate, `futures symbol ${index}.onboardDate`),
      deliveryDate:
        symbol.deliveryDate === undefined
          ? undefined
          : asNumber(symbol.deliveryDate, `futures symbol ${index}.deliveryDate`),
      filters:
        symbol.filters === undefined
          ? undefined
          : asArray(symbol.filters, `futures symbol ${index}.filters`).map((filter, filterIndex) =>
              asObject(filter, `futures symbol ${index}.filters[${filterIndex}]`) as FuturesFilter,
            ),
    };
  });
}

export function parseSpotExchangeInfo(payload: unknown): SpotSymbolInfo[] {
  const root = asObject(payload, "spot exchange info");
  return asArray(root.symbols, "spot exchange info symbols").map((entry, index) => {
    const symbol = asObject(entry, `spot symbol ${index}`);
    return {
      symbol: asString(symbol.symbol, `spot symbol ${index}.symbol`),
      baseAsset: asString(symbol.baseAsset, `spot symbol ${index}.baseAsset`),
      quoteAsset: asString(symbol.quoteAsset, `spot symbol ${index}.quoteAsset`),
      status: asString(symbol.status, `spot symbol ${index}.status`),
    };
  });
}

export function parseKlines(payload: unknown): FuturesCandle[] {
  return asArray(payload, "klines").map((entry, index) => {
    const row = asArray(entry, `kline ${index}`);
    if (row.length < 11) {
      throw new TypeError(`kline ${index} must include at least 11 fields`);
    }

    return {
      openTime: asNumber(row[0], `kline ${index}.openTime`),
      open: asString(row[1], `kline ${index}.open`),
      high: asString(row[2], `kline ${index}.high`),
      low: asString(row[3], `kline ${index}.low`),
      close: asString(row[4], `kline ${index}.close`),
      volume: asString(row[5], `kline ${index}.volume`),
      closeTime: asNumber(row[6], `kline ${index}.closeTime`),
      quoteAssetVolume: asString(row[7], `kline ${index}.quoteAssetVolume`),
      tradeCount: asNumber(row[8], `kline ${index}.tradeCount`),
      takerBuyBaseAssetVolume: asString(row[9], `kline ${index}.takerBuyBaseAssetVolume`),
      takerBuyQuoteAssetVolume: asString(row[10], `kline ${index}.takerBuyQuoteAssetVolume`),
      isClosed: row.length >= 12 && typeof row[11] === "boolean" ? row[11] : undefined,
      raw: row,
    };
  });
}

export function parseOpenInterestHistory(payload: unknown): OpenInterestSnapshot[] {
  return asArray(payload, "open interest history").map((entry, index) => {
    const item = asObject(entry, `open interest history ${index}`);
    return {
      symbol: asString(item.symbol, `open interest history ${index}.symbol`),
      sumOpenInterest: asString(item.sumOpenInterest, `open interest history ${index}.sumOpenInterest`),
      sumOpenInterestValue: asString(
        item.sumOpenInterestValue,
        `open interest history ${index}.sumOpenInterestValue`,
      ),
      timestamp: asNumber(item.timestamp, `open interest history ${index}.timestamp`),
    };
  });
}

export function parseTakerLongShortRatio(payload: unknown): TakerFlowSnapshot[] {
  return asArray(payload, "taker long-short ratio").map((entry, index) => {
    const item = asObject(entry, `taker long-short ratio ${index}`);
    return {
      // Binance takerlongshortRatio 响应不含 symbol 字段，兜底为空串。
      symbol: typeof item.symbol === "string" ? item.symbol : "",
      buySellRatio: asString(item.buySellRatio, `taker long-short ratio ${index}.buySellRatio`),
      buyVol: asString(item.buyVol, `taker long-short ratio ${index}.buyVol`),
      sellVol: asString(item.sellVol, `taker long-short ratio ${index}.sellVol`),
      timestamp: asNumber(item.timestamp, `taker long-short ratio ${index}.timestamp`),
    };
  });
}

export function parseFundingRateHistory(payload: unknown): FundingRateSnapshot[] {
  return asArray(payload, "funding rate history").map((entry, index) => {
    const item = asObject(entry, `funding rate history ${index}`);
    return {
      symbol: asString(item.symbol, `funding rate history ${index}.symbol`),
      fundingRate: asString(item.fundingRate, `funding rate history ${index}.fundingRate`),
      fundingTime: asNumber(item.fundingTime, `funding rate history ${index}.fundingTime`),
    };
  });
}

export function parseLongShortRatio(payload: unknown): LongShortRatioSnapshot[] {
  return asArray(payload, "long/short ratio").map((entry, index) => {
    const item = asObject(entry, `long/short ratio ${index}`);
    return {
      symbol: asString(item.symbol, `long/short ratio ${index}.symbol`),
      longAccount: asString(item.longAccount, `long/short ratio ${index}.longAccount`),
      shortAccount: asString(item.shortAccount, `long/short ratio ${index}.shortAccount`),
      longShortRatio: asString(item.longShortRatio, `long/short ratio ${index}.longShortRatio`),
      timestamp: asNumber(item.timestamp, `long/short ratio ${index}.timestamp`),
    };
  });
}
