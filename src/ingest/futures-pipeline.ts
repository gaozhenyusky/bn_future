import type {
  FundingRateSnapshot,
  FuturesCandle,
  FuturesKlineInterval,
  MarketContext,
  OpenInterestSnapshot,
  TakerFlowSnapshot,
} from "../domain/futures";
import { RateLimitedQueue } from "./rate-limited-queue";

const OI_RETRY_DELAYS_MS = [2_000, 5_000] as const;

type SleepLike = (delayMs: number) => Promise<void>;

type MarketDataRestClient = {
  getKlines(symbol: string, interval: FuturesKlineInterval, limit: number): Promise<FuturesCandle[]>;
  getOpenInterestHistory(
    symbol: string,
    period: FuturesKlineInterval,
    limit: number,
  ): Promise<OpenInterestSnapshot[]>;
  getTakerLongShortRatio(
    symbol: string,
    period: FuturesKlineInterval,
    limit: number,
  ): Promise<TakerFlowSnapshot[]>;
  getFundingRateHistory(symbol: string, limit: number): Promise<FundingRateSnapshot[]>;
};

type PipelineRepository = {
  saveCandle(candle: FuturesCandle): Promise<void>;
  getCheckpoint(stream: string): Promise<number | null>;
  setCheckpoint(stream: string, timestamp: number): Promise<void>;
};

async function readOptional<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch {
    return [];
  }
}

function intervalToMs(interval: FuturesKlineInterval): number {
  return interval === "5m" ? 5 * 60 * 1_000 : 15 * 60 * 1_000;
}

function createClosedCandleKey(candle: FuturesCandle): string {
  return `${requireSymbol(candle)}:${requireInterval(candle)}:${candle.openTime}`;
}

function createStreamKey(symbol: string, interval: FuturesKlineInterval): string {
  return `${symbol}:${interval}`;
}

function requireSymbol(candle: FuturesCandle): string {
  if (!candle.symbol) {
    throw new Error("Futures candle is missing symbol");
  }

  return candle.symbol;
}

function requireInterval(candle: FuturesCandle): FuturesKlineInterval {
  if (!candle.interval) {
    throw new Error("Futures candle is missing interval");
  }

  return candle.interval;
}

function normalizeCandleIdentity(
  candle: FuturesCandle,
  symbol: string,
  interval: FuturesKlineInterval,
): FuturesCandle {
  return {
    ...candle,
    symbol: candle.symbol ?? symbol,
    interval: candle.interval ?? interval,
  };
}

function normalizeIncomingCandle(candle: FuturesCandle, now: () => number): FuturesCandle {
  return {
    ...candle,
    sourceTimestamp: candle.sourceTimestamp ?? candle.closeTime,
    receivedTimestamp: candle.receivedTimestamp ?? now(),
  };
}

function selectMatchingOpenInterest(
  snapshots: readonly OpenInterestSnapshot[],
  candle: FuturesCandle,
): OpenInterestSnapshot | undefined {
  // 与 taker 相同：接受最近一个已发布的 OI 快照（<= closeTime），兼容发布滞后。
  return [...snapshots]
    .sort((left, right) => left.timestamp - right.timestamp)
    .filter((snapshot) => snapshot.timestamp <= candle.closeTime)
    .at(-1);
}

function selectPreviousOpenInterest(
  snapshots: readonly OpenInterestSnapshot[],
  currentSnapshot: OpenInterestSnapshot | undefined,
): OpenInterestSnapshot | undefined {
  if (!currentSnapshot) {
    return undefined;
  }

  return [...snapshots]
    .sort((left, right) => left.timestamp - right.timestamp)
    .filter((snapshot) => snapshot.timestamp < currentSnapshot.timestamp)
    .at(-1);
}

function selectMatchingTakerFlow(
  snapshots: readonly TakerFlowSnapshot[],
  candle: FuturesCandle,
): TakerFlowSnapshot | undefined {
  // Binance takerlongshortRatio 发布滞后可达 10+ 分钟：K 线闭合时最新周期数据
  // 可能尚未发布，接受最近一个已发布的快照（<= closeTime），用上一周期近似。
  return [...snapshots]
    .sort((left, right) => left.timestamp - right.timestamp)
    .filter((snapshot) => snapshot.timestamp <= candle.closeTime)
    .at(-1);
}

function selectFundingRate(
  fundingRates: readonly FundingRateSnapshot[],
  candle: FuturesCandle,
): FundingRateSnapshot | undefined {
  const sortedFundingRates = [...fundingRates].sort((left, right) => left.fundingTime - right.fundingTime);

  return sortedFundingRates.filter((snapshot) => snapshot.fundingTime <= candle.closeTime).at(-1) ?? sortedFundingRates.at(-1);
}

export class OiPoller {
  private readonly restClient: Pick<
    MarketDataRestClient,
    "getOpenInterestHistory" | "getTakerLongShortRatio" | "getFundingRateHistory"
  >;
  private readonly sleep: SleepLike;
  private readonly now: () => number;

  constructor(options: {
    restClient: Pick<MarketDataRestClient, "getOpenInterestHistory" | "getTakerLongShortRatio" | "getFundingRateHistory">;
    sleep?: SleepLike;
    now?: () => number;
  }) {
    this.restClient = options.restClient;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.now = options.now ?? (() => Date.now());
  }

