import type { FuturesSymbolInfo, SpotSymbolInfo } from "./futures";

export function getActiveSpotBaseAssets(spotSymbols: ReadonlyArray<SpotSymbolInfo>): ReadonlySet<string> {
  const active = new Set<string>();
  for (const symbol of spotSymbols) {
    if (symbol.status === "TRADING") {
      active.add(symbol.baseAsset);
    }
  }
  return active;
}

export function getDefaultFuturesUniverse(
  futuresSymbols: ReadonlyArray<FuturesSymbolInfo>,
): FuturesSymbolInfo[] {
  return futuresSymbols.filter(
    (symbol) =>
      symbol.status === "TRADING" && symbol.contractType === "PERPETUAL" && symbol.quoteAsset === "USDT",
  );
}

