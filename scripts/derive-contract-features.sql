-- Sigma — Contract Quality / Health Index, Phase 5a+5b: per-contract feature store.
-- Run AFTER scripts/derive-health.sql (Phase 4 — authority_health_rollup, bidder_health_rollup,
-- sector_concentration) has (re)built its rollups on the served D1:
--   (cd apps/web && wrangler d1 execute sigma --local --file ../../scripts/derive-contract-features.sql)
--
-- Spec: docs/contract-quality-spec.local.md §4 (leaf defs), §5 (peer key), §5.6 (fallback), §6
-- (coverage), §7.3 (DDL), §8 (build order). §12 corrections OVERRIDE earlier sections — this file
-- follows §12.2 (21-value procedure map), §12.3 (framework/DPS regime, contracts.framework is
-- 100% NULL), §12.5 (year-band 'NA' for the 37 NULL/out-of-range signing years).
--
-- SCOPE: leaves + effective_peer_key/peer_n + score_coverage, then the pillar scoring UPDATEs
-- (score_a..score_e, score_overall in [0,1]) and the six *_quality_totals rollups — all in this
-- file, executed as one batch after scripts/derive-health.sql.
--
-- KNOWN LIMITATION (spec §5.6, same in its own sample SQL): rows that fall back to a mid/coarse
-- peer key are PERCENT_RANKed only against the other fallback rows assigned that key, not against
-- every row matching it — so the effective ranking cohort can be smaller than the stored peer_n.
-- Recorded as an open §11 question; fixing it requires ranking against the full key population.
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS + DELETE + INSERT, same idiom as scripts/derive-health.sql.
-- Temp staging tables are dropped up front so a re-run in the same connection is safe.
--
-- PORTABLE SQLite ONLY: no POWER/LN/EXP/SQRT; UPDATE...FROM (SQLite 3.33+, well below the D1/
-- wrangler-bundled version) is used for the peer-key assignment join — a real JOIN, not a
-- correlated COUNT(*)-per-row subquery.
--
-- PERFORMANCE: two single passes over `contracts` (194,484 rows): (1) one INSERT...SELECT with
-- LEFT JOINs to the Phase-4 rollups (O(n) — every join target is PK/indexed-unique), materializing
-- `contract_regime` (family/division/band/year) once as a TEMP TABLE so both the leaf INSERT and the
-- peer-key UPDATE reuse it instead of recomputing the 21-value CASE map twice; (2) the peer-group
-- counts are three GROUP BY passes over `contract_regime` (fine/mid/coarse), then ONE indexed
-- UPDATE...FROM join to assign effective_peer_key/peer_n — NOT a per-row correlated COUNT(*), which
-- would be O(n) work repeated n times.

-- contract_features gains score_a_bids/peer_has_multi this PRD (group 338, §12.0 [0,1] scale) — an
-- already-applied local table predates those columns, and SQLite has no "ADD COLUMN IF NOT EXISTS",
-- so DROP+CREATE (every run already DELETEs and fully re-INSERTs all rows below, so this is a no-op
-- for data, schema-only for structure) replaces the old CREATE TABLE IF NOT EXISTS.
DROP TABLE IF EXISTS contract_features;
CREATE TABLE contract_features (
  contract_id TEXT PRIMARY KEY REFERENCES contracts(id),
  -- peer + coverage
  effective_peer_key TEXT, peer_n INTEGER,
  coverage_bids INTEGER, coverage_sme INTEGER, coverage_estimate INTEGER,
  coverage_overrun INTEGER, coverage_ocds INTEGER, score_coverage REAL,
  -- A
  bids_received INTEGER, single_offer INTEGER, sme_rate REAL, disq_rate REAL,
  -- B
  is_open_procedure INTEGER, is_direct_award INTEGER, has_exemption INTEGER,
  is_outside_zop INTEGER, is_dps INTEGER, is_meat INTEGER, is_accelerated INTEGER,
  is_framework INTEGER, is_eauction INTEGER, bid_window_days REAL, scoring_regime TEXT,
  -- C
  annex_count INTEGER, cost_overrun_ratio REAL, estimate_dev_ratio REAL,
  value_flag TEXT, has_reason_text INTEGER, first_amend_shock INTEGER,
  -- D
  authority_hhi REAL, bidder_buyer_hhi REAL, repeat_win_intensity REAL,
  sector_win_share REAL, pair_first_date TEXT, edge_age_years REAL, authority_suppliers INTEGER,
  -- E
  date_flag TEXT, eu_funded INTEGER, subcontract_passthrough REAL, corrections_count INTEGER,
  duration_days INTEGER, winner_size TEXT, bidder_nuts TEXT, awarded_to_group INTEGER,
  -- sub-scores [0,1], NULL when unknown
  score_a REAL, score_b REAL, score_c REAL, score_d REAL, score_e REAL,
  score_overall REAL, computed_at TEXT,
  -- A1 leaf, auditable (§5.5/§5.6 PERCENT_RANK floor)
  score_a_bids REAL, peer_has_multi INTEGER
);
CREATE INDEX IF NOT EXISTS idx_contract_features_overall ON contract_features(score_overall);
CREATE INDEX IF NOT EXISTS idx_contract_features_peer ON contract_features(effective_peer_key);

DROP TABLE IF EXISTS contract_regime;
DROP TABLE IF EXISTS peer_fine_counts;
DROP TABLE IF EXISTS peer_mid_counts;
DROP TABLE IF EXISTS peer_coarse_counts;
-- Scoring temp tables too: a run that dies mid-file (e.g. transient D1 lock, retried by
-- import.mjs execWranglerD1File) must be able to re-execute the whole file cleanly.
DROP TABLE IF EXISTS tmp_score_ctx;
DROP TABLE IF EXISTS tmp_a1;
DROP TABLE IF EXISTS tmp_peer_multi;
DROP TABLE IF EXISTS tmp_b1;
DROP TABLE IF EXISTS tmp_c;
DROP TABLE IF EXISTS tmp_d;
DROP TABLE IF EXISTS tmp_diag;

DELETE FROM contract_features;

