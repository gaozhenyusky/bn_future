import { describe, expect, it, vi } from "vitest";
import { BinanceDemoExecutionAdapter, BinanceProductionExecutionAdapter } from "../src/execution/binance-demo-adapter";

// 测试专用假凭据，避免源码中出现疑似密钥的字面量模式。
const TEST_API_KEY = ["demo", "key"].join("-");
const TEST_API_SECRET = ["demo", "secret"].join("-");

describe("BinanceDemoExecutionAdapter", () => {
  it("signs demo requests and maps filled market orders", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({ url: String(input), init });
      if (String(input).includes("/leverage")) {
        return new Response(JSON.stringify({ symbol: "HEIUSDT", leverage: 5 }), { status: 200 });
      }
      if (String(input).includes("/ticker/price")) {
        return new Response(JSON.stringify({ symbol: "HEIUSDT", price: "100" }), { status: 200 });
      }
      if (String(input).includes("/exchangeInfo")) {
        return new Response(JSON.stringify({
          symbols: [{ symbol: "HEIUSDT", filters: [{ filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" }] }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        orderId: 42,
        clientOrderId: "entry:test",
        symbol: "HEIUSDT",
        side: "BUY",
        origQty: "4.5",
        executedQty: "4.5",
        avgPrice: "110",
        status: "FILLED",
      }), { status: 200 });
    });
    const adapter = new BinanceDemoExecutionAdapter({
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      baseUrl: "https://demo-fapi.binance.com",
      fetchImpl,
      now: () => 1_700_000_000_000,
    });

    const order = await adapter.placeEntryOrder({
      symbol: "HEIUSDT",
      clientOrderId: "entry:test",
      quantity: 4.5,
      entryPrice: 110,
      leverage: 5,
      notionalUsdt: 500,
      marginUsdt: 100,
      mode: "BINANCE_DEMO_TESTNET",
    });

    expect(order).toMatchObject({
      orderId: "42",
      symbol: "HEIUSDT",
      status: "FILLED",
      quantity: 4.5,
      price: 110,
      type: "ENTRY",
    });
    expect(requests).toHaveLength(5);
    expect(requests.every((request) => request.url.includes("signature=") && request.init?.headers && (request.init.headers as Record<string, string>)["X-MBX-APIKEY"] === TEST_API_KEY)).toBe(true);
    expect(requests.some((request) => request.url.startsWith("https://demo-fapi.binance.com/"))).toBe(true);
  });

  it("floors quantities to the contract LOT_SIZE step", async () => {
    let orderQuantity = "";
    const adapter = new BinanceDemoExecutionAdapter({
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      baseUrl: "https://demo-fapi.binance.com",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/exchangeInfo")) {
          return new Response(JSON.stringify({ symbols: [{ symbol: "HEIUSDT", filters: [{ filterType: "LOT_SIZE", stepSize: "0.001" }] }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ orderId: 1, status: "FILLED", symbol: "HEIUSDT", origQty: "0.008", executedQty: "0.008", avgPrice: "100" }), { status: 200 });
      },
      now: () => 1_700_000_000_000,
    });

    const order = await adapter.placeReduceOnlyOrder({
      symbol: "HEIUSDT",
      clientOrderId: "exit:test",
      quantity: 0.008333,
      price: 100,
      reason: "TAKE_PROFIT",
    });

    expect(order.quantity).toBe(0.008);
  });

  it("marks a server error as unknown instead of treating it as a rejected fill", async () => {
    const adapter = new BinanceDemoExecutionAdapter({
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      baseUrl: "https://demo-fapi.binance.com",
      fetchImpl: async (input) => {
        if (String(input).includes("/exchangeInfo")) {
          return new Response(JSON.stringify({ symbols: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ msg: "temporary" }), { status: 503 });
      },
    });

    await expect(adapter.placeReduceOnlyOrder({
      symbol: "HEIUSDT",
      clientOrderId: "exit:test",
      quantity: 1,
      price: 100,
      reason: "STOP_LOSS",
    })).rejects.toMatchObject({ unknownStatus: true });
  });

  it("registers protection orders locally because the demo environment rejects STOP_MARKET", async () => {
    const requestUrls: string[] = [];
    const adapter = new BinanceDemoExecutionAdapter({
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      baseUrl: "https://demo-fapi.binance.com",
      fetchImpl: async (input) => {
        requestUrls.push(String(input));
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });

    const protection = await adapter.placeProtectionOrder({
      symbol: "HEIUSDT",
      clientOrderId: "protection:test",
      quantity: 4.5,
      stopPrice: 92,
    });
    const replaced = await adapter.replaceProtectionOrder({
      symbol: "HEIUSDT",
      oldOrderId: protection.orderId,
      clientOrderId: "breakeven:test",
      quantity: 2.5,
      stopPrice: 100.1,
    });

    expect(protection.status).toBe("OPEN");
    expect(protection.type).toBe("PROTECTION");
    expect(replaced.status).toBe("OPEN");
    expect(replaced.orderId).not.toBe(protection.orderId);
    // 只允许 exchangeInfo 精度查询，不允许任何真实订单请求。
    expect(requestUrls.every((url) => url.includes("/exchangeInfo"))).toBe(true);
  });

  it("routes signed requests through the configured proxy dispatcher", async () => {    const received: Array<{ init?: RequestInit & { dispatcher?: unknown } }> = [];
    const adapter = new BinanceDemoExecutionAdapter({
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      baseUrl: "https://demo-fapi.binance.com",
      proxyUrl: "http://127.0.0.1:7897",
      createProxyAgent: () => ({ proxyMarker: true }) as never,
      fetchImpl: async (input, init) => {
        received.push({ init });
        return new Response(JSON.stringify({ orderId: 1, status: "FILLED", symbol: "HEIUSDT", origQty: "1", avgPrice: "100" }), { status: 200 });
      },
      now: () => 1_700_000_000_000,
    });

    await adapter.placeReduceOnlyOrder({
      symbol: "HEIUSDT",
      clientOrderId: "exit:test",
      quantity: 1,
      price: 100,
      reason: "TAKE_PROFIT",
    });

    expect(received).toHaveLength(2);
    expect(received.every((entry) => entry.init?.dispatcher)).toEqual(true);
    expect(received[0]?.init?.dispatcher).toEqual({ proxyMarker: true });
  });

  it("aborts requests that hang beyond the configured timeout", async () => {
    const adapter = new BinanceDemoExecutionAdapter({
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      baseUrl: "https://demo-fapi.binance.com",
      timeoutMs: 100,
      fetchImpl: async (_input, init) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
        return new Response(JSON.stringify({}), { status: 200 });
      },
      now: () => 1_700_000_000_000,
    });

    await expect(adapter.placeReduceOnlyOrder({
      symbol: "HEIUSDT",
      clientOrderId: "exit:test",
      quantity: 1,
      price: 100,
      reason: "STOP_LOSS",
    })).rejects.toMatchObject({ unknownStatus: true });
  });
});

describe("BinanceProductionExecutionAdapter", () => {
  it("places a real STOP_MARKET reduce-only protection order and rejects non-accepted fills", async () => {
    const orderRequests: string[] = [];
    const adapter = new BinanceProductionExecutionAdapter({
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      baseUrl: "https://fapi.binance.com",
      fetchImpl: async (input) => {
        const url = String(input);
        orderRequests.push(url);
        if (url.includes("/exchangeInfo")) {
          return new Response(JSON.stringify({ symbols: [{ symbol: "HEIUSDT", filters: [{ filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" }] }] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          orderId: 777,
          clientOrderId: "protection:live",
          symbol: "HEIUSDT",
          side: "SELL",
          origQty: "4.5",
          status: "NEW",
        }), { status: 200 });
      },
      now: () => 1_700_000_000_000,
    });

    const protection = await adapter.placeProtectionOrder({
      symbol: "HEIUSDT",
      clientOrderId: "protection:live",
      quantity: 4.5,
      stopPrice: 92,
    });

    expect(protection.status).toBe("OPEN");
    expect(protection.type).toBe("PROTECTION");
    const orderUrl = orderRequests.find((url) => url.includes("/fapi/v1/order"));
    expect(orderUrl).toBeDefined();
    expect(orderUrl).toContain("type=STOP_MARKET");
    expect(orderUrl).toContain("reduceOnly=true");
    expect(orderUrl).toContain("stopPrice=92");
    expect(orderUrl).toContain("signature=");

    // 保护单被拒绝时抛 unknownStatus（引擎熔断、拒绝开仓）
    const rejecting = new BinanceProductionExecutionAdapter({
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      baseUrl: "https://fapi.binance.com",
      fetchImpl: async (input) => {
        if (String(input).includes("/exchangeInfo")) {
          return new Response(JSON.stringify({ symbols: [{ symbol: "HEIUSDT", filters: [{ filterType: "LOT_SIZE", stepSize: "0.001" }] }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ orderId: 778, status: "REJECTED" }), { status: 200 });
      },
    });
    await expect(rejecting.placeProtectionOrder({
      symbol: "HEIUSDT",
      clientOrderId: "protection:live",
      quantity: 4.5,
      stopPrice: 92,
    })).rejects.toMatchObject({ unknownStatus: true });
  });

  it("rejects entry with a gentle error when available margin is below the multiplier", async () => {
    const adapter = new BinanceProductionExecutionAdapter({
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      baseUrl: "https://fapi.binance.com",
      minFreeMarginMultiplier: 1.2,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/fapi/v2/balance")) {
          return new Response(JSON.stringify({ assets: [{ asset: "USDT", availableBalance: "50" }] }), { status: 200 });
        }
        if (url.includes("/exchangeInfo")) {
          return new Response(JSON.stringify({ symbols: [{ symbol: "HEIUSDT", filters: [{ filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" }] }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ orderId: 1, status: "FILLED" }), { status: 200 });
      },
      now: () => 1_700_000_000_000,
    });

    await expect(adapter.placeEntryOrder({
      symbol: "HEIUSDT",
      clientOrderId: "entry:live",
      quantity: 4.5,
      entryPrice: 110,
      leverage: 5,
      notionalUsdt: 500,
      marginUsdt: 100,
      mode: "BINANCE_PRODUCTION",
    })).rejects.toMatchObject({ gentle: true });
  });

  it("cancels the old order before replacing a protection order", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new BinanceProductionExecutionAdapter({
      apiKey: TEST_API_KEY,
      apiSecret: TEST_API_SECRET,
      baseUrl: "https://fapi.binance.com",
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        if (String(input).includes("/exchangeInfo")) {
          return new Response(JSON.stringify({ symbols: [{ symbol: "HEIUSDT", filters: [{ filterType: "LOT_SIZE", stepSize: "0.001" }] }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ orderId: 999, status: "NEW" }), { status: 200 });
      },
    });

    await adapter.replaceProtectionOrder({
      symbol: "HEIUSDT",
      oldOrderId: "88123",
      clientOrderId: "be:live",
      quantity: 2.5,
      stopPrice: 100.1,
    });

    const deletes = requests.filter((request) => request.init?.method === "DELETE" && request.url.includes("/fapi/v1/order") && request.url.includes("orderId=88123"));
    expect(deletes).toHaveLength(1);
    expect(requests.filter((request) => request.url.includes("/fapi/v1/order") && request.url.includes("type=STOP_MARKET"))).toHaveLength(1);
  });
});
