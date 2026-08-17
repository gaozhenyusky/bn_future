import type { BitgetReferenceFactor } from "../domain/bitget-reference";
import {
  buildFuturesOiAnomalyFactors,
  calculateFuturesOiAnomalyScore,
  DEFAULT_FUTURES_OI_FACTOR_THRESHOLDS,
  deriveFuturesOiValueAlignment,
  type FuturesOiFactorThresholds,
} from "../analysis/futures-oi-factors";
import type {
  ContractOnlyReason,
  FuturesContractOnlyRisk,
  ContractUniverseItem,
  FuturesCandle,
  FuturesDataCompleteness,
  FuturesKlineInterval,
  FuturesMetrics,
  FuturesOiLeaderboardRow,
  FuturesPriceOiAlignment,
  FuturesSignal,
  FuturesSignalSeverity,
  MarketContext,
  OpenInterestSnapshot,
} from "../domain/futures";

type QueryResultRow = Record<string, unknown>;

export interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; affectedRows?: number }>;
}

export interface FuturesCleanupInput {
  hotCutoff: number;
  signalCutoff: number;
  sourceEventCutoff: number;
  batchSize: number;
}

export interface FuturesCleanupStats {
  candles: number;
  openInterest: number;
  metrics: number;
  references: number;
  signals: number;
  sourceEvents: number;
}

export interface FuturesCleanupRepository {
  cleanupHistoricalData(input: FuturesCleanupInput): Promise<FuturesCleanupStats>;
}

export interface FuturesRepository {
  upsertContracts(items: readonly ContractUniverseItem[]): Promise<void>;
  /** 批量更新合约市值（M USD），供 Binance Alpha 板块展示 */
  updateMarketCaps(marketCapBySymbol: ReadonlyMap<string, number>): Promise<void>;
  getClosedCandleBaseline(symbol: string, interval: FuturesKlineInterval, limit: number): Promise<FuturesCandle[]>;
  saveCandle(candle: FuturesCandle): Promise<void>;
  saveMarketContext(context: MarketContext): Promise<void>;
  saveMetrics(metrics: FuturesMetrics): Promise<void>;
  saveSignal(signal: FuturesSignal): Promise<void>;
  saveSignalIfNew(signal: FuturesSignal): Promise<boolean>;
  saveBitgetReference(factor: BitgetReferenceFactor): Promise<void>;
  getBitgetReference(
    symbol: string,
    interval: FuturesKlineInterval,
    candleOpenTime: number,
  ): Promise<BitgetReferenceFactor | undefined>;
  saveSourceEvent(event: FuturesSourceEvent): Promise<void>;
  getCheckpoint(stream: string): Promise<number | null>;
  setCheckpoint(stream: string, timestamp: number): Promise<void>;
  listRadar(query: FuturesRadarQuery): Promise<FuturesRadarRow[]>;
  listOiLeaderboard(query: FuturesOiLeaderboardQuery): Promise<FuturesOiLeaderboardRow[]>;
  listSignals(query: FuturesSignalsQuery): Promise<FuturesSignal[]>;
}

export interface FuturesSourceEvent {
  eventKey: string;
  eventType: string;
  symbol?: string;
  interval?: FuturesKlineInterval;
  sourceTimestamp: number;
  receivedTimestamp: number;
  payload: unknown;
}

export interface FuturesRadarQuery {
  interval?: FuturesKlineInterval;
  contractOnly?: boolean;
  minSeverity?: FuturesSignalSeverity;
  limit: number;
}

export interface FuturesSignalsQuery {
  symbol?: string;
  interval?: FuturesKlineInterval;
  from?: number;
  to?: number;
  limit: number;
}

export interface FuturesOiLeaderboardQuery {
  interval: FuturesKlineInterval;
  limit: number;
  /** 评分段：launch=启动评分（OI 主），ambush=埋伏评分（不参考 OI） */
  scoreType?: "launch" | "ambush";
  /** 市值上限（M USD）：埋伏段只展示市值不超过该值的合约 */
  maxMarketCapM?: number;
}

export interface FuturesRadarRow {
  symbol: string;
  interval: FuturesKlineInterval;
  signalType: FuturesSignal["signalType"];
  severity: FuturesSignalSeverity;
  confidence: number;
  explanation: string;
  evidence: string[];
  thresholdVersion: string;
  candleOpenTime: number;
  isContractOnly: boolean;
  contractOnlyReason: ContractOnlyReason;
  dataCompleteness: FuturesDataCompleteness;
  priceReturn: number;
  volumeRatio: number;
  oiValueDelta: number;
  takerImbalance: number;
  contractOnlyRisk?: FuturesContractOnlyRisk;
  bitgetReference?: BitgetReferenceFactor;
}

interface CandleRow extends QueryResultRow {
  symbol: string;
  interval: FuturesKlineInterval;
  open_time: number;
  open_price: string;
  high_price: string;
  low_price: string;
  close_price: string;
  volume: string;
  close_time: number;
  quote_asset_volume: string;
  trade_count: number;
  taker_buy_base_asset_volume: string;
  taker_buy_quote_asset_volume: string;
  is_closed: boolean;
  source_timestamp: number | null;
  received_timestamp: number | null;
  raw_payload: unknown;
}

interface CheckpointRow extends QueryResultRow {
  timestamp: number;
}

interface SignalRow extends QueryResultRow {
  symbol: string;
  interval: FuturesKlineInterval;
  candle_open_time: number;
  signal_type: FuturesSignal["signalType"];
  severity: FuturesSignalSeverity;
  confidence: number;
  explanation: string;
  evidence: unknown;
  threshold_version: string;
  contract_only_risk_level: FuturesContractOnlyRisk["level"] | null;
  contract_only_risk_reason: FuturesContractOnlyRisk["reason"] | null;
}

