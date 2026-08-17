import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const fixtureDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("loadConfig", () => {
  it("loads the local MySQL defaults without requiring Binance credentials", () => {
    const config = loadConfig({});

    expect(config.binanceFuturesRestBaseUrl).toBe("https://fapi.binance.com");
    expect(config.binanceFuturesWsBaseUrl).toBe("wss://fstream.binance.com");
    expect(config.bitgetApiBaseUrl).toBe("https://api.bitget.com");
    expect(config.bitgetHttpTimeoutMs).toBe(5_000);
    expect(config.bitgetReferenceCacheMs).toBe(300_000);
    expect(config.bitgetReferenceConcurrency).toBe(3);
    expect(config.bitgetReferenceDirectionalReturn).toBe(0.001);
    expect(config.bitgetReferenceOiDelta).toBe(0.02);
    expect(config.bitgetReferencePriceGap).toBe(0.003);
    expect(config.bitgetReferenceConfidenceCap).toBe(0.1);
    expect(config.mysqlHost).toBe("127.0.0.1");
    expect(config.mysqlPort).toBe(3306);
    expect(config.mysqlUser).toBe("root");
    expect(config.mysqlPassword).toBe("gao");
    expect(config.mysqlDatabase).toBe("crypto_monitor");
    expect(config.futuresStartupBackfillSymbolLimit).toBe(24);
    expect(config.futuresRestPollIntervalMs).toBe(30_000);
    expect(config.futuresRestPollSymbolLimit).toBe(24);
    expect(config.futuresHotRetentionDays).toBe(30);
    expect(config.futuresSignalRetentionDays).toBe(180);
    expect(config.futuresSourceEventRetentionDays).toBe(14);
    expect(config.futuresCleanupIntervalMs).toBe(21_600_000);
    expect(config.futuresCleanupBatchSize).toBe(5_000);
    expect(config.futuresPriceReturn5mThreshold).toBe(0.03);
    expect(config.binanceWeb3SkillsDir).toBeUndefined();
    expect(config.onchainRefreshMs).toBe(15_000);
    expect(config.telegramBotToken).toBeUndefined();
    expect(config.executionMode).toBe("SIMULATION");
    expect(config.executionMaxSlippageBps).toBe(15);
  });

  it("loads explicit MySQL settings and keeps the Binance proxy optional", () => {
    const config = loadConfig({
      MYSQL_HOST: "db.local",
      MYSQL_PORT: "3307",
      MYSQL_USER: "monitor",
      MYSQL_PASSWORD: "local-password",
      MYSQL_DATABASE: "radar",
      BINANCE_HTTP_PROXY: "http://proxy.example:8080",
      BINANCE_WEB3_SKILLS_DIR: "/opt/binance-skills",
      ONCHAIN_REFRESH_MS: "30000",
    });

    expect(config.mysqlHost).toBe("db.local");
    expect(config.mysqlPort).toBe(3307);
    expect(config.mysqlUser).toBe("monitor");
    expect(config.mysqlPassword).toBe("local-password");
    expect(config.mysqlDatabase).toBe("radar");
    expect(config.binanceHttpProxy).toBe("http://proxy.example:8080");
    expect(config.binanceWeb3SkillsDir).toBe("/opt/binance-skills");
    expect(config.onchainRefreshMs).toBe(30_000);
  });

  it("falls back to the standard HTTPS proxy when Binance proxy is not set", () => {
    const config = loadConfig({
      HTTPS_PROXY: "http://proxy.example:7897",
    });

    expect(config.binanceHttpProxy).toBe("http://proxy.example:7897");
  });

  it("prefers the Binance-specific proxy over standard proxy variables", () => {
    const config = loadConfig({
      BINANCE_HTTP_PROXY: "http://binance-proxy.example:7897",
      HTTPS_PROXY: "http://proxy.example:7897",
      HTTP_PROXY: "http://fallback.example:7897",
    });

    expect(config.binanceHttpProxy).toBe("http://binance-proxy.example:7897");
  });

  it("rejects an invalid MySQL port", () => {
    expect(() => loadConfig({ MYSQL_PORT: "0" })).toThrow("MYSQL_PORT");
  });

  it("rejects non-positive Bitget durations concurrency and thresholds", () => {
    expect(() => loadConfig({ BITGET_HTTP_TIMEOUT_MS: "0" })).toThrow("BITGET_HTTP_TIMEOUT_MS");
    expect(() => loadConfig({ BITGET_REFERENCE_CACHE_MS: "0" })).toThrow("BITGET_REFERENCE_CACHE_MS");
    expect(() => loadConfig({ BITGET_REFERENCE_CONCURRENCY: "0" })).toThrow("BITGET_REFERENCE_CONCURRENCY");
    expect(() => loadConfig({ BITGET_REFERENCE_DIRECTION_RETURN: "0" })).toThrow(
      "BITGET_REFERENCE_DIRECTION_RETURN",
    );
    expect(() => loadConfig({ BITGET_REFERENCE_OI_DELTA: "0" })).toThrow("BITGET_REFERENCE_OI_DELTA");
    expect(() => loadConfig({ BITGET_REFERENCE_PRICE_GAP: "0" })).toThrow("BITGET_REFERENCE_PRICE_GAP");
    expect(() => loadConfig({ BITGET_REFERENCE_CONFIDENCE_CAP: "0" })).toThrow(
      "BITGET_REFERENCE_CONFIDENCE_CAP",
    );
  });

  it("rejects Telegram configuration when only one Telegram field is present", () => {
    expect(() =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: "secret-is-not-printed",
      }),
    ).toThrow("TELEGRAM_CHAT_ID");
  });

  it("accepts demo execution credentials as optional configuration without enabling them by default", () => {
    const config = loadConfig({
      BINANCE_EXECUTION_MODE: "BINANCE_DEMO_TESTNET",
      BINANCE_DEMO_API_KEY: ["demo", "key"].join("-"),
      BINANCE_DEMO_API_SECRET: ["demo", "secret"].join("-"),
      BINANCE_DEMO_FUTURES_REST_BASE_URL: "https://demo-fapi.binance.com",
    });

    expect(config.executionMode).toBe("BINANCE_DEMO_TESTNET");
    expect(config.binanceDemoFuturesRestBaseUrl).toBe("https://demo-fapi.binance.com");
  });

  it("accepts BINANCE_PRODUCTION mode with production credentials", () => {
    const config = loadConfig({
      BINANCE_EXECUTION_MODE: "BINANCE_PRODUCTION",
      BINANCE_PRODUCTION_API_KEY: ["live", "key"].join("-"),
      BINANCE_PRODUCTION_API_SECRET: ["live", "secret"].join("-"),
    });

    expect(config.executionMode).toBe("BINANCE_PRODUCTION");
    expect(config.binanceProductionApiKey).toBe(["live", "key"].join("-"));
    expect(config.binanceProductionMinFreeMarginMultiplier).toBe(1.2);
  });

  it("rejects BINANCE_PRODUCTION mode without production credentials", () => {
    expect(() =>
      loadConfig({
        BINANCE_EXECUTION_MODE: "BINANCE_PRODUCTION",
      }),
    ).toThrow("BINANCE_PRODUCTION_API_KEY");
  });

  it("keeps the production start script aligned with the TypeScript build output", () => {
    const packageJson = JSON.parse(readFileSync(resolve(fixtureDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(packageJson.dependencies?.tsx).toBeDefined();
    expect(packageJson.devDependencies?.tsx).toBeUndefined();
    // tsx 不自动加载 .env，启动脚本必须显式 --env-file（本地与服务器一致）
    expect(packageJson.scripts?.start).toBe("node --env-file=.env --import tsx/esm dist/src/main.js");
  });
});
