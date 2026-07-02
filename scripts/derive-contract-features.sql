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
-- SCOPE (this PRD): leaves + effective_peer_key/peer_n + score_coverage only. score_a..score_e and
-- score_overall are left NULL — the scoring UPDATEs are the NEXT PRD (group 338).
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

CREATE TABLE IF NOT EXISTS contract_features (
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
  -- sub-scores [0,1], NULL when unknown — populated by the NEXT PRD (group 338)
  score_a REAL, score_b REAL, score_c REAL, score_d REAL, score_e REAL,
  score_overall REAL, computed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_contract_features_overall ON contract_features(score_overall);
CREATE INDEX IF NOT EXISTS idx_contract_features_peer ON contract_features(effective_peer_key);

DROP TABLE IF EXISTS contract_regime;
DROP TABLE IF EXISTS peer_fine_counts;
DROP TABLE IF EXISTS peer_mid_counts;
DROP TABLE IF EXISTS peer_coarse_counts;

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
       WHEN fa.first_currency IS NOT NULL AND fa.first_currency <> c.currency THEN NULL
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

-- Summary (last result set printed by `wrangler d1 execute`). unmapped_family_rows must be 0 — the
-- §12.2 completeness guard for the 21-value procedure_type vocabulary. contract_features_rows must
-- equal contracts_rows — the leaf INSERT inner-joins tenders/bidders/contract_regime, so a future
-- orphaned contracts.bidder_id/tender_id (SQLite doesn't enforce FKs unless PRAGMA foreign_keys=ON)
-- would silently drop that contract from the feature store without this check.
SELECT
  (SELECT COUNT(*) FROM contracts) AS contracts_rows,
  (SELECT COUNT(*) FROM contract_features) AS contract_features_rows,
  (SELECT COUNT(*) FROM contract_features WHERE score_coverage IS NULL) AS null_coverage_rows,
  (SELECT COUNT(*) FROM contract_features WHERE effective_peer_key IS NULL) AS null_peer_key_rows,
  (SELECT COUNT(*) FROM contract_features WHERE scoring_regime = 'framework') AS framework_regime_rows,
  (SELECT COUNT(*) FROM contract_features WHERE single_offer = 1) AS single_offer_rows;
