import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { OnchainChainId, OnchainSnapshot } from "../domain/onchain";
import { ONCHAIN_CHAINS } from "../domain/onchain";
import type { OnchainGemService } from "../services/onchain-gem-service";

const chainSchema = z.enum(["all", ...ONCHAIN_CHAINS] as ["all", ...OnchainChainId[]]);
const limitSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return 50;
  return Number(value);
}, z.number().int().positive().max(100));

const querySchema = z.object({
  chain: chainSchema.optional(),
  limit: limitSchema,
});

type OnchainRouteService = Pick<OnchainGemService, "scan" | "getSnapshot">;

function sendValidationError(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: "INVALID_QUERY",
    message: error.issues[0]?.message ?? "Invalid query",
  });
}

function unavailableSnapshot(): OnchainSnapshot {
  return {
    candidates: [],
    statuses: [],
    scannedAt: 0,
  };
}

export function registerOnchainRoutes(
  app: FastifyInstance,
  deps: { onchainService?: OnchainRouteService },
) {
  app.get("/api/onchain/gems", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return sendValidationError(reply, parsed.error);

    if (!deps.onchainService) {
      return reply.code(503).send({
        error: "ONCHAIN_UNAVAILABLE",
        message: "链上发现服务尚未配置",
        items: [],
      });
    }

    const snapshot = await deps.onchainService.scan();
    const items = snapshot.candidates
      .filter((candidate) => parsed.data.chain === undefined || parsed.data.chain === "all" || candidate.chainId === parsed.data.chain)
      .slice(0, parsed.data.limit);
    return {
      items,
      scannedAt: snapshot.scannedAt,
    };
  });

  app.get("/api/onchain/status", async (_request, reply) => {
    if (!deps.onchainService) {
      return reply.code(503).send({
        status: "unavailable",
        message: "链上发现服务尚未配置",
        sources: [],
      });
    }

    const snapshot = deps.onchainService.getSnapshot();
    const connected = snapshot.statuses.filter((item) => item.status === "connected").length;
    const unavailable = snapshot.statuses.filter((item) => item.status === "unavailable").length;
    return {
      status: snapshot.statuses.length === 0 || unavailable === snapshot.statuses.length
        ? "unavailable"
        : unavailable > 0
          ? "degraded"
          : "connected",
      connected,
      unavailable,
      scannedAt: snapshot.scannedAt,
      sources: snapshot.statuses,
    };
  });
}
