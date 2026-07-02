-- Sigma — Contract Quality / Health Index, Phase 4: entity-grain rollups the per-contract scoring
-- (Phase 5, next PRD group) joins against. Run AFTER scripts/precompute.sql has (re)built
-- flow_pairs/authority_totals/tenders.estimated_value_eur on the served D1:
--   (cd apps/web && wrangler d1 execute sigma --local --file ../../scripts/derive-health.sql)
--
-- Spec: docs/contract-quality-spec.local.md §7.2 (table DDL + INSERT bodies) + §8 (build order).
-- §12 corrections override earlier sections on conflict (score scale, procedure-type vocabulary —
-- neither concerns these four tables, which are raw fractions/counts, not [0,1] pillar scores).
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS + DELETE + INSERT, same idiom as scripts/precompute.sql.
-- PORTABLE SQLite ONLY: no POWER/LN/EXP/SQRT — HHI as (x)*(x); percentiles via LIMIT 1 OFFSET.
--
-- PERFORMANCE: authority_health_rollup's HHI is computed via a two-step aggregate-then-join
-- (authority_won -> authority_won_totals -> grouped join), NOT the spec's literal correlated
-- subquery-per-authority-row — same numbers, one pass over flow_pairs instead of one subquery
-- execution per authority. Every other INSERT below is a single-pass GROUP BY over contracts/
-- flow_pairs (O(n log n) in the sort/hash the query planner picks, n = contracts_with_bids or
-- flow_pairs rows, both well under 200k).

-- ── authority_health_rollup ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS authority_health_rollup (
  authority_id        TEXT PRIMARY KEY REFERENCES authorities(id),
  hhi                 REAL,    -- SUM((won/total)*(won/total)) over the authority's bidders
  single_offer_share  REAL,    -- bids_received=1 / known-bids contracts
  direct_award_share  REAL,    -- procedure_type='Пряко договаряне' / total
  avg_annex_count     REAL,
  avg_cost_overrun    REAL,    -- mean current/signing where it grew
  cancelled_share     REAL,    -- tenders.cancelled=1 / tenders (authority)
  contracts_with_bids INTEGER,
  total_contracts     INTEGER
);
DELETE FROM authority_health_rollup;
WITH authority_won AS (
  SELECT authority_id, bidder_id, won_eur FROM flow_pairs
),
authority_won_totals AS (
  SELECT authority_id, SUM(won_eur) AS total_won_eur FROM authority_won GROUP BY authority_id
),
authority_hhi AS (
  SELECT w.authority_id,
    SUM((w.won_eur / NULLIF(t.total_won_eur,0)) * (w.won_eur / NULLIF(t.total_won_eur,0))) AS hhi
  FROM authority_won w JOIN authority_won_totals t ON t.authority_id = w.authority_id
  GROUP BY w.authority_id
),
authority_stats AS (
  SELECT t.authority_id AS authority_id,
    SUM(CASE WHEN c.bids_received = 1 THEN 1.0 ELSE 0 END)
      / NULLIF(SUM(CASE WHEN c.bids_received IS NOT NULL THEN 1 ELSE 0 END),0) AS single_offer_share,
    SUM(CASE WHEN t.procedure_type='Пряко договаряне' THEN 1.0 ELSE 0 END) / NULLIF(COUNT(*),0) AS direct_award_share,
    AVG(c.annex_count) AS avg_annex_count,
    AVG(CASE WHEN c.signing_value_eur>0 AND c.current_value_eur>c.signing_value_eur
             THEN c.current_value_eur/c.signing_value_eur END) AS avg_cost_overrun,
    SUM(CASE WHEN c.bids_received IS NOT NULL THEN 1 ELSE 0 END) AS contracts_with_bids,
    COUNT(*) AS total_contracts
  FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE c.amount_eur IS NOT NULL
  GROUP BY t.authority_id
)
INSERT INTO authority_health_rollup
  (authority_id, hhi, single_offer_share, direct_award_share, avg_annex_count, avg_cost_overrun,
   cancelled_share, contracts_with_bids, total_contracts)
SELECT s.authority_id, h.hhi, s.single_offer_share, s.direct_award_share, s.avg_annex_count,
       s.avg_cost_overrun, NULL, s.contracts_with_bids, s.total_contracts
FROM authority_stats s LEFT JOIN authority_hhi h ON h.authority_id = s.authority_id;

-- cancelled_share: second pass, joining tenders grouped by authority_id (spec leaves it NULL in the
-- main INSERT). Pre-aggregated CTE keeps this a lookup per authority row, not a per-contract rescan.
UPDATE authority_health_rollup
SET cancelled_share = (
  SELECT SUM(CASE WHEN t.cancelled = 1 THEN 1.0 ELSE 0 END) / NULLIF(COUNT(*),0)
  FROM tenders t WHERE t.authority_id = authority_health_rollup.authority_id
);

-- ── bidder_health_rollup ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bidder_health_rollup (
  bidder_id        TEXT PRIMARY KEY REFERENCES bidders(id),
  buyer_hhi        REAL,     -- SUM((won_from_buyer/total_won)^2) across buyers
  buyer_count      INTEGER,
  avg_repeat_share REAL,
  total_contracts  INTEGER
);
DELETE FROM bidder_health_rollup;
INSERT INTO bidder_health_rollup (bidder_id, buyer_hhi, buyer_count, avg_repeat_share, total_contracts)
SELECT fp.bidder_id,
  SUM((fp.won_eur/NULLIF(bt.won_eur,0))*(fp.won_eur/NULLIF(bt.won_eur,0))),
  COUNT(DISTINCT fp.authority_id),
  AVG(fp.contracts*1.0/NULLIF(at.contracts,0)),
  bt.contracts