interface RadarRow extends SignalRow {
  is_contract_only: boolean | null;
  contract_only_reason: ContractOnlyReason | null;
  data_completeness: FuturesDataCompleteness | null;
  price_return: number | null;
  volume_ratio: number | null;
  oi_value_delta: number | null;
  taker_imbalance: number | null;
  factor_provider: "bitget" | null;
  factor_signal_type: string | null;
  factor_signal_bias: BitgetReferenceFactor["signalBias"] | null;
  factor_status: BitgetReferenceFactor["status"] | null;
  factor_completeness: BitgetReferenceFactor["completeness"] | null;
  factor_score: number | null;
  factor_confidence_adjustment: number | null;
  factor_missing: unknown;
  factor_evidence: unknown;
  factor_aligned_spot_open_time: number | null;
  factor_aligned_futures_open_time: number | null;
  factor_spot_price_return: number | null;
  factor_futures_price_return: number | null;
  factor_spot_quote_volume_ratio: number | null;
  factor_futures_quote_volume_ratio: number | null;
  factor_oi_delta: number | null;
  factor_funding_rate: number | null;
  factor_basis: number | null;
  factor_price_gap: number | null;
  factor_observed_at: number | null;
}

interface OiMetricRow extends QueryResultRow {
  symbol: string;
  interval: FuturesKlineInterval;
  candle_open_time: number;
  is_contract_only: boolean | null;
  contract_only_reason: ContractOnlyReason | null;
  data_completeness: FuturesDataCompleteness | null;
  price_return: number | null;
  volume_ratio: number | null;
  oi_value_delta: number | null;
  oi_unit_delta: number | null;
  taker_imbalance: number | null;
  price_oi_alignment: FuturesPriceOiAlignment | null;
  short_fuel_score: number | null;
  short_fuel_level: string | null;
  short_fuel_evidence: unknown;
  market_cap_m: number | null;
  breakout_context: string | null;
  position_percentile: number | null;
  ambush_score: number | null;
  seven_day_range: number | null;
}

interface BitgetReferenceRow extends QueryResultRow {
  symbol: string;
  interval: FuturesKlineInterval;
  candle_open_time: number;
  provider: "bitget";
  signal_type: string;
  signal_bias: BitgetReferenceFactor["signalBias"];
  status: BitgetReferenceFactor["status"];
  completeness: BitgetReferenceFactor["completeness"];
  score: number;
  confidence_adjustment: number;
  missing: unknown;
  evidence: unknown;
  aligned_spot_open_time: number | null;
  aligned_futures_open_time: number | null;
  spot_price_return: number | null;
  futures_price_return: number | null;
  spot_quote_volume_ratio: number | null;
  futures_quote_volume_ratio: number | null;
  oi_delta: number | null;
  funding_rate: number | null;
  basis: number | null;
  price_gap: number | null;
  observed_at: number;
}

function requireSymbol(symbol: string | undefined): string {
  if (!symbol) {
    throw new Error("Repository persistence requires a futures symbol");
  }

  return symbol;
}

function requireInterval(interval: FuturesKlineInterval | undefined): FuturesKlineInterval {
  if (!interval) {
    throw new Error("Repository persistence requires a futures interval");
  }

  return interval;
}

function createCandleKey(candle: Pick<FuturesCandle, "symbol" | "interval" | "openTime">): string {
  return `${requireSymbol(candle.symbol)}:${requireInterval(candle.interval)}:${candle.openTime}`;
}

function createSignalKey(signal: Pick<FuturesSignal, "symbol" | "interval" | "candleOpenTime" | "signalType" | "thresholdVersion">): string {
  return [
    signal.symbol,
    signal.interval,
    signal.candleOpenTime,
    signal.signalType,
    signal.thresholdVersion,
  ].join(":");
}

function createContractKey(contract: Pick<ContractUniverseItem, "symbol">): string {
  return contract.symbol;
}

function createOpenInterestKey(
  snapshot: Pick<OpenInterestSnapshot, "symbol" | "timestamp">,
  interval: FuturesKlineInterval,
): string {
  return `${snapshot.symbol}:${interval}:${snapshot.timestamp}`;
}

function createBitgetReferenceKey(
  factor: Pick<BitgetReferenceFactor, "symbol" | "interval" | "candleOpenTime" | "provider">,
): string {
  return `${factor.symbol}:${factor.interval}:${factor.candleOpenTime}:${factor.provider}`;
}

function getSeverityRank(severity: FuturesSignalSeverity): number {
  switch (severity) {
    case "HIGH":
      return 0;
    case "WARNING":
      return 1;
    case "INFO":
    default:
      return 2;
  }
}

function getAllowedSeverities(minSeverity: FuturesSignalSeverity | undefined): FuturesSignalSeverity[] {
  switch (minSeverity) {
    case "HIGH":
      return ["HIGH"];
    case "WARNING":
      return ["HIGH", "WARNING"];
    case "INFO":
    case undefined:
    default:
      return ["HIGH", "WARNING", "INFO"];
  }
}

function toEvidenceArray(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return toEvidenceArray(JSON.parse(value));
    } catch {
      return [];
    }
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function toOptionalNumber(value: number | null | undefined): number | undefined {
  return value ?? undefined;
}

function toMissingArray(value: unknown): BitgetReferenceFactor["missing"] {
  return toEvidenceArray(value) as BitgetReferenceFactor["missing"];
}

function toContractOnlyRisk(
  level: FuturesContractOnlyRisk["level"] | null,
  reason: FuturesContractOnlyRisk["reason"] | null,
): FuturesContractOnlyRisk | undefined {
  if (!level || !reason) {
    return undefined;
  }

  return { level, reason };
}

function mapSignalRow(row: SignalRow): FuturesSignal {
  return {
    symbol: row.symbol,
    interval: row.interval,
    candleOpenTime: row.candle_open_time,
    signalType: row.signal_type,
    severity: row.severity,
    confidence: row.confidence,
    explanation: row.explanation,
    evidence: toEvidenceArray(row.evidence),
    thresholdVersion: row.threshold_version,
    contractOnlyRisk: toContractOnlyRisk(row.contract_only_risk_level, row.contract_only_risk_reason),
  };
}

