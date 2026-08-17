# MySQL 中文链上猎犬监控台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PostgreSQL with MySQL, add read-only Binance Web3 gem discovery, and build a Chinese React/Vite monitoring page.

**Architecture:** The existing TypeScript service keeps its pure Futures analysis and repository interfaces. A MySQL adapter translates the repository operations to `mysql2/promise`, while a skill-process adapter calls the installed Binance Web3 CLI without credentials. A Vite React app consumes normalized JSON endpoints and renders the approved dark monitoring-console design.

**Tech Stack:** Node.js 22+, TypeScript, Fastify, mysql2, React, Vite, Vitest, CSS, Binance Web3 skill CLIs.

## Global Constraints

- Read-only monitoring only; never place, cancel, modify, or simulate an order.
- MySQL defaults are `127.0.0.1:3306`, `root`, database `crypto_monitor`; password is local environment configuration only.
- All visible UI copy is Chinese.
- “自动打金狗” means automatic discovery, scoring, deduplication, persistence, and alerting; no automatic purchase.
- Missing or rate-limited Binance Web3 data must be surfaced as unavailable, never replaced with fabricated data.
- Preserve the existing Futures metric and signal behavior.

### Task 1: Switch persistence and configuration to MySQL

**Files:** modify `src/config.ts`, `src/storage/db.ts`, `src/main.ts`, `src/storage/migrations/001_futures_radar.sql`, `package.json`, `.env.example`, `README.md`; create `src/storage/mysql-queryable.ts`; test `tests/config.test.ts`, `tests/mysql-queryable.test.ts`.

- [ ] Add MySQL config fields and validate host, port, user, database, and password.
- [ ] Replace the PostgreSQL pool and migration runner with `mysql2/promise`.
- [ ] Translate the existing repository SQL through a tested MySQL query adapter, including JSON serialization, placeholders, upsert syntax, and insert-if-new result handling.
- [ ] Use MySQL JSON, BIGINT, and DATETIME-compatible migration DDL.
- [ ] Run focused tests, full tests, and TypeScript build.

### Task 2: Add Binance Web3 gem discovery

**Files:** create `src/connectors/binance-web3-skills.ts`, `src/domain/onchain.ts`, `src/services/onchain-gem-service.ts`, `src/http/onchain-routes.ts`; modify `src/config.ts`, `src/main.ts`, `src/http/app.ts`; test `tests/binance-web3-skills.test.ts`, `tests/onchain-gem-service.test.ts`, `tests/onchain-routes.test.ts`.

- [ ] Invoke skill CLIs without a shell and normalize smart-money inflow, meme-rush, and smart-money signal responses.
- [ ] Scan BSC, Solana, and Base with bounded concurrency and a refresh interval.
- [ ] Score candidates using only fields actually returned, retain evidence and completeness, and map all statuses to Chinese.
- [ ] Add `GET /api/onchain/gems` and `GET /api/onchain/status`.

### Task 3: Build the Chinese React/Vite monitor

**Files:** create `frontend/package.json`, `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/App.tsx`, `frontend/src/styles.css`, `frontend/vite.config.ts`, `frontend/tsconfig.json`; modify root scripts and README.

- [ ] Create the dashboard shell, Chinese navigation, summary strip, OI/volume SVG chart, Futures table, gem hunter table, and details panel.
- [ ] Add 15-second polling, chain/severity filters, loading state, error state, and unavailable-data state.
- [ ] Add Vite proxy to backend and responsive desktop/mobile layout.
- [ ] Run frontend build and browser verification with screenshots.

### Task 4: Integration verification

- [ ] Run MySQL migration against the configured local server if reachable.
- [ ] Run `npm test`, backend build, frontend build, and smoke checks.
- [ ] Verify the dashboard against `/health`, `/api/futures/radar`, and `/api/onchain/gems`.
- [ ] Keep the branch isolated and avoid staging unrelated generated files.
