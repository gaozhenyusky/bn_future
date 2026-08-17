ALTER TABLE futures_flow_metrics
  ADD COLUMN breakout_context VARCHAR(32) NULL,
  ADD COLUMN position_percentile DOUBLE NULL;
