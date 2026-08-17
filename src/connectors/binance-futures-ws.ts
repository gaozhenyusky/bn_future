import { ProxyAgent, WebSocket as UndiciWebSocket, type Dispatcher } from "undici";

import type { FuturesCandle, FuturesKlineInterval } from "../domain/futures";
import { sanitizeErrorMessage } from "../utils/sanitize-error";

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type KlineStreamErrorEvent = {
  scope: "message-dispatch" | "startup-snapshot-dispatch" | "reconnect-setup-failure";
  message: string;
  chunkIndex: number;
  chunkCount: number;
  symbols: readonly string[];
  streams: readonly string[];
};

type TimeoutHandle = ReturnType<typeof setTimeout>;
type SetTimeoutLike = (callback: () => void, delayMs: number) => TimeoutHandle;
type ClearTimeoutLike = (timeoutId: TimeoutHandle) => void;
type IntervalHandle = ReturnType<typeof setInterval>;
type SetIntervalLike = (callback: () => void, delayMs: number) => IntervalHandle;
type ClearIntervalLike = (intervalId: IntervalHandle) => void;

type WebSocketLike = {
  readonly url?: string;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: (error: unknown) => void;
  onping?: () => void;
  onpong?: () => void;
  send?: (message: string) => void;
  close?: () => void;
  pong?: () => void;
};

type KlineRestClient = {
  getKlines(symbol: string, interval: FuturesKlineInterval, limit: number): Promise<FuturesCandle[]>;
};

type SleepLike = (delayMs: number) => Promise<void>;

type CandleHandler = (candle: FuturesCandle) => Promise<void>;
type ConnectionStateHandler = (event: KlineStreamConnectionEvent) => void;
type WebSocketOptions = { dispatcher?: Dispatcher };
type WebSocketConstructor = (url: string, options?: WebSocketOptions) => WebSocketLike;
type ClosableWebSocketFactory = ((url: string) => WebSocketLike) & {
  close?: () => Promise<void> | void;
};

type StreamChunk = {
  streams: string[];
  symbols: string[];
};

type ConnectionState = {
  chunk: StreamChunk;
  stable: boolean;
  reconnectAttempt: number;
  socket?: WebSocketLike;
  heartbeatTimeout?: TimeoutHandle;
  stableTimeout?: TimeoutHandle;
};

const DEFAULT_WS_BASE_URL = "wss://fstream.binance.com";
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
const DEFAULT_STABLE_CONNECTION_MS = 10_000;

export function createBinanceWebSocketFactory(options: {
  proxyUrl?: string;
  createProxyAgent?: (proxyUrl: string) => Dispatcher;
  webSocketConstructor?: WebSocketConstructor;
} = {}): ClosableWebSocketFactory {
  const proxyUrl = options.proxyUrl?.trim();
  const dispatcher = proxyUrl
    ? (options.createProxyAgent ?? ((value: string) => new ProxyAgent(value)))(proxyUrl)
    : undefined;
  const webSocketConstructor =
    options.webSocketConstructor ??
    ((url: string, webSocketOptions?: WebSocketOptions) =>
      new UndiciWebSocket(url, webSocketOptions) as unknown as WebSocketLike);
  const factory = ((url: string) =>
    webSocketConstructor(url, dispatcher ? { dispatcher } : undefined)) as ClosableWebSocketFactory;

  if (dispatcher && typeof dispatcher.close === "function") {
    factory.close = async () => {
      await dispatcher.close();
    };
  }

  return factory;
}

export type KlineStreamConnectionReason =
  | "open"
  | "close"
  | "heartbeat-timeout"
  | "reconnect-setup-failure"
  | "stop";

export type KlineStreamConnectionEvent = {
  status: "connected" | "disconnected";
  reason: KlineStreamConnectionReason;
  chunkIndex: number;
  chunkCount: number;
  symbols: readonly string[];
  streams: readonly string[];
};

function chunkItems<T>(items: readonly T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push([...items.slice(index, index + chunkSize)]);
  }
  return chunks;
}

function createWsUrl(baseUrl: string, streams: readonly string[]): string {
  return `${baseUrl.replace(/\/+$/, "")}/stream?streams=${streams.join("/")}`;
}

function createBackoffDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 30_000);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseCandleMessage(payload: string, receivedTimestamp: number): FuturesCandle | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }

  const root = asObject(parsed);
  const data = root ? asObject(root.data) : undefined;
  const kline = data ? asObject(data.k) : undefined;
  const symbol = asString(kline?.s ?? data?.s);
  const interval = asString(kline?.i);

  if (!kline || !symbol || (interval !== "5m" && interval !== "15m")) {
    return undefined;
  }

  const openTime = asNumber(kline.t);
  const closeTime = asNumber(kline.T);
  const eventTime = data ? asNumber(data.E) : undefined;
  const open = asString(kline.o);
  const close = asString(kline.c);
  const high = asString(kline.h);
  const low = asString(kline.l);
  const volume = asString(kline.v);
  const quoteAssetVolume = asString(kline.q);
  const tradeCount = asNumber(kline.n);
  const takerBuyBaseAssetVolume = asString(kline.V);
  const takerBuyQuoteAssetVolume = asString(kline.Q);
  const isClosed = typeof kline.x === "boolean" ? kline.x : undefined;

  if (
    openTime === undefined ||
    closeTime === undefined ||
    !open ||
    !close ||
    !high ||
    !low ||
    !volume ||
    !quoteAssetVolume ||
    tradeCount === undefined ||
    !takerBuyBaseAssetVolume ||
    !takerBuyQuoteAssetVolume
  ) {
    return undefined;
  }

  return {
    symbol,
    interval,
    openTime,
    open,
    high,
    low,
    close,
    volume,
    closeTime,
    quoteAssetVolume,
    tradeCount,
    takerBuyBaseAssetVolume,
    takerBuyQuoteAssetVolume,
    isClosed,
    sourceTimestamp: eventTime ?? closeTime,
    receivedTimestamp,
    raw: parsed,
  };
}

function normalizeRestCandle(
  candle: FuturesCandle,
  symbol: string,
  interval: FuturesKlineInterval,
  receivedTimestamp: number,
): FuturesCandle {
  return {
    ...candle,
    symbol: candle.symbol ?? symbol,
    interval: candle.interval ?? interval,
    isClosed: candle.isClosed ?? true,
    sourceTimestamp: candle.sourceTimestamp ?? candle.closeTime,
    receivedTimestamp: candle.receivedTimestamp ?? receivedTimestamp,
  };
}

export class KlineStream {
  private readonly wsBaseUrl: string;
  private readonly restClient: KlineRestClient;
  private readonly websocketFactory: ClosableWebSocketFactory;
  private readonly sleep: SleepLike;
  private readonly logger: Logger;
  private readonly maxStreamsPerSocket: number;
  private readonly checkpointProvider?: { getCheckpoint(stream: string): Promise<number | null> };
  private readonly now: () => number;
  private readonly setTimeoutFn: SetTimeoutLike;
  private readonly clearTimeoutFn: ClearTimeoutLike;
  private readonly heartbeatTimeoutMs: number;
  private readonly stableConnectionMs: number;
  private readonly startupBackfillSymbolLimit: number;
  private readonly restPollingIntervalMs: number;
  private readonly restPollingSymbolLimit: number;
  private readonly setIntervalFn: SetIntervalLike;
  private readonly clearIntervalFn: ClearIntervalLike;
  private readonly onError?: (event: KlineStreamErrorEvent) => void;
  private readonly handlers: CandleHandler[] = [];
  private readonly connectionStateHandlers: ConnectionStateHandler[] = [];
  private readonly states: ConnectionState[] = [];
  private stopped = false;
  private intervals: readonly FuturesKlineInterval[] = ["5m", "15m"];
  private backfillSymbols = new Set<string>();
  private backfilledSymbols = new Set<string>();
  private pollingSymbols: string[] = [];
  private pollingIntervalIndex = 0;
  private pollingInFlight = false;
  private restPollingTimer?: IntervalHandle;

