-- Sigma - normalise the EOP/OCDS staging into the domain tables
-- (authorities, tenders, lots, bidders, contracts). Run AFTER scripts/load-eop.mjs
-- (+ scripts/derive-amendments.sql for current_value/annex_count) have populated staging:
--   (cd apps/web && wrangler d1 execute sigma --local --file ../../scripts/normalize-raw.sql)
--
-- SOURCE MODEL (see docs/etl.md): the EOP open-data feed is the authoritative base for
-- 2020-2026 (raw_contracts + raw_tenders, source 'eop:%'). The OCDS JSON feed is the
-- go-forward delta for new 2026+ data (source 'ocds:%'); its rows carry their procedure fields on
-- the contract row, so they flow through here automatically and a UNP with no tenders-export row
-- gets a synthetic tender (step 2b). DEDUPE (step 5): where OCDS overlaps the EOP corpus,
-- EOP WINS - an OCDS contract is taken only when no EOP row shares its contract_number (the
-- public-procurement contract document number, common to both feeds; OCDS keeps its ocid in unp,
-- which never matches the EOP UNP format, so contract_number is the cross-source key). Genuinely new OCDS contracts
-- are added. This makes the OCDS go-live catch-up safe even though OCDS republishes contracts
-- already in EOP. data_freshness records the "current as of" boundary per feed.
--
-- FULL REBUILD: clears the derived tables and re-inserts from staging, so a re-run always
-- reflects the current rules and never leaves stale rows. wrangler runs this file as one
-- atomic D1 batch (explicit BEGIN/COMMIT is rejected), so a failed run rolls back.
--
-- Cleaning policy — staging stays 100% raw; cleaning happens only here:
--   * Currency is kept per row as it appears (BGN pre-2026, EUR from 2026, a few foreign) —
--     NOT coerced to one currency. Money sums must group/convert by currency downstream.
--   * Authorities dedupe on ЕИК (Вид на възложителя kept as `type`); a canonical name is kept.
--   * Bidders dedupe on raw contractor ЕИК (kept verbatim in bulstat); is_consortium comes from
--     the admin "възложена на група" flag (awarded_to_group), not a name heuristic. Resolving the
--     members hidden behind a single consortium ЕИК needs the Търговски регистър (joined on ЕИК),
--     a parked future pipeline; for now the full value is attributed to the consortium entity.
--   * Tenders come from the tenders-export header row (one per УНП); lots from its lot rows.
--     11k+ УНП appear only in contracts (no tenders row) → a synthetic 'неизвестна' tender so
--     every contract has a parent. bids stays empty (the data has a bid COUNT, not bids).

-- Full clear in child→parent order (D1 enforces FKs).
DELETE FROM search_index;
DELETE FROM flow_pairs;
DELETE FROM company_totals;
DELETE FROM authority_totals;
DELETE FROM sector_totals;
DELETE FROM facet_counts;
DELETE FROM home_totals;
DELETE FROM contracts;
DELETE FROM lots;
DELETE FROM tenders;
DELETE FROM bidders;
DELETE FROM authorities;

-- 1) Authorities — dedupe on ЕИК across both contracts and tenders staging, keep a
--    canonical display name and the authority type (Вид на възложителя).
INSERT OR IGNORE INTO authorities (id, name, bulstat, type)
SELECT 'auth:' || authority_eik, MIN(authority_name), authority_eik, MAX(authority_type)
FROM (
  SELECT authority_eik, authority_name, authority_type FROM raw_contracts WHERE authority_eik IS NOT NULL
  UNION ALL
  SELECT authority_eik, authority_name, authority_type FROM raw_tenders   WHERE authority_eik IS NOT NULL
)
GROUP BY authority_eik;

-- 1b) Friendly authority type buckets — heuristic from name + ЗОП type (non-critical display field;
--     name patterns cover Title- and UPPER-case Cyrillic since SQLite LIKE is case-sensitive for it).
UPDATE authorities SET type_group = CASE
  WHEN name LIKE 'Община%' OR name LIKE 'ОБЩИНА%' OR name LIKE '%Столична община%' OR name LIKE '%СТОЛИЧНА ОБЩИНА%' THEN 'община'
  WHEN name LIKE 'Министерство%' OR name LIKE 'МИНИСТЕРСТВО%' THEN 'министерство'
  WHEN name LIKE '%болница%' OR name LIKE '%БОЛНИЦА%' OR name LIKE 'МБАЛ%' OR name LIKE '%МБАЛ%' OR name LIKE '%СБАЛ%' OR name LIKE '%ДКЦ%' OR name LIKE '%лечебно заведение%' THEN 'болница'
  WHEN name LIKE '%университет%' OR name LIKE '%УНИВЕРСИТЕТ%' OR name LIKE '%училище%' OR name LIKE '%УЧИЛИЩЕ%' OR name LIKE '%гимназия%' OR name LIKE '%ГИМНАЗИЯ%' OR name LIKE '%детска градина%' OR name LIKE '%ДЕТСКА ГРАДИНА%' OR name LIKE '%академия%' THEN 'образование'
  WHEN name LIKE '%агенция%' OR name LIKE '%Агенция%' OR name LIKE '%АГЕНЦИЯ%' THEN 'агенция'
  WHEN type LIKE 'Публично предприятие%' OR type LIKE 'Комунални услуги%' THEN 'държавна компания'
  ELSE 'друго'
END;

-- 2a) Tenders — the header row of each procurement (lot_id IS NULL): one per УНП, carrying
--     procedure type, CPV, the procurement-level estimated value, lot count and authority.
INSERT OR IGNORE INTO tenders
  (id, source_id, title, authority_id, cpv_code, cpv_description, estimated_value, currency,
   procedure_type, contract_kind, num_lots, status, published_at, deadline_at,
   legal_basis, award_criteria, main_activity, notice_type,
   place_of_performance, start_date, end_date, duration, duration_unit,
   eu_programme, green, social, innovation, eauction, cancelled, eop_tender_id)
