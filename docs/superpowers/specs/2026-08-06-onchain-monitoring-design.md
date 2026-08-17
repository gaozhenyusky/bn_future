# 7×24 链上热门代币监控系统设计

- 日期：2026-08-06
- 状态：待用户评审
- 范围：Solana、BSC、Ethereum、Base；Binance USDⓈ-M 合约；Robinhood Chain 预留适配器
- 操作边界：只读监控、人工确认、LP 状态查看和操作预览；不自动交易、不自动跟单、不自动修改 LP

## 1. 目标

系统需要持续监控：

1. 热门代币、新交易对、交易量和流动性变化；
2. Binance Square 热议内容；
3. X/Twitter 指定账号、关键词、代币符号和合约地址；
4. Binance Web3 Smart Money、KOL、排行榜和钱包交易；
5. DBot 的热门代币、实时交易、LP 增减和钱包事件；
6. Solana、BSC、Ethereum、Base 的钱包和 LP 风险；
7. Telegram 实时告警和本地 Web 仪表盘；
8. 用户自己的 LP 头寸、范围、奖励和流动性风险。
9. Binance 合约中没有 Binance 现货对应交易对的代币，重点观察 5m/15m K 线放量和 OI 放大。

系统输出的是“可核验候选”和“风险事件”，不是自动买卖建议。

## 2. 选定方案

采用“官方数据优先 + 两个独立来源确认 + 可插拔备用源”的方案：

- 社交主源：X Filtered Stream；
- 币安广场：必选适配器，优先官方或授权读取接口；当前 Binance Square skill 只支持发帖，因此备用为第三方实时 feed 或不登录的公开页面采集；
- 链上主源：DBot REST/WebSocket；
- 链上第二来源：Birdeye WebSocket，作为可选增强；
- Binance 链上情报：leaderboard、wallet tracker、trading signal、token audit；
- Binance USDⓈ-M Futures：交易对状态、5m/15m K 线、OI、主动买卖量、资金费率、标记价格和爆仓背景；
- 交易对补充：DEX Screener；
- 高级情报：Nansen、Arkham、Cielo、Moni；
- 宏观和研究：CoinGecko、CoinMarketCap、CoinGlass、Dune、DefiLlama、Token Terminal；
- LP 读数：DBot LP 事件 + Birdeye LP 事件 + Binance Agentic Wallet DeFi position。

任何一个外部供应商都不能单独决定“热门”或“聪明钱”。

## 3. 数据源边界

| 数据源 | 第一阶段用途 | 实时性 | 主要限制 |
|---|---|---:|---|
| X Filtered Stream | 账号、关键词、$TOKEN、合约地址、社交热度 | 秒级至十秒级 | 需要 X 开发者项目和 Bearer Token |
| Binance Square | 热议帖子、作者、代币提及、互动增长 | 取决于读取接口 | 已安装 square-post 只支持发布，不支持读取 |
| DBot | Solana/BSC 热门/新币、交易和 LP 事件 | REST + WebSocket | 热门/新币接口主要是 Solana/BSC；Robinhood 数据覆盖未确认 |
| Binance leaderboard | 地址种子、PnL、胜率、交易量 | 轮询 | 主要是榜单快照，不等于长期能力 |
| Binance wallet tracker | Smart Money/KOL 代币和交易流 | WebSocket/轮询 | 公共标签是供应商标签，需要独立验证 |
| Binance USDⓈ-M Futures | 合约-only 发现、5m/15m K 线、OI、主动买卖量和衍生品风险 | Kline WebSocket + REST | OI 是多空双方总持仓，不能单独证明净多或净空；公开 OI 历史有时间窗口和请求限制 |
| Birdeye | 多链新交易对、代币统计、钱包和 LP 事件 | WebSocket | 实时 WebSocket 需要相应商业套餐 |
| DEX Screener | 交易对、流动性、成交量、社交链接 | REST | 不提供可靠的 Smart Money 身份判断 |
| Nansen/Arkham/Cielo/Moni | 地址标签和高级钱包情报 | 依套餐 | 成本、额度和字段可用性需要单独确认 |
| CoinGlass | OI、资金费率、爆仓和衍生品背景 | REST/计划能力 | 更适合 BTC/ETH 和市场环境，不适合新 meme 币发现 |
| Dune/DefiLlama/Token Terminal | 回测、协议、TVL、费用和基本面 | 分钟至小时 | 不作为秒级告警主源 |