  async pollClosedCandle(candle: FuturesCandle): Promise<MarketContext> {
    const symbol = requireSymbol(candle);
    const interval = requireInterval(candle);

    let fundingRate: FundingRateSnapshot | undefined;
    let openInterest: OpenInterestSnapshot | undefined;
    let previousOpenInterest: OpenInterestSnapshot | undefined;
    let takerFlow: TakerFlowSnapshot | undefined;

    for (let attempt = 0; attempt <= OI_RETRY_DELAYS_MS.length; attempt += 1) {
      const [openInterestHistory, takerFlowHistory, fundingRateHistory] = await Promise.all([
        readOptional(() => this.restClient.getOpenInterestHistory(symbol, interval, 10)),
        readOptional(() => this.restClient.getTakerLongShortRatio(symbol, interval, 10)),
        readOptional(() => this.restClient.getFundingRateHistory(symbol, 10)),
      ]);

      openInterest = selectMatchingOpenInterest(openInterestHistory, candle);
      previousOpenInterest = selectPreviousOpenInterest(openInterestHistory, openInterest);
      takerFlow = selectMatchingTakerFlow(takerFlowHistory, candle);
      fundingRate = fundingRate ?? selectFundingRate(fundingRateHistory, candle);

      if (openInterest && previousOpenInterest && takerFlow) {
        break;
      }

      if (attempt < OI_RETRY_DELAYS_MS.length) {
        await this.sleep(OI_RETRY_DELAYS_MS[attempt]);
      }
    }

    const missing: Array<"openInterest" | "previousOpenInterest" | "takerFlow" | "fundingRate"> = [];
    if (!openInterest) {
      missing.push("openInterest");
    }
    if (openInterest && !previousOpenInterest) {
      missing.push("previousOpenInterest");
    }
    if (!takerFlow) {
      missing.push("takerFlow");
    }
    if (!fundingRate) {
      missing.push("fundingRate");
    }

    return {
      symbol,
      interval,
      candleOpenTime: candle.openTime,
      candleCloseTime: candle.closeTime,
      openInterest,
      previousOpenInterest,
      takerFlow,
      fundingRate,
      sourceTimestamp: candle.sourceTimestamp ?? candle.closeTime,
      receivedTimestamp: candle.receivedTimestamp ?? this.now(),
      openInterestTimestamp: openInterest?.timestamp,
      takerFlowTimestamp: takerFlow?.timestamp,
      fundingRateTimestamp: fundingRate?.fundingTime,
      isComplete: missing.length === 0,
      missing,
    };
  }
}

export class FuturesPipeline {
  private readonly repository: PipelineRepository;
  private readonly oiPoller: { pollClosedCandle(candle: FuturesCandle): Promise<MarketContext> };
  private readonly restClient?: Pick<MarketDataRestClient, "getKlines">;
  private readonly queue: RateLimitedQueue;
  private readonly now: () => number;

  constructor(options: {
    repository: PipelineRepository;
    oiPoller: { pollClosedCandle(candle: FuturesCandle): Promise<MarketContext> };
    restClient?: Pick<MarketDataRestClient, "getKlines">;
    queue?: RateLimitedQueue;
    now?: () => number;
  }) {
    this.repository = options.repository;
    this.oiPoller = options.oiPoller;
    this.restClient = options.restClient;
    this.queue = options.queue ?? new RateLimitedQueue({ concurrency: 1 });
    this.now = options.now ?? (() => Date.now());
  }

  async handleCandle(candle: FuturesCandle): Promise<void> {
    const normalizedCandle = normalizeIncomingCandle(candle, this.now);
    await this.repository.saveCandle(normalizedCandle);

    if (!normalizedCandle.isClosed) {
      return;
    }

    await this.processClosedCandle(normalizedCandle, {
      allowGapRecovery: true,
    });
  }

  private async processClosedCandle(
    candle: FuturesCandle,
    options: {
      allowGapRecovery: boolean;
    },
  ) {
    const symbol = requireSymbol(candle);
    const interval = requireInterval(candle);
    const closedCandleKey = createClosedCandleKey(candle);
    const streamKey = createStreamKey(symbol, interval);
    const checkpointBeforeProcessing = await this.repository.getCheckpoint(streamKey);

    if (checkpointBeforeProcessing !== null && candle.closeTime <= checkpointBeforeProcessing) {
      return;
    }

    if (options.allowGapRecovery) {
      await this.recoverGap(candle, streamKey, checkpointBeforeProcessing);
      const checkpointAfterRecovery = await this.repository.getCheckpoint(streamKey);
      if (checkpointAfterRecovery !== null && candle.closeTime <= checkpointAfterRecovery) {
        return;
      }
    }

    await this.queue.enqueue(closedCandleKey, async () => {
      await this.oiPoller.pollClosedCandle(candle);
      await this.advanceCheckpoint(streamKey, candle.closeTime);
    });
  }

  private async recoverGap(candle: FuturesCandle, streamKey: string, checkpoint: number | null) {
    if (!this.restClient) {
      return;
    }

    const interval = requireInterval(candle);
    const symbol = requireSymbol(candle);

    if (checkpoint === null || candle.closeTime - checkpoint <= intervalToMs(interval)) {
      return;
    }

    const backfill = await this.restClient.getKlines(symbol, interval, 50);
    const orderedMissingCandles = backfill
      .map((item) => normalizeIncomingCandle(normalizeCandleIdentity(item, symbol, interval), this.now))
      .filter((item) => item.closeTime > checkpoint && item.closeTime < candle.closeTime && item.isClosed !== false)
      .sort((left, right) => left.openTime - right.openTime);

    for (const missingCandle of orderedMissingCandles) {
      await this.processClosedCandle(missingCandle, {
        allowGapRecovery: false,
      });
    }
  }

  private async advanceCheckpoint(streamKey: string, candidateTimestamp: number) {
    const currentCheckpoint = await this.repository.getCheckpoint(streamKey);
    if (currentCheckpoint === null || candidateTimestamp > currentCheckpoint) {
      await this.repository.setCheckpoint(streamKey, candidateTimestamp);
    }
  }
}
