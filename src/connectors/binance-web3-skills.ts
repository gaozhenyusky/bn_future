import { execFile as nodeExecFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { OnchainChainId, OnchainObservation } from "../domain/onchain";

type ExecFileResult = { stdout: string | Buffer; stderr: string | Buffer };
type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; shell: false },
) => Promise<ExecFileResult>;

const defaultExecFile = promisify(nodeExecFile) as unknown as ExecFileLike;
const BINANCE_ICON_PREFIX = "https://bin.bnbstatic.com";

export interface BinanceWeb3SkillsConnectorOptions {
  skillsRoot?: string;
  nodeBinary?: string;
  timeoutMs?: number;
  execFileImpl?: ExecFileLike;
  now?: () => number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function getItems(payload: unknown): Record<string, unknown>[] {
  const root = asRecord(payload);
  const data = root?.data;
  const list = Array.isArray(data) ? data : asRecord(data)?.data;
  return Array.isArray(list) ? list.map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined) : [];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[$,%]/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function percentValue(value: unknown): number | undefined {
  return numberValue(value);
}

function iconUrl(value: unknown): string | undefined {
  const path = stringValue(value);
  if (!path) return undefined;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${BINANCE_ICON_PREFIX}${path.startsWith("/") ? "" : "/"}${path}`;
}

function addressFor(item: Record<string, unknown>): string | undefined {
  return stringValue(item.contractAddress) ?? stringValue(item.ca);
}

function symbolFor(item: Record<string, unknown>): string | undefined {
  return stringValue(item.symbol) ?? stringValue(item.ticker) ?? stringValue(item.tokenName);
}

function makeObservation(
  item: Record<string, unknown>,
  source: OnchainObservation["source"],
  chainId: OnchainChainId,
  evidence: string[],
  now: () => number,
): OnchainObservation | undefined {
  const contractAddress = addressFor(item);
  const symbol = symbolFor(item);
  if (!contractAddress || !symbol) return undefined;

  return {
    chainId,
    symbol,
    name: stringValue(item.name) ?? stringValue(item.tokenName),
    contractAddress,
    logoUrl: iconUrl(item.logoUrl ?? item.tokenIconUrl ?? item.icon),
    price: numberValue(item.price ?? item.currentPrice),
    marketCap: numberValue(item.marketCap ?? item.currentMarketCap),
    liquidity: numberValue(item.liquidity),
    volume: numberValue(item.volume),
    priceChangePercent: percentValue(item.priceChange ?? item.priceChangeRate),
    holders: numberValue(item.holders),
    holdersTop10Percent: percentValue(item.holdersTop10Percent),
    smartMoneyInflow: numberValue(item.inflow),
    smartMoneyTraders: numberValue(item.traders),
    smartMoneyCount: numberValue(item.smartMoneyCount),
    tokenRiskLevel: numberValue(item.tokenRiskLevel),
    evidence,
    source,
    observedAt: now(),
  };
}

function resolveSkillsRoot(explicit?: string): string | undefined {
  if (explicit) return explicit;

  const candidates = [
    process.env.BINANCE_WEB3_SKILLS_DIR,
    `${process.cwd()}/agent/skills`,
    `${process.cwd()}/../agent/skills`,
    `${process.cwd()}/../../agent/skills`,
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(`${candidate}/crypto-market-rank/scripts/cli.mjs`));
}

export class BinanceWeb3SkillsConnector {
  private readonly skillsRoot?: string;
  private readonly nodeBinary: string;
  private readonly timeoutMs: number;
  private readonly execFile: ExecFileLike;
  private readonly now: () => number;
  private readonly validateScripts: boolean;

  constructor(options: BinanceWeb3SkillsConnectorOptions = {}) {
    this.skillsRoot = resolveSkillsRoot(options.skillsRoot);
    this.nodeBinary = options.nodeBinary ?? process.execPath;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.execFile = options.execFileImpl ?? defaultExecFile;
    this.now = options.now ?? (() => Date.now());
    this.validateScripts = options.execFileImpl === undefined;
  }

  async fetchSmartMoneyInflow(chainId: OnchainChainId, period = "1h"): Promise<OnchainObservation[]> {
    const payload = await this.runSkill("crypto-market-rank", "smart-money-inflow", { chainId, period });
    return getItems(payload)
      .map((item) => makeObservation(item, "smart-money-inflow", chainId, ["聪明钱净流入榜"], this.now))
      .filter((item): item is OnchainObservation => item !== undefined);
  }

  async fetchMemeRush(chainId: OnchainChainId, rankType = 30): Promise<OnchainObservation[]> {
    const stage = rankType === 10 ? "新发行" : rankType === 20 ? "接近迁移" : "已迁移";
    const payload = await this.runSkill("meme-rush", "meme-rush", { chainId, rankType, limit: 50 });
    return getItems(payload)
      .map((item) => {
        const observation = makeObservation(item, "meme-rush", chainId, [`meme生命周期：${stage}`], this.now);
        if (!observation) return undefined;
        observation.launchStage = stage;
        observation.washTrading = item.tagDevWashTrading === true || item.tagInsiderWashTrading === true;
        observation.devSoldAll = item.devPosition === 2 || item.devPosition === "2";
        if (observation.washTrading) observation.evidence.push("洗盘风险");
        if (observation.devSoldAll) observation.evidence.push("开发者疑似清仓");
        return observation;
      })
      .filter((item): item is OnchainObservation => item !== undefined);
  }

  async fetchSmartMoneySignals(chainId: Extract<OnchainChainId, "56" | "CT_501">): Promise<OnchainObservation[]> {
    const payload = await this.runSkill("trading-signal", "smart-money", { chainId, page: 1, pageSize: 50 });
    return getItems(payload)
      .map((item) => {
        const observation = makeObservation(item, "smart-money-signal", chainId, [
          `聪明钱${stringValue(item.direction) === "sell" ? "卖出" : "买入"}信号`,
          `信号状态：${stringValue(item.status) ?? "未知"}`,
        ], this.now);
        if (!observation) return undefined;
        observation.direction = stringValue(item.direction) === "sell" ? "sell" : "buy";
        const maxGain = numberValue(item.maxGain);
        observation.signalStatus = stringValue(item.status);
        observation.smartMoneyCount = numberValue(item.smartMoneyCount);
        observation.priceChangePercent = maxGain === undefined ? observation.priceChangePercent : maxGain * 100;
        return observation;
      })
      .filter((item): item is OnchainObservation => item !== undefined);
  }

  /** Binance Alpha 板块代币：token-rank rankType=20（含市值，USD）；chainId 支持 56/CT_501/8453/1 */
  async fetchAlphaRank(chainId: string, size = 200): Promise<Array<{ symbol: string; contractAddress?: string; marketCapUsd?: number }>> {
    const payload = await this.runSkill("crypto-market-rank", "token-rank", {
      rankType: 20,
      chainId,
      page: 1,
      size,
    });
    const root = asRecord(payload);
    const data = asRecord(root?.data);
    const tokens = Array.isArray(data?.tokens) ? data.tokens : [];
    return tokens
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== undefined)
      .map((item) => ({
        symbol: stringValue(item.symbol) ?? "",
        contractAddress: stringValue(item.contractAddress),
        marketCapUsd: numberValue(item.marketCap),
      }))
      .filter((item) => item.symbol.length > 0);
  }

  private async runSkill(skillName: string, command: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.skillsRoot) {
      throw new Error("Binance Web3 skills are unavailable");
    }

    const scriptPath = `${this.skillsRoot}/${skillName}/scripts/cli.mjs`;
    if (this.validateScripts && !existsSync(scriptPath)) {
      throw new Error(`Binance Web3 skill is unavailable: ${skillName}`);
    }

    const result = await this.execFile(this.nodeBinary, [scriptPath, command, JSON.stringify(params)], {
      timeout: this.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
    });
    const stdout = String(result.stdout).trim();
    if (!stdout) throw new Error(`Binance Web3 skill returned no data: ${skillName}/${command}`);

    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new Error(`Binance Web3 skill returned invalid JSON: ${skillName}/${command}`);
    }
  }
}
