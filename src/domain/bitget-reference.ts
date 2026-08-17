export type BitgetMarketInterval = "5m" | "15m";

export interface BitgetSpotSymbol {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  status: string;
}

export interface BitgetFuturesContract {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  productType: "usdt-futures";
  status?: string;
  symbolType?: string;
}

export interface BitgetMarketCandle {
  symbol: string;
  interval: BitgetMarketInterval;
  openTime: number;
  open: number | undefined;
  high: number | undefined;
  low: number | undefined;
  close: number | undefined;
  volumeBase: number | undefined;
  volumeQuote: number | undefined;
  sourceTimestamp: number;
  receivedTimestamp: number;
  raw: unknown;
}

export interface BitgetTicker {
  symbol: string;
  lastPrice: number | undefined;
  bidPrice: number | undefined;
  askPrice: number | undefined;
  quoteVolume: number | undefined;
  sourceTimestamp: number | undefined;
  receivedTimestamp: number;
}

export interface BitgetFuturesTicker extends BitgetTicker {
  indexPrice: number | undefined;
  fundingRate: number | undefined;
  holdingAmount: number | undefined;
  markPrice: number | undefined;
}

export interface BitgetOpenInterest {
  symbol: string;
  openInterest: number | undefined;
  sourceTimestamp: number | undefined;
  receivedTimestamp: number;
}

export interface BitgetFundingRate {
  symbol: string;
  productType: "usdt-futures";
  fundingRate: number | undefined;
  fundingRateIntervalHours: number | undefined;
  nextUpdate: number | undefined;
  minFundingRate: number | undefined;
  maxFundingRate: number | undefined;
  receivedTimestamp: number;
}

export type BitgetReferenceStatus =
  | "BITGET_CONFIRMED"
  | "BITGET_CONTRADICTED"
  | "BITGET_INCOMPLETE"
  | "BITGET_UNAVAILABLE";

export type BitgetReferenceCompleteness = "COMPLETE" | "PARTIAL" | "MISSING";

export type BitgetReferenceSignalBias = "LONG" | "SHORT" | null;

export type BitgetReferenceUnavailableField =
  | "spotCandles"
  | "futuresCandles"
  | "openInterest"
  | "fundingRate";

export type BitgetReferenceMissingField =
  | BitgetReferenceUnavailableField
  | "spotDirection"
  | "futuresDirection"
  | "spotQuoteVolumeRatio"
  | "futuresQuoteVolumeRatio"
  | "previousOpenInterest"
  | "priceGap"
  | "basis";

export interface BitgetReferenceThresholds {
  directionalReturnThreshold: number;
  oiDeltaThreshold: number;
  priceGapThreshold: number;
  confidenceAdjustmentCap: number;
}

export interface BitgetReferenceInput {
  symbol: string;
  interval: BitgetMarketInterval;
  candleOpenTime: number;
  signalType: string;
  signalBias: BitgetReferenceSignalBias;
  binanceOpen: number;
  binanceClose: number;
  binanceCloseTime: number;
  spotCandles?: ReadonlyArray<BitgetMarketCandle>;
  futuresCandles?: ReadonlyArray<BitgetMarketCandle>;
  openInterest?: BitgetOpenInterest;
  previousOpenInterest?: BitgetOpenInterest;
  fundingRate?: BitgetFundingRate;
  thresholds: BitgetReferenceThresholds;
  unavailable?: ReadonlyArray<BitgetReferenceUnavailableField>;
}

export interface BitgetReferenceFactor {
  provider: "bitget";
  symbol: string;
  interval: BitgetMarketInterval;
  candleOpenTime: number;
  signalType: string;
  signalBias: BitgetReferenceSignalBias;
  status: BitgetReferenceStatus;
  completeness: BitgetReferenceCompleteness;
  score: number;
  confidenceAdjustment: number;
  missing: ReadonlyArray<BitgetReferenceMissingField>;
  evidence: ReadonlyArray<string>;
  alignedSpotOpenTime?: number;
  alignedFuturesOpenTime?: number;
  spotPriceReturn?: number;
  futuresPriceReturn?: number;
  spotQuoteVolumeRatio?: number;
  futuresQuoteVolumeRatio?: number;
  oiDelta?: number;
  fundingRate?: number;
  basis?: number;
  priceGap?: number;
  observedAt: number;
}
