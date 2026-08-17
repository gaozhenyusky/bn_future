# Bitget Reference Factor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add public Bitget Spot and USDT-M Futures market data as a bounded reference factor for Binance-generated 5m/15m Futures signals without expanding the Binance universe or enabling trading.

**Architecture:** Keep Binance as the primary universe, candle stream, OI analysis, and signal source. Add an isolated Bitget public REST adapter and a pure factor calculator; invoke them only after a Binance candidate signal exists, persist the result beside the existing signal data, and expose it as optional `bitgetReference` data. Bitget failures remain visible through health and evidence but never remove or fabricate Binance data.

**Tech Stack:** Node.js 22+, TypeScript, Fastify, `undici`, MySQL via `mysql2/promise`, Vitest, React, Vite, CSS, Bitget v2 public REST APIs.

## Global Constraints

- Read-only public market data only; no Bitget API keys, account calls, order calls, signing, LP mutation, or trading automation.
- Binance remains the only source of the main monitored universe; Bitget never adds Bitget-only symbols.
- Reference queries run only for Binance candidate signals and only for `5m` and `15m` intervals.
- Bitget missing, malformed, timed-out, 429, or 418 data is represented as missing/unavailable and is never converted to zero.
- Bitget confidence adjustment is capped at `±0.10`, cannot promote `INFO` to `HIGH`, and is not applied for `BITGET_UNAVAILABLE`.
- MySQL defaults remain `127.0.0.1:3306`, user `root`, password `gao`, database `crypto_monitor`.
- All visible UI copy remains Chinese and must not contain buy, sell, order, copy-trade, or profit promises.
- Preserve existing Binance metrics, signal types, repository compatibility, read-only startup degradation, and current frontend routes.

## File map

Create:

- `src/domain/bitget-reference.ts` — normalized Bitget snapshots, status, and factor types.
- `src/connectors/bitget-http.ts` — public Bitget HTTP transport, timeout, retry, envelope validation, and sanitized errors.
- `src/connectors/bitget-market-rest.ts` — Bitget Spot/Futures endpoint requests and response parsing.
- `src/analysis/bitget-reference-factor.ts` — pure timestamp alignment, ratios, status, score, and bounded signal adjustment.
- `src/services/bitget-reference-service.ts` — candidate-only orchestration, cache, deduplication, and health callbacks.
- `src/storage/migrations/003_bitget_reference_factors.sql` — MySQL persistence for reference snapshots.
- `tests/bitget-http.test.ts` — transport behavior and public envelope errors.
- `tests/bitget-market-rest.test.ts` — Bitget response parsing and endpoint mapping.
- `tests/bitget-reference-factor.test.ts` — deterministic factor and confidence rules.
- `tests/bitget-reference-service.test.ts` — candidate filtering, deduplication, partial data, and failure behavior.
- `tests/bitget-reference-repository.test.ts` — MySQL query and in-memory persistence behavior.

Modify:

- `src/config.ts`, `.env.example`, `README.md` — Bitget base URL, timeout, cache, concurrency, and factor thresholds.
- `src/domain/futures.ts` — optional reference factor on radar rows/signals where required by the API contract.
- `src/analysis/futures-classifier.ts` — apply only the bounded confidence/evidence adjustment after the primary signal exists.
- `src/services/futures-radar-service.ts` — inject an optional reference service after candidate classification and before publication persistence.
- `src/storage/futures-repository.ts` — save/load Bitget factors and left-join them into radar rows.
- `src/storage/in-memory-futures-repository.ts` — mirror the factor store for existing service tests.
- `src/storage/db.ts` — apply migration 003 through the existing migration runner without special casing.
- `src/http/app.ts`, `src/http/futures-routes.ts` — expose Bitget health and optional `bitgetReference` fields.
- `src/main.ts` — wire Bitget service and health controller while keeping startup non-blocking.
- `tests/config.test.ts`, `tests/futures-radar-service.test.ts`, `tests/futures-routes.test.ts`, `tests/main.test.ts` — preserve old behavior and cover the new optional dependency.
- `frontend/src/App.tsx`, `frontend/src/styles.css` — Chinese Bitget reference badge, detail values, and unavailable states.

---

### Task 1: Add the Bitget public transport and normalized market adapter

**Files:**

- Create: `src/domain/bitget-reference.ts`
- Create: `src/connectors/bitget-http.ts`
- Create: `src/connectors/bitget-market-rest.ts`
- Test: `tests/bitget-http.test.ts`
- Test: `tests/bitget-market-rest.test.ts`

**Interfaces:**

