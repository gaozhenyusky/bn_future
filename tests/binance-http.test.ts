import { describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "undici";

import { BinanceHttpClient } from "../src/connectors/binance-http";

describe("BinanceHttpClient", () => {
  it("routes requests through the configured HTTPS proxy", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const createProxyAgent = vi.fn((proxyUrl: string) => ({ proxyUrl })) as unknown as (
      proxyUrl: string,
    ) => Dispatcher;

    const client = new BinanceHttpClient({
      baseUrl: "https://fapi.binance.com",
      proxyUrl: "http://proxy.example:8080",
      fetchImpl,
      createProxyAgent,
    });

    await client.getJson<{ ok: boolean }>("/fapi/v1/exchangeInfo");

    expect(createProxyAgent).toHaveBeenCalledWith("http://proxy.example:8080");
    const requestInit = fetchImpl.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined;
    expect(requestInit?.dispatcher).toEqual({ proxyUrl: "http://proxy.example:8080" });
  });

  it("clears each attempt timeout before awaiting retry backoff", async () => {
    const events: string[] = [];
    let timerId = 0;
    const handles = new Map<number, ReturnType<typeof setTimeout>>();

    const setTimeoutFn = vi.fn(((_callback: () => void, _delay: number) => {
      const id = ++timerId;
      const handle = { id } as unknown as ReturnType<typeof setTimeout>;
      handles.set(id, handle);
      events.push(`set:${id}`);
      return handle;
    }) as (callback: () => void, delay: number) => ReturnType<typeof setTimeout>);
    const clearTimeoutFn = vi.fn(((timeoutId: ReturnType<typeof setTimeout>) => {
      const id = (timeoutId as unknown as { id: number }).id;
      events.push(`clear:${id}`);
    }) as (timeoutId: ReturnType<typeof setTimeout>) => void);
    const sleep = vi.fn<(delayMs: number) => Promise<void>>(async (_delayMs) => {
      events.push("sleep");
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("retry", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const client = new BinanceHttpClient({
      baseUrl: "https://fapi.binance.com",
      fetchImpl,
      retry: {
        maxRetries: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
      sleep,
      setTimeoutFn,
      clearTimeoutFn,
    });

    const result = await client.getJson<{ ok: boolean }>("/fapi/v1/exchangeInfo");

    expect(result).toEqual({ ok: true });
    expect(events).toEqual(["set:1", "clear:1", "sleep", "set:2", "clear:2"]);
  });
});