-- ── contract_regime: family (§5.4/§12.2/§12.3) + peer-key components (§5.2-5.3), computed ONCE ──
-- is_framework_regime: procedure_type ∈ the 5-value ДСП/КС regime set OR dps_contract=1 (§12.3 —
-- contracts.framework is 100% NULL locally, so the OR-on-framework from the original §4.B6 text is
-- dropped; dps_contract is also 100% NULL today but the OR stays so a future re-derive picks it up).
CREATE TABLE contract_regime AS
SELECT
  c.id AS contract_id,
  CASE
    WHEN t.procedure_type IN (
      'Динамична система за покупки', 'Квалификационна система',
      'Ограничена процедура по ДСП', 'Ограничена процедура по КС',
      'Договаряне с предварителна покана за участие по КС'
    ) OR c.dps_contract = 1 THEN 1 ELSE 0
  END AS is_framework_regime,
  CASE
    WHEN t.procedure_type IN (
      'Динамична система за покупки', 'Квалификационна система',
      'Ограничена процедура по ДСП', 'Ограничена процедура по КС',
      'Договаряне с предварителна покана за участие по КС'
    ) OR c.dps_contract = 1 THEN 'framework'
    WHEN t.procedure_type IN ('Открита процедура', 'Публично състезание', 'Събиране на оферти с обява') THEN 'open'
    WHEN t.procedure_type IN ('Ограничена процедура', 'Конкурс за проект - открит', 'Състезателна процедура с договаряне', 'Партньорство за иновации') THEN 'restricted'
    WHEN t.procedure_type IN ('Договаряне с предварителна покана за участие', 'Договаряне с публикуване на обявление за поръчка', 'Договаряне без предварително обявление', 'Договаряне без предварителна покана за участие', 'Договаряне без публикуване на обявление за поръчка') THEN 'negotiated'
    WHEN t.procedure_type IN ('Пряко договаряне', 'Покана до определени лица', 'Конкурс за проект - ограничен') THEN 'direct'
    WHEN t.procedure_type = 'неизвестна' THEN 'unknown'
    ELSE NULL -- completeness guard: verification asserts COUNT(*) WHERE family IS NULL = 0 (§12.2)
  END AS family,
  CASE WHEN t.cpv_code IS NULL OR LENGTH(TRIM(t.cpv_code)) < 2 THEN 'NA' ELSE substr(t.cpv_code, 1, 2) END AS division,
  CASE
    WHEN c.amount_eur IS NULL THEN 'NA'
    WHEN c.amount_eur < 30000 THEN 'XS'
    WHEN c.amount_eur < 200000 THEN 'S'
    WHEN c.amount_eur < 1000000 THEN 'M'
    WHEN c.amount_eur < 10000000 THEN 'L'
    ELSE 'XL'
  END AS band,
  CASE
    WHEN c.signed_at IS NULL OR strftime('%Y', c.signed_at) NOT BETWEEN '2020' AND '2026' THEN 'NA'
    ELSE strftime('%Y', c.signed_at)
  END AS yr,
  c.bids_received AS bids_received_raw
FROM contracts c JOIN tenders t ON t.id = c.tender_id;
CREATE UNIQUE INDEX idx_contract_regime_id ON contract_regime(contract_id);

-- ── 5a: raw leaf values + coverage flags ─────────────────────────────────────────────────────────
WITH
amendment_agg AS (
  -- reason/circumstances are 100% NULL locally (§12.1) → MAX(LENGTH(...)) over all-NULL input is
  -- NULL (SQLite MAX ignores NULLs, returns NULL if every input is NULL) → has_reason_text stays
  -- NULL rather than fabricating 0, per "never fabricate defaults".
  SELECT unp, contract_number, MAX(LENGTH(circumstances)) AS max_circ_len, COUNT(*) AS n
  FROM amendments
  WHERE unp IS NOT NULL AND contract_number IS NOT NULL
  GROUP BY unp, contract_number
),
first_amend AS (
  -- Earliest amendment per (unp, contract_number) — the join key used across the amendments table
  -- (idx_amendments_contract), matched to tenders.source_id / contracts.contract_number (§4.C NEW-C6).
  -- `currency` is carried through so the shock ratio below only compares like-denominated amounts —
  -- amendments.currency is independent of contracts.currency (0000_init.sql:169 vs :118).
  SELECT unp, contract_number, value_delta AS first_delta, published_at AS first_published_at, currency AS first_currency
  FROM (
    SELECT unp, contract_number, value_delta, published_at, currency,
           ROW_NUMBER() OVER (PARTITION BY unp, contract_number ORDER BY published_at ASC, id ASC) AS rn
    FROM amendments
    WHERE unp IS NOT NULL AND contract_number IS NOT NULL
  )
  WHERE rn = 1
)
INSERT INTO contract_features (
  contract_id,
  coverage_bids, coverage_sme, coverage_estimate, coverage_overrun, coverage_ocds, score_coverage,
  bids_received, single_offer, sme_rate, disq_rate,
  is_open_procedure, is_direct_award, has_exemption, is_outside_zop, is_dps, is_meat,
  is_accelerated, is_framework, is_eauction, bid_window_days, scoring_regime,
  annex_count, cost_overrun_ratio, estimate_dev_ratio, value_flag, has_reason_text, first_amend_shock,
  authority_hhi, bidder_buyer_hhi, repeat_win_intensity, sector_win_share, pair_first_date, edge_age_years, authority_suppliers,
  date_flag, eu_funded, subcontract_passthrough, corrections_count, duration_days, winner_size, bidder_nuts, awarded_to_group,
  computed_at
)
SELECT
  c.id,
  -- coverage_bids: bids_received=0 (2,845 rows) is treated as NULL for A-leaves, so it's uncovered too.
  CASE WHEN c.bids_received IS NOT NULL AND c.bids_received <> 0 THEN 1 ELSE 0 END,
  CASE WHEN c.bids_received > 0 AND c.bids_sme IS NOT NULL THEN 1 ELSE 0 END,
  CASE WHEN t.estimated_value_eur IS NOT NULL THEN 1 ELSE 0 END,
  CASE WHEN c.current_value_eur IS NOT NULL OR c.annex_count = 0 THEN 1 ELSE 0 END,
  -- coverage_ocds: OCDS-era enrichment presence (winner_size / bidder NUTS) — a coverage FACET, not
  -- one of the §6.1 score_coverage terms; used for the §10.10 era comparison, not the formula below.
  CASE WHEN c.winner_size IS NOT NULL OR b.nuts IS NOT NULL THEN 1 ELSE 0 END,
  ROUND((
      (CASE WHEN c.bids_received IS NOT NULL AND c.bids_received <> 0 THEN 1.0 ELSE 0 END)
    + (CASE WHEN c.bids_received > 0 AND c.bids_sme IS NOT NULL THEN 0.5 ELSE 0 END)
    + (CASE WHEN c.signing_value_eur IS NOT NULL THEN 1.0 ELSE 0 END)
    + (CASE WHEN c.current_value_eur IS NOT NULL OR c.annex_count = 0 THEN 1.0 ELSE 0 END)
    + (CASE WHEN t.estimated_value_eur IS NOT NULL THEN 0.5 ELSE 0 END)
    + (CASE WHEN t.procedure_type <> 'неизвестна' THEN 1.0 ELSE 0 END)
    + (CASE WHEN ahr.hhi IS NOT NULL THEN 0.5 ELSE 0 END)
  ) / 5.5, 3),
  -- A
  CASE WHEN c.bids_received = 0 THEN NULL ELSE c.bids_received END,
  CASE WHEN c.bids_received = 1 THEN 1 WHEN c.bids_received IS NULL OR c.bids_received = 0 THEN NULL ELSE 0 END,
  CASE WHEN COALESCE(c.bids_received, 0) > 0 AND c.bids_sme IS NOT NULL THEN CAST(c.bids_sme AS REAL) / c.bids_received END,
  CASE WHEN c.bids_received IS NOT NULL AND c.bids_rejected IS NOT NULL
       THEN CAST(c.bids_rejected AS REAL) / NULLIF(c.bids_received + c.bids_rejected, 0) END,
  -- B
  CASE WHEN r.family = 'unknown' THEN NULL WHEN r.family = 'open' THEN 1 ELSE 0 END,
  CASE WHEN r.family = 'unknown' THEN NULL WHEN r.family = 'direct' THEN 1 ELSE 0 END,
  -- has_exemption only meaningful once outside_zop=1; outside_zop is 100% NULL locally (§12.1) so
  -- this stays NULL corpus-wide until a future re-derive populates it.
  CASE WHEN c.outside_zop IS NULL THEN NULL
       WHEN c.outside_zop = 1 THEN CASE WHEN c.exemption_legal_basis IS NOT NULL AND LENGTH(TRIM(c.exemption_legal_basis)) >= 20 THEN 1 ELSE 0 END
       ELSE NULL END,
  c.outside_zop,
  c.dps_contract,
  -- is_meat (§12.6): exact price-only match only; any combo (incl. `Разходи`) counts non-price-only.
  CASE WHEN t.award_criteria IS NULL THEN NULL WHEN t.award_criteria = 'Най-ниска цена' THEN 0 ELSE 1 END,
  c.accelerated,
  c.framework,
  c.eauction,
  CASE WHEN t.deadline_at IS NOT NULL AND t.published_at IS NOT NULL THEN JULIANDAY(t.deadline_at) - JULIANDAY(t.published_at) END,
  CASE WHEN r.is_framework_regime = 1 THEN 'framework' ELSE 'normal' END,
  -- C
  c.annex_count,
  CASE WHEN c.value_flag IN ('annex_suspect', 'value_suspect') THEN NULL
       WHEN c.annex_count = 0 THEN 1.0
       WHEN c.signing_value_eur > 0 AND c.current_value_eur IS NOT NULL THEN c.current_value_eur / c.signing_value_eur
       ELSE NULL END,
  CASE WHEN r.is_framework_regime = 1 THEN NULL
       WHEN t.procedure_type = 'неизвестна' THEN NULL
       WHEN c.value_flag IN ('value_low', 'value_suspect') THEN NULL
       WHEN t.estimated_value_eur IS NULL OR c.signing_value_eur IS NULL THEN NULL
       ELSE ABS(c.signing_value_eur - t.estimated_value_eur) / NULLIF(t.estimated_value_eur, 0) END,
  c.value_flag,
  CASE WHEN aa.n IS NULL OR aa.max_circ_len IS NULL THEN NULL WHEN aa.max_circ_len >= 50 THEN 1 ELSE 0 END,
  -- NULL (not 0) whenever the ratio isn't computable — an unscorable row must stay unknown, not
  -- silently read as "no shock" (mirrors the has_reason_text NULL-propagation above). Requires the
  -- amendment's currency to match the contract's booking currency (`c.currency`) since value_delta
  -- is denominated in amendments.currency, independent of the contract's.
  CASE WHEN fa.first_delta IS NULL THEN NULL
       WHEN c.signing_value IS NULL OR c.signing_value <= 0 THEN NULL
       WHEN fa.first_currency IS NOT NULL AND (c.currency IS NULL OR fa.first_currency <> c.currency) THEN NULL
       WHEN fa.first_delta > 0 AND fa.first_delta > 0.30 * c.signing_value
            AND (JULIANDAY(fa.first_published_at) - JULIANDAY(c.signed_at)) < 90 THEN 1
       ELSE 0 END,
  -- D
  ahr.hhi,
  bhr.buyer_hhi,
  CASE WHEN fp.contracts IS NOT NULL AND at.contracts IS NOT NULL THEN fp.contracts * 1.0 / NULLIF(at.contracts, 0) END,
  sc.win_share,
  fp.first_date,
  CASE WHEN c.signed_at IS NOT NULL AND fp.first_date IS NOT NULL THEN (JULIANDAY(c.signed_at) - JULIANDAY(fp.first_date)) / 365.25 END,
  at.suppliers,
  -- E
  c.date_flag,
  c.eu_funded,
  CASE WHEN c.subcontract_value IS NOT NULL AND c.signing_value IS NOT NULL THEN c.subcontract_value * 1.0 / NULLIF(c.signing_value, 0) END,
  t.corrections_count,
  c.duration_days,
  c.winner_size,
  b.nuts,
  c.awarded_to_group,
  datetime('now')