SELECT
  't:' || t.unp,
  t.unp,
  COALESCE(t.procurement_subject, '(без предмет)'),
  'auth:' || t.authority_eik,
  t.cpv_code,
  t.cpv_description,
  t.estimated_value,
  COALESCE(t.currency, 'BGN'),
  COALESCE(t.procedure_type, 'неизвестна'),
  t.contract_kind,
  t.num_lots,
  CASE WHEN EXISTS (SELECT 1 FROM raw_contracts c WHERE c.unp = t.unp) THEN 'awarded' ELSE 'published' END,
  t.published_at,
  t.deadline,
  t.legal_basis,
  t.award_criteria,
  t.main_activity,
  t.notice_type,
  t.place_of_performance,
  t.start_date,
  t.end_date,
  t.duration,
  t.duration_unit,
  t.eu_programme,
  t.green,
  t.social,
  t.innovation,
  t.eauction,
  t.cancelled,
  NULLIF(t.tender_id, '')                 -- raw EOP numeric tenderId from the header row
FROM raw_tenders t
WHERE t.lot_id IS NULL
  AND EXISTS (SELECT 1 FROM authorities a WHERE a.id = 'auth:' || t.authority_eik);

-- 2b) Synthetic tenders — УНП that appear only in contracts (no tenders-export row), so
--     every contract has a parent. Procedure type is unknown ('неизвестна'); subject/CPV/
--     estimated are taken from the contract line.
WITH folded AS (
  SELECT
    c.unp,
    MIN(c.procurement_subject) AS raw_title,
    'auth:' || MIN(c.authority_eik) AS authority_id,
    MIN(c.cpv_code) AS cpv_code,
    MIN(c.estimated_value) AS estimated_value,
    MIN(c.currency) AS raw_currency,
    MIN(c.contract_kind) AS contract_kind,
    MIN(c.legal_basis) AS legal_basis,
    MIN(c.award_criteria) AS award_criteria,
    MIN(NULLIF(c.tender_ext_id, '')) AS eop_tender_id  -- synthetic tenders inherit the EOP id from contracts
  FROM raw_contracts c
  WHERE 1 = 1
    AND c.unp IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM raw_tenders t WHERE t.unp = c.unp)
    AND EXISTS (SELECT 1 FROM authorities a WHERE a.id = 'auth:' || c.authority_eik)
  GROUP BY c.unp
)
INSERT INTO tenders
  (id, source_id, title, authority_id, cpv_code, estimated_value, currency,
   procedure_type, contract_kind, status, legal_basis, award_criteria, eop_tender_id)
SELECT
  't:' || unp,
  unp,
  COALESCE(raw_title, '(без предмет)'),
  authority_id,
  cpv_code,
  estimated_value,
  COALESCE(raw_currency, 'BGN'),
  'неизвестна',
  contract_kind,
  'awarded',
  legal_basis,
  award_criteria,
  eop_tender_id
FROM folded
WHERE true
ON CONFLICT(id) DO UPDATE SET
  title = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.title = '(без предмет)' THEN tenders.title
      WHEN tenders.title = '(без предмет)' THEN excluded.title
      ELSE min(tenders.title, excluded.title)
    END
    ELSE tenders.title END,
  cpv_code = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.cpv_code IS NULL THEN tenders.cpv_code
      WHEN tenders.cpv_code IS NULL THEN excluded.cpv_code
      ELSE min(tenders.cpv_code, excluded.cpv_code)
    END
    ELSE tenders.cpv_code END,
  estimated_value = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.estimated_value IS NULL THEN tenders.estimated_value
      WHEN tenders.estimated_value IS NULL THEN excluded.estimated_value
      ELSE min(tenders.estimated_value, excluded.estimated_value)
    END
    ELSE tenders.estimated_value END,
  currency = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.currency = 'BGN' AND tenders.currency <> 'BGN' THEN tenders.currency
      WHEN tenders.currency = 'BGN' AND excluded.currency <> 'BGN' THEN excluded.currency
      ELSE min(tenders.currency, excluded.currency)
    END
    ELSE tenders.currency END,
  contract_kind = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.contract_kind IS NULL THEN tenders.contract_kind
      WHEN tenders.contract_kind IS NULL THEN excluded.contract_kind
      ELSE min(tenders.contract_kind, excluded.contract_kind)
    END
    ELSE tenders.contract_kind END,
  legal_basis = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.legal_basis IS NULL THEN tenders.legal_basis
      WHEN tenders.legal_basis IS NULL THEN excluded.legal_basis
      ELSE min(tenders.legal_basis, excluded.legal_basis)
    END
    ELSE tenders.legal_basis END,
  award_criteria = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.award_criteria IS NULL THEN tenders.award_criteria
      WHEN tenders.award_criteria IS NULL THEN excluded.award_criteria
      ELSE min(tenders.award_criteria, excluded.award_criteria)
    END
    ELSE tenders.award_criteria END,
  eop_tender_id = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.eop_tender_id IS NULL THEN tenders.eop_tender_id
      WHEN tenders.eop_tender_id IS NULL THEN excluded.eop_tender_id
      ELSE min(tenders.eop_tender_id, excluded.eop_tender_id)
    END
    ELSE tenders.eop_tender_id END;