- `BitgetHttpClient.getJson<T>(path: string, query: Record<string, string | number | undefined>): Promise<T>`
- `BitgetMarketRestClient.getSpotSymbols(): Promise<BitgetSpotSymbol[]>`
- `BitgetMarketRestClient.getFuturesContracts(): Promise<BitgetFuturesContract[]>`
- `BitgetMarketRestClient.getSpotCandles(symbol, interval, limit): Promise<BitgetMarketCandle[]>`
- `BitgetMarketRestClient.getFuturesCandles(symbol, interval, limit): Promise<BitgetMarketCandle[]>`
- `BitgetMarketRestClient.getSpotTicker(symbol): Promise<BitgetTicker | undefined>`
- `BitgetMarketRestClient.getFuturesTicker(symbol): Promise<BitgetFuturesTicker | undefined>`
- `BitgetMarketRestClient.getOpenInterest(symbol): Promise<BitgetOpenInterest | undefined>`
- `BitgetMarketRestClient.getFundingRate(symbol): Promise<BitgetFundingRate | undefined>`

- [ ] **Step 1: Write the failing transport tests.**

  Add a fetch stub that returns a Bitget success envelope `{ code: "00000", msg: "success", data: ... }`, a 429 response with `Retry-After`, a 500 response, and a malformed JSON response. Assert that the client returns parsed JSON for success, does not retry 429/418 aggressively, retries bounded transient 5xx/network failures, and sanitizes the public error message without returning request headers or proxy credentials.

- [ ] **Step 2: Run the transport tests and verify the expected failure.**

  Run:

  ```bash
  npm test -- --run tests/bitget-http.test.ts
  ```

  Expected: FAIL because `BitgetHttpClient` and its error type do not exist.

- [ ] **Step 3: Write the failing response-parser tests.**

  Fixture the official response shapes for:

  ```text
  /api/v2/spot/public/symbols
  /api/v2/mix/market/contracts?productType=usdt-futures
  /api/v2/spot/market/candles?granularity=5min|15min
  /api/v2/mix/market/candles?productType=usdt-futures&granularity=5m|15m
  /api/v2/spot/market/tickers
  /api/v2/mix/market/ticker?productType=usdt-futures
  /api/v2/mix/market/open-interest?productType=usdt-futures
  /api/v2/mix/market/current-fund-rate?productType=usdt-futures
  ```

  Assert string numerics become finite numbers, timestamps become numbers, Bitget `USDT-FUTURES` is normalized to `usdt-futures`, open candles are excluded from closed-candle selection, and malformed numerics become `undefined` rather than zero.

- [ ] **Step 4: Run the parser tests and verify the expected failure.**

  Run:

  ```bash
  npm test -- --run tests/bitget-market-rest.test.ts
  ```

  Expected: FAIL because the normalized Bitget types and adapter methods are not implemented.

- [ ] **Step 5: Implement the minimal transport.**

  Implement `BitgetHttpClient` using the existing `undici` `ProxyAgent` pattern. Default `BITGET_API_BASE_URL` to `https://api.bitget.com`, use a bounded timeout, parse the Bitget envelope, and throw `BitgetHttpError` for non-`00000` codes or HTTP failures. Retry only network errors and 5xx responses; surface 429/418 immediately with `retryAfterMs` when present.

- [ ] **Step 6: Implement the minimal market adapter.**

  Implement endpoint-specific query construction and parsers. Keep all Bitget field names inside this adapter. Use quote volume from candle index 6 for futures and index 6/7 according to the Spot response contract, and retain `sourceTimestamp` separately from local `receivedTimestamp`.

- [ ] **Step 7: Run focused tests and build.**

  Run:

  ```bash
  npm test -- --run tests/bitget-http.test.ts tests/bitget-market-rest.test.ts
  npm run build
  ```

  Expected: all new tests pass and TypeScript compiles.

---

### Task 2: Implement the pure Bitget reference-factor calculator

**Files:**

- Modify: `src/domain/bitget-reference.ts`
- Create: `src/analysis/bitget-reference-factor.ts`
- Test: `tests/bitget-reference-factor.test.ts`

**Interfaces:**

- `calculateBitgetReference(input: BitgetReferenceInput): BitgetReferenceFactor`
- `applyBitgetReference(signal: FuturesSignal, factor: BitgetReferenceFactor): FuturesSignal`

`BitgetReferenceInput` contains the Binance signal type/bias, Binance candle close/open, target interval/open time, Bitget Spot/Futures closed-candle arrays, Bitget OI snapshots, funding rate, and the configured thresholds.

