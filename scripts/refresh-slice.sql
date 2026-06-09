-- Sigma — daily refresh: derive the OCDS go-forward delta into the domain + refresh ONLY the
-- affected rollup/FTS rows. Run by apps/etl's RefreshWorkflow after the OCDS staging is upserted;
-- also runnable via sqlite3/wrangler for tests and manual catch-up.
--
-- SCOPED + IDEMPOTENT. It replaces only c:e:/c:o: contracts represented by the transient window
-- and refreshes the rollup rows for c:e:/c:o: entities. Admin-derived c: rows are left alone.
-- EOP wins over OCDS when both feeds carry the same public contract document number. Re-running the
-- same window yields the same domain rows. Mirrors normalize-egov.sql steps 1/2b/4/5 plus
-- precompute.sql, scoped.

-- The base-wins dedup probes contracts by АОП document number — index it (no-op if already present).
CREATE INDEX IF NOT EXISTS idx_contracts_cnum ON contracts(contract_number);

-- ── 1) Authorities referenced by OCDS staging (new ones only; INSERT OR IGNORE) ────────────────────
INSERT OR IGNORE INTO authorities (id, name, bulstat, type)
SELECT 'auth:' || authority_eik, MIN(authority_name), authority_eik, MAX(authority_type)
FROM (
  SELECT source, authority_eik, authority_name, authority_type FROM raw_egov_contracts
  UNION ALL
  SELECT source, authority_eik, authority_name, authority_type FROM raw_egov_tenders
)
WHERE (source LIKE 'eop:%' OR source LIKE 'ocds:%') AND authority_eik IS NOT NULL
GROUP BY authority_eik;

-- type_group for any authority still missing it (covers the rows just inserted) — same heuristic as
-- normalize-egov.sql step 1b.
UPDATE authorities SET type_group = CASE
  WHEN name LIKE 'Община%' OR name LIKE 'ОБЩИНА%' OR name LIKE '%Столична община%' OR name LIKE '%СТОЛИЧНА ОБЩИНА%' THEN 'община'
  WHEN name LIKE 'Министерство%' OR name LIKE 'МИНИСТЕРСТВО%' THEN 'министерство'
  WHEN name LIKE '%болница%' OR name LIKE '%БОЛНИЦА%' OR name LIKE 'МБАЛ%' OR name LIKE '%МБАЛ%' OR name LIKE '%СБАЛ%' OR name LIKE '%ДКЦ%' OR name LIKE '%лечебно заведение%' THEN 'болница'
  WHEN name LIKE '%университет%' OR name LIKE '%УНИВЕРСИТЕТ%' OR name LIKE '%училище%' OR name LIKE '%УЧИЛИЩЕ%' OR name LIKE '%гимназия%' OR name LIKE '%ГИМНАЗИЯ%' OR name LIKE '%детска градина%' OR name LIKE '%ДЕТСКА ГРАДИНА%' OR name LIKE '%академия%' THEN 'образование'
  WHEN name LIKE '%агенция%' OR name LIKE '%Агенция%' OR name LIKE '%АГЕНЦИЯ%' THEN 'агенция'
  WHEN type LIKE 'Публично предприятие%' OR type LIKE 'Комунални услуги%' THEN 'държавна компания'
  ELSE 'друго'
END
WHERE type_group IS NULL;

-- ── 2) Bidders referenced by OCDS staging (new ones only) — same identity rule as normalize step 4 ──
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
  SELECT contractor_name, eik_clean,
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
    SELECT contractor_name,
      TRIM(CASE WHEN contractor_eik LIKE 'ЕИК %' THEN SUBSTR(contractor_eik, 5) ELSE contractor_eik END) AS eik_clean
    FROM raw_egov_contracts WHERE source LIKE 'eop:%' OR source LIKE 'ocds:%'
  )
)
WHERE bidder_key IS NOT NULL
GROUP BY bidder_key;

-- EOP tender headers and lots loaded since the last full normalize.
INSERT INTO tenders
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
WHERE t.lot_id IS NULL
  AND EXISTS (SELECT 1 FROM authorities a WHERE a.id = 'auth:' || t.authority_eik)
