# MySQL Retention and 5m Breakout Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Binance futures monitor responsive during long-running 24/7 operation and make the leaderboard favor genuine 5-minute upward breakouts.

**Architecture:** Add composite indexes through a forward-only MySQL migration, expose retention settings through configuration, and run a batched cleanup service on startup plus a recurring timer. Extend the existing 0–100 anomaly score with an explicit positive 5-minute price-expansion factor while keeping execution gates unchanged except that the shared score calculation sees the same factor.

**Tech Stack:** TypeScript, Fastify, Vitest, MySQL 8/InnoDB, existing `mysql2` adapter, Binance Futures 5m/15m candle and OI pipeline.

## Global Constraints

- Keep only Binance USDT perpetual contract-only symbols in the monitored universe.
- Keep automatic execution in simulation mode by default; this change must not enable production trading.
- Keep the public anomaly score in the range 0–100.
- Use batched deletes with a configurable batch size; do not run one unbounded delete during service startup.
- Preserve existing user changes in the dirty worktree and do not reset unrelated files.
- The default breakout threshold is a positive 5-minute return of 3%.
- The default hot-data retention is 30 days, signal retention is 180 days, and source-event retention is 14 days.

---

### Task 1: Lock configuration, retention, and breakout behavior with failing tests

**Files:**
- Modify: `tests/config.test.ts`
- Create: `tests/futures-retention.test.ts`
- Create: `tests/futures-oi-factors.test.ts`

**Interfaces:**
- Tests will require `loadConfig({})` to expose the retention and 5m breakout defaults.
- Tests will require `FuturesRetentionService` to perform one cleanup on start and to stop its timer.
- Tests will require `FuturesOiAnomalyFactorCode` to include `PRICE_5M_EXPANSION` and the score to increase only for a positive 5m return.

- [ ] **Step 1: Add failing configuration assertions**

  Assert the defaults are `30`, `180`, `14`, `21600000`, `5000`, and `0.03` for hot retention days, signal retention days, source-event retention days, cleanup interval, cleanup batch size, and 5m price threshold.

- [ ] **Step 2: Add failing retention service tests**

  Use a repository recorder and injected interval functions to assert `start()` calls cleanup once with cutoffs derived from the injected clock and `stop()` clears the scheduled timer.

- [ ] **Step 3: Add failing breakout-factor tests**

  Assert a 5m input with `priceReturn5m: 0.03` emits `PRICE_5M_EXPANSION` and scores higher than the same input with `priceReturn5m: 0`. Assert a negative 5m return does not emit the positive expansion factor.

- [ ] **Step 4: Run the focused tests and verify they fail for missing behavior**

  Run: `npm test -- --run tests/config.test.ts tests/futures-retention.test.ts tests/futures-oi-factors.test.ts`

  Expected: failure because the new configuration fields, retention service, and factor code do not exist yet.

---

### Task 2: Implement retention configuration, batched cleanup, and scheduler

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `src/storage/futures-repository.ts`
- Modify: `src/storage/mysql-queryable.ts`
- Create: `src/services/futures-retention-service.ts`
- Modify: `src/main.ts`

**Interfaces:**
- `AppConfig` produces `futuresHotRetentionDays`, `futuresSignalRetentionDays`, `futuresSourceEventRetentionDays`, `futuresCleanupIntervalMs`, `futuresCleanupBatchSize`, and `futuresPriceReturn5mThreshold`.
- `FuturesRepository` produces `cleanupHistoricalData(input): Promise<FuturesCleanupStats>`.
- `FuturesRetentionService` consumes the repository and retention config, exposes `start()`, `cleanupNow()`, and `stop()`.
- `Queryable.query()` may return optional `affectedRows` so the MySQL adapter can drive bounded delete loops without breaking existing row-only fakes.

- [ ] **Step 1: Implement the minimum configuration schema**

  Add positive config parsing with the defaults from the global constraints and map the fields into `AppConfig`. Document the same variables in `.env.example`.

- [ ] **Step 2: Implement MySQL affected-row propagation**

  Extend the query result shape with optional `affectedRows`; preserve existing `rows` behavior and return the MySQL driver’s affected row count for non-SELECT statements.

- [ ] **Step 3: Implement repository cleanup in bounded batches**

  Delete old rows from `futures_candles`, `futures_oi_snapshots`, `futures_flow_metrics`, `futures_reference_factors`, `futures_signals`, and `source_events` using `LIMIT $batchSize`, looping until fewer than a batch are removed. Use `received_timestamp`/`observed_at` for ingestion tables and candle time for signals. Return per-table deletion counts.

