import { afterEach, describe, expect, it, vi } from "vitest";

import { BinanceHttpError, BinanceResponseError } from "../src/connectors/binance-http";
import { BinanceFuturesRestClient } from "../src/connectors/binance-futures-rest";

const originalFetch = globalThis.fetch;

function installFetchStub(implementation: typeof fetch) {
  Object.defineProperty(globalThis, "fetch", {
    value: implementation,
    configurable: true,
    writable: true,
  });
}

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

describe("BinanceFuturesRestClient", () => {
  afterEach(() => {
    installFetchStub(originalFetch);
    vi.restoreAllMocks();
  });

  it("calls the public Futures exchangeInfo endpoint and normalizes symbol filters", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        symbols: [
          {
            symbol: "HEIUSDT",
            pair: "HEIUSDT",
            baseAsset: "HEI",
            quoteAsset: "USDT",
            contractType: "PERPETUAL",
            status: "TRADING",
            onboardDate: 1722902400000,
            deliveryDate: 0,
            filters: [
              { filterType: "PRICE_FILTER", minPrice: "0.0001", maxPrice: "1000", tickSize: "0.0001" },
              { filterType: "LOT_SIZE", minQty: "1", maxQty: "1000000", stepSize: "1" },
            ],
          },
        ],
      }),
    );
    installFetchStub(fetchMock);

    const client = new BinanceFuturesRestClient();
    const symbols = await client.getFuturesExchangeInfo();

    expect(symbols).toEqual([
      {
        symbol: "HEIUSDT",
        pair: "HEIUSDT",
        baseAsset: "HEI",
        quoteAsset: "USDT",
        contractType: "PERPETUAL",
        status: "TRADING",
        onboardDate: 1722902400000,
        deliveryDate: 0,
        filters: [
          { filterType: "PRICE_FILTER", minPrice: "0.0001", maxPrice: "1000", tickSize: "0.0001" },
          { filterType: "LOT_SIZE", minQty: "1", maxQty: "1000000", stepSize: "1" },
        ],
      },
    ]);

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("https://fapi.binance.com/fapi/v1/exchangeInfo");
    expect(requestInit?.headers).toBeUndefined();
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("calls the public Spot exchangeInfo endpoint without API-key headers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        symbols: [{ symbol: "BANKUSDT", baseAsset: "BANK", quoteAsset: "USDT", status: "TRADING" }],
      }),
    );
    installFetchStub(fetchMock);

    const client = new BinanceFuturesRestClient();
    const symbols = await client.getSpotExchangeInfo();

    expect(symbols).toEqual([{ symbol: "BANKUSDT", baseAsset: "BANK", quoteAsset: "USDT", status: "TRADING" }]);

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("https://api.binance.com/api/v3/exchangeInfo");
    expect(requestInit?.headers).toBeUndefined();
  });

  it("calls the public kline endpoint and preserves raw numeric strings plus the closed flag", async () => {
    const rawKline = [
      1722902400000,
      "0.1234",
      "0.2234",
      "0.1000",
      "0.2000",
      "98765.4321",
      1722902699999,
      "12345.6789",
      321,
      "45678.9",
      "5678.9",
      true,
    ];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([rawKline]));
    installFetchStub(fetchMock);

    const client = new BinanceFuturesRestClient();
    const klines = await client.getKlines("HEIUSDT", "5m", 2);

    expect(klines).toEqual([
      {
        openTime: 1722902400000,
        open: "0.1234",
        high: "0.2234",
        low: "0.1000",
        close: "0.2000",
        volume: "98765.4321",
        closeTime: 1722902699999,
        quoteAssetVolume: "12345.6789",
        tradeCount: 321,
        takerBuyBaseAssetVolume: "45678.9",
        takerBuyQuoteAssetVolume: "5678.9",
        isClosed: true,
        raw: rawKline,
      },
    ]);

    const [requestUrl] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("https://fapi.binance.com/fapi/v1/klines?symbol=HEIUSDT&interval=5m&limit=2");
  });

  it("calls the public open interest statistics endpoint and preserves sumOpenInterestValue strings", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([
        {
          symbol: "HEIUSDT",
          sumOpenInterest: "12345.0000",
          sumOpenInterestValue: "67890.1234",
          timestamp: 1722902400000,
        },
      ]),
    );
    installFetchStub(fetchMock);

    const client = new BinanceFuturesRestClient();
    const result = await client.getOpenInterestHistory("HEIUSDT", "15m", 30);

    expect(result).toEqual([
      {
        symbol: "HEIUSDT",
        sumOpenInterest: "12345.0000",
        sumOpenInterestValue: "67890.1234",
        timestamp: 1722902400000,
      },
    ]);

    const [requestUrl] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://fapi.binance.com/futures/data/openInterestHist?symbol=HEIUSDT&period=15m&limit=30",
    );
  });

  it("calls the public taker long-short ratio and funding rate endpoints instead of any private income endpoint", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            symbol: "HEIUSDT",
            buySellRatio: "1.25",
            buyVol: "1000.5",
            sellVol: "800.4",
            timestamp: 1722902400000,
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            symbol: "HEIUSDT",
            fundingRate: "0.00010000",
            fundingTime: 1722902400000,
          },
        ]),
      );
    installFetchStub(fetchMock);

    const client = new BinanceFuturesRestClient();
    const takerFlow = await client.getTakerLongShortRatio("HEIUSDT", "5m", 10);
    const fundingRates = await client.getFundingRateHistory("HEIUSDT", 5);

    expect(takerFlow).toEqual([
      {
        symbol: "HEIUSDT",
        buySellRatio: "1.25",
        buyVol: "1000.5",
        sellVol: "800.4",
        timestamp: 1722902400000,
      },
    ]);
    expect(fundingRates).toEqual([
      {
        symbol: "HEIUSDT",
        fundingRate: "0.00010000",
        fundingTime: 1722902400000,
      },
    ]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=HEIUSDT&period=5m&limit=10",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://fapi.binance.com/fapi/v1/fundingRate?symbol=HEIUSDT&limit=5",
    );
    expect(fetchMock.mock.calls.map(([requestUrl]) => String(requestUrl))).not.toContain(
      expect.stringContaining("/fapi/v1/income"),
    );
  });

  it("raises a typed BinanceHttpError for HTTP 429 with retry-after metadata and without leaking headers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: -1003, msg: "Too many requests" }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "1200",
        },
      }),
    );
    installFetchStub(fetchMock);

    const client = new BinanceFuturesRestClient({
      retry: {
        maxRetries: 0,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
    });

    await expect(client.getFuturesExchangeInfo()).rejects.toMatchObject({
      name: "BinanceHttpError",
      status: 429,
      retryAfterMs: 1200000,
      path: "/fapi/v1/exchangeInfo",
    } satisfies Partial<BinanceHttpError>);

    await client.getFuturesExchangeInfo().catch((error: unknown) => {
      expect(error).toBeInstanceOf(BinanceHttpError);
      expect(error).not.toHaveProperty("headers");
      expect((error as Error).message).not.toContain("X-MBX-APIKEY");
    });
  });

  it("raises a typed BinanceHttpError for invalid JSON responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("not-json", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );
    installFetchStub(fetchMock);

    const client = new BinanceFuturesRestClient();

    await expect(client.getSpotExchangeInfo()).rejects.toMatchObject({
      name: "BinanceHttpError",
      status: 200,
      path: "/api/v3/exchangeInfo",
      code: "INVALID_JSON",
    } satisfies Partial<BinanceHttpError>);
  });

  it("raises a typed response error for malformed-but-valid JSON kline payloads", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([
        [
          1722902400000,
          "0.1234",
          "0.2234",
        ],
      ]),
    );
    installFetchStub(fetchMock);

    const client = new BinanceFuturesRestClient();

    const errorPromise = client.getKlines("HEIUSDT", "5m", 1);

    await expect(errorPromise).rejects.toMatchObject({
      name: "BinanceResponseError",
      code: "MALFORMED_PAYLOAD",
      path: "/fapi/v1/klines",
      context: "klines",
    } satisfies Partial<BinanceResponseError>);

    await errorPromise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(BinanceResponseError);
      expect((error as Error).message).not.toContain("0.1234");
    });
  });

  it("raises a typed response error for malformed-but-valid JSON open-interest payloads", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([
        {
          symbol: "HEIUSDT",
          sumOpenInterest: "12345.0000",
          timestamp: 1722902400000,
        },
      ]),
    );
    installFetchStub(fetchMock);

    const client = new BinanceFuturesRestClient();

    await expect(client.getOpenInterestHistory("HEIUSDT", "15m", 1)).rejects.toMatchObject({
      name: "BinanceResponseError",
      code: "MALFORMED_PAYLOAD",
      path: "/futures/data/openInterestHist",
      context: "open interest history",
    } satisfies Partial<BinanceResponseError>);
  });
});
