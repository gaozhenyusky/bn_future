import type { BinanceWeb3SkillsConnector } from "../connectors/binance-web3-skills";

/** Alpha 板块市场服务：定时拉取 Binance Alpha 代币，维护 baseAsset → 市值(M) 映射 */
export class AlphaMarketService {
  private readonly connector: Pick<BinanceWeb3SkillsConnector, "fetchAlphaRank">;
  private readonly refreshMs: number;
  private readonly onHealthChange?: (status: "connected" | "degraded" | "disconnected", message?: string) => void;
  private readonly now: () => number;

  /** baseAsset（大写，如 "AKE"）→ 市值（M USD） */
  private marketCapByBaseAsset = new Map<string, number>();
  private lastRefreshAt = 0;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private inFlight = false;

  constructor(options: {
    connector: Pick<BinanceWeb3SkillsConnector, "fetchAlphaRank">;
    refreshMs?: number;
    onHealthChange?: (status: "connected" | "degraded" | "disconnected", message?: string) => void;
    now?: () => number;
  }) {
    this.connector = options.connector;
    this.refreshMs = options.refreshMs ?? 60 * 60 * 1000;
    this.onHealthChange = options.onHealthChange;
    this.now = options.now ?? (() => Date.now());
  }

  get marketCapByBaseAssetSnapshot(): ReadonlyMap<string, number> {
    return this.marketCapByBaseAsset;
  }

  /** Alpha 集合是否已成功加载（未加载时不启用过滤，避免误伤） */
  get alphaReady(): boolean {
    return this.lastRefreshAt > 0;
  }

  get lastRefreshAtMs(): number {
    return this.lastRefreshAt;
  }

  async start(): Promise<void> {
    await this.refresh();
    if (!this.refreshTimer && this.refreshMs > 0) {
      this.refreshTimer = setInterval(() => {
        void this.refresh();
      }, this.refreshMs);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  async refresh(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;

    try {
      const chains = ["56", "CT_501", "8453", "1"];
      const results = await Promise.allSettled(
        chains.map((chainId) => this.connector.fetchAlphaRank(chainId, 200)),
      );

      const next = new Map<string, number>();
      let failedChains = 0;
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          failedChains += 1;
          continue;
        }
        for (const token of result.value) {
          const baseAsset = token.symbol.toUpperCase();
          if (!baseAsset) continue;
          const marketCapM = token.marketCapUsd !== undefined ? token.marketCapUsd / 1_000_000 : 0;
          // 同名冲突时保留市值更大的记录（更可能是主网币）。
          const existing = next.get(baseAsset);
          if (existing === undefined || marketCapM > existing) {
            next.set(baseAsset, marketCapM);
          }
        }
      }

      this.marketCapByBaseAsset = next;
      this.lastRefreshAt = this.now();

      if (failedChains === results.length) {
        this.onHealthChange?.("disconnected", "Binance Alpha 列表拉取失败");
      } else if (failedChains > 0) {
        this.onHealthChange?.("degraded", `${failedChains}/${results.length} 条链 Alpha 拉取失败`);
      } else {
        this.onHealthChange?.("connected", `Alpha ${next.size} 个代币`);
      }
    } catch {
      this.onHealthChange?.("disconnected", "Binance Alpha 列表拉取失败");
    } finally {
      this.inFlight = false;
    }
  }
}
