import type {
  FuturesCleanupInput,
  FuturesCleanupStats,
  FuturesCleanupRepository,
} from "../storage/futures-repository";

const DAY_MS = 24 * 60 * 60 * 1_000;

export type FuturesRetentionConfig = {
  hotRetentionDays: number;
  signalRetentionDays: number;
  sourceEventRetentionDays: number;
  cleanupIntervalMs: number;
  cleanupBatchSize: number;
};

type SetIntervalLike = (callback: () => void, delayMs: number) => unknown;
type ClearIntervalLike = (intervalId: unknown) => void;

type Logger = {
  warn?: (message: string) => void;
};

export class FuturesRetentionService {
  private readonly repository: FuturesCleanupRepository;
  private readonly now: () => number;
  private readonly retention: FuturesRetentionConfig;
  private readonly setIntervalFn: SetIntervalLike;
  private readonly clearIntervalFn: ClearIntervalLike;
  private readonly logger: Logger;
  private timer: unknown;

  constructor(options: {
    repository: FuturesCleanupRepository;
    retention: FuturesRetentionConfig;
    now?: () => number;
    setIntervalFn?: SetIntervalLike;
    clearIntervalFn?: ClearIntervalLike;
    logger?: Logger;
  }) {
    this.repository = options.repository;
    this.retention = options.retention;
    this.now = options.now ?? (() => Date.now());
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
    this.logger = options.logger ?? {};
  }

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    await this.runCleanup();
    this.timer = this.setIntervalFn(() => {
      void this.runCleanup();
    }, this.retention.cleanupIntervalMs);
  }

  async cleanupNow(): Promise<FuturesCleanupStats | undefined> {
    return this.runCleanup();
  }

  async stop(): Promise<void> {
    if (!this.timer) {
      return;
    }

    this.clearIntervalFn(this.timer);
    this.timer = undefined;
  }

  private async runCleanup(): Promise<FuturesCleanupStats | undefined> {
    const now = this.now();
    const input: FuturesCleanupInput = {
      hotCutoff: now - this.retention.hotRetentionDays * DAY_MS,
      signalCutoff: now - this.retention.signalRetentionDays * DAY_MS,
      sourceEventCutoff: now - this.retention.sourceEventRetentionDays * DAY_MS,
      batchSize: this.retention.cleanupBatchSize,
    };

    try {
      return await this.repository.cleanupHistoricalData(input);
    } catch (error) {
      this.logger.warn?.(
        `Futures historical cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return undefined;
    }
  }
}