  constructor(options: {
    wsBaseUrl?: string;
    restClient: KlineRestClient;
    websocketFactory?: (url: string) => WebSocketLike;
    websocketProxyUrl?: string;
    createProxyAgent?: (proxyUrl: string) => Dispatcher;
    webSocketConstructor?: WebSocketConstructor;
    sleep?: SleepLike;
    logger?: Logger;
    maxStreamsPerSocket?: number;
    checkpointProvider?: { getCheckpoint(stream: string): Promise<number | null> };
    now?: () => number;
    setTimeoutFn?: SetTimeoutLike;
    clearTimeoutFn?: ClearTimeoutLike;
    heartbeatTimeoutMs?: number;
    stableConnectionMs?: number;
    startupBackfillSymbolLimit?: number;
    restPollingIntervalMs?: number;
    restPollingSymbolLimit?: number;
    setIntervalFn?: SetIntervalLike;
    clearIntervalFn?: ClearIntervalLike;
    onError?: (event: KlineStreamErrorEvent) => void;
  }) {
    this.wsBaseUrl = options.wsBaseUrl ?? DEFAULT_WS_BASE_URL;
    this.restClient = options.restClient;
    this.websocketFactory =
      options.websocketFactory ??
      createBinanceWebSocketFactory({
        proxyUrl: options.websocketProxyUrl,
        createProxyAgent: options.createProxyAgent,
        webSocketConstructor: options.webSocketConstructor,
      });
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.logger = options.logger ?? {};
    this.maxStreamsPerSocket = options.maxStreamsPerSocket ?? 200;
    this.checkpointProvider = options.checkpointProvider;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.stableConnectionMs = options.stableConnectionMs ?? DEFAULT_STABLE_CONNECTION_MS;
    this.startupBackfillSymbolLimit = options.startupBackfillSymbolLimit ?? 24;
    this.restPollingIntervalMs = options.restPollingIntervalMs ?? 0;
    this.restPollingSymbolLimit = options.restPollingSymbolLimit ?? 0;
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.onError = options.onError;
  }

  onCandle(handler: CandleHandler): void {
    this.handlers.push(handler);
  }

  onConnectionState(handler: ConnectionStateHandler): void {
    this.connectionStateHandlers.push(handler);
  }

