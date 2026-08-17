import { z } from "zod";

const requiredUrl = (name: string) =>
  z
    .string({
      required_error: `${name} is required`,
    })
    .min(1, `${name} is required`)
    .url(`${name} must be a valid URL`);

const positiveNumber = (defaultValue: number, name: string) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return defaultValue;
    return Number(value);
  }, z.number().positive(`${name} must be greater than 0`));

const positiveInt = (defaultValue: number, name: string) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return defaultValue;
    return Number(value);
  }, z.number().int().positive(`${name} must be greater than 0`));

const configSchema = z
  .object({
    HTTP_HOST: z.string().min(1).default("127.0.0.1"),
    HTTP_PORT: positiveInt(8787, "HTTP_PORT"),
    MYSQL_HOST: z.string().min(1).default("127.0.0.1"),
    MYSQL_PORT: positiveInt(3306, "MYSQL_PORT"),
    MYSQL_USER: z.string().min(1).default("root"),
    MYSQL_PASSWORD: z.string().default("gao"),
    MYSQL_DATABASE: z.string().min(1).default("crypto_monitor"),
    MYSQL_CONNECTION_LIMIT: positiveInt(10, "MYSQL_CONNECTION_LIMIT"),
    BINANCE_FUTURES_REST_BASE_URL: requiredUrl("BINANCE_FUTURES_REST_BASE_URL").default("https://fapi.binance.com"),
    BINANCE_FUTURES_WS_BASE_URL: requiredUrl("BINANCE_FUTURES_WS_BASE_URL").default("wss://fstream.binance.com"),
    BINANCE_HTTP_PROXY: z.string().url("BINANCE_HTTP_PROXY must be a valid URL").optional(),
    HTTPS_PROXY: z.string().url("HTTPS_PROXY must be a valid URL").optional(),
    HTTP_PROXY: z.string().url("HTTP_PROXY must be a valid URL").optional(),
    BITGET_API_BASE_URL: requiredUrl("BITGET_API_BASE_URL").default("https://api.bitget.com"),
    BITGET_HTTP_TIMEOUT_MS: positiveInt(5_000, "BITGET_HTTP_TIMEOUT_MS"),
    BITGET_REFERENCE_CACHE_MS: positiveInt(300_000, "BITGET_REFERENCE_CACHE_MS"),
    BITGET_REFERENCE_CONCURRENCY: positiveInt(3, "BITGET_REFERENCE_CONCURRENCY"),
    BITGET_REFERENCE_DIRECTION_RETURN: positiveNumber(0.001, "BITGET_REFERENCE_DIRECTION_RETURN"),
    BITGET_REFERENCE_OI_DELTA: positiveNumber(0.02, "BITGET_REFERENCE_OI_DELTA"),
    BITGET_REFERENCE_PRICE_GAP: positiveNumber(0.003, "BITGET_REFERENCE_PRICE_GAP"),
    BITGET_REFERENCE_CONFIDENCE_CAP: positiveNumber(0.1, "BITGET_REFERENCE_CONFIDENCE_CAP"),
    BINANCE_WEB3_SKILLS_DIR: z.string().min(1).optional(),
    ONCHAIN_REFRESH_MS: positiveInt(15_000, "ONCHAIN_REFRESH_MS"),
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    TELEGRAM_CHAT_ID: z.string().min(1).optional(),
    FUTURES_POLL_CONCURRENCY: positiveInt(5, "FUTURES_POLL_CONCURRENCY"),
    FUTURES_STARTUP_BACKFILL_SYMBOL_LIMIT: positiveInt(24, "FUTURES_STARTUP_BACKFILL_SYMBOL_LIMIT"),
    FUTURES_REST_POLL_INTERVAL_MS: positiveInt(30_000, "FUTURES_REST_POLL_INTERVAL_MS"),
    FUTURES_REST_POLL_SYMBOL_LIMIT: positiveInt(24, "FUTURES_REST_POLL_SYMBOL_LIMIT"),
    FUTURES_VOLUME_RATIO_5M: positiveNumber(2, "FUTURES_VOLUME_RATIO_5M"),
    FUTURES_OI_DELTA_5M: positiveNumber(0.05, "FUTURES_OI_DELTA_5M"),
    FUTURES_VOLUME_RATIO_15M: positiveNumber(1.5, "FUTURES_VOLUME_RATIO_15M"),
    FUTURES_OI_DELTA_15M: positiveNumber(0.08, "FUTURES_OI_DELTA_15M"),
    FUTURES_HOT_RETENTION_DAYS: positiveInt(30, "FUTURES_HOT_RETENTION_DAYS"),
    FUTURES_SIGNAL_RETENTION_DAYS: positiveInt(180, "FUTURES_SIGNAL_RETENTION_DAYS"),
    FUTURES_SOURCE_EVENT_RETENTION_DAYS: positiveInt(14, "FUTURES_SOURCE_EVENT_RETENTION_DAYS"),
    FUTURES_CLEANUP_INTERVAL_MS: positiveInt(21_600_000, "FUTURES_CLEANUP_INTERVAL_MS"),
    FUTURES_CLEANUP_BATCH_SIZE: positiveInt(5_000, "FUTURES_CLEANUP_BATCH_SIZE"),
    FUTURES_PRICE_RETURN_5M_THRESHOLD: positiveNumber(0.03, "FUTURES_PRICE_RETURN_5M_THRESHOLD"),
    BINANCE_EXECUTION_MODE: z.enum(["SIMULATION", "BINANCE_DEMO_TESTNET", "BINANCE_PRODUCTION"]).default("SIMULATION"),
    BINANCE_DEMO_API_KEY: z.string().min(1).optional(),
    BINANCE_DEMO_API_SECRET: z.string().min(1).optional(),
    BINANCE_DEMO_FUTURES_REST_BASE_URL: z.string().url("BINANCE_DEMO_FUTURES_REST_BASE_URL must be a valid URL").optional(),
    BINANCE_PRODUCTION_API_KEY: z.string().min(1).optional(),
    BINANCE_PRODUCTION_API_SECRET: z.string().min(1).optional(),
    BINANCE_PRODUCTION_MIN_FREE_MARGIN_MULTIPLIER: positiveNumber(1.2, "BINANCE_PRODUCTION_MIN_FREE_MARGIN_MULTIPLIER"),
    EXECUTION_MAX_SLIPPAGE_BPS: positiveNumber(15, "EXECUTION_MAX_SLIPPAGE_BPS"),
  })
  .superRefine((value, ctx) => {
    const hasBotToken = value.TELEGRAM_BOT_TOKEN !== undefined;
    const hasChatId = value.TELEGRAM_CHAT_ID !== undefined;
    if (hasBotToken !== hasChatId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasBotToken ? ["TELEGRAM_CHAT_ID"] : ["TELEGRAM_BOT_TOKEN"],
        message: "Telegram configuration requires both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.",
      });
    }
    if (value.BINANCE_EXECUTION_MODE === "BINANCE_PRODUCTION") {
      const hasProductionCredentials = Boolean(value.BINANCE_PRODUCTION_API_KEY && value.BINANCE_PRODUCTION_API_SECRET);
      if (!hasProductionCredentials) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["BINANCE_PRODUCTION_API_KEY"],
          message: "BINANCE_PRODUCTION mode requires BINANCE_PRODUCTION_API_KEY and BINANCE_PRODUCTION_API_SECRET.",
        });
      }
    }
  });

