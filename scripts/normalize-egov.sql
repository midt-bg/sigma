-- Sigma — normalise the admin ЦАИС ЕОП staging into the domain tables
-- (authorities, tenders, lots, bidders, contracts). Run AFTER scripts/load-admin.mjs
-- (+ scripts/derive-amendments.sql for current_value/annex_count) have populated staging:
--   (cd apps/api && wrangler d1 execute sigma --local --file ../../scripts/normalize-egov.sql)
--
-- SOURCE MODEL (see docs/etl-pipeline.md): the admin export is the authoritative base for
-- 2020–2026 (raw_egov_contracts + raw_egov_tenders, source 'admin:%'). The OCDS JSON feed is the
-- go-forward delta for new 2026+ data (source 'ocds:%'); its rows carry their procedure fields on
-- the contract row, so they flow through here automatically and a УНП with no tenders-export row
-- gets a synthetic tender (step 2b). DEDUPE (step 5): where OCDS overlaps the admin snapshot,
-- ADMIN WINS — an OCDS contract is taken only when no admin row shares its contract_number (the
-- АОП contract document number, common to both feeds; OCDS keeps its ocid in unp, which never
-- matches the admin УНП, so contract_number is the cross-source key). Genuinely new OCDS contracts
-- are added. This makes the OCDS go-live catch-up safe even though OCDS republishes contracts
-- already in admin. data_freshness records the "current as of" boundary per feed.
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
--     the admin "възложена на група" flag (awarded_to_group), not a name heuristic. Members
--     hidden behind a single consortium ЕИК need the Търговски регистър (joined on ЕИК) — a
--     later pipeline; bidder_members stays empty and contract_participants attributes the full
--     value to the consortium entity (role 'consortium_unresolved').
--   * Tenders come from the tenders-export header row (one per УНП); lots from its lot rows.
--     11k+ УНП appear only in contracts (no tenders row) → a synthetic 'неизвестна' tender so
--     every contract has a parent. bids stays empty (the data has a bid COUNT, not bids).

-- Full clear in child→parent order (D1 enforces FKs). risk_scores is a dependent and is stale after
-- a domain reload; it is recomputed by apps/etl after this runs.
DELETE FROM bidder_members;
DELETE FROM contracts;
DELETE FROM risk_scores;
DELETE FROM lots;
DELETE FROM tenders;
DELETE FROM bidders;
DELETE FROM authorities;

-- 1) Authorities — dedupe on ЕИК across both contracts and tenders staging, keep a
--    canonical display name and the authority type (Вид на възложителя).
INSERT OR IGNORE INTO authorities (id, name, bulstat, type)
SELECT 'auth:' || authority_eik, MIN(authority_name), authority_eik, MAX(authority_type)
FROM (
  SELECT authority_eik, authority_name, authority_type FROM raw_egov_contracts WHERE authority_eik IS NOT NULL
  UNION ALL
  SELECT authority_eik, authority_name, authority_type FROM raw_egov_tenders   WHERE authority_eik IS NOT NULL
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
   eu_programme, green, social, innovation, eauction, cancelled)
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
  CASE WHEN EXISTS (SELECT 1 FROM raw_egov_contracts c WHERE c.unp = t.unp) THEN 'awarded' ELSE 'published' END,
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
  t.cancelled
FROM raw_egov_tenders t
WHERE t.lot_id IS NULL;

-- 2b) Synthetic tenders — УНП that appear only in contracts (no tenders-export row), so
--     every contract has a parent. Procedure type is unknown ('неизвестна'); subject/CPV/
--     estimated are taken from the contract line.
INSERT OR IGNORE INTO tenders
  (id, source_id, title, authority_id, cpv_code, estimated_value, currency,
   procedure_type, contract_kind, status, legal_basis, award_criteria)
SELECT
  't:' || c.unp,
  c.unp,
  COALESCE(MIN(c.procurement_subject), '(без предмет)'),
  'auth:' || MIN(c.authority_eik),
  MIN(c.cpv_code),
  MIN(c.estimated_value),
  COALESCE(MIN(c.currency), 'BGN'),
  'неизвестна',
  MIN(c.contract_kind),
  'awarded',
  MIN(c.legal_basis),
  MIN(c.award_criteria)
FROM raw_egov_contracts c
WHERE c.unp IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM raw_egov_tenders t WHERE t.unp = c.unp)
GROUP BY c.unp;

