import { calculateBitgetReference } from "../analysis/bitget-reference-factor";
import type {
  BitgetFundingRate,
  BitgetFuturesContract,
  BitgetMarketCandle,
  BitgetMarketInterval,
  BitgetOpenInterest,
  BitgetReferenceFactor,
  BitgetReferenceInput,
  BitgetReferenceThresholds,
  BitgetReferenceUnavailableField,
  BitgetSpotSymbol,
} from "../domain/bitget-reference";
import { RateLimitedQueue } from "../ingest/rate-limited-queue";

type MetadataSnapshot = {
  expiresAt: number;
  spotSymbols: BitgetSpotSymbol[];
  futuresContracts: BitgetFuturesContract[];
};

type MarketClient = {
  getSpotSymbols(): Promise<BitgetSpotSymbol[]>;
  getFuturesContracts(): Promise<BitgetFuturesContract[]>;
  getSpotCandles(symbol: string, interval: BitgetMarketInterval, limit: number): Promise<BitgetMarketCandle[]>;
  getFuturesCandles(symbol: string, interval: BitgetMarketInterval, limit: number): Promise<BitgetMarketCandle[]>;
  getOpenInterest(symbol: string): Promise<BitgetOpenInterest | undefined>;
  getFundingRate(symbol: string): Promise<BitgetFundingRate | undefined>;
};

type EvaluateInput = {
  symbol: string;
  interval: BitgetMarketInterval;
  candleOpenTime: number;
  signalType: string;
  binanceOpen: number;
  binanceClose: number;
  binanceCloseTime: number;
};

type HealthStatus = "connected" | "degraded" | "disconnected";

function createEvaluateKey(input: EvaluateInput): string {
  return `${input.symbol}:${input.interval}:${input.candleOpenTime}`;
}

function createOpenInterestBaselineKey(input: Pick<EvaluateInput, "symbol" | "interval">): string {
  return `${input.symbol}:${input.interval}`;
}

function inferSignalBias(signalType: string): BitgetReferenceInput["signalBias"] {
  if (signalType === "LONG_BUILDUP_CANDIDATE" || signalType === "SHORT_COVERING") {
    return "LONG";
  }

  if (signalType === "SHORT_BUILDUP_CANDIDATE" || signalType === "LONG_LIQUIDATION") {
    return "SHORT";
  }

  return null;
}

export class BitgetReferenceService {
  private readonly marketClient: MarketClient;
  private readonly cacheMs: number;
  private readonly concurrency: number;
  private readonly thresholds: BitgetReferenceThresholds;
  private readonly now: () => number;
  private readonly onHealthChange?: (status: HealthStatus, message?: string) => void;
  private queue: RateLimitedQueue;
  private metadata?: MetadataSnapshot;
  private metadataPromise?: Promise<MetadataSnapshot>;
  private readonly inflight = new Map<string, Promise<BitgetReferenceFactor>>();
  private readonly previousOpenInterestBySymbol = new Map<string, BitgetOpenInterest>();
  private generation = 0;

  constructor(options: {
    marketClient: MarketClient;
    cacheMs: number;
    concurrency: number;
    thresholds: BitgetReferenceThresholds;
    now?: () => number;
    onHealthChange?: (status: HealthStatus, message?: string) => void;
  }) {
    this.marketClient = options.marketClient;
    this.cacheMs = options.cacheMs;
    this.concurrency = options.concurrency;
    this.thresholds = options.thresholds;
    this.now = options.now ?? (() => Date.now());
    this.onHealthChange = options.onHealthChange;
    this.queue = new RateLimitedQueue({
      concurrency: this.concurrency,
    });
  }

  async evaluate(input: EvaluateInput): Promise<BitgetReferenceFactor> {
    const key = createEvaluateKey(input);
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const generation = this.generation;
    const promise = this.queue.enqueue(key, async () => this.evaluateFresh(input, generation));
    this.inflight.set(key, promise);
    void promise.finally(() => {
      if (this.inflight.get(key) === promise) {
        this.inflight.delete(key);
      }
    });
    return promise;
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.metadata = undefined;
    this.metadataPromise = undefined;
    this.inflight.clear();
    this.previousOpenInterestBySymbol.clear();
    this.queue = new RateLimitedQueue({
      concurrency: this.concurrency,
    });
  }