ON CONFLICT(id) DO UPDATE SET
  source_id = CASE WHEN tenders.procedure_type = 'неизвестна' THEN excluded.source_id ELSE tenders.source_id END,
  title = CASE WHEN tenders.procedure_type = 'неизвестна' THEN excluded.title ELSE tenders.title END,
  authority_id = CASE WHEN tenders.procedure_type = 'неизвестна' THEN excluded.authority_id ELSE tenders.authority_id END,
  cpv_code = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.cpv_code, tenders.cpv_code) ELSE tenders.cpv_code END,
  cpv_description = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.cpv_description, tenders.cpv_description) ELSE tenders.cpv_description END,
  estimated_value = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.estimated_value, tenders.estimated_value) ELSE tenders.estimated_value END,
  currency = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.currency, tenders.currency) ELSE tenders.currency END,
  procedure_type = CASE WHEN tenders.procedure_type = 'неизвестна' THEN excluded.procedure_type ELSE tenders.procedure_type END,
  contract_kind = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.contract_kind, tenders.contract_kind) ELSE tenders.contract_kind END,
  num_lots = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.num_lots, tenders.num_lots) ELSE tenders.num_lots END,
  status = CASE WHEN excluded.status = 'awarded' THEN 'awarded' ELSE tenders.status END,
  published_at = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.published_at, tenders.published_at) ELSE tenders.published_at END,
  deadline_at = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.deadline_at, tenders.deadline_at) ELSE tenders.deadline_at END,
  legal_basis = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.legal_basis, tenders.legal_basis) ELSE tenders.legal_basis END,
  award_criteria = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.award_criteria, tenders.award_criteria) ELSE tenders.award_criteria END,
  main_activity = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.main_activity, tenders.main_activity) ELSE tenders.main_activity END,
  notice_type = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.notice_type, tenders.notice_type) ELSE tenders.notice_type END,
  place_of_performance = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.place_of_performance, tenders.place_of_performance) ELSE tenders.place_of_performance END,
  start_date = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.start_date, tenders.start_date) ELSE tenders.start_date END,
  end_date = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.end_date, tenders.end_date) ELSE tenders.end_date END,
  duration = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.duration, tenders.duration) ELSE tenders.duration END,
  duration_unit = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.duration_unit, tenders.duration_unit) ELSE tenders.duration_unit END,
  eu_programme = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.eu_programme, tenders.eu_programme) ELSE tenders.eu_programme END,
  green = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.green, tenders.green) ELSE tenders.green END,
  social = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.social, tenders.social) ELSE tenders.social END,
  innovation = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.innovation, tenders.innovation) ELSE tenders.innovation END,
  eauction = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.eauction, tenders.eauction) ELSE tenders.eauction END,
  cancelled = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.cancelled, tenders.cancelled) ELSE tenders.cancelled END;

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
FROM raw_egov_tenders t
WHERE t.lot_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || t.unp);

