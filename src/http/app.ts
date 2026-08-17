import Fastify, { type FastifyInstance } from "fastify";
import type { FuturesRepository } from "../storage/futures-repository";
import { registerFuturesRoutes } from "./futures-routes";
import { registerOnchainRoutes } from "./onchain-routes";
import { registerSettingsRoutes } from "./settings-routes";
import { registerExecutionRoutes, type ExecutionPnlDeps } from "./execution-routes";
import type { OnchainGemService } from "../services/onchain-gem-service";
import type { ExecutionSettingsService } from "../services/execution-settings-service";

export interface ConnectorHealthState {
  status: "connected" | "degraded" | "disconnected";
  message?: string;
  updatedAt?: number;
}

export interface HealthState {
  connectors: Record<string, ConnectorHealthState>;
}

function serializeHealthState(health: HealthState) {
  const connectors = Object.fromEntries(
    Object.entries(health.connectors).map(([name, connector]) => [
      name,
      {
        status: connector.status,
        message: connector.message,
        updatedAt: connector.updatedAt,
      },
    ]),
  );

  return {
    status: deriveStatus(health),
    connectors,
  };
}

function deriveStatus(health: HealthState): "ok" | "degraded" {
  const connectors = Object.values(health.connectors);
  if (connectors.length === 0) {
    return "ok";
  }

  return connectors.every((connector) => connector.status === "connected") ? "ok" : "degraded";
}

export function buildApp(deps: {
  repository: FuturesRepository;
  health: HealthState;
  onchainService?: Pick<OnchainGemService, "scan" | "getSnapshot">;
  settingsService?: ExecutionSettingsService;
  refreshHandlers?: {
    refreshUniverse: () => Promise<void>;
    refreshAlpha?: () => Promise<void>;
  };
} & ExecutionPnlDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
  });

  app.get("/health", async () => serializeHealthState(deps.health));

  registerFuturesRoutes(app, deps);
  registerOnchainRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerExecutionRoutes(app, deps);

  return app;
}
