import type { FuturesSignal } from "../domain/futures";

type FetchLike = typeof fetch;
type TimeoutHandle = ReturnType<typeof setTimeout>;
type SetTimeoutLike = (callback: () => void, delayMs: number) => TimeoutHandle;
type ClearTimeoutLike = (timeoutId: TimeoutHandle) => void;

export class TelegramNotifierError extends Error {
  readonly status?: number;
  readonly code: "HTTP_ERROR" | "NETWORK_ERROR" | "TIMEOUT";
  readonly cause?: unknown;

  constructor(options: {
    message: string;
    code: "HTTP_ERROR" | "NETWORK_ERROR" | "TIMEOUT";
    status?: number;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = "TelegramNotifierError";
    this.status = options.status;
    this.code = options.code;
    this.cause = options.cause;
  }
}

export interface TelegramNotifierOptions {
  botToken?: string;
  chatId?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  setTimeoutFn?: SetTimeoutLike;
  clearTimeoutFn?: ClearTimeoutLike;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function getSignalDirection(signal: FuturesSignal): string {
  switch (signal.signalType) {
    case "LONG_BUILDUP_CANDIDATE":
    case "SHORT_COVERING":
      return "LONG";
    case "SHORT_BUILDUP_CANDIDATE":
    case "LONG_LIQUIDATION":
      return "SHORT";
    case "FUTURES_OI_CONFLICT":
      return "CONFLICT";
    case "TURNOVER_ONLY":
      return "NEUTRAL";
    case "CONTRACT_ONLY_RISK":
    default:
      return "OBSERVE";
  }
}

function getEvidenceValue(signal: FuturesSignal, key: string): string | undefined {
  const prefix = `${key}=`;
  const match = signal.evidence.find((item) => item.startsWith(prefix));
  return match?.slice(prefix.length);
}

function buildMessage(signal: FuturesSignal): string {
  const dataCompleteness = getEvidenceValue(signal, "dataCompleteness") ?? "COMPLETE";
  const contractOnlyRisk = signal.contractOnlyRisk
    ? `${signal.contractOnlyRisk.level} (${signal.contractOnlyRisk.reason})`
    : `LOW (${getEvidenceValue(signal, "contractOnlyReason") ?? "SPOT_BASE_ASSET_PRESENT"})`;
  const oiValueDelta = getEvidenceValue(signal, "oiValueDelta");
  const absOiSurge = getEvidenceValue(signal, "absOiSurge");

  const oiLine =
    oiValueDelta !== undefined
      ? `OI value delta: ${oiValueDelta}`
      : `Absolute OI surge: ${absOiSurge ?? "n/a"}`;

  return [
    "Read-only observation",
    `Symbol: ${signal.symbol}`,
    `Interval: ${signal.interval}`,
    `Price direction: ${getSignalDirection(signal)}`,
    `Volume ratio: ${getEvidenceValue(signal, "volumeRatio") ?? "n/a"}`,
    oiLine,
    `Taker imbalance: ${getEvidenceValue(signal, "takerImbalance") ?? "n/a"}`,
    `Contract-only risk: ${contractOnlyRisk}`,
    `Explanation: ${signal.explanation}`,
    `Data completeness: ${dataCompleteness}`,
    `Threshold version: ${signal.thresholdVersion}`,
  ].join("\n");
}

export class TelegramNotifier {
  private readonly botToken?: string;
  private readonly chatId?: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly setTimeoutFn: SetTimeoutLike;
  private readonly clearTimeoutFn: ClearTimeoutLike;

  constructor(options: TelegramNotifierOptions) {
    this.botToken = options.botToken;
    this.chatId = options.chatId;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  async send(signal: FuturesSignal): Promise<"sent" | "skipped"> {
    if (!this.botToken || !this.chatId) {
      return "skipped";
    }

    const controller = new AbortController();
    const timeoutId = this.setTimeoutFn(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: buildMessage(signal),
        }),
        signal: controller.signal,
      });

      this.clearTimeoutFn(timeoutId);

      if (!response.ok) {
        throw new TelegramNotifierError({
          message: `Telegram request failed with status ${response.status}`,
          code: "HTTP_ERROR",
          status: response.status,
        });
      }

      return "sent";
    } catch (error) {
      if (error instanceof TelegramNotifierError) {
        throw error;
      }

      this.clearTimeoutFn(timeoutId);

      const isAbortError = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

      throw new TelegramNotifierError({
        message: isAbortError ? "Telegram request timed out" : "Telegram request failed",
        code: isAbortError ? "TIMEOUT" : "NETWORK_ERROR",
        cause: error,
      });
    }
  }
}