-- 3) Lots — the lot rows of each procurement (lot_id IS NOT NULL), linked to their tender.
-- Canonical lot id is `lot:UNP:N` with N the integer lot number. The two feeds disagree on the raw
-- form — the tender feed numbers lots 1..N, the contract feed (OCDS) uses 'LOT-000N' — so BOTH the
-- lots id here and the contracts.lot_id below normalise it the same way, or the lots↔contract link
-- (and the „Обособени позиции" table / current-lot highlight) breaks for the OCDS rows.
INSERT OR IGNORE INTO lots (id, tender_id, title, cpv_code, estimated_value)
SELECT
  'lot:' || t.unp || ':' || CASE
    WHEN t.lot_id LIKE 'LOT-%' AND REPLACE(t.lot_id, 'LOT-', '') <> '' AND REPLACE(t.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(t.lot_id, 'LOT-', '') AS INTEGER)
    WHEN t.lot_id <> '' AND t.lot_id NOT GLOB '*[^0-9]*' THEN CAST(t.lot_id AS INTEGER)
    ELSE t.lot_id
  END,
  't:' || t.unp,
  COALESCE(t.lot_name, '(без предмет)'),
  t.cpv_code,
  t.estimated_value
FROM raw_tenders t
WHERE t.lot_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || t.unp);

-- 4) Bidders — winning contractors, with a robust identity key:
--      * valid ЕИК (digits-only, length 9/13)  → key by ЕИК       ('eik:<eik>')
--      * otherwise (withheld 'не се публикува', foreign id, multi-ЕИК consortium, missing) →
--        key by NORMALISED NAME ('name:<UPPER+collapsed name>')
--    Keying invalid ЕИК by name stops the collapse where ~595 distinct withheld-ЕИК contractors
--    merged onto one node. bulstat/eik_normalized stay set only for a valid ЕИК (NULL otherwise,
--    which keeps the bulstat UNIQUE happy). is_consortium describes the ENTITY (a JV), so it is
--    name-based — a semicolon member list or ДЗЗД / ОБЕДИНЕНИЕ / КОНСОРЦИУМ in the name; the
--    per-contract awarded_to_group flag lives on contracts, not here.
INSERT OR IGNORE INTO bidders (id, name, bulstat, eik_normalized, eik_valid, is_consortium, kind)
SELECT
  bidder_key,
  MIN(contractor_name),
  MIN(CASE WHEN eik_valid = 1 THEN eik_clean END),
  MIN(CASE WHEN eik_valid = 1 THEN eik_clean END),
  MAX(eik_valid),
  MAX(grp),
  CASE WHEN MAX(grp) = 1 THEN 'consortium' ELSE 'company' END
FROM (
  SELECT
    contractor_name,
    eik_clean,
    CASE WHEN eik_clean NOT GLOB '*[^0-9]*' AND LENGTH(eik_clean) IN (9, 13) THEN 1 ELSE 0 END AS eik_valid,
    CASE
      WHEN eik_clean NOT GLOB '*[^0-9]*' AND LENGTH(eik_clean) IN (9, 13) THEN 'eik:' || eik_clean
      WHEN contractor_name IS NOT NULL AND TRIM(contractor_name) <> '' THEN 'name:' || UPPER(TRIM(REPLACE(REPLACE(contractor_name, '  ', ' '), '  ', ' ')))
      ELSE NULL
    END AS bidder_key,
    CASE
      WHEN contractor_name LIKE '%;%'
        OR UPPER(contractor_name) LIKE '%ДЗЗД%'
        OR UPPER(contractor_name) LIKE '%ОБЕДИНЕНИЕ%'
        OR UPPER(contractor_name) LIKE '%КОНСОРЦИУМ%'
      THEN 1 ELSE 0
    END AS grp
  FROM (
    SELECT
      contractor_name,
      TRIM(CASE WHEN contractor_eik LIKE 'ЕИК %' THEN SUBSTR(contractor_eik, 5) ELSE contractor_eik END) AS eik_clean
    FROM raw_contracts WHERE source LIKE 'eop:%' OR source LIKE 'ocds:%'
  )
)
WHERE bidder_key IS NOT NULL
GROUP BY bidder_key;

-- 4b) Curated public-owned winner classification. Exact EIK matches cover the allowlist; a small
-- branch list handles valid 13-digit branch EIKs used by AПИ/ОПУ, ЕСО/МЕР, БНР and Информационно
-- обслужване. Private look-alikes stay absent from the seed table and therefore remain NULL.
CREATE TABLE IF NOT EXISTS state_owned_eik (
  eik TEXT PRIMARY KEY,
  ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('state', 'municipal', 'mixed')),
  canonical_name TEXT NOT NULL
);

UPDATE bidders
SET ownership_kind = (
  SELECT s.ownership_kind
  FROM state_owned_eik s
  WHERE bidders.eik_valid = 1
    AND (
      bidders.eik_normalized = s.eik
      OR (s.eik = '000695089' AND bidders.eik_normalized GLOB '0006950890*')
      OR (s.eik = '175201304' AND bidders.eik_normalized GLOB '1752013040*')
      OR (s.eik = '000672343' AND bidders.eik_normalized GLOB '0006723430*')
      OR (s.eik = '831641791' AND bidders.eik_normalized GLOB '8316417910124*')
    )
  LIMIT 1
);

-- 5) Contracts — awarded lines (1:1 with staging rows), linked to tender + winning bidder,
--    with the data-quality verdict (see 0007_data_quality.sql):
--      value_flag = 'value_suspect'  effective value >2bn EUR, or >200× the procedure estimate
--                                    when that estimate is at least 1000 EUR — repaired to the
--                                    procedure estimate for sums/display
--                 | 'value_low'      zero/negative, OR a tiny signed value (< 1000 EUR) that is also
--                                    < 5% of the estimate. KEPT IN the sums (amount_eur populated) but
--                                    LABELLED — large legitimate framework call-offs (a small share of
--                                    a huge ceiling but big in absolute terms) are excluded by the
--                                    < 1000 EUR floor, so they keep counting and stay unflagged
--                 | 'annex_suspect'  amendment pushed current_value ≥100× signing, or negative →
--                                    fall back to signing_value, or current_value if signing is
--                                    missing, so the contract still counts
--                 | 'review'         ≥10× the procedure estimate (kept, but flagged)
--                 | 'ok'
--    `amount` is the as-recorded display value (current_value when an annex legitimately raised it,
--    else signing; procedure estimate for value_suspect; signing/current fallback for annex_suspect).
--    `amount_eur` is the SAFE-TO-SUM canonical value:
--    BGN→EUR at the fixed peg (÷1.95583), EUR as-is, foreign at the latest prior ECB rate within
--    10 days of signing (fx_rates); value_suspect uses the procedure estimate in EUR, and foreign
--    rows without a bounded prior rate stay NULL. fx_converted = 1 for foreign rows, and
--    fx_rate carries the applied rate on the row (amount * fx_rate = amount_eur), so the original value,
--    the rate, and the EUR value are all auditable without joining fx_rates.
INSERT OR IGNORE INTO contracts
  (id, tender_id, bidder_id, amount, currency, signed_at,
   contract_number, signing_value, current_value, annex_count, eu_funded, bids_received,
   contract_kind, awarded_to_group, value_flag, date_flag, amount_eur, fx_converted, fx_rate,
   lot_id, document_number, published_at, contract_subject,
   eu_programme, duration_days, winner_size, contractor_country,
   bids_sme, bids_rejected, bids_non_eea,
   subcontractor_eik, subcontractor_name, subcontract_value,
   eauction, framework, accelerated, strategic)