-- Party/contact enrichment for entities touched by the refreshed staging.
UPDATE authorities SET
  nuts       = COALESCE((SELECT p.region_nuts    FROM raw_ocds_parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.region_nuts, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), nuts),
  settlement = COALESCE((SELECT p.locality       FROM raw_ocds_parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.locality, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), settlement),
  address    = COALESCE((SELECT p.street_address FROM raw_ocds_parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.street_address, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), address),
  contact_email = COALESCE((SELECT p.contact_email FROM raw_ocds_parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.contact_email, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_email),
  contact_phone = COALESCE((SELECT p.contact_phone FROM raw_ocds_parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.contact_phone, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_phone)
WHERE EXISTS (SELECT 1 FROM raw_ocds_parties p WHERE p.eik = authorities.bulstat);

UPDATE bidders SET
  nuts       = COALESCE((SELECT p.region_nuts    FROM raw_ocds_parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.region_nuts, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), nuts),
  settlement = COALESCE((SELECT p.locality       FROM raw_ocds_parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.locality, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), settlement),
  address    = COALESCE((SELECT p.street_address FROM raw_ocds_parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.street_address, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), address),
  contact_email = COALESCE((SELECT p.contact_email FROM raw_ocds_parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.contact_email, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_email),
  contact_phone = COALESCE((SELECT p.contact_phone FROM raw_ocds_parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.contact_phone, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_phone)
WHERE EXISTS (SELECT 1 FROM raw_ocds_parties p WHERE p.eik = bidders.eik_normalized);

UPDATE authorities
SET region = (SELECT n.nuts3_name FROM nuts_regions n WHERE n.nuts3 = authorities.nuts)
WHERE authorities.nuts IS NOT NULL
  AND EXISTS (SELECT 1 FROM nuts_regions n WHERE n.nuts3 = authorities.nuts)
  AND (
    EXISTS (SELECT 1 FROM raw_ocds_parties p WHERE p.eik = authorities.bulstat)
    OR EXISTS (SELECT 1 FROM raw_egov_contracts c WHERE c.authority_eik = authorities.bulstat)
    OR EXISTS (SELECT 1 FROM raw_egov_tenders t WHERE t.authority_eik = authorities.bulstat)
  );

CREATE INDEX IF NOT EXISTS idx_egov_tenders_tender_id ON raw_egov_tenders(tender_id);
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
  JOIN raw_egov_tenders rt ON rt.tender_id = rl.tender_id
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

-- ── 3) Synthetic 'неизвестна' tenders for OCDS УНП (ocid) — matches normalize step 2b ───────────────
INSERT OR IGNORE INTO tenders
  (id, source_id, title, authority_id, cpv_code, estimated_value, currency, procedure_type, contract_kind, status, legal_basis, award_criteria)
SELECT
  't:' || c.unp, c.unp, COALESCE(MIN(c.procurement_subject), '(без предмет)'),
  'auth:' || MIN(c.authority_eik), MIN(c.cpv_code), MIN(c.estimated_value),
  COALESCE(MIN(c.currency), 'BGN'), 'неизвестна', MIN(c.contract_kind), 'awarded', MIN(c.legal_basis), MIN(c.award_criteria)
FROM raw_egov_contracts c
WHERE (c.source LIKE 'eop:%' OR c.source LIKE 'ocds:%') AND c.unp IS NOT NULL
  AND EXISTS (SELECT 1 FROM authorities a WHERE a.id = 'auth:' || c.authority_eik)
GROUP BY c.unp;

-- 4) Contracts - replace rows represented by the transient window, then re-derive deltas.
DELETE FROM contracts
WHERE id GLOB 'c:[eo]:*'
  AND EXISTS (
    SELECT 1
    FROM raw_egov_contracts r
    WHERE r.contract_number = contracts.contract_number
      AND 't:' || r.unp = contracts.tender_id
      AND (
        (contracts.id LIKE 'c:e:%' AND r.source LIKE 'eop:%')
        OR (contracts.id LIKE 'c:o:%' AND r.source LIKE 'ocds:%')
      )
  );
INSERT OR IGNORE INTO contracts
  (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, signing_value, current_value,
   annex_count, eu_funded, bids_received, contract_kind, awarded_to_group, value_flag, amount_eur,
   fx_converted, fx_rate, signing_value_eur, current_value_eur,
   lot_id, document_number, published_at, contract_subject,
   eu_programme, duration_days, winner_size, contractor_country,
   bids_sme, bids_rejected, bids_non_eea,
   subcontractor_eik, subcontractor_name, subcontract_value,
   eauction, framework, accelerated, strategic)
SELECT
  'c:o:' || x.unp || ':' || x.contract_number || ':' ||
    COALESCE(NULLIF(x.lot_id, ''), '_') || ':' || x.bidder_key || ':' || x.contract_ordinal,
  't:' || x.unp,
  x.bidder_key,
  x.display_native,
  COALESCE(x.currency, 'BGN'),
  x.contract_date,
  x.contract_number,
  x.signing_value,
  x.current_value,
  0,
  x.eu_funded,
  x.bids_received,
  x.contract_kind,
  x.awarded_to_group,
  x.value_flag,
  x.amount_eur,
  CASE WHEN COALESCE(x.currency, 'BGN') NOT IN ('BGN', 'EUR') THEN 1 ELSE 0 END,
  x.fx_rate,
  x.signing_value_eur,
  x.current_value_eur,
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
  SELECT q.*,
    CASE
      WHEN q.value_flag = 'value_suspect' THEN NULL
      WHEN COALESCE(q.currency,'BGN') = 'EUR' THEN q.trusted_native
      WHEN COALESCE(q.currency,'BGN') = 'BGN' THEN q.trusted_native / 1.95583
      ELSE q.trusted_native * q.fx_rate
    END AS amount_eur,
    CASE
      WHEN q.value_flag = 'value_suspect' OR q.signing_value IS NULL THEN NULL
      WHEN COALESCE(q.currency,'BGN') = 'EUR' THEN q.signing_value
      WHEN COALESCE(q.currency,'BGN') = 'BGN' THEN q.signing_value / 1.95583
      ELSE q.signing_value * q.fx_rate
    END AS signing_value_eur,
    CASE
      WHEN q.value_flag IN ('value_suspect', 'annex_suspect') OR q.current_value IS NULL THEN NULL
      WHEN COALESCE(q.currency,'BGN') = 'EUR' THEN q.current_value
      WHEN COALESCE(q.currency,'BGN') = 'BGN' THEN q.current_value / 1.95583
      ELSE q.current_value * q.fx_rate
    END AS current_value_eur
  FROM (
    SELECT y.*,
      CASE y.value_flag
        WHEN 'annex_suspect' THEN COALESCE(y.signing_value, y.current_value)
        ELSE COALESCE(y.current_value, y.signing_value)
      END AS display_native,
      CASE y.value_flag
        WHEN 'value_suspect' THEN NULL
        WHEN 'annex_suspect' THEN COALESCE(y.signing_value, y.current_value)
        ELSE COALESCE(y.current_value, y.signing_value)
      END AS trusted_native,
      -- fx: EUR as-is, BGN at the peg, foreign at the signing-date ECB rate (NULL if missing)
      CASE WHEN COALESCE(y.currency,'BGN') NOT IN ('BGN','EUR')
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
          PARTITION BY z.unp, z.contract_number, z.bidder_key, COALESCE(NULLIF(z.lot_id, ''), '_')
          ORDER BY z.id
        ) AS contract_ordinal
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
        WHERE c.source LIKE 'ocds:%' AND c.contract_number IS NOT NULL
      ) z
    ) y
  ) q
) x
WHERE x.bidder_key IS NOT NULL
  AND x.display_native IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || x.unp)
  AND EXISTS (SELECT 1 FROM bidders b WHERE b.id = x.bidder_key)
  -- EOP wins: skip OCDS rows when the transient window has an EOP row for the same document.
  AND NOT EXISTS (
    SELECT 1 FROM raw_egov_contracts e
    WHERE e.source LIKE 'eop:%'
      AND e.contract_number = x.contract_number
  )
  -- Existing admin rows also win.
  AND NOT EXISTS (SELECT 1 FROM contracts c2 WHERE c2.contract_number = x.contract_number AND c2.id NOT GLOB 'c:[eo]:*')
  -- Existing EOP rows win over later OCDS-only windows too.
  AND NOT EXISTS (SELECT 1 FROM contracts c3 WHERE c3.id GLOB 'c:e:*' AND c3.contract_number = x.contract_number);