- [ ] **Step 1: Write failing deterministic factor tests.**

  Add fixtures for:

  1. Bitget Spot and Futures both move in the Binance LONG direction, futures OI rises above 2%, and both quote-volume ratios are available; expect `BITGET_CONFIRMED`, `COMPLETE`, positive score, and confirmation evidence.
  2. Both Bitget markets move opposite to a Binance SHORT signal; expect `BITGET_CONTRADICTED` and negative score.
  3. Spot exists but futures OI is missing; expect `BITGET_INCOMPLETE`, `PARTIAL`, no fabricated OI value, and a partial score.
  4. All provider calls are unavailable; expect `BITGET_UNAVAILABLE`, `MISSING`, score `0`, and an unchanged signal confidence.
  5. A positive factor cannot change `INFO` to `HIGH`, and any confidence adjustment is capped at `0.10`.

- [ ] **Step 2: Run the factor tests and verify the expected failure.**

  Run:

  ```bash
  npm test -- --run tests/bitget-reference-factor.test.ts
  ```

  Expected: FAIL because the calculator and signal adjustment functions do not exist.

- [ ] **Step 3: Implement timestamp alignment and metrics.**

  Select the latest closed Bitget candle whose open/close window matches the Binance target interval and whose close time is not newer than the Binance candle close. Compute price returns, median-20 quote-volume ratios, OI delta, funding rate, basis, and cross-exchange price gap. Keep unavailable fields as `undefined` and append field names to `missing`.

- [ ] **Step 4: Implement status and score rules.**

  Use the approved thresholds: directional return `0.001`, OI delta `0.02`, price gap `0.003`, and confidence cap `0.10`. Return evidence strings with actual values and threshold names. Classify unavailable provider errors separately from valid-but-incomplete responses.

- [ ] **Step 5: Implement bounded signal adjustment.**

  Clone the original signal, append a `bitgetStatus=...` and factor evidence, adjust confidence only for `BITGET_CONFIRMED` or `BITGET_CONTRADICTED`, clamp to `[0, 1]`, and preserve the original severity. Do not adjust when the signal is non-directional or the factor is unavailable.

- [ ] **Step 6: Run focused tests and build.**

  Run:

  ```bash
  npm test -- --run tests/bitget-reference-factor.test.ts
  npm run build
  ```

  Expected: all factor tests pass and no existing TypeScript errors appear.

---

### Task 3: Add MySQL and in-memory factor persistence

**Files:**

- Create: `src/storage/migrations/003_bitget_reference_factors.sql`
- Modify: `src/storage/futures-repository.ts`
- Modify: `src/storage/in-memory-futures-repository.ts`
- Test: `tests/bitget-reference-repository.test.ts`
- Test: `tests/mysql-queryable.test.ts`

**Interfaces:**

- `FuturesRepository.saveBitgetReference(factor: BitgetReferenceFactor): Promise<void>`
- `FuturesRepository.getBitgetReference(symbol, interval, candleOpenTime): Promise<BitgetReferenceFactor | undefined>`
- `FuturesRadarRow.bitgetReference?: BitgetReferenceFactor`

- [ ] **Step 1: Write failing persistence tests.**

  Test a factor upsert with a fake `Queryable`: assert the query targets `futures_reference_factors`, serializes `missing` and `evidence` as JSON, writes `NULL` for missing numeric fields, and uses the full `(symbol, interval, candle_open_time, provider)` conflict key. Test that `listRadar` maps an optional factor without changing rows that have no factor.

- [ ] **Step 2: Run the persistence tests and verify the expected failure.**

  Run:

  ```bash
  npm test -- --run tests/bitget-reference-repository.test.ts
  ```

  Expected: FAIL because the repository methods, migration, and optional radar field do not exist.

- [ ] **Step 3: Add migration 003.**

  Create `futures_reference_factors` with the approved identity, status, timing, Spot fields, Futures fields, and JSON evidence fields. Add indexes on `(status, observed_at)` and `(symbol, interval_name, candle_open_time)`. Use MySQL types compatible with the current adapter and make the migration idempotent through `CREATE TABLE IF NOT EXISTS`.

- [ ] **Step 4: Implement repository persistence.**

  Add typed row mapping, idempotent upsert, and a left join from `futures_signals`/`futures_flow_metrics` to the factor table in `listRadar`. The factor provider must be fixed to `bitget`; malformed stored JSON maps to empty arrays, while missing numeric columns remain `undefined`.

- [ ] **Step 5: Mirror the behavior in the in-memory repository.**

  Store factors by the same composite key, return cloned objects, and include the factor when mapping radar rows. Existing tests that create signals without factors must continue to return `bitgetReference: undefined`.