function mapBitgetReferenceRow(
  row:
    | BitgetReferenceRow
    | (RadarRow & {
        symbol: string;
        interval: FuturesKlineInterval;
        candle_open_time: number;
      }),
  prefix = "",
): BitgetReferenceFactor | undefined {
  const provider = row[`${prefix}provider` as keyof typeof row];
  if (provider !== "bitget") {
    return undefined;
  }

  return {
    provider: "bitget",
    symbol: row.symbol,
    interval: row.interval,
    candleOpenTime: row.candle_open_time,
    signalType: row[`${prefix}signal_type` as keyof typeof row] as string,
    signalBias: row[`${prefix}signal_bias` as keyof typeof row] as BitgetReferenceFactor["signalBias"],
    status: row[`${prefix}status` as keyof typeof row] as BitgetReferenceFactor["status"],
    completeness: row[`${prefix}completeness` as keyof typeof row] as BitgetReferenceFactor["completeness"],
    score: row[`${prefix}score` as keyof typeof row] as number,
    confidenceAdjustment: row[`${prefix}confidence_adjustment` as keyof typeof row] as number,
    missing: toMissingArray(row[`${prefix}missing` as keyof typeof row]),
    evidence: toEvidenceArray(row[`${prefix}evidence` as keyof typeof row]),
    alignedSpotOpenTime: toOptionalNumber(row[`${prefix}aligned_spot_open_time` as keyof typeof row] as number | null),
    alignedFuturesOpenTime: toOptionalNumber(
      row[`${prefix}aligned_futures_open_time` as keyof typeof row] as number | null,
    ),
    spotPriceReturn: toOptionalNumber(row[`${prefix}spot_price_return` as keyof typeof row] as number | null),
    futuresPriceReturn: toOptionalNumber(row[`${prefix}futures_price_return` as keyof typeof row] as number | null),
    spotQuoteVolumeRatio: toOptionalNumber(
      row[`${prefix}spot_quote_volume_ratio` as keyof typeof row] as number | null,
    ),
    futuresQuoteVolumeRatio: toOptionalNumber(
      row[`${prefix}futures_quote_volume_ratio` as keyof typeof row] as number | null,
    ),
    oiDelta: toOptionalNumber(row[`${prefix}oi_delta` as keyof typeof row] as number | null),
    fundingRate: toOptionalNumber(row[`${prefix}funding_rate` as keyof typeof row] as number | null),
    basis: toOptionalNumber(row[`${prefix}basis` as keyof typeof row] as number | null),
    priceGap: toOptionalNumber(row[`${prefix}price_gap` as keyof typeof row] as number | null),
    observedAt: row[`${prefix}observed_at` as keyof typeof row] as number,
  };
}

function mapRadarRow(row: RadarRow): FuturesRadarRow {
  const signal = mapSignalRow(row);

  return {
    ...signal,
    isContractOnly: row.is_contract_only ?? false,
    contractOnlyReason: row.contract_only_reason ?? "SPOT_BASE_ASSET_PRESENT",
    dataCompleteness: row.data_completeness ?? "COMPLETE",
    priceReturn: row.price_return ?? 0,
    volumeRatio: row.volume_ratio ?? 0,
    oiValueDelta: row.oi_value_delta ?? 0,
    takerImbalance: row.taker_imbalance ?? 0,
    bitgetReference: mapBitgetReferenceRow(row, "factor_"),
  };
}

function mapOiLeaderboardRow(
  row: OiMetricRow,
  signals: FuturesSignal[],
  rank: number,
  thresholdConfig: FuturesOiFactorThresholds,
): FuturesOiLeaderboardRow {
  const isContractOnly = row.is_contract_only ?? false;
  const dataCompleteness = row.data_completeness ?? "INCOMPLETE_CONTEXT";
  const priceReturn = row.price_return ?? 0;
  const priceReturn5m = row.interval === "5m" ? priceReturn : 0;
  const volumeRatio = row.volume_ratio ?? 0;
  const oiValueDelta = row.oi_value_delta ?? 0;
  const oiUnitDelta = row.oi_unit_delta ?? oiValueDelta;
  const takerImbalance = row.taker_imbalance ?? 0;
  const priceOiAlignment = deriveFuturesOiValueAlignment(priceReturn, oiValueDelta);
  const shortFuelScore = row.short_fuel_score ?? 0;
  const shortFuelEvidence = Array.isArray(row.short_fuel_evidence) ? row.short_fuel_evidence : [];
  const factorInput = {
    interval: row.interval,
    oiValueDelta,
    volumeRatio,
    priceReturn,
    priceReturn5m,
    takerImbalance,
    priceOiAlignment,
    dataCompleteness,
    isContractOnly,
    shortFuel:
      shortFuelScore > 0 || shortFuelEvidence.length > 0
        ? {
            score: shortFuelScore,
            level: (row.short_fuel_level ?? "NONE") as "HIGH" | "WARNING" | "INFO" | "NONE",
            evidence: shortFuelEvidence,
            dataAvailable: true,
          }
        : undefined,
  } as const;

  return {
    rank,
    symbol: row.symbol,
    interval: row.interval,
    candleOpenTime: row.candle_open_time,
    isContractOnly,
    contractOnlyReason: row.contract_only_reason ?? "SPOT_BASE_ASSET_PRESENT",
    dataCompleteness,
    priceReturn,
    priceReturn5m,
    volumeRatio,
    oiValueDelta,
    oiUnitDelta,
    takerImbalance,
    priceOiAlignment,
    anomalyScore: calculateFuturesOiAnomalyScore(factorInput, thresholdConfig),
    factors: buildFuturesOiAnomalyFactors(factorInput, thresholdConfig),
    signals,
    marketCapM: row.market_cap_m ?? undefined,
    breakoutContext: row.breakout_context as "LOW_POSITION_BREAKOUT" | "HIGH_POSITION_RISK" | "NEUTRAL" | undefined,
    positionPercentile: row.position_percentile ?? undefined,
    ambushScore: row.ambush_score ?? undefined,
    sevenDayRange: row.seven_day_range ?? undefined,
  };
}