SELECT
  CASE
    WHEN x.source LIKE 'eop:%' THEN 'c:e:' || COALESCE(x.unp, '') || ':' || COALESCE(x.contract_number, '') || ':' ||
      COALESCE(NULLIF(x.lot_norm, ''), '_') || ':' || x.bidder_key || ':' || x.contract_ordinal
    WHEN x.source LIKE 'ocds:%' THEN 'c:o:' || COALESCE(x.unp, '') || ':' || COALESCE(x.contract_number, '') || ':' ||
      COALESCE(NULLIF(x.lot_id, ''), '_') || ':' || x.bidder_key || ':' || x.contract_ordinal
    ELSE 'c:' || x.id
  END,
  't:' || x.unp,
  x.bidder_key,
  x.display_native,
  COALESCE(x.currency, 'BGN'),
  x.contract_date,
  x.contract_number,
  x.signing_value,
  x.current_value,
  COALESCE(x.annex_count, 0),
  x.eu_funded,
  x.bids_received,
  x.contract_kind,
  x.awarded_to_group,
  x.value_flag,
  x.date_flag,
  CASE
    WHEN x.value_flag = 'value_suspect' THEN x.proc_est_eur
    WHEN x.trusted_native IS NULL THEN NULL
    WHEN COALESCE(x.currency, 'BGN') = 'EUR' THEN x.trusted_native
    WHEN COALESCE(x.currency, 'BGN') = 'BGN' THEN x.trusted_native / 1.95583
    ELSE x.trusted_native * x.fx_rate
  END,
  CASE WHEN COALESCE(x.currency, 'BGN') NOT IN ('BGN', 'EUR') THEN 1 ELSE 0 END,
  x.fx_rate,
  CASE WHEN x.lot_id IS NOT NULL AND TRIM(x.lot_id) <> '' THEN 'lot:' || x.unp || ':' || CASE
    WHEN x.lot_id LIKE 'LOT-%' AND REPLACE(x.lot_id, 'LOT-', '') <> '' AND REPLACE(x.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(x.lot_id, 'LOT-', '') AS INTEGER)
    WHEN x.lot_id <> '' AND x.lot_id NOT GLOB '*[^0-9]*' THEN CAST(x.lot_id AS INTEGER)
    ELSE x.lot_id
  END ELSE NULL END,
  x.document_number,
  x.published_at,
  x.contract_subject,
  x.eu_programme,
  x.duration_days,
  x.winner_size,
  x.contractor_country,
  x.bids_sme,
  x.bids_rejected,
  x.bids_non_eea,
  x.subcontractor_eik,
  x.subcontractor_name,
  x.subcontract_value,
  x.eauction,
  x.framework_contract,
  x.accelerated,
  x.strategic