-- EOP base rows loaded after the last full normalize. This mirrors normalize-egov.sql's EOP branch:
-- newest cumulative bucket wins, existing full-normalize rows win over refresh rows.
DELETE FROM contracts
WHERE id GLOB 'c:o:*'
  AND EXISTS (
    SELECT 1 FROM raw_egov_contracts e
    WHERE e.source LIKE 'eop:%'
      AND e.contract_number = contracts.contract_number
  );

INSERT OR IGNORE INTO contracts
  (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, signing_value, current_value,
   annex_count, eu_funded, bids_received, contract_kind, awarded_to_group, value_flag, amount_eur,
   fx_converted, fx_rate, signing_value_eur, current_value_eur,
   lot_id, document_number, published_at, contract_subject,
   eu_programme, duration_days, winner_size, contractor_country,
   bids_sme, bids_rejected, bids_non_eea,
   subcontractor_eik, subcontractor_name, subcontract_value,
   eauction, framework, accelerated, strategic)
SELECT
  'c:e:' || x.unp || ':' || x.contract_number || ':' ||
    COALESCE(NULLIF(x.lot_norm, ''), '_') || ':' || x.bidder_key || ':' || x.contract_ordinal,
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
  x.amount_eur,
  CASE WHEN COALESCE(x.currency, 'BGN') NOT IN ('BGN', 'EUR') THEN 1 ELSE 0 END,
  x.fx_rate,
  x.signing_value_eur,
  x.current_value_eur,
  CASE WHEN x.lot_norm IS NOT NULL AND TRIM(x.lot_norm) <> '' THEN 'lot:' || x.unp || ':' || x.lot_norm ELSE NULL END,
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
  SELECT q.*,
    CASE
      WHEN q.value_flag = 'value_suspect' THEN NULL
      WHEN COALESCE(q.currency,'BGN') = 'EUR' THEN q.trusted_native
      WHEN COALESCE(q.currency,'BGN') = 'BGN' THEN q.trusted_native / 1.95583
      ELSE q.trusted_native * q.fx_rate
    END AS amount_eur,
    CASE
      WHEN q.value_flag = 'value_suspect' OR q.signing_value IS NULL THEN NULL
      WHEN COALESCE(q.currency,'BGN') = 'EUR' THEN q.signing_value
      WHEN COALESCE(q.currency,'BGN') = 'BGN' THEN q.signing_value / 1.95583
      ELSE q.signing_value * q.fx_rate
    END AS signing_value_eur,
    CASE
      WHEN q.value_flag IN ('value_suspect', 'annex_suspect') OR q.current_value IS NULL THEN NULL
      WHEN COALESCE(q.currency,'BGN') = 'EUR' THEN q.current_value
      WHEN COALESCE(q.currency,'BGN') = 'BGN' THEN q.current_value / 1.95583
      ELSE q.current_value * q.fx_rate
    END AS current_value_eur
  FROM (
    SELECT y.*,
      CASE y.value_flag
        WHEN 'annex_suspect' THEN COALESCE(y.signing_value, y.current_value)
        ELSE COALESCE(y.current_value, y.signing_value)
      END AS display_native,
      CASE y.value_flag
        WHEN 'value_suspect' THEN NULL
        WHEN 'annex_suspect' THEN COALESCE(y.signing_value, y.current_value)
        ELSE COALESCE(y.current_value, y.signing_value)
      END AS trusted_native,
      CASE WHEN COALESCE(y.currency,'BGN') NOT IN ('BGN','EUR')
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
          PARTITION BY z.unp, z.contract_number, z.bidder_key, COALESCE(NULLIF(z.lot_norm, ''), '_')
          ORDER BY z.id
        ) AS contract_ordinal
      FROM (
        SELECT c.*,
          CASE
            WHEN c.lot_id LIKE 'LOT-%' AND REPLACE(c.lot_id, 'LOT-', '') <> '' AND REPLACE(c.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(c.lot_id, 'LOT-', '') AS INTEGER)
            WHEN c.lot_id <> '' AND c.lot_id NOT GLOB '*[^0-9]*' THEN CAST(c.lot_id AS INTEGER)
            ELSE c.lot_id
          END AS lot_norm,
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
        WHERE c.source LIKE 'eop:%'
          AND NOT EXISTS (
            SELECT 1 FROM raw_egov_contracts a
            WHERE a.source LIKE 'eop:%'
              AND a.contract_number = c.contract_number
              AND COALESCE(a.unp, '') = COALESCE(c.unp, '')
              AND COALESCE(a.lot_id, '') = COALESCE(c.lot_id, '')
              AND COALESCE(a.contractor_eik, '') = COALESCE(c.contractor_eik, '')
              AND COALESCE(a.contractor_name, '') = COALESCE(c.contractor_name, '')
              AND (a.source > c.source OR (a.source = c.source AND a.id > c.id)))
      ) z
    ) y
  ) q
) x
WHERE x.bidder_key IS NOT NULL
  AND x.display_native IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || x.unp)
  AND EXISTS (SELECT 1 FROM bidders b WHERE b.id = x.bidder_key)
  AND NOT EXISTS (
    SELECT 1 FROM contracts c2
    WHERE c2.id NOT GLOB 'c:[eo]:*'
      AND c2.contract_number = x.contract_number
      AND c2.tender_id = 't:' || x.unp
      AND COALESCE(c2.lot_id, '') = COALESCE(CASE WHEN x.lot_norm IS NOT NULL AND TRIM(x.lot_norm) <> '' THEN 'lot:' || x.unp || ':' || x.lot_norm ELSE NULL END, '')
      AND c2.bidder_id = x.bidder_key
  );