function mapCandleRow(row: CandleRow): FuturesCandle {
  return {
    symbol: row.symbol,
    interval: row.interval,
    openTime: row.open_time,
    open: row.open_price,
    high: row.high_price,
    low: row.low_price,
    close: row.close_price,
    volume: row.volume,
    closeTime: row.close_time,
    quoteAssetVolume: row.quote_asset_volume,
    tradeCount: row.trade_count,
    takerBuyBaseAssetVolume: row.taker_buy_base_asset_volume,
    takerBuyQuoteAssetVolume: row.taker_buy_quote_asset_volume,
    isClosed: row.is_closed,
    sourceTimestamp: row.source_timestamp ?? undefined,
    receivedTimestamp: row.received_timestamp ?? undefined,
    raw: row.raw_payload,
  };
}

async function recordSourceEvent(
  db: Queryable,
  event: FuturesSourceEvent,
) {
  await db.query(
    `
      INSERT INTO source_events (
        event_key,
        event_type,
        symbol,
        interval,
        source_timestamp,
        received_timestamp,
        payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (event_key) DO UPDATE
      SET event_type = EXCLUDED.event_type,
          symbol = EXCLUDED.symbol,
          interval = EXCLUDED.interval,
          source_timestamp = EXCLUDED.source_timestamp,
          received_timestamp = EXCLUDED.received_timestamp,
          payload = EXCLUDED.payload
    `,
    [
      event.eventKey,
      event.eventType,
      event.symbol ?? null,
      event.interval ?? null,
      event.sourceTimestamp,
      event.receivedTimestamp,
      event.payload,
    ],
  );
}

async function upsertOpenInterestSnapshot(
  db: Queryable,
  interval: FuturesKlineInterval,
  snapshot: OpenInterestSnapshot,
  receivedTimestamp: number,
) {
  await db.query(
    `
      INSERT INTO futures_oi_snapshots (
        symbol,
        interval,
        timestamp,
        sum_open_interest,
        sum_open_interest_value,
        source_timestamp,
        received_timestamp
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (symbol, interval, timestamp) DO UPDATE
      SET sum_open_interest = EXCLUDED.sum_open_interest,
          sum_open_interest_value = EXCLUDED.sum_open_interest_value,
          source_timestamp = EXCLUDED.source_timestamp,
          received_timestamp = EXCLUDED.received_timestamp
    `,
    [
      snapshot.symbol,
      interval,
      snapshot.timestamp,
      snapshot.sumOpenInterest,
      snapshot.sumOpenInterestValue,
      snapshot.timestamp,
      receivedTimestamp,
    ],
  );

  await recordSourceEvent(db, {
    eventKey: `oi:${createOpenInterestKey(snapshot, interval)}`,
    eventType: "open_interest_snapshot",
    symbol: snapshot.symbol,
    interval,
    sourceTimestamp: snapshot.timestamp,
    receivedTimestamp,
    payload: snapshot,
  });
}

async function deleteInBatches(
  db: Queryable,
  statement: string,
  cutoff: number,
  batchSize: number,
): Promise<number> {
  let deleted = 0;

  while (true) {
    const result = await db.query(statement, [cutoff, batchSize]);
    const affectedRows = result.affectedRows ?? 0;
    deleted += affectedRows;
    if (affectedRows < batchSize) {
      return deleted;
    }
  }
}

export class PostgresFuturesRepository implements FuturesRepository {
  constructor(
    private readonly db: Queryable,
    private readonly oiFactorThresholds: FuturesOiFactorThresholds = DEFAULT_FUTURES_OI_FACTOR_THRESHOLDS,
  ) {}

  async upsertContracts(items: readonly ContractUniverseItem[]): Promise<void> {
    for (const item of items) {
      await this.db.query(
        `
          INSERT INTO futures_contracts (
            symbol,
            pair,
            base_asset,
            quote_asset,
            contract_type,
            status,
            onboard_date,
            delivery_date,
            filters,
            is_contract_only,
            spot_base_asset_matches,
            contract_only_reason
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (symbol) DO UPDATE
          SET pair = EXCLUDED.pair,
              base_asset = EXCLUDED.base_asset,
              quote_asset = EXCLUDED.quote_asset,
              contract_type = EXCLUDED.contract_type,
              status = EXCLUDED.status,
              onboard_date = EXCLUDED.onboard_date,
              delivery_date = EXCLUDED.delivery_date,
              filters = EXCLUDED.filters,
              is_contract_only = EXCLUDED.is_contract_only,
              spot_base_asset_matches = EXCLUDED.spot_base_asset_matches,
              contract_only_reason = EXCLUDED.contract_only_reason
        `,
        [
          item.symbol,
          item.pair,
          item.baseAsset,
          item.quoteAsset,
          item.contractType,
          item.status,
          item.onboardDate,
          item.deliveryDate ?? null,
          item.filters ?? null,
          item.isContractOnly,
          item.spotBaseAssetMatches,
          item.contractOnlyReason,
        ],
      );
    }
  }

  async updateMarketCaps(marketCapBySymbol: ReadonlyMap<string, number>): Promise<void> {
    for (const [symbol, marketCapM] of marketCapBySymbol) {
      await this.db.query(
        "UPDATE futures_contracts SET market_cap_m = $1 WHERE symbol = $2",
        [marketCapM, symbol],
      );
    }
  }

  async getClosedCandleBaseline(
    symbol: string,
    interval: FuturesKlineInterval,
    limit: number,
  ): Promise<FuturesCandle[]> {
    const rows = await this.db.query<CandleRow>(
      `
        SELECT
          symbol,
          interval,
          open_time,
          open_price,
          high_price,
          low_price,
          close_price,
          volume,
          close_time,
          quote_asset_volume,
          trade_count,
          taker_buy_base_asset_volume,
          taker_buy_quote_asset_volume,
          is_closed,
          source_timestamp,
          received_timestamp,
          raw_payload
        FROM futures_candles
        WHERE symbol = $1
          AND interval = $2
          AND is_closed = TRUE
        ORDER BY open_time DESC
        LIMIT $3
      `,
      [symbol, interval, limit],
    );

    return rows.rows.map(mapCandleRow).reverse();
  }

