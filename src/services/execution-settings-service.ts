import type { ExecutionSettings } from "../domain/execution-settings";
import { DEFAULT_EXECUTION_SETTINGS, parseExecutionSettings } from "../domain/execution-settings";
import type { ExecutionSettingsRepository } from "../storage/execution-settings-repository";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class ExecutionSettingsService {
  constructor(private readonly repository: ExecutionSettingsRepository) {}

  /** 读取当前生效设置；存储不可用时 fail-safe 返回默认值，不阻断监控 */
  async get(): Promise<ExecutionSettings> {
    try {
      return await this.repository.get();
    } catch {
      return { ...DEFAULT_EXECUTION_SETTINGS };
    }
  }

  /** 合并部分更新并校验；校验失败时抛出带中文消息的 Error */
  async update(partial: unknown): Promise<ExecutionSettings> {
    const current = await this.get();
    const merged = isRecord(partial) ? { ...current, ...partial } : { ...current };
    delete (merged as Partial<ExecutionSettings>).updatedAt;
    const settings = parseExecutionSettings(merged);
    await this.repository.put(settings);
    return { ...settings, updatedAt: Date.now() };
  }
}