-- 5) Promote window amendments into served domain history and roll touched contracts.
INSERT OR REPLACE INTO amendments (
  id, natural_key, contract_number, unp, value_before, value_after, value_delta, currency,
  published_at, document_number, description, source
)
WITH keyed AS (
  SELECT
    *,
    'am:' || COALESCE(unp, '') || ':' || COALESCE(contract_number, '') || ':' ||
      COALESCE(
        NULLIF(document_number, ''),
        NULLIF(correction_number, ''),
        NULLIF(seq_no, ''),
        'content:' || COALESCE(published_at, '') || ':' ||
          COALESCE(CAST(value_before AS TEXT), '') || ':' ||
          COALESCE(CAST(value_after AS TEXT), '') || ':' ||
          COALESCE(CAST(value_delta AS TEXT), '') || ':' ||
          COALESCE(currency, '') || ':' ||
          COALESCE(description, '')
      ) AS natural_key
  FROM raw_egov_amendments
), dedup AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY natural_key
      ORDER BY source DESC, id DESC
    ) AS rn
  FROM keyed
)
SELECT
  natural_key,
  natural_key,
  contract_number,
  unp,
  value_before,
  value_after,
  value_delta,
  currency,
  published_at,
  document_number,
  description,
  source
FROM dedup
WHERE rn = 1;

UPDATE contracts
SET
  annex_count = (
    SELECT COUNT(*) FROM amendments a
    WHERE a.unp = substr(contracts.tender_id, 3)
      AND a.contract_number = contracts.contract_number
  ),
  current_value = (
    SELECT a.value_after FROM amendments a
    WHERE a.unp = substr(contracts.tender_id, 3)
      AND a.contract_number = contracts.contract_number
      AND a.value_after IS NOT NULL
    ORDER BY a.published_at DESC, a.id DESC
    LIMIT 1
  )