  private async evaluateFresh(input: EvaluateInput, generation: number): Promise<BitgetReferenceFactor> {
    let metadata: MetadataSnapshot;
    try {
      metadata = await this.loadMetadata(generation);
    } catch (error) {
      const factor = this.createUnavailableFactor(input, ["spotCandles", "futuresCandles", "openInterest", "fundingRate"]);
      this.emitHealth(generation, "disconnected", this.describeMetadataFailure(error));
      return factor;
    }

    const hasSpotSymbol = metadata.spotSymbols.some((item) => item.symbol === input.symbol);
    const hasFuturesContract = metadata.futuresContracts.some((item) => item.symbol === input.symbol);

    if (!hasSpotSymbol || !hasFuturesContract) {
      const factor = this.createUnavailableFactor(input, ["spotCandles", "futuresCandles", "openInterest", "fundingRate"]);
      this.emitHealth(generation, "disconnected", `Bitget symbol metadata unavailable for ${input.symbol}`);
      return factor;
    }

    const unavailable = new Set<BitgetReferenceUnavailableField>();
    let degradedMessage: string | undefined;

    const spotCandles = await this.loadOptional("spotCandles", unavailable, async () =>
      this.marketClient.getSpotCandles(input.symbol, input.interval, 21),
    );
    const futuresCandles = await this.loadOptional("futuresCandles", unavailable, async () =>
      this.marketClient.getFuturesCandles(input.symbol, input.interval, 21),
    );
    const openInterest = await this.loadOptional("openInterest", unavailable, async () =>
      this.marketClient.getOpenInterest(input.symbol),
    );
    const fundingRate = await this.loadOptional("fundingRate", unavailable, async () =>
      this.marketClient.getFundingRate(input.symbol),
    );
    const openInterestBaselineKey = createOpenInterestBaselineKey(input);
    const previousOpenInterest = this.previousOpenInterestBySymbol.get(openInterestBaselineKey);

    if (unavailable.size > 0) {
      degradedMessage = `Bitget unavailable fields: ${[...unavailable].join(",")}`;
    }

    const factor = calculateBitgetReference({
      symbol: input.symbol,
      interval: input.interval,
      candleOpenTime: input.candleOpenTime,
      signalType: input.signalType,
      signalBias: inferSignalBias(input.signalType),
      binanceOpen: input.binanceOpen,
      binanceClose: input.binanceClose,
      binanceCloseTime: input.binanceCloseTime,
      spotCandles,
      futuresCandles,
      openInterest,
      previousOpenInterest,
      fundingRate,
      thresholds: this.thresholds,
      unavailable: [...unavailable],
    });

    if (openInterest && this.isCurrentGeneration(generation)) {
      this.previousOpenInterestBySymbol.set(openInterestBaselineKey, openInterest);
    }

    if (factor.status === "BITGET_UNAVAILABLE") {
      this.emitHealth(generation, "disconnected", degradedMessage);
    } else if (factor.completeness === "PARTIAL") {
      this.emitHealth(generation, "degraded", degradedMessage ?? "Bitget returned partial data");
    } else {
      this.emitHealth(generation, "connected");
    }

    return factor;
  }

  private async loadMetadata(generation: number): Promise<MetadataSnapshot> {
    const now = this.now();
    if (this.metadata && this.metadata.expiresAt > now) {
      return this.metadata;
    }

    if (this.metadataPromise) {
      return this.metadataPromise;
    }

    const promise = Promise.all([
      this.marketClient.getSpotSymbols(),
      this.marketClient.getFuturesContracts(),
    ]).then(([spotSymbols, futuresContracts]) => {
      const snapshot: MetadataSnapshot = {
        expiresAt: this.now() + this.cacheMs,
        spotSymbols,
        futuresContracts,
      };
      if (this.isCurrentGeneration(generation)) {
        this.metadata = snapshot;
      }
      return snapshot;
    });
    this.metadataPromise = promise;

    try {
      return await promise;
    } finally {
      if (this.metadataPromise === promise) {
        this.metadataPromise = undefined;
      }
    }
  }

  private async loadOptional<T>(
    field: BitgetReferenceUnavailableField,
    unavailable: Set<BitgetReferenceUnavailableField>,
    load: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await load();
    } catch (error) {
      unavailable.add(field);
      return undefined;
    }
  }

  private createUnavailableFactor(
    input: EvaluateInput,
    unavailable: BitgetReferenceUnavailableField[],
  ): BitgetReferenceFactor {
    return calculateBitgetReference({
      symbol: input.symbol,
      interval: input.interval,
      candleOpenTime: input.candleOpenTime,
      signalType: input.signalType,
      signalBias: inferSignalBias(input.signalType),
      binanceOpen: input.binanceOpen,
      binanceClose: input.binanceClose,
      binanceCloseTime: input.binanceCloseTime,
      thresholds: this.thresholds,
      unavailable,
    });
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.generation;
  }

  private emitHealth(generation: number, status: HealthStatus, message?: string) {
    if (!this.isCurrentGeneration(generation)) {
      return;
    }

    this.onHealthChange?.(status, message);
  }

  private describeMetadataFailure(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }

    return "Bitget metadata unavailable";
  }
}
