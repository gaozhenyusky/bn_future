import type {
  FundingRateSnapshot,
  FuturesCandle,
  FuturesKlineInterval,
  MarketContext,
  OiAccumulation,
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

/**
 * 长窗口 OI 积累趋势：以历史快照中最早的一条为基线，计算到当前快照的累计变化率。
 * 单根 K 线的 oiValueDelta 只反映一个周期（5m/15m），资金提前数小时布局（GPS 回测
 * 中 OI 翻倍后放量启动）时无法体现；这里用整段历史窗口捕捉。
 */
function computeOiAccumulation(
  snapshots: readonly OpenInterestSnapshot[],
  currentSnapshot: OpenInterestSnapshot | undefined,
  interval: FuturesKlineInterval,
): OiAccumulation | undefined {
  if (!currentSnapshot) {
    return undefined;
  }

  const sorted = [...snapshots]
    .sort((left, right) => left.timestamp - right.timestamp)
    .filter((snapshot) => snapshot.timestamp <= currentSnapshot.timestamp);

  // 至少需要 7 个样本（当前 + 6 条历史）才有统计意义：5m 窗口约 30 分钟，15m 约 90 分钟。
  if (sorted.length < 7) {
    return undefined;
  }

  const baseline = sorted[0];
  const currentValue = Number.parseFloat(currentSnapshot.sumOpenInterestValue);
  const baselineValue = Number.parseFloat(baseline.sumOpenInterestValue);
  const currentUnits = Number.parseFloat(currentSnapshot.sumOpenInterest);
  const baselineUnits = Number.parseFloat(baseline.sumOpenInterest);

  let delta: number | undefined;
  if (baselineValue > 0 && currentValue > 0) {
    delta = currentValue / baselineValue - 1;
  } else if (baselineUnits > 0 && currentUnits > 0) {
    delta = currentUnits / baselineUnits - 1;
  }
  if (delta === undefined || !Number.isFinite(delta)) {
    return undefined;
  }

  const spanMinutes = Math.round((currentSnapshot.timestamp - baseline.timestamp) / 60_000);
  const hours = Math.floor(spanMinutes / 60);
  const minutes = spanMinutes % 60;
  const windowLabel = hours > 0 ? (minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`) : `${minutes}m`;

  return {
    windowLabel: `${windowLabel} (${interval}×${sorted.length})`,
    delta,
    samples: sorted.length,
  };
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
    let oiAccumulation: OiAccumulation | undefined;

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
      oiAccumulation = computeOiAccumulation(openInterestHistory, openInterest, interval);
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
      oiAccumulation,
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
