# Bitget Reference Factor Design

## Goal

接入 Bitget 现货和 USDT-M 合约公开市场 API，把 Bitget 作为 Binance 合约信号的独立参考因子，用于确认、冲突识别和数据完整性提示；不使用 Bitget API Key，不执行交易，不扩展 Binance 的主监控池。

## Scope and boundaries

### In scope

- 对 Binance 已纳入监控且产生 5m/15m 信号的同名 `BASEUSDT` 标的做 Bitget 交叉验证。
- 读取 Bitget 公开接口：现货交易对、现货 K 线、现货 Ticker；合约配置、合约 K 线、合约 Ticker、OI、当前资金费率。
- 归一化 Bitget 的价格、成交量、OI、资金费率和时间戳。
- 计算 Bitget 对 Binance 信号的确认、冲突、部分数据和不可用状态。
- 将参考因子落库，并在 Futures API、健康状态和中文前端展示。

### Out of scope

- Bitget 独立发现 Binance 没有的标的。
- Bitget 账户、持仓、订单、资金或签名接口。
- 自动下单、自动买入、自动卖出、LP 操作或私钥签名。
- 用 Bitget 数据替代 Binance 主信号或单独产生交易信号。
- 为了补齐 Bitget 缺失字段而引入第三方数据源。

## Existing project context

当前工程由 `FuturesRadarService` 驱动 Binance USDⓈ-M Futures 的 5m/15m K 线、OI、主动买卖和资金费率分析；`FuturesRepository` 将信号和指标持久化到 MySQL，`/api/futures/radar` 返回中文前端消费的雷达行。现有 `RestClient` 是单一 Binance 适配器，Bitget 不应侵入 Binance 响应解析和主信号分类器的职责。

因此新增一个独立的 Bitget 参考层：

```text
Binance closed candle/signal
        |
        v
BitgetReferenceService
  |-- Spot REST adapter
  |-- Futures REST adapter
  |-- symbol/time normalization
  |-- factor classification
        |
        +--> MySQL futures_reference_factors
        +--> Futures API bitgetReference
        +--> health connector bitgetReference
        +--> Chinese UI confirmation badge/evidence
```

## Official public API mapping

Use Bitget v2 public endpoints with no authentication:

| Domain | Endpoint | Use |
| --- | --- | --- |
| Spot | `GET /api/v2/spot/public/symbols` | 判断 Bitget 现货交易对是否在线、获取 base/quote |
| Spot | `GET /api/v2/spot/market/candles` | 获取 5m/15m 现货 K 线和成交量 |
| Spot | `GET /api/v2/spot/market/tickers` | 获取现货最新价、盘口一档、24h 成交量 |
| Futures | `GET /api/v2/mix/market/contracts?productType=usdt-futures` | 判断 Bitget USDT-M 合约是否存在、读取合约元信息 |
| Futures | `GET /api/v2/mix/market/candles` | 获取 5m/15m 合约 K 线和成交量 |
| Futures | `GET /api/v2/mix/market/ticker` | 获取合约最新价、标记价、指数价、资金费率和持仓量字段 |
| Futures | `GET /api/v2/mix/market/open-interest` | 获取平台级合约 OI |
| Futures | `GET /api/v2/mix/market/current-fund-rate` | 获取当前资金费率和下一次更新时间 |

Bitget 文档说明这些市场接口支持公开访问；5m/15m K 线、OI 和资金费率的返回字段需要在适配层做字符串转数值和时间戳校验。接口 URL 和字段以官方文档为准，不把搜索摘要或第三方 SDK 当作协议定义。

## Data flow

1. Binance 关闭一根 5m 或 15m K 线并完成现有 OI/成交量分析。
2. `FuturesRadarService` 将 Binance 的 `symbol`、`interval`、`candleOpenTime` 和主信号传给 `BitgetReferenceService`。
3. 服务先把 Binance symbol 规范化为 `BASEUSDT`，只允许 USDT 现货和 USDT-M 合约；无法安全映射时直接返回 `BITGET_INCOMPLETE`。
4. Bitget 适配器并发读取目标标的的现货 K 线、合约 K 线、合约 OI、Ticker 和资金费率；每个请求有超时和独立错误，不因一个字段失败而丢弃其他字段。
5. 服务只使用与 Binance candle 时间窗口一致的已关闭 Bitget K 线，记录 Bitget 的源时间和本地接收时间。
6. 计算参考因子并保存快照；主 Binance 信号继续按原逻辑保存。
7. API 在主雷达行中附带 `bitgetReference`；前端显示状态、分数、证据和缺失字段。