- [ ] **Step 6: Run focused repository tests and migration syntax checks.**

  Run:

  ```bash
  npm test -- --run tests/bitget-reference-repository.test.ts tests/mysql-queryable.test.ts
  npm run db:migrate
  ```

  Expected: tests pass and migration 003 applies after migrations 001 and 002 without modifying existing rows.

---

### Task 4: Integrate candidate-only Bitget orchestration and health

**Files:**

- Create: `src/services/bitget-reference-service.ts`
- Modify: `src/services/futures-radar-service.ts`
- Modify: `src/http/app.ts`
- Modify: `src/main.ts`
- Modify: `src/config.ts`, `.env.example`
- Test: `tests/bitget-reference-service.test.ts`
- Test: `tests/futures-radar-service.test.ts`
- Test: `tests/main.test.ts`
- Test: `tests/config.test.ts`

**Interfaces:**

- `BitgetReferenceService.evaluate(input): Promise<BitgetReferenceFactor>`
- `BitgetReferenceService.stop(): Promise<void>`
- health connector key: `bitgetReference`
- `FuturesRadarService` receives optional `referenceService?: Pick<BitgetReferenceService, "evaluate">` and optional factor persistence through `FuturesRepository`.

- [ ] **Step 1: Write failing orchestration tests.**

  Test that:

  1. A candidate Binance signal invokes Bitget exactly once for `(symbol, interval, candleOpenTime)` and saves one factor.
  2. Two concurrent calls for the same key share one in-flight promise.
  3. A Binance candle that produces no candidate does not invoke Bitget.
  4. A Bitget timeout returns `BITGET_UNAVAILABLE`, keeps the Binance signal persisted/notified, and marks health disconnected without rejecting the candle queue.
  5. A partial Bitget response marks health degraded and leaves missing fields undefined.
  6. Existing `FuturesRadarService` tests with no reference service behave exactly as before.

- [ ] **Step 2: Run the orchestration tests and verify the expected failure.**

  Run:

  ```bash
  npm test -- --run tests/bitget-reference-service.test.ts tests/futures-radar-service.test.ts
  ```

  Expected: FAIL because the service, optional dependency wiring, and factor persistence call do not exist.

- [ ] **Step 3: Add Bitget configuration.**

  Add validated fields with defaults:

  ```text
  BITGET_API_BASE_URL=https://api.bitget.com
  BITGET_HTTP_TIMEOUT_MS=5000
  BITGET_REFERENCE_CACHE_MS=300000
  BITGET_REFERENCE_CONCURRENCY=3
  BITGET_REFERENCE_DIRECTION_RETURN=0.001
  BITGET_REFERENCE_OI_DELTA=0.02
  BITGET_REFERENCE_PRICE_GAP=0.003
  BITGET_REFERENCE_CONFIDENCE_CAP=0.10
  ```

  Keep all values public and non-secret; reject non-positive durations, concurrency, and thresholds through the existing Zod configuration path.

- [ ] **Step 4: Implement the candidate-only service.**

  Build a five-minute cache for Spot symbols and USDT-M contract metadata. For each candidate, use a promise map keyed by `symbol:interval:candleOpenTime` and a bounded queue to fetch the target market snapshots. Return partial factors instead of failing the entire job. Clear in-flight entries in `finally` and expose `stop()` that clears timers/cache state without closing the shared MySQL pool.

- [ ] **Step 5: Integrate after primary classification.**

  In `FuturesRadarService.processClosedCandle`, keep the current sequence through `classifyFuturesSignal`. If a candidate exists and the optional reference service is configured, evaluate and save the factor, then pass the factor through `applyBitgetReference` before `resolvePublicationSignal` and `saveSignalIfNew`. If the service is absent or unavailable, use the original signal and continue checkpoint advancement.

- [ ] **Step 6: Wire health and runtime startup safely.**

  Extend connector health to support `connected`, `degraded`, and `disconnected`; initialize `bitgetReference` as disconnected/uninitialized. Wire `BitgetHttpClient`, `BitgetMarketRestClient`, `BitgetReferenceService`, and its health controller in `createRuntime`. Keep Bitget startup asynchronous and non-blocking like the existing Binance/Web3 background initialization.

- [ ] **Step 7: Run focused tests and build.**

  Run:

  ```bash
  npm test -- --run tests/bitget-reference-service.test.ts tests/futures-radar-service.test.ts tests/main.test.ts tests/config.test.ts
  npm run build
  ```

  Expected: all focused tests pass; existing Binance-only service tests remain green.