FROM (
  SELECT y.*,
    CASE y.value_flag
      WHEN 'value_suspect' THEN y.proc_est_native
      WHEN 'annex_suspect' THEN COALESCE(y.signing_value, y.current_value)
      ELSE COALESCE(y.current_value, y.signing_value)
    END AS display_native,
    -- value_suspect is repaired directly from proc_est_eur in the outer amount_eur CASE; value_low and
    -- 'review' fall to the populated ELSE branch, so their amount_eur is set, NOT nulled.
    CASE y.value_flag
      WHEN 'value_suspect' THEN NULL
      WHEN 'annex_suspect' THEN COALESCE(y.signing_value, y.current_value)
      ELSE COALESCE(y.current_value, y.signing_value)
    END AS trusted_native,
    -- ECB rates are published on business days only; carry the latest prior rate forward for
    -- weekend/holiday signings, never future-dated, and cap the fallback at 10 calendar days.
    CASE WHEN COALESCE(y.currency, 'BGN') NOT IN ('BGN', 'EUR')
      THEN (
        SELECT f.eur_per_unit
        FROM fx_rates f
        WHERE f.base_currency = y.currency
          AND f.rate_date <= y.contract_date
          AND f.rate_date >= date(y.contract_date, '-10 days')
        ORDER BY f.rate_date DESC
        LIMIT 1
      )
      ELSE NULL END AS fx_rate
  FROM (
    SELECT z.*,
      ROW_NUMBER() OVER (
        PARTITION BY z.unp, COALESCE(z.contract_number, ''), z.bidder_key,
          CASE
            WHEN z.source LIKE 'eop:%' THEN COALESCE(NULLIF(z.lot_norm, ''), '_')
            ELSE COALESCE(NULLIF(z.lot_id, ''), '_')
          END
        ORDER BY z.signing_value, z.contract_date, z.document_number, z.id
      ) AS contract_ordinal
    FROM (
      SELECT c.*,
        CASE
          WHEN c.lot_id LIKE 'LOT-%' AND REPLACE(c.lot_id, 'LOT-', '') <> '' AND REPLACE(c.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(c.lot_id, 'LOT-', '') AS INTEGER)
          WHEN c.lot_id <> '' AND c.lot_id NOT GLOB '*[^0-9]*' THEN CAST(c.lot_id AS INTEGER)
          ELSE c.lot_id
        END AS lot_norm,
        CASE
          -- Over-valuation + absurd are checked FIRST and repaired to the procedure estimate.
          -- value_low is a labelled-but-counted flag (see the amount_eur CASE).
          WHEN c.eff_eur > 2000000000 OR (c.proc_est_eur >= 1000 AND c.eff_eur > 200 * c.proc_est_eur) THEN 'value_suspect'
          -- value_low: zero/negative, OR a tiny signed value (< 1000 EUR) that is also < 5% of the
          -- estimate. Large legitimate framework call-offs (small share of a huge ceiling but big in
          -- absolute terms) are NOT caught — the < 1000 EUR floor keeps them OUT of value_low.
          WHEN COALESCE(c.current_value, c.signing_value) <= 0 THEN 'value_low'
          WHEN c.estimated_value > 0 AND c.signing_value IS NOT NULL AND (
            CASE
              WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN c.signing_value
              WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN c.signing_value / 1.95583
              ELSE c.signing_value * (
                SELECT f.eur_per_unit
                FROM fx_rates f
                WHERE f.base_currency = c.currency
                  AND f.rate_date <= c.contract_date
                  AND f.rate_date >= date(c.contract_date, '-10 days')
                ORDER BY f.rate_date DESC
                LIMIT 1
              )
            END
          ) < 1000 AND (
            CASE
              WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN c.signing_value
              WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN c.signing_value / 1.95583
              ELSE c.signing_value * (
                SELECT f.eur_per_unit
                FROM fx_rates f
                WHERE f.base_currency = c.currency
                  AND f.rate_date <= c.contract_date
                  AND f.rate_date >= date(c.contract_date, '-10 days')
                ORDER BY f.rate_date DESC
                LIMIT 1
              )
            END
          ) / NULLIF((
            CASE
              WHEN COALESCE(NULLIF(c.procurement_currency, ''), NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN c.estimated_value
              WHEN COALESCE(NULLIF(c.procurement_currency, ''), NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN c.estimated_value / 1.95583
              ELSE c.estimated_value * (
                SELECT f.eur_per_unit
                FROM fx_rates f
                WHERE f.base_currency = COALESCE(NULLIF(c.procurement_currency, ''), NULLIF(c.currency, ''))
                  AND f.rate_date <= c.contract_date
                  AND f.rate_date >= date(c.contract_date, '-10 days')
                ORDER BY f.rate_date DESC
                LIMIT 1
              )
            END
          ), 0) < 0.05 THEN 'value_low'
          WHEN c.current_value IS NOT NULL AND (c.current_value < 0 OR (c.signing_value > 0 AND c.current_value / c.signing_value >= 100)) THEN 'annex_suspect'
          WHEN c.proc_est_eur > 0 AND c.eff_eur >= 10 * c.proc_est_eur THEN 'review'
          ELSE 'ok'
        END AS value_flag,
        CASE
          WHEN c.contract_date IS NOT NULL
           AND c.published_at IS NOT NULL
           AND c.contract_date > date(c.published_at, '+2 day') THEN 'signed_after_publication'
          ELSE 'ok'
        END AS date_flag,
        CASE
          WHEN TRIM(CASE WHEN c.contractor_eik LIKE 'ЕИК %' THEN SUBSTR(c.contractor_eik, 5) ELSE c.contractor_eik END) NOT GLOB '*[^0-9]*'
           AND LENGTH(TRIM(CASE WHEN c.contractor_eik LIKE 'ЕИК %' THEN SUBSTR(c.contractor_eik, 5) ELSE c.contractor_eik END)) IN (9, 13)
          THEN 'eik:' || TRIM(CASE WHEN c.contractor_eik LIKE 'ЕИК %' THEN SUBSTR(c.contractor_eik, 5) ELSE c.contractor_eik END)
          WHEN c.contractor_name IS NOT NULL AND TRIM(c.contractor_name) <> '' THEN 'name:' || UPPER(TRIM(REPLACE(REPLACE(c.contractor_name, '  ', ' '), '  ', ' ')))
          ELSE NULL
        END AS bidder_key
      FROM (
        SELECT c.*,
          CASE
            WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN COALESCE(c.current_value, c.signing_value)
            WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN COALESCE(c.current_value, c.signing_value) / 1.95583
            ELSE COALESCE(c.current_value, c.signing_value) * (
              SELECT f.eur_per_unit
              FROM fx_rates f
              WHERE f.base_currency = NULLIF(c.currency, '')
                AND f.rate_date <= c.contract_date
                AND f.rate_date >= date(c.contract_date, '-10 days')
              ORDER BY f.rate_date DESC
              LIMIT 1
            )
          END AS eff_eur,
          CASE
            WHEN t.estimated_value IS NULL THEN NULL
            WHEN COALESCE(NULLIF(t.currency, ''), 'BGN') = 'EUR' THEN t.estimated_value
            WHEN COALESCE(NULLIF(t.currency, ''), 'BGN') = 'BGN' THEN t.estimated_value / 1.95583
            ELSE t.estimated_value * (
              SELECT f.eur_per_unit
              FROM fx_rates f
              WHERE f.base_currency = NULLIF(t.currency, '')
                AND f.rate_date <= c.contract_date
                AND f.rate_date >= date(c.contract_date, '-10 days')
              ORDER BY f.rate_date DESC
              LIMIT 1
            )
          END AS proc_est_eur,
          t.estimated_value AS proc_est_native
        FROM raw_contracts c
        LEFT JOIN tenders t ON t.id = 't:' || c.unp
      ) c
      -- EOP always; an OCDS row only when no EOP row shares its contract_number - EOP wins.
      -- Key is contract_number (the public-procurement contract document number, common to both feeds), NOT unp:
      -- OCDS stores its ocid in unp, which never matches the EOP UNP format. (idx_raw_cnum)
      -- EOP daily open-data buckets are CUMULATIVE: the same contract recurs across consecutive days,
      -- so keep exactly ONE row per logical contract (unp+contract_number+lot+contractor), choosing the
      -- latest source-day (then highest id). Without this, contracts and every EUR total double-count.
      -- The NOT EXISTS leads with contract_number so idx_raw_cnum/idx_raw_unp_cnum keep it cheap.
      WHERE (c.source LIKE 'eop:%' AND NOT EXISTS (
              SELECT 1 FROM raw_contracts a
              WHERE a.source LIKE 'eop:%'
                -- Bare equality (not COALESCE) so idx_raw_cnum drives the seek; contract_number is
                -- guaranteed non-null by the base keep-filter, so this is identical to COALESCE(...,'')
                -- but O(n log n) instead of the O(n^2) full scan COALESCE forces on a 380k-row corpus.
                AND a.contract_number = c.contract_number
                AND COALESCE(a.unp, '') = COALESCE(c.unp, '')
                AND COALESCE(a.lot_id, '') = COALESCE(c.lot_id, '')
                AND COALESCE(a.contractor_eik, '') = COALESCE(c.contractor_eik, '')
                AND COALESCE(a.contractor_name, '') = COALESCE(c.contractor_name, '')
                AND (a.source > c.source OR (a.source = c.source AND a.id > c.id))))
         OR (c.source LIKE 'ocds:%' AND NOT EXISTS (
              SELECT 1 FROM raw_contracts a
              WHERE a.source LIKE 'eop:%'
                AND a.contract_number = c.contract_number))  -- bare = -> idx_raw_cnum (see above)
    ) z
  ) y
) x
WHERE x.bidder_key IS NOT NULL
  AND x.display_native IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || x.unp)
  AND EXISTS (SELECT 1 FROM bidders  b  WHERE b.id  = x.bidder_key);

-- Reconciliation guard: the final summary reports the contracts inserted alongside the surviving
-- staging candidates, so a future NOT NULL/foreign-key mismatch is visible instead of hidden by
-- INSERT OR IGNORE.

-- Promote transient/work OCDS party staging into the served parties projection.
WITH keyed AS (
  SELECT
    CASE
      -- ЕИК is the stable national identity, so key by it FIRST. The OCDS (ocid, party_id) pair is
      -- positional within a release ("ORG-0003" = the 3rd party in THIS package), and the same slot is
      -- reused for a different company on every republish — keying on it collapses genuinely-distinct
      -- companies onto one node, and source-DESC dedup then drops all but the latest occupant. Putting
      -- ЕИК first prevents that collision; the (ocid, party_id) suffix keeps one row per appearance so
      -- the per-field enrichment below can still pick the richest non-blank value across appearances.
      WHEN NULLIF(eik, '') IS NOT NULL THEN 'eik:' || eik || ':ocid:' || COALESCE(ocid, '') || ':party:' || COALESCE(party_id, '')
      WHEN NULLIF(ocid, '') IS NOT NULL AND NULLIF(party_id, '') IS NOT NULL THEN 'ocid:' || ocid || ':party:' || party_id
      ELSE 'content:' ||
        COALESCE(ocid, '') || ':' || COALESCE(party_id, '') || ':' || COALESCE(eik, '') || ':' ||
        COALESCE(name, '') || ':' || COALESCE(street_address, '') || ':' || COALESCE(locality, '') || ':' ||
        COALESCE(region_nuts, '') || ':' || COALESCE(contact_email, '') || ':' || COALESCE(contact_phone, '')
    END AS party_key,
    eik,
    source,
    ocid,
    party_id,
    name,
    street_address,
    locality,
    region_nuts,
    contact_email,
    contact_phone
  FROM raw_ocds_parties
), ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY party_key
      ORDER BY source DESC, COALESCE(ocid, '') DESC, COALESCE(party_id, '') DESC,
        COALESCE(name, '') DESC, COALESCE(street_address, '') DESC, COALESCE(locality, '') DESC,
        COALESCE(contact_email, '') DESC, COALESCE(contact_phone, '') DESC
    ) AS rn
  FROM keyed
)
INSERT OR REPLACE INTO parties (
  party_key, eik, source, ocid, party_id, name, street_address, locality, region_nuts,
  contact_email, contact_phone
)
SELECT
  party_key, eik, source, ocid, party_id, name, street_address, locality, region_nuts,
  contact_email, contact_phone
