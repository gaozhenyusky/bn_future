ALTER TABLE futures_candles
  ADD INDEX idx_futures_candles_interval_symbol_open_time (interval_name, symbol, open_time);

ALTER TABLE futures_flow_metrics
  ADD INDEX idx_futures_flow_metrics_interval_symbol_candle (interval_name, symbol, candle_open_time);

ALTER TABLE futures_oi_snapshots
  ADD INDEX idx_futures_oi_snapshots_interval_timestamp (interval_name, timestamp);

ALTER TABLE futures_signals
  ADD INDEX idx_futures_signals_candle_symbol_interval (candle_open_time, symbol, interval_name);

ALTER TABLE source_events
  ADD INDEX idx_source_events_received_timestamp (received_timestamp);

ALTER TABLE futures_reference_factors
  ADD INDEX idx_futures_reference_factors_observed_at (observed_at);
