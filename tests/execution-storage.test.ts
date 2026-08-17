import { describe, expect, it } from "vitest";
import { MysqlExecutionAuditRepository, MysqlExecutionPositionStore } from "../src/storage/execution-repository";

describe("MySQL execution repositories", () => {
  it("uses durable execution tables and dedupe reservations", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const repository = new MysqlExecutionPositionStore({
      async query(text, values) {
        queries.push({ text, values });
        if (text.includes("RETURNING 1 AS created")) return { rows: [{ created: 1 }] as any };
        return { rows: [] as any };
      },
    });

    expect(await repository.reserveEntry("signal-key", "HEIUSDT")).toBe(true);
    await repository.markSignalProcessed("signal-key");
    await repository.releaseEntryReservation("signal-key", "HEIUSDT");

    expect(queries[0]?.text).toContain("execution_entry_reservations");
    expect(queries[0]?.text).toContain("ON CONFLICT (dedupe_key) DO NOTHING");
    expect(queries.some((query) => query.text.includes("execution_processed_signals"))).toBe(true);
  });

  it("writes audit events without exposing credentials", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const repository = new MysqlExecutionAuditRepository({
      async query(text, values) {
        queries.push({ text, values });
        return { rows: [] as any };
      },
    });

    await repository.record({ type: "ENTRY_REJECTED", symbol: "HEIUSDT", at: 123, reasonCode: "TEST" });

    expect(queries[0]?.text).toContain("execution_audit_events");
    expect(queries[0]?.values).toEqual(["ENTRY_REJECTED", "HEIUSDT", "TEST", 123, {}]);
  });
});