WHERE (id GLOB 'c:[eo]:*' AND EXISTS (
      SELECT 1 FROM raw_egov_contracts rc
      WHERE rc.unp = substr(contracts.tender_id, 3)
        AND rc.contract_number = contracts.contract_number
   ))
   OR EXISTS (
      SELECT 1 FROM raw_egov_amendments ra
      WHERE ra.unp = substr(contracts.tender_id, 3)
        AND ra.contract_number = contracts.contract_number
   );

WITH contract_base AS (
  SELECT c.id, c.currency, c.signing_value, c.current_value, c.fx_rate, c.value_flag,
    te.estimated_value AS tender_estimated_value,
    COALESCE((
      SELECT rc.estimated_value
      FROM raw_egov_contracts rc
      WHERE rc.unp = substr(c.tender_id, 3)
        AND rc.contract_number = c.contract_number
        AND (
          (c.id LIKE 'c:e:%' AND rc.source LIKE 'eop:%')
          OR (c.id LIKE 'c:o:%' AND rc.source LIKE 'ocds:%')
        )
      ORDER BY rc.source DESC, rc.id DESC
      LIMIT 1
    ), te.estimated_value) AS classifier_estimated_value
  FROM contracts c
  JOIN tenders te ON te.id = c.tender_id
  WHERE (
      (c.id GLOB 'c:[eo]:*' AND EXISTS (
        SELECT 1 FROM raw_egov_contracts rc
        WHERE rc.unp = substr(c.tender_id, 3)
          AND rc.contract_number = c.contract_number
      ))
      OR EXISTS (
        SELECT 1 FROM raw_egov_amendments ra
        WHERE ra.unp = substr(c.tender_id, 3)
          AND ra.contract_number = c.contract_number
      )
    )
    AND EXISTS (
      SELECT 1 FROM amendments a
      WHERE a.unp = substr(c.tender_id, 3)
        AND a.contract_number = c.contract_number
    )
), base AS (
  SELECT id, currency, signing_value, current_value, fx_rate,
    CASE
      WHEN c.value_flag <> 'annex_suspect'
        AND NOT (c.current_value IS NOT NULL AND (c.current_value < 0 OR (c.signing_value > 0 AND c.current_value / c.signing_value >= 100)))
      THEN c.value_flag
      WHEN COALESCE(classifier_estimated_value, 0) > 0 AND c.signing_value / classifier_estimated_value >= 100 THEN 'value_suspect'
      WHEN c.current_value IS NOT NULL AND (c.current_value < 0 OR (c.signing_value > 0 AND c.current_value / c.signing_value >= 100)) THEN 'annex_suspect'
      WHEN COALESCE(classifier_estimated_value, 0) > 0 AND COALESCE(c.current_value, c.signing_value) / classifier_estimated_value >= 10 THEN 'review'
      ELSE 'ok'
    END AS new_value_flag
  FROM contract_base c
), calc AS (
  SELECT id, new_value_flag,
    CASE new_value_flag
      WHEN 'annex_suspect' THEN COALESCE(signing_value, current_value)
      ELSE COALESCE(current_value, signing_value)
    END AS display_native,
    CASE new_value_flag
      WHEN 'value_suspect' THEN NULL
      WHEN 'annex_suspect' THEN COALESCE(signing_value, current_value)
      ELSE COALESCE(current_value, signing_value)
    END AS trusted_native,
    CASE
      WHEN new_value_flag IN ('value_suspect', 'annex_suspect') OR current_value IS NULL THEN NULL
      WHEN COALESCE(currency, 'BGN') = 'EUR' THEN current_value
      WHEN COALESCE(currency, 'BGN') = 'BGN' THEN current_value / 1.95583
      WHEN fx_rate IS NOT NULL THEN current_value * fx_rate
      ELSE NULL
    END AS new_current_value_eur,
    currency,
    fx_rate,
    signing_value
  FROM base
), recalculated AS (
  SELECT id, new_value_flag, display_native, trusted_native,
    CASE
      WHEN trusted_native IS NULL THEN NULL
      WHEN COALESCE(currency, 'BGN') = 'EUR' THEN trusted_native
      WHEN COALESCE(currency, 'BGN') = 'BGN' THEN trusted_native / 1.95583
      WHEN fx_rate IS NOT NULL THEN trusted_native * fx_rate
      ELSE NULL
    END AS new_amount_eur,
    CASE
      WHEN new_value_flag = 'value_suspect' OR signing_value IS NULL THEN NULL
      WHEN COALESCE(currency, 'BGN') = 'EUR' THEN signing_value
      WHEN COALESCE(currency, 'BGN') = 'BGN' THEN signing_value / 1.95583
      WHEN fx_rate IS NOT NULL THEN signing_value * fx_rate
      ELSE NULL
    END AS new_signing_value_eur,
    new_current_value_eur
  FROM calc
)
UPDATE contracts
SET
  value_flag = recalculated.new_value_flag,
  amount = recalculated.display_native,
  amount_eur = recalculated.new_amount_eur,
  signing_value_eur = recalculated.new_signing_value_eur,
  current_value_eur = recalculated.new_current_value_eur
