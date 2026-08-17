import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Interval = "5m" | "15m";
type Section = "contract" | "onchain" | "settings" | "records";
type FactorSeverity = "HIGH" | "WARNING" | "INFO";

type OiFactor = {
  code: string;
  label: string;
  severity: FactorSeverity;
  detail: string;
  value?: number;
};

type OiSignal = {
  signalType: string;
  severity: FactorSeverity;
  confidence: number;
  explanation: string;
  evidence: string[];
  thresholdVersion: string;
  candleOpenTime: number;
};

type OiRow = {
  rank: number;
  symbol: string;
  interval: Interval;
  candleOpenTime: number;
  isContractOnly: boolean;
  contractOnlyReason: string;
  dataCompleteness: string;
  priceReturn: number;
  priceReturn5m: number;
  volumeRatio: number;
  oiValueDelta: number;
  oiUnitDelta: number;
  takerImbalance: number;
  priceOiAlignment: string;
  anomalyScore: number;
  ambushScore?: number;
  marketCapM?: number;
  factors: OiFactor[];
  signals: OiSignal[];
};

type HealthResponse = {
  status: "ok" | "degraded";
  connectors?: Record<string, { status: "connected" | "degraded" | "disconnected"; message?: string; updatedAt?: number }>;
};

type ScoreType = "launch" | "ambush";

type LeaderboardResponse = {
  interval: Interval;
  scoreType?: ScoreType;
  generatedAt: number;
  items: OiRow[];
};

type TakeProfitLevel = {
  pricePercent: number;
  closeRatio: number;
};

type BreakoutHoldSettings = {
  stopLossPercent: number;
  maxHoldMinutes: number;
  takeProfitLevels: TakeProfitLevel[];
};

type AmbushSettings = {
  enabled: boolean;
  minShortFuelScore: number;
  minScore: number;
  maxMarketCapM: number;
};

type ExecutionSettings = {
  leverage: number;
  notionalUsdt: number;
  minOiBurstDelta: number;
  maxOpenPositions: number;
  takeProfitLevels: TakeProfitLevel[];
  stopLossPercent: number;
  breakevenPercent: number;
  maxHoldMinutes: number;
  reversalExitEnabled: boolean;
  circuitBreakerAutoReset: boolean;
  breakoutHold: BreakoutHoldSettings;
  ambush: AmbushSettings;
  updatedAt?: number;
};

type OpenableItem = {
  symbol: string;
  marketCapM?: number;
  anomalyScore: number;
  ambushScore?: number;
  mode: "STANDARD" | "AMBUSH";
  dataCompleteness: string;
  reasons: string[];
};

type OpenableResponse = {
  interval: Interval;
  items: OpenableItem[];
  generatedAt: number;
};

type ExecutionRecord = {
  symbol: string;
  status: "OPEN" | "CLOSED";
  openCount: number;
  closeCount: number;
  entryPrice: number;
  initialQuantity: number;
  remainingQuantity: number;
  marginUsdt: number;
  leverage: number;
  notionalUsdt: number;
  stopPrice: number;
  takeProfitLevelReached: number;
  openedAt: number;
  closedAt: number | null;
  updatedAt: number;
  pnl?: {
    realizedPnl: number;
    unrealizedPnl: number;
    totalPnl: number;
    commission: number;
    fundingFee: number;
    netPnl: number;
    fundingPeriods: number;
  };
};

type ExecutionEvent = {
  type: string;
  symbol?: string;
  reasonCode?: string;
  at: number;
  details?: Record<string, unknown>;
};

type RecordsResponse = {
  items: ExecutionRecord[];
};

type RecordDetailResponse = {
  item: ExecutionRecord;
  events: ExecutionEvent[];
};

const factorLabel: Record<string, string> = {
  OI_DIRECTION: "OI方向",
  OI_THRESHOLD_BREAK: "OI阈值突破",
  VOLUME_EXPANSION: "成交量放大",
  PRICE_5M_EXPANSION: "5分钟爆发",
  PRICE_OI_ALIGNMENT: "价格-OI结构",
  TAKER_CONFIRMATION: "主动成交确认",
  CONTRACT_ONLY_RISK: "仅合约风险",
  DATA_INCOMPLETE: "数据不完整",
  SHORT_FUEL: "空头燃料",
};

function formatPercent(value: number | undefined, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

function formatScore(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value)}` : "—";
}

function formatMarketCap(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}M`;
}

