# bn_future

---

# Futures Radar

这是一个币安合约与链上热门代币监控服务：后端采集 Binance USDⓈ-M 合约公开行情，并通过已安装的 Binance Web3 skills 做链上候选发现；前端提供全中文轻量监控页面。交易执行默认是模拟盘。

## Execution boundary

- Public market data is used for the radar and leaderboard.
- Bitget 仅作为 Binance 合约信号的参考因子，不会扩展监控 universe，也不会替代 Binance 上架/下架边界。
- `SIMULATION` is the default execution mode and uses no exchange credentials.
- `BINANCE_DEMO_TESTNET` is opt-in and requires an explicitly configured non-production endpoint plus demo credentials; production Binance endpoints are rejected by runtime wiring.
- `BINANCE_PRODUCTION`（实盘）是显式选择项：要求 `BINANCE_PRODUCTION_API_KEY` / `BINANCE_PRODUCTION_API_SECRET`，执行端点由运行时强制固定为 `https://fapi.binance.com`（白名单校验，任何其他端点都会被拒绝）。实盘下的安全边界：
  - 止损保护单为交易所真实 `STOP_MARKET` reduce-only 挂单，**挂不上保护单就拒绝开仓**；
  - 开仓前校验可用保证金 ≥ 本次保证金 × `BINANCE_PRODUCTION_MIN_FREE_MARGIN_MULTIPLIER`（默认 `1.2`），不足时温和拒绝（不熔断）；
  - 熔断自动复位在实盘下**强制关闭**，数据/订单异常恢复后必须人工确认（手动清熔断）才会重新开仓；
  - 前端顶栏显示红色脉冲"实盘交易"标识，与模拟盘区分。
  实盘交易使用真实资金，接入前务必使用**子账户 + 小额试运行**，API Key 只开合约权限、不开提现权限，并设置 IP 白名单。
- No wallet private keys, LP mutation, or frontend trading switch is exposed.
- “自动打金狗”仅表示自动发现、评分、去重和告警候选代币，不包含自动买入、卖出、LP 操作或私钥签名。
- Telegram alerts are optional and configuration-only.
- If the runtime requires an outbound proxy, set `BINANCE_HTTP_PROXY`; the backend falls back to the standard `HTTPS_PROXY` and then `HTTP_PROXY` variables, while the smoke script accepts the same variables without printing them.
- Startup historical backfill is capped by `FUTURES_STARTUP_BACKFILL_SYMBOL_LIMIT` (default `24`) to avoid an API request burst; live WebSocket subscriptions still cover the full detected universe.
- When a proxy completes the WebSocket handshake but drops data frames, the service alternates controlled REST polling for the first `FUTURES_REST_POLL_SYMBOL_LIMIT` symbols (default `24`) every `FUTURES_REST_POLL_INTERVAL_MS` (default `30s`).
- Bitget `429/418`、网络故障或被代理拦截时会直接显示为“不可用”，不会做激进重试。
- 历史数据由定期清理任务维护：K线/OI/指标/参考因子默认保留 `30` 天，信号保留 `180` 天，原始 source events 保留 `14` 天；每 `6` 小时按 `5000` 行批量清理一次。
- 评分保持 0–100 分：OI 50 分、成交量 15 分、5 分钟正涨幅 15 分、价格-OI 结构 10 分、主动成交 10 分。5 分钟涨幅达到 `3%` 时显示“5分钟爆发”高优先级因子。

## Execution settings

执行参数保存在 MySQL `execution_settings` 表（迁移 `006`），通过前端“设置”页或 `GET/PUT /api/settings` 可视化配置，**保存后立即生效**（每次信号评估与行情检查读取最新值），无需重启：

- 开仓参数：`leverage` 杠杆倍数（默认 5）、`notionalUsdt` 开仓金额（默认 500 USDT）、`minEntryScore` 开仓评分阈值（默认 80）、`maxOpenPositions` 最大持仓数（默认 3）。
- 分级止盈 `takeProfitLevels`（默认三级 `+8% 平 1/3 → +15% 平 1/3 → +25% 平剩余`，最多 5 级，按涨幅升序，末级平仓比例必须为 1）：每级触发后止损上移（第 1 级 → 保本 `breakevenPercent`，第 k 级 → 上一级止盈价）。
- 兜底保护：`stopLossPercent` 止损率（默认 8，即 -8%）、`maxHoldMinutes` 时间兜底（默认 120 分钟未达第一级止盈则平仓，0=关闭）、`reversalExitEnabled` 5m 价格-OI 反转退出（默认开）、`circuitBreakerAutoReset` 熔断自动复位（默认开，数据流恢复后自动解除）。
- 设置读取失败时回退默认值，不阻断监控；旧持仓行（无 `takeProfitLevelReached` 字段）视为未触达任何止盈级。

