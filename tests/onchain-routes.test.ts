import { describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app";
import type { OnchainSnapshot } from "../src/domain/onchain";

const repository = {
  upsertContracts: async () => undefined,
  getClosedCandleBaseline: async () => [],
  saveCandle: async () => undefined,
  saveMarketContext: async () => undefined,
  saveMetrics: async () => undefined,
  saveSignal: async () => undefined,
  saveSignalIfNew: async () => true,
  saveSourceEvent: async () => undefined,
  getCheckpoint: async () => null,
  setCheckpoint: async () => undefined,
  listRadar: async () => [],
  listSignals: async () => [],
} as never;

const snapshot: OnchainSnapshot = {
  candidates: [{
    chainId: "56",
    symbol: "GEM",
    contractAddress: "0xabc",
    score: 7.5,
    status: "重点观察",
    dataCompleteness: "完整",
    sources: ["smart-money-inflow"],
    evidence: ["聪明钱净流入榜"],
    observedAt: 100,
  }],
  statuses: [{
    chainId: "56",
    source: "smart-money-inflow",
    status: "connected",
    updatedAt: 100,
  }],
  scannedAt: 100,
};

describe("onchain routes", () => {
  it("returns Chinese-labelled gem candidates and source status", async () => {
    const app = buildApp({
      repository,
      health: { connectors: {} },
      onchainService: {
        scan: async () => snapshot,
        getSnapshot: () => snapshot,
      },
    });

    const gems = await app.inject({ method: "GET", url: "/api/onchain/gems?chain=56&limit=10" });
    const status = await app.inject({ method: "GET", url: "/api/onchain/status" });

    expect(gems.statusCode).toBe(200);
    expect(gems.json()).toEqual({ items: snapshot.candidates, scannedAt: 100 });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ status: "connected", connected: 1, unavailable: 0 });
  });

  it("rejects unsupported chain filters", async () => {
    const app = buildApp({ repository, health: { connectors: {} }, onchainService: { scan: async () => snapshot, getSnapshot: () => snapshot } });

    const response = await app.inject({ method: "GET", url: "/api/onchain/gems?chain=1" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "INVALID_QUERY" });
  });
});
