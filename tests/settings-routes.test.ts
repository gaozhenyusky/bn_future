import { describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app";
import { DEFAULT_EXECUTION_SETTINGS } from "../src/domain/execution-settings";
import { InMemoryExecutionSettingsRepository } from "../src/storage/execution-settings-repository";
import { ExecutionSettingsService } from "../src/services/execution-settings-service";

const repository = {
  upsertContracts: async () => undefined,
  getClosedCandleBaseline: async () => [],
  saveCandle: async () => undefined,
  saveMarketContext: async () => undefined,
  saveMetrics: async () => undefined,
  saveSignal: async () => undefined,
  saveSignalIfNew: async () => true,
  saveSourceEvent: async () => undefined,
  getCheckpoint: async () => null,
  setCheckpoint: async () => undefined,
  listRadar: async () => [],
  listSignals: async () => [],
} as never;

function createApp() {
  return buildApp({
    repository,
    health: { connectors: {} },
    settingsService: new ExecutionSettingsService(new InMemoryExecutionSettingsRepository()),
  });
}

describe("settings routes", () => {
  it("GET /api/settings 返回默认设置", async () => {
    const app = createApp();
    const response = await app.inject({ method: "GET", url: "/api/settings" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.settings.leverage).toBe(5);
    expect(body.settings.minOiBurstDelta).toBe(0.05);
    expect(body.settings.takeProfitLevels).toHaveLength(3);
  });

  it("PUT /api/settings 保存部分更新并立即返回新值", async () => {
    const app = createApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { leverage: 10, notionalUsdt: 2000 },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.settings.leverage).toBe(10);
    expect(body.settings.notionalUsdt).toBe(2000);
    expect(body.settings.minOiBurstDelta).toBe(0.05);
    expect(body.updatedAt).toBeGreaterThan(0);
  });

  it("PUT 保存后 GET 返回持久化值", async () => {
    const app = createApp();
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { stopLossPercent: 12, maxHoldMinutes: 60 },
    });
    const response = await app.inject({ method: "GET", url: "/api/settings" });

    const body = response.json();
    expect(body.settings.stopLossPercent).toBe(12);
    expect(body.settings.maxHoldMinutes).toBe(60);
  });

  it("PUT 非法配置返回 400 与中文错误", async () => {
    const app = createApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { leverage: 999 },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe("INVALID_SETTINGS");
    expect(body.message).toMatch(/杠杆/);
  });

  it("settings 服务缺失时返回 503", async () => {
    const app = buildApp({ repository, health: { connectors: {} } });
    const response = await app.inject({ method: "GET", url: "/api/settings" });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("SETTINGS_UNAVAILABLE");
  });
});
