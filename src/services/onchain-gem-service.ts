import type {
  OnchainChainId,
  OnchainGemCandidate,
  OnchainObservation,
  OnchainSnapshot,
  OnchainSource,
  OnchainSourceStatus,
} from "../domain/onchain";
import { ONCHAIN_CHAINS } from "../domain/onchain";
import type { OnchainGemStore } from "../storage/onchain-gem-repository";

export interface OnchainGemConnector {
  fetchSmartMoneyInflow(chainId: OnchainChainId, period?: string): Promise<OnchainObservation[]>;
  fetchMemeRush(chainId: OnchainChainId, rankType?: number): Promise<OnchainObservation[]>;
  fetchSmartMoneySignals(chainId: Extract<OnchainChainId, "56" | "CT_501">): Promise<OnchainObservation[]>;
}

export interface OnchainGemServiceOptions {
  connector: OnchainGemConnector;
  refreshMs?: number;
  now?: () => number;
  store?: OnchainGemStore;
}

type SourceJob = {
  source: OnchainSource;
  chainId: OnchainChainId;
  run: () => Promise<OnchainObservation[]>;
};

const SOURCE_LABELS: Record<OnchainSource, string> = {
  "smart-money-inflow": "聪明钱净流入",
  "meme-rush": "meme 生命周期",
  "smart-money-signal": "聪明钱信号",
};

const optionalNumericFields = [
  "price",
  "marketCap",
  "liquidity",
  "volume",
  "priceChangePercent",
  "holders",
  "holdersTop10Percent",
  "smartMoneyInflow",
  "smartMoneyTraders",
  "smartMoneyCount",
  "tokenRiskLevel",
] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function scoreCandidate(candidate: OnchainGemCandidate): number {
  const liquidityScore = Math.min(Math.max(candidate.liquidity ?? 0, 0) / 50_000, 1) * 2;
  const inflowScore = Math.min(Math.max(candidate.smartMoneyInflow ?? 0, 0) / 100_000, 1) * 3;
  const traderScore = Math.min(Math.max(candidate.smartMoneyTraders ?? 0, 0) / 10, 1) * 2;
  const signalScore = Math.min(Math.max(candidate.smartMoneyCount ?? 0, 0) / 5, 1) * 1.5;
  const concentrationScore = candidate.holdersTop10Percent !== undefined && candidate.holdersTop10Percent <= 30 ? 1 : 0;
  const momentumScore = candidate.priceChangePercent !== undefined && candidate.priceChangePercent > 0
    ? Math.min(candidate.priceChangePercent / 20, 1) * 0.5
    : 0;
  const riskPenalty = candidate.tokenRiskLevel !== undefined && candidate.tokenRiskLevel >= 3 ? 3 : 0;
  const washPenalty = candidate.washTrading || candidate.devSoldAll || candidate.evidence.some((item) => item.includes("洗盘")) ? 3 : 0;
  const sellPenalty = candidate.direction === "sell" ? 1 : 0;

  return clamp(
    liquidityScore + inflowScore + traderScore + signalScore + concentrationScore + momentumScore
      - riskPenalty - washPenalty - sellPenalty,
    0,
    10,
  );
}

function classifyCandidate(candidate: OnchainGemCandidate): OnchainGemCandidate["status"] {
  if ((candidate.tokenRiskLevel ?? 0) >= 3 || candidate.washTrading || candidate.devSoldAll || candidate.evidence.some((item) => item.includes("洗盘"))) {
    return "高风险";
  }

  return candidate.score >= 6 ? "重点观察" : "观察";
}

function mergeObservation(existing: OnchainGemCandidate | undefined, observation: OnchainObservation): OnchainGemCandidate {
  if (!existing) {
    const candidate: OnchainGemCandidate = {
      ...observation,
      score: 0,
      status: "观察",
      dataCompleteness: "部分",
      sources: [observation.source],
      evidence: [...observation.evidence],
    };
    candidate.score = Number(scoreCandidate(candidate).toFixed(2));
    candidate.dataCompleteness = candidate.sources.length >= 2 ? "完整" : "部分";
    candidate.status = classifyCandidate(candidate);
    return candidate;
  }

  const candidate = { ...existing };
  for (const field of optionalNumericFields) {
    if (observation[field] !== undefined) {
      Object.assign(candidate, { [field]: observation[field] });
    }
  }

  for (const field of ["name", "logoUrl", "launchStage", "direction", "signalStatus"] as const) {
    if (observation[field] !== undefined) Object.assign(candidate, { [field]: observation[field] });
  }
  candidate.washTrading = candidate.washTrading || observation.washTrading;
  candidate.devSoldAll = candidate.devSoldAll || observation.devSoldAll;
  candidate.sources = Array.from(new Set([...candidate.sources, observation.source]));
  candidate.evidence = Array.from(new Set([...candidate.evidence, ...observation.evidence]));
  candidate.observedAt = Math.max(candidate.observedAt, observation.observedAt);
  candidate.score = Number(scoreCandidate(candidate).toFixed(2));
  candidate.dataCompleteness = candidate.sources.length >= 2 ? "完整" : "部分";
  candidate.status = classifyCandidate(candidate);
  return candidate;
}

