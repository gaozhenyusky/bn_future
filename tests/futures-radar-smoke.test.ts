import { describe, expect, it } from "vitest";

import { runFuturesSmoke } from "../scripts/futures-radar-smoke";

describe("runFuturesSmoke", () => {
  it("issues exactly one public exchangeInfo fetch and prints a futures-only perpetual summary", async () => {
    const calls: string[] = [];
    const logs: string[] = [];

    await runFuturesSmoke(
      {},
      {
        getFuturesExchangeInfo: async () => {
          calls.push("futures");
          return [
            {
              symbol: "HEIUSDT",
              pair: "HEIUSDT",
              baseAsset: "HEI",
              quoteAsset: "USDT",
              contractType: "PERPETUAL",
              status: "TRADING",
              onboardDate: 1,
            },
            {
              symbol: "OLDUSDT",
              pair: "OLDUSDT",
              baseAsset: "OLD",
              quoteAsset: "USDT",
              contractType: "PERPETUAL",
              status: "CLOSE",
              onboardDate: 1,
            },
            {
              symbol: "QBTCUSDT",
              pair: "QBTCUSDT",
              baseAsset: "QBTC",
              quoteAsset: "USDT",
              contractType: "CURRENT_QUARTER",
              status: "TRADING",
              onboardDate: 1,
            },
          ];
        },
      },
      {
        log(message) {
          logs.push(message);
        },
        error() {
          throw new Error("unexpected smoke error output");
        },
      },
    );

    expect(calls).toEqual(["futures"]);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      summary: "Binance Futures USDT perpetual exchange-info snapshot only; contract-only classification is not attempted in smoke mode.",
      connectorStatus: {
        bitgetReference:
          "Bitget reference factor is public read-only only; 429/418 or network failures are surfaced as unavailable without aggressive retry.",
      },
      tradingUsdtPerpetualCount: 1,
      sampleSymbols: ["HEIUSDT"],
    });
  });
});