FROM recalculated
WHERE recalculated.id = contracts.id;

-- 6) Refresh rollups + FTS for the AFFECTED entities only, then the small globals
-- Affected = entities involved in refresh-derived ('c:e:%'/'c:o:%') contracts. The two affected-sets are
-- inlined as subqueries (not TEMP tables) so the whole script runs as one D1 .batch() transaction.
DELETE FROM company_totals WHERE bidder_id IN (SELECT DISTINCT bidder_id FROM contracts WHERE id GLOB 'c:[eo]:*');
INSERT INTO company_totals (bidder_id, name, kind, eik, eik_valid, settlement, won_eur, contracts, authorities, eu_eur, first_date, last_date)
SELECT b.id, b.name, b.kind, b.eik_normalized, b.eik_valid, b.settlement,
  SUM(c.amount_eur), COUNT(*), COUNT(DISTINCT t.authority_id),
  SUM(CASE WHEN c.eu_funded = 1 THEN c.amount_eur ELSE 0 END), MIN(c.signed_at), MAX(c.signed_at)
FROM contracts c JOIN bidders b ON b.id = c.bidder_id JOIN tenders t ON t.id = c.tender_id
WHERE c.amount_eur IS NOT NULL AND c.bidder_id IN (SELECT DISTINCT bidder_id FROM contracts WHERE id GLOB 'c:[eo]:*')
GROUP BY b.id;
UPDATE company_totals SET primary_sector = (
  SELECT substr(t.cpv_code, 1, 2) FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE c.bidder_id = company_totals.bidder_id AND c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'') <> ''
  GROUP BY substr(t.cpv_code, 1, 2) ORDER BY SUM(c.amount_eur) DESC, substr(t.cpv_code, 1, 2) LIMIT 1)
WHERE bidder_id IN (SELECT DISTINCT bidder_id FROM contracts WHERE id GLOB 'c:[eo]:*');

DELETE FROM authority_totals WHERE authority_id IN (SELECT DISTINCT t2.authority_id FROM contracts c2 JOIN tenders t2 ON t2.id = c2.tender_id WHERE c2.id GLOB 'c:[eo]:*');
INSERT INTO authority_totals (authority_id, name, type_group, settlement, region, spent_eur, contracts, suppliers, avg_eur, eu_eur, first_date, last_date)
SELECT a.id, a.name, a.type_group, a.settlement, a.region,
  SUM(c.amount_eur), COUNT(*), COUNT(DISTINCT c.bidder_id), SUM(c.amount_eur) / COUNT(*),
  SUM(CASE WHEN c.eu_funded = 1 THEN c.amount_eur ELSE 0 END), MIN(c.signed_at), MAX(c.signed_at)
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
WHERE c.amount_eur IS NOT NULL AND t.authority_id IN (SELECT DISTINCT t2.authority_id FROM contracts c2 JOIN tenders t2 ON t2.id = c2.tender_id WHERE c2.id GLOB 'c:[eo]:*')
GROUP BY a.id;
UPDATE authority_totals SET primary_sector = (
  SELECT substr(t.cpv_code, 1, 2) FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE t.authority_id = authority_totals.authority_id AND c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'') <> ''
  GROUP BY substr(t.cpv_code, 1, 2) ORDER BY SUM(c.amount_eur) DESC, substr(t.cpv_code, 1, 2) LIMIT 1)
WHERE authority_id IN (SELECT DISTINCT t2.authority_id FROM contracts c2 JOIN tenders t2 ON t2.id = c2.tender_id WHERE c2.id GLOB 'c:[eo]:*');

-- flow_pairs for affected authorities (rebuild every pair of an affected authority — bounded)
DELETE FROM flow_pairs WHERE authority_id IN (SELECT DISTINCT t2.authority_id FROM contracts c2 JOIN tenders t2 ON t2.id = c2.tender_id WHERE c2.id GLOB 'c:[eo]:*');
INSERT INTO flow_pairs (authority_id, bidder_id, authority_name, bidder_name, bidder_kind, won_eur, contracts)
SELECT t.authority_id, c.bidder_id, a.name, b.name, b.kind, SUM(c.amount_eur), COUNT(*)
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id JOIN bidders b ON b.id = c.bidder_id
WHERE c.amount_eur IS NOT NULL AND t.authority_id IN (SELECT DISTINCT t2.authority_id FROM contracts c2 JOIN tenders t2 ON t2.id = c2.tender_id WHERE c2.id GLOB 'c:[eo]:*')
GROUP BY t.authority_id, c.bidder_id;

