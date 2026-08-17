import type { OnchainGemCandidate, OnchainSnapshot } from "../domain/onchain";
import type { Queryable } from "./futures-repository";

export interface OnchainGemStore {
  loadSnapshot(): Promise<OnchainSnapshot | null>;
  saveSnapshot(snapshot: OnchainSnapshot): Promise<void>;
}

type CandidateRow = Record<string, unknown> & {
  chain_id: OnchainGemCandidate["chainId"];
  symbol: string;
  name: string | null;
  contract_address: string;
  logo_url: string | null;
  price: number | null;
  market_cap: number | null;
  liquidity: number | null;
  volume: number | null;
  price_change_percent: number | null;
  holders: number | null;
  holders_top10_percent: number | null;
  smart_money_inflow: number | null;
  smart_money_traders: number | null;
  smart_money_count: number | null;
  token_risk_level: number | null;
  launch_stage: OnchainGemCandidate["launchStage"] | null;
  direction: OnchainGemCandidate["direction"] | null;
  signal_status: string | null;
  wash_trading: boolean | null;
  dev_sold_all: boolean | null;
  score: number;
  status: OnchainGemCandidate["status"];
  data_completeness: OnchainGemCandidate["dataCompleteness"];
  sources: unknown;
  evidence: unknown;
  observed_at: number;
};

function jsonArray(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return jsonArray(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mapCandidate(row: CandidateRow): OnchainGemCandidate {
  return {
    chainId: row.chain_id,
    symbol: row.symbol,
    name: row.name ?? undefined,
    contractAddress: row.contract_address,
    logoUrl: row.logo_url ?? undefined,
    price: row.price ?? undefined,
    marketCap: row.market_cap ?? undefined,
    liquidity: row.liquidity ?? undefined,
    volume: row.volume ?? undefined,
    priceChangePercent: row.price_change_percent ?? undefined,
    holders: row.holders ?? undefined,
    holdersTop10Percent: row.holders_top10_percent ?? undefined,
    smartMoneyInflow: row.smart_money_inflow ?? undefined,
    smartMoneyTraders: row.smart_money_traders ?? undefined,
    smartMoneyCount: row.smart_money_count ?? undefined,
    tokenRiskLevel: row.token_risk_level ?? undefined,
    launchStage: row.launch_stage ?? undefined,
    direction: row.direction ?? undefined,
    signalStatus: row.signal_status ?? undefined,
    washTrading: row.wash_trading ?? undefined,
    devSoldAll: row.dev_sold_all ?? undefined,
    score: row.score,
    status: row.status,
    dataCompleteness: row.data_completeness,
    sources: jsonArray(row.sources) as OnchainGemCandidate["sources"],
    evidence: jsonArray(row.evidence),
    observedAt: row.observed_at,
  };
}

export class MysqlOnchainGemRepository implements OnchainGemStore {
  constructor(private readonly db: Queryable) {}

  async loadSnapshot(): Promise<OnchainSnapshot | null> {
    const result = await this.db.query<CandidateRow>(`
      SELECT chain_id, symbol, name, contract_address, logo_url, price, market_cap,
             liquidity, volume, price_change_percent, holders, holders_top10_percent,
             smart_money_inflow, smart_money_traders, smart_money_count, token_risk_level,
             launch_stage, direction, signal_status, wash_trading, dev_sold_all, score,
             status, data_completeness, sources, evidence, observed_at
      FROM onchain_gem_candidates
      ORDER BY score DESC, observed_at DESC
      LIMIT 200
    `);
    if (result.rows.length === 0) return null;
    return {
      candidates: result.rows.map(mapCandidate),
      statuses: [],
      scannedAt: Math.max(...result.rows.map((row) => row.observed_at)),
    };
  }

  async saveSnapshot(snapshot: OnchainSnapshot): Promise<void> {
    for (const candidate of snapshot.candidates) {
      await this.db.query(`
        INSERT INTO onchain_gem_candidates (
          chain_id, symbol, name, contract_address, logo_url, price, market_cap,
          liquidity, volume, price_change_percent, holders, holders_top10_percent,
          smart_money_inflow, smart_money_traders, smart_money_count, token_risk_level,
          launch_stage, direction, signal_status, wash_trading, dev_sold_all, score,
          status, data_completeness, sources, evidence, observed_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27
        )
        ON CONFLICT (chain_id, contract_address) DO UPDATE
        SET symbol = EXCLUDED.symbol,
            name = EXCLUDED.name,
            logo_url = EXCLUDED.logo_url,
            price = EXCLUDED.price,
            market_cap = EXCLUDED.market_cap,
            liquidity = EXCLUDED.liquidity,
            volume = EXCLUDED.volume,
            price_change_percent = EXCLUDED.price_change_percent,
            holders = EXCLUDED.holders,
            holders_top10_percent = EXCLUDED.holders_top10_percent,
            smart_money_inflow = EXCLUDED.smart_money_inflow,
            smart_money_traders = EXCLUDED.smart_money_traders,
            smart_money_count = EXCLUDED.smart_money_count,
            token_risk_level = EXCLUDED.token_risk_level,
            launch_stage = EXCLUDED.launch_stage,
            direction = EXCLUDED.direction,
            signal_status = EXCLUDED.signal_status,
            wash_trading = EXCLUDED.wash_trading,
            dev_sold_all = EXCLUDED.dev_sold_all,
            score = EXCLUDED.score,
            status = EXCLUDED.status,
            data_completeness = EXCLUDED.data_completeness,
            sources = EXCLUDED.sources,
            evidence = EXCLUDED.evidence,
            observed_at = EXCLUDED.observed_at
      `, [
        candidate.chainId,
        candidate.symbol,
        candidate.name ?? null,
        candidate.contractAddress,
        candidate.logoUrl ?? null,
        candidate.price ?? null,
        candidate.marketCap ?? null,
        candidate.liquidity ?? null,
        candidate.volume ?? null,
        candidate.priceChangePercent ?? null,
        candidate.holders ?? null,
        candidate.holdersTop10Percent ?? null,
        candidate.smartMoneyInflow ?? null,
        candidate.smartMoneyTraders ?? null,
        candidate.smartMoneyCount ?? null,
        candidate.tokenRiskLevel ?? null,
        candidate.launchStage ?? null,
        candidate.direction ?? null,
        candidate.signalStatus ?? null,
        candidate.washTrading ?? false,
        candidate.devSoldAll ?? false,
        candidate.score,
        candidate.status,
        candidate.dataCompleteness,
        candidate.sources,
        candidate.evidence,
        candidate.observedAt,
      ]);
    }
  }
}
