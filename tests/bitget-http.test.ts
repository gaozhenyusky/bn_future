import { describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "undici";

import { BitgetHttpClient, BitgetHttpError } from "../src/connectors/bitget-http";

describe("BitgetHttpClient", () => {
  it("returns parsed envelope data and routes requests through the configured HTTPS proxy", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "00000",
          msg: "success",
          requestTime: 1_723_000_000_000,
          data: [{ symbol: "BTCUSDT" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const createProxyAgent = vi.fn((proxyUrl: string) => ({ proxyUrl })) as unknown as (
      proxyUrl: string,
    ) => Dispatcher;

    const client = new BitgetHttpClient({
      proxyUrl: "http://proxy.example:8080",
      fetchImpl,
      createProxyAgent,
    });

    const payload = await client.getJson<Array<{ symbol: string }>>("/api/v2/spot/public/symbols", {});

    expect(payload).toEqual([{ symbol: "BTCUSDT" }]);
    expect(createProxyAgent).toHaveBeenCalledWith("http://proxy.example:8080");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.bitget.com/api/v2/spot/public/symbols");
    const requestInit = fetchImpl.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined;
    expect(requestInit?.dispatcher).toEqual({ proxyUrl: "http://proxy.example:8080" });
  });

  it("surfaces 429 retry-after metadata immediately without retrying aggressively or leaking proxy secrets", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "42900",
          msg: "Too many requests",
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "120",
          },
        },
      ),
    );

    const client = new BitgetHttpClient({
      proxyUrl: "http://reader:super-secret@proxy.example:8080",
      fetchImpl,
      retry: {
        maxRetries: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
    });

    const errorPromise = client.getJson("/api/v2/mix/market/contracts", {
      productType: "usdt-futures",
    });

    await expect(errorPromise).rejects.toMatchObject({
      name: "BitgetHttpError",
      status: 429,
      retryAfterMs: 120_000,
      path: "/api/v2/mix/market/contracts",
    } satisfies Partial<BitgetHttpError>);

    await errorPromise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(BitgetHttpError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect((error as Error).message).not.toContain("super-secret");
      expect((error as Error).message).not.toContain("proxy.example");
      expect((error as Error).message).not.toContain("authorization");
      expect(error).not.toHaveProperty("headers");
    });
  });

  it("surfaces 418 immediately without retrying", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "41800",
          msg: "IP banned",
        }),
        {
          status: 418,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );

    const sleep = vi.fn<(delayMs: number) => Promise<void>>(async () => {});
    const client = new BitgetHttpClient({
      fetchImpl,
      retry: {
        maxRetries: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
      sleep,
    });

    await expect(
      client.getJson("/api/v2/mix/market/ticker", {
        symbol: "BTCUSDT",
        productType: "usdt-futures",
      }),
    ).rejects.toMatchObject({
      name: "BitgetHttpError",
      status: 418,
      path: "/api/v2/mix/market/ticker",
    } satisfies Partial<BitgetHttpError>);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient 5xx and network failures only within the configured bound", async () => {
    const sleep = vi.fn<(delayMs: number) => Promise<void>>(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "50000",
            msg: "server busy",
          }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockRejectedValueOnce(new TypeError("socket hang up"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "00000",
            msg: "success",
            requestTime: 1_723_000_000_000,
            data: { symbol: "BTCUSDT" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const client = new BitgetHttpClient({
      fetchImpl,
      retry: {
        maxRetries: 2,
        baseDelayMs: 5,
        maxDelayMs: 5,
      },
      sleep,
    });

    const payload = await client.getJson<{ symbol: string }>("/api/v2/mix/market/ticker", {
      symbol: "BTCUSDT",
      productType: "usdt-futures",
    });

    expect(payload).toEqual({ symbol: "BTCUSDT" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("raises a sanitized invalid-json error when Bitget returns malformed JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("not-json", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const client = new BitgetHttpClient({
      proxyUrl: "http://reader:super-secret@proxy.example:8080",
      fetchImpl,
    });

    const errorPromise = client.getJson("/api/v2/spot/market/tickers", {
      symbol: "BTCUSDT",
    });

    await expect(errorPromise).rejects.toMatchObject({
      name: "BitgetHttpError",
      status: 200,
      path: "/api/v2/spot/market/tickers",
      code: "INVALID_JSON",
    } satisfies Partial<BitgetHttpError>);

    await errorPromise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(BitgetHttpError);
      expect((error as Error).message).not.toContain("super-secret");
      expect((error as Error).message).not.toContain("proxy.example");
      expect((error as Error).message).not.toContain("authorization");
    });
  });
});