---

### Task 5: Expose the factor through the API and Chinese dashboard

**Files:**

- Modify: `src/http/futures-routes.ts`
- Modify: `src/http/app.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`
- Test: `tests/futures-routes.test.ts`

**Interfaces:**

- Existing `GET /api/futures/radar` query parameters remain unchanged.
- Each returned radar row may contain `bitgetReference` with the normalized factor contract.
- `GET /health` includes `connectors.bitgetReference`.

- [ ] **Step 1: Write failing route tests.**

  Seed an in-memory radar signal with a confirmed factor and assert the JSON response contains `bitgetReference.status`, `factorScore`, Spot/Futures fields, `missing`, and `evidence`. Seed a row without a factor and assert the field is absent/undefined rather than a zero-filled object. Assert health serializes `degraded` and `disconnected` Bitget states.

- [ ] **Step 2: Run route tests and verify the expected failure.**

  Run:

  ```bash
  npm test -- --run tests/futures-routes.test.ts
  ```

  Expected: FAIL because route/domain mapping and health status support are not yet wired.

- [ ] **Step 3: Implement API mapping without breaking old fields.**

  Keep the current validation schemas and response shape. Extend only the radar row mapper and health object; do not add new required query parameters or change pagination semantics.

- [ ] **Step 4: Add Chinese UI fields and states.**

  Extend `FuturesRow` with the optional factor. Add a `Bitget 参考` badge to each futures row and a detail block showing:

  ```text
  状态、因子分数、现货涨跌、合约涨跌、OI变化、资金费率、基差、证据、缺失字段
  ```

  Map statuses to `已确认`, `有冲突`, `数据不完整`, `不可用`. Render `—` for undefined values and `暂无 Bitget 参考` for absent factors. Keep the existing no-trading copy and responsive layout.

- [ ] **Step 5: Run route and frontend checks.**

  Run:

  ```bash
  npm test -- --run tests/futures-routes.test.ts
  npm run frontend:build
  ```

  Expected: API tests pass and Vite produces a successful production build.

---

### Task 6: Documentation, migration, and integration verification

**Files:**

- Modify: `README.md`
- Modify: `.env.example`
- Modify: `scripts/futures-radar-smoke.ts` if the smoke output needs a non-secret Bitget status line
- Test: `tests/futures-radar-smoke.test.ts`

- [ ] **Step 1: Write failing smoke/config documentation tests where applicable.**

  Extend config tests to assert Bitget defaults and validation. Extend the smoke test only to assert the optional connector summary remains non-secret; do not make live Bitget availability a unit-test requirement.

- [ ] **Step 2: Run the focused tests and verify the expected failure.**

  Run:

  ```bash
  npm test -- --run tests/config.test.ts tests/futures-radar-smoke.test.ts
  ```

  Expected: FAIL until the new configuration and status output are implemented.

- [ ] **Step 3: Document setup and read-only behavior.**

  Add the Bitget environment variables, migration command, health interpretation, public endpoint scope, and explicit note that Bitget is only a Binance reference factor. Document that `429/418` is surfaced as unavailable and is not aggressively retried.

- [ ] **Step 4: Run the complete verification suite.**

  Run:

  ```bash
  npm test -- --run
  npm run build
  npm run frontend:build
  npm run db:migrate
  ```

  Expected: all backend tests pass, TypeScript builds, frontend builds, and migration 003 is recorded in `schema_migrations`.

- [ ] **Step 5: Perform bounded live public checks.**

  With no credentials, call one Bitget Spot ticker and one Bitget USDT-M Futures ticker for a stable public symbol through the configured proxy if available. Verify that a live 429/418 or network failure yields a visible `不可用` health state and no process crash. Do not loop or retry aggressively.

- [ ] **Step 6: Verify the UI and worktree scope.**

  Start backend and frontend, open `http://127.0.0.1:5173`, verify the Bitget badge/detail states at desktop and mobile widths, and run:

  ```bash
  git diff --check
  git status --short
  ```

  Keep unrelated existing worktree changes unstaged and do not commit generated screenshots or local secrets.

---

## Execution order and checkpoints

1. Complete Tasks 1–2 and run their focused tests.
2. Complete Task 3 and apply migration 003 locally.
3. Complete Task 4; verify a Binance-only run still works when Bitget is unavailable.
4. Complete Task 5; verify API backward compatibility and the Chinese UI.
5. Complete Task 6; run the full suite and bounded live checks.

At each checkpoint, stop if the public provider returns a rate-limit/ban response, record the provider state, and continue only with deterministic fixtures or already available data.
