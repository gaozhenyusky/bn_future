import { describe, expect, it, vi } from "vitest";

import {
  BitgetMarketRestClient,
  BitgetResponseError,
} from "../src/connectors/bitget-market-rest";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
    ...init,
  });
}

describe("BitgetMarketRestClient", () => {
  it("calls the public spot and futures endpoints and normalizes Bitget payloads into finite numbers", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          code: "00000",
          msg: "success",
          requestTime: 1_724_276_707_885,
          data: [
            {
              symbol: "BTCUSDT",
              baseCoin: "BTC",
              quoteCoin: "USDT",
              status: "online",
              minTradeUSDT: "1",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: "00000",
          msg: "success",
          requestTime: 1_695_793_701_269,
          data: [
            {
              symbol: "BTCUSDT",
              baseCoin: "BTC",
              quoteCoin: "USDT",
              symbolType: "perpetual",
              productType: "USDT-FUTURES",
              status: "normal",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: "00000",
          msg: "success",
          requestTime: 1_695_800_278_693,
          data: [
            ["1722902100000", "100", "110", "90", "105", "10", "999", "1001"],
            ["1722902400000", "105", "115", "95", "111", "11", "1000", "1002"],
            ["1722902700000", "111", "116", "101", "114", "12", "1003", "1005"],
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: "00000",
          msg: "success",
          requestTime: 1_695_865_615_662,
          data: [
            ["1722902100000", "200", "210", "190", "205", "20", "2001"],
            ["1722902400000", "205", "215", "195", "211", "21", "2002"],
            ["1722902700000", "211", "216", "201", "214", "22", "2003"],
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: "00000",
          msg: "success",
          requestTime: 1_695_808_949_356,
          data: [
            {
              symbol: "ETHUSDT",
              lastPr: "2500.5",
              bidPr: "2500.1",
              askPr: "2500.9",
              quoteVolume: "0",
              usdtVolume: "123456.78",
              ts: "1722902700000",
            },
            {
              symbol: "BTCUSDT",
              lastPr: "61000.5",
              bidPr: "60999.1",
              askPr: "61001.9",
              quoteVolume: "0",
              usdtVolume: "456789.12",
              ts: "1722902700001",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: "00000",
          msg: "success",
          requestTime: 1_695_794_095_685,
          data: [
            {
              symbol: "BTCUSDT",
              lastPr: "61010.5",
              bidPr: "61009.1",
              askPr: "61011.9",
              quoteVolume: "987654.32",
              indexPrice: "61005.1",
              fundingRate: "bad-rate",
              holdingAmount: "321.9",
              markPrice: "bad-mark",
              ts: "1722902701000",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: "00000",
          msg: "success",
          requestTime: 1_695_796_780_343,
          data: {
            openInterestList: [
              {
                symbol: "BTCUSDT",
                size: "34278.06",
              },
            ],
            ts: "1722902702000",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: "00000",
          msg: "success",
          requestTime: 1_743_054_548_546,
          data: [
            {
              symbol: "BTCUSDT",
              fundingRate: "0.000068",
              fundingRateInterval: "8",
              nextUpdate: "1722903000000",
              minFundingRate: "-0.003",
              maxFundingRate: "0.003",
            },
          ],
        }),
      );

    const client = new BitgetMarketRestClient({
      fetchImpl,
      now: () => 1_722_902_850_000,
    });

    const spotSymbols = await client.getSpotSymbols();
    const futuresContracts = await client.getFuturesContracts();
    const spotCandles = await client.getSpotCandles("BTCUSDT", "5m", 3);
    const futuresCandles = await client.getFuturesCandles("BTCUSDT", "5m", 3);
    const spotTicker = await client.getSpotTicker("BTCUSDT");
    const futuresTicker = await client.getFuturesTicker("BTCUSDT");
    const openInterest = await client.getOpenInterest("BTCUSDT");
    const fundingRate = await client.getFundingRate("BTCUSDT");

    expect(spotSymbols).toEqual([
      {
        symbol: "BTCUSDT",
        baseCoin: "BTC",
        quoteCoin: "USDT",
        status: "online",
      },
    ]);
    expect(futuresContracts).toEqual([
      {
        symbol: "BTCUSDT",
        baseCoin: "BTC",
        quoteCoin: "USDT",
        productType: "usdt-futures",
        status: "normal",
        symbolType: "perpetual",
      },
    ]);
    expect(spotCandles).toEqual([
      {
        symbol: "BTCUSDT",
        interval: "5m",
        openTime: 1_722_902_100_000,
        open: 100,
        high: 110,
        low: 90,
        close: 105,
        volumeBase: 10,
        volumeQuote: 1001,
        sourceTimestamp: 1_722_902_100_000,
        receivedTimestamp: 1_722_902_850_000,
        raw: ["1722902100000", "100", "110", "90", "105", "10", "999", "1001"],
      },
      {
        symbol: "BTCUSDT",
        interval: "5m",
        openTime: 1_722_902_400_000,
        open: 105,
        high: 115,
        low: 95,
        close: 111,
        volumeBase: 11,
        volumeQuote: 1002,
        sourceTimestamp: 1_722_902_400_000,
        receivedTimestamp: 1_722_902_850_000,
        raw: ["1722902400000", "105", "115", "95", "111", "11", "1000", "1002"],
      },
    ]);
    expect(futuresCandles).toEqual([
      {
        symbol: "BTCUSDT",
        interval: "5m",
        openTime: 1_722_902_100_000,
        open: 200,
        high: 210,
        low: 190,
        close: 205,
        volumeBase: 20,
        volumeQuote: 2001,
        sourceTimestamp: 1_722_902_100_000,
        receivedTimestamp: 1_722_902_850_000,
        raw: ["1722902100000", "200", "210", "190", "205", "20", "2001"],
      },
      {
        symbol: "BTCUSDT",
        interval: "5m",
        openTime: 1_722_902_400_000,
        open: 205,
        high: 215,
        low: 195,
        close: 211,
        volumeBase: 21,
        volumeQuote: 2002,
        sourceTimestamp: 1_722_902_400_000,
        receivedTimestamp: 1_722_902_850_000,
        raw: ["1722902400000", "205", "215", "195", "211", "21", "2002"],
      },
    ]);
    expect(spotTicker).toEqual({
      symbol: "BTCUSDT",
      lastPrice: 61000.5,
      bidPrice: 60999.1,
      askPrice: 61001.9,
      quoteVolume: 456789.12,
      sourceTimestamp: 1_722_902_700_001,
      receivedTimestamp: 1_722_902_850_000,
    });
    expect(futuresTicker).toEqual({
      symbol: "BTCUSDT",
      lastPrice: 61010.5,
      bidPrice: 61009.1,
      askPrice: 61011.9,
      quoteVolume: 987654.32,
      indexPrice: 61005.1,
      fundingRate: undefined,
      holdingAmount: 321.9,
      markPrice: undefined,
      sourceTimestamp: 1_722_902_701_000,
      receivedTimestamp: 1_722_902_850_000,
    });
    expect(openInterest).toEqual({
      symbol: "BTCUSDT",
      openInterest: 34278.06,
      sourceTimestamp: 1_722_902_702_000,
      receivedTimestamp: 1_722_902_850_000,
    });
    expect(fundingRate).toEqual({
      symbol: "BTCUSDT",
      productType: "usdt-futures",
      fundingRate: 0.000068,
      fundingRateIntervalHours: 8,
      nextUpdate: 1_722_903_000_000,
      minFundingRate: -0.003,
      maxFundingRate: 0.003,
      receivedTimestamp: 1_722_902_850_000,
    });

    expect(fetchImpl.mock.calls.map(([requestUrl]) => String(requestUrl))).toEqual([
      "https://api.bitget.com/api/v2/spot/public/symbols",
      "https://api.bitget.com/api/v2/mix/market/contracts?productType=usdt-futures",
      "https://api.bitget.com/api/v2/spot/market/candles?symbol=BTCUSDT&granularity=5min&limit=3",
      "https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=usdt-futures&granularity=5m&limit=3",
      "https://api.bitget.com/api/v2/spot/market/tickers?symbol=BTCUSDT",
      "https://api.bitget.com/api/v2/mix/market/ticker?symbol=BTCUSDT&productType=usdt-futures",
      "https://api.bitget.com/api/v2/mix/market/open-interest?symbol=BTCUSDT&productType=usdt-futures",
      "https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=BTCUSDT&productType=usdt-futures",
    ]);
  });

  it("returns undefined instead of zero for malformed numerics and empty matches", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          code: "00000",
          msg: "success",
          requestTime: 1,
          data: [
            {
              symbol: "BTCUSDT",
              lastPr: "bad",
              bidPr: "61009.1",
              askPr: "61011.9",
              quoteVolume: "oops",
              usdtVolume: "still-bad",
              ts: "bad-ts",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: "00000",
          msg: "success",
          requestTime: 1,
          data: {
            openInterestList: [
              {
                symbol: "BTCUSDT",
                size: "bad",
              },
            ],
            ts: "bad-ts",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: "00000",
          msg: "success",
          requestTime: 1,
          data: [],
        }),
      );

    const client = new BitgetMarketRestClient({
      fetchImpl,
      now: () => 5_000,
    });

    expect(await client.getSpotTicker("BTCUSDT")).toEqual({
      symbol: "BTCUSDT",
      lastPrice: undefined,
      bidPrice: 61009.1,
      askPrice: 61011.9,
      quoteVolume: undefined,
      sourceTimestamp: undefined,
      receivedTimestamp: 5_000,
    });
    expect(await client.getOpenInterest("BTCUSDT")).toEqual({
      symbol: "BTCUSDT",
      openInterest: undefined,
      sourceTimestamp: undefined,
      receivedTimestamp: 5_000,
    });
    expect(await client.getFundingRate("BTCUSDT")).toBeUndefined();
  });

  it("accepts the alternate 7-field spot candle response contract and uses field 6 as quote volume", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        code: "00000",
        msg: "success",
        requestTime: 1_695_800_278_693,
        data: [
          ["1722901500000", "99", "101", "98", "100", "9", "900"],
          ["1722902400000", "100", "110", "90", "105", "10", "bad-quote"],
          ["1722903300000", "105", "115", "95", "111", "11", "1002"],
        ],
      }),
    );

    const client = new BitgetMarketRestClient({
      fetchImpl,
      now: () => 1_722_902_850_000,
    });

    const spotCandles = await client.getSpotCandles("BTCUSDT", "5m", 3);

    expect(spotCandles).toEqual([
      {
        symbol: "BTCUSDT",
        interval: "5m",
        openTime: 1_722_901_500_000,
        open: 99,
        high: 101,
        low: 98,
        close: 100,
        volumeBase: 9,
        volumeQuote: 900,
        sourceTimestamp: 1_722_901_500_000,
        receivedTimestamp: 1_722_902_850_000,
        raw: ["1722901500000", "99", "101", "98", "100", "9", "900"],
      },
      {
        symbol: "BTCUSDT",
        interval: "5m",
        openTime: 1_722_902_400_000,
        open: 100,
        high: 110,
        low: 90,
        close: 105,
        volumeBase: 10,
        volumeQuote: undefined,
        sourceTimestamp: 1_722_902_400_000,
        receivedTimestamp: 1_722_902_850_000,
        raw: ["1722902400000", "100", "110", "90", "105", "10", "bad-quote"],
      },
    ]);
  });

  it("calls the public 15m futures candle endpoint and parses closed rows", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        code: "00000",
        msg: "success",
        requestTime: 1_695_865_615_662,
        data: [
          ["1722900600000", "190", "200", "185", "195", "18", "1801"],
          ["1722901500000", "195", "205", "190", "201", "19", "1902"],
          ["1722902400000", "201", "211", "198", "207", "20", "2003"],
        ],
      }),
    );

    const client = new BitgetMarketRestClient({
      fetchImpl,
      now: () => 1_722_903_350_000,
    });

    const futuresCandles = await client.getFuturesCandles("BTCUSDT", "15m", 3);

    expect(futuresCandles).toEqual([
      {
        symbol: "BTCUSDT",
        interval: "15m",
        openTime: 1_722_900_600_000,
        open: 190,
        high: 200,
        low: 185,
        close: 195,
        volumeBase: 18,
        volumeQuote: 1801,
        sourceTimestamp: 1_722_900_600_000,
        receivedTimestamp: 1_722_903_350_000,
        raw: ["1722900600000", "190", "200", "185", "195", "18", "1801"],
      },
      {
        symbol: "BTCUSDT",
        interval: "15m",
        openTime: 1_722_901_500_000,
        open: 195,
        high: 205,
        low: 190,
        close: 201,
        volumeBase: 19,
        volumeQuote: 1902,
        sourceTimestamp: 1_722_901_500_000,
        receivedTimestamp: 1_722_903_350_000,
        raw: ["1722901500000", "195", "205", "190", "201", "19", "1902"],
      },
      {
        symbol: "BTCUSDT",
        interval: "15m",
        openTime: 1_722_902_400_000,
        open: 201,
        high: 211,
        low: 198,
        close: 207,
        volumeBase: 20,
        volumeQuote: 2003,
        sourceTimestamp: 1_722_902_400_000,
        receivedTimestamp: 1_722_903_350_000,
        raw: ["1722902400000", "201", "211", "198", "207", "20", "2003"],
      },
    ]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=usdt-futures&granularity=15m&limit=3",
    );
  });

  it("raises a typed response error for malformed-but-valid JSON candle payloads", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        code: "00000",
        msg: "success",
        requestTime: 1,
        data: [["1722902400000", "100", "110"]],
      }),
    );

    const client = new BitgetMarketRestClient({
      fetchImpl,
    });

    const errorPromise = client.getSpotCandles("BTCUSDT", "15m", 1);

    await expect(errorPromise).rejects.toMatchObject({
      name: "BitgetResponseError",
      code: "MALFORMED_PAYLOAD",
      path: "/api/v2/spot/market/candles",
      context: "spot candles",
    } satisfies Partial<BitgetResponseError>);
  });
});