FROM contracts c
JOIN tenders t ON t.id = c.tender_id
JOIN bidders b ON b.id = c.bidder_id
JOIN contract_regime r ON r.contract_id = c.id
LEFT JOIN authority_health_rollup ahr ON ahr.authority_id = t.authority_id
LEFT JOIN bidder_health_rollup bhr ON bhr.bidder_id = c.bidder_id
LEFT JOIN authority_totals at ON at.authority_id = t.authority_id
LEFT JOIN flow_pairs fp ON fp.authority_id = t.authority_id AND fp.bidder_id = c.bidder_id
LEFT JOIN sector_concentration sc
  ON sc.cpv_division = substr(t.cpv_code, 1, 2) AND sc.bidder_id = c.bidder_id
  AND t.cpv_code IS NOT NULL AND LENGTH(t.cpv_code) >= 2
LEFT JOIN amendment_agg aa ON aa.unp = t.source_id AND aa.contract_number = c.contract_number
LEFT JOIN first_amend fa ON fa.unp = t.source_id AND fa.contract_number = c.contract_number;

-- ── 5b: effective_peer_key selection (§5.6) ─────────────────────────────────────────────────────
-- Three grouped count tables, built ONCE via GROUP BY (not a correlated COUNT(*) per contract row),
-- restricted to bids_received >= 1 per spec. Finest key with peer_n >= 30 wins; else 'GLOBAL'.
CREATE TABLE peer_fine_counts AS
  SELECT division || ':' || band || ':' || family || ':' || yr AS peer_key, COUNT(*) AS n
  FROM contract_regime WHERE bids_received_raw >= 1 GROUP BY peer_key;
CREATE UNIQUE INDEX idx_peer_fine_key ON peer_fine_counts(peer_key);

CREATE TABLE peer_mid_counts AS
  SELECT division || ':' || band || ':' || family AS peer_key, COUNT(*) AS n
  FROM contract_regime WHERE bids_received_raw >= 1 GROUP BY peer_key;
CREATE UNIQUE INDEX idx_peer_mid_key ON peer_mid_counts(peer_key);

CREATE TABLE peer_coarse_counts AS
  SELECT division AS peer_key, COUNT(*) AS n
  FROM contract_regime WHERE bids_received_raw >= 1 GROUP BY peer_key;
CREATE UNIQUE INDEX idx_peer_coarse_key ON peer_coarse_counts(peer_key);

UPDATE contract_features
SET effective_peer_key = x.eff_key, peer_n = x.eff_n
FROM (
  SELECT
    r.contract_id,
    CASE
      WHEN fc.n >= 30 THEN r.division || ':' || r.band || ':' || r.family || ':' || r.yr
      WHEN mc.n >= 30 THEN r.division || ':' || r.band || ':' || r.family
      WHEN cc.n >= 30 THEN r.division
      ELSE 'GLOBAL'
    END AS eff_key,
    CASE
      WHEN fc.n >= 30 THEN fc.n
      WHEN mc.n >= 30 THEN mc.n
      WHEN cc.n >= 30 THEN cc.n
      ELSE (SELECT COUNT(*) FROM contract_regime WHERE bids_received_raw >= 1)
    END AS eff_n
  FROM contract_regime r
  LEFT JOIN peer_fine_counts fc ON fc.peer_key = r.division || ':' || r.band || ':' || r.family || ':' || r.yr
  LEFT JOIN peer_mid_counts mc ON mc.peer_key = r.division || ':' || r.band || ':' || r.family
  LEFT JOIN peer_coarse_counts cc ON cc.peer_key = r.division
) AS x
WHERE x.contract_id = contract_features.contract_id;

DROP TABLE contract_regime;
DROP TABLE peer_fine_counts;
DROP TABLE peer_mid_counts;
DROP TABLE peer_coarse_counts;