  async saveCandle(candle: FuturesCandle): Promise<void> {
    const symbol = requireSymbol(candle.symbol);
    const interval = requireInterval(candle.interval);

    await this.db.query(
      `
        INSERT INTO futures_candles (
          symbol,
          interval,
          open_time,
          open_price,
          high_price,
          low_price,
          close_price,
          volume,
          close_time,
          quote_asset_volume,
          trade_count,
          taker_buy_base_asset_volume,
          taker_buy_quote_asset_volume,
          is_closed,
          source_timestamp,
          received_timestamp,
          raw_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (symbol, interval, open_time) DO UPDATE
        SET open_price = EXCLUDED.open_price,
            high_price = EXCLUDED.high_price,
            low_price = EXCLUDED.low_price,
            close_price = EXCLUDED.close_price,
            volume = EXCLUDED.volume,
            close_time = EXCLUDED.close_time,
            quote_asset_volume = EXCLUDED.quote_asset_volume,
            trade_count = EXCLUDED.trade_count,
            taker_buy_base_asset_volume = EXCLUDED.taker_buy_base_asset_volume,
            taker_buy_quote_asset_volume = EXCLUDED.taker_buy_quote_asset_volume,
            is_closed = EXCLUDED.is_closed,
            source_timestamp = EXCLUDED.source_timestamp,
            received_timestamp = EXCLUDED.received_timestamp,
            raw_payload = EXCLUDED.raw_payload
      `,
      [
        symbol,
        interval,
        candle.openTime,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
        candle.closeTime,
        candle.quoteAssetVolume,
        candle.tradeCount,
        candle.takerBuyBaseAssetVolume,
        candle.takerBuyQuoteAssetVolume,
        candle.isClosed ?? false,
        candle.sourceTimestamp ?? null,
        candle.receivedTimestamp ?? null,
        candle.raw,
      ],
    );

    if (candle.sourceTimestamp !== undefined && candle.receivedTimestamp !== undefined) {
      await recordSourceEvent(this.db, {
        eventKey: `candle:${createCandleKey({ symbol, interval, openTime: candle.openTime })}`,
        eventType: "futures_candle",
        symbol,
        interval,
        sourceTimestamp: candle.sourceTimestamp,
        receivedTimestamp: candle.receivedTimestamp,
        payload: candle,
      });
    }
  }

  async saveMarketContext(context: MarketContext): Promise<void> {
    await this.db.query(
      `
        INSERT INTO futures_flow_metrics (
          symbol,
          interval,
          candle_open_time,
          candle_close_time,
          source_timestamp,
          received_timestamp,
          taker_buy_sell_ratio_raw,
          taker_buy_volume_raw,
          taker_sell_volume_raw,
          taker_flow_timestamp,
          funding_rate_raw,
          funding_rate_timestamp,
          is_contract_only,
          contract_only_reason,
          spot_base_asset_matches,
          is_complete,
          missing
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (symbol, interval, candle_open_time) DO UPDATE
        SET candle_close_time = EXCLUDED.candle_close_time,
            source_timestamp = EXCLUDED.source_timestamp,
            received_timestamp = EXCLUDED.received_timestamp,
            taker_buy_sell_ratio_raw = EXCLUDED.taker_buy_sell_ratio_raw,
            taker_buy_volume_raw = EXCLUDED.taker_buy_volume_raw,
            taker_sell_volume_raw = EXCLUDED.taker_sell_volume_raw,
            taker_flow_timestamp = EXCLUDED.taker_flow_timestamp,
            funding_rate_raw = EXCLUDED.funding_rate_raw,
            funding_rate_timestamp = EXCLUDED.funding_rate_timestamp,
            is_contract_only = EXCLUDED.is_contract_only,
            contract_only_reason = EXCLUDED.contract_only_reason,
            spot_base_asset_matches = EXCLUDED.spot_base_asset_matches,
            is_complete = EXCLUDED.is_complete,
            missing = EXCLUDED.missing
      `,
      [
        context.symbol,
        context.interval,
        context.candleOpenTime,
        context.candleCloseTime,
        context.sourceTimestamp,
        context.receivedTimestamp,
        context.takerFlow?.buySellRatio ?? null,
        context.takerFlow?.buyVol ?? null,
        context.takerFlow?.sellVol ?? null,
        context.takerFlowTimestamp ?? null,
        context.fundingRate?.fundingRate ?? null,
        context.fundingRateTimestamp ?? null,
        context.isContractOnly ?? null,
        context.contractOnlyReason ?? null,
        context.spotBaseAssetMatches ?? null,
        context.isComplete,
        context.missing,
      ],
    );

    if (context.openInterest) {
      await upsertOpenInterestSnapshot(this.db, context.interval, context.openInterest, context.receivedTimestamp);
    }

    if (context.previousOpenInterest) {
      await upsertOpenInterestSnapshot(this.db, context.interval, context.previousOpenInterest, context.receivedTimestamp);
    }

    if (context.takerFlow) {
      await recordSourceEvent(this.db, {
        eventKey: `taker-flow:${context.symbol}:${context.interval}:${context.takerFlow.timestamp}`,
        eventType: "taker_flow_snapshot",
        symbol: context.symbol,
        interval: context.interval,
        sourceTimestamp: context.takerFlow.timestamp,
        receivedTimestamp: context.receivedTimestamp,
        payload: context.takerFlow,
      });
    }

    if (context.fundingRate) {
      await recordSourceEvent(this.db, {
        eventKey: `funding-rate:${context.symbol}:${context.fundingRate.fundingTime}`,
        eventType: "funding_rate_snapshot",
        symbol: context.symbol,
        interval: context.interval,
        sourceTimestamp: context.fundingRate.fundingTime,
        receivedTimestamp: context.receivedTimestamp,
        payload: context.fundingRate,
      });
    }
  }

