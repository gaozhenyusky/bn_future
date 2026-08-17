export type FuturesSymbolStatus = "TRADING" | "BREAK" | "CLOSE";

export type FuturesContractType = "PERPETUAL" | "CURRENT_QUARTER" | "NEXT_QUARTER" | string;

export type FuturesFilter =
  | {
      filterType: "PRICE_FILTER";
      minPrice: string;
      maxPrice: string;
      tickSize: string;
    }
  | {
      filterType: "LOT_SIZE";
      minQty: string;
      maxQty: string;
      stepSize: string;
    }
  | {
      filterType: "MARKET_LOT_SIZE";
      minQty: string;
      maxQty: string;
      stepSize: string;
    }
  | {
      filterType: string;
      [key: string]: string;
    };

export interface FuturesSymbolInfo {
  symbol: string;
  pair: string;
  baseAsset: string;
  quoteAsset: string;
  contractType: FuturesContractType;
  status: FuturesSymbolStatus | string;
  onboardDate: number;
  deliveryDate?: number;
  filters?: ReadonlyArray<FuturesFilter>;
}

export type SpotSymbolStatus = "TRADING" | "BREAK" | "HALT" | string;

export interface SpotSymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: SpotSymbolStatus;
}

export type ContractOnlyReason = "NO_ACTIVE_SPOT_BASE_ASSET" | "SPOT_BASE_ASSET_PRESENT";

export interface ContractUniverseItem extends FuturesSymbolInfo {
  isContractOnly: boolean;
  spotBaseAssetMatches: string[];
  contractOnlyReason: ContractOnlyReason;
}

export type FuturesKlineInterval = "5m" | "15m";

/** 市场 K 线周期：监控用 5m/15m，场景分析用 1h（不落库，仅计算） */
export type MarketKlineInterval = FuturesKlineInterval | "1h";

export interface FuturesCandle {
  symbol?: string;
  interval?: FuturesKlineInterval;
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteAssetVolume: string;
  tradeCount: number;
  takerBuyBaseAssetVolume: string;
  takerBuyQuoteAssetVolume: string;
  isClosed?: boolean;
  isBackfill?: boolean;
  isStartupSnapshot?: boolean;
  sourceTimestamp?: number;
  receivedTimestamp?: number;
  raw: unknown;
}

export type OpenInterestPeriod = "5m" | "15m";