-- 3) Lots — the lot rows of each procurement (lot_id IS NOT NULL), linked to their tender.
INSERT OR IGNORE INTO lots (id, tender_id, title, cpv_code, estimated_value)
SELECT
  'lot:' || t.unp || ':' || t.lot_id,
  't:' || t.unp,
  COALESCE(t.lot_name, '(без предмет)'),
  t.cpv_code,
  t.estimated_value
FROM raw_egov_tenders t
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
    FROM raw_egov_contracts WHERE source LIKE 'admin:%' OR source LIKE 'ocds:%'
  )
)
WHERE bidder_key IS NOT NULL
GROUP BY bidder_key;

-- 5) Contracts — awarded lines (1:1 with staging rows), linked to tender + winning bidder,
--    with the data-quality verdict (see 0007_data_quality.sql):
--      value_flag = 'value_suspect'  signed value ≥100× estimate (untrustworthy, excluded from sums)
--                 | 'annex_suspect'  amendment pushed current_value ≥100× signing, or negative →
--                                    fall back to the sane signing value (the contract still counts)
--                 | 'review'         10–100× estimate (kept, but flagged)
--                 | 'ok'
--    `amount` is the as-recorded display value (current_value when an annex legitimately raised it,
--    else signing; signing for annex_suspect). `amount_eur` is the SAFE-TO-SUM canonical value:
--    BGN→EUR at the fixed peg (÷1.95583), EUR as-is, foreign at the signing-date ECB rate (fx_rates);
--    NULL for value_suspect and any foreign row missing a rate. fx_converted = 1 for foreign rows, and
--    fx_rate carries the applied rate on the row (amount * fx_rate = amount_eur), so the original value,
--    the rate, and the EUR value are all auditable without joining fx_rates.
INSERT OR IGNORE INTO contracts
  (id, tender_id, bidder_id, amount, currency, signed_at,
   contract_number, signing_value, current_value, annex_count, eu_funded, bids_received,
   contract_kind, awarded_to_group, value_flag, amount_eur, fx_converted, fx_rate,
   lot_id, document_number, published_at, contract_subject,
   eu_programme, duration_days, winner_size, contractor_country,
   bids_sme, bids_rejected, bids_non_eea,
   subcontractor_eik, subcontractor_name, subcontract_value,
   eauction, framework, accelerated, strategic)
SELECT
  'c:' || x.id,
  't:' || x.unp,
  x.bidder_key,
  CASE WHEN x.value_flag = 'annex_suspect' THEN x.signing_value ELSE COALESCE(x.current_value, x.signing_value) END,
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
  CASE
    WHEN x.trusted_native IS NULL THEN NULL
    WHEN COALESCE(x.currency, 'BGN') = 'EUR' THEN x.trusted_native
    WHEN COALESCE(x.currency, 'BGN') = 'BGN' THEN x.trusted_native / 1.95583
    ELSE x.trusted_native * (SELECT f.eur_per_unit FROM fx_rates f WHERE f.base_currency = x.currency AND f.rate_date = x.contract_date)
  END,
  CASE WHEN COALESCE(x.currency, 'BGN') NOT IN ('BGN', 'EUR') THEN 1 ELSE 0 END,
  CASE WHEN COALESCE(x.currency, 'BGN') NOT IN ('BGN', 'EUR')
    THEN (SELECT f.eur_per_unit FROM fx_rates f WHERE f.base_currency = x.currency AND f.rate_date = x.contract_date)
    ELSE NULL END,
  CASE WHEN x.lot_id IS NOT NULL AND TRIM(x.lot_id) <> '' THEN 'lot:' || x.unp || ':' || x.lot_id ELSE NULL END,
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
      WHEN 'value_suspect' THEN NULL
      WHEN 'annex_suspect' THEN y.signing_value
      ELSE COALESCE(y.current_value, y.signing_value)
    END AS trusted_native
  FROM (
    SELECT c.*,
      CASE
        WHEN c.estimated_value > 0 AND c.signing_value / c.estimated_value >= 100 THEN 'value_suspect'
        WHEN c.current_value IS NOT NULL AND (c.current_value < 0 OR (c.signing_value > 0 AND c.current_value / c.signing_value >= 100)) THEN 'annex_suspect'
        WHEN c.estimated_value > 0 AND COALESCE(c.current_value, c.signing_value) / c.estimated_value >= 10 THEN 'review'
        ELSE 'ok'
      END AS value_flag,
      CASE
        WHEN TRIM(CASE WHEN c.contractor_eik LIKE 'ЕИК %' THEN SUBSTR(c.contractor_eik, 5) ELSE c.contractor_eik END) NOT GLOB '*[^0-9]*'
         AND LENGTH(TRIM(CASE WHEN c.contractor_eik LIKE 'ЕИК %' THEN SUBSTR(c.contractor_eik, 5) ELSE c.contractor_eik END)) IN (9, 13)
        THEN 'eik:' || TRIM(CASE WHEN c.contractor_eik LIKE 'ЕИК %' THEN SUBSTR(c.contractor_eik, 5) ELSE c.contractor_eik END)
        WHEN c.contractor_name IS NOT NULL AND TRIM(c.contractor_name) <> '' THEN 'name:' || UPPER(TRIM(REPLACE(REPLACE(c.contractor_name, '  ', ' '), '  ', ' ')))
        ELSE NULL
      END AS bidder_key
    FROM raw_egov_contracts c
    -- admin always; an OCDS row only when no admin row shares its contract_number — admin wins.
    -- Key is contract_number (the АОП contract document number, common to both feeds), NOT unp:
    -- OCDS stores its ocid ('ocds-…') in unp, which never matches the admin УНП format. (idx_egov_cnum)
    WHERE c.source LIKE 'admin:%'
       OR (c.source LIKE 'ocds:%' AND c.contract_number IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM raw_egov_contracts a
            WHERE a.source LIKE 'admin:%' AND a.contract_number = c.contract_number))
  ) y
) x
WHERE x.bidder_key IS NOT NULL
  AND COALESCE(x.current_value, x.signing_value) IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || x.unp)
  AND EXISTS (SELECT 1 FROM bidders  b  WHERE b.id  = x.bidder_key);