DBot 官方数据接口见：
https://docs.dbotx.com/reference/data-apis-overview

X Filtered Stream 官方说明见：
https://docs.x.com/x-api/posts/filtered-stream/introduction

Birdeye WebSocket 和网络支持见：
https://docs.birdeye.so/docs/websocket
https://docs.birdeye.so/docs/supported-networks

Binance USDⓈ-M Futures 官方接口见：
https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#open-interest
https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Kline-Candlestick-Streams

## 4. 总体数据流

    X Stream ───────────────┐
    Binance Square ────────┤
    DBot REST/WS ──────────┤
    Birdeye WS ────────────┤
    Binance skills ────────┤
    Binance Futures ───────┤
    DEX Screener ──────────┘
                  ↓
          事件标准化和去重
                  ↓
          Token / Pair / Wallet
          关联与时间窗口聚合
                  ↓
       安全检查 + Smart Money 验证
                  ↓
        热度分数、信心分数、风险分数
                  ↓
        Telegram 告警 + Web 仪表盘
                  ↓
        原始事件、评分和告警持久化

所有事件必须保留 source、source_event_id、received_at、observed_at 和原始 payload 摘要，便于之后解释“为什么报警”。

## 5. Binance Square 监控方案

### 5.1 统一接口

Square 适配器输出：

- post_id；
- author_id、author_name、author_reputation；
- published_at、received_at；
- text、media、quoted_post；
- like_count、comment_count、share_count；
- token_symbols；
- contract_addresses；
- chain_mentions；
- source_url；
- raw_payload_hash。

同一帖子以 post_id 去重；编辑内容以 post_id + edit/version 去重。

### 5.2 数据源优先级

1. 如果用户可提供 Binance 官方或授权读取权限，使用官方读取接口；
2. 否则接入可审计的第三方实时 feed，并在每条记录上标记 provider；
3. 最后才考虑不登录的公开页面轮询，仅作为低可靠补偿；
4. 不使用登录 Cookie，不绕过验证，不把前端私有接口当成稳定生产 API。

第三方监控服务不是 Binance 官方服务，必须单独配置、记录延迟和断流状态。示例：
https://binance.1322.io/

### 5.3 Square 热度

Square 帖子只产生“社交候选”，需要同时满足以下至少一项链上确认：

- DBot/Birdeye 交易量或买入人数显著上升；
- Binance Smart Money/KOL 地址实际买入；
- 流动性满足最低门槛且未出现快速撤 LP；
- Binance token audit 未触发高风险；
- X 或另一独立社交来源同步升温。

## 6. 聪明钱地址获取与管理

### 6.1 地址种子

地址池来源分为四类：

1. Binance leaderboard：按链、7d/30d、ALL/KOL 读取排行榜；
2. Binance wallet tracker：读取公共 Smart Money/KOL 交易流；
3. Token-based discovery：对同一代币买入者做地址交集和共识统计；
4. 外部标签：Nansen、Arkham、Cielo、Moni、DBot/Birdeye 作为补充证据。

第一批只读查询示例：

    baw leaderboard query -c 56 -p 7d -t ALL --json
    baw leaderboard query -c CT_501 -p 7d -t ALL --json
    baw leaderboard query -c 1 -p 7d -t ALL --json
    baw leaderboard query -c 8453 -p 7d -t ALL --json

    baw tracker token query -c 56 --tag-type smy --json
    baw tracker tx query -c 56 --tag-type smy --json