  async start(symbols: string[], intervals: readonly ["5m", "15m"]): Promise<void> {
    this.stopped = false;
    this.intervals = intervals;
    this.backfillSymbols = new Set(symbols.slice(0, this.startupBackfillSymbolLimit));
    this.backfilledSymbols.clear();
    this.pollingSymbols =
      this.restPollingSymbolLimit > 0 ? symbols.slice(0, this.restPollingSymbolLimit) : [...symbols];
    this.pollingIntervalIndex = 0;

    const streams = symbols.flatMap((symbol) => intervals.map((interval) => `${symbol.toLowerCase()}@kline_${interval}`));
    const symbolChunks = chunkItems(streams, this.maxStreamsPerSocket).map((chunk) => ({
      streams: chunk,
      symbols: [...new Set(chunk.map((item) => item.split("@")[0]?.toUpperCase() ?? ""))].filter(Boolean),
    }));

    this.states.length = 0;
    symbolChunks.forEach((chunk) => {
      this.states.push({
        chunk,
        stable: false,
        reconnectAttempt: 0,
      });
    });

    // REST 轮询先于 WebSocket 连接启动：universe 刷新触发的 stop→start 中，
    // 即使某个 chunk 的 backfill/连接瞬时失败，轮询数据面也不会丢失。
    if (this.restPollingIntervalMs > 0 && this.pollingSymbols.length > 0 && !this.restPollingTimer) {
      this.restPollingTimer = this.setIntervalFn(() => {
        void this.pollLatestClosedCandles();
      }, this.restPollingIntervalMs);
    }

    for (let index = 0; index < this.states.length; index += 1) {
      try {
        await this.connect(index);
      } catch (error) {
        // 单 chunk 连接/回填失败不阻塞其它 chunk；WS 侧由 reconnect 循环持续重试。
        this.reportBackgroundError(
          index,
          "reconnect-setup-failure",
          error,
          "Binance Futures kline stream start failed",
        );
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.backfillSymbols.clear();
    this.backfilledSymbols.clear();
    this.pollingSymbols = [];
    this.pollingIntervalIndex = 0;
    this.pollingInFlight = false;
    if (this.restPollingTimer) {
      this.clearIntervalFn(this.restPollingTimer);
      this.restPollingTimer = undefined;
    }
    for (let index = 0; index < this.states.length; index += 1) {
      this.emitConnectionState(index, "disconnected", "stop");
    }
    for (const state of this.states) {
      state.socket?.close?.();
    }
    await this.websocketFactory.close?.();
  }

  private async connect(index: number): Promise<void> {
    const state = this.states[index];
    if (!state || this.stopped) {
      return;
    }

    await this.backfill(state.chunk, index);

    const socket = this.websocketFactory(createWsUrl(this.wsBaseUrl, state.chunk.streams));
    state.socket = socket;
    state.stable = false;

    socket.onopen = () => {
      this.bumpHeartbeat(index, socket);
      this.emitConnectionState(index, "connected", "open");
      this.logger.info?.(`Connected Binance Futures kline stream chunk ${index + 1}`);
    };
    socket.onmessage = (event) => {
      this.markHealthyActivity(index, socket);
      this.bumpHeartbeat(index, socket);
      void this.handleMessage(event.data).catch((error) => {
        this.reportBackgroundError(index, "message-dispatch", error, "Binance Futures kline stream dispatch failed");
      });
    };
    socket.onping = () => {
      this.markHealthyActivity(index, socket);
      this.bumpHeartbeat(index, socket);
      socket.pong?.();
      socket.send?.("pong");
    };
    socket.onpong = () => {
      this.markHealthyActivity(index, socket);
      this.bumpHeartbeat(index, socket);
    };
    socket.onclose = () => {
      this.clearStateTimers(state);
      this.emitConnectionState(index, "disconnected", "close");
      void this.handleClose(index);
    };
    socket.onerror = () => {
      this.logger.warn?.("Binance Futures kline stream error");
    };
  }

  private async handleClose(index: number): Promise<void> {
    const state = this.states[index];
    if (!state) {
      return;
    }

    state.stable = false;
    state.socket = undefined;

    if (this.stopped) {
      return;
    }

    while (!this.stopped) {
      const delay = createBackoffDelay(state.reconnectAttempt);
      state.reconnectAttempt += 1;
      await this.sleep(delay);

      if (this.stopped) {
        return;
      }

      try {
        await this.connect(index);
        return;
      } catch (error) {
        this.reportBackgroundError(
          index,
          "reconnect-setup-failure",
          error,
          "Binance Futures kline stream reconnect failed",
        );
        const failedSocket = state.socket as WebSocketLike | undefined;
        if (failedSocket && typeof failedSocket.close === "function") {
          failedSocket.close();
        }
        state.socket = undefined;
        this.clearStateTimers(state);
      }
    }
  }

  private async backfill(chunk: StreamChunk, chunkIndex: number): Promise<void> {
    for (const symbol of chunk.symbols) {
      if (
        !this.backfillSymbols.has(symbol) ||
        (this.restPollingIntervalMs > 0 && this.backfilledSymbols.has(symbol))
      ) {
        continue;
      }

      for (const interval of this.intervals) {
        const checkpoint = await this.checkpointProvider?.getCheckpoint(`${symbol}:${interval}`);
        const candles = await this.restClient.getKlines(symbol, interval, 50);
        const closedCandles = candles
          .map((candle) => normalizeRestCandle(candle, symbol, interval, this.now()))
          .filter((candle) => checkpoint === undefined || checkpoint === null || candle.closeTime > checkpoint)
          .filter((candle) => candle.isClosed !== false)
          .sort((left, right) => left.openTime - right.openTime);

        for (const candle of closedCandles) {
          await this.emitCandle({ ...candle, isBackfill: true });
        }

        // Historical candles are needed for the volume baseline, but they
        // should not each trigger expensive OI polling. Re-emit only the
        // newest closed candle as a normal event so the radar service builds
        // a current market context and score during startup.
        const latestClosedCandle = closedCandles.at(-1);
        if (latestClosedCandle) {
          void this.emitCandle({ ...latestClosedCandle, isBackfill: true, isStartupSnapshot: true }).catch((error) => {
            this.reportBackgroundError(
              chunkIndex,
              "startup-snapshot-dispatch",
              error,
              "Binance Futures startup snapshot dispatch failed",
            );
          });
        }
      }

      this.backfilledSymbols.add(symbol);
    }
  }

  private async pollLatestClosedCandles(): Promise<void> {
    if (this.stopped || this.pollingInFlight || this.pollingSymbols.length === 0) {
      return;
    }

    const interval = this.intervals[this.pollingIntervalIndex % this.intervals.length];
    this.pollingIntervalIndex += 1;
    this.pollingInFlight = true;

    try {
      for (const symbol of this.pollingSymbols) {
        try {
          const candles = await this.restClient.getKlines(symbol, interval, 2);
          const now = this.now();
          const latestClosed = candles
            .map((candle) => normalizeRestCandle(candle, symbol, interval, now))
            .filter((candle) => candle.closeTime <= now && candle.isClosed !== false)
            .sort((left, right) => left.openTime - right.openTime)
            .at(-1);

          if (latestClosed) {
            // Do not make the REST fetch loop wait for OI/metrics processing.
            // A slow symbol must not prevent later symbols from receiving a
            // fresh closed candle in the same polling round.
            void this.emitCandle(latestClosed).catch((error) => {
              this.logger.warn?.(
                `Binance Futures REST polling dispatch failed for ${symbol} ${interval}: ${
                  error instanceof Error ? error.message : "unknown error"
                }`,
              );
            });
          }
        } catch (error) {
          this.logger.warn?.(
            `Binance Futures REST polling failed for ${symbol} ${interval}: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
        }
      }
    } finally {
      this.pollingInFlight = false;
    }
  }

  private async handleMessage(payload: string): Promise<void> {
    const candle = parseCandleMessage(payload, this.now());
    if (!candle) {
      this.logger.warn?.("Ignored malformed Binance Futures kline message");
      return;
    }

    await this.emitCandle(candle);
  }

  private markHealthyActivity(index: number, socket: WebSocketLike) {
    this.scheduleStableConnection(index, socket);
  }

  private scheduleStableConnection(index: number, socket: WebSocketLike) {
    const state = this.states[index];
    if (!state) {
      return;
    }

    if (state.stableTimeout) {
      this.clearTimeoutFn(state.stableTimeout);
    }

    state.stableTimeout = this.setTimeoutFn(() => {
      if (this.stopped || state.socket !== socket) {
        return;
      }

      state.stable = true;
      state.reconnectAttempt = 0;
    }, this.stableConnectionMs);
  }

  private bumpHeartbeat(index: number, socket: WebSocketLike) {
    const state = this.states[index];
    if (!state) {
      return;
    }

    // Some outbound proxies complete the WebSocket handshake but drop the
    // exchange's data frames. REST polling remains the data plane in that case,
    // so do not repeatedly tear down a valid handshake and re-run backfill.
    if (this.restPollingIntervalMs > 0) {
      return;
    }

    if (state.heartbeatTimeout) {
      this.clearTimeoutFn(state.heartbeatTimeout);
    }

    state.heartbeatTimeout = this.setTimeoutFn(() => {
      if (this.stopped || state.socket !== socket) {
        return;
      }

      this.logger.warn?.("Binance Futures kline stream heartbeat timed out");
      this.emitConnectionState(index, "disconnected", "heartbeat-timeout");
      socket.close?.();
    }, this.heartbeatTimeoutMs);
  }

  private clearStateTimers(state: ConnectionState) {
    if (state.heartbeatTimeout) {
      this.clearTimeoutFn(state.heartbeatTimeout);
      state.heartbeatTimeout = undefined;
    }

    if (state.stableTimeout) {
      this.clearTimeoutFn(state.stableTimeout);
      state.stableTimeout = undefined;
    }
  }

  private async emitCandle(candle: FuturesCandle): Promise<void> {
    for (const handler of this.handlers) {
      await handler(candle);
    }
  }

  private emitConnectionState(
    index: number,
    status: KlineStreamConnectionEvent["status"],
    reason: KlineStreamConnectionReason,
  ) {
    const state = this.states[index];
    if (!state) {
      return;
    }

    const event: KlineStreamConnectionEvent = {
      status,
      reason,
      chunkIndex: index,
      chunkCount: this.states.length,
      symbols: [...state.chunk.symbols],
      streams: [...state.chunk.streams],
    };

    for (const handler of this.connectionStateHandlers) {
      handler(event);
    }
  }

  private reportBackgroundError(
    index: number,
    scope: KlineStreamErrorEvent["scope"],
    error: unknown,
    logPrefix: string,
  ) {
    const state = this.states[index];
    const message = sanitizeErrorMessage(error);

    this.logger.warn?.(`${logPrefix}: ${message}`);
    if (scope === "reconnect-setup-failure") {
      this.emitConnectionState(index, "disconnected", "reconnect-setup-failure");
    }

    this.onError?.({
      scope,
      message,
      chunkIndex: index,
      chunkCount: this.states.length,
      symbols: state ? [...state.chunk.symbols] : [],
      streams: state ? [...state.chunk.streams] : [],
    });
  }
}