- [ ] **Step 4: Implement and wire `FuturesRetentionService`**

  Compute cutoffs from `Date.now()` (injectable in tests), run cleanup once on startup, schedule the configured interval, log failures without taking down the data stream, and clear the timer on stop. Stop this service before the repository pool is closed.

- [ ] **Step 5: Run the focused tests and verify they pass**

  Run: `npm test -- --run tests/config.test.ts tests/futures-retention.test.ts`

  Expected: all configuration and retention tests pass.

---

### Task 3: Add MySQL indexes and make cleanup schema-safe

**Files:**
- Create: `src/storage/migrations/005_indexes_and_retention.sql`
- Create: `tests/storage-migrations.test.ts`

**Interfaces:**
- Migration produces indexes for interval/time filtering and latest-row joins without changing primary-key semantics.

- [ ] **Step 1: Add a migration test that names the required indexes**

  Read the migration file and assert it contains indexes for `futures_candles(interval_name, symbol, open_time)`, `futures_flow_metrics(interval_name, symbol, candle_open_time)`, `futures_oi_snapshots(interval_name, timestamp)`, `futures_signals(candle_open_time, symbol, interval_name)`, `source_events(received_timestamp)`, and `futures_reference_factors(observed_at)`.

- [ ] **Step 2: Write the forward-only migration**

  Add the six indexes with stable names. The migration runner applies each file once through `schema_migrations`; do not modify existing primary keys.

- [ ] **Step 3: Run migration tests and apply the migration locally**

  Run: `npm test -- --run tests/storage-migrations.test.ts`

  Then run: `npm run db:migrate`

  Expected: migration `005_indexes_and_retention.sql` is applied once to the local MySQL database.

---

### Task 4: Add the positive 5-minute price-expansion factor

**Files:**
- Modify: `src/domain/futures.ts`
- Modify: `src/analysis/futures-oi-factors.ts`
- Modify: `src/storage/futures-repository.ts`
- Modify: `src/storage/in-memory-futures-repository.ts`
- Modify: `src/execution/futures-signal-adapter.ts`
- Modify: `src/main.ts`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- `FuturesOiLeaderboardRow` produces `priceReturn5m` and the `PRICE_5M_EXPANSION` factor.
- The score calculation uses weights: OI 50, volume 15, 5m positive price expansion 15, price-OI alignment 10, taker confirmation 10; the final value remains capped at 100.
- The 5m expansion threshold is configured at 3% by default and only applies to 5m rows; 15m rows report `priceReturn5m: 0` until a same-window 5m join is introduced.

- [ ] **Step 1: Extend the score input and factor union**

  Add `priceReturn5m` to the internal scoring input, add `PRICE_5M_EXPANSION` to the domain factor code union, and add `priceReturn5m` to leaderboard rows.

- [ ] **Step 2: Implement factor detection and score weighting**

  Emit a warning factor for a positive 5m return and a high-severity factor at or above the configured threshold. Give the continuous positive return up to 15 points; do not reward negative returns.

- [ ] **Step 3: Pass the factor through all score consumers**

  Pass the 5m return for 5m leaderboard rows, in-memory rows, and execution signal adaptation. Keep 15m rows at zero and preserve the existing 80-point execution gate.

- [ ] **Step 4: Expose the value in the API and show the factor in Chinese UI**

  Serialize `priceReturn5m` and map `PRICE_5M_EXPANSION` to `5分钟上涨` / `5分钟爆发` labels. Keep the existing price-change column and add no new external trading behavior.

- [ ] **Step 5: Run score and API tests**

  Run: `npm test -- --run tests/futures-oi-factors.test.ts tests/futures-repository.test.ts tests/futures-routes.test.ts tests/execution-engine.test.ts tests/execution-risk.test.ts`

  Expected: all focused score, ranking, API, and execution tests pass.

---

### Task 5: Full verification and runtime check

**Files:**
- Modify: `README.md`
- Modify: `frontend/src/App.tsx` (only if build exposes a type mismatch)

- [ ] **Step 1: Document retention and breakout settings**

  Add the default retention periods, cleanup interval, batch size, and 5m price threshold to the local run instructions.

- [ ] **Step 2: Run the complete test suite and builds**

  Run: `npm test -- --run`

  Run: `npm run build`

  Run: `npm run frontend:build`

- [ ] **Step 3: Verify the local database and API**

  Run: `npm run db:migrate`; query `information_schema.statistics` for the six index names; call `/health` and `/api/futures/oi-leaderboard?interval=5m&limit=10`.

- [ ] **Step 4: Report evidence and remaining limitations**

  Report exact test/build results, applied migration, cleanup defaults, and that only 5m rows receive the new explicit price-expansion score until a same-window 5m join is added for 15m rows.