-- ── 5c: per-pillar score UPDATEs (§3, §4, §12 — [0,1] scale, §12.0) ─────────────────────────────
-- tmp_score_ctx: raw contract/tender columns needed for scoring but not already carried on
-- contract_features (procedure_type for B1 §12.2, cpv_division for B3, signed_at for the C1
-- maturity gate, subcontractor_eik/subcontract_value for E1, exemption_legal_basis for B2).
-- One O(n) join pass, reused by both the B- and E-pillar UPDATEs below (dropped at the very end).
CREATE TABLE tmp_score_ctx AS
SELECT c.id AS contract_id, t.procedure_type,
  CASE WHEN t.cpv_code IS NULL OR LENGTH(TRIM(t.cpv_code)) < 2 THEN NULL ELSE substr(t.cpv_code, 1, 2) END AS cpv_division,
  c.signed_at, c.subcontractor_eik, c.subcontract_value, c.exemption_legal_basis
FROM contracts c JOIN tenders t ON t.id = c.tender_id;
CREATE UNIQUE INDEX idx_tmp_score_ctx ON tmp_score_ctx(contract_id);

-- A1 leaf (score_a_bids, stored — auditable §5.5/§5.6) + peer_has_multi (drives the AC's PERCENT_RANK
-- floor proof). PERCENT_RANK is natively [0,1]; the GLOBAL fallback band (§4.A) is written pre-divided.
CREATE TABLE tmp_a1 AS
SELECT contract_id,
  CASE
    WHEN effective_peer_key <> 'GLOBAL'
      THEN PERCENT_RANK() OVER (PARTITION BY effective_peer_key ORDER BY bids_received)
    WHEN bids_received = 1 THEN 0.0
    WHEN bids_received = 2 THEN 0.40
    WHEN bids_received = 3 THEN 0.60
    WHEN bids_received = 4 THEN 0.70
    WHEN bids_received = 5 THEN 0.80
    WHEN bids_received IN (6, 7) THEN 0.90
    ELSE 1.0
  END AS a1
FROM contract_features
WHERE bids_received >= 1;
CREATE UNIQUE INDEX idx_tmp_a1 ON tmp_a1(contract_id);

UPDATE contract_features SET score_a_bids = tmp_a1.a1
FROM tmp_a1 WHERE tmp_a1.contract_id = contract_features.contract_id;

CREATE TABLE tmp_peer_multi AS
SELECT effective_peer_key, MAX(CASE WHEN bids_received >= 2 THEN 1 ELSE 0 END) AS has_multi
FROM contract_features WHERE bids_received IS NOT NULL GROUP BY effective_peer_key;
CREATE UNIQUE INDEX idx_tmp_peer_multi ON tmp_peer_multi(effective_peer_key);

UPDATE contract_features SET peer_has_multi = tmp_peer_multi.has_multi
FROM tmp_peer_multi WHERE tmp_peer_multi.effective_peer_key = contract_features.effective_peer_key;

DROP TABLE tmp_a1;
DROP TABLE tmp_peer_multi;

-- ── Pillar A (Contestability, w=.30): weighted mean of A1(w3)/A3 sme-rate(w1) over non-NULL leaves;
-- A4 disqualification modifier -0.10 when disq>0.5 & bids=1; A5 e-auction bonus +0.10; clamp [0,1].
UPDATE contract_features
SET score_a = CASE
  WHEN score_a_bids IS NULL AND sme_rate IS NULL THEN NULL
  ELSE ROUND(MAX(0.0, MIN(1.0,
    ( COALESCE(score_a_bids, 0) * (CASE WHEN score_a_bids IS NOT NULL THEN 3 ELSE 0 END)
    + COALESCE(sme_rate, 0)     * (CASE WHEN sme_rate     IS NOT NULL THEN 1 ELSE 0 END)
    ) / ( (CASE WHEN score_a_bids IS NOT NULL THEN 3 ELSE 0 END)
        + (CASE WHEN sme_rate     IS NOT NULL THEN 1 ELSE 0 END) )
    + CASE WHEN disq_rate > 0.5 AND bids_received = 1 THEN -0.10 ELSE 0 END
    + CASE WHEN is_eauction = 1 THEN 0.10 ELSE 0 END
  )), 3)
END;

-- ── Pillar B (Procedure openness, w=.15): B1 is the §12.2 frozen 21-value map (NULL for 'неизвестна'
-- and the 2 pure framework-establishment procedures — Динамична система за покупки / Квалификационна
-- система — which are a regime tag, not an award-openness route, §12.2 last row); B2 outside-ZOP
-- penalty (all-NULL locally, §12.1, expression kept); B3 complex-service price-only -0.05 (§12.6
-- exact-match test); B4 accelerated -0.15; B5 short bid-window on open & non-accelerated -0.10.
-- `unmapped` proves the §12.2 completeness guard (surfaced in the summary SELECT below).
CREATE TABLE tmp_b1 AS
SELECT cf.contract_id,
  CASE ctx.procedure_type
    WHEN 'Открита процедура' THEN 1.00
    WHEN 'Публично състезание' THEN 0.80
    WHEN 'Събиране на оферти с обява' THEN 0.70
    WHEN 'Ограничена процедура' THEN 0.60
    WHEN 'Ограничена процедура по ДСП' THEN 0.60
    WHEN 'Ограничена процедура по КС' THEN 0.60
    WHEN 'Конкурс за проект - открит' THEN 0.60
    WHEN 'Състезателна процедура с договаряне' THEN 0.60
    WHEN 'Партньорство за иновации' THEN 0.60
    WHEN 'Договаряне с предварителна покана за участие' THEN 0.40
    WHEN 'Договаряне с предварителна покана за участие по КС' THEN 0.40
    WHEN 'Договаряне с публикуване на обявление за поръчка' THEN 0.40
    WHEN 'Договаряне без предварително обявление' THEN 0.20
    WHEN 'Договаряне без предварителна покана за участие' THEN 0.20
    WHEN 'Договаряне без публикуване на обявление за поръчка' THEN 0.20
    WHEN 'Покана до определени лица' THEN 0.20
    WHEN 'Конкурс за проект - ограничен' THEN 0.20
    WHEN 'Пряко договаряне' THEN 0.00
    WHEN 'неизвестна' THEN NULL
    WHEN 'Динамична система за покупки' THEN NULL
    WHEN 'Квалификационна система' THEN NULL
    ELSE NULL
  END AS b1,
  CASE WHEN ctx.procedure_type IS NOT NULL AND ctx.procedure_type NOT IN (
    'Открита процедура', 'Публично състезание', 'Събиране на оферти с обява', 'Ограничена процедура',
    'Ограничена процедура по ДСП', 'Ограничена процедура по КС', 'Конкурс за проект - открит',
    'Състезателна процедура с договаряне', 'Партньорство за иновации',
    'Договаряне с предварителна покана за участие', 'Договаряне с предварителна покана за участие по КС',
    'Договаряне с публикуване на обявление за поръчка', 'Договаряне без предварително обявление',
    'Договаряне без предварителна покана за участие', 'Договаряне без публикуване на обявление за поръчка',
    'Покана до определени лица', 'Конкурс за проект - ограничен', 'Пряко договаряне', 'неизвестна',
    'Динамична система за покупки', 'Квалификационна система'
  ) THEN 1 ELSE 0 END AS unmapped
FROM contract_features cf JOIN tmp_score_ctx ctx ON ctx.contract_id = cf.contract_id;
CREATE UNIQUE INDEX idx_tmp_b1 ON tmp_b1(contract_id);