-- 6) Location enrichment from OCDS parties (raw_ocds_parties, populated by scripts/load-ocds.mjs).
--    Match on ЕИК; take the most-recent non-null value (parties repeat across releases). OCDS covers
--    2026+ entities, so authorities/bidders absent from OCDS keep NULL location until the Trade
--    Register loader fills the rest. No-op when raw_ocds_parties is empty (admin-only import).
UPDATE authorities SET
  nuts       = COALESCE(nuts,       (SELECT p.region_nuts    FROM raw_ocds_parties p WHERE p.eik = authorities.bulstat AND p.region_nuts    IS NOT NULL ORDER BY p.id DESC LIMIT 1)),
  settlement = COALESCE(settlement, (SELECT p.locality       FROM raw_ocds_parties p WHERE p.eik = authorities.bulstat AND p.locality       IS NOT NULL ORDER BY p.id DESC LIMIT 1)),
  address    = COALESCE(address,    (SELECT p.street_address FROM raw_ocds_parties p WHERE p.eik = authorities.bulstat AND p.street_address IS NOT NULL ORDER BY p.id DESC LIMIT 1))
WHERE EXISTS (SELECT 1 FROM raw_ocds_parties p WHERE p.eik = authorities.bulstat);

UPDATE bidders SET
  nuts       = COALESCE(nuts,       (SELECT p.region_nuts    FROM raw_ocds_parties p WHERE p.eik = bidders.eik_normalized AND p.region_nuts    IS NOT NULL ORDER BY p.id DESC LIMIT 1)),
  settlement = COALESCE(settlement, (SELECT p.locality       FROM raw_ocds_parties p WHERE p.eik = bidders.eik_normalized AND p.locality       IS NOT NULL ORDER BY p.id DESC LIMIT 1)),
  address    = COALESCE(address,    (SELECT p.street_address FROM raw_ocds_parties p WHERE p.eik = bidders.eik_normalized AND p.street_address IS NOT NULL ORDER BY p.id DESC LIMIT 1))
WHERE EXISTS (SELECT 1 FROM raw_ocds_parties p WHERE p.eik = bidders.eik_normalized);

