CREATE TABLE IF NOT EXISTS futures_contracts (
  symbol VARCHAR(64) PRIMARY KEY,
  pair VARCHAR(64) NOT NULL,
  base_asset VARCHAR(32) NOT NULL,
  quote_asset VARCHAR(32) NOT NULL,
  contract_type VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  onboard_date BIGINT NOT NULL,
  delivery_date BIGINT NULL,
  filters JSON NULL,
  is_contract_only BOOLEAN NOT NULL,
  spot_base_asset_matches JSON NOT NULL,
  contract_only_reason VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS futures_candles (
  symbol VARCHAR(64) NOT NULL,
  interval_name VARCHAR(8) NOT NULL,
  open_time BIGINT NOT NULL,
  open_price VARCHAR(64) NOT NULL,
  high_price VARCHAR(64) NOT NULL,
  low_price VARCHAR(64) NOT NULL,
  close_price VARCHAR(64) NOT NULL,
  volume VARCHAR(64) NOT NULL,
  close_time BIGINT NOT NULL,
  quote_asset_volume VARCHAR(64) NOT NULL,
  trade_count INT NOT NULL,
  taker_buy_base_asset_volume VARCHAR(64) NOT NULL,
  taker_buy_quote_asset_volume VARCHAR(64) NOT NULL,
  is_closed BOOLEAN NOT NULL,
  source_timestamp BIGINT NULL,
  received_timestamp BIGINT NULL,
  raw_payload JSON NOT NULL,
  PRIMARY KEY (symbol, interval_name, open_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS futures_oi_snapshots (
  symbol VARCHAR(64) NOT NULL,
  interval_name VARCHAR(8) NOT NULL,
  timestamp BIGINT NOT NULL,
  sum_open_interest VARCHAR(64) NOT NULL,
  sum_open_interest_value VARCHAR(64) NOT NULL,
  source_timestamp BIGINT NOT NULL,
  received_timestamp BIGINT NOT NULL,
  PRIMARY KEY (symbol, interval_name, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS futures_flow_metrics (
  symbol VARCHAR(64) NOT NULL,
  interval_name VARCHAR(8) NOT NULL,
  candle_open_time BIGINT NOT NULL,
  candle_close_time BIGINT NULL,
  source_timestamp BIGINT NULL,
  received_timestamp BIGINT NULL,
  taker_buy_sell_ratio_raw VARCHAR(64) NULL,
  taker_buy_volume_raw VARCHAR(64) NULL,
  taker_sell_volume_raw VARCHAR(64) NULL,
  taker_flow_timestamp BIGINT NULL,
  funding_rate_raw VARCHAR(64) NULL,
  funding_rate_timestamp BIGINT NULL,
  is_contract_only BOOLEAN NULL,
  contract_only_reason VARCHAR(64) NULL,
  spot_base_asset_matches JSON NULL,
  is_complete BOOLEAN NULL,
  missing JSON NULL,
  volume_ratio DOUBLE NULL,
  volume_percentile DOUBLE NULL,
  oi_value_delta DOUBLE NULL,
  oi_unit_delta DOUBLE NULL,
  price_return DOUBLE NULL,
  taker_imbalance DOUBLE NULL,
  liquidation_ratio DOUBLE NULL,
  price_oi_alignment VARCHAR(64) NULL,
  data_completeness VARCHAR(64) NULL,
  contract_only_risk_level VARCHAR(32) NULL,
  contract_only_risk_reason VARCHAR(64) NULL,
  PRIMARY KEY (symbol, interval_name, candle_open_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS futures_signals (
  symbol VARCHAR(64) NOT NULL,
  interval_name VARCHAR(8) NOT NULL,
  candle_open_time BIGINT NOT NULL,
  signal_type VARCHAR(64) NOT NULL,
  threshold_version VARCHAR(255) NOT NULL,
  severity VARCHAR(32) NOT NULL,
  confidence DOUBLE NOT NULL,
  explanation VARCHAR(512) NOT NULL,
  evidence JSON NOT NULL,
  contract_only_risk_level VARCHAR(32) NULL,
  contract_only_risk_reason VARCHAR(64) NULL,
  PRIMARY KEY (symbol, interval_name, candle_open_time, signal_type, threshold_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS source_events (
  event_key VARCHAR(512) PRIMARY KEY,
  event_type VARCHAR(128) NOT NULL,
  symbol VARCHAR(64) NULL,
  interval_name VARCHAR(8) NULL,
  source_timestamp BIGINT NOT NULL,
  received_timestamp BIGINT NOT NULL,
  payload JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connector_checkpoints (
  stream VARCHAR(255) PRIMARY KEY,
  timestamp BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
