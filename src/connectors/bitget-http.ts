import { ProxyAgent, type Dispatcher } from "undici";

type FetchInit = RequestInit & { dispatcher?: Dispatcher };
type FetchLike = (input: RequestInfo | URL, init?: FetchInit) => Promise<Response>;
type TimeoutHandle = ReturnType<typeof setTimeout>;
type SetTimeoutLike = (callback: () => void, delayMs: number) => TimeoutHandle;
type ClearTimeoutLike = (timeoutId: TimeoutHandle) => void;

interface BitgetEnvelope<T> {
  code?: unknown;
  msg?: unknown;
  data?: T;
}

export class BitgetHttpError extends Error {
  readonly status?: number;
  readonly path: string;
  readonly retryAfterMs?: number;
  readonly code?: string;
  readonly cause?: unknown;

  constructor(options: {
    message: string;
    path: string;
    status?: number;
    retryAfterMs?: number;
    code?: string;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = "BitgetHttpError";
    this.status = options.status;
    this.path = options.path;
    this.retryAfterMs = options.retryAfterMs;
    this.code = options.code;
    this.cause = options.cause;
  }
}

export interface BitgetHttpClientOptions {
  baseUrl?: string;
  proxyUrl?: string;
  fetchImpl?: FetchLike;
  createProxyAgent?: (proxyUrl: string) => Dispatcher;
  timeoutMs?: number;
  retry?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  sleep?: (delayMs: number) => Promise<void>;
  setTimeoutFn?: SetTimeoutLike;
  clearTimeoutFn?: ClearTimeoutLike;
}

const DEFAULT_BASE_URL = "https://api.bitget.com";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return undefined;
  }

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const dateMs = Date.parse(headerValue);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }

  return Math.max(dateMs - Date.now(), 0);
}

function createBackoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
}

function asEnvelope<T>(value: unknown): BitgetEnvelope<T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Bitget envelope must be an object");
  }

  return value as BitgetEnvelope<T>;
}

export class BitgetHttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly setTimeoutFn: SetTimeoutLike;
  private readonly clearTimeoutFn: ClearTimeoutLike;

  constructor(options: BitgetHttpClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const baseFetch = options.fetchImpl ?? fetch;
    const proxyUrl = options.proxyUrl?.trim();
    if (proxyUrl) {
      const createProxyAgent = options.createProxyAgent ?? ((value: string) => new ProxyAgent(value));
      const dispatcher = createProxyAgent(proxyUrl);
      this.fetchImpl = (input, init = {}) =>
        baseFetch(input, {
          ...init,
          dispatcher,
        });
    } else {
      this.fetchImpl = baseFetch;
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  async getJson<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = this.setTimeoutFn(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          signal: controller.signal,
        });

        this.clearTimeoutFn(timeoutId);

        if (!response.ok) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          const error = new BitgetHttpError({
            message: `Bitget request failed with status ${response.status} for ${path}`,
            path,
            status: response.status,
            retryAfterMs,
          });

          if (attempt < this.maxRetries && shouldRetryStatus(response.status)) {
            await this.sleep(retryAfterMs ?? createBackoffDelay(attempt, this.baseDelayMs, this.maxDelayMs));
            continue;
          }

          throw error;
        }

        let parsedBody: unknown;
        try {
          parsedBody = await response.json();
        } catch (error) {
          throw new BitgetHttpError({
            message: `Bitget returned invalid JSON for ${path}`,
            path,
            status: response.status,
            code: "INVALID_JSON",
            cause: error,
          });
        }

        const envelope = asEnvelope<T>(parsedBody);
        if (envelope.code !== "00000") {
          throw new BitgetHttpError({
            message: `Bitget request failed with code ${typeof envelope.code === "string" ? envelope.code : "UNKNOWN"} for ${path}`,
            path,
            status: response.status,
            code: typeof envelope.code === "string" ? envelope.code : "UNKNOWN",
          });
        }

        return envelope.data as T;
      } catch (error) {
        if (error instanceof BitgetHttpError) {
          throw error;
        }

        this.clearTimeoutFn(timeoutId);

        const isAbortError =
          error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
        const networkError = new BitgetHttpError({
          message: isAbortError ? `Bitget request timed out for ${path}` : `Bitget network failure for ${path}`,
          path,
          code: isAbortError ? "TIMEOUT" : "NETWORK_ERROR",
          cause: error,
        });

        if (attempt < this.maxRetries) {
          await this.sleep(createBackoffDelay(attempt, this.baseDelayMs, this.maxDelayMs));
          continue;
        }

        throw networkError;
      }
    }
  }
}