Bitget 查询只针对 Binance 已产生候选的标的，不在启动时全量拉取 Bitget 所有交易对，避免扩大请求量和触发限流。

## Normalized data contract

新增内部类型 `BitgetReferenceFactor`：

```ts
type BitgetReferenceStatus =
  | "BITGET_CONFIRMED"
  | "BITGET_CONTRADICTED"
  | "BITGET_INCOMPLETE"
  | "BITGET_UNAVAILABLE";

interface BitgetReferenceFactor {
  provider: "bitget";
  symbol: string;
  interval: "5m" | "15m";
  candleOpenTime: number;
  observedAt: number;
  sourceTimestamp?: number;
  status: BitgetReferenceStatus;
  factorScore: number; // -1 to 1, reference only
  completeness: "COMPLETE" | "PARTIAL" | "MISSING";
  spot?: {
    available: boolean;
    close?: number;
    volumeQuote?: number;
    priceReturn?: number;
    volumeRatio?: number;
  };
  futures?: {
    available: boolean;
    close?: number;
    volumeQuote?: number;
    priceReturn?: number;
    volumeRatio?: number;
    openInterest?: number;
    openInterestDelta?: number;
    fundingRate?: number;
    basis?: number;
  };
  missing: string[];
  evidence: string[];
  error?: string;
}
```

The API may expose this object as `bitgetReference` on `FuturesRadarRow`. The persistence representation may use JSON for `missing` and `evidence`, but numeric fields needed for filtering and audit remain separate columns.

## Factor calculations

The factor is a small confirmation signal, not a new classifier:

- `spotDirection`: Bitget spot closed-candle return direction.
- `futuresDirection`: Bitget futures closed-candle return direction.
- `spotVolumeRatio`: current Bitget spot quote volume divided by the median of the previous 20 same-interval closed candles, when the baseline exists.
- `futuresVolumeRatio`: same calculation for Bitget futures quote volume.
- `openInterestDelta`: current Bitget futures OI divided by the previous same-interval OI minus 1, using timestamps not newer than the target candle.
- `basis`: `(bitgetFuturesClose - bitgetSpotClose) / bitgetSpotClose` when both prices are present.
- `crossExchangePriceGap`: absolute difference between Binance and Bitget close prices after timestamp alignment.

Default scoring:

- `+1.0` when Bitget spot and futures direction agree with the Binance directional signal and OI/volume do not contradict it.
- `+0.5` when only one Bitget market confirms and the other is missing.
- `0` when the data is incomplete or the Binance signal is non-directional.
- `-1.0` when Bitget spot and futures both materially contradict the Binance directional signal, or Bitget futures OI moves in the opposite direction with sufficient data.

The main signal confidence adjustment is capped at `±0.10`; the Bitget factor cannot promote an `INFO` signal to `HIGH`, cannot suppress a Binance signal by itself, and is not applied when status is `BITGET_UNAVAILABLE`.

Thresholds must be named configuration values, not magic literals. Initial defaults should be:

- minimum absolute candle return for directional comparison: `0.001`;
- minimum absolute OI delta for an OI confirmation/contradiction: `0.02`;
- maximum acceptable cross-exchange close gap for confirmation: `0.003`;
- confidence adjustment cap: `0.10`.

These are screening defaults and must remain visible in evidence; they are not a trading guarantee.

## Persistence

Create MySQL migration `003_bitget_reference_factors.sql` with table `futures_reference_factors`:

