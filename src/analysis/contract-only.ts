import type { ContractUniverseItem, FuturesSymbolInfo, SpotSymbolInfo } from "../domain/futures";
import { getActiveSpotBaseAssets, getDefaultFuturesUniverse } from "../domain/universe";

export function classifyContractOnly(
  futures: FuturesSymbolInfo,
  activeSpotBaseAssets: ReadonlySet<string>,
): ContractUniverseItem {
  const spotBaseAssetMatches = activeSpotBaseAssets.has(futures.baseAsset) ? [futures.baseAsset] : [];
  const isContractOnly = spotBaseAssetMatches.length === 0;

  return {
    ...futures,
    isContractOnly,
    spotBaseAssetMatches,
    contractOnlyReason: isContractOnly ? "NO_ACTIVE_SPOT_BASE_ASSET" : "SPOT_BASE_ASSET_PRESENT",
  };
}

export function buildContractUniverse(
  futuresSymbols: FuturesSymbolInfo[],
  spotSymbols: SpotSymbolInfo[],
): ContractUniverseItem[] {
  const activeSpotBaseAssets = getActiveSpotBaseAssets(spotSymbols);
  return getDefaultFuturesUniverse(futuresSymbols)
    .map((symbol) => classifyContractOnly(symbol, activeSpotBaseAssets))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
}