## Setup

Install dependencies:

```bash
npm install
```

## Development

Run tests:

```bash
npm test
```

Run the integrated service test:

```bash
npm test -- --run tests/futures-radar-service.test.ts
```

Run the focused config tests:

```bash
npm test -- --run tests/config.test.ts
```

Build:

```bash
npm run build
```

Start in development mode:

```bash
npm run dev
```

Start the built service:

```bash
npm start
```

`npm start` runs the compiled backend entry at `dist/src/main.js` through the existing `tsx` ESM loader, because the TypeScript build currently emits extensionless internal imports that plain `node dist/src/main.js` cannot resolve reliably.

For production/runtime installs, keep `tsx` in root runtime `dependencies`. A deploy that uses `npm install --omit=dev` must still provide the `node --import tsx/esm dist/src/main.js` loader contract; only TypeScript, Vitest, and Node type packages stay development-only.

Run the public smoke summary:

```bash
npm run futures:smoke
```

Run migrations:

```bash
npm run db:migrate
```

## 配置

复制 `.env.example` 后按本机环境调整。默认已经使用 MySQL：`127.0.0.1:3306`，账号 `root`，密码 `gao`，数据库 `crypto_monitor`。Telegram 配置必须成对出现，均为可选。

Bitget 相关环境变量默认值如下，均为公开只读参考用途：

- `BITGET_API_BASE_URL=https://api.bitget.com`
- `BITGET_HTTP_TIMEOUT_MS=5000`
- `BITGET_REFERENCE_CACHE_MS=300000`
- `BITGET_REFERENCE_CONCURRENCY=3`
- `BITGET_REFERENCE_DIRECTION_RETURN=0.001`
- `BITGET_REFERENCE_OI_DELTA=0.02`
- `BITGET_REFERENCE_PRICE_GAP=0.003`
- `BITGET_REFERENCE_CONFIDENCE_CAP=0.10`

这些配置只影响 Bitget 参考因子的抓取、缓存和阈值判断；不会启用 Bitget 账户、下单、签名或 LP 操作。

合约存储与爆发评分相关配置：

- `FUTURES_HOT_RETENTION_DAYS=30`
- `FUTURES_SIGNAL_RETENTION_DAYS=180`
- `FUTURES_SOURCE_EVENT_RETENTION_DAYS=14`
- `FUTURES_CLEANUP_INTERVAL_MS=21600000`
- `FUTURES_CLEANUP_BATCH_SIZE=5000`
- `FUTURES_PRICE_RETURN_5M_THRESHOLD=0.03`

如需接入 Binance Web3 skills，可设置 `BINANCE_WEB3_SKILLS_DIR` 指向包含 `crypto-market-rank`、`meme-rush` 和 `trading-signal` 的 skills 目录；未找到 provider 时，页面会显示“不可用”，不会伪造链上数据。

## 启动

先准备数据库并执行迁移：

```bash
mysql -h 127.0.0.1 -P 3306 -uroot -p -e "CREATE DATABASE IF NOT EXISTS crypto_monitor CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
npm run db:migrate
```

当前迁移序号包含 `004_execution.sql`，会创建模拟/演练执行所需的持仓、订单、去重、熔断和审计表。重复执行 `npm run db:migrate` 应保持幂等，只会在 `schema_migrations` 中记录未执行过的 migration。

启动后端：

```bash
npm run dev
```

另开终端启动前端：

```bash
npm run frontend:dev
```

浏览器访问 `http://127.0.0.1:5173` 查看中文 dashboard；后端 API 在 `http://127.0.0.1:8787`。

如需构建产物验证，可分别运行：

```bash
npm run build
npm run frontend:build
```

## 健康状态说明

