import { describe, expect, it, vi } from "vitest";
import { buildApp, type HealthState } from "../src/http/app";
import {
  createConnectorHealthController,
  createHealthTrackedStream,
  createRuntimeFromDependencies,
  runDirectEntry,
} from "../src/main";

type ConnectionEvent = {
  status: "connected" | "disconnected";
  reason?: string;
  chunkIndex: number;
  chunkCount: number;
  symbols: readonly string[];
  streams: readonly string[];
};

function createHealthState(): HealthState {
  return {
    connectors: {
      futuresStream: {
        status: "disconnected",
      },
      bitgetReference: {
        status: "disconnected",
      },
    },
  };
}

function createFakeStream() {
  let candleHandler: ((candle: unknown) => Promise<void>) | undefined;
  let connectionStateHandler: ((event: ConnectionEvent) => void) | undefined;

  return {
    onCandle(handler: (candle: unknown) => Promise<void>) {
      candleHandler = handler;
    },
    onConnectionState(handler: (event: ConnectionEvent) => void) {
      connectionStateHandler = handler;
    },
    async start() {
      void candleHandler;
    },
    async stop() {
      void connectionStateHandler;
    },
    emit(event: ConnectionEvent) {
      connectionStateHandler?.(event);
    },
  };
}

describe("createHealthTrackedStream", () => {
  it("marks the futures stream connected only after every configured chunk is open", async () => {
    const stream = createFakeStream();
    const health = createHealthState();
    const trackedStream = createHealthTrackedStream(stream as never, health);

    await trackedStream.start(["HEIUSDT", "BANKUSDT"], ["5m", "15m"]);

    expect(health.connectors.futuresStream.status).toBe("disconnected");

    stream.emit({
      status: "connected",
      reason: "open",
      chunkIndex: 0,
      chunkCount: 2,
      symbols: ["HEIUSDT"],
      streams: ["heiusdt@kline_5m", "heiusdt@kline_15m"],
    });

    expect(health.connectors.futuresStream.status).toBe("disconnected");

    stream.emit({
      status: "connected",
      reason: "open",
      chunkIndex: 1,
      chunkCount: 2,
      symbols: ["BANKUSDT"],
      streams: ["bankusdt@kline_5m", "bankusdt@kline_15m"],
    });

    expect(health.connectors.futuresStream.status).toBe("connected");

    stream.emit({
      status: "disconnected",
      reason: "close",
      chunkIndex: 1,
      chunkCount: 2,
      symbols: ["BANKUSDT"],
      streams: ["bankusdt@kline_5m", "bankusdt@kline_15m"],
    });

    expect(health.connectors.futuresStream.status).toBe("disconnected");
  });

  it("treats a successful zero-symbol start as connected and stop as disconnected", async () => {
    const stream = createFakeStream();
    const health = createHealthState();
    const trackedStream = createHealthTrackedStream(stream as never, health);

    await trackedStream.start([], ["5m", "15m"]);
    expect(health.connectors.futuresStream.status).toBe("connected");

    await trackedStream.stop();
    expect(health.connectors.futuresStream.status).toBe("disconnected");
  });
});

describe("createRuntimeFromDependencies", () => {
  it("listens before waiting for slow service initialization", async () => {
    const calls: string[] = [];
    let appListening = false;
    let resolveServiceStart!: () => void;
    const serviceStart = new Promise<void>((resolve) => {
      resolveServiceStart = resolve;
    });

    const runtime = createRuntimeFromDependencies({
      config: {
        httpHost: "127.0.0.1",
        httpPort: 3000,
      },
      health: createHealthState(),
      service: {
        async start() {
          calls.push("service:start");
          expect(appListening).toBe(true);
          await serviceStart;
        },
        async stop() {
          calls.push("service:stop");
        },
      },
      app: {
        async listen() {
          calls.push("app:listen");
          appListening = true;
          return "http://127.0.0.1:3000";
        },
        async close() {
          calls.push("app:close");
          return undefined;
        },
      },
      closePool: async () => {
        calls.push("pool:close");
      },
    });

    const startup = runtime.start().then(() => "started");
    const result = await Promise.race([
      startup,
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ]);

    resolveServiceStart();
    await startup;

    expect(result).toBe("started");
    expect(calls.slice(0, 2)).toEqual(["app:listen", "service:start"]);
    await runtime.stop();
  });

  it("keeps the read API available when background service initialization fails", async () => {
    const calls: string[] = [];

    const runtime = createRuntimeFromDependencies({
      config: {
        httpHost: "127.0.0.1",
        httpPort: 3000,
      },
      health: createHealthState(),
      service: {
        async start() {
          calls.push("service:start");
          throw new Error("startup failed");
        },
        async stop() {
          calls.push("service:stop");
        },
      },
      app: {
        async listen() {
          calls.push("app:listen");
          return "http://127.0.0.1:3000";
        },
        async close() {
          calls.push("app:close");
          return undefined;
        },
      },
      closePool: async () => {
        calls.push("pool:close");
      },
    });

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(calls).toEqual(["app:listen", "service:start"]);
    await runtime.stop();
    expect(calls).toEqual(["app:listen", "service:start", "app:close", "service:stop", "pool:close"]);
  });
});

describe("createConnectorHealthController", () => {
  it("marks degraded health with a sanitized public message and can recover to connected", () => {
    const health = createHealthState();
    const controller = createConnectorHealthController(health, "futuresProcessing", () => 1_720_000_000_000);

    controller.markDegraded("background token=secret wss://example.com/stream?key=raw");

    expect(health.connectors.futuresProcessing).toEqual({
      status: "degraded",
      message: "background token=REDACTED [redacted-url]",
      updatedAt: 1_720_000_000_000,
    });

    controller.markConnected();

    expect(health.connectors.futuresProcessing).toEqual({
      status: "connected",
      updatedAt: 1_720_000_000_000,
    });
  });
});

describe("buildApp /health", () => {
  it("returns degraded overall status when a connector is degraded or disconnected", async () => {
    const app = buildApp({
      repository: {
        listRadar: async () => [],
        listSignals: async () => [],
      } as never,
      health: {
        connectors: {
          futuresStream: {
            status: "connected",
            updatedAt: 1,
          },
          bitgetReference: {
            status: "degraded",
            message: "provider returned partial data",
            updatedAt: 2,
          },
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "degraded",
      connectors: {
        futuresStream: {
          status: "connected",
          updatedAt: 1,
        },
        bitgetReference: {
          status: "degraded",
          message: "provider returned partial data",
          updatedAt: 2,
        },
      },
    });

    await app.close();
  });
});

describe("runDirectEntry", () => {
  it("prints only a generic sanitized startup failure and sets a nonzero exit code", async () => {
    const errors: string[] = [];
    const processLike = {
      exitCode: 0,
      once: vi.fn(),
    };

    await runDirectEntry({
      startRuntime: async () => {
        throw new Error("token=secret wss://example.com/stream?key=raw");
      },
      consoleLike: {
        error(message: string) {
          errors.push(message);
        },
      },
      processLike: processLike as never,
    });

    expect(errors).toEqual(["Startup failed. Check configuration and connectivity."]);
    expect(processLike.exitCode).toBe(1);
    expect(processLike.once).not.toHaveBeenCalled();
  });
});
