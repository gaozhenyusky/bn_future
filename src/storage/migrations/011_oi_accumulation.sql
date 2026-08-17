-- OI 积累趋势：长窗口 OI 累计变化（GPS 回测启发：资金提前数小时布局后放量启动）
ALTER TABLE futures_flow_metrics
  ADD COLUMN oi_accumulation_delta DOUBLE NULL,
  ADD COLUMN oi_accumulation_window_label VARCHAR(64) NULL,
  ADD COLUMN oi_accumulation_samples INT NULL;
