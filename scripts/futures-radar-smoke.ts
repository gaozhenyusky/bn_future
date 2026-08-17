import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultFuturesUniverse } from "../src/domain/universe";
import type { FuturesSymbolInfo } from "../src/domain/futures";
import { BinanceHttpError, BinanceResponseError } from "../src/connectors/binance-http";
import { BinanceFuturesRestClient } from "../src/connectors/binance-futures-rest";

type ConsoleLike = Pick<typeof console, "log" | "error">;

type FuturesExchangeInfoClient = {
  getFuturesExchangeInfo(): Promise<FuturesSymbolInfo[]>;
};

function toOptionalUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getBinanceProxyUrl(env: NodeJS.ProcessEnv): string | undefined {
  return toOptionalUrl(env.BINANCE_HTTP_PROXY ?? env.HTTPS_PROXY ?? env.HTTP_PROXY);
}

function formatSmokeError(error: unknown): string {
  if (error instanceof BinanceHttpError) {
    return `Smoke network error: ${error.message}`;
  }

  if (error instanceof BinanceResponseError) {
    return `Smoke response error: ${error.message}`;
  }

  if (error instanceof Error) {
    return `Smoke failed: ${error.message}`;
  }

  return "Smoke failed: unknown error";
}

function createDefaultClient(env: NodeJS.ProcessEnv): FuturesExchangeInfoClient {
  return new BinanceFuturesRestClient({
    futuresBaseUrl: toOptionalUrl(env.BINANCE_FUTURES_REST_BASE_URL),
    proxyUrl: getBinanceProxyUrl(env),
  });
}

export async function runFuturesSmoke(
  env: NodeJS.ProcessEnv = process.env,
  client: FuturesExchangeInfoClient = createDefaultClient(env),
  output: ConsoleLike = console,
): Promise<void> {
  const futuresSymbols = await client.getFuturesExchangeInfo();
  const universe = getDefaultFuturesUniverse(futuresSymbols);
  const sampleSymbols = universe
    .map((item) => item.symbol)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 25);

  output.log(
    JSON.stringify(
      {
        summary:
          "Binance Futures USDT perpetual exchange-info snapshot only; contract-only classification is not attempted in smoke mode.",
        connectorStatus: {
          bitgetReference:
            "Bitget reference factor is public read-only only; 429/418 or network failures are surfaced as unavailable without aggressive retry.",
        },
        tradingUsdtPerpetualCount: universe.length,
        sampleSymbols,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runFuturesSmoke();
  } catch (error) {
    console.error(formatSmokeError(error));
    process.exitCode = 1;
  }
}
