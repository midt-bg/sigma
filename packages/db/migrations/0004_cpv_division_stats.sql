-- Per-CPV-division value percentiles for the contract-page "Подобни договори" benchmark.
-- Filled by scripts/precompute.sql (full rebuild) and scripts/refresh-slice.sql (cron refresh);
-- the contract page reads ONE row here instead of scanning its whole division per view.
CREATE TABLE IF NOT EXISTS cpv_division_stats (
  division TEXT PRIMARY KEY,
  priced_contracts INTEGER NOT NULL,
  p25_eur REAL NOT NULL,
  median_eur REAL NOT NULL,
  p75_eur REAL NOT NULL,
  p90_eur REAL NOT NULL,
  p95_eur REAL NOT NULL,
  p99_eur REAL NOT NULL
);
