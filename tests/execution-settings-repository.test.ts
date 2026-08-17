import { describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_SETTINGS } from "../src/domain/execution-settings";
import {
  EXECUTION_SETTINGS_KEY,
  InMemoryExecutionSettingsRepository,
  MysqlExecutionSettingsRepository,
} from "../src/storage/execution-settings-repository";

describe("MysqlExecutionSettingsRepository", () => {
  it("无配置行时返回默认设置", async () => {
    const repository = new MysqlExecutionSettingsRepository({
      async query() {
        return { rows: [] as never[] };
      },
    });

    const settings = await repository.get();
    expect(settings).toMatchObject(DEFAULT_EXECUTION_SETTINGS);
  });

  it("读取已保存的配置并合并默认值", async () => {
    const repository = new MysqlExecutionSettingsRepository({
      async query(text) {
        if (text.includes("SELECT")) {
          return {
            rows: [
              {
                setting_value: { leverage: 10, minOiBurstDelta: 0.1 },
                updated_at: 123456,
              },
            ],
          } as never;
        }
        return { rows: [] as never[] };
      },
    });

    const settings = await repository.get();
    expect(settings.leverage).toBe(10);
    expect(settings.minOiBurstDelta).toBe(0.1);
    expect(settings.notionalUsdt).toBe(500);
    expect(settings.updatedAt).toBe(123456);
  });

  it("put 写入单行 upsert 且不覆盖 updatedAt 输入值", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const repository = new MysqlExecutionSettingsRepository({
      async query(text, values) {
        queries.push({ text, values });
        return { rows: [] as never[] };
      },
    });

    await repository.put({ ...DEFAULT_EXECUTION_SETTINGS, updatedAt: 1 });

    expect(queries[0]?.text).toContain("execution_settings");
    expect(queries[0]?.text).toContain("ON CONFLICT (setting_key)");
    expect(queries[0]?.values?.[0]).toBe(EXECUTION_SETTINGS_KEY);
    const stored = queries[0]?.values?.[1] as Record<string, unknown>;
    expect(stored.updatedAt).toBeUndefined();
    expect(stored.leverage).toBe(5);
  });

  it("处理 JSON 字符串形式的存量值", async () => {
    const repository = new MysqlExecutionSettingsRepository({
      async query() {
        return { rows: [{ setting_value: JSON.stringify({ stopLossPercent: 12 }), updated_at: 9 }] } as never;
      },
    });

    const settings = await repository.get();
    expect(settings.stopLossPercent).toBe(12);
    expect(settings.updatedAt).toBe(9);
  });
});

describe("InMemoryExecutionSettingsRepository", () => {
  it("读写往返保持设置", async () => {
    const repository = new InMemoryExecutionSettingsRepository();
    await repository.put({ ...DEFAULT_EXECUTION_SETTINGS, leverage: 20, notionalUsdt: 2000 });

    const settings = await repository.get();
    expect(settings.leverage).toBe(20);
    expect(settings.notionalUsdt).toBe(2000);
  });

  it("未写入时返回默认值", async () => {
    const repository = new InMemoryExecutionSettingsRepository();
    expect(await repository.get()).toMatchObject(DEFAULT_EXECUTION_SETTINGS);
  });
});