  async saveMetrics(metrics: FuturesMetrics): Promise<void> {
    await this.db.query(
      `
        INSERT INTO futures_flow_metrics (
          symbol,
          interval,
          candle_open_time,
          candle_close_time,
          volume_ratio,
          volume_percentile,
          oi_value_delta,
          oi_unit_delta,
          price_return,
          taker_imbalance,
          liquidation_ratio,
          price_oi_alignment,
          data_completeness,
          contract_only_risk_level,
          contract_only_risk_reason,
          short_fuel_score,
          short_fuel_level,
          short_fuel_evidence,
          breakout_context,
          position_percentile,
          ambush_score,
          seven_day_range
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
        ON CONFLICT (symbol, interval, candle_open_time) DO UPDATE
        SET candle_close_time = EXCLUDED.candle_close_time,
            volume_ratio = EXCLUDED.volume_ratio,
            volume_percentile = EXCLUDED.volume_percentile,
            oi_value_delta = EXCLUDED.oi_value_delta,
            oi_unit_delta = EXCLUDED.oi_unit_delta,
            price_return = EXCLUDED.price_return,
            taker_imbalance = EXCLUDED.taker_imbalance,
            liquidation_ratio = EXCLUDED.liquidation_ratio,
            price_oi_alignment = EXCLUDED.price_oi_alignment,
            data_completeness = EXCLUDED.data_completeness,
            contract_only_risk_level = EXCLUDED.contract_only_risk_level,
            contract_only_risk_reason = EXCLUDED.contract_only_risk_reason,
            short_fuel_score = EXCLUDED.short_fuel_score,
            short_fuel_level = EXCLUDED.short_fuel_level,
            short_fuel_evidence = EXCLUDED.short_fuel_evidence,
            breakout_context = EXCLUDED.breakout_context,
            position_percentile = EXCLUDED.position_percentile,
            ambush_score = EXCLUDED.ambush_score,
            seven_day_range = EXCLUDED.seven_day_range
      `,
      [
        metrics.symbol,
        metrics.interval,
        metrics.candleOpenTime,
        metrics.candleCloseTime,
        metrics.volumeRatio,
        metrics.volumePercentile,
        metrics.oiValueDelta,
        metrics.oiUnitDelta,
        metrics.priceReturn,
        metrics.takerImbalance,
        metrics.liquidationRatio,
        metrics.priceOiAlignment,
        metrics.dataCompleteness,
        metrics.contractOnlyRisk.level,
        metrics.contractOnlyRisk.reason,
        metrics.shortFuelScore ?? null,
        metrics.shortFuelLevel ?? null,
        metrics.shortFuelEvidence ?? [],
        metrics.breakoutContext ?? null,
        metrics.positionPercentile ?? null,
        metrics.ambushScore ?? null,
        metrics.sevenDayRange ?? null,
      ],
    );
  }

  async saveSignal(signal: FuturesSignal): Promise<void> {
    await this.db.query(
      `
        INSERT INTO futures_signals (
          symbol,
          interval,
          candle_open_time,
          signal_type,
          threshold_version,
          severity,
          confidence,
          explanation,
          evidence,
          contract_only_risk_level,
          contract_only_risk_reason
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (symbol, interval, candle_open_time, signal_type, threshold_version) DO UPDATE
        SET severity = EXCLUDED.severity,
            confidence = EXCLUDED.confidence,
            explanation = EXCLUDED.explanation,
            evidence = EXCLUDED.evidence,
            contract_only_risk_level = EXCLUDED.contract_only_risk_level,
            contract_only_risk_reason = EXCLUDED.contract_only_risk_reason
      `,
      [
        signal.symbol,
        signal.interval,
        signal.candleOpenTime,
        signal.signalType,
        signal.thresholdVersion,
        signal.severity,
        signal.confidence,
        signal.explanation,
        signal.evidence,
        signal.contractOnlyRisk?.level ?? null,
        signal.contractOnlyRisk?.reason ?? null,
      ],
    );
  }

  async saveSignalIfNew(signal: FuturesSignal): Promise<boolean> {
    const result = await this.db.query<{ created: number }>(
      `
        INSERT INTO futures_signals (
          symbol,
          interval,
          candle_open_time,
          signal_type,
          threshold_version,
          severity,
          confidence,
          explanation,
          evidence,
          contract_only_risk_level,
          contract_only_risk_reason
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (symbol, interval, candle_open_time, signal_type, threshold_version) DO NOTHING
        RETURNING 1 AS created
      `,
      [
        signal.symbol,
        signal.interval,
        signal.candleOpenTime,
        signal.signalType,
        signal.thresholdVersion,
        signal.severity,
        signal.confidence,
        signal.explanation,
        signal.evidence,
        signal.contractOnlyRisk?.level ?? null,
        signal.contractOnlyRisk?.reason ?? null,
      ],
    );

    return result.rows.length > 0;
  }

  async saveBitgetReference(factor: BitgetReferenceFactor): Promise<void> {
    await this.db.query(
      `
        INSERT INTO futures_reference_factors (
          symbol,
          interval,
          candle_open_time,
          provider,
          signal_type,
          signal_bias,
          status,
          completeness,
          score,
          confidence_adjustment,
          missing,
          evidence,
          aligned_spot_open_time,
          aligned_futures_open_time,
          spot_price_return,
          futures_price_return,
          spot_quote_volume_ratio,
          futures_quote_volume_ratio,
          oi_delta,
          funding_rate,
          basis,
          price_gap,
          observed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
        ON CONFLICT (symbol, interval, candle_open_time, provider) DO UPDATE
        SET provider = EXCLUDED.provider,
            signal_type = EXCLUDED.signal_type,
            signal_bias = EXCLUDED.signal_bias,
            status = EXCLUDED.status,
            completeness = EXCLUDED.completeness,
            score = EXCLUDED.score,
            confidence_adjustment = EXCLUDED.confidence_adjustment,
            missing = EXCLUDED.missing,
            evidence = EXCLUDED.evidence,
            aligned_spot_open_time = EXCLUDED.aligned_spot_open_time,
            aligned_futures_open_time = EXCLUDED.aligned_futures_open_time,
            spot_price_return = EXCLUDED.spot_price_return,
            futures_price_return = EXCLUDED.futures_price_return,
            spot_quote_volume_ratio = EXCLUDED.spot_quote_volume_ratio,
            futures_quote_volume_ratio = EXCLUDED.futures_quote_volume_ratio,
            oi_delta = EXCLUDED.oi_delta,
            funding_rate = EXCLUDED.funding_rate,
            basis = EXCLUDED.basis,
            price_gap = EXCLUDED.price_gap,
            observed_at = EXCLUDED.observed_at
      `,
      [
        factor.symbol,
        factor.interval,
        factor.candleOpenTime,
        "bitget",
        factor.signalType,
        factor.signalBias,
        factor.status,
        factor.completeness,
        factor.score,
        factor.confidenceAdjustment,
        factor.missing,
        factor.evidence,
        factor.alignedSpotOpenTime ?? null,
        factor.alignedFuturesOpenTime ?? null,
        factor.spotPriceReturn ?? null,
        factor.futuresPriceReturn ?? null,
        factor.spotQuoteVolumeRatio ?? null,
        factor.futuresQuoteVolumeRatio ?? null,
        factor.oiDelta ?? null,
        factor.fundingRate ?? null,
        factor.basis ?? null,
        factor.priceGap ?? null,
        factor.observedAt,
      ],
    );
  }

