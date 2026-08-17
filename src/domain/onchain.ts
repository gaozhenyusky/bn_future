export type OnchainChainId = "56" | "CT_501" | "8453";

export type OnchainSource = "smart-money-inflow" | "meme-rush" | "smart-money-signal";

export type OnchainGemStatus = "观察" | "重点观察" | "高风险";

export type OnchainDataCompleteness = "完整" | "部分";

export interface OnchainObservation {
  chainId: OnchainChainId;
  symbol: string;
  name?: string;
  contractAddress: string;
  logoUrl?: string;
  price?: number;
  marketCap?: number;
  liquidity?: number;
  volume?: number;
  priceChangePercent?: number;
  holders?: number;
  holdersTop10Percent?: number;
  smartMoneyInflow?: number;
  smartMoneyTraders?: number;
  smartMoneyCount?: number;
  tokenRiskLevel?: number;
  launchStage?: "新发行" | "接近迁移" | "已迁移";
  direction?: "buy" | "sell";
  signalStatus?: string;
  washTrading?: boolean;
  devSoldAll?: boolean;
  source: OnchainSource;
  evidence: string[];
  observedAt: number;
}

export interface OnchainGemCandidate {
  chainId: OnchainChainId;
  symbol: string;
  name?: string;
  contractAddress: string;
  logoUrl?: string;
  price?: number;
  marketCap?: number;
  liquidity?: number;
  volume?: number;
  priceChangePercent?: number;
  holders?: number;
  holdersTop10Percent?: number;
  smartMoneyInflow?: number;
  smartMoneyTraders?: number;
  smartMoneyCount?: number;
  tokenRiskLevel?: number;
  launchStage?: "新发行" | "接近迁移" | "已迁移";
  direction?: "buy" | "sell";
  signalStatus?: string;
  washTrading?: boolean;
  devSoldAll?: boolean;
  score: number;
  status: OnchainGemStatus;
  dataCompleteness: OnchainDataCompleteness;
  sources: OnchainSource[];
  evidence: string[];
  observedAt: number;
}

export interface OnchainSourceStatus {
  source: OnchainSource;
  chainId: OnchainChainId;
  status: "connected" | "degraded" | "unavailable";
  message?: string;
  updatedAt: number;
}

export interface OnchainSnapshot {
  candidates: OnchainGemCandidate[];
  statuses: OnchainSourceStatus[];
  scannedAt: number;
}

export const ONCHAIN_CHAINS: readonly OnchainChainId[] = ["56", "CT_501", "8453"];
