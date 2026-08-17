import { describe, expect, it, vi } from "vitest";

import type { FuturesCandle } from "../src/domain/futures";
import { KlineStream, createBinanceWebSocketFactory } from "../src/connectors/binance-futures-ws";

class FakeWebSocket {
  readonly sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: (error: unknown) => void;
  onping?: () => void;
  onpong?: () => void;
  closeCount = 0;

  constructor(readonly url: string) {}

  open() {
    this.onopen?.();
  }

  message(payload: unknown) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.onmessage?.({ data });
  }

  close() {
    this.closeCount += 1;
    this.onclose?.();
  }

  ping() {
    this.onping?.();
  }

  pong() {
    this.sent.push("pong");
    this.onpong?.();
  }

  send(message: string) {
    this.sent.push(message);
  }
}

function createWsKlineMessage(options: {
  symbol: string;
  interval: "5m" | "15m";
  openTime: number;
  closeTime: number;
  isClosed: boolean;
}) {
  return {
    stream: `${options.symbol.toLowerCase()}@kline_${options.interval}`,
    data: {
      e: "kline",
      E: options.closeTime,
      s: options.symbol,
      k: {
        t: options.openTime,
        T: options.closeTime,
        s: options.symbol,
        i: options.interval,
        o: "1.00",
        c: "1.25",
        h: "1.30",
        l: "0.95",
        v: "1000.5",
        q: "1500.7",
        n: 42,
        V: "550.1",
        Q: "825.4",
        x: options.isClosed,
      },
    },
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

function createManualTimers() {
  let now = 0;
  let nextId = 1;
  const timeouts = new Map<number, { at: number; callback: () => void }>();

  return {
    now: () => now,
    setTimeoutFn(callback: () => void, delayMs: number) {
      const id = nextId++;
      timeouts.set(id, { at: now + delayMs, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn(timeoutId: ReturnType<typeof setTimeout>) {
      timeouts.delete(timeoutId as unknown as number);
    },
    async advanceBy(delayMs: number) {
      const target = now + delayMs;

      while (true) {
        const due = [...timeouts.entries()]
          .filter(([, timeout]) => timeout.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];

        if (!due) {
          break;
        }

        const [id, timeout] = due;
        timeouts.delete(id);
        now = timeout.at;
        timeout.callback();
        await flushMicrotasks();
      }

      now = target;
      await flushMicrotasks();
    },
  };
}

describe("KlineStream", () => {
  it("passes the configured proxy dispatcher to the production WebSocket", () => {
    const dispatcher = { proxyUrl: "http://proxy.example:7897" } as any;
    const createProxyAgent = vi.fn(() => dispatcher);
    const webSocketConstructor = vi.fn((url: string) => new FakeWebSocket(url));

    const factory = createBinanceWebSocketFactory({
      proxyUrl: "http://proxy.example:7897",
      createProxyAgent,
      webSocketConstructor,
    });

    factory("wss://fstream.binance.com/stream?streams=heiusdt@kline_5m");

    expect(createProxyAgent).toHaveBeenCalledWith("http://proxy.example:7897");
    expect(webSocketConstructor).toHaveBeenCalledWith(
      "wss://fstream.binance.com/stream?streams=heiusdt@kline_5m",
      { dispatcher },
    );
  });

  it("backfills history and re-emits the latest closed candle for OI processing on start", async () => {
    const sockets: FakeWebSocket[] = [];
    const backfillCalls: Array<{ symbol: string; interval: "5m" | "15m"; limit: number }> = [];
    const received: Array<{ symbol: string; interval: string; openTime: number; isBackfill?: boolean; isStartupSnapshot?: boolean }> = [];

    const stream = new KlineStream({
      wsBaseUrl: "wss://fstream.binance.com",
      maxStreamsPerSocket: 2,
      websocketFactory: (url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      restClient: {
        async getKlines(symbol: string, interval: "5m" | "15m", limit: number) {
          backfillCalls.push({ symbol, interval, limit });
          return [
            {
              symbol,
              interval,
              openTime: interval === "5m" ? 1 : 2,
              open: "1.0",
              high: "1.1",
              low: "0.9",
              close: "1.05",
              volume: "100",
              closeTime: interval === "5m" ? 300_000 : 900_000,
              quoteAssetVolume: "200",
              tradeCount: 10,
              takerBuyBaseAssetVolume: "50",
              takerBuyQuoteAssetVolume: "100",
              isClosed: true,
              raw: [],
            },
          ];
        },
      },
      logger: {
        info() {},
        warn() {},
      },
    });

    stream.onCandle(async (candle) => {
      received.push({
        symbol: candle.symbol!,
        interval: candle.interval!,
        openTime: candle.openTime,
        isBackfill: candle.isBackfill,
        isStartupSnapshot: candle.isStartupSnapshot,
      });
    });

    await stream.start(["HEIUSDT", "BANKUSDT"], ["5m", "15m"]);

    expect(backfillCalls).toEqual([
      { symbol: "HEIUSDT", interval: "5m", limit: 50 },
      { symbol: "HEIUSDT", interval: "15m", limit: 50 },
      { symbol: "BANKUSDT", interval: "5m", limit: 50 },
      { symbol: "BANKUSDT", interval: "15m", limit: 50 },
    ]);
    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.url).toBe(
      "wss://fstream.binance.com/stream?streams=heiusdt@kline_5m/heiusdt@kline_15m",
    );
    expect(sockets[1]?.url).toBe(
      "wss://fstream.binance.com/stream?streams=bankusdt@kline_5m/bankusdt@kline_15m",
    );
    expect(received).toEqual([
      { symbol: "HEIUSDT", interval: "5m", openTime: 1, isBackfill: true },
      { symbol: "HEIUSDT", interval: "5m", openTime: 1, isBackfill: true, isStartupSnapshot: true },
      { symbol: "HEIUSDT", interval: "15m", openTime: 2, isBackfill: true },
      { symbol: "HEIUSDT", interval: "15m", openTime: 2, isBackfill: true, isStartupSnapshot: true },
      { symbol: "BANKUSDT", interval: "5m", openTime: 1, isBackfill: true },
      { symbol: "BANKUSDT", interval: "5m", openTime: 1, isBackfill: true, isStartupSnapshot: true },
      { symbol: "BANKUSDT", interval: "15m", openTime: 2, isBackfill: true },
      { symbol: "BANKUSDT", interval: "15m", openTime: 2, isBackfill: true, isStartupSnapshot: true },
    ]);
  });

  it("keeps every live subscription but caps startup historical backfill symbols", async () => {
    const sockets: FakeWebSocket[] = [];
    const backfillCalls: string[] = [];
    const stream = new KlineStream({
      startupBackfillSymbolLimit: 1,
      websocketFactory: (url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      restClient: {
        async getKlines(symbol: string) {
          backfillCalls.push(symbol);
          return [];
        },
      },
    });

    await stream.start(["HEIUSDT", "BANKUSDT"], ["5m", "15m"]);

    expect(backfillCalls).toEqual(["HEIUSDT", "HEIUSDT"]);
    expect(sockets[0]?.url).toContain("heiusdt@kline_5m");
    expect(sockets[0]?.url).toContain("bankusdt@kline_15m");
  });

  it("does not block stream startup on OI processing for the latest backfill snapshot", async () => {
    let releaseSnapshot: (() => void) | undefined;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const stream = new KlineStream({
      websocketFactory: (url: string) => new FakeWebSocket(url),
      restClient: {
        async getKlines(symbol: string, interval: "5m" | "15m") {
          return [{
            symbol,
            interval,
            openTime: 1,
            open: "1.0",
            high: "1.1",
            low: "0.9",
            close: "1.05",
            volume: "100",
            closeTime: 2,
            quoteAssetVolume: "200",
            tradeCount: 10,
            takerBuyBaseAssetVolume: "50",
            takerBuyQuoteAssetVolume: "100",
            isClosed: true,
            raw: [],
          }];
        },
      },
    });

    stream.onCandle(async (candle) => {
      if (candle.isStartupSnapshot) {
        await snapshotGate;
      }
    });

    const startPromise = stream.start(["HEIUSDT"], ["5m", "15m"]);
    const completedBeforeRelease = await Promise.race([
      startPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    releaseSnapshot?.();
    await startPromise;
    expect(completedBeforeRelease).toBe(true);
    await stream.stop();
  });

  it("polls the latest closed candle through REST when live polling is enabled", async () => {
    let pollCallback: (() => void) | undefined;
    const received: FuturesCandle[] = [];
    const calls: Array<{ symbol: string; interval: string; limit: number }> = [];
    const stream = new KlineStream({
      restPollingIntervalMs: 1_000,
      setIntervalFn(callback: () => void) {
        pollCallback = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn() {},
      websocketFactory: (url: string) => new FakeWebSocket(url),
      restClient: {
        async getKlines(symbol: string, interval: "5m" | "15m", limit: number) {
          calls.push({ symbol, interval, limit });
          if (limit === 50) {
            return [];
          }

          return [
            {
              symbol,
              interval,
              openTime: 1,
              open: "1.0",
              high: "1.1",
              low: "0.9",
              close: "1.05",
              volume: "100",
              closeTime: 2,
              quoteAssetVolume: "200",
              tradeCount: 10,
              takerBuyBaseAssetVolume: "50",
              takerBuyQuoteAssetVolume: "100",
              raw: [],
            },
          ];
        },
      },
    });

    stream.onCandle(async (candle) => {
      if (!candle.isBackfill) {
        received.push(candle);
      }
    });

    await stream.start(["HEIUSDT"], ["5m", "15m"]);
    pollCallback?.();
    await flushMicrotasks();

    expect(calls.filter((call) => call.limit === 2)).toEqual([
      { symbol: "HEIUSDT", interval: "5m", limit: 2 },
    ]);
    expect(received).toHaveLength(1);
    await stream.stop();
  });

  it("does not let one symbol's candle processing block REST polling for later symbols", async () => {
    let pollCallback: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstProcessingGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const received: string[] = [];
    const stream = new KlineStream({
      restPollingIntervalMs: 1_000,
      setIntervalFn(callback: () => void) {
        pollCallback = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn() {},
      websocketFactory: (url: string) => new FakeWebSocket(url),
      restClient: {
        async getKlines(symbol: string, interval: "5m" | "15m", limit: number) {
          if (limit === 50) {
            return [];
          }

          return [{
            symbol,
            interval,
            openTime: 1,
            open: "1.0",
            high: "1.1",
            low: "0.9",
            close: "1.05",
            volume: "100",
            closeTime: 2,
            quoteAssetVolume: "200",
            tradeCount: 10,
            takerBuyBaseAssetVolume: "50",
            takerBuyQuoteAssetVolume: "100",
            isClosed: true,
            raw: [],
          }];
        },
      },
    });

    stream.onCandle(async (candle) => {
      if (candle.isBackfill) {
        return;
      }

      received.push(candle.symbol!);
      if (candle.symbol === "HEIUSDT") {
        await firstProcessingGate;
      }
    });

    await stream.start(["HEIUSDT", "APRUSDT"], ["5m", "15m"]);
    pollCallback?.();
    await flushMicrotasks();

    const receivedBeforeRelease = [...received];
    releaseFirst?.();
    await flushMicrotasks();
    await stream.stop();

    expect(receivedBeforeRelease).toEqual(expect.arrayContaining(["HEIUSDT", "APRUSDT"]));
  });

  it("emits live and closed klines, ignores malformed payloads without logging raw data, and reconnects with capped exponential backoff", async () => {
    const sockets: FakeWebSocket[] = [];
    const warnings: string[] = [];
    const delays: number[] = [];
    const received: Array<{ symbol: string; interval: string; isClosed?: boolean }> = [];

    const stream = new KlineStream({
      wsBaseUrl: "wss://fstream.binance.com",
      websocketFactory: (url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      restClient: {
        async getKlines() {
          return [];
        },
      },
      sleep: async (delayMs: number) => {
        delays.push(delayMs);
      },
      logger: {
        info() {},
        warn(message: string) {
          warnings.push(message);
        },
      },
    });

    stream.onCandle(async (candle) => {
      received.push({
        symbol: candle.symbol!,
        interval: candle.interval!,
        isClosed: candle.isClosed,
      });
    });

    await stream.start(["HEIUSDT"], ["5m", "15m"]);

    sockets[0]?.open();
    sockets[0]?.message("not-json secret-header=Bearer abc123");
    sockets[0]?.message(
      createWsKlineMessage({
        symbol: "HEIUSDT",
        interval: "5m",
        openTime: 1_000,
        closeTime: 301_000,
        isClosed: false,
      }),
    );
    sockets[0]?.message(
      createWsKlineMessage({
        symbol: "HEIUSDT",
        interval: "15m",
        openTime: 2_000,
        closeTime: 902_000,
        isClosed: true,
      }),
    );

    expect(received).toEqual([
      { symbol: "HEIUSDT", interval: "5m", isClosed: false },
      { symbol: "HEIUSDT", interval: "15m", isClosed: true },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("malformed");
    expect(warnings[0]).not.toContain("secret-header");
    expect(warnings[0]).not.toContain("abc123");

    sockets[0]?.close();
    await flushMicrotasks();
    sockets[1]?.close();
    await flushMicrotasks();
    sockets[2]?.close();
    await flushMicrotasks();
    sockets[3]?.close();
    await flushMicrotasks();
    sockets[4]?.close();
    await flushMicrotasks();
    sockets[5]?.close();
    await flushMicrotasks();

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(sockets).toHaveLength(7);
  });

  it("catches candle-handler rejections, logs a sanitized dispatch failure, and reports the background error", async () => {
    const sockets: FakeWebSocket[] = [];
    const warnings: string[] = [];
    const backgroundErrors: Array<{ scope: string; message: string }> = [];

    const stream = new KlineStream({
      wsBaseUrl: "wss://fstream.binance.com",
      websocketFactory: (url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      restClient: {
        async getKlines() {
          return [];
        },
      },
      logger: {
        info() {},
        warn(message: string) {
          warnings.push(message);
        },
      },
      onError(event) {
        backgroundErrors.push({
          scope: event.scope,
          message: event.message,
        });
      },
    });

    stream.onCandle(async () => {
      throw new Error("dispatch token=secret symbol=HEIUSDT");
    });

    await stream.start(["HEIUSDT"], ["5m", "15m"]);

    sockets[0]?.message(
      createWsKlineMessage({
        symbol: "HEIUSDT",
        interval: "5m",
        openTime: 10_000,
        closeTime: 310_000,
        isClosed: true,
      }),
    );
    await flushMicrotasks();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("dispatch failed");
    expect(warnings[0]).not.toContain("token=secret");
    expect(backgroundErrors).toEqual([
      {
        scope: "message-dispatch",
        message: "dispatch token=REDACTED symbol=HEIUSDT",
      },
    ]);
  });

  it("skips checkpointed startup backfill candles and stamps backfill received timestamps separately from source timestamps", async () => {
    const received: Array<{ openTime: number; sourceTimestamp?: number; receivedTimestamp?: number; isBackfill?: boolean; isStartupSnapshot?: boolean }> = [];

    const options: any = {
      wsBaseUrl: "wss://fstream.binance.com",
      now: () => 9_999,
      checkpointProvider: {
        async getCheckpoint(stream: string) {
          return stream === "HEIUSDT:5m" ? 600_000 : null;
        },
      },
      websocketFactory: (url: string) => new FakeWebSocket(url),
      restClient: {
        async getKlines(_symbol: string, interval: "5m" | "15m") {
          if (interval === "15m") {
            return [];
          }

          return [
            {
              symbol: "HEIUSDT",
              interval: "5m",
              openTime: 0,
              open: "1.0",
              high: "1.1",
              low: "0.9",
              close: "1.0",
              volume: "100",
              closeTime: 300_000,
              quoteAssetVolume: "200",
              tradeCount: 10,
              takerBuyBaseAssetVolume: "50",
              takerBuyQuoteAssetVolume: "100",
              isClosed: true,
              raw: [],
            },
            {
              symbol: "HEIUSDT",
              interval: "5m",
              openTime: 300_000,
              open: "1.0",
              high: "1.1",
              low: "0.9",
              close: "1.0",
              volume: "100",
              closeTime: 600_000,
              quoteAssetVolume: "200",
              tradeCount: 10,
              takerBuyBaseAssetVolume: "50",
              takerBuyQuoteAssetVolume: "100",
              isClosed: true,
              raw: [],
            },
            {
              symbol: "HEIUSDT",
              interval: "5m",
              openTime: 600_000,
              open: "1.0",
              high: "1.1",
              low: "0.9",
              close: "1.0",
              volume: "100",
              closeTime: 900_000,
              quoteAssetVolume: "200",
              tradeCount: 10,
              takerBuyBaseAssetVolume: "50",
              takerBuyQuoteAssetVolume: "100",
              isClosed: true,
              raw: [],
            },
          ];
        },
      },
      logger: {
        info() {},
        warn() {},
      },
    };

    const stream = new KlineStream(options);
    stream.onCandle(async (candle) => {
      received.push({
        openTime: candle.openTime,
        sourceTimestamp: candle.sourceTimestamp,
        receivedTimestamp: candle.receivedTimestamp,
        isBackfill: candle.isBackfill,
        isStartupSnapshot: candle.isStartupSnapshot,
      });
    });

    await stream.start(["HEIUSDT"], ["5m", "15m"]);

    expect(received).toEqual([
      {
        openTime: 600_000,
        sourceTimestamp: 900_000,
        receivedTimestamp: 9_999,
        isBackfill: true,
      },
      {
        openTime: 600_000,
        sourceTimestamp: 900_000,
        receivedTimestamp: 9_999,
        isBackfill: true,
        isStartupSnapshot: true,
      },
    ]);
  });

  it("closes unhealthy sockets on heartbeat timeout, answers ping/pong, and resets reconnect backoff after a stable healthy connection", async () => {
    const timers = createManualTimers();
    const sockets: FakeWebSocket[] = [];
    const delays: number[] = [];
    const warnings: string[] = [];

    const options: any = {
      wsBaseUrl: "wss://fstream.binance.com",
      heartbeatTimeoutMs: 5_000,
      stableConnectionMs: 3_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      now: timers.now,
      websocketFactory: (url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      restClient: {
        async getKlines() {
          return [];
        },
      },
      sleep: async (delayMs: number) => {
        delays.push(delayMs);
      },
      logger: {
        info() {},
        warn(message: string) {
          warnings.push(message);
        },
      },
    };

    const stream = new KlineStream(options);
    await stream.start(["HEIUSDT"], ["5m", "15m"]);

    sockets[0]?.open();
    await timers.advanceBy(5_000);
    expect(sockets[0]?.closeCount).toBe(1);
    expect(delays).toEqual([1_000]);

    sockets[1]?.open();
    await timers.advanceBy(5_000);
    expect(sockets[1]?.closeCount).toBe(1);
    expect(delays).toEqual([1_000, 2_000]);

    sockets[2]?.open();
    sockets[2]?.ping();
    expect(sockets[2]?.sent).toContain("pong");
    sockets[2]?.message(
      createWsKlineMessage({
        symbol: "HEIUSDT",
        interval: "5m",
        openTime: 1_000,
        closeTime: 301_000,
        isClosed: false,
      }),
    );
    await timers.advanceBy(3_000);
    sockets[2]?.close();
    await flushMicrotasks();

    expect(delays).toEqual([1_000, 2_000, 1_000]);
    expect(warnings.some((warning) => warning.includes("heartbeat"))).toBe(true);
  });

  it("retries reconnect backfill and socket setup failures until the chunk reconnects", async () => {
    const sockets: FakeWebSocket[] = [];
    const warnings: string[] = [];
    const delays: number[] = [];
    let backfillAttempts = 0;
    let socketAttempts = 0;

    const stream = new KlineStream({
      wsBaseUrl: "wss://fstream.binance.com",
      websocketFactory: (url: string) => {
        socketAttempts += 1;
        if (socketAttempts === 2) {
          throw new Error("temporary socket setup failure");
        }

        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      restClient: {
        async getKlines() {
          backfillAttempts += 1;
          if (backfillAttempts === 3) {
            throw new Error("temporary backfill failure");
          }

          return [];
        },
      },
      sleep: async (delayMs: number) => {
        delays.push(delayMs);
      },
      logger: {
        info() {},
        warn(message: string) {
          warnings.push(message);
        },
      },
    });

    await stream.start(["HEIUSDT"], ["5m", "15m"]);
    sockets[0]?.close();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(delays).toEqual([1_000, 2_000, 4_000]);
    expect(sockets).toHaveLength(2);
    expect(warnings.some((warning) => warning.includes("reconnect failed"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("temporary backfill failure"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("temporary socket setup failure"))).toBe(true);
  });

  it("emits chunk-scoped connection-state events for open, close, heartbeat timeout, reconnect setup failure, and stop", async () => {
    const timers = createManualTimers();
    const sockets: FakeWebSocket[] = [];
    let socketAttempts = 0;
    const events: Array<{
      status: string;
      reason?: string;
      chunkIndex: number;
      chunkCount: number;
      symbols: string[];
      streams: string[];
    }> = [];

    const stream = new KlineStream({
      wsBaseUrl: "wss://fstream.binance.com",
      heartbeatTimeoutMs: 5_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      now: timers.now,
      websocketFactory: (url: string) => {
        socketAttempts += 1;
        if (socketAttempts === 2) {
          throw new Error("temporary socket setup failure");
        }

        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      restClient: {
        async getKlines() {
          return [];
        },
      },
      sleep: async () => undefined,
      logger: {
        info() {},
        warn() {},
      },
    });

    stream.onConnectionState((event) => {
      events.push({
        status: event.status,
        reason: event.reason,
        chunkIndex: event.chunkIndex,
        chunkCount: event.chunkCount,
        symbols: [...event.symbols],
        streams: [...event.streams],
      });
    });

    await stream.start(["HEIUSDT"], ["5m", "15m"]);

    sockets[0]?.open();
    sockets[0]?.close();
    await flushMicrotasks();

    const reconnectingSocket = sockets.at(-1);
    reconnectingSocket?.open();
    await timers.advanceBy(5_000);
    await flushMicrotasks();

    await stream.stop();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "connected",
          reason: "open",
          chunkIndex: 0,
          chunkCount: 1,
          symbols: ["HEIUSDT"],
          streams: ["heiusdt@kline_5m", "heiusdt@kline_15m"],
        }),
        expect.objectContaining({
          status: "disconnected",
          reason: "close",
          chunkIndex: 0,
          chunkCount: 1,
        }),
        expect.objectContaining({
          status: "disconnected",
          reason: "reconnect-setup-failure",
          chunkIndex: 0,
          chunkCount: 1,
        }),
        expect.objectContaining({
          status: "disconnected",
          reason: "heartbeat-timeout",
          chunkIndex: 0,
          chunkCount: 1,
        }),
        expect.objectContaining({
          status: "disconnected",
          reason: "stop",
          chunkIndex: 0,
          chunkCount: 1,
        }),
      ]),
    );
  });
});