- primary key: `(symbol, interval_name, candle_open_time, provider)`;
- identity: `symbol`, `interval_name`, `candle_open_time`, `provider`;
- status: `status`, `completeness`, `factor_score`;
- source timing: `source_timestamp`, `observed_at`, `received_timestamp`;
- spot fields: availability, close, quote volume, return, volume ratio;
- futures fields: availability, close, quote volume, return, volume ratio, OI, OI delta, funding rate, basis;
- audit fields: `missing` JSON, `evidence` JSON, `error` VARCHAR;
- indexes: `(status, observed_at)` and `(symbol, interval_name, candle_open_time)`.

Upserts must be idempotent. A Bitget retry must not create a second factor for the same Binance candle. Existing Binance tables and signal keys remain unchanged.

## API and health behavior

Extend `/api/futures/radar` rows with optional `bitgetReference`. Preserve existing response fields and query parameters.

Add a health connector named `bitgetReference`:

- `connected`: latest reference query completed with usable data;
- `degraded`: Bitget responded but fields were incomplete or the target symbol was not listed;
- `disconnected`: timeout, HTTP error, malformed response, or repeated provider failure.

The application remains available when Bitget is down. Binance data continues to be returned without a Bitget adjustment. Error messages must be sanitized and must not include credentials, proxy URLs with secrets, or raw request headers.

## Frontend behavior

The existing Chinese dashboard keeps Binance as the primary source. Add:

- a `Bitget 参考` column or inline badge in the Futures table;
- status labels `已确认`, `有冲突`, `数据不完整`, `不可用`;
- a detail section with Bitget spot/futures return, OI delta, basis, factor score, source time, and evidence;
- a top-level source status entry for Bitget;
- an explicit unavailable state instead of zero values when a field was not returned.

No buy, sell, order, copy-trade, or profit language is added.

## Error handling and rate limits

- Use a shared public HTTP client with timeout, bounded retry only for network errors and transient 5xx responses, and no aggressive retry for 429/418.
- Honor `Retry-After` when Bitget supplies it and mark the provider degraded/disconnected.
- Limit each Binance candle to one Bitget reference job; deduplicate concurrent jobs by `(symbol, interval, candleOpenTime)`.
- Use partial results when one endpoint succeeds and another fails, while preserving `missing` and `error`.
- A malformed numeric field becomes missing; it never becomes zero.
- Keep request concurrency bounded by configuration.

## Testing and acceptance criteria

### Unit tests

- Parse valid Bitget spot symbols, spot candles, spot ticker, futures contracts, futures candles, OI, ticker and funding responses.
- Reject wrong product type, wrong symbol, open/incomplete candles, invalid numeric fields and malformed `code` responses.
- Normalize timestamps and quote volumes consistently.
- Compute confirmation, contradiction, partial and unavailable statuses from deterministic fixtures.
- Enforce confidence adjustment cap and no adjustment for unavailable data.
- Verify MySQL factor upsert and JSON field serialization.

### Integration tests

- A Binance signal triggers one deduplicated Bitget reference job.
- Bitget failure leaves the Binance signal available and sets health to degraded/disconnected.
- `/api/futures/radar` preserves old fields and returns `bitgetReference` when available.
- A MySQL migration applies cleanly after migrations 001 and 002.

### Acceptance

- `npm test` passes.
- `npm run build` passes.
- Frontend build passes.
- Public Bitget endpoints are queried without credentials.
- A live Bitget outage produces a visible Chinese unavailable state and no fabricated values.
- Existing read-only, no-trading, no-LP-mutation boundary remains unchanged.

## References

- Bitget Spot symbols: https://www.bitget.com/api-doc/spot/market/Get-Symbols
- Bitget Spot ticker: https://www.bitget.com/api-doc/spot/market/Get-Tickers
- Bitget Spot candles: https://www.bitget.com/api-doc/spot/market/Get-Candle-Data
- Bitget Futures contracts: https://www.bitget.com/api-doc/contract/market/Get-All-Symbols-Contracts
- Bitget Futures ticker: https://www.bitget.com/api-doc/classic/contract/market/Get-Ticker
- Bitget Futures candles: https://www.bitget.com/api-doc/classic/contract/market/Get-Candle-Data
- Bitget Futures OI: https://www.bitget.com/api-doc/classic/contract/market/Get-Open-Interest
- Bitget Futures funding rate: https://www.bitget.com/api-doc/contract/market/Get-Current-Funding-Rate
