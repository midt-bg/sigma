-- Sigma — anomaly screen storage: cpv_price_stats + contract_anomalies.
--
-- Numbered incremental migration (the repo's current convention for post-0000 schema changes;
-- 0002/0004 are claimed by in-flight PRs, so this takes 0005). Both tables are populated by
-- scripts/precompute.sql §7 on every full import and scoped-refreshed by the daily slice
-- (scripts/refresh-slice.sql, @refresh-batch anomalies); methodology lives on /methodology#flags.
--
-- IF NOT EXISTS on purpose: unlike 0000_init (fresh-database assumption), these tables may already
-- exist on a running database — precompute.sql and the refresh batch create them defensively so the
-- ETL keeps working on databases migrated before this file landed. The guards make this migration a
-- safe no-op there and keep both creation paths convergent.

-- Per full CPV code: peer count + median contract value over clean rows. Feeds the price-outlier
-- signal in contract_anomalies; rebuilt on full import (precompute.sql), kept as-is by the daily
-- slice (medians drift negligibly within a day; a brand-new cohort appears on the next full import).
CREATE TABLE IF NOT EXISTS cpv_price_stats (
  cpv_code   TEXT PRIMARY KEY,
  peers      INTEGER NOT NULL,            -- clean contracts sharing this full CPV code
  median_eur REAL NOT NULL                -- median amount_eur of those contracts
);

-- Anomaly screen: one row per contract with at least one fired PRICE signal (over-estimate / annex
-- growth / price outlier). Signals are INDICATORS for public scrutiny, not verdicts — thresholds and
-- exclusions are documented in scripts/precompute.sql §7 and on /methodology. The `flag_*` columns
-- are the authoritative triggers (ratios are stored whenever computable, even under threshold);
-- single_bid / no_notice are context-only and never create a row by themselves. Denormalised
-- amount/date/sector/party columns keep list filtering on this small table (no 190k-row scans).
CREATE TABLE IF NOT EXISTS contract_anomalies (
  contract_id         TEXT PRIMARY KEY REFERENCES contracts(id),
  score               INTEGER NOT NULL,   -- 0–100 weighted sum of fired signals (see precompute §7)
  rank_value          REAL NOT NULL,      -- score-major, amount-minor sort key (score×1e12 + amount)
  flag_over_estimate  INTEGER NOT NULL DEFAULT 0,  -- signed ≥ +10% above the authority's own estimate
  flag_annex_growth   INTEGER NOT NULL DEFAULT 0,  -- grew ≥ +20% via annexes
  flag_price_outlier  INTEGER NOT NULL DEFAULT 0,  -- ≥5× the CPV-code median (peers ≥ 10, ≥ €50k)
  flag_single_bid     INTEGER NOT NULL DEFAULT 0,  -- one offer in a competitive procedure (context)
  flag_no_notice      INTEGER NOT NULL DEFAULT 0,  -- direct / no-notice procedure (context)
  over_estimate_ratio REAL,               -- signing_value_eur / estimated_eur (when comparable)
  estimated_eur       REAL,               -- the comparable estimate (lot-level, or single-lot tender)
  annex_growth_ratio  REAL,               -- current_value_eur / signing_value_eur (annexed rows)
  price_ratio         REAL,               -- amount_eur / peer_median_eur (peers ≥ 10)
  peer_median_eur     REAL,
  peer_count          INTEGER,
  amount_eur          REAL NOT NULL,      -- copied from contracts for filter/sort locality
  signed_at           TEXT,
  cpv_division        TEXT,               -- 2-digit CPV division (sector facet)
  authority_id        TEXT NOT NULL,
  bidder_id           TEXT NOT NULL
);

-- Anomaly screen: default sort (score-major/amount-minor) + the value/date sorts and party scoping.
CREATE INDEX IF NOT EXISTS idx_anomalies_rank ON contract_anomalies(rank_value DESC);
CREATE INDEX IF NOT EXISTS idx_anomalies_amount ON contract_anomalies(amount_eur);
CREATE INDEX IF NOT EXISTS idx_anomalies_signed ON contract_anomalies(signed_at);
CREATE INDEX IF NOT EXISTS idx_anomalies_authority ON contract_anomalies(authority_id);
CREATE INDEX IF NOT EXISTS idx_anomalies_bidder ON contract_anomalies(bidder_id);