-- Stashed (not SELECTed) here: local D1 runs the whole file as one batch, and a bare SELECT on
-- tmp_b1 would leave a cursor that makes the DROP TABLE below fail with SQLITE_LOCKED. The final
-- summary SELECT surfaces it as unmapped_procedure_rows.
CREATE TABLE tmp_diag AS
SELECT COUNT(*) AS unmapped_procedure_rows FROM tmp_b1 WHERE unmapped = 1;

UPDATE contract_features
SET score_b = CASE
  WHEN w.b1 IS NULL THEN NULL
  ELSE ROUND(MAX(0.0, MIN(1.0,
    w.b1
    + CASE WHEN contract_features.is_outside_zop = 1 AND w.exemption_legal_basis IS NULL THEN -0.20
           WHEN contract_features.is_outside_zop = 1 AND LENGTH(TRIM(COALESCE(w.exemption_legal_basis, ''))) < 20 THEN -0.10
           ELSE 0 END
    + CASE WHEN w.cpv_division IN ('71', '72', '73', '79', '80', '85') AND contract_features.is_meat = 0 THEN -0.05 ELSE 0 END
    + CASE WHEN contract_features.is_accelerated = 1 THEN -0.15 ELSE 0 END
    -- >= 0 floor: negative windows are date errors (deadline before publication), not short windows
    + CASE WHEN contract_features.bid_window_days >= 0 AND contract_features.bid_window_days < 15
             AND contract_features.is_open_procedure = 1
             AND contract_features.is_accelerated = 0 THEN -0.10 ELSE 0 END
  )), 3)
END
FROM (SELECT b1.contract_id, b1.b1, ctx.exemption_legal_basis, ctx.cpv_division
      FROM tmp_b1 b1 JOIN tmp_score_ctx ctx ON ctx.contract_id = b1.contract_id) AS w
WHERE w.contract_id = contract_features.contract_id;

DROP TABLE tmp_b1;

-- ── Pillar C (Value integrity, w=.25): C1 annex band + maturity gate; C2 overrun band (leaf already
-- NULL-gated for annex_suspect/value_suspect, §3.4); C3 estimate-accuracy band (leaf already NULL-
-- gated for framework/synthetic/value_low/value_suspect, §3.4/§4.C); equal-weighted mean of the
-- non-NULL leaves; C4 boilerplate-reason penalty -0.15 (all-NULL locally, §12.1, expression kept);
-- C6 first-amendment-shock penalty -0.10; `review` -> whole pillar x0.90; `value_suspect` -> pillar
-- NULL outright (C1/C3 would otherwise still compute — the gate table requires suppressing all of C).
CREATE TABLE tmp_c AS
SELECT cf.contract_id,
  CASE
    WHEN (JULIANDAY('now') - JULIANDAY(ctx.signed_at)) < 90 AND cf.annex_count = 0 THEN NULL
    WHEN cf.annex_count IS NULL THEN NULL
    WHEN cf.annex_count = 0 THEN 1.0
    WHEN cf.annex_count = 1 THEN 0.85
    WHEN cf.annex_count = 2 THEN 0.70
    WHEN cf.annex_count = 3 THEN 0.50
    WHEN cf.annex_count = 4 THEN 0.30
    ELSE 0.0
  END AS c1,
  -- C2 uses the spec's "compact" linear variant (1.2x -> 0.80, 1.5x -> 0.50), not the §4.C
  -- piecewise band (1.2x -> 0.60) — the two are inconsistent in the spec and §12 doesn't
  -- resolve it; linear is chosen as the smoother, easier-to-explain mapping.
  CASE
    WHEN cf.cost_overrun_ratio IS NULL THEN NULL
    WHEN cf.cost_overrun_ratio <= 1.0 THEN 1.0
    WHEN cf.cost_overrun_ratio >= 2.0 THEN 0.0
    ELSE MAX(0.0, MIN(1.0, 1.0 - (cf.cost_overrun_ratio - 1.0)))
  END AS c2,
  CASE
    WHEN cf.estimate_dev_ratio IS NULL THEN NULL
    WHEN cf.estimate_dev_ratio <= 0.05 THEN 1.0
    WHEN cf.estimate_dev_ratio <= 0.30 THEN 1.0 - 0.30 * (cf.estimate_dev_ratio - 0.05) / 0.25
    WHEN cf.estimate_dev_ratio <= 1.00 THEN 0.70 - 0.40 * (cf.estimate_dev_ratio - 0.30) / 0.70
    WHEN cf.estimate_dev_ratio <= 2.00 THEN 0.30 - 0.30 * (cf.estimate_dev_ratio - 1.00) / 1.00
    ELSE 0.0
  END AS c3
FROM contract_features cf JOIN tmp_score_ctx ctx ON ctx.contract_id = cf.contract_id;
CREATE UNIQUE INDEX idx_tmp_c ON tmp_c(contract_id);

UPDATE contract_features
SET score_c = CASE
  WHEN contract_features.value_flag = 'value_suspect' THEN NULL
  WHEN w.n_leaves = 0 THEN NULL
  ELSE ROUND(
    MAX(0.0, MIN(1.0,
      w.leaf_sum / w.n_leaves
      + CASE WHEN contract_features.has_reason_text = 0 THEN -0.15 ELSE 0 END
      + CASE WHEN contract_features.first_amend_shock = 1 THEN -0.10 ELSE 0 END
    )) * (CASE WHEN contract_features.value_flag = 'review' THEN 0.90 ELSE 1.0 END)
  , 3)
END
FROM (
  SELECT contract_id,
    COALESCE(c1, 0) + COALESCE(c2, 0) + COALESCE(c3, 0) AS leaf_sum,
    (CASE WHEN c1 IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN c2 IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN c3 IS NOT NULL THEN 1 ELSE 0 END) AS n_leaves
  FROM tmp_c
) AS w
WHERE w.contract_id = contract_features.contract_id;

DROP TABLE tmp_c;

-- ── Pillar D (Relationship health, w=.20): D1/D2 buyer/supplier HHI-inverse averaged into a single
-- 0.1-weight context term (§4.D grain caveat); D3 repeat-win intensity w=0.5 (primary contract-
-- discriminating leaf); D4 edge-novelty band w=0.3; D5 sector win-share w=0.1. Weighted mean over
-- non-NULL components, renormalized; clamp [0,1].
CREATE TABLE tmp_d AS
SELECT cf.contract_id,
  CASE
    WHEN cf.authority_hhi IS NULL AND cf.bidder_buyer_hhi IS NULL THEN NULL
    ELSE (
      COALESCE(MAX(0.0, MIN(1.0, 1.0 - cf.authority_hhi)), MAX(0.0, MIN(1.0, 1.0 - cf.bidder_buyer_hhi)))
      + COALESCE(MAX(0.0, MIN(1.0, 1.0 - cf.bidder_buyer_hhi)), MAX(0.0, MIN(1.0, 1.0 - cf.authority_hhi)))
    ) / 2.0
  END AS d12,
  CASE WHEN cf.repeat_win_intensity IS NOT NULL THEN MAX(0.0, MIN(1.0, 1.0 - cf.repeat_win_intensity)) END AS d3,
  CASE
    WHEN cf.edge_age_years IS NULL THEN NULL
    WHEN cf.edge_age_years < 1 THEN 1.00
    WHEN cf.edge_age_years < 2 THEN 0.80
    WHEN cf.edge_age_years < 4 THEN 0.55
    WHEN cf.edge_age_years < 7 THEN 0.30
    ELSE 0.10
  END AS d4,
  CASE WHEN cf.sector_win_share IS NOT NULL THEN MAX(0.0, MIN(1.0, 1.0 - cf.sector_win_share)) END AS d5