FROM flow_pairs fp
JOIN (SELECT bidder_id, SUM(won_eur) won_eur, SUM(contracts) contracts FROM flow_pairs GROUP BY bidder_id) bt
  ON bt.bidder_id = fp.bidder_id
JOIN authority_totals at ON at.authority_id = fp.authority_id
GROUP BY fp.bidder_id;

-- ── sector_concentration ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sector_concentration (
  cpv_division       TEXT NOT NULL,
  bidder_id          TEXT NOT NULL REFERENCES bidders(id),
  won_eur            REAL NOT NULL,
  contracts          INTEGER NOT NULL,
  division_total_eur REAL NOT NULL,
  win_share          REAL NOT NULL,
  PRIMARY KEY (cpv_division, bidder_id)
);
CREATE INDEX IF NOT EXISTS idx_sector_concentration_bidder ON sector_concentration(bidder_id);
DELETE FROM sector_concentration;
-- HAVING <> 0 guards win_share's division: a CPV division whose priced contracts sum to 0 EUR
-- (a single amount_eur=0 contract, or exact +/- offsets) would otherwise yield 0/0 = NULL and
-- abort the whole derive on win_share's NOT NULL constraint. Such a division carries no
-- meaningful share, so it is skipped here; downstream (derive-contract-features.sql LEFT JOIN)
-- its contracts get sector_win_share NULL — an honest "unknown", never a fabricated 0 score.
WITH div_totals AS (
  SELECT substr(t.cpv_code,1,2) div, SUM(c.amount_eur) total_eur
  FROM contracts c JOIN tenders t ON t.id=c.tender_id
  WHERE c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'')<>''
  GROUP BY substr(t.cpv_code,1,2)
  HAVING SUM(c.amount_eur) <> 0)
INSERT INTO sector_concentration (cpv_division, bidder_id, won_eur, contracts, division_total_eur, win_share)
SELECT substr(t.cpv_code,1,2), c.bidder_id, SUM(c.amount_eur), COUNT(*), dt.total_eur,
       SUM(c.amount_eur)/dt.total_eur
FROM contracts c JOIN tenders t ON t.id=c.tender_id
JOIN div_totals dt ON dt.div=substr(t.cpv_code,1,2)
WHERE c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'')<>''
GROUP BY substr(t.cpv_code,1,2), c.bidder_id;

-- ── health_percentiles ───────────────────────────────────────────────────────────────────────
-- Corpus distribution snapshot (calibration + validation, §10) via the LIMIT 1 OFFSET idiom.
CREATE TABLE IF NOT EXISTS health_percentiles (
  signal TEXT PRIMARY KEY, p05 REAL, p25 REAL, p50 REAL, p75 REAL, p95 REAL
);
DELETE FROM health_percentiles;

INSERT INTO health_percentiles
WITH vals AS (SELECT bids_received AS v FROM contracts WHERE bids_received IS NOT NULL),
     n AS (SELECT COUNT(*) AS cnt FROM vals)
SELECT 'bids_received',
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.05 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.25 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.50 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.75 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.95 AS INTEGER) FROM n));

INSERT INTO health_percentiles
WITH vals AS (
  SELECT current_value_eur/signing_value_eur AS v FROM contracts
  WHERE signing_value_eur > 0 AND current_value_eur IS NOT NULL
),
n AS (SELECT COUNT(*) AS cnt FROM vals)
SELECT 'cost_overrun_ratio',
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.05 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.25 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.50 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.75 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.95 AS INTEGER) FROM n));

INSERT INTO health_percentiles
WITH vals AS (
  SELECT ABS(c.signing_value_eur - t.estimated_value_eur) / NULLIF(t.estimated_value_eur,0) AS v
  FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE c.signing_value_eur IS NOT NULL AND t.estimated_value_eur IS NOT NULL
    AND t.procedure_type <> 'неизвестна'
),
n AS (SELECT COUNT(*) AS cnt FROM vals)
SELECT 'estimate_dev_ratio',
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.05 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.25 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.50 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.75 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.95 AS INTEGER) FROM n));

INSERT INTO health_percentiles
WITH vals AS (SELECT annex_count AS v FROM contracts WHERE annex_count IS NOT NULL),
     n AS (SELECT COUNT(*) AS cnt FROM vals)
SELECT 'annex_count',
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.05 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.25 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.50 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.75 AS INTEGER) FROM n)),
  (SELECT v FROM vals ORDER BY v LIMIT 1 OFFSET (SELECT CAST(cnt*0.95 AS INTEGER) FROM n));

-- Summary (last result set printed by `wrangler d1 execute`)
SELECT
  (SELECT COUNT(*) FROM authority_health_rollup) AS authority_health_rows,
  (SELECT COUNT(*) FROM bidder_health_rollup)     AS bidder_health_rows,
  (SELECT COUNT(*) FROM sector_concentration)     AS sector_concentration_rows,
  (SELECT COUNT(*) FROM health_percentiles)       AS health_percentile_rows;