不会自动执行 tracker address add、batch 或 follow。第一阶段先在本地维护地址池，避免未审查的地址进入 Binance 跟踪列表。

### 6.2 地址质量

地址必须经过滚动窗口评估，而不是使用一次性收益排名。评估维度：

- 胜率；
- 实现收益；
- 收益稳定性；
- 最大回撤；
- 交易频率和持仓持续时间；
- 是否反复提前买入新热点；
- 是否存在 bot-like、wash-trade、套利或协议地址特征；
- 是否能在第二个独立数据源中观察到相同活动。

Binance leaderboard skill 提供六维地址分析和 AI 行为标签；系统会保留供应商评分，同时计算自己的观察评分，不把供应商标签直接视为事实。

### 6.3 地址状态

地址状态分为：

- candidate：刚发现，证据不足；
- observed：已观察到足够交易；
- qualified：跨窗口和跨来源通过；
- muted：机器人、协议、CEX、做市或行为异常；
- stale：超过配置周期没有新活动；
- rejected：明确不纳入告警。

每个地址必须记录发现来源、证据链接、首次/最近活动和评分版本。

## 7. 代币和告警评分

系统维护五个独立分数：

- chain_activity：链上活跃度；
- social_heat：X 和 Square 社交热度；
- smart_money：高质量地址的净买入和共识；
- safety：合约、持仓、LP 和交易限制风险；
- lp_risk：撤 LP、流动性下降和价格冲击风险。

默认只触发两类告警：

### 热门候选告警

满足：

- chain_activity 和 social_heat 至少一项达到阈值；
- 至少一个独立链上来源确认；
- smart_money 或多钱包共识出现；
- safety 不低于最低阈值；
- 最近没有严重 LP 风险事件。

### 风险告警

任一项即可触发：

- LP 快速撤出；
- 流动性低于代币自身历史基线；
- 大额持仓集中度明显上升；
- 高风险 token audit；
- 买入快速增加但卖出受限或交易异常；
- Smart Money 集中卖出；
- 社交热度上升但链上没有成交和地址增长。

分数、阈值和窗口全部配置化，第一版不会把阈值硬编码成交易规则。

## 8. Binance USDⓈ-M 合约-only 监控

### 8.1 合约池构建

系统不把 HEI、BANK 写死为唯一观察对象，而是把它们作为测试和初始观察样本。合约池由 Binance Futures exchangeInfo 动态生成：

1. 保留 status=TRADING、contractType=PERPETUAL、quoteAsset=USDT 的 USDⓈ-M 合约；
2. 读取 Binance Spot exchangeInfo，建立当前可交易的 spot baseAsset 集合；
3. 以 futures baseAsset 与 spot baseAsset 做交集；
4. futures 有交易、spot 没有对应可交易 baseAsset 的标记为 contract_only；
5. 合约下架、交割、暂停或刚上线的状态全部保留，不用历史数据假装当前可交易。

contract_only 不是投资优势，而是“缺少现货确认”的风险标签。它们更容易受到杠杆、薄盘口、爆仓和做市活动影响，因此需要更严格的流动性和历史基线条件。

### 8.2 数据输入

每个候选合约接入：

- Kline WebSocket：5m、15m；实时接收当前柱，只有收盘字段为 true 时才生成主信号；
- Kline REST：断线补偿和启动回填；
- Open Interest Statistics：5m、15m 的 sumOpenInterest 和 sumOpenInterestValue；
- Open Interest：需要时读取当前 OI，辅助观察未收盘柱；
- Taker Buy/Sell Volume：buyVol、sellVol、buySellRatio；
- Mark Price 和 funding rate：判断持仓成本和价格偏离；
- Top Trader Long/Short Ratio：只作为参与者结构背景，不作为净多净空的直接证明；
- Liquidation stream 或历史爆仓数据：识别挤空、长多清算和异常波动；
- ExchangeInfo：合约状态、上线时间、精度、最小名义价值和 quote asset。