FROM ranked
WHERE rn = 1;

-- 6) Location enrichment from OCDS parties (parties, populated from raw_ocds_parties).
--    Match on ЕИК; take the most-recent non-null value (parties repeat across releases). OCDS covers
--    2026+ entities, so authorities/bidders absent from OCDS keep NULL location until the Trade
--    Register loader fills the rest. No-op when parties is empty (admin-only import).
UPDATE authorities SET
  nuts       = COALESCE((SELECT p.region_nuts    FROM parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.region_nuts, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), nuts),
  settlement = COALESCE((SELECT p.locality       FROM parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.locality, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), settlement),
  address    = COALESCE((SELECT p.street_address FROM parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.street_address, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), address),
  contact_email = COALESCE((SELECT p.contact_email FROM parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.contact_email, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_email),
  contact_phone = COALESCE((SELECT p.contact_phone FROM parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.contact_phone, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_phone)
WHERE EXISTS (SELECT 1 FROM parties p WHERE p.eik = authorities.bulstat);

UPDATE bidders SET
  nuts       = COALESCE((SELECT p.region_nuts    FROM parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.region_nuts, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), nuts),
  settlement = COALESCE((SELECT p.locality       FROM parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.locality, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), settlement),
  address    = COALESCE((SELECT p.street_address FROM parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.street_address, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), address),
  contact_email = COALESCE((SELECT p.contact_email FROM parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.contact_email, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_email),
  contact_phone = COALESCE((SELECT p.contact_phone FROM parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.contact_phone, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_phone)
WHERE EXISTS (SELECT 1 FROM parties p WHERE p.eik = bidders.eik_normalized);

-- 6b) Per-lot value enrichment from OCDS. The bridge is OCDS tender.id -> EOP tenderId
--     (raw_tenders.tender_id) -> UNP -> domain lots. ocid is a surrogate and is never
--     treated as the UNP.
CREATE INDEX IF NOT EXISTS idx_raw_tenders_tender_id ON raw_tenders(tender_id);
WITH mapped AS (
  SELECT
    'lot:' || rt.unp || ':' || CASE
      WHEN rl.lot_id LIKE 'LOT-%' AND REPLACE(rl.lot_id, 'LOT-', '') <> '' AND REPLACE(rl.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(rl.lot_id, 'LOT-', '') AS INTEGER)
      WHEN rl.lot_id <> '' AND rl.lot_id NOT GLOB '*[^0-9]*' THEN CAST(rl.lot_id AS INTEGER)
      ELSE rl.lot_id
    END AS domain_lot_id,
    rl.value_amount,
    rl.value_currency,
    ROW_NUMBER() OVER (
      PARTITION BY 'lot:' || rt.unp || ':' || CASE
        WHEN rl.lot_id LIKE 'LOT-%' AND REPLACE(rl.lot_id, 'LOT-', '') <> '' AND REPLACE(rl.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(rl.lot_id, 'LOT-', '') AS INTEGER)
        WHEN rl.lot_id <> '' AND rl.lot_id NOT GLOB '*[^0-9]*' THEN CAST(rl.lot_id AS INTEGER)
        ELSE rl.lot_id
      END
      ORDER BY rl.id DESC
    ) AS rn
  FROM raw_ocds_lots rl
  JOIN raw_tenders rt ON rt.tender_id = rl.tender_id
  WHERE rl.tender_id IS NOT NULL
    AND rl.lot_id IS NOT NULL
    AND rt.unp IS NOT NULL
)
UPDATE lots
SET
  value_amount = COALESCE(lots.value_amount, mapped.value_amount),
  value_currency = COALESCE(lots.value_currency, mapped.value_currency)
FROM mapped
WHERE mapped.rn = 1
  AND mapped.domain_lot_id = lots.id;

-- 7) Region from NUTS (nuts_regions, seeded by scripts/load-nuts.sql) — labels the OCDS-sourced NUTS
--    codes and fills authorities.region (област) where empty. No-op if nuts_regions is unseeded.
UPDATE authorities SET region = (SELECT n.nuts3_name FROM nuts_regions n WHERE n.nuts3 = authorities.nuts)
WHERE authorities.nuts IS NOT NULL AND authorities.region IS NULL;

-- Freshness boundary from the served domain contract ids. Staging is work-only.
DELETE FROM data_freshness;
INSERT INTO data_freshness (source, as_of, rows, refreshed_at)
SELECT
  CASE
    WHEN id LIKE 'c:e:%' THEN 'eop'
    WHEN id LIKE 'c:o:%' THEN 'ocds'
    ELSE 'other'
  END AS src,
  MAX(CASE WHEN signed_at <= date('now') THEN signed_at END),
  COUNT(*),
  datetime('now')
FROM contracts
GROUP BY src;

-- Pipeline reconciliation stats (#97): persist the eligible-candidate count (the SAME expression
-- the summary below prints) and the resulting contracts count, so the integrity gate
-- (scripts/integrity-checks.mjs) and the printed summary read ONE computation and cannot disagree.
-- ETL-internal, single row, recomputed every full rebuild; NOT shipped to the served D1
-- (ship-domain.mjs ships domain/reference tables only), so the staging-reconciliation check
-- self-skips there.
CREATE TABLE IF NOT EXISTS pipeline_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  contract_candidates INTEGER NOT NULL,
  contracts_inserted INTEGER NOT NULL,
  computed_at TEXT NOT NULL
);
DELETE FROM pipeline_stats;
INSERT INTO pipeline_stats (id, contract_candidates, contracts_inserted, computed_at)
SELECT 1,
  (SELECT COUNT(*) FROM (
    SELECT c.id
    FROM (
      SELECT c.*,
        CASE
          -- Mirrors the main derive CASE above; value_low is checked AFTER over-valuation + absurd.
          WHEN c.eff_eur > 2000000000 OR (c.proc_est_eur >= 1000 AND c.eff_eur > 200 * c.proc_est_eur) THEN 'value_suspect'
          WHEN COALESCE(c.current_value, c.signing_value) <= 0 THEN 'value_low'
          WHEN c.estimated_value > 0 AND c.signing_value IS NOT NULL AND (
            CASE
              WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN c.signing_value
              WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN c.signing_value / 1.95583
              ELSE c.signing_value * (
                SELECT f.eur_per_unit
                FROM fx_rates f
                WHERE f.base_currency = c.currency
                  AND f.rate_date <= c.contract_date
                  AND f.rate_date >= date(c.contract_date, '-10 days')
                ORDER BY f.rate_date DESC
                LIMIT 1
              )
            END
          ) < 1000 AND (
            CASE
              WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN c.signing_value
              WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN c.signing_value / 1.95583
              ELSE c.signing_value * (
                SELECT f.eur_per_unit
                FROM fx_rates f
                WHERE f.base_currency = c.currency
                  AND f.rate_date <= c.contract_date
                  AND f.rate_date >= date(c.contract_date, '-10 days')
                ORDER BY f.rate_date DESC
                LIMIT 1
              )
            END
          ) / NULLIF((
            CASE
              WHEN COALESCE(NULLIF(c.procurement_currency, ''), NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN c.estimated_value
              WHEN COALESCE(NULLIF(c.procurement_currency, ''), NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN c.estimated_value / 1.95583
              ELSE c.estimated_value * (
                SELECT f.eur_per_unit
                FROM fx_rates f
                WHERE f.base_currency = COALESCE(NULLIF(c.procurement_currency, ''), NULLIF(c.currency, ''))
                  AND f.rate_date <= c.contract_date
                  AND f.rate_date >= date(c.contract_date, '-10 days')
                ORDER BY f.rate_date DESC
                LIMIT 1
              )
            END
          ), 0) < 0.05 THEN 'value_low'
          WHEN c.current_value IS NOT NULL AND (c.current_value < 0 OR (c.signing_value > 0 AND c.current_value / c.signing_value >= 100)) THEN 'annex_suspect'
          WHEN c.proc_est_eur > 0 AND c.eff_eur >= 10 * c.proc_est_eur THEN 'review'
          ELSE 'ok'
        END AS value_flag,
        CASE
          WHEN TRIM(CASE WHEN c.contractor_eik LIKE 'ЕИК %' THEN SUBSTR(c.contractor_eik, 5) ELSE c.contractor_eik END) NOT GLOB '*[^0-9]*'
           AND LENGTH(TRIM(CASE WHEN c.contractor_eik LIKE 'ЕИК %' THEN SUBSTR(c.contractor_eik, 5) ELSE c.contractor_eik END)) IN (9, 13)
          THEN 'eik:' || TRIM(CASE WHEN c.contractor_eik LIKE 'ЕИК %' THEN SUBSTR(c.contractor_eik, 5) ELSE c.contractor_eik END)
          WHEN c.contractor_name IS NOT NULL AND TRIM(c.contractor_name) <> '' THEN 'name:' || UPPER(TRIM(REPLACE(REPLACE(c.contractor_name, '  ', ' '), '  ', ' ')))
          ELSE NULL
        END AS bidder_key
      FROM (
        SELECT c.*,
          CASE
            WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN COALESCE(c.current_value, c.signing_value)
            WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN COALESCE(c.current_value, c.signing_value) / 1.95583
            ELSE COALESCE(c.current_value, c.signing_value) * (
              SELECT f.eur_per_unit
              FROM fx_rates f
              WHERE f.base_currency = NULLIF(c.currency, '')
                AND f.rate_date <= c.contract_date
                AND f.rate_date >= date(c.contract_date, '-10 days')
              ORDER BY f.rate_date DESC
              LIMIT 1
            )
          END AS eff_eur,
          CASE
            WHEN t.estimated_value IS NULL THEN NULL
            WHEN COALESCE(NULLIF(t.currency, ''), 'BGN') = 'EUR' THEN t.estimated_value
            WHEN COALESCE(NULLIF(t.currency, ''), 'BGN') = 'BGN' THEN t.estimated_value / 1.95583
            ELSE t.estimated_value * (
              SELECT f.eur_per_unit
              FROM fx_rates f
              WHERE f.base_currency = NULLIF(t.currency, '')
                AND f.rate_date <= c.contract_date
                AND f.rate_date >= date(c.contract_date, '-10 days')
              ORDER BY f.rate_date DESC
              LIMIT 1
            )
          END AS proc_est_eur,
          t.estimated_value AS proc_est_native
        FROM raw_contracts c
        LEFT JOIN tenders t ON t.id = 't:' || c.unp
      ) c
      -- Eligibility must mirror the INSERT INTO contracts WHERE exactly, so this candidate count is a
      -- true superset of what lands (inserted <= candidates holds by construction; the gap is only the
      -- EOP cumulative-bucket dedup). The OCDS branch deliberately has NO `contract_number IS NOT NULL`
      -- guard — the INSERT's OCDS branch keeps a null-contract_number row (NOT EXISTS over a NULL join
      -- is TRUE), so requiring it here would undercount and make a real insert look like inserted>candidates.
      WHERE c.source LIKE 'eop:%'
         OR (c.source LIKE 'ocds:%' AND NOT EXISTS (
              SELECT 1 FROM raw_contracts a
              WHERE a.source LIKE 'eop:%' AND a.contract_number = c.contract_number))
    ) c
    WHERE c.bidder_key IS NOT NULL
      AND CASE c.value_flag
        WHEN 'annex_suspect' THEN COALESCE(c.signing_value, c.current_value)
        ELSE COALESCE(c.current_value, c.signing_value)
      END IS NOT NULL
      AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || c.unp)
      AND EXISTS (SELECT 1 FROM bidders b WHERE b.id = c.bidder_key)
  )),
  (SELECT COUNT(*) FROM contracts),
  datetime('now');

-- Summary (last result set printed by `wrangler d1 execute`)
SELECT
  (SELECT COUNT(*) FROM authorities)                              AS authorities,
  (SELECT COUNT(*) FROM tenders)                                  AS tenders,
  (SELECT COUNT(*) FROM lots)                                     AS lots,
  (SELECT COUNT(*) FROM bidders)                                  AS bidders,
  (SELECT COUNT(*) FROM bidders WHERE eik_valid = 0)              AS bidders_name_keyed,
  (SELECT COUNT(*) FROM bidders WHERE kind = 'consortium')        AS consortia,
  (SELECT COUNT(*) FROM contracts)                                AS contracts,
  (SELECT contract_candidates FROM pipeline_stats)                AS contract_candidates,
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'value_suspect') AS value_suspect,
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'annex_suspect') AS annex_suspect,
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'review')    AS review,
  (SELECT COUNT(*) FROM contracts WHERE fx_converted = 1)         AS fx_converted,
  (SELECT ROUND(SUM(amount_eur) / 1e9, 2) FROM contracts)        AS clean_total_eur_bn,
  (SELECT GROUP_CONCAT(source || ':' || COALESCE(as_of, '?') || '(' || rows || ')', ' ') FROM data_freshness) AS data_as_of;
