import { describe, expect, it } from "vitest";

import { GateFuturesRestClient, toGateContract } from "../src/connectors/gate-futures-rest";

describe("toGateContract", () => {
  it("转换 Binance 合约名为 Gate 合约名", () => {
    expect(toGateContract("AKEUSDT")).toBe("AKE_USDT");
    expect(toGateContract("1000BONKUSDT")).toBe("1000BONK_USDT");
    expect(toGateContract("BTCUSDT")).toBe("BTC_USDT");
  });
});

describe("GateFuturesRestClient", () => {
  it("拉取合约统计并映射为空头燃料数据", async () => {
    const requests: string[] = [];
    const client = new GateFuturesRestClient({
      baseUrl: "https://api.gateio.ws",
      fetchImpl: async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify([{
          time: 1_700_000_000,
          lsr_account: 0.41,
          lsr_taker: 1.24,
          top_lsr_account: 0.73,
          top_long_account: 55,
          top_short_account: 75,
          short_liq_usd_new: 858_000,
          open_interest_usd: 8_862_002.7,
          short_users: 2191,
          long_users: 902,
          last_funding_rate: "0.00005",
        }]), { status: 200 });
      },
    });

    const data = await client.getShortFuelData("AKEUSDT");

    expect(requests[0]).toContain("/api/v4/futures/usdt/contract_stats");
    expect(requests[0]).toContain("contract=AKE_USDT");
    expect(data).toEqual({
      lsrAccount: 0.41,
      topLsrAccount: 0.73,
      shortLiqUsd: 858_000,
      fundingRate: 0.00005,
    });
  });

  it("空响应返回 undefined", async () => {
    const client = new GateFuturesRestClient({
      fetchImpl: async () => new Response(JSON.stringify([]), { status: 200 }),
    });

    expect(await client.getShortFuelData("AKEUSDT")).toBeUndefined();
  });

  it("网络失败抛出类型化错误", async () => {
    const client = new GateFuturesRestClient({
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });

    await expect(client.getContractStats("AKEUSDT")).rejects.toMatchObject({ name: "GateFuturesError" });
  });

  it("HTTP 错误抛出类型化错误", async () => {
    const client = new GateFuturesRestClient({
      fetchImpl: async () => new Response(JSON.stringify({ message: "bad" }), { status: 404 }),
    });

    await expect(client.getContractStats("AKEUSDT")).rejects.toMatchObject({ status: 404 });
  });
});