-- search_index rows for affected entities (companies + authorities)
DELETE FROM search_index WHERE kind = 'company' AND ref IN (SELECT DISTINCT bidder_id FROM contracts WHERE id GLOB 'c:[eo]:*');
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'company', ct.bidder_id, ct.name, COALESCE(ct.eik, ''), COALESCE(ct.settlement, ''), ct.won_eur
FROM company_totals ct WHERE ct.bidder_id IN (SELECT DISTINCT bidder_id FROM contracts WHERE id GLOB 'c:[eo]:*');
DELETE FROM search_index WHERE kind = 'authority' AND ref IN (SELECT DISTINCT t2.authority_id FROM contracts c2 JOIN tenders t2 ON t2.id = c2.tender_id WHERE c2.id GLOB 'c:[eo]:*');
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'authority', at.authority_id, at.name, COALESCE(substr(at.authority_id, 6), ''), COALESCE(at.settlement, ''), at.spent_eur
FROM authority_totals at WHERE at.authority_id IN (SELECT DISTINCT t2.authority_id FROM contracts c2 JOIN tenders t2 ON t2.id = c2.tender_id WHERE c2.id GLOB 'c:[eo]:*');
-- contract search rows for the refresh-derived contracts
DELETE FROM search_index WHERE kind = 'contract' AND ref GLOB 'c:[eo]:*';
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'contract', c.id, COALESCE(NULLIF(c.contract_subject, ''), t.title), COALESCE(t.source_id, ''),
  a.name || ' → ' || b.name, c.amount_eur
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id JOIN bidders b ON b.id = c.bidder_id
WHERE c.id GLOB 'c:[eo]:*' AND COALESCE(NULLIF(c.contract_subject, ''), t.title) IS NOT NULL;

-- Small global rollups - recomputed in full (one-row / small facet tables; cheap per refresh).
DELETE FROM data_freshness;
INSERT INTO data_freshness (source, as_of, rows, refreshed_at)
SELECT
  CASE
    WHEN id LIKE 'c:e:%' THEN 'eop'
    WHEN id LIKE 'c:o:%' THEN 'ocds'
    WHEN id LIKE 'c:%' THEN 'admin'
    ELSE 'other'
  END AS src,
  MAX(CASE WHEN signed_at <= date('now') THEN signed_at END),
  COUNT(*),
  datetime('now')
FROM contracts
GROUP BY src;

DELETE FROM home_totals;
INSERT INTO home_totals (id, contracts, value_eur, authorities, bidders, suspect, first_date, last_date, as_of, refreshed_at)
SELECT 1,
  (SELECT COUNT(*) FROM contracts),
  (SELECT COALESCE(SUM(amount_eur), 0) FROM contracts),
  (SELECT COUNT(*) FROM authority_totals),
  (SELECT COUNT(*) FROM company_totals),
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'value_suspect'),
  (SELECT MIN(signed_at) FROM contracts WHERE signed_at >= '2020-01-01' AND signed_at <= date('now')),
  (SELECT MAX(signed_at) FROM contracts WHERE signed_at <= date('now')),
  -- Freshness is the latest in-corpus signed contract date. data_freshness is maintained above.
  (SELECT MAX(signed_at) FROM contracts WHERE signed_at <= date('now')),
  datetime('now');

DELETE FROM sector_totals;
INSERT INTO sector_totals (division, contracts, value_eur)
SELECT substr(t.cpv_code, 1, 2), COUNT(*), COALESCE(SUM(c.amount_eur), 0)
FROM contracts c JOIN tenders t ON t.id = c.tender_id
WHERE c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'') <> ''
GROUP BY substr(t.cpv_code, 1, 2);

DELETE FROM facet_counts;
INSERT INTO facet_counts (facet, key, contracts, value_eur)
SELECT 'procedure', t.procedure_type, COUNT(*), COALESCE(SUM(c.amount_eur), 0)
FROM contracts c JOIN tenders t ON t.id = c.tender_id GROUP BY t.procedure_type;
INSERT INTO facet_counts (facet, key, contracts, value_eur)
SELECT 'eu', CASE WHEN c.eu_funded = 1 THEN '1' ELSE '0' END, COUNT(*), COALESCE(SUM(c.amount_eur), 0)
FROM contracts c GROUP BY CASE WHEN c.eu_funded = 1 THEN '1' ELSE '0' END;