export interface OpenInterestSnapshot {
  symbol: string;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

export interface TakerFlowSnapshot {
  symbol: string;
  buySellRatio: string;
  buyVol: string;
  sellVol: string;
  timestamp: number;
}

export interface FundingRateSnapshot {
  symbol: string;
  fundingRate: string;
  fundingTime: number;
}

/** 多空持仓人数比快照（Binance /futures/data/*） */
export interface LongShortRatioSnapshot {
  symbol: string;
  /** 多头账户占比（0-1） */
  longAccount: string;
  /** 空头账户占比（0-1） */
  shortAccount: string;
  /** 多/空比 */
  longShortRatio: string;
  timestamp: number;
}

export type MarketContextMissingField = "openInterest" | "previousOpenInterest" | "takerFlow" | "fundingRate";

export interface MarketContext {
  symbol: string;
  interval: FuturesKlineInterval;
  candleOpenTime: number;
  candleCloseTime: number;
  openInterest?: OpenInterestSnapshot;
  previousOpenInterest?: OpenInterestSnapshot;
  takerFlow?: TakerFlowSnapshot;
  fundingRate?: FundingRateSnapshot;
  isContractOnly?: boolean;
  contractOnlyReason?: ContractOnlyReason;
  spotBaseAssetMatches?: ReadonlyArray<string>;
  sourceTimestamp: number;
  receivedTimestamp: number;
  openInterestTimestamp?: number;
  takerFlowTimestamp?: number;
  fundingRateTimestamp?: number;
  isComplete: boolean;
  missing: ReadonlyArray<MarketContextMissingField>;
}

export type FuturesDataCompleteness = "COMPLETE" | "INSUFFICIENT_BASELINE" | "INCOMPLETE_CONTEXT";

export type FuturesPriceOiAlignment =
  | "PRICE_UP_OI_UP"
  | "PRICE_DOWN_OI_UP"
  | "PRICE_UP_OI_DOWN"
  | "PRICE_DOWN_OI_DOWN"
  | "FLAT_OI"
  | "FLAT_PRICE"
  | "UNAVAILABLE";

export type FuturesContractOnlyRiskLevel = "LOW" | "HIGH";

export interface FuturesContractOnlyRisk {
  level: FuturesContractOnlyRiskLevel;
  reason: ContractOnlyReason | "SPOT_BASE_ASSET_PRESENT";
}

export interface FuturesMetrics {
  symbol: string;
  interval: FuturesKlineInterval;
  candleOpenTime: number;
  candleCloseTime: number;
  volumeRatio: number;
  volumePercentile: number;
  oiValueDelta: number;
  oiUnitDelta: number;
  priceReturn: number;
  takerImbalance: number;
  liquidationRatio: number;
  priceOiAlignment: FuturesPriceOiAlignment;
  dataCompleteness: FuturesDataCompleteness;
  contractOnlyRisk: FuturesContractOnlyRisk;
  /** 跨交易所空头燃料因子（Binance/Gate 合约持仓结构，0-15 分） */
  shortFuelScore?: number;
  shortFuelLevel?: "HIGH" | "WARNING" | "INFO" | "NONE";
  shortFuelEvidence?: string[];
  /** 开仓场景（由 1h K 线分析得出） */
  breakoutContext?: "LOW_POSITION_BREAKOUT" | "HIGH_POSITION_RISK" | "NEUTRAL";
  positionPercentile?: number;
  /** 埋伏评分（不参考 OI，0-100） */
  ambushScore?: number;
  /** 最近 7 天振幅（横盘度） */
  sevenDayRange?: number;
}

export type FuturesSignalType =
  | "LONG_BUILDUP_CANDIDATE"
  | "SHORT_BUILDUP_CANDIDATE"
  | "SHORT_COVERING"
  | "LONG_LIQUIDATION"
  | "TURNOVER_ONLY"
  | "CONTRACT_ONLY_RISK"
  | "AMBUSH_CANDIDATE"
  | "FUTURES_OI_CONFLICT";

export type FuturesSignalSeverity = "INFO" | "WARNING" | "HIGH";

export interface FuturesSignal {
  signalType: FuturesSignalType;
  severity: FuturesSignalSeverity;
  confidence: number;
  explanation: string;
  evidence: string[];
  symbol: string;
  interval: FuturesKlineInterval;
  candleOpenTime: number;
  thresholdVersion: string;
  contractOnlyRisk?: FuturesContractOnlyRisk;
  /** 开仓场景（由 1h K 线分析得出，供执行层区分低位启动与高位风险） */
  breakoutContext?: "LOW_POSITION_BREAKOUT" | "HIGH_POSITION_RISK" | "NEUTRAL";
  positionPercentile?: number;
  move24h?: number;
  /** 开单模式：AMBUSH 表示低位空头燃料埋伏开单（放宽方向性门槛） */
  entryMode?: "STANDARD" | "AMBUSH";
  /** 跨交易所空头燃料分数（0-15） */
  shortFuelScore?: number;
}

export interface FuturesThresholds {
  volumeRatioThreshold: number;
  oiDeltaThreshold: number;
  flatOiDeltaTolerance: number;
  takerConfirmationThreshold: number;
  thresholdVersion: string;
}

export type FuturesOiAnomalyFactorCode =
  | "OI_DIRECTION"
  | "OI_THRESHOLD_BREAK"
  | "VOLUME_EXPANSION"
  | "PRICE_5M_EXPANSION"
  | "PRICE_OI_ALIGNMENT"
  | "TAKER_CONFIRMATION"
  | "CONTRACT_ONLY_RISK"
  | "DATA_INCOMPLETE"
  | "SHORT_FUEL";

export interface FuturesOiAnomalyFactor {
  code: FuturesOiAnomalyFactorCode;
  label: string;
  severity: "HIGH" | "WARNING" | "INFO";
  detail: string;
  value?: number;
}

export interface FuturesOiLeaderboardRow {
  rank: number;
  symbol: string;
  interval: FuturesKlineInterval;
  candleOpenTime: number;
  isContractOnly: boolean;
  contractOnlyReason: ContractOnlyReason;
  dataCompleteness: FuturesDataCompleteness;
  priceReturn: number;
  priceReturn5m: number;
  volumeRatio: number;
  oiValueDelta: number;
  oiUnitDelta: number;
  takerImbalance: number;
  priceOiAlignment: FuturesPriceOiAlignment;
  anomalyScore: number;
  factors: FuturesOiAnomalyFactor[];
  signals: FuturesSignal[];
  /** 当前市值（M USD，来自 Binance Alpha 板块） */
  marketCapM?: number;
  /** 开仓场景（由 1h K 线分析得出） */
  breakoutContext?: "LOW_POSITION_BREAKOUT" | "HIGH_POSITION_RISK" | "NEUTRAL";
  positionPercentile?: number;
  /** 埋伏评分（不参考 OI，0-100） */
  ambushScore?: number;
  sevenDayRange?: number;
}