function timeAgo(timestamp: number): string {
  if (!timestamp) return "暂无";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

function timeText(timestamp: number): string {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function displaySymbol(symbol: string): string {
  return symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
}

function statusTone(status: string): "good" | "warn" | "bad" {
  return status === "connected" || status === "ok" ? "good" : status === "degraded" ? "warn" : "bad";
}

function Icon({ name }: { name: "chain" | "contract" | "refresh" | "close" | "pulse" | "chevron" | "gear" | "history" }) {
  const paths = {
    chain: <><path d="m10 13 4-4" /><path d="M7.5 16.5 6 18a3.18 3.18 0 0 1-4.5-4.5l3-3a3.18 3.18 0 0 1 4.5 0" /><path d="m16.5 7.5 1.5-1.5a3.18 3.18 0 0 1 4.5 4.5l-3 3a3.18 3.18 0 0 1-4.5 0" /></>,
    contract: <><path d="M4 5h16v14H4z" /><path d="M8 9h8M8 13h5M8 17h3" /></>,
    refresh: <><path d="M20 11a8 8 0 0 0-14.8-4L3 10" /><path d="M3 4v6h6" /><path d="M4 13a8 8 0 0 0 14.8 4L21 14" /><path d="M21 20v-6h-6" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    pulse: <><path d="M3 12h4l2-7 4 14 2-7h6" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    gear: <><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></>,
    history: <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></>,
  }[name];

  return <svg aria-hidden="true" className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths}</svg>;
}

function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot ${statusTone(status)}`} />;
}

function FactorChip({ factor }: { factor: OiFactor }) {
  return <span className={`factor-chip factor-${factor.severity.toLowerCase()}`} title={factor.detail}>{factor.label}</span>;
}

function EmptyState({ message }: { message: string }) {
  return <div className="empty-state"><Icon name="pulse" /><span>{message}</span></div>;
}

function DetailPanel({ row, onClose }: { row: OiRow | null; onClose: () => void }) {
  if (!row) {
    return <aside className="detail-panel panel detail-empty"><EmptyState message="点击排行榜中的标的查看触发因子" /></aside>;
  }

  return <aside className="detail-panel panel" aria-label={`${row.symbol} 异动详情`}>
    <div className="detail-heading">
      <div><span className="eyebrow">合约异动详情</span><h2>{displaySymbol(row.symbol)}USDT 永续</h2><p>Binance · USDT 保证金 · {row.interval} 窗口</p></div>
      <button type="button" className="icon-button" aria-label="关闭详情" onClick={onClose}><Icon name="close" /></button>
    </div>
    <div className="detail-meta"><span>{timeText(row.candleOpenTime)}</span><span className={`quality quality-${row.dataCompleteness === "COMPLETE" ? "good" : "warn"}`}>{row.dataCompleteness === "COMPLETE" ? "数据完整" : "数据不完整"}</span></div>
    <section className="detail-section"><div className="section-label">触发因子 <span>{row.factors.length}</span></div><div className="factor-cloud">{row.factors.length ? row.factors.map((factor) => <FactorChip key={`${factor.code}-${factor.label}`} factor={factor} />) : <span className="muted">未达到已配置因子阈值</span>}</div></section>
    <section className="detail-section"><div className="section-label">原始证据 <span>{row.interval}</span></div><div className="evidence-list">
      <div><span>OI 变化</span><strong className={row.oiValueDelta >= 0 ? "positive" : "negative"}>{formatPercent(row.oiValueDelta)}</strong></div>
      <div><span>价格变化</span><strong className={row.priceReturn >= 0 ? "positive" : "negative"}>{formatPercent(row.priceReturn)}</strong></div>
      {row.interval === "5m" && <div><span>5分钟涨幅因子</span><strong className={row.priceReturn5m >= 0 ? "positive" : "negative"}>{formatPercent(row.priceReturn5m)}</strong></div>}
      <div><span>成交量比</span><strong>{row.volumeRatio.toFixed(2)}x</strong></div>
      <div><span>主动成交失衡</span><strong>{formatPercent(row.takerImbalance)}</strong></div>
      <div><span>价格-OI结构</span><strong>{row.priceOiAlignment.replaceAll("_", " ")}</strong></div>
      <div><span>异常评分</span><strong className="score-value">{formatScore(row.anomalyScore)} / 100</strong></div>
    </div></section>
    <section className="detail-section"><div className="section-label">因子说明</div><div className="factor-explanations">{row.factors.map((factor) => <div className="factor-explanation" key={`${factor.code}-detail`}><FactorChip factor={factor} /><p>{factor.detail}</p></div>)}</div></section>
    {row.signals.length > 0 && <section className="detail-section"><div className="section-label">已生成信号</div>{row.signals.map((signal) => <div className="signal-note" key={`${signal.signalType}-${signal.thresholdVersion}`}><strong>{signal.signalType}</strong><span>{signal.explanation}</span><small>{signal.evidence.join(" · ")}</small></div>)}</section>}
  </aside>;
}

type DraftLevel = { pricePercent: string; closeRatio: string };

type DraftBreakoutHold = {
  stopLossPercent: string;
  maxHoldMinutes: string;
  takeProfitLevels: DraftLevel[];
};

type DraftSettings = {
  leverage: string;
  notionalUsdt: string;
  minOiBurstDelta: string;
  maxOpenPositions: string;
  takeProfitLevels: DraftLevel[];
  stopLossPercent: string;
  breakevenPercent: string;
  maxHoldMinutes: string;
  reversalExitEnabled: boolean;
  circuitBreakerAutoReset: boolean;
  breakoutHold: DraftBreakoutHold;
  ambushEnabled: boolean;
  ambushMinShortFuelScore: string;
  ambushMinScore: string;
  ambushMaxMarketCapM: string;
};

const emptyDraft: DraftSettings = {
  leverage: "5",
  notionalUsdt: "500",
  minOiBurstDelta: "0.05",
  maxOpenPositions: "3",
  takeProfitLevels: [
    { pricePercent: "8", closeRatio: "0.333" },
    { pricePercent: "15", closeRatio: "0.333" },
    { pricePercent: "25", closeRatio: "1" },
  ],
  stopLossPercent: "8",
  breakevenPercent: "0.1",
  maxHoldMinutes: "120",
  reversalExitEnabled: true,
  circuitBreakerAutoReset: true,
  breakoutHold: {
    stopLossPercent: "12",
    maxHoldMinutes: "720",
    takeProfitLevels: [
      { pricePercent: "30", closeRatio: "0.333" },
      { pricePercent: "60", closeRatio: "0.333" },
      { pricePercent: "120", closeRatio: "1" },
    ],
  },
  ambushEnabled: true,
  ambushMinShortFuelScore: "10",
  ambushMinScore: "15",
  ambushMaxMarketCapM: "20",
};

function toDraft(settings: ExecutionSettings): DraftSettings {
  return {
    leverage: String(settings.leverage),
    notionalUsdt: String(settings.notionalUsdt),
    minOiBurstDelta: String(settings.minOiBurstDelta),
    maxOpenPositions: String(settings.maxOpenPositions),
    takeProfitLevels: settings.takeProfitLevels.map((level) => ({
      pricePercent: String(level.pricePercent),
      closeRatio: String(level.closeRatio),
    })),
    stopLossPercent: String(settings.stopLossPercent),
    breakevenPercent: String(settings.breakevenPercent),
    maxHoldMinutes: String(settings.maxHoldMinutes),
    reversalExitEnabled: settings.reversalExitEnabled,
    circuitBreakerAutoReset: settings.circuitBreakerAutoReset,
    breakoutHold: {
      stopLossPercent: String(settings.breakoutHold.stopLossPercent),
      maxHoldMinutes: String(settings.breakoutHold.maxHoldMinutes),
      takeProfitLevels: settings.breakoutHold.takeProfitLevels.map((level) => ({
        pricePercent: String(level.pricePercent),
        closeRatio: String(level.closeRatio),
      })),
    },
    ambushEnabled: settings.ambush.enabled,
    ambushMinShortFuelScore: String(settings.ambush.minShortFuelScore),
    ambushMinScore: String(settings.ambush.minScore),
    ambushMaxMarketCapM: String(settings.ambush.maxMarketCapM),
  };
}

function fromDraft(draft: DraftSettings): ExecutionSettings {
  return {
    leverage: Number(draft.leverage),
    notionalUsdt: Number(draft.notionalUsdt),
    minOiBurstDelta: Number(draft.minOiBurstDelta),
    maxOpenPositions: Number(draft.maxOpenPositions),
    takeProfitLevels: draft.takeProfitLevels.map((level) => ({
      pricePercent: Number(level.pricePercent),
      closeRatio: Number(level.closeRatio),
    })),
    stopLossPercent: Number(draft.stopLossPercent),
    breakevenPercent: Number(draft.breakevenPercent),
    maxHoldMinutes: Number(draft.maxHoldMinutes),
    reversalExitEnabled: draft.reversalExitEnabled,
    circuitBreakerAutoReset: draft.circuitBreakerAutoReset,
    breakoutHold: {
      stopLossPercent: Number(draft.breakoutHold.stopLossPercent),
      maxHoldMinutes: Number(draft.breakoutHold.maxHoldMinutes),
      takeProfitLevels: draft.breakoutHold.takeProfitLevels.map((level) => ({
        pricePercent: Number(level.pricePercent),
        closeRatio: Number(level.closeRatio),
      })),
    },
    ambush: {
      enabled: draft.ambushEnabled,
      minShortFuelScore: Number(draft.ambushMinShortFuelScore),
      minScore: Number(draft.ambushMinScore),
      maxMarketCapM: Number(draft.ambushMaxMarketCapM),
    },
  };
}

function NumberField({ label, value, onChange, hint, step }: { label: string; value: string; onChange: (value: string) => void; hint?: string; step?: string }) {
  return <label className="field"><span>{label}</span><input type="number" step={step ?? "any"} min="0" value={value} onChange={(event) => onChange(event.target.value)} />{hint && <small>{hint}</small>}</label>;
}

function ToggleField({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string }) {
  return <label className="field toggle-field"><span className="toggle-label"><strong>{label}</strong>{hint && <small>{hint}</small>}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>;
}

function SettingsPanel() {
  const [draft, setDraft] = useState<DraftSettings>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/settings");
      if (!response.ok) throw new Error("设置读取失败");
      const body = await response.json() as { settings: ExecutionSettings; updatedAt?: number };
      setDraft(toDraft(body.settings));
      if (body.updatedAt) setSavedAt(body.updatedAt);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取执行设置");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const saveSettings = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fromDraft(draft)),
      });
      const body = await response.json() as { settings?: ExecutionSettings; updatedAt?: number; message?: string };
      if (!response.ok || !body.settings) {
        throw new Error(body.message ?? "设置保存失败");
      }
      setDraft(toDraft(body.settings));
      setSavedAt(body.updatedAt ?? Date.now());
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "设置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const updateLevel = (index: number, patch: Partial<DraftLevel>) => {
    setDraft((current) => ({
      ...current,
      takeProfitLevels: current.takeProfitLevels.map((level, levelIndex) => (levelIndex === index ? { ...level, ...patch } : level)),
    }));
  };

  const updateBreakoutLevel = (index: number, patch: Partial<DraftLevel>) => {
    setDraft((current) => ({
      ...current,
      breakoutHold: {
        ...current.breakoutHold,
        takeProfitLevels: current.breakoutHold.takeProfitLevels.map((level, levelIndex) => (levelIndex === index ? { ...level, ...patch } : level)),
      },
    }));
  };

  const addBreakoutLevel = () => {
    setDraft((current) => {
      if (current.breakoutHold.takeProfitLevels.length >= 5) return current;
      const last = current.breakoutHold.takeProfitLevels[current.breakoutHold.takeProfitLevels.length - 1];
      return {
        ...current,
        breakoutHold: {
          ...current.breakoutHold,
          takeProfitLevels: [...current.breakoutHold.takeProfitLevels, { pricePercent: String((Number(last?.pricePercent ?? 15) + 15)), closeRatio: "1" }],
        },
      };
    });
  };

  const removeBreakoutLevel = (index: number) => {
    setDraft((current) => ({
      ...current,
      breakoutHold: {
        ...current.breakoutHold,
        takeProfitLevels: current.breakoutHold.takeProfitLevels.filter((_level, levelIndex) => levelIndex !== index),
      },
    }));
  };

  const addLevel = () => {
    setDraft((current) => {
      if (current.takeProfitLevels.length >= 5) return current;
      const last = current.takeProfitLevels[current.takeProfitLevels.length - 1];
      return {
        ...current,
        takeProfitLevels: [...current.takeProfitLevels, { pricePercent: String((Number(last?.pricePercent ?? 8) + 10)), closeRatio: "1" }],
      };
    });
  };

  const removeLevel = (index: number) => {
    setDraft((current) => ({
      ...current,
      takeProfitLevels: current.takeProfitLevels.filter((_level, levelIndex) => levelIndex !== index),
    }));
  };

  return <main className="main-content settings-main">
    <section className="page-heading"><div><span className="eyebrow">执行策略 · 即时生效</span><h1>执行设置</h1><p>杠杆、开仓金额与评分门槛在保存后即时生效；止盈分级与兜底保护作用于新开仓及现有持仓的后续检查。</p></div><div className="freshness">{savedAt > 0 && <span className="saved-note">上次保存 {timeText(savedAt)}</span>}</div></section>

    {error && <div className="error-banner"><span>{error}</span></div>}

    {loading ? <section className="panel settings-panel"><div className="empty-state"><Icon name="pulse" /><span>正在加载执行设置…</span></div></section> : <>
      <section className="panel settings-panel">
        <div className="settings-group"><div className="settings-group-title"><span className="eyebrow">启动开单配置（STANDARD）</span><h2>OI 爆发启动的标的：OI 变化达爆发阈值 + 放量增仓信号才开单</h2><p className="settings-note">启动评分以 OI 变化为主要依据；开单主门槛是 OI 爆发阈值，评分仅作异动强度参考。</p></div>
          <div className="settings-grid">
            <NumberField label="杠杆倍数" value={draft.leverage} hint="1-125 倍" onChange={(value) => setDraft({ ...draft, leverage: value })} />
            <NumberField label="开仓金额（USDT）" value={draft.notionalUsdt} hint="每笔名义本金" onChange={(value) => setDraft({ ...draft, notionalUsdt: value })} />
            <NumberField label="OI 爆发阈值（%）" value={draft.minOiBurstDelta} hint="STANDARD 放量确认开单主门槛，如 0.05 = OI 变化 5%" step="0.01" onChange={(value) => setDraft({ ...draft, minOiBurstDelta: value })} />
            <NumberField label="最大持仓数" value={draft.maxOpenPositions} hint="同时持仓上限" step="1" onChange={(value) => setDraft({ ...draft, maxOpenPositions: value })} />
          </div>
        </div>
      </section>

      <section className="panel settings-panel">
        <div className="settings-group"><div className="settings-group-title"><span className="eyebrow">分级止盈</span><h2>按涨幅逐级止盈，每级触发后上移止损</h2></div>
          <div className="tp-levels">
            {draft.takeProfitLevels.map((level, index) => <div className="tp-level-row" key={`level-${index}`}>
              <span className="tp-level-index">第 {index + 1} 级</span>
              <label className="field"><span>触发涨幅（%）</span><input type="number" step="any" min="0" value={level.pricePercent} onChange={(event) => updateLevel(index, { pricePercent: event.target.value })} /></label>
              <label className="field"><span>平仓比例（0-1）</span><input type="number" step="any" min="0" max="1" value={level.closeRatio} onChange={(event) => updateLevel(index, { closeRatio: event.target.value })} /></label>
              <button type="button" className="icon-button" aria-label={`删除第 ${index + 1} 级止盈`} onClick={() => removeLevel(index)} disabled={draft.takeProfitLevels.length <= 1}><Icon name="close" /></button>
            </div>)}
          </div>
          <div className="tp-actions"><button type="button" className="filter-button" onClick={addLevel} disabled={draft.takeProfitLevels.length >= 5}>添加止盈级别</button><small>最多 5 级；级别按涨幅升序排列，末级平仓比例必须为 1（清仓）</small></div>
        </div>
      </section>

      <section className="panel settings-panel">
        <div className="settings-group"><div className="settings-group-title"><span className="eyebrow">兜底保护</span><h2>风险兜底与熔断行为</h2></div>
          <div className="settings-grid">
            <NumberField label="止损率（%）" value={draft.stopLossPercent} hint="如 8 表示 -8% 触发止损" onChange={(value) => setDraft({ ...draft, stopLossPercent: value })} />
            <NumberField label="保本上移（%）" value={draft.breakevenPercent} hint="第一级止盈后止损抬至 +x%" onChange={(value) => setDraft({ ...draft, breakevenPercent: value })} />
            <NumberField label="时间兜底（分钟）" value={draft.maxHoldMinutes} hint="0=关闭；超时未达第一级止盈则平仓" step="1" onChange={(value) => setDraft({ ...draft, maxHoldMinutes: value })} />
          </div>
          <div className="settings-grid toggles">
            <ToggleField label="5m 反转退出" hint="价格-OI 结构反转时平仓" checked={draft.reversalExitEnabled} onChange={(checked) => setDraft({ ...draft, reversalExitEnabled: checked })} />
            <ToggleField label="熔断自动复位" hint="数据流恢复后自动解除熔断" checked={draft.circuitBreakerAutoReset} onChange={(checked) => setDraft({ ...draft, circuitBreakerAutoReset: checked })} />
          </div>
        </div>
      </section>

      <section className="panel settings-panel">
        <div className="settings-group"><div className="settings-group-title"><span className="eyebrow">低位启动持仓参数</span><h2>长期横盘后放量突破的标的，用更大的想象力持仓</h2><p className="settings-note">底部启动的庄币可能涨 3-10 倍：止损放宽到 -12%、时间兜底 12 小时、止盈放到 +30%/+60%/+120%，让利润跑完主升段。仅当信号判定为“低位启动”时生效。</p></div>
          <div className="settings-grid">
            <NumberField label="宽松止损率（%）" value={draft.breakoutHold.stopLossPercent} hint="如 10 表示 -10% 触发止损" onChange={(value) => setDraft({ ...draft, breakoutHold: { ...draft.breakoutHold, stopLossPercent: value } })} />
            <NumberField label="宽松时间兜底（分钟）" value={draft.breakoutHold.maxHoldMinutes} hint="0=关闭" step="1" onChange={(value) => setDraft({ ...draft, breakoutHold: { ...draft.breakoutHold, maxHoldMinutes: value } })} />
          </div>
          <div className="tp-levels">
            {draft.breakoutHold.takeProfitLevels.map((level, index) => <div className="tp-level-row" key={`breakout-level-${index}`}>
              <span className="tp-level-index">第 {index + 1} 级</span>
              <label className="field"><span>触发涨幅（%）</span><input type="number" step="any" min="0" value={level.pricePercent} onChange={(event) => updateBreakoutLevel(index, { pricePercent: event.target.value })} /></label>
              <label className="field"><span>平仓比例（0-1）</span><input type="number" step="any" min="0" max="1" value={level.closeRatio} onChange={(event) => updateBreakoutLevel(index, { closeRatio: event.target.value })} /></label>
              <button type="button" className="icon-button" aria-label={`删除低位启动第 ${index + 1} 级止盈`} onClick={() => removeBreakoutLevel(index)} disabled={draft.breakoutHold.takeProfitLevels.length <= 1}><Icon name="close" /></button>
            </div>)}
          </div>
          <div className="tp-actions"><button type="button" className="filter-button" onClick={addBreakoutLevel} disabled={draft.breakoutHold.takeProfitLevels.length >= 5}>添加止盈级别</button><small>最多 5 级；末级平仓比例必须为 1</small></div>
        </div>
      </section>

      <section className="panel settings-panel">
        <div className="settings-group"><div className="settings-group-title"><span className="eyebrow">埋伏开单配置（AMBUSH）</span><h2>低位 + 空头燃料堆积时直接开单，不等放量确认</h2><p className="settings-note">埋伏评分不参考 OI 变化（权重：空头燃料 + 低位位置 + 横盘程度 + 主动盘 + 温和上涨 + 量能蓄势）；庄家横盘吸筹期空单堆积，提前埋伏等待拉盘爆空。</p></div>
          <div className="settings-grid toggles">
            <ToggleField label="启用埋伏开单" hint="低位 + 空头燃料达标即开单" checked={draft.ambushEnabled} onChange={(checked) => setDraft({ ...draft, ambushEnabled: checked })} />
            <NumberField label="空头燃料最低分（0-15）" value={draft.ambushMinShortFuelScore} hint="Binance/Gate 合约空头堆积得分" step="1" onChange={(value) => setDraft({ ...draft, ambushMinShortFuelScore: value })} />
            <NumberField label="埋伏评分门槛（0-100）" value={draft.ambushMinScore} hint="埋伏评分（不参考 OI），默认 15" step="1" onChange={(value) => setDraft({ ...draft, ambushMinScore: value })} />
            <NumberField label="埋伏市值上限（M）" value={draft.ambushMaxMarketCapM} hint="超过该市值的币不做埋伏（庄家难控盘），默认 20" step="1" onChange={(value) => setDraft({ ...draft, ambushMaxMarketCapM: value })} />
          </div>
        </div>
      </section>

      <div className="settings-actions"><button type="button" className="primary-button" onClick={() => void saveSettings()} disabled={saving}>{saving ? "保存中…" : "保存设置"}</button><span className="settings-hint">保存后立即生效，无需重启服务</span></div>
    </>}
  </main>;
}

const eventLabel: Record<string, string> = {
  ENTRY_OPENED: "开仓",
  ENTRY_SUBMITTED: "入场订单已提交",
  ENTRY_REJECTED: "入场被拒",
  DUPLICATE_SIGNAL_IGNORED: "重复信号忽略",
  POSITION_PARTIALLY_EXITED: "部分止盈",
  POSITION_CLOSED: "平仓",
  CIRCUIT_BREAKER_TRIPPED: "熔断触发",
  CIRCUIT_BREAKER_RESET: "熔断复位",
};

const reasonLabel: Record<string, string> = {
  TAKE_PROFIT: "分级止盈",
  STOP_LOSS: "止损",
  REVERSAL: "5m 反转",
  MAX_HOLD_REACHED: "时间兜底",
  CIRCUIT_BREAKER: "熔断",
  ANOMALY_SCORE_TOO_LOW: "评分不足",
  MAX_POSITIONS_REACHED: "持仓上限",
  CIRCUIT_BREAKER_ACTIVE: "熔断中",
  DATA_STREAM_INTERRUPTED: "数据中断",
  ORDER_STATUS_UNKNOWN: "订单状态未知",
  PROTECTION_ORDER_MISSING: "保护单缺失",
};

function detailText(key: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (key === "level") return `第 ${value} 级`;
    if (key === "quantity" || key === "remainingQuantity") return `${value} 枚`;
    if (key === "stopPrice" || key === "entryPrice") return `@ ${value}`;
    return String(value);
  }
  return String(value);
}

function formatUsdt(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)} USDT`;
}