公开合约行情和 OI 使用公开市场数据接口，不配置交易权限。若未来需要读取用户自己的合约仓位，另行配置只读 USER_DATA 权限，禁止 TRADE 权限。

### 8.3 核心指标

对每个合约、每个时间周期分别计算：

- volume_ratio = 当前 quote volume / 前 20 根已收盘同周期 K 线的中位数；
- volume_percentile = 当前成交量在最近 30 天同周期成交量中的分位数；
- oi_value_delta = 当前 sumOpenInterestValue / 上一根同周期值 - 1；
- oi_unit_delta = 当前 sumOpenInterest / 上一根同周期值 - 1；
- price_return = 收盘价 / 开盘价 - 1；
- taker_imbalance = (buyVol - sellVol) / (buyVol + sellVol)；
- price_oi_alignment = price_return 与 oi_value_delta 的方向关系；
- liquidation_ratio = 当前爆仓额 / 最近同周期成交额；
- contract_only_risk = 没有现货确认、合约年龄、盘口深度、OI/成交额和流动性综合风险。

优先使用 sumOpenInterestValue，而不是只看合约数量 OI，因为币价变化会影响名义持仓价值。OI 表示未平仓合约总量，增加 OI 同时意味着多空双方都增加了仓位，不能直接解释成“多头在买入”。

### 8.4 5m/15m 结构判定

| 价格 | OI | 成交量 | 初步解释 | 处理 |
|---|---|---|---|---|
| 上涨 | 上升 | 放大 | 新仓推动的上行候选 | 等待主动买量和第二根 K 线确认 |
| 下跌 | 上升 | 放大 | 新仓推动的下行候选 | 关注主动卖量和空头拥挤 |
| 上涨 | 下降 | 放大 | 空头回补或挤空 | 不等同于新多入场 |
| 下跌 | 下降 | 放大 | 多头平仓/清算 | 触发风险和去杠杆观察 |
| 横盘 | 上升 | 放大 | 杠杆堆积、方向未定 | 不发方向性热门告警 |
| 任意 | 基本不变 | 放大 | 换手或短线噪声 | 需要社交或链上独立确认 |

### 8.5 默认告警条件

初始参数只作为可回测的默认值，不是交易规则：

- 5m 放量增仓：volume_ratio ≥ 2.0 且绝对 oi_value_delta ≥ 5%；
- 15m 放量增仓：volume_ratio ≥ 1.5 且绝对 oi_value_delta ≥ 8%；
- contract_only 还必须满足合约最低流动性、最小 OI 名义价值和至少 20 根历史基线；
- 方向性告警还要结合价格方向和 taker_imbalance；
- 若出现大额爆仓、盘口过薄或资金费率异常，只发风险告警，不发热门方向告警；
- 同一合约在 5m 与 15m 方向一致时，提升信心；方向相反时标记为冲突。

默认值上线后用历史数据回测校准，系统同时保存原始值、标准化分位数和阈值版本。

### 8.6 合约告警类型

- FUTURES_CONTRACT_ONLY_DISCOVERED：发现只有合约、没有 Binance 现货对应交易对的标的；
- FUTURES_VOLUME_OI_SURGE：5m/15m 同时放量和 OI 放大；
- FUTURES_LONG_BUILDUP_CANDIDATE：价格上涨、OI 上升、主动买量占优；
- FUTURES_SHORT_BUILDUP_CANDIDATE：价格下跌、OI 上升、主动卖量占优；
- FUTURES_SHORT_COVERING：价格上涨、OI 下降并伴随爆仓/主动买量；
- FUTURES_LONG_LIQUIDATION：价格下跌、OI 下降并伴随爆仓/主动卖量；
- FUTURES_OI_CONFLICT：5m 和 15m 结构方向冲突；
- FUTURES_CONTRACT_ONLY_RISK：无现货确认、薄流动性或杠杆风险上升。