  async getBitgetReference(
    symbol: string,
    interval: FuturesKlineInterval,
    candleOpenTime: number,
  ): Promise<BitgetReferenceFactor | undefined> {
    const result = await this.db.query<BitgetReferenceRow>(
      `
        SELECT
          symbol,
          interval,
          candle_open_time,
          provider,
          signal_type,
          signal_bias,
          status,
          completeness,
          score,
          confidence_adjustment,
          missing,
          evidence,
          aligned_spot_open_time,
          aligned_futures_open_time,
          spot_price_return,
          futures_price_return,
          spot_quote_volume_ratio,
          futures_quote_volume_ratio,
          oi_delta,
          funding_rate,
          basis,
          price_gap,
          observed_at
        FROM futures_reference_factors
        WHERE symbol = $1
          AND interval = $2
          AND candle_open_time = $3
          AND provider = 'bitget'
        LIMIT 1
      `,
      [symbol, interval, candleOpenTime],
    );

    const row = result.rows[0];
    return row ? mapBitgetReferenceRow(row) : undefined;
  }

  async saveSourceEvent(event: FuturesSourceEvent): Promise<void> {
    await recordSourceEvent(this.db, event);
  }

  async getCheckpoint(stream: string): Promise<number | null> {
    const result = await this.db.query<CheckpointRow>(
      "SELECT timestamp FROM connector_checkpoints WHERE stream = $1",
      [stream],
    );

    return result.rows[0]?.timestamp ?? null;
  }

  async setCheckpoint(stream: string, timestamp: number): Promise<void> {
    await this.db.query(
      `
        INSERT INTO connector_checkpoints (stream, timestamp)
        VALUES ($1, $2)
        ON CONFLICT (stream) DO UPDATE
        SET timestamp = EXCLUDED.timestamp
        WHERE EXCLUDED.timestamp > connector_checkpoints.timestamp
      `,
      [stream, timestamp],
    );
  }

  async cleanupHistoricalData(input: FuturesCleanupInput): Promise<FuturesCleanupStats> {
    const [candles, openInterest, metrics, references, signals, sourceEvents] = await Promise.all([
      deleteInBatches(
        this.db,
        "DELETE FROM futures_candles WHERE COALESCE(received_timestamp, close_time) < $1 LIMIT $2",
        input.hotCutoff,
        input.batchSize,
      ),
      deleteInBatches(
        this.db,
        "DELETE FROM futures_oi_snapshots WHERE received_timestamp < $1 LIMIT $2",
        input.hotCutoff,
        input.batchSize,
      ),
      deleteInBatches(
        this.db,
        "DELETE FROM futures_flow_metrics WHERE COALESCE(received_timestamp, candle_close_time) < $1 LIMIT $2",
        input.hotCutoff,
        input.batchSize,
      ),
      deleteInBatches(
        this.db,
        "DELETE FROM futures_reference_factors WHERE observed_at < $1 LIMIT $2",
        input.hotCutoff,
        input.batchSize,
      ),
      deleteInBatches(
        this.db,
        "DELETE FROM futures_signals WHERE candle_open_time < $1 LIMIT $2",
        input.signalCutoff,
        input.batchSize,
      ),
      deleteInBatches(
        this.db,
        "DELETE FROM source_events WHERE received_timestamp < $1 LIMIT $2",
        input.sourceEventCutoff,
        input.batchSize,
      ),
    ]);

    return { candles, openInterest, metrics, references, signals, sourceEvents };
  }

  async listRadar(query: FuturesRadarQuery): Promise<FuturesRadarRow[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];

    if (query.interval) {
      values.push(query.interval);
      clauses.push(`s.interval = $${values.length}`);
    }

    if (query.contractOnly !== undefined) {
      values.push(query.contractOnly);
      clauses.push(`COALESCE(m.is_contract_only, false) = $${values.length}`);
    }

    const severities = getAllowedSeverities(query.minSeverity);
    const severityPlaceholders = severities.map((severity) => {
      values.push(severity);
      return `$${values.length}`;
    });
    clauses.push(`s.severity IN (${severityPlaceholders.join(", ")})`);

    values.push(query.limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const result = await this.db.query<RadarRow>(
      `
        SELECT
          s.symbol,
          s.interval,
          s.candle_open_time,
          s.signal_type,
          s.severity,
          s.confidence,
          s.explanation,
          s.evidence,
          s.threshold_version,
          s.contract_only_risk_level,
          s.contract_only_risk_reason,
          m.is_contract_only,
          m.contract_only_reason,
          m.data_completeness,
          m.price_return,
          m.volume_ratio,
          m.oi_value_delta,
          m.taker_imbalance,
          r.provider AS factor_provider,
          r.signal_type AS factor_signal_type,
          r.signal_bias AS factor_signal_bias,
          r.status AS factor_status,
          r.completeness AS factor_completeness,
          r.score AS factor_score,
          r.confidence_adjustment AS factor_confidence_adjustment,
          r.missing AS factor_missing,
          r.evidence AS factor_evidence,
          r.aligned_spot_open_time AS factor_aligned_spot_open_time,
          r.aligned_futures_open_time AS factor_aligned_futures_open_time,
          r.spot_price_return AS factor_spot_price_return,
          r.futures_price_return AS factor_futures_price_return,
          r.spot_quote_volume_ratio AS factor_spot_quote_volume_ratio,
          r.futures_quote_volume_ratio AS factor_futures_quote_volume_ratio,
          r.oi_delta AS factor_oi_delta,
          r.funding_rate AS factor_funding_rate,
          r.basis AS factor_basis,
          r.price_gap AS factor_price_gap,
          r.observed_at AS factor_observed_at
        FROM futures_signals s
        LEFT JOIN futures_flow_metrics m
          ON m.symbol = s.symbol
         AND m.interval = s.interval
         AND m.candle_open_time = s.candle_open_time
        LEFT JOIN futures_reference_factors r
          ON r.symbol = s.symbol
         AND r.interval = s.interval
         AND r.candle_open_time = s.candle_open_time
         AND r.provider = 'bitget'
        ${whereClause}
        ORDER BY
          CASE s.severity
            WHEN 'HIGH' THEN 0
            WHEN 'WARNING' THEN 1
            ELSE 2
          END,
          s.candle_open_time DESC,
          s.symbol ASC,
          s.interval ASC
        LIMIT $${values.length}
      `,
      values,
    );

    return result.rows.map(mapRadarRow);
  }

