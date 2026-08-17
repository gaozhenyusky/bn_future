import { describe, expect, it } from "vitest";
import type { OnchainObservation } from "../src/domain/onchain";
import { OnchainGemService, type OnchainGemConnector } from "../src/services/onchain-gem-service";

function observation(overrides: Partial<OnchainObservation>): OnchainObservation {
  return {
    chainId: "56",
    symbol: "GEM",
    contractAddress: "0xabc",
    source: "smart-money-inflow",
    evidence: ["聪明钱净流入榜"],
    observedAt: 100,
    ...overrides,
  };
}

function connector(overrides: Partial<OnchainGemConnector> = {}): OnchainGemConnector {
  return {
    fetchSmartMoneyInflow: async () => [observation({ smartMoneyInflow: 120_000, smartMoneyTraders: 8, liquidity: 60_000 })],
    fetchMemeRush: async () => [observation({ source: "meme-rush", launchStage: "已迁移", holdersTop10Percent: 22, evidence: ["meme生命周期：已迁移"] })],
    fetchSmartMoneySignals: async () => [observation({ source: "smart-money-signal", smartMoneyCount: 4, direction: "buy", evidence: ["聪明钱买入信号"] })],
    ...overrides,
  };
}

describe("OnchainGemService", () => {
  it("merges three Binance Web3 evidence streams, scores, and deduplicates candidates", async () => {
    const service = new OnchainGemService({ connector: connector(), now: () => 200 });

    const snapshot = await service.scan();

    const gem = snapshot.candidates.find((item) => item.contractAddress === "0xabc");
    expect(gem).toMatchObject({
      chainId: "56",
      score: 8.8,
      status: "重点观察",
      dataCompleteness: "完整",
      sources: ["smart-money-inflow", "meme-rush", "smart-money-signal"],
    });
    expect(gem?.evidence).toEqual(expect.arrayContaining(["聪明钱净流入榜", "meme生命周期：已迁移", "聪明钱买入信号"]));
    expect(snapshot.candidates.filter((item) => item.contractAddress === "0xabc")).toHaveLength(1);
    expect(snapshot.statuses).toHaveLength(8);
  });

  it("keeps partial results and marks a failed source unavailable", async () => {
    const service = new OnchainGemService({
      connector: connector({
        fetchMemeRush: async () => { throw new Error("provider down"); },
      }),
      now: () => 300,
    });

    const snapshot = await service.scan();

    expect(snapshot.candidates).not.toHaveLength(0);
    expect(snapshot.statuses.some((status) => status.source === "meme-rush" && status.status === "unavailable")).toBe(true);
    expect(snapshot.scannedAt).toBe(300);
  });
});
