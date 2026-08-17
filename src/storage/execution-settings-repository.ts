import { DEFAULT_EXECUTION_SETTINGS, EXECUTION_SETTINGS_KEYS, type ExecutionSettings } from "../domain/execution-settings";
import type { Queryable } from "./futures-repository";

export const EXECUTION_SETTINGS_KEY = "execution";

export interface ExecutionSettingsRepository {
  get(): Promise<ExecutionSettings>;
  put(settings: ExecutionSettings): Promise<void>;
}

function parseSettingsValue(value: unknown): Partial<ExecutionSettings> {
  if (typeof value !== "string") return value as Partial<ExecutionSettings>;
  try {
    return JSON.parse(value) as Partial<ExecutionSettings>;
  } catch {
    return {};
  }
}

export class MysqlExecutionSettingsRepository implements ExecutionSettingsRepository {
  constructor(private readonly db: Queryable) {}

  async get(): Promise<ExecutionSettings> {
    const result = await this.db.query<{ setting_value: unknown; updated_at: number }>(
      "SELECT setting_value, updated_at FROM execution_settings WHERE setting_key = $1",
      [EXECUTION_SETTINGS_KEY],
    );
    const row = result.rows[0];
    if (!row) return { ...DEFAULT_EXECUTION_SETTINGS };
    const stored = parseSettingsValue(row.setting_value);
    // 白名单过滤：丢弃旧版本遗留的未知键（如 minEntryScore），避免校验拒绝。
    const filtered = Object.fromEntries(
      EXECUTION_SETTINGS_KEYS.filter((key) => key in stored).map((key) => [key, stored[key]]),
    );
    return {
      ...DEFAULT_EXECUTION_SETTINGS,
      ...filtered,
      updatedAt: row.updated_at,
    };
  }

  async put(settings: ExecutionSettings): Promise<void> {
    const { updatedAt: _updatedAt, ...value } = settings;
    await this.db.query(
      "INSERT INTO execution_settings (setting_key, setting_value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = EXCLUDED.updated_at",
      [EXECUTION_SETTINGS_KEY, value, Date.now()],
    );
  }
}

export class InMemoryExecutionSettingsRepository implements ExecutionSettingsRepository {
  private settings: ExecutionSettings = { ...DEFAULT_EXECUTION_SETTINGS };

  async get(): Promise<ExecutionSettings> {
    return { ...this.settings };
  }

  async put(settings: ExecutionSettings): Promise<void> {
    this.settings = { ...settings };
  }
}