`/health` 会同时返回顶层服务状态和各连接器状态：

- 顶层 `status`
  - `ok`：所有已暴露的连接器当前都是 `connected`
  - `degraded`：服务进程仍在线，但至少一个连接器不是 `connected`
- `connectors.*.status`
  - `connected`：该公开数据来源最近一次检查可用
  - `degraded`：该连接器仍可提供部分结果，但参考因子/链上来源只拿到部分公开数据，或公开接口返回了可见的降级信息
  - `disconnected`：该连接器当前不可用，例如启动前、网络不可达、代理阻断，或 Bitget 公开接口返回 `429/418` 后被直接标记为不可用

其中 `connectors.bitgetReference` 专门表示 Bitget 公开参考因子的状态；它只作为 Binance 信号的辅助参考，不会扩展监控 universe，也不会改变顶层 `status` 只取 `ok | degraded` 这一约定。

## 执行规则

- 仅保留 Binance 有 USDT 永续、且 Binance Spot 没有同 `baseAsset` 活跃现货的标的。
- 入场必须同时满足评分 `>=80`、`PRICE_UP_OI_UP`、对应周期 OI/成交量阈值、数据完整、主动买盘确认、滑点未超限、未达到 3 个持仓且没有重复订单。
- 每笔固定保证金 100 USDT、5 倍杠杆、名义仓位约 500 USDT，只做多，不加仓、不滚仓。
- 入场后下 8% 硬止损；上涨 8% 平 50%，剩余仓位保护价移动到入场价上方约 0.1%；5m 反转时平剩余仓位；没有固定最长持仓时间。
- 订单状态未知、数据流中断或保护单缺失会触发执行熔断。前端没有开启生产交易的按钮。

### 手动干预注意事项（实盘）

- **引擎外的任何手动操作不会自动同步引擎状态**。直接通过交易所 API 平仓、撤销保护单等操作后，必须手工同步数据库，否则 dashboard 会显示错误的"持仓中"，引擎还可能对已不存在的仓位执行止盈/止损（reduce-only 被拒会触发熔断），或错误占用 `maxOpenPositions` 名额拒绝新开仓。
- 手动平仓后需要同步的两处：
  1. `execution_positions`：将该 symbol 的记录 `status` 置为 `CLOSED`；
  2. `execution_audit_events`：补一条 `POSITION_CLOSED`（`reason_code='MANUAL_FLATTEN'`）审计记录，说明为引擎外手动平仓。
- 手动撤销保护单（Algo 条件单）后，如对应持仓仍在，需由引擎在下次替换保护单时重新挂单；确认 `fapi/v1/openAlgoOrders` 无残留。

## Public endpoint scope

- Binance：公开 USDⓈ-M 合约行情、交易所元数据、只读 WebSocket 行情。
- Bitget：公开 Spot / USDT-M 行情与参考因子计算所需元数据，只用于交叉验证 Binance 信号。
- Binance Web3：本地 skills 提供的公开候选发现结果。

Demo/Testnet 凭证若显式配置，只由隔离的 Demo 执行适配器使用；生产凭证和生产端点会被运行时拒绝。本项目不包含钱包私钥、转账或 LP 变更逻辑。

## Runtime wiring

- `src/main.ts` wires the runtime through dependency injection only.
- Startup loads configuration, creates a MySQL-backed repository, connects the Binance Futures REST/WebSocket market-data adapters, attaches the candle orchestration service, and serves the Fastify read API. Simulation mode also consumes qualified signals through the isolated execution engine; Demo/Testnet mode uses the signed adapter only when explicitly configured.
- Startup also attaches the public Bitget reference service as a secondary factor only; it never widens the Binance futures universe.
- Chain discovery invokes the local Binance Web3 skill CLIs for BSC、Solana 和 Base, then merges smart-money inflow, meme lifecycle, and supported per-trade signals into a scored candidate list.
- No production trading, LP mutation, DBot, or X/Square adapters are enabled in this slice.
- `npm run futures:smoke` performs exactly one public Binance Futures exchange-info fetch and prints a Futures-only USDT perpetual count plus non-sensitive sample symbols only; it does not attempt Spot cross-checking or contract-only classification, and the Bitget status line is descriptive only rather than a live credentialed check.
