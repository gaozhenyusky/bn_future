import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("storage indexes migration", () => {
  it("defines the time-oriented indexes used by retention and leaderboard queries", async () => {
    const sql = await readFile(new URL("../src/storage/migrations/005_indexes_and_retention.sql", import.meta.url), "utf8");

    expect(sql).toContain("ADD INDEX idx_futures_candles_interval_symbol_open_time (interval_name, symbol, open_time)");
    expect(sql).toContain("ADD INDEX idx_futures_flow_metrics_interval_symbol_candle (interval_name, symbol, candle_open_time)");
    expect(sql).toContain("ADD INDEX idx_futures_oi_snapshots_interval_timestamp (interval_name, timestamp)");
    expect(sql).toContain("ADD INDEX idx_futures_signals_candle_symbol_interval (candle_open_time, symbol, interval_name)");
    expect(sql).toContain("ADD INDEX idx_source_events_received_timestamp (received_timestamp)");
    expect(sql).toContain("ADD INDEX idx_futures_reference_factors_observed_at (observed_at)");
  });
});