-- 7) Company master + ownership from the Trade Register (raw_tr_*, scripts/load-tr.mjs). Latest deed
--    per ЕИК wins. Enriches bidders' seat/legal_form and (re)builds company_owners + beneficial_owners.
--    No-op when raw_tr_* is empty (the open feed is daily deltas; coverage grows via the scheduled job).
UPDATE bidders SET
  legal_form   = COALESCE(legal_form,   (SELECT c.legal_form        FROM raw_tr_companies c WHERE c.uic = bidders.eik_normalized AND c.legal_form        IS NOT NULL ORDER BY c.file_date DESC, c.id DESC LIMIT 1)),
  settlement   = COALESCE(settlement,   (SELECT c.settlement        FROM raw_tr_companies c WHERE c.uic = bidders.eik_normalized AND c.settlement        IS NOT NULL ORDER BY c.file_date DESC, c.id DESC LIMIT 1)),
  ekatte       = COALESCE(ekatte,       (SELECT c.settlement_ekatte FROM raw_tr_companies c WHERE c.uic = bidders.eik_normalized AND c.settlement_ekatte IS NOT NULL ORDER BY c.file_date DESC, c.id DESC LIMIT 1)),
  municipality = COALESCE(municipality, (SELECT c.municipality      FROM raw_tr_companies c WHERE c.uic = bidders.eik_normalized AND c.municipality      IS NOT NULL ORDER BY c.file_date DESC, c.id DESC LIMIT 1)),
  address      = COALESCE(address,      (SELECT TRIM(COALESCE(c.street,'') || ' ' || COALESCE(c.street_number,'')) FROM raw_tr_companies c WHERE c.uic = bidders.eik_normalized AND c.street IS NOT NULL ORDER BY c.file_date DESC, c.id DESC LIMIT 1))
WHERE EXISTS (SELECT 1 FROM raw_tr_companies c WHERE c.uic = bidders.eik_normalized);

DELETE FROM company_owners;
INSERT OR IGNORE INTO company_owners (company_eik, role, owner_name, owner_eik, indent_type, share_pct, country, source)
SELECT o.uic, o.role, o.owner_name, MAX(o.owner_uic), MAX(o.indent_type), NULL, MAX(o.country), MIN(o.source)
FROM raw_tr_owners o WHERE o.owner_name IS NOT NULL
GROUP BY o.uic, o.role, o.owner_name;

DELETE FROM beneficial_owners;
INSERT OR IGNORE INTO beneficial_owners (company_eik, owner_name, country, indent_type, source)
SELECT a.uic, a.owner_name, MAX(a.country), MAX(a.indent_type), MIN(a.source)
FROM raw_tr_actual_owners a WHERE a.owner_name IS NOT NULL
GROUP BY a.uic, a.owner_name;

-- 8) Region from NUTS (nuts_regions, seeded by scripts/load-nuts.sql) — labels the OCDS-sourced NUTS
--    codes and fills authorities.region (област) where empty. No-op if nuts_regions is unseeded.
UPDATE authorities SET region = (SELECT n.nuts3_name FROM nuts_regions n WHERE n.nuts3 = authorities.nuts)
WHERE authorities.nuts IS NOT NULL AND authorities.region IS NULL;

-- Freshness boundary — "data current as of" per feed (latest real contract date + row count),
-- for the UI and to verify the OCDS go-forward catch-up. Recomputed each run.
DELETE FROM data_freshness;
INSERT INTO data_freshness (source, as_of, rows, refreshed_at)
SELECT
  CASE WHEN source LIKE 'admin:%' THEN 'admin' WHEN source LIKE 'ocds:%' THEN 'ocds' ELSE 'other' END AS src,
  MAX(CASE WHEN contract_date <= date('now') THEN contract_date END),
  COUNT(*),
  datetime('now')
FROM raw_egov_contracts
GROUP BY src;

-- Summary (last result set printed by `wrangler d1 execute`)
SELECT
  (SELECT COUNT(*) FROM authorities)                              AS authorities,
  (SELECT COUNT(*) FROM tenders)                                  AS tenders,
  (SELECT COUNT(*) FROM lots)                                     AS lots,
  (SELECT COUNT(*) FROM bidders)                                  AS bidders,
  (SELECT COUNT(*) FROM bidders WHERE eik_valid = 0)              AS bidders_name_keyed,
  (SELECT COUNT(*) FROM bidders WHERE kind = 'consortium')        AS consortia,
  (SELECT COUNT(*) FROM contracts)                                AS contracts,
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'value_suspect') AS value_suspect,
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'annex_suspect') AS annex_suspect,
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'review')    AS review,
  (SELECT COUNT(*) FROM contracts WHERE fx_converted = 1)         AS fx_converted,
  (SELECT ROUND(SUM(amount_eur) / 1e9, 2) FROM contracts)        AS clean_total_eur_bn,
  (SELECT GROUP_CONCAT(source || ':' || COALESCE(as_of, '?') || '(' || rows || ')', ' ') FROM data_freshness) AS data_as_of;
