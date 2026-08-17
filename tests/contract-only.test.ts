import { describe, expect, it } from "vitest";
import { buildContractUniverse } from "../src/analysis/contract-only";

describe("contract-only classification", () => {
  it("marks a Futures base asset with no active Spot base asset as contract-only", () => {
    const result = buildContractUniverse(
      [
        {
          symbol: "HEIUSDT",
          pair: "HEIUSDT",
          baseAsset: "HEI",
          quoteAsset: "USDT",
          contractType: "PERPETUAL",
          status: "TRADING",
          onboardDate: 1,
        },
      ],
      [],
    );

    expect(result[0].isContractOnly).toBe(true);
    expect(result[0].contractOnlyReason).toBe("NO_ACTIVE_SPOT_BASE_ASSET");
  });

  it("does not mark a Futures symbol as contract-only when an active Spot pair exists", () => {
    const result = buildContractUniverse(
      [
        {
          symbol: "BANKUSDT",
          pair: "BANKUSDT",
          baseAsset: "BANK",
          quoteAsset: "USDT",
          contractType: "PERPETUAL",
          status: "TRADING",
          onboardDate: 1,
        },
      ],
      [{ symbol: "BANKUSDT", baseAsset: "BANK", quoteAsset: "USDT", status: "TRADING" }],
    );

    expect(result[0].isContractOnly).toBe(false);
    expect(result[0].spotBaseAssetMatches).toEqual(["BANK"]);
  });

  it("excludes non-trading or non-perpetual Futures symbols from the default universe", () => {
    const result = buildContractUniverse(
      [
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
          symbol: "QUARTERUSDT",
          pair: "QUARTERUSDT",
          baseAsset: "QUARTER",
          quoteAsset: "USDT",
          contractType: "CURRENT_QUARTER",
          status: "TRADING",
          onboardDate: 1,
        },
      ],
      [],
    );

    expect(result).toEqual([]);
  });

  it("filters inactive Spot matches and sorts the default universe by symbol ascending", () => {
    const result = buildContractUniverse(
      [
        {
          symbol: "ZETAUSDT",
          pair: "ZETAUSDT",
          baseAsset: "ZETA",
          quoteAsset: "USDT",
          contractType: "PERPETUAL",
          status: "TRADING",
          onboardDate: 1,
        },
        {
          symbol: "ALPHAUSDT",
          pair: "ALPHAUSDT",
          baseAsset: "ALPHA",
          quoteAsset: "USDT",
          contractType: "PERPETUAL",
          status: "TRADING",
          onboardDate: 1,
        },
      ],
      [
        { symbol: "ZETAUSDT", baseAsset: "ZETA", quoteAsset: "USDT", status: "BREAK" },
        { symbol: "ALPHAUSDT", baseAsset: "ALPHA", quoteAsset: "USDT", status: "TRADING" },
      ],
    );

    expect(result.map((item) => item.symbol)).toEqual(["ALPHAUSDT", "ZETAUSDT"]);
    expect(result[0].isContractOnly).toBe(false);
    expect(result[0].spotBaseAssetMatches).toEqual(["ALPHA"]);
    expect(result[1].isContractOnly).toBe(true);
    expect(result[1].spotBaseAssetMatches).toEqual([]);
  });
});