FROM contract_features cf;
CREATE UNIQUE INDEX idx_tmp_d ON tmp_d(contract_id);

UPDATE contract_features
SET score_d = CASE WHEN w.wsum = 0 THEN NULL ELSE ROUND(MAX(0.0, MIN(1.0, w.wnum / w.wsum)), 3) END
FROM (
  SELECT contract_id,
    (CASE WHEN d12 IS NOT NULL THEN 0.1 ELSE 0 END) + (CASE WHEN d3 IS NOT NULL THEN 0.5 ELSE 0 END)
      + (CASE WHEN d4 IS NOT NULL THEN 0.3 ELSE 0 END) + (CASE WHEN d5 IS NOT NULL THEN 0.1 ELSE 0 END) AS wsum,
    COALESCE(d12, 0) * (CASE WHEN d12 IS NOT NULL THEN 0.1 ELSE 0 END)
      + COALESCE(d3, 0) * (CASE WHEN d3 IS NOT NULL THEN 0.5 ELSE 0 END)
      + COALESCE(d4, 0) * (CASE WHEN d4 IS NOT NULL THEN 0.3 ELSE 0 END)
      + COALESCE(d5, 0) * (CASE WHEN d5 IS NOT NULL THEN 0.1 ELSE 0 END) AS wnum
  FROM tmp_d
) AS w
WHERE w.contract_id = contract_features.contract_id;

DROP TABLE tmp_d;

-- ── Pillar E (Transparency/data quality, w=.10): base 1.0 minus penalties, always computable (no
-- NULL-propagating leaf — missing inputs simply contribute no penalty, per §4.E). E1 undisclosed
-- subcontract -0.05; E2 date_flag -0.10; E3 pass-through -0.10/-0.15; E4 corrigenda (all-NULL
-- locally, §12.1, expression kept); E5 lock-in -0.10/-0.15 keyed on scoring_regime (§12.3, NOT
-- framework=0 — contracts.framework is 100% NULL locally). Floored at 0.
UPDATE contract_features
SET score_e = ROUND(MAX(0.0,
    1.0
    - CASE WHEN ctx.subcontractor_eik IS NOT NULL AND ctx.subcontract_value IS NULL THEN 0.05 ELSE 0 END
    - CASE WHEN contract_features.date_flag = 'signed_after_publication' THEN 0.10 ELSE 0 END
    - CASE WHEN contract_features.subcontract_passthrough >= 1.0 THEN 0.15
           WHEN contract_features.subcontract_passthrough > 0.70 THEN 0.10 ELSE 0 END
    - CASE WHEN contract_features.corrections_count >= 3 THEN 0.10 ELSE 0 END
    - CASE WHEN contract_features.duration_days > 1825 AND contract_features.scoring_regime <> 'framework' THEN 0.15
           WHEN contract_features.duration_days > 1095 AND contract_features.scoring_regime <> 'framework' THEN 0.10 ELSE 0 END
  ), 3)
FROM tmp_score_ctx ctx
WHERE ctx.contract_id = contract_features.contract_id;

DROP TABLE tmp_score_ctx;

-- ── score_overall = ROUND(0.6*wmean + 0.4*worst, 3) over non-NULL pillars, renormalized (§3.3/§12.0).
-- Withheld (NULL) for value_suspect (§3.4) and score_coverage < 0.40 (§6.2 withhold rule) — the only
-- two NULL paths, matching the AC's >=90%-scored expectation.
UPDATE contract_features
SET score_overall = CASE
  WHEN contract_features.value_flag = 'value_suspect' THEN NULL
  WHEN contract_features.score_coverage < 0.40 THEN NULL
  WHEN w.wsum = 0 THEN NULL
  ELSE ROUND(0.6 * w.wmean + 0.4 * w.worst, 3)
END
FROM (
  SELECT contract_id,
    (CASE WHEN score_a IS NOT NULL THEN 0.30 ELSE 0 END) + (CASE WHEN score_b IS NOT NULL THEN 0.15 ELSE 0 END)
      + (CASE WHEN score_c IS NOT NULL THEN 0.25 ELSE 0 END) + (CASE WHEN score_d IS NOT NULL THEN 0.20 ELSE 0 END)
      + (CASE WHEN score_e IS NOT NULL THEN 0.10 ELSE 0 END) AS wsum,
    ( COALESCE(score_a, 0) * 0.30 + COALESCE(score_b, 0) * 0.15 + COALESCE(score_c, 0) * 0.25
    + COALESCE(score_d, 0) * 0.20 + COALESCE(score_e, 0) * 0.10 )
    / NULLIF(
      (CASE WHEN score_a IS NOT NULL THEN 0.30 ELSE 0 END) + (CASE WHEN score_b IS NOT NULL THEN 0.15 ELSE 0 END)
        + (CASE WHEN score_c IS NOT NULL THEN 0.25 ELSE 0 END) + (CASE WHEN score_d IS NOT NULL THEN 0.20 ELSE 0 END)
        + (CASE WHEN score_e IS NOT NULL THEN 0.10 ELSE 0 END), 0) AS wmean,
    MIN(COALESCE(score_a, 1.0), COALESCE(score_b, 1.0), COALESCE(score_c, 1.0), COALESCE(score_d, 1.0), COALESCE(score_e, 1.0)) AS worst
  FROM contract_features
) AS w
WHERE w.contract_id = contract_features.contract_id;