合约信号不会替代链上和社交验证。对于热门代币告警，合约-only 只能作为衍生品证据，必须和 Binance Square/X、DBot/Birdeye 或 Smart Money 证据组合。

## 9. 存储设计

推荐生产使用 PostgreSQL，开发和单机演示允许 SQLite。

核心表：

- sources：数据源、能力、套餐、健康状态；
- source_events：原始事件摘要、去重键、接收时间；
- tokens：链、合约地址、符号、名称、风险状态；
- pairs：交易对、DEX、创建时间、当前流动性；
- token_metrics：1m/5m/15m/1h/6h/24h 聚合指标；
- futures_contracts：合约状态、现货交集状态、上线时间和风险标签；
- futures_candles：5m/15m K 线和收盘状态；
- futures_oi_snapshots：sumOpenInterest、sumOpenInterestValue 和时间戳；
- futures_flow_metrics：成交量比、OI 变化、主动买卖量、资金费率和爆仓指标；
- futures_signals：合约结构信号、阈值版本、解释和证据；
- social_posts：X/Square 帖子和提及；
- wallets：地址、链、标签、来源、状态；
- wallet_observations：地址在代币上的买卖、持仓和收益；
- lp_events：加 LP、撤 LP、LP 头寸、范围变化；
- signals：原子信号及证据；
- alerts：已发送告警、去重键、发送状态；
- connector_checkpoints：WebSocket 重连和轮询游标；
- audit_log：配置、人工确认和预览操作。

钱包地址必须按 chain + address 作为唯一键，不能假设 EVM 地址和 Solana 地址可以互换。

## 10. 7×24 稳定性

每个连接器都要实现：

- 心跳和 pong；
- 指数退避重连；
- 断线期间的 REST 补偿；
- source checkpoint；
- 幂等写入；
- 速率限制；
- provider error 分类；
- 断流告警；
- 进程重启后恢复未处理事件。

WebSocket 事件不能只存在内存里。收到事件后先写入 source_events，再异步计算评分和发送告警。

Telegram 告警必须具备：

- alert_id；
- token、chain、contract；
- 触发时间；
- 分数；
- 触发证据；
- 各数据源时间戳；
- 风险项；
- DBot、Binance、DEX Screener、区块浏览器链接；
- “仅观察/不构成交易指令”标记。

## 11. 本地 Web 仪表盘

第一版页面：

1. Hot Tokens：按链、热度、聪明钱确认和风险排序；
2. Social Pulse：X/Square 帖子、作者、互动增速和代币关联；
3. Smart Money：地址排名、最近买卖、共识代币和地址状态；
4. Token Detail：价格、交易量、流动性、持仓、审计和社交证据；
5. LP Monitor：LP 增减、流动性曲线、用户 LP 头寸和范围；
6. Alerts：告警时间线、已确认/忽略状态；
7. Source Health：各 API、WebSocket、延迟和断流情况。
8. Futures Radar：contract_only 合约、5m/15m K 线、OI、成交量、主动买卖量、资金费率和清算背景。

## 12. LP 管理边界

第一阶段仅允许：

- 读取用户 LP 头寸；
- 读取价格范围、是否 out-of-range 和奖励；
- 监控新增/撤出 LP；
- 计算流动性风险；
- 生成 deposit、redeem、lp-add、lp-remove、claim 的预览。

任何真实 LP 操作必须：

1. 先生成 preview；
2. 展示代币、数量、滑点、费用、池子、范围和预计结果；
3. 获得用户明确确认；
4. 执行后重新读取链上状态；
5. 记录 audit_log。

系统不会自行执行 LP 操作。

## 13. 分阶段交付

### Phase 0：配置和安全

