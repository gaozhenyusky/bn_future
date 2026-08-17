import { describe, expect, it, vi } from "vitest";
import type { FuturesSignal } from "../src/domain/futures";
import { TelegramNotifier, TelegramNotifierError } from "../src/alerts/telegram";

function createSignal(overrides?: Partial<FuturesSignal>): FuturesSignal {
  return {
    symbol: "HEIUSDT",
    interval: "5m",
    signalType: "LONG_BUILDUP_CANDIDATE",
    severity: "HIGH",
    confidence: 0.81,
    explanation: "price rose while open interest expanded on elevated volume",
    evidence: [
      "priceReturn=8.00%",
      "volumeRatio=2.40",
      "oiValueDelta=11.00%",
      "takerImbalance=18.00%",
      "dataCompleteness=COMPLETE",
      "contractOnlyReason=NO_ACTIVE_SPOT_BASE_ASSET",
    ],
    thresholdVersion: "task-7-thresholds",
    candleOpenTime: 1_720_000_000_000,
    contractOnlyRisk: {
      level: "HIGH",
      reason: "NO_ACTIVE_SPOT_BASE_ASSET",
    },
    ...overrides,
  };
}

describe("TelegramNotifier", () => {
  it("skips when Telegram settings are absent", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const notifier = new TelegramNotifier({
      fetchImpl,
    });

    const result = await notifier.send(createSignal());

    expect(result).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends JSON with a timeout when configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );
    const setTimeoutFn = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutFn = vi.fn();
    const notifier = new TelegramNotifier({
      botToken: "telegram-secret-token",
      chatId: "123456",
      timeoutMs: 4_321,
      fetchImpl,
      setTimeoutFn,
      clearTimeoutFn,
    });

    const result = await notifier.send(createSignal());

    expect(result).toBe("sent");
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 4_321);
    expect(clearTimeoutFn).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("/sendMessage");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual(
      expect.objectContaining({
        chat_id: "123456",
        text: expect.stringContaining("Read-only observation"),
      }),
    );
  });

  it("converts non-2xx responses into a typed error without exposing the token", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: false }), {
        status: 502,
        headers: {
          "content-type": "application/json",
        },
      }),
    );
    const notifier = new TelegramNotifier({
      botToken: "telegram-secret-token",
      chatId: "123456",
      fetchImpl,
    });

    await expect(() => notifier.send(createSignal())).rejects.toMatchObject({
      name: "TelegramNotifierError",
      status: 502,
      code: "HTTP_ERROR",
    });

    await expect(() => notifier.send(createSignal())).rejects.not.toThrow("telegram-secret-token");
  });

  it("labels absOiSurge fallback distinctly when oiValueDelta evidence is absent", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );
    const notifier = new TelegramNotifier({
      botToken: "telegram-secret-token",
      chatId: "123456",
      fetchImpl,
    });

    await notifier.send(
      createSignal({
        evidence: [
          "priceReturn=8.00%",
          "volumeRatio=2.40",
          "absOiSurge=9.00%",
          "takerImbalance=18.00%",
          "dataCompleteness=COMPLETE",
          "contractOnlyReason=NO_ACTIVE_SPOT_BASE_ASSET",
        ],
      }),
    );

    const [, init] = fetchImpl.mock.calls[0]!;
    const payload = JSON.parse(String(init?.body));

    expect(payload.text).toContain("Absolute OI surge: 9.00%");
    expect(payload.text).not.toContain("OI value delta: 9.00%");
  });
});