export type AppConfig = {
  httpHost: string;
  httpPort: number;
  mysqlHost: string;
  mysqlPort: number;
  mysqlUser: string;
  mysqlPassword: string;
  mysqlDatabase: string;
  mysqlConnectionLimit: number;
  binanceFuturesRestBaseUrl: string;
  binanceFuturesWsBaseUrl: string;
  binanceHttpProxy?: string;
  bitgetApiBaseUrl: string;
  bitgetHttpTimeoutMs: number;
  bitgetReferenceCacheMs: number;
  bitgetReferenceConcurrency: number;
  bitgetReferenceDirectionalReturn: number;
  bitgetReferenceOiDelta: number;
  bitgetReferencePriceGap: number;
  bitgetReferenceConfidenceCap: number;
  binanceWeb3SkillsDir?: string;
  onchainRefreshMs: number;
  telegramBotToken?: string;
  telegramChatId?: string;
  futuresPollConcurrency: number;
  futuresStartupBackfillSymbolLimit: number;
  futuresRestPollIntervalMs: number;
  futuresRestPollSymbolLimit: number;
  futuresVolumeRatio5m: number;
  futuresOiDelta5m: number;
  futuresVolumeRatio15m: number;
  futuresOiDelta15m: number;
  futuresHotRetentionDays: number;
  futuresSignalRetentionDays: number;
  futuresSourceEventRetentionDays: number;
  futuresCleanupIntervalMs: number;
  futuresCleanupBatchSize: number;
  futuresPriceReturn5mThreshold: number;
  executionMode: "SIMULATION" | "BINANCE_DEMO_TESTNET" | "BINANCE_PRODUCTION";
  binanceDemoApiKey?: string;
  binanceDemoApiSecret?: string;
  binanceDemoFuturesRestBaseUrl?: string;
  binanceProductionApiKey?: string;
  binanceProductionApiSecret?: string;
  binanceProductionMinFreeMarginMultiplier: number;
  executionMaxSlippageBps: number;
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path[0] ? String(issue.path[0]) : "configuration";
    throw new Error(`Invalid ${field}: ${issue.message}`);
  }

  const value = parsed.data;
  return {
    httpHost: value.HTTP_HOST,
    httpPort: value.HTTP_PORT,
    mysqlHost: value.MYSQL_HOST,
    mysqlPort: value.MYSQL_PORT,
    mysqlUser: value.MYSQL_USER,
    mysqlPassword: value.MYSQL_PASSWORD,
    mysqlDatabase: value.MYSQL_DATABASE,
    mysqlConnectionLimit: value.MYSQL_CONNECTION_LIMIT,
    binanceFuturesRestBaseUrl: value.BINANCE_FUTURES_REST_BASE_URL,
    binanceFuturesWsBaseUrl: value.BINANCE_FUTURES_WS_BASE_URL,
    binanceHttpProxy: value.BINANCE_HTTP_PROXY ?? value.HTTPS_PROXY ?? value.HTTP_PROXY,
    bitgetApiBaseUrl: value.BITGET_API_BASE_URL,
    bitgetHttpTimeoutMs: value.BITGET_HTTP_TIMEOUT_MS,
    bitgetReferenceCacheMs: value.BITGET_REFERENCE_CACHE_MS,
    bitgetReferenceConcurrency: value.BITGET_REFERENCE_CONCURRENCY,
    bitgetReferenceDirectionalReturn: value.BITGET_REFERENCE_DIRECTION_RETURN,
    bitgetReferenceOiDelta: value.BITGET_REFERENCE_OI_DELTA,
    bitgetReferencePriceGap: value.BITGET_REFERENCE_PRICE_GAP,
    bitgetReferenceConfidenceCap: value.BITGET_REFERENCE_CONFIDENCE_CAP,
    binanceWeb3SkillsDir: value.BINANCE_WEB3_SKILLS_DIR,
    onchainRefreshMs: value.ONCHAIN_REFRESH_MS,
    telegramBotToken: value.TELEGRAM_BOT_TOKEN,
    telegramChatId: value.TELEGRAM_CHAT_ID,
    futuresPollConcurrency: value.FUTURES_POLL_CONCURRENCY,
    futuresStartupBackfillSymbolLimit: value.FUTURES_STARTUP_BACKFILL_SYMBOL_LIMIT,
    futuresRestPollIntervalMs: value.FUTURES_REST_POLL_INTERVAL_MS,
    futuresRestPollSymbolLimit: value.FUTURES_REST_POLL_SYMBOL_LIMIT,
    futuresVolumeRatio5m: value.FUTURES_VOLUME_RATIO_5M,
    futuresOiDelta5m: value.FUTURES_OI_DELTA_5M,
    futuresVolumeRatio15m: value.FUTURES_VOLUME_RATIO_15M,
    futuresOiDelta15m: value.FUTURES_OI_DELTA_15M,
    futuresHotRetentionDays: value.FUTURES_HOT_RETENTION_DAYS,
    futuresSignalRetentionDays: value.FUTURES_SIGNAL_RETENTION_DAYS,
    futuresSourceEventRetentionDays: value.FUTURES_SOURCE_EVENT_RETENTION_DAYS,
    futuresCleanupIntervalMs: value.FUTURES_CLEANUP_INTERVAL_MS,
    futuresCleanupBatchSize: value.FUTURES_CLEANUP_BATCH_SIZE,
    futuresPriceReturn5mThreshold: value.FUTURES_PRICE_RETURN_5M_THRESHOLD,
    executionMode: value.BINANCE_EXECUTION_MODE,
    binanceDemoApiKey: value.BINANCE_DEMO_API_KEY,
    binanceDemoApiSecret: value.BINANCE_DEMO_API_SECRET,
    binanceDemoFuturesRestBaseUrl: value.BINANCE_DEMO_FUTURES_REST_BASE_URL,
    binanceProductionApiKey: value.BINANCE_PRODUCTION_API_KEY,
    binanceProductionApiSecret: value.BINANCE_PRODUCTION_API_SECRET,
    binanceProductionMinFreeMarginMultiplier: value.BINANCE_PRODUCTION_MIN_FREE_MARGIN_MULTIPLIER,
    executionMaxSlippageBps: value.EXECUTION_MAX_SLIPPAGE_BPS,
  };
}