  async listOiLeaderboard(query: FuturesOiLeaderboardQuery): Promise<FuturesOiLeaderboardRow[]> {
    const result = await this.db.query<OiMetricRow>(
      `
        SELECT
          m.symbol,
          m.interval,
          m.candle_open_time,
          m.is_contract_only,
          m.contract_only_reason,
          m.data_completeness,
          m.price_return,
          m.volume_ratio,
          m.oi_value_delta,
          m.oi_unit_delta,
          m.taker_imbalance,
          m.price_oi_alignment,
          m.short_fuel_score,
          m.short_fuel_level,
          m.short_fuel_evidence,
          c.market_cap_m,
          m.breakout_context,
          m.position_percentile,
          m.ambush_score,
          m.seven_day_range
        FROM futures_flow_metrics m
        INNER JOIN futures_contracts c ON c.symbol = m.symbol
        WHERE m.interval = $1
          AND c.status = 'TRADING'
          AND c.quote_asset = 'USDT'
          AND c.contract_type = 'PERPETUAL'
          AND c.is_contract_only = TRUE
          AND c.market_cap_m IS NOT NULL
          AND m.is_contract_only = TRUE
          AND m.oi_value_delta IS NOT NULL
          AND m.candle_open_time >= (SELECT MAX(candle_open_time) FROM futures_flow_metrics WHERE interval_name = $2) - 900000
          AND ($3 IS NULL OR c.market_cap_m <= $4)
          AND NOT EXISTS (
            SELECT 1
            FROM futures_flow_metrics newer
            WHERE newer.symbol = m.symbol
              AND newer.interval = m.interval
              AND newer.is_contract_only = TRUE
              AND newer.oi_value_delta IS NOT NULL
              AND newer.candle_open_time > m.candle_open_time
          )
        ORDER BY m.symbol ASC, m.candle_open_time DESC
      `,
      [query.interval, query.interval, query.maxMarketCapM ?? null, query.maxMarketCapM ?? null],
    );

    const mappedItems: FuturesOiLeaderboardRow[] = [];
    for (const row of result.rows) {
      const signals = await this.listSignals({
        symbol: row.symbol,
        interval: row.interval,
        from: row.candle_open_time,
        to: row.candle_open_time,
        limit: 20,
      });
      mappedItems.push(mapOiLeaderboardRow(row, signals, 0, this.oiFactorThresholds));
    }

    return mappedItems
      .sort((left, right) => {
        // 按所选评分段排序：launch 用启动评分（OI 主），ambush 用埋伏评分（不参考 OI）。
        const scoreOrder =
          (query.scoreType === "ambush" ? right.ambushScore ?? 0 : right.anomalyScore) -
          (query.scoreType === "ambush" ? left.ambushScore ?? 0 : left.anomalyScore);
        if (scoreOrder !== 0) return scoreOrder;

        const oiOrder = Math.abs(right.oiValueDelta) - Math.abs(left.oiValueDelta);
        if (oiOrder !== 0) return oiOrder;

        const volumeOrder = right.volumeRatio - left.volumeRatio;
        if (volumeOrder !== 0) return volumeOrder;

        const timeOrder = right.candleOpenTime - left.candleOpenTime;
        if (timeOrder !== 0) return timeOrder;

        return left.symbol.localeCompare(right.symbol);
      })
      .slice(0, query.limit)
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }

  async listSignals(query: FuturesSignalsQuery): Promise<FuturesSignal[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];

    if (query.symbol) {
      values.push(query.symbol);
      clauses.push(`symbol = $${values.length}`);
    }

    if (query.interval) {
      values.push(query.interval);
      clauses.push(`interval = $${values.length}`);
    }

    if (query.from !== undefined) {
      values.push(query.from);
      clauses.push(`candle_open_time >= $${values.length}`);
    }

    if (query.to !== undefined) {
      values.push(query.to);
      clauses.push(`candle_open_time <= $${values.length}`);
    }

    values.push(query.limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const result = await this.db.query<SignalRow>(
      `
        SELECT
          symbol,
          interval,
          candle_open_time,
          signal_type,
          severity,
          confidence,
          explanation,
          evidence,
          threshold_version,
          contract_only_risk_level,
          contract_only_risk_reason
        FROM futures_signals
        ${whereClause}
        ORDER BY candle_open_time DESC, symbol ASC, interval ASC, signal_type ASC, threshold_version ASC
        LIMIT $${values.length}
      `,
      values,
    );

    return result.rows.map(mapSignalRow);
  }
}

export function createPostgresFuturesRepository(
  db: Queryable,
  thresholdConfig?: FuturesOiFactorThresholds,
): FuturesRepository & FuturesCleanupRepository {
  return new PostgresFuturesRepository(db, thresholdConfig);
}

export function createMysqlFuturesRepository(
  db: Queryable,
  thresholdConfig?: FuturesOiFactorThresholds,
): FuturesRepository & FuturesCleanupRepository {
  return new PostgresFuturesRepository(db, thresholdConfig);
}

export const storageKeys = {
  createCandleKey,
  createSignalKey,
  createContractKey,
  createOpenInterestKey,
  createBitgetReferenceKey,
};
