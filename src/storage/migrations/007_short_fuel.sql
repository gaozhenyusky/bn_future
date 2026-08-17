ALTER TABLE futures_flow_metrics
  ADD COLUMN short_fuel_score DOUBLE NULL,
  ADD COLUMN short_fuel_level VARCHAR(16) NULL,
  ADD COLUMN short_fuel_evidence JSON NULL;