function pnlTone(value: number | undefined): string {
  if (value === undefined || value === 0) return "muted";
  return value > 0 ? "positive" : "negative";
}

function RecordDetailPanel({ record, events, onClose }: { record: ExecutionRecord; events: ExecutionEvent[]; onClose: () => void }) {
  const pnl = record.pnl;
  return <aside className="detail-panel panel" aria-label={`${record.symbol} 交易明细`}>
    <div className="detail-heading">
      <div><span className="eyebrow">模拟交易明细</span><h2>{displaySymbol(record.symbol)}USDT 永续</h2><p>{record.status === "OPEN" ? "持仓中" : "已平仓"} · {record.leverage}x 杠杆 · 只读模拟</p></div>
      <button type="button" className="icon-button" aria-label="关闭明细" onClick={onClose}><Icon name="close" /></button>
    </div>
    <div className="detail-meta"><span>开仓 {timeText(record.openedAt)}</span><span>{record.closedAt ? `平仓 ${timeText(record.closedAt)}` : "等待平仓"}</span></div>
    <section className="detail-section"><div className="section-label">持仓参数</div><div className="evidence-list">
      <div><span>开仓价</span><strong className="mono">{record.entryPrice}</strong></div>
      <div><span>数量</span><strong className="mono">{record.initialQuantity} 枚</strong></div>
      <div><span>剩余数量</span><strong className="mono">{record.remainingQuantity} 枚</strong></div>
      <div><span>名义金额</span><strong className="mono">{record.notionalUsdt} USDT</strong></div>
      <div><span>保证金</span><strong className="mono">{record.marginUsdt} USDT</strong></div>
      <div><span>杠杆</span><strong className="mono">{record.leverage}x</strong></div>
      <div><span>当前止损</span><strong className="mono">{record.stopPrice}</strong></div>
      <div><span>止盈级数</span><strong className="mono">{record.takeProfitLevelReached} / 配置级数</strong></div>
    </div></section>
    {pnl && <section className="detail-section"><div className="section-label">盈亏与费用</div><div className="pnl-grid">
      <div><span>已实现盈亏</span><strong className={`mono ${pnlTone(pnl.realizedPnl)}`}>{formatUsdt(pnl.realizedPnl)}</strong></div>
      <div><span>浮动盈亏</span><strong className={`mono ${pnlTone(pnl.unrealizedPnl)}`}>{formatUsdt(pnl.unrealizedPnl)}</strong></div>
      <div><span>总盈亏</span><strong className={`mono ${pnlTone(pnl.totalPnl)}`}>{formatUsdt(pnl.totalPnl)}</strong></div>
      <div><span>手续费</span><strong className="mono">{formatUsdt(-pnl.commission)}</strong></div>
      <div><span>资金费</span><strong className="mono">{formatUsdt(-pnl.fundingFee)}</strong><small>{pnl.fundingPeriods} 个结算周期（每 8 小时）</small></div>
      <div><span>净盈亏（含费用）</span><strong className={`mono ${pnlTone(pnl.netPnl)}`}>{formatUsdt(pnl.netPnl)}</strong></div>
    </div></section>}
    <section className="detail-section"><div className="section-label">操作时间线 <span>{events.length}</span></div><div className="event-timeline">
      {events.length === 0 ? <span className="muted">暂无操作记录</span> : events.map((event, index) => <div className="event-item" key={`${event.type}-${event.at}-${index}`}>
        <div className="event-marker" /><div className="event-content"><div className="event-head"><strong>{eventLabel[event.type] ?? event.type}</strong>{event.reasonCode && <span className="event-reason">{reasonLabel[event.reasonCode] ?? event.reasonCode}</span>}<small>{timeText(event.at)}</small></div>
        {event.details && <div className="event-details">{Object.entries(event.details).map(([key, value]) => { const text = detailText(key, value); return text ? <span key={key}>{text}</span> : null; })}</div>}
      </div></div>)}
    </div></section>
  </aside>;
}

