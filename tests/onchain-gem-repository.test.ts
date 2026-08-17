import { describe, expect, it } from "vitest";
import type { OnchainSnapshot } from "../src/domain/onchain";
import { MysqlOnchainGemRepository } from "../src/storage/onchain-gem-repository";
import type { Queryable } from "../src/storage/futures-repository";

describe("MysqlOnchainGemRepository", () => {
  it("persists normalized candidates with JSON evidence and reads them back", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const snapshot: OnchainSnapshot = {
      candidates: [{
        chainId: "56",
        symbol: "GEM",
        contractAddress: "0xabc",
        score: 7.2,
        status: "重点观察",
        dataCompleteness: "完整",
        sources: ["smart-money-inflow", "meme-rush"],
        evidence: ["聪明钱净流入榜", "meme生命周期：已迁移"],
        observedAt: 123,
      }],
      statuses: [],
      scannedAt: 123,
    };
    const db = {
      async query(text: string, values?: readonly unknown[]) {
        calls.push({ text, values: values ?? [] });
        if (text.includes("SELECT chain_id")) {
          return { rows: [{
            chain_id: "56",
            symbol: "GEM",
            name: null,
            contract_address: "0xabc",
            logo_url: null,
            price: null,
            market_cap: null,
            liquidity: null,
            volume: null,
            price_change_percent: null,
            holders: null,
            holders_top10_percent: null,
            smart_money_inflow: null,
            smart_money_traders: null,
            smart_money_count: null,
            token_risk_level: null,
            launch_stage: null,
            direction: null,
            signal_status: null,
            wash_trading: false,
            dev_sold_all: false,
            score: 7.2,
            status: "重点观察",
            data_completeness: "完整",
            sources: JSON.stringify(["smart-money-inflow", "meme-rush"]),
            evidence: JSON.stringify(["聪明钱净流入榜", "meme生命周期：已迁移"]),
            observed_at: 123,
          }] };
        }
        return { rows: [] };
      },
    };
    const repository = new MysqlOnchainGemRepository(db as Queryable);

    await repository.saveSnapshot(snapshot);
    const loaded = await repository.loadSnapshot();

    expect(calls[0]?.text).toContain("ON CONFLICT (chain_id, contract_address)");
    expect(calls[0]?.values).toContain(snapshot.candidates[0]?.sources);
    expect(loaded?.candidates[0]).toMatchObject({
      symbol: "GEM",
      sources: ["smart-money-inflow", "meme-rush"],
      evidence: ["聪明钱净流入榜", "meme生命周期：已迁移"],
    });
  });
});