function createJobs(connector: OnchainGemConnector): SourceJob[] {
  const jobs: SourceJob[] = [];
  for (const chainId of ONCHAIN_CHAINS) {
    jobs.push({
      source: "smart-money-inflow",
      chainId,
      run: () => connector.fetchSmartMoneyInflow(chainId, "1h"),
    });
    jobs.push({
      source: "meme-rush",
      chainId,
      run: () => connector.fetchMemeRush(chainId, 30),
    });
    if (chainId === "56" || chainId === "CT_501") {
      jobs.push({
        source: "smart-money-signal",
        chainId,
        run: () => connector.fetchSmartMoneySignals(chainId),
      });
    }
  }
  return jobs;
}

export class OnchainGemService {
  private readonly connector: OnchainGemConnector;
  private readonly refreshMs: number;
  private readonly now: () => number;
  private readonly store?: OnchainGemStore;
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanPromise: Promise<OnchainSnapshot> | undefined;
  private snapshot: OnchainSnapshot = {
    candidates: [],
    statuses: [],
    scannedAt: 0,
  };

  constructor(options: OnchainGemServiceOptions) {
    this.connector = options.connector;
    this.refreshMs = options.refreshMs ?? 15_000;
    this.now = options.now ?? (() => Date.now());
    this.store = options.store;
  }

  async start(): Promise<void> {
    if (this.store) {
      try {
        const saved = await this.store.loadSnapshot();
        if (saved) this.snapshot = saved;
      } catch {
        // A stale database snapshot must not prevent live monitoring.
      }
    }
    await this.scan();
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.scan();
      }, this.refreshMs);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getSnapshot(): OnchainSnapshot {
    return this.snapshot;
  }

  async scan(): Promise<OnchainSnapshot> {
    if (this.scanPromise) return this.scanPromise;

    this.scanPromise = this.scanInternal().finally(() => {
      this.scanPromise = undefined;
    });
    return this.scanPromise;
  }

  private async scanInternal(): Promise<OnchainSnapshot> {
    const jobs = createJobs(this.connector);
    const results = await Promise.all(jobs.map(async (job) => {
      try {
        const observations = await job.run();
        return {
          job,
          observations,
          status: {
            source: job.source,
            chainId: job.chainId,
            status: observations.length > 0 ? "connected" : "degraded",
            message: observations.length > 0 ? undefined : `${SOURCE_LABELS[job.source]}暂无候选数据`,
            updatedAt: this.now(),
          } satisfies OnchainSourceStatus,
        };
      } catch (error) {
        return {
          job,
          observations: [],
          status: {
            source: job.source,
            chainId: job.chainId,
            status: "unavailable",
            message: error instanceof Error ? error.message : `${SOURCE_LABELS[job.source]}不可用`,
            updatedAt: this.now(),
          } satisfies OnchainSourceStatus,
        };
      }
    }));

    const merged = new Map<string, OnchainGemCandidate>();
    for (const result of results) {
      for (const observation of result.observations) {
        const key = `${observation.chainId}:${observation.contractAddress.toLowerCase()}`;
        merged.set(key, mergeObservation(merged.get(key), observation));
      }
    }

    const snapshot: OnchainSnapshot = {
      candidates: Array.from(merged.values()).sort((left, right) => right.score - left.score || right.observedAt - left.observedAt),
      statuses: results.map((result) => result.status),
      scannedAt: this.now(),
    };
    this.snapshot = snapshot;
    if (this.store) {
      try {
        await this.store.saveSnapshot(snapshot);
      } catch {
        // Live API data remains useful when persistence is temporarily degraded.
      }
    }
    return snapshot;
  }
}