- 配置密钥注入方式；
- 建立 PostgreSQL/SQLite schema；
- 建立 source health 和日志；
- 不配置交易权限，不登录钱包。

### Phase 1：只读核心链路

- X Filtered Stream；
- Binance Square adapter；
- DBot REST/WebSocket；
- Binance leaderboard/tracker/token audit；
- Binance Futures contract-only radar；
- Telegram 告警；
- Hot Tokens 和 Alerts 页面。

### Phase 2：聪明钱地址池

- 多链排行榜采集；
- 地址质量评分；
- Token-based buyer intersection；
- 地址状态、静音和过期机制；
- Smart Money 页面。

### Phase 3：多链补强和 LP 监控

- Birdeye WebSocket；
- DEX Screener enrichment；
- LP add/remove 事件；
- 用户 LP position read-only；
- LP 风险页面。

### Phase 4：高级情报

按预算选择 Nansen、Arkham、Cielo、Moni、Dune、DefiLlama、CoinGlass、Token Terminal 等，不影响核心系统运行。

### Phase 5：人工确认工作流

- 人工确认按钮；
- 生成 DeFi preview；
- 预览结果持久化；
- 仍不启用自动交易或自动 LP。

## 14. 验收标准

设计实现后至少满足：

- 连接器断线后可以自动重连并补偿；
- 同一帖子、交易和告警不会重复；
- 同一代币按 chain + contract 正确归一化；
- Square、X、DBot、Binance 的证据可以在代币详情页同时查看；
- 至少两类独立证据才生成热门候选；
- Smart Money 地址有来源、评分、最近行为和异常标记；
- LP 撤出和流动性骤降能生成风险告警；
- 无钱包私钥、API Secret 或交易权限进入日志和前端；
- 没有任何未经人工确认的交易或 LP 状态改变；
- Robinhood Chain 未有可靠数据源时，系统明确标记为 degraded，不伪造覆盖率。
- contract_only 合约能自动由 Futures/Spot exchangeInfo 交集生成，不依赖 HEI/BANK 硬编码；
- 5m/15m K 线使用收盘数据，OI 使用同周期历史数据并处理断线补偿；
- 能区分价格上涨+OI上升、价格上涨+OI下降、价格下跌+OI上升、价格下跌+OI下降；
- OI 增加不会被直接标记为多头增加，必须结合主动买卖量、价格和清算背景；
- 合约-only 放量增仓告警包含成交量比、OI变化、价格方向和无现货确认风险。

## 15. 待确认配置

以下配置不影响设计成立，但进入实施前需要确定：

1. Binance Square 是否接受第三方 feed 作为备用；
2. 是否提供 X API Bearer Token；
3. 是否提供 DBot API Key；
4. 是否购买 Birdeye Business WebSocket；
5. Telegram Bot 和目标 Chat ID；
6. PostgreSQL 运行位置；
7. Robinhood Chain 使用的具体数据供应商；
8. 是否允许 Nansen/Cielo/Moni 作为付费增强源。
9. Binance Futures 是否优先只监控 USDⓈ-M USDT 永续合约，或同时加入 COIN-M/交割合约；
10. 5m/15m 合约告警默认阈值是否先按设计值运行并通过历史数据回测校准。

## 16. 明确不做

- 不使用 Twitter/X 网页 Cookie 伪装 API；
- 不使用 Binance Square 登录 Cookie 作为生产凭据；
- 不把 GMGN 或 AxiomExchange 当成未经确认的后端 API；
- 不根据单一帖子、单一钱包或单一平台标签自动买入；
- 不自动跟单；
- 不自动交易；
- 不自动加 LP、撤 LP 或领取奖励；
- 不把“牛市回来了”作为事实，而是作为待验证的市场假设。
- 不把 OI 增加直接解释成多头增加；
- 不把合约-only 代币的价格上涨当作现货资金确认；
- 不用未收盘的 5m/15m K 线触发不可逆操作。