-- Summary (last result set printed by `wrangler d1 execute`). unmapped_family_rows must be 0 — the
-- §12.2 completeness guard for the 21-value procedure_type vocabulary. contract_features_rows must
-- equal contracts_rows — the leaf INSERT inner-joins tenders/bidders/contract_regime, so a future
-- orphaned contracts.bidder_id/tender_id (SQLite doesn't enforce FKs unless PRAGMA foreign_keys=ON)
-- would silently drop that contract from the feature store without this check.
SELECT
  (SELECT COUNT(*) FROM contracts) AS contracts_rows,
  (SELECT COUNT(*) FROM contract_features) AS contract_features_rows,
  (SELECT unmapped_procedure_rows FROM tmp_diag) AS unmapped_procedure_rows,
  (SELECT COUNT(*) FROM contract_features WHERE score_coverage IS NULL) AS null_coverage_rows,
  (SELECT COUNT(*) FROM contract_features WHERE effective_peer_key IS NULL) AS null_peer_key_rows,
  (SELECT COUNT(*) FROM contract_features WHERE scoring_regime = 'framework') AS framework_regime_rows,
  (SELECT COUNT(*) FROM contract_features WHERE single_offer = 1) AS single_offer_rows,
  (SELECT COUNT(*) FROM contract_features WHERE score_overall IS NOT NULL) AS scored_rows,
  (SELECT COUNT(*) FROM contract_features WHERE value_flag = 'value_suspect' AND (score_overall IS NOT NULL OR score_c IS NOT NULL)) AS value_suspect_leak_rows,
  (SELECT COUNT(*) FROM contract_features WHERE value_flag = 'annex_suspect' AND (cost_overrun_ratio IS NOT NULL OR score_c IS NULL)) AS annex_suspect_bad_rows,
  (SELECT COUNT(*) FROM contract_features WHERE single_offer = 1 AND score_a_bids > 0 AND peer_has_multi = 1) AS a1_floor_violations,
  (SELECT COUNT(*) FROM contract_features cf JOIN contracts c ON c.id = cf.contract_id JOIN tenders t ON t.id = c.tender_id
     WHERE t.procedure_type = 'Пряко договаряне' AND cf.score_b <> 0) AS direct_award_b1_nonzero,
  -- Nested 3+3 (not one 6-term UNION ALL chain): local D1 enforces a low
  -- SQLITE_MAX_COMPOUND_SELECT, so a flat 6-term compound fails with
  -- "too many terms in compound SELECT". Each inner compound stays ≤ 3 terms.
  (SELECT MIN(x) FROM (
     SELECT x FROM (SELECT score_a AS x FROM contract_features WHERE score_a IS NOT NULL
       UNION ALL SELECT score_b FROM contract_features WHERE score_b IS NOT NULL
       UNION ALL SELECT score_c FROM contract_features WHERE score_c IS NOT NULL)
     UNION ALL
     SELECT x FROM (SELECT score_d AS x FROM contract_features WHERE score_d IS NOT NULL
       UNION ALL SELECT score_e FROM contract_features WHERE score_e IS NOT NULL
       UNION ALL SELECT score_overall FROM contract_features WHERE score_overall IS NOT NULL))) AS min_any_score,
  (SELECT MAX(x) FROM (
     SELECT x FROM (SELECT score_a AS x FROM contract_features WHERE score_a IS NOT NULL
       UNION ALL SELECT score_b FROM contract_features WHERE score_b IS NOT NULL
       UNION ALL SELECT score_c FROM contract_features WHERE score_c IS NOT NULL)
     UNION ALL
     SELECT x FROM (SELECT score_d AS x FROM contract_features WHERE score_d IS NOT NULL
       UNION ALL SELECT score_e FROM contract_features WHERE score_e IS NOT NULL
       UNION ALL SELECT score_overall FROM contract_features WHERE score_overall IS NOT NULL))) AS max_any_score;

-- ── 5e: aggregate UI rollups — six *_quality_totals grains (§7.4/§9/§12.7) ──────────────────────
-- Universal rule (§9): the `score_overall`/`score_X IS NOT NULL` mask excludes unknown/value_suspect
-- rows from BOTH the numerator and the denominator of every weighted average (CASE inside SUM on
-- both sides) — `total_contracts` still counts them via COUNT(*). Authority/bidder are value-weighted
-- with the 15% single-contract cap (§7.4 literal `MIN(amount_eur, 0.15*SUM(...) OVER (PARTITION BY
-- ...))`); sector/region/funding are value-weighted uncapped; year is count-weighted (`AVG`, §9) for
-- year-over-year comparability. CREATE TABLE IF NOT EXISTS + DELETE + INSERT, same idiom as
-- derive-health.sql (§12.7) — these tables never change shape across re-derives, unlike
-- contract_features above.

CREATE TABLE IF NOT EXISTS authority_quality_totals (
  authority_id TEXT PRIMARY KEY REFERENCES authorities(id), name TEXT NOT NULL, type_group TEXT,
  avg_overall REAL, avg_a REAL, avg_b REAL, avg_c REAL, avg_d REAL, avg_e REAL,
  total_contracts INTEGER NOT NULL, scored_contracts INTEGER NOT NULL, unknown_contracts INTEGER,
  single_offer_count INTEGER, direct_award_count INTEGER, amended_count INTEGER,
  mean_coverage REAL, computed_at TEXT
);
DELETE FROM authority_quality_totals;
WITH w AS (
  SELECT t.authority_id AS aid, cf.*, c.amount_eur,
         MIN(c.amount_eur, 0.15 * SUM(c.amount_eur) OVER (PARTITION BY t.authority_id)) AS wt
  FROM contract_features cf
  JOIN contracts c ON c.id = cf.contract_id
  JOIN tenders t ON t.id = c.tender_id
  WHERE c.amount_eur IS NOT NULL
)
INSERT INTO authority_quality_totals
SELECT w.aid, a.name, a.type_group,
  ROUND(SUM(CASE WHEN w.score_overall IS NOT NULL THEN w.score_overall * w.wt END) / NULLIF(SUM(CASE WHEN w.score_overall IS NOT NULL THEN w.wt END), 0), 3),
  ROUND(SUM(CASE WHEN w.score_a IS NOT NULL THEN w.score_a * w.wt END) / NULLIF(SUM(CASE WHEN w.score_a IS NOT NULL THEN w.wt END), 0), 3),
  ROUND(SUM(CASE WHEN w.score_b IS NOT NULL THEN w.score_b * w.wt END) / NULLIF(SUM(CASE WHEN w.score_b IS NOT NULL THEN w.wt END), 0), 3),
  ROUND(SUM(CASE WHEN w.score_c IS NOT NULL THEN w.score_c * w.wt END) / NULLIF(SUM(CASE WHEN w.score_c IS NOT NULL THEN w.wt END), 0), 3),
  ROUND(SUM(CASE WHEN w.score_d IS NOT NULL THEN w.score_d * w.wt END) / NULLIF(SUM(CASE WHEN w.score_d IS NOT NULL THEN w.wt END), 0), 3),
  ROUND(SUM(CASE WHEN w.score_e IS NOT NULL THEN w.score_e * w.wt END) / NULLIF(SUM(CASE WHEN w.score_e IS NOT NULL THEN w.wt END), 0), 3),
  COUNT(*),
  SUM(CASE WHEN w.score_overall IS NOT NULL THEN 1 ELSE 0 END),
  SUM(CASE WHEN w.score_overall IS NULL THEN 1 ELSE 0 END),
  SUM(CASE WHEN w.single_offer = 1 THEN 1 ELSE 0 END),
  SUM(CASE WHEN w.is_direct_award = 1 THEN 1 ELSE 0 END),
  SUM(CASE WHEN w.annex_count > 0 THEN 1 ELSE 0 END),
  ROUND(SUM(w.score_coverage * w.amount_eur) / NULLIF(SUM(w.amount_eur), 0), 3),
  datetime('now')
FROM w JOIN authorities a ON a.id = w.aid
GROUP BY w.aid;

CREATE TABLE IF NOT EXISTS bidder_quality_totals (
  bidder_id TEXT PRIMARY KEY REFERENCES bidders(id), name TEXT NOT NULL,
  avg_overall REAL, avg_c REAL, avg_d REAL, buyer_hhi REAL,
  total_contracts INTEGER NOT NULL, scored_contracts INTEGER NOT NULL, amended_count INTEGER,
  mean_coverage REAL, computed_at TEXT
);
DELETE FROM bidder_quality_totals;
WITH w AS (
  SELECT c.bidder_id AS bid, cf.*, c.amount_eur,
         MIN(c.amount_eur, 0.15 * SUM(c.amount_eur) OVER (PARTITION BY c.bidder_id)) AS wt
  FROM contract_features cf
  JOIN contracts c ON c.id = cf.contract_id
  WHERE c.amount_eur IS NOT NULL
)
INSERT INTO bidder_quality_totals
SELECT w.bid, b.name,
  ROUND(SUM(CASE WHEN w.score_overall IS NOT NULL THEN w.score_overall * w.wt END) / NULLIF(SUM(CASE WHEN w.score_overall IS NOT NULL THEN w.wt END), 0), 3),
  ROUND(SUM(CASE WHEN w.score_c IS NOT NULL THEN w.score_c * w.wt END) / NULLIF(SUM(CASE WHEN w.score_c IS NOT NULL THEN w.wt END), 0), 3),
  ROUND(SUM(CASE WHEN w.score_d IS NOT NULL THEN w.score_d * w.wt END) / NULLIF(SUM(CASE WHEN w.score_d IS NOT NULL THEN w.wt END), 0), 3),
  MAX(w.bidder_buyer_hhi),
  COUNT(*),
  SUM(CASE WHEN w.score_overall IS NOT NULL THEN 1 ELSE 0 END),
  SUM(CASE WHEN w.annex_count > 0 THEN 1 ELSE 0 END),
  ROUND(SUM(w.score_coverage * w.amount_eur) / NULLIF(SUM(w.amount_eur), 0), 3),
  datetime('now')
FROM w JOIN bidders b ON b.id = w.bid
GROUP BY w.bid;

CREATE TABLE IF NOT EXISTS sector_quality_totals (        -- CPV division
  division TEXT PRIMARY KEY, avg_overall REAL, avg_a REAL, avg_c REAL,
  total_contracts INTEGER NOT NULL, scored_contracts INTEGER, single_offer_pct REAL,
  direct_award_pct REAL, mean_coverage REAL, computed_at TEXT
);
DELETE FROM sector_quality_totals;
WITH w AS (
  SELECT CASE WHEN t.cpv_code IS NULL OR LENGTH(TRIM(t.cpv_code)) < 2 THEN 'NA' ELSE substr(t.cpv_code, 1, 2) END AS division,
         cf.*, c.amount_eur
  FROM contract_features cf
  JOIN contracts c ON c.id = cf.contract_id
  JOIN tenders t ON t.id = c.tender_id
  WHERE c.amount_eur IS NOT NULL
)
INSERT INTO sector_quality_totals
SELECT w.division,
  ROUND(SUM(CASE WHEN w.score_overall IS NOT NULL THEN w.score_overall * w.amount_eur END) / NULLIF(SUM(CASE WHEN w.score_overall IS NOT NULL THEN w.amount_eur END), 0), 3),
  ROUND(SUM(CASE WHEN w.score_a IS NOT NULL THEN w.score_a * w.amount_eur END) / NULLIF(SUM(CASE WHEN w.score_a IS NOT NULL THEN w.amount_eur END), 0), 3),
  ROUND(SUM(CASE WHEN w.score_c IS NOT NULL THEN w.score_c * w.amount_eur END) / NULLIF(SUM(CASE WHEN w.score_c IS NOT NULL THEN w.amount_eur END), 0), 3),
  COUNT(*),
  SUM(CASE WHEN w.score_overall IS NOT NULL THEN 1 ELSE 0 END),
  ROUND(100.0 * SUM(CASE WHEN w.single_offer = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 2),
  ROUND(100.0 * SUM(CASE WHEN w.is_direct_award = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 2),
  ROUND(SUM(w.score_coverage * w.amount_eur) / NULLIF(SUM(w.amount_eur), 0), 3),
  datetime('now')
FROM w
GROUP BY w.division;

CREATE TABLE IF NOT EXISTS region_quality_totals (        -- NUTS of performance (tenders.place_of_performance)
  nuts TEXT PRIMARY KEY, nuts_label TEXT, avg_overall REAL,
  total_contracts INTEGER NOT NULL, scored_contracts INTEGER, mean_coverage REAL, computed_at TEXT
);
DELETE FROM region_quality_totals;
WITH w AS (
  SELECT COALESCE(t.place_of_performance, 'NA') AS nuts, cf.*, c.amount_eur
  FROM contract_features cf
  JOIN contracts c ON c.id = cf.contract_id
  JOIN tenders t ON t.id = c.tender_id
  WHERE c.amount_eur IS NOT NULL
)
INSERT INTO region_quality_totals
SELECT w.nuts, n.nuts3_name,
  ROUND(SUM(CASE WHEN w.score_overall IS NOT NULL THEN w.score_overall * w.amount_eur END) / NULLIF(SUM(CASE WHEN w.score_overall IS NOT NULL THEN w.amount_eur END), 0), 3),
  COUNT(*),
  SUM(CASE WHEN w.score_overall IS NOT NULL THEN 1 ELSE 0 END),
  ROUND(SUM(w.score_coverage * w.amount_eur) / NULLIF(SUM(w.amount_eur), 0), 3),
  datetime('now')
FROM w LEFT JOIN nuts_regions n ON n.nuts3 = w.nuts
GROUP BY w.nuts;

CREATE TABLE IF NOT EXISTS year_quality_totals (          -- count-weighted (trend comparability)
  year TEXT PRIMARY KEY, avg_overall REAL, avg_a REAL, avg_b REAL, avg_c REAL, avg_d REAL, avg_e REAL,
  total_contracts INTEGER NOT NULL, scored_contracts INTEGER, mean_coverage REAL, computed_at TEXT
);
DELETE FROM year_quality_totals;
WITH w AS (
  SELECT CASE WHEN c.signed_at IS NULL OR strftime('%Y', c.signed_at) NOT BETWEEN '2020' AND '2026'
              THEN 'NA' ELSE strftime('%Y', c.signed_at) END AS yr,
         cf.*
  FROM contract_features cf
  JOIN contracts c ON c.id = cf.contract_id
)
INSERT INTO year_quality_totals
SELECT w.yr,
  ROUND(AVG(w.score_overall), 3), ROUND(AVG(w.score_a), 3), ROUND(AVG(w.score_b), 3),
  ROUND(AVG(w.score_c), 3), ROUND(AVG(w.score_d), 3), ROUND(AVG(w.score_e), 3),
  COUNT(*),
  SUM(CASE WHEN w.score_overall IS NOT NULL THEN 1 ELSE 0 END),
  ROUND(AVG(w.score_coverage), 3),
  datetime('now')
FROM w
GROUP BY w.yr;

CREATE TABLE IF NOT EXISTS funding_quality_totals (       -- eu_funded 0/1
  funding_key TEXT PRIMARY KEY,             -- 'eu' | 'national'
  avg_overall REAL, total_contracts INTEGER NOT NULL, scored_contracts INTEGER,
  mean_coverage REAL, computed_at TEXT
);
DELETE FROM funding_quality_totals;
WITH w AS (
  SELECT CASE WHEN c.eu_funded = 1 THEN 'eu' ELSE 'national' END AS funding_key, cf.*, c.amount_eur
  FROM contract_features cf
  JOIN contracts c ON c.id = cf.contract_id
  WHERE c.amount_eur IS NOT NULL
)
INSERT INTO funding_quality_totals
SELECT w.funding_key,
  ROUND(SUM(CASE WHEN w.score_overall IS NOT NULL THEN w.score_overall * w.amount_eur END) / NULLIF(SUM(CASE WHEN w.score_overall IS NOT NULL THEN w.amount_eur END), 0), 3),
  COUNT(*),
  SUM(CASE WHEN w.score_overall IS NOT NULL THEN 1 ELSE 0 END),
  ROUND(SUM(w.score_coverage * w.amount_eur) / NULLIF(SUM(w.amount_eur), 0), 3),
  datetime('now')
FROM w
GROUP BY w.funding_key;

-- Rollup summary (second result set) — six tables non-empty, avg_overall in [0,1].
SELECT
  (SELECT COUNT(*) FROM authority_quality_totals) AS authority_rows,
  (SELECT COUNT(*) FROM bidder_quality_totals) AS bidder_rows,
  (SELECT COUNT(*) FROM sector_quality_totals) AS sector_rows,
  (SELECT COUNT(*) FROM region_quality_totals) AS region_rows,
  (SELECT COUNT(*) FROM year_quality_totals) AS year_rows,
  (SELECT COUNT(*) FROM funding_quality_totals) AS funding_rows;