function RecordsPanel({ selected, onSelect, onClose }: { selected: ExecutionRecord | null; onSelect: (record: ExecutionRecord) => void; onClose: () => void }) {
  const [rows, setRows] = useState<ExecutionRecord[]>([]);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const requestId = useRef(0);

  const loadData = useCallback(async (manual = false) => {
    const currentRequestId = ++requestId.current;
    if (manual) setRefreshing(true);
    try {
      const response = await fetch("/api/execution/records");
      if (!response.ok) throw new Error("交易记录读取失败");
      const body = await response.json() as RecordsResponse;
      if (currentRequestId !== requestId.current) return;
      setRows(body.items ?? []);
      setLoadedAt(Date.now());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取交易记录");
    } finally {
      if (currentRequestId === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  const loadDetail = useCallback(async (symbol: string) => {
    try {
      const response = await fetch(`/api/execution/records?symbol=${encodeURIComponent(symbol)}`);
      if (!response.ok) return;
      const body = await response.json() as RecordDetailResponse;
      // 入场被拒不进时间线（后端已过滤，此处防御旧缓存/数据）。
      setEvents((body.events ?? []).filter((event) => event.type !== "ENTRY_REJECTED"));
    } catch {
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    void loadData();
    const timer = window.setInterval(() => void loadData(), 15_000);
    return () => window.clearInterval(timer);
  }, [loadData]);

  useEffect(() => {
    if (selected) void loadDetail(selected.symbol);
  }, [selected, loadDetail]);

  return <>
    <main className="main-content">
      <section className="page-heading"><div><span className="eyebrow">模拟执行 · 只读</span><h1>模拟交易记录</h1><p>自动开仓、分级止盈与平仓的每一笔明细；模拟盘不调用任何真实下单接口。</p></div><div className="freshness"><span>{refreshing ? "刷新中" : "实时更新"}</span><small>{loadedAt ? `更新于 ${timeText(loadedAt)}` : "等待数据"}</small></div></section>

      {error && <div className="error-banner"><span>{error}</span><button type="button" className="text-button" onClick={() => void loadData(true)}>重试</button></div>}

      <section className="toolbar panel"><button type="button" className="refresh-button" onClick={() => void loadData(true)} disabled={refreshing}><Icon name="refresh" />{refreshing ? "刷新中" : "刷新"}</button><span className="toolbar-note">{rows.length} 笔交易记录</span></section>

      <section className="table-panel panel"><div className="table-heading"><div><h2>开平仓记录</h2><p>点击任意记录查看完整操作时间线与盈亏明细；仅模拟盘数据。</p></div><span className="table-legend"><i className="legend-dot good" />持仓中 <i className="legend-dot" />已平仓</span></div><div className="table-scroll"><table><thead><tr><th>标的</th><th>状态</th><th>开仓价</th><th>数量</th><th>杠杆</th><th>名义金额</th><th>止盈级数</th><th>净盈亏</th><th>开仓时间</th><th>平仓时间</th><th /></tr></thead><tbody>{rows.length === 0 ? <tr><td colSpan={11}><EmptyState message={error ? "后端未连接，暂无交易记录" : "还没有模拟交易，等待合格信号自动开仓"} /></td></tr> : rows.map((row) => <tr key={row.symbol} className={selected?.symbol === row.symbol ? "is-row-selected" : ""} onClick={() => onSelect(row)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(row); }}><td><div className="symbol-cell"><span className="asset-symbol">{displaySymbol(row.symbol).slice(0, 4)}</span><div><strong>{displaySymbol(row.symbol)}USDT</strong><small>永续 · 开仓 {row.openCount} 次 · 平仓 {row.closeCount} 次</small></div></div></td><td><span className={`quality quality-${row.status === "OPEN" ? "good" : ""}`}>{row.status === "OPEN" ? "持仓中" : "已平仓"}</span></td><td className="mono">{row.entryPrice}</td><td className="mono">{row.initialQuantity} 枚</td><td className="mono">{row.leverage}x</td><td className="mono">{row.notionalUsdt} USDT</td><td className="mono">{row.takeProfitLevelReached}</td><td className={`mono ${pnlTone(row.pnl?.netPnl)}`}><strong>{formatUsdt(row.pnl?.netPnl)}</strong></td><td className="muted mono">{timeText(row.openedAt)}</td><td className="muted mono">{row.closedAt ? timeText(row.closedAt) : "—"}</td><td className="row-arrow"><Icon name="chevron" /></td></tr>)}</tbody></table></div></section>
    </main>
    {selected && <div className="detail-side"><RecordDetailPanel record={selected} events={events} onClose={onClose} /></div>}
  </>;
}

export default function App() {
  const [section, setSection] = useState<Section>("contract");
  const [interval, setIntervalValue] = useState<Interval>("5m");
  const [scoreType, setScoreType] = useState<ScoreType>("launch");
  const [rows, setRows] = useState<OiRow[]>([]);
  const [openableItems, setOpenableItems] = useState<OpenableItem[]>([]);
  const [selected, setSelected] = useState<OiRow | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<ExecutionRecord | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [onlyThreshold, setOnlyThreshold] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const requestId = useRef(0);

  const loadData = useCallback(async (manual = false) => {
    const currentRequestId = ++requestId.current;
    const requestedInterval = interval;
    if (manual) setRefreshing(true);
    try {
      const [healthResponse, leaderboardResponse, openableResponse] = await Promise.all([
        fetch("/health"),
        fetch(`/api/futures/oi-leaderboard?interval=${interval}&limit=10&scoreType=${scoreType}`),
        fetch(`/api/futures/openable?interval=${interval}&limit=20&scoreType=${scoreType}`),
      ]);
      if (!healthResponse.ok || !leaderboardResponse.ok || !openableResponse.ok) throw new Error("后端请求失败，请检查服务状态");
      const nextHealth = await healthResponse.json() as HealthResponse;
      const nextLeaderboard = await leaderboardResponse.json() as LeaderboardResponse;
      const nextOpenable = await openableResponse.json() as OpenableResponse;
      if (currentRequestId !== requestId.current || nextLeaderboard.interval !== requestedInterval) return;
      setHealth(nextHealth);
      setRows(nextLeaderboard.items ?? []);
      setOpenableItems(nextOpenable.items ?? []);
      setLoadedAt(nextLeaderboard.generatedAt || Date.now());
      setSelected((current) => current && (nextLeaderboard.items ?? []).some((item) => item.symbol === current.symbol) ? (nextLeaderboard.items ?? []).find((item) => item.symbol === current.symbol) ?? null : (nextLeaderboard.items?.[0] ?? null));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法连接后端");
    } finally {
      if (currentRequestId === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [interval, scoreType]);

  useEffect(() => {
    void loadData();
    const timer = window.setInterval(() => void loadData(), 15_000);
    return () => window.clearInterval(timer);
  }, [loadData]);

  const handleRefresh = useCallback(async () => {
    // 电脑睡眠/断线恢复后：先触发后台主动刷新（交易所信息 + Alpha 板块），
    // 让 universe、市值与数据完整性尽快对齐当前时间，再拉取最新数据。
    try {
      await fetch("/api/futures/refresh", { method: "POST" });
    } catch {
      // 后台刷新失败不阻断数据拉取。
    }
    await loadData(true);
  }, [loadData]);

  const visibleRows = useMemo(() => onlyThreshold ? rows.filter((row) => row.factors.some((factor) => factor.code === "OI_THRESHOLD_BREAK")) : rows, [onlyThreshold, rows]);
  const online = health?.connectors?.futuresStream?.status === "connected";
  const processOnline = health?.connectors?.futuresProcessing?.status === "connected";
  const liveTrading = (health?.connectors?.execution?.message ?? "").includes("PRODUCTION");
  const highCount = rows.filter((row) => row.factors.some((factor) => factor.severity === "HIGH")).length;

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Icon name="pulse" /></div><div><div className="brand-name">合约雷达</div><div className="brand-subtitle">OI 异动监控台</div></div></div>
      <div className="topbar-status">{liveTrading ? <span className="live-mode">实盘交易</span> : <span className="read-only">只读模式</span>}<span className="connection"><StatusDot status={health?.status ?? "disconnected"} />{loading ? "连接中" : error ? "请求异常" : "服务在线"}</span></div>
    </header>

    <div className="workspace">
      <aside className="rail"><nav className="rail-nav" aria-label="主导航">
        <button type="button" className={`rail-item ${section === "onchain" ? "is-active" : ""}`} onClick={() => setSection("onchain")}><Icon name="chain" /><span>链上</span><span className="rail-note">待接入</span></button>
        <button type="button" className={`rail-item ${section === "contract" ? "is-active" : ""}`} onClick={() => setSection("contract")}><Icon name="contract" /><span>合约</span><span className="rail-count">{rows.length}</span></button>
        <button type="button" className={`rail-item ${section === "records" ? "is-active" : ""}`} onClick={() => setSection("records")}><Icon name="history" /><span>交易记录</span></button>
        <button type="button" className={`rail-item ${section === "settings" ? "is-active" : ""}`} onClick={() => setSection("settings")}><Icon name="gear" /><span>设置</span></button>
      </nav><div className="rail-bottom"><div className="rail-divider" /><span className="rail-caption">数据源</span><div className="source-mini"><StatusDot status={online ? "connected" : "disconnected"} />币安合约</div><div className="source-mini"><StatusDot status={processOnline ? "connected" : "disconnected"} />指标处理</div><div className="source-mini"><StatusDot status="degraded" />Bitget 参考</div></div></aside>

      {section === "settings" ? <SettingsPanel /> : section === "records" ? <RecordsPanel selected={selectedRecord} onSelect={setSelectedRecord} onClose={() => setSelectedRecord(null)} /> : section === "onchain" ? <main className="main-content placeholder-main"><div className="placeholder-card panel"><span className="eyebrow">模块预留</span><h1>链上监控</h1><p>链上模块暂未启用，本页先专注 Binance 合约 OI 异动排行榜。</p><button type="button" className="primary-button" onClick={() => setSection("contract")}>返回合约排行榜 <Icon name="chevron" /></button></div></main> : <main className="main-content">
        <section className="page-heading"><div><span className="eyebrow">Binance Futures · 只读</span><h1>合约 OI 异动排行榜</h1><p>按综合评分降序排列；每个仅合约标的只取最新闭合窗口，并展示真实触发因子。</p></div><div className="freshness"><StatusDot status={online ? "connected" : "disconnected"} /><span>{refreshing ? "刷新中" : "实时更新"}</span><small>{loadedAt ? `更新于 ${timeText(loadedAt)}` : "等待数据"}</small></div></section>

        {error && <div className="error-banner"><span>{error}</span><button type="button" className="text-button" onClick={() => void loadData(true)}>重试</button></div>}

        <section className="toolbar panel"><div className="interval-tabs" role="tablist" aria-label="评分体系">{(["launch", "ambush"] as ScoreType[]).map((value) => <button type="button" key={value} className={scoreType === value ? "is-selected" : ""} onClick={() => setScoreType(value)} role="tab" aria-selected={scoreType === value}>{value === "launch" ? "启动评分" : "埋伏评分"}</button>)}</div><div className="toolbar-divider" /><div className="interval-tabs" role="tablist" aria-label="K线周期">{(["5m", "15m"] as Interval[]).map((value) => <button type="button" key={value} className={interval === value ? "is-selected" : ""} onClick={() => setIntervalValue(value)} role="tab" aria-selected={interval === value}>{value}</button>)}</div><div className="toolbar-divider" /><button type="button" className={`filter-button ${onlyThreshold ? "is-selected" : ""}`} onClick={() => setOnlyThreshold((value) => !value)} aria-pressed={onlyThreshold}>仅看 OI 阈值突破</button><button type="button" className="refresh-button" onClick={() => void handleRefresh()} disabled={refreshing}><Icon name="refresh" />{refreshing ? "刷新中" : "刷新"}</button><span className="toolbar-note">{rows.length} 个 Alpha 合约 · {interval} 窗口 · {scoreType === "launch" ? "启动评分（OI 主）" : "埋伏评分（不参考 OI）"}</span></section>

        <section className="openable-panel panel"><div className="table-heading"><div><h2>🎯 可开单候选</h2><p>当前满足开单条件的合约（STANDARD 放量确认 / AMBUSH 低位埋伏，数据不完整也照常展示）；实际是否开单由执行引擎按设置判定。</p></div><span className="table-legend"><i className="legend-dot high" />AMBUSH 埋伏 <i className="legend-dot warn" />STANDARD</span></div>{openableItems.length === 0 ? <div className="empty-state"><Icon name="pulse" /><span>暂无满足开单条件的合约 —— STANDARD 需 OI 爆发（放量增仓信号）；AMBUSH 需低位 + 空头燃料堆积。等待市场出现符合条件的标的。</span></div> : <div className="openable-list">{openableItems.map((item) => <div className={`openable-card mode-${item.mode.toLowerCase()}`} key={item.symbol}><div className="openable-head"><strong>{displaySymbol(item.symbol)}USDT</strong><span className={`mode-badge mode-${item.mode.toLowerCase()}`}>{item.mode === "AMBUSH" ? "埋伏" : "放量"}</span></div><div className="openable-meta"><span>市值 {formatMarketCap(item.marketCapM)}</span><span>{item.mode === "AMBUSH" ? `埋伏 ${item.ambushScore ?? 0}` : `启动 ${item.anomalyScore}`}</span><span className={item.dataCompleteness === "COMPLETE" ? "quality-good" : "quality-warn"}>{item.dataCompleteness === "COMPLETE" ? "数据完整" : "数据不完整"}</span></div><div className="openable-reasons">{item.reasons.map((reason) => <small key={reason}>· {reason}</small>)}</div></div>)}</div>}</section>

        <section className="stats-strip" aria-label="排行榜摘要"><div><span>当前排名</span><strong>{visibleRows.length}</strong><small>{onlyThreshold ? "OI 阈值突破" : "最新 OI 数据"}</small></div><div><span>高优先因子</span><strong className="danger-text">{highCount}</strong><small>OI 阈值突破</small></div><div><span>最大 OI 变化</span><strong>{visibleRows.length ? formatPercent(visibleRows.reduce((max, row) => Math.abs(row.oiValueDelta) > Math.abs(max.oiValueDelta) ? row : max).oiValueDelta) : "—"}</strong><small>{visibleRows.length ? displaySymbol(visibleRows.reduce((max, row) => Math.abs(row.oiValueDelta) > Math.abs(max.oiValueDelta) ? row : max).symbol) : "等待数据"}</small></div><div><span>最后刷新</span><strong className="mono">{loadedAt ? timeText(loadedAt) : "—"}</strong><small>{loadedAt ? timeAgo(loadedAt) : "—"}</small></div></section>

        <section className="table-panel panel"><div className="table-heading"><div><h2>OI 异动明细</h2><p>每行均可点击查看触发因子和原始证据；不执行交易。仅展示 Binance Alpha 板块合约，按评分取前 10。</p></div><span className="table-legend"><i className="legend-dot high" />高优先 <i className="legend-dot warn" />参考因子</span></div><div className="table-scroll"><table><thead><tr><th>#</th><th>标的</th><th>市值</th><th>{scoreType === "launch" ? "启动评分" : "埋伏评分"}</th><th>OI变化</th><th>价格变化</th><th>成交量比</th><th>触发因子</th><th>质量</th><th>时间</th><th /></tr></thead><tbody>{visibleRows.length === 0 ? <tr><td colSpan={11}><EmptyState message={error ? "后端未连接，暂无真实 OI 数据" : onlyThreshold ? "当前窗口暂无 OI 阈值突破" : "等待合约 OI 数据"} /></td></tr> : visibleRows.map((row) => <tr key={`${row.symbol}-${row.interval}`} className={selected?.symbol === row.symbol ? "is-row-selected" : ""} onClick={() => setSelected(row)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelected(row); }}><td className="rank">{row.rank}</td><td><div className="symbol-cell"><span className="asset-symbol">{displaySymbol(row.symbol).slice(0, 4)}</span><div><strong>{displaySymbol(row.symbol)}USDT</strong><small>Binance 永续 · {row.interval}</small></div></div></td><td className="mono">{formatMarketCap(row.marketCapM)}</td><td><span className="score-badge"><strong>{scoreType === "ambush" ? formatScore(row.ambushScore ?? 0) : formatScore(row.anomalyScore)}</strong><small>/ 100</small></span></td><td className={`mono ${row.oiValueDelta >= 0 ? "positive" : "negative"}`}><strong>{formatPercent(row.oiValueDelta)}</strong></td><td className={`mono ${row.priceReturn >= 0 ? "positive" : "negative"}`}>{formatPercent(row.priceReturn)}</td><td className="mono volume-value">{row.volumeRatio.toFixed(2)}x</td><td><div className="factor-list">{row.factors.map((factor) => <FactorChip key={`${factor.code}-${factor.label}`} factor={factor} />)}</div></td><td><span className={`quality quality-${row.dataCompleteness === "COMPLETE" ? "good" : "warn"}`}>{row.dataCompleteness === "COMPLETE" ? "完整" : "部分"}</span></td><td className="muted mono">{timeText(row.candleOpenTime)}</td><td className="row-arrow"><Icon name="chevron" /></td></tr>)}</tbody></table></div></section>
      </main>}

      {section === "contract" && <div className="detail-side"><DetailPanel row={selected} onClose={() => setSelected(null)} /></div>}
    </div>
    <footer className="footer"><span>合约雷达 · Binance 合约数据</span><span>自动刷新 15 秒 · 前端无交易控制 · 默认模拟</span></footer>
  </div>;
}
