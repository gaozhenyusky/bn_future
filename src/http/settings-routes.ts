import type { FastifyInstance } from "fastify";
import type { ExecutionSettingsService } from "../services/execution-settings-service";

export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: { settingsService?: ExecutionSettingsService },
) {
  app.get("/api/settings", async (_request, reply) => {
    if (!deps.settingsService) {
      return reply.code(503).send({
        error: "SETTINGS_UNAVAILABLE",
        message: "执行设置服务尚未配置",
      });
    }

    try {
      const settings = await deps.settingsService.get();
      return {
        settings,
        updatedAt: settings.updatedAt,
      };
    } catch {
      return reply.code(503).send({
        error: "SETTINGS_UNAVAILABLE",
        message: "执行设置读取失败",
      });
    }
  });

  app.put("/api/settings", async (request, reply) => {
    if (!deps.settingsService) {
      return reply.code(503).send({
        error: "SETTINGS_UNAVAILABLE",
        message: "执行设置服务尚未配置",
      });
    }

    try {
      const settings = await deps.settingsService.update(request.body ?? {});
      return {
        settings,
        updatedAt: settings.updatedAt,
      };
    } catch (error) {
      return reply.code(400).send({
        error: "INVALID_SETTINGS",
        message: error instanceof Error ? error.message : "执行设置校验失败",
      });
    }
  });
}
