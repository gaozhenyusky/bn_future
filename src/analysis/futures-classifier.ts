import type { AppConfig } from "../config";
import type {
  FuturesKlineInterval,
  FuturesMetrics,
  FuturesSignal,
  FuturesSignalSeverity,
  FuturesSignalType,
  FuturesThresholds,
} from "../domain/futures";

type DirectionalBias = "LONG" | "SHORT" | null;

const INTERVAL_SORT_ORDER: Record<FuturesKlineInterval, number> = {
  "5m": 0,
  "15m": 1,
};

function formatThresholdNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toString();
}

function createDerivedThresholdVersion(
  interval: FuturesKlineInterval,
  volumeRatioThreshold: number,
  oiDeltaThreshold: number,
  flatOiDeltaTolerance: number,
  takerConfirmationThreshold: number,
): string {
  return [
    `cfg:${interval}`,
    `vr=${formatThresholdNumber(volumeRatioThreshold)}`,
    `oi=${formatThresholdNumber(oiDeltaThreshold)}`,
    `flat=${formatThresholdNumber(flatOiDeltaTolerance)}`,
    `taker=${formatThresholdNumber(takerConfirmationThreshold)}`,
  ].join(":");
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function getDirectionalOiDelta(metrics: FuturesMetrics): number {
  return metrics.oiUnitDelta !== 0 ? metrics.oiUnitDelta : metrics.oiValueDelta;
}

function getVolumeHot(metrics: FuturesMetrics, thresholds: FuturesThresholds): boolean {
  return metrics.volumeRatio >= thresholds.volumeRatioThreshold;
}

function getAbsOiSurge(metrics: FuturesMetrics): number {
  return Math.max(Math.abs(metrics.oiValueDelta), Math.abs(metrics.oiUnitDelta));
}

function buildSignal(
  metrics: FuturesMetrics,
  thresholds: FuturesThresholds,
  signalType: FuturesSignalType,
  severity: FuturesSignalSeverity,
  explanation: string,
  evidence: string[],
  confidence: number,
): FuturesSignal {
  return {
    signalType,
    severity,
    confidence: clampConfidence(confidence),
    explanation,
    evidence,
    symbol: metrics.symbol,
    interval: metrics.interval,
    candleOpenTime: metrics.candleOpenTime,
    thresholdVersion: thresholds.thresholdVersion,
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function determineDirectionalSignalType(metrics: FuturesMetrics): FuturesSignalType | null {
  const oiDirectionalDelta = getDirectionalOiDelta(metrics);

  if (metrics.priceReturn > 0 && oiDirectionalDelta > 0) {
    return "LONG_BUILDUP_CANDIDATE";
  }

  if (metrics.priceReturn < 0 && oiDirectionalDelta > 0) {
    return "SHORT_BUILDUP_CANDIDATE";
  }

  if (metrics.priceReturn > 0 && oiDirectionalDelta < 0) {
    return "SHORT_COVERING";
  }

  if (metrics.priceReturn < 0 && oiDirectionalDelta < 0) {
    return "LONG_LIQUIDATION";
  }

  return null;
}

function getSignalBias(signalType: FuturesSignalType): DirectionalBias {
  if (signalType === "LONG_BUILDUP_CANDIDATE" || signalType === "SHORT_COVERING") {
    return "LONG";
  }

  if (signalType === "SHORT_BUILDUP_CANDIDATE" || signalType === "LONG_LIQUIDATION") {
    return "SHORT";
  }

  return null;
}

function buildDirectionalExplanation(signalType: FuturesSignalType, metrics: FuturesMetrics): string {
  switch (signalType) {
    case "LONG_BUILDUP_CANDIDATE":
      return "price rose while open interest expanded on elevated volume";
    case "SHORT_BUILDUP_CANDIDATE":
      return "price fell while open interest expanded on elevated volume";
    case "SHORT_COVERING":
      return "price rose while open interest contracted, consistent with shorts closing";
    case "LONG_LIQUIDATION":
      return "price fell while open interest contracted, consistent with long liquidation";
    default:
      return "directional futures structure detected";
  }
}

function buildDirectionalEvidence(metrics: FuturesMetrics): string[] {
  return [
    `priceReturn=${formatPercent(metrics.priceReturn)}`,
    `oiUnitDelta=${formatPercent(metrics.oiUnitDelta)}`,
    `oiValueDelta=${formatPercent(metrics.oiValueDelta)}`,
    `volumeRatio=${metrics.volumeRatio.toFixed(2)}`,
    `takerImbalance=${formatPercent(metrics.takerImbalance)}`,
  ];
}

function withContractOnlyRisk(signal: FuturesSignal, metrics: FuturesMetrics): FuturesSignal {
  if (metrics.contractOnlyRisk.level !== "HIGH") {
    return signal;
  }

  const contractOnlyEvidence = `contractOnlyReason=${metrics.contractOnlyRisk.reason}`;

  return {
    ...signal,
    evidence: signal.evidence.includes(contractOnlyEvidence)
      ? signal.evidence
      : [...signal.evidence, contractOnlyEvidence],
    contractOnlyRisk: metrics.contractOnlyRisk,
  };
}

function compareConflictSignals(left: FuturesSignal, right: FuturesSignal): number {
  const intervalOrder = INTERVAL_SORT_ORDER[left.interval] - INTERVAL_SORT_ORDER[right.interval];
  if (intervalOrder !== 0) {
    return intervalOrder;
  }

  if (left.candleOpenTime !== right.candleOpenTime) {
    return left.candleOpenTime - right.candleOpenTime;
  }

  const signalTypeOrder = left.signalType.localeCompare(right.signalType);
  if (signalTypeOrder !== 0) {
    return signalTypeOrder;
  }

  return left.thresholdVersion.localeCompare(right.thresholdVersion);
}

function getCanonicalConflictSignals(signals: readonly FuturesSignal[]): FuturesSignal[] {
  return [...signals].sort(compareConflictSignals);
}

export function createFuturesThresholds(
  config: Pick<AppConfig, "futuresVolumeRatio5m" | "futuresOiDelta5m" | "futuresVolumeRatio15m" | "futuresOiDelta15m">,
  interval: FuturesKlineInterval,
  options?: Partial<Pick<FuturesThresholds, "flatOiDeltaTolerance" | "takerConfirmationThreshold" | "thresholdVersion">>,
): FuturesThresholds {
  const flatOiDeltaTolerance = options?.flatOiDeltaTolerance ?? 0.01;
  const takerConfirmationThreshold = options?.takerConfirmationThreshold ?? 0.05;

  if (interval === "5m") {
    return {
      volumeRatioThreshold: config.futuresVolumeRatio5m,
      oiDeltaThreshold: config.futuresOiDelta5m,
      flatOiDeltaTolerance,
      takerConfirmationThreshold,
      thresholdVersion:
        options?.thresholdVersion ??
        createDerivedThresholdVersion(
          interval,
          config.futuresVolumeRatio5m,
          config.futuresOiDelta5m,
          flatOiDeltaTolerance,
          takerConfirmationThreshold,
        ),
    };
  }

  return {
    volumeRatioThreshold: config.futuresVolumeRatio15m,
    oiDeltaThreshold: config.futuresOiDelta15m,
    flatOiDeltaTolerance,
    takerConfirmationThreshold,
    thresholdVersion:
      options?.thresholdVersion ??
      createDerivedThresholdVersion(
        interval,
        config.futuresVolumeRatio15m,
        config.futuresOiDelta15m,
        flatOiDeltaTolerance,
        takerConfirmationThreshold,
      ),
  };
}

export function classifyFuturesSignal(
  metrics: FuturesMetrics,
  thresholds: FuturesThresholds,
): FuturesSignal | null {
  if (metrics.dataCompleteness !== "COMPLETE") {
    if (metrics.contractOnlyRisk.level === "HIGH") {
      return withContractOnlyRisk(
        buildSignal(
          metrics,
          thresholds,
          "CONTRACT_ONLY_RISK",
          "WARNING",
          "contract-only futures instrument lacks an active Spot base asset, so directional interpretation stays suppressed until the data is complete",
          [`contractOnlyReason=${metrics.contractOnlyRisk.reason}`, `dataCompleteness=${metrics.dataCompleteness}`],
          0.45,
        ),
        metrics,
      );
    }

    return null;
  }

  const directionalOiDelta = getDirectionalOiDelta(metrics);
  const absOiSurge = getAbsOiSurge(metrics);
  const volumeHot = getVolumeHot(metrics, thresholds);

  if (volumeHot && absOiSurge <= thresholds.flatOiDeltaTolerance) {
    return withContractOnlyRisk(
      buildSignal(
        metrics,
        thresholds,
        "TURNOVER_ONLY",
        "INFO",
        "turnover increased, but open interest stayed essentially flat so no directional futures structure is confirmed",
        [`volumeRatio=${metrics.volumeRatio.toFixed(2)}`, `absOiSurge=${formatPercent(absOiSurge)}`],
        0.5,
      ),
      metrics,
    );
  }

  if (!volumeHot || absOiSurge < thresholds.oiDeltaThreshold) {
    if (metrics.contractOnlyRisk.level === "HIGH") {
      return withContractOnlyRisk(
        buildSignal(
          metrics,
          thresholds,
          "CONTRACT_ONLY_RISK",
          "WARNING",
          "contract-only futures activity is notable, but volume or open-interest expansion is below the directional threshold",
          [
            `contractOnlyReason=${metrics.contractOnlyRisk.reason}`,
            `volumeRatio=${metrics.volumeRatio.toFixed(2)}`,
            `absOiSurge=${formatPercent(absOiSurge)}`,
          ],
          0.42,
        ),
        metrics,
      );
    }

    return null;
  }

  const signalType = determineDirectionalSignalType(metrics);
  if (!signalType) {
    if (metrics.contractOnlyRisk.level === "HIGH") {
      return withContractOnlyRisk(
        buildSignal(
          metrics,
          thresholds,
          "CONTRACT_ONLY_RISK",
          "WARNING",
          "contract-only futures activity is elevated, but the price and open-interest structure is not directional enough yet",
          [
            `contractOnlyReason=${metrics.contractOnlyRisk.reason}`,
            `volumeRatio=${metrics.volumeRatio.toFixed(2)}`,
            `absOiSurge=${formatPercent(absOiSurge)}`,
          ],
          0.46,
        ),
        metrics,
      );
    }

    return null;
  }

  const takerSupport =
    signalType === "LONG_BUILDUP_CANDIDATE" || signalType === "SHORT_COVERING"
      ? metrics.takerImbalance >= thresholds.takerConfirmationThreshold
      : metrics.takerImbalance <= -thresholds.takerConfirmationThreshold;

  return withContractOnlyRisk(
    buildSignal(
      metrics,
      thresholds,
      signalType,
      "HIGH",
      buildDirectionalExplanation(signalType, metrics),
      buildDirectionalEvidence(metrics),
      0.58 +
        Math.min(0.18, Math.max(0, metrics.volumeRatio - thresholds.volumeRatioThreshold) * 0.1) +
        Math.min(0.14, Math.max(0, absOiSurge - thresholds.oiDeltaThreshold)) +
        (takerSupport ? 0.1 : 0),
    ),
    metrics,
  );
}

export function aggregateFuturesSignals(
  signals: readonly (FuturesSignal | null | undefined)[],
): FuturesSignal | null {
  const presentSignals = signals.filter((signal): signal is FuturesSignal => signal !== null && signal !== undefined);
  if (presentSignals.length === 0) {
    return null;
  }

  const biases = new Set<DirectionalBias>(presentSignals.map((signal) => getSignalBias(signal.signalType)));
  biases.delete(null);

  if (biases.size > 1) {
    const canonicalSignals = getCanonicalConflictSignals(presentSignals);
    const latestSignal = canonicalSignals.at(-1)!;

    return {
      signalType: "FUTURES_OI_CONFLICT",
      severity: "WARNING",
      confidence: 0.5,
      explanation: "5m and 15m directional futures structures conflict, so the move needs slower confirmation before escalation",
      evidence: canonicalSignals.map((signal) => `${signal.interval}:${signal.signalType}`),
      symbol: latestSignal.symbol,
      interval: latestSignal.interval,
      candleOpenTime: latestSignal.candleOpenTime,
      thresholdVersion: canonicalSignals.map((signal) => signal.thresholdVersion).join("|"),
    };
  }

  return presentSignals.at(-1)!;
}
