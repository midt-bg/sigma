-- Work DB staging schema. Served D1 must never include these raw tables.
-- ===================================================================================
-- 2) STAGING — storage.eop.bg per-day open-data buckets (base JSON + in-bucket OCDS), by
--    scripts/load-eop.mjs. 100% raw landing (source 'eop:<cat>:<date>' / 'ocds:<date>'); all cleaning
--    happens in normalize-raw.sql. These raw tables live in the work DB only, never the served D1.
-- ===================================================================================

CREATE TABLE raw_contracts (
  id               INTEGER PRIMARY KEY,
  source           TEXT NOT NULL,          -- 'admin:contracts:2023' (also 'ocds:…' for the go-forward feed)
  dataset_uri      TEXT,
  resource_uri     TEXT,
  dataset_year     INTEGER,
  dataset_variant  TEXT,
  fetched_at       TEXT NOT NULL,

  -- contract register (column = Bulgarian header it maps from)
  seq_no               TEXT,              -- Пореден номер
  document_number      TEXT,              -- Номер на документ
  contract_number      TEXT,              -- Номер на договор
  contract_date        TEXT,              -- Дата на договор (ISO)
  published_at         TEXT,              -- Публикуван на (ISO)
  unp                  TEXT,              -- Уникален номер на поръчката  ← join key
  authority_eik        TEXT,              -- ЕИК на възложителя
  authority_name       TEXT,              -- Възложител
  buyer_appearance     TEXT,              -- exact OCDS source-appearance witness, never published
  buyer_is_supplier    INTEGER DEFAULT 0, -- selected OCDS buyer also has supplier evidence
  authority_type       TEXT,              -- Вид на възложителя
  procurement_subject  TEXT,              -- Предмет на поръчката
  contract_kind        TEXT,              -- Обект на поръчката (Доставки/Услуги/Строителство)
  eu_funded            INTEGER,           -- EU финансиране (0/1)
  bids_received        INTEGER,           -- Брой оферти
  contract_subject     TEXT,              -- Предмет на договора
  contractor_eik       TEXT,              -- ЕИК на изпълнителя (leading zeros kept)
  contractor_name      TEXT,              -- Изпълнител
  awarded_to_group     INTEGER,           -- Възложена на група (обединение/консорциум)
  signing_value        REAL,              -- Стойност при сключване
  currency             TEXT,              -- Валута (BGN / EUR / foreign)
  vat                  TEXT,              -- ДДС
  sme                  TEXT,              -- Малко или средно предприятие (МСП)

  -- procedure-level fields (admin carries them per row → needs_enrichment = 0)
  procedure_type   TEXT,                  -- Вид на процедурата
  cpv_code         TEXT,                  -- CPV код
  cpv_description  TEXT,                  -- Описание на CPV кода
  estimated_value  REAL,                  -- Прогнозна стойност
  current_value    REAL,                  -- Текуща стойност (от derive-amendments.sql)
  lot_id           TEXT,                  -- Идентификатор на обособена позиция
  award_criteria   TEXT,                  -- Критерий за възлагане
  legal_basis      TEXT,                  -- Правно основание за откриване
  annex_count      INTEGER DEFAULT 0,     -- rolled up by derive-amendments.sql

  -- full capture — every remaining EOP contracts field (scripts/load-eop.mjs)
  tender_ext_id            TEXT,          -- ID на поръчката
  procurement_currency     TEXT,          -- Валута на поръчката
  joint_procurement        INTEGER,       -- Съвместно възлагане
  central_purchasing       INTEGER,       -- възложена от централен орган за покупки
  main_activity            TEXT,          -- Основна дейност (на възложителя)
  notice_type              TEXT,          -- Вид обявление
  contractor_country       TEXT,          -- Код на държавата на изпълнителя
  winner_owner_nationality TEXT,          -- Националност на собственика на победителя
  winner_size              TEXT,          -- Размер на победителя (micro/small/medium/large)
  has_subcontractor        INTEGER,       -- Подизпълнител (да/не)
  subcontractor_name       TEXT,          -- Наименование на подизпълнителя
  subcontractor_eik        TEXT,          -- ЕИК на подизпълнителя
  subcontract_share        TEXT,          -- Дял на поръчката, възложен на подизпълнител
  subcontract_value        REAL,          -- Стойност, възложена на подизпълнител
  eu_programme             TEXT,          -- Европейска програма (operational programme)
  framework_notice         INTEGER,       -- Поръчка за Рамково споразумение
  framework_contract       INTEGER,       -- Договор по рамково споразумение
  related_to               TEXT,          -- Свързана с
  dps_contract             INTEGER,       -- Договор по ДСП (динамична система за покупки)
  accelerated              INTEGER,       -- Ускорена процедура
  eauction                 INTEGER,       -- Електронен търг
  strategic                INTEGER,       -- Стратегическа поръчка
  outside_zop              INTEGER,       -- Договорът е извън приложното поле на ЗОП
  exemption_legal_basis    TEXT,          -- Правно основание за изключение
  bids_sme                 INTEGER,       -- Брой оферти от МСП
  bids_rejected            INTEGER,       -- Брой отстранени оферти
  bids_non_eea             INTEGER,       -- Брой оферти - извън ЕИП
  duration_days            INTEGER,       -- Срок на договора в дни
  non_award                INTEGER,       -- Невъзлагане
  correction_number        TEXT,          -- Номер на поправката
  ted_link                 TEXT,          -- Линк към публикацията в ТЕД

  -- enrichment tracking (vestigial under the admin base — always 0/NULL; kept for the portal feed)
  needs_enrichment   INTEGER NOT NULL DEFAULT 1,
  enriched_at        TEXT,
  enrichment_source  TEXT
);

-- Procedure records (lot-grained: one header row per УНП with lot_id NULL, plus one row per lot).
CREATE TABLE raw_tenders (
  id              INTEGER PRIMARY KEY,
  source          TEXT NOT NULL,          -- 'admin:tenders:2023'
  dataset_year    INTEGER,
  fetched_at      TEXT NOT NULL,
  unp             TEXT,                    -- Уникален номер на поръчката
  tender_id       TEXT,                    -- ID на поръчката
  procedure_type  TEXT,                    -- Вид на поръчката
  procurement_subject TEXT,                -- Предмет на поръчката
  cpv_code        TEXT,
  cpv_description TEXT,
  contract_kind   TEXT,                    -- Обект на поръчката
  estimated_value REAL,                    -- Прогнозна стойност (procurement-level on the header row, per-lot on lot rows)
  currency        TEXT,
  legal_basis     TEXT,
  award_criteria  TEXT,
  authority_name  TEXT,
  authority_eik   TEXT,
  authority_type  TEXT,                    -- Вид на възложителя
  main_activity   TEXT,                    -- Основна дейност
  deadline        TEXT,                    -- Срок за получаване на оферти (raw)
  notice_type     TEXT,                    -- Вид обявление
  lot_id          TEXT,                    -- Идентификатор на обособена позиция (NULL on the header row)
  lot_name        TEXT,                    -- Наименование на обособената позиция
  num_lots        INTEGER,                 -- Брой обособени позиции (on the header row)
  eu_funded       INTEGER,
  -- full capture — every remaining EOP tenders field (scripts/load-eop.mjs)
  seq_no               TEXT,
  document_number      TEXT,
  published_at         TEXT,
  joint_procurement    INTEGER,
  central_purchasing   INTEGER,
  eu_programme         TEXT,
  secured_financing    INTEGER,
  framework_notice     INTEGER,
  dps_notice           INTEGER,
  accelerated          INTEGER,
  eauction             INTEGER,
  strategic            INTEGER,
  green                INTEGER,
  social               INTEGER,
  innovation           INTEGER,
  options              INTEGER,
  renewable            INTEGER,
  reserved             INTEGER,
  variants             INTEGER,
  place_of_performance TEXT,
  duration             TEXT,
  duration_unit        TEXT,
  start_date           TEXT,
  end_date             TEXT,
  einvoicing           INTEGER,
  epayment             INTEGER,
  eordering            INTEGER,
  corrections_count    INTEGER,
  cancelled            INTEGER,
  correction_number    TEXT,
  ted_link             TEXT
);

-- One row per amendment (изменение / анекс); derive-amendments.sql rolls these onto contracts.
CREATE TABLE raw_amendments (
  id               INTEGER PRIMARY KEY,
  source           TEXT NOT NULL,          -- 'admin:annexes:2023'
  dataset_uri      TEXT,
  resource_uri     TEXT,
  dataset_year     INTEGER,
  dataset_variant  TEXT,
  fetched_at       TEXT NOT NULL,
  seq_no               TEXT,
  document_number      TEXT,
  contract_number      TEXT,              -- ← link to raw_contracts (rewritten in place by the #306 value resolver)
  contract_number_raw  TEXT,              -- #306: the annex-side number before the value resolver rewrote it (provenance; NULL = never rewritten)
  value_anchor_kind    TEXT,              -- direct value match or inherited chain link
  link_method          TEXT,              -- #306: 'value_anchor' when the resolver linked this row by value; NULL = matched by number / unlinked
  contract_date        TEXT,
  published_at         TEXT,              -- amendment publication date (ordering key)
  unp                  TEXT,              -- ← link to raw_contracts
  authority_eik        TEXT,
  authority_name       TEXT,
  procurement_subject  TEXT,
  contract_kind        TEXT,
  eu_funded            INTEGER,
  contract_subject     TEXT,
  contractor_eik       TEXT,
  contractor_name      TEXT,
  value_before     REAL,                  -- Стойност преди изменението
  value_after      REAL,                  -- Стойност след изменението  → current_value
  value_delta      REAL,                  -- Изменение на стойността
  -- #305 Tier-2 text-based value correction (computed in TS ingest, packages/ingest/src/amendment-total.ts):
  -- value_treatment labels how the основание text reads value_delta ('total_restated' / 'unchanged_restated'
  -- / 'genuine_increment', NULL when no signal); value_after_restated is the corrected (true) total when a
  -- double-count was confirmed, else NULL. Derive/normalize use COALESCE(value_after_restated, value_after)
  -- as the effective after, and skip the arithmetic annex_total_suspect flag when value_treatment IS NOT NULL.
  value_treatment      TEXT,
  value_after_restated REAL,
  currency         TEXT,
  description      TEXT,                  -- Описание на измененията
  reason           TEXT,                  -- Причини за изменение (ЗОП основание)
  circumstances    TEXT,                  -- Обстоятелства
  sme              TEXT,
  -- full capture — every remaining EOP annexes field (scripts/load-eop.mjs)
  tender_ext_id            TEXT,
  procedure_type           TEXT,
  cpv_code                 TEXT,
  cpv_description          TEXT,
  authority_type           TEXT,
  main_activity            TEXT,
  lot_id                   TEXT,
  awarded_to_group         INTEGER,
  contractor_country       TEXT,
  winner_owner_nationality TEXT,
  winner_size              TEXT,
  eu_programme             TEXT,
  outside_zop              INTEGER,
  exemption_legal_basis    TEXT,
  correction_number        TEXT,
  ted_link                 TEXT
);

-- OCDS parties (storage.eop.bg in-bucket OCDS feed) — full party records: ЕИК + address (city + NUTS region) +
-- roles + contact. Captured by scripts/load-eop.mjs; normalize-raw.sql enriches authorities/bidders
-- location from here by ЕИК. Source 'ocds:%'.
CREATE TABLE raw_ocds_parties (
  id             INTEGER PRIMARY KEY,
  source         TEXT NOT NULL,
  dataset_uri    TEXT,
  resource_uri   TEXT,
  fetched_at     TEXT NOT NULL,
  ocid           TEXT,                     -- release ocid (provenance)
  party_id       TEXT,                     -- independent release party ref
  party_id_copies_eik INTEGER NOT NULL DEFAULT 0,
  source_party_id TEXT GENERATED ALWAYS AS (
    CASE WHEN party_id_copies_eik = 1 THEN eik ELSE party_id END
  ) VIRTUAL,
  eik            TEXT,                     -- identifier.id when scheme = BG-EIK
  is_supplier    INTEGER NOT NULL DEFAULT 0, -- supplier role or referenced by an award supplier
  appearance     TEXT,                     -- internal equality witness for exact (ocid, party_id, eik)
  scheme         TEXT,                     -- identifier.scheme
  name           TEXT,
  roles          TEXT,                     -- comma-joined OCDS roles (buyer/supplier/tenderer/…)
  street_address TEXT,
  locality       TEXT,                     -- settlement / city
  postal_code    TEXT,
  region_nuts    TEXT,                     -- NUTS region code
  country        TEXT,
  contact_name   TEXT,
  contact_email  TEXT,
  contact_phone  TEXT
);

-- OCDS lots — per-lot values from the in-bucket release package. tender_id is the OCDS tender.id
-- used to bridge to raw_tenders.tender_id; ocid is provenance only, not a UNP.
CREATE TABLE raw_ocds_lots (
  id             INTEGER PRIMARY KEY,
  source         TEXT NOT NULL,
  dataset_uri    TEXT,
  resource_uri   TEXT,
  fetched_at     TEXT NOT NULL,
  ocid           TEXT,
  tender_id      TEXT,
  lot_id         TEXT,
  title          TEXT,
  value_amount   REAL,
  value_currency TEXT
);

-- Work-only staging indexes.
CREATE INDEX idx_raw_unp ON raw_contracts(unp);
CREATE INDEX idx_raw_unp_cnum ON raw_contracts(unp, contract_number);
CREATE INDEX idx_raw_cnum ON raw_contracts(contract_number);  -- admin↔OCDS dedup key (normalize step 5)
CREATE INDEX idx_raw_eik ON raw_contracts(contractor_eik);
CREATE INDEX idx_raw_year ON raw_contracts(dataset_year);
CREATE INDEX idx_raw_needs_enrichment ON raw_contracts(needs_enrichment);
CREATE INDEX idx_raw_tenders_unp ON raw_tenders(unp);
CREATE INDEX idx_raw_tenders_tender_id ON raw_tenders(tender_id);
CREATE INDEX idx_raw_tenders_source ON raw_tenders(source);
CREATE INDEX idx_raw_amend_contract ON raw_amendments(unp, contract_number);
CREATE INDEX idx_raw_amend_source ON raw_amendments(source);
CREATE INDEX idx_ocds_parties_eik ON raw_ocds_parties(eik);
CREATE INDEX idx_ocds_parties_source ON raw_ocds_parties(source);
CREATE INDEX idx_ocds_parties_appearance ON raw_ocds_parties(appearance);
CREATE INDEX idx_ocds_lots_source ON raw_ocds_lots(source);
CREATE INDEX idx_ocds_lots_ocid_lot ON raw_ocds_lots(ocid, lot_id);
CREATE INDEX idx_ocds_lots_tender_lot ON raw_ocds_lots(tender_id, lot_id);

-- Inputs to the contract valuation rule. The full and slice scripts stage raw input rows with
-- integer ids. Slice reconciliation reuses the table for affected served contracts with text ids.
CREATE TABLE IF NOT EXISTS raw_contract_value_inputs (
  id PRIMARY KEY NOT NULL,
  unp TEXT,
  contract_number TEXT,
  signed_at TEXT,
  signing_value REAL,
  signing_currency TEXT,
  current_value REAL,
  current_currency TEXT,
  proc_est_native REAL,
  proc_est_currency TEXT,
  own_est_native REAL,
  own_est_currency TEXT,
  framework INTEGER,
  keep_symbolic INTEGER,
  prior_signing_rate REAL,
  current_annex_key TEXT
);

-- Use the same supplier ID validation for bidder identity, signings and annexes.
-- The raw lookup key lives in staging only. Served provenance uses only the validated EIK
-- and a status so a supplied but unverified identifier cannot stand in for missing evidence.
CREATE VIEW IF NOT EXISTS raw_supplier_evidence AS
WITH identifiers AS (
  SELECT contractor_eik AS eik_raw FROM raw_contracts
  UNION
  SELECT contractor_eik FROM raw_amendments
  UNION
  SELECT eik FROM raw_ocds_parties WHERE is_supplier = 1
), cleaned AS (
  -- SQLite's default TRIM removes ordinary spaces. Preserve other characters
  -- for the ASCII digit check, and recognize the existing uppercase ЕИК prefix.
  SELECT eik_raw,
    TRIM(CASE WHEN eik_raw LIKE 'ЕИК %' THEN SUBSTR(eik_raw, 5) ELSE eik_raw END) AS eik_clean
  FROM identifiers
), validated AS (
  SELECT eik_raw, eik_clean,
    -- Bulgarian ЕИК/Булстат control-digit validation (#195).
    -- Reject embedded NUL before SQLite's text length and pattern checks.
    --   9-digit: weight positions 1..8 by 1..8; control = sum % 11. If that is 10, re-weight by
    --            3..10; a second 10 → 0. The 9th digit must equal the control.
    --   13-digit: the leading 9 digits must themselves be a valid 9-digit ЕИК, then weight
    --            positions 9..12 by 2,7,3,5 (fallback 4,9,5,7; second 10 → 0). The 13th digit
    --            must equal that control.
    CASE
      WHEN eik_clean IS NULL OR eik_clean IN ('000000000', '0000000000000') OR INSTR(eik_raw, char(0)) > 0
        OR eik_clean GLOB '*[^0-9]*' OR LENGTH(eik_clean) NOT IN (9, 13) THEN 0
      WHEN (
        CASE
          WHEN (1 * CAST(SUBSTR(eik_clean, 1, 1) AS INTEGER) + 2 * CAST(SUBSTR(eik_clean, 2, 1) AS INTEGER) + 3 * CAST(SUBSTR(eik_clean, 3, 1) AS INTEGER) + 4 * CAST(SUBSTR(eik_clean, 4, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 5, 1) AS INTEGER) + 6 * CAST(SUBSTR(eik_clean, 6, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 7, 1) AS INTEGER) + 8 * CAST(SUBSTR(eik_clean, 8, 1) AS INTEGER)) % 11 < 10 THEN (1 * CAST(SUBSTR(eik_clean, 1, 1) AS INTEGER) + 2 * CAST(SUBSTR(eik_clean, 2, 1) AS INTEGER) + 3 * CAST(SUBSTR(eik_clean, 3, 1) AS INTEGER) + 4 * CAST(SUBSTR(eik_clean, 4, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 5, 1) AS INTEGER) + 6 * CAST(SUBSTR(eik_clean, 6, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 7, 1) AS INTEGER) + 8 * CAST(SUBSTR(eik_clean, 8, 1) AS INTEGER)) % 11
          WHEN (3 * CAST(SUBSTR(eik_clean, 1, 1) AS INTEGER) + 4 * CAST(SUBSTR(eik_clean, 2, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 3, 1) AS INTEGER) + 6 * CAST(SUBSTR(eik_clean, 4, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 5, 1) AS INTEGER) + 8 * CAST(SUBSTR(eik_clean, 6, 1) AS INTEGER) + 9 * CAST(SUBSTR(eik_clean, 7, 1) AS INTEGER) + 10 * CAST(SUBSTR(eik_clean, 8, 1) AS INTEGER)) % 11 < 10 THEN (3 * CAST(SUBSTR(eik_clean, 1, 1) AS INTEGER) + 4 * CAST(SUBSTR(eik_clean, 2, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 3, 1) AS INTEGER) + 6 * CAST(SUBSTR(eik_clean, 4, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 5, 1) AS INTEGER) + 8 * CAST(SUBSTR(eik_clean, 6, 1) AS INTEGER) + 9 * CAST(SUBSTR(eik_clean, 7, 1) AS INTEGER) + 10 * CAST(SUBSTR(eik_clean, 8, 1) AS INTEGER)) % 11
          ELSE 0
        END
      ) <> CAST(SUBSTR(eik_clean, 9, 1) AS INTEGER) THEN 0
      WHEN LENGTH(eik_clean) = 9 THEN 1
      WHEN (
        CASE
          WHEN (2 * CAST(SUBSTR(eik_clean, 9, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 10, 1) AS INTEGER) + 3 * CAST(SUBSTR(eik_clean, 11, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 12, 1) AS INTEGER)) % 11 < 10 THEN (2 * CAST(SUBSTR(eik_clean, 9, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 10, 1) AS INTEGER) + 3 * CAST(SUBSTR(eik_clean, 11, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 12, 1) AS INTEGER)) % 11
          WHEN (4 * CAST(SUBSTR(eik_clean, 9, 1) AS INTEGER) + 9 * CAST(SUBSTR(eik_clean, 10, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 11, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 12, 1) AS INTEGER)) % 11 < 10 THEN (4 * CAST(SUBSTR(eik_clean, 9, 1) AS INTEGER) + 9 * CAST(SUBSTR(eik_clean, 10, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 11, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 12, 1) AS INTEGER)) % 11
          ELSE 0
        END
      ) = CAST(SUBSTR(eik_clean, 13, 1) AS INTEGER) THEN 1
      ELSE 0
    END AS eik_valid
  FROM cleaned
)
SELECT eik_raw, CASE WHEN eik_valid = 1 THEN eik_clean END AS eik,
  CASE WHEN eik_valid = 1 THEN 'valid'
       WHEN NULLIF(TRIM(eik_raw), '') IS NULL THEN 'absent'
       ELSE 'unverified' END AS evidence_status
FROM validated;

-- Materialize these once per publication. The role ledger stores equality witnesses only.
CREATE TABLE raw_ocds_party_screening (
  party_row_id INTEGER PRIMARY KEY,
  evidence_status TEXT NOT NULL
);
CREATE TABLE raw_ocds_authority_keys (
  contract_row_id INTEGER PRIMARY KEY,
  authority_id TEXT
);
CREATE TABLE raw_ocds_authority_moves (
  tender_id TEXT PRIMARY KEY,
  old_id TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  name TEXT NOT NULL
);
-- Keep the narrow admission result shared by contract publication and buyer attribution.
CREATE TABLE raw_contract_admissions (
  raw_id INTEGER PRIMARY KEY,
  contract_id TEXT NOT NULL,
  bidder_id TEXT NOT NULL,
  amount REAL NOT NULL,
  lot_id TEXT
);
CREATE TABLE raw_new_synthetic_tenders (
  tender_id TEXT PRIMARY KEY
);
CREATE TABLE raw_contract_buyer_tenders (
  tender_id TEXT PRIMARY KEY
);
CREATE TABLE raw_previous_ocds_contract_buyers (
  contract_id TEXT PRIMARY KEY,
  appearance TEXT,
  source TEXT NOT NULL,
  authority_id TEXT NOT NULL
);
CREATE TABLE raw_ocds_tender_selections (
  tender_id TEXT PRIMARY KEY,
  authority_id TEXT,  -- NULL when no eligible buyer remains
  old_authority_id TEXT NOT NULL,
  source TEXT,  -- NULL for an EOP contract takeover or no eligible buyer
  appearance TEXT
);
CREATE VIEW IF NOT EXISTS raw_ocds_party_input AS
SELECT p.id, p.source, p.ocid, p.source_party_id AS party_id, p.eik, p.name,
  p.street_address, p.locality, p.region_nuts, p.contact_email, p.contact_phone,
  COALESCE(s.evidence_status, CASE
    WHEN NULLIF(p.eik, '') IS NULL AND p.ocid <> '' AND p.source_party_id <> '' THEN 'absent'
  END) AS evidence_status,
  CASE
    WHEN p.eik <> '' THEN 'eik:' || p.eik || ':ocid:' || COALESCE(p.ocid, '') || ':party:' || COALESCE(p.source_party_id, '')
    WHEN p.ocid <> '' AND p.source_party_id <> '' THEN 'ocid:' || p.ocid || ':party:' || p.source_party_id
    ELSE 'content:' || COALESCE(p.ocid, '') || ':' || COALESCE(p.source_party_id, '') || ':' || COALESCE(p.eik, '') || ':' ||
      COALESCE(p.name, '') || ':' || COALESCE(p.street_address, '') || ':' || COALESCE(p.locality, '') || ':' ||
      COALESCE(p.region_nuts, '') || ':' || COALESCE(p.contact_email, '') || ':' || COALESCE(p.contact_phone, '')
  END AS legacy_key
FROM raw_ocds_parties p
LEFT JOIN raw_ocds_party_screening s ON s.party_row_id = p.id;

-- Carry an exact legacy row into ranking before retiring its old key.
-- A positional reference alone is insufficient when there is identifier evidence.
CREATE VIEW IF NOT EXISTS raw_ocds_party_retirements AS
SELECT DISTINCT p.party_key, p.source, p.ocid, p.party_id, p.eik, p.name,
  p.street_address, p.locality, p.region_nuts, p.contact_email, p.contact_phone
FROM raw_ocds_party_input r
JOIN parties p ON p.party_key = r.legacy_key
  AND p.ocid IS r.ocid AND p.party_id IS r.party_id
WHERE (r.evidence_status = 'unverified' AND p.eik IS r.eik)
   OR (r.evidence_status = 'absent' AND NULLIF(r.eik, '') IS NULL AND NULLIF(p.eik, '') IS NULL);

CREATE VIEW IF NOT EXISTS raw_serving_ocds_parties AS
WITH input AS (
  SELECT legacy_key, source, ocid, party_id, eik, name, street_address, locality,
    region_nuts, contact_email, contact_phone, evidence_status
  FROM raw_ocds_party_input
  UNION ALL
  SELECT party_key, source, ocid, party_id, eik, name, street_address, locality,
    region_nuts, contact_email, contact_phone,
    CASE WHEN NULLIF(eik, '') IS NULL THEN 'absent' ELSE 'unverified' END
  FROM raw_ocds_party_retirements
), public_fields AS (
  SELECT legacy_key, source, ocid, evidence_status,
    CASE WHEN evidence_status = 'unverified' AND party_id = eik THEN 1 ELSE 0 END AS copied_ref,
    CASE WHEN evidence_status = 'unverified' THEN NULLIF(party_id, eik) ELSE party_id END AS party_id,
    CASE WHEN evidence_status IN ('unverified', 'absent') THEN NULL ELSE eik END AS eik,
    CASE WHEN evidence_status = 'unverified' THEN NULLIF(name, eik) ELSE name END AS name,
    CASE WHEN evidence_status = 'unverified' THEN NULLIF(street_address, eik) ELSE street_address END AS street_address,
    CASE WHEN evidence_status = 'unverified' THEN NULLIF(locality, eik) ELSE locality END AS locality,
    CASE WHEN evidence_status = 'unverified' THEN NULLIF(region_nuts, eik) ELSE region_nuts END AS region_nuts,
    CASE WHEN evidence_status = 'unverified' THEN NULLIF(contact_email, eik) ELSE contact_email END AS contact_email,
    CASE WHEN evidence_status = 'unverified' THEN NULLIF(contact_phone, eik) ELSE contact_phone END AS contact_phone
  FROM input
), incoming AS MATERIALIZED (
  SELECT CASE
    WHEN evidence_status IS NULL OR evidence_status = 'valid' THEN legacy_key
    WHEN copied_ref = 0 AND ocid <> '' AND party_id <> '' THEN 'ocds-ref:' || json_array(ocid, party_id)
    -- No independent reference remains. The observation key only uses the published descriptive
    -- fields. Structured tuples avoid delimiter collisions and array reordering is irrelevant.
    ELSE 'ocds-observation:' || json_array(ocid, party_id, name, street_address, locality,
      region_nuts, contact_email, contact_phone)
  END AS party_key, eik, source, ocid, party_id, name, street_address, locality, region_nuts,
    contact_email, contact_phone
  FROM public_fields
), contenders AS (
  SELECT *, 1 AS incoming FROM incoming
  UNION ALL
  SELECT p.*, 0 AS incoming FROM (SELECT DISTINCT party_key FROM incoming) k
  JOIN parties p USING (party_key)
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY party_key
    ORDER BY source DESC, COALESCE(ocid, '') DESC, COALESCE(party_id, '') DESC,
      COALESCE(name, '') DESC, COALESCE(street_address, '') DESC, COALESCE(locality, '') DESC,
      COALESCE(contact_email, '') DESC, COALESCE(contact_phone, '') DESC,
      region_nuts DESC, eik DESC, ocid DESC, party_id DESC, name DESC, street_address DESC,
      locality DESC, contact_email DESC, contact_phone DESC, incoming
  ) AS rn
  FROM contenders
)
SELECT party_key, eik, source, ocid, party_id, name, street_address, locality, region_nuts,
  contact_email, contact_phone
FROM ranked WHERE rn = 1 AND incoming = 1;

CREATE VIEW IF NOT EXISTS raw_serving_contract_authorities AS
SELECT c.id, c.source, c.unp, c.buyer_appearance,
  CASE WHEN k.contract_row_id IS NULL THEN 'auth:' || c.authority_eik ELSE k.authority_id END AS authority_id,
  CASE WHEN k.contract_row_id IS NULL THEN c.authority_eik END AS authority_eik,
  CASE WHEN k.contract_row_id IS NULL THEN c.authority_name ELSE NULLIF(c.authority_name, c.authority_eik) END AS authority_name,
  c.authority_type
FROM raw_contracts c
LEFT JOIN raw_ocds_authority_keys k ON k.contract_row_id = c.id;

-- Use the contract admission and the eligible authority from the same publication.
CREATE VIEW IF NOT EXISTS raw_contract_buyer_candidates AS
SELECT p.contract_id, c.tender_id, a.source, a.authority_id, a.buyer_appearance AS appearance
FROM raw_contract_admissions p
JOIN contracts c ON c.id = p.contract_id
JOIN raw_serving_contract_authorities a
  ON a.id = p.raw_id AND c.tender_id = 't:' || a.unp AND c.own_estimate_source = a.source
JOIN authorities eligible ON eligible.id = a.authority_id;

-- A published header or EOP buyer has neither an OCDS binding nor a pending marker.
CREATE VIEW IF NOT EXISTS raw_open_synthetic_buyers AS
SELECT t.id AS tender_id, t.authority_id
FROM raw_contract_buyer_tenders affected
CROSS JOIN tenders t ON t.id = affected.tender_id
WHERE EXISTS (SELECT 1 FROM raw_new_synthetic_tenders n WHERE n.tender_id = t.id)
   OR EXISTS (SELECT 1 FROM synthetic_tenders_awaiting_buyer p WHERE p.tender_id = t.id)
   OR EXISTS (SELECT 1 FROM ocds_tender_buyers b WHERE b.tender_id = t.id AND b.authority_id = t.authority_id);

-- Exact role-only evidence can correct a signing even while another signing owns the tender.
CREATE VIEW IF NOT EXISTS raw_ocds_contract_buyer_moves AS
SELECT b.contract_id, a.bulstat,
  'ocds-auth:' || lower(hex(t.source_id)) AS authority_id,
  NULLIF(NULLIF(NULLIF(TRIM(c.ordering_unit_name), a.bulstat), ''), '(без име)') AS name
FROM raw_ocds_party_screening s
CROSS JOIN raw_ocds_parties p ON p.id = s.party_row_id
CROSS JOIN ocds_contract_buyers b ON b.appearance = p.appearance
CROSS JOIN contracts c ON c.id = b.contract_id
CROSS JOIN tenders t ON t.id = c.tender_id AND t.source_id = p.ocid
CROSS JOIN authorities a ON a.id = b.authority_id
WHERE s.evidence_status = 'unverified' AND a.id LIKE 'auth:%';

CREATE VIEW IF NOT EXISTS raw_ocds_scoped_names AS
WITH candidates AS (
  SELECT a.authority_id, a.authority_name AS name
  FROM raw_ocds_authority_keys k
  JOIN raw_serving_contract_authorities a ON a.id = k.contract_row_id
  WHERE a.authority_id IS NOT NULL
  UNION ALL
  SELECT authority_id, name FROM raw_ocds_authority_moves
  UNION ALL
  SELECT authority_id, name FROM raw_ocds_contract_buyer_moves
), staged AS (
  SELECT authority_id,
    COALESCE(MIN(NULLIF(NULLIF(TRIM(name), ''), '(без име)')), '(без име)') AS name
  FROM candidates GROUP BY authority_id
)
SELECT s.authority_id, s.name FROM staged s
LEFT JOIN authorities a ON a.id = s.authority_id
WHERE a.id IS NULL OR (
  s.name <> '(без име)'
  AND (NULLIF(TRIM(a.name), '') IS NULL OR a.name = '(без име)' OR s.name < a.name)
);

-- The same publication precedence used to promote contracts. EOP repeats a logical lot/contractor
-- across buckets. It also supersedes OCDS by document number, even when its signing cannot anchor.
CREATE VIEW IF NOT EXISTS raw_contract_publications AS
SELECT c.*
FROM raw_contracts c
WHERE (c.source LIKE 'eop:%' AND NOT EXISTS (
    SELECT 1 FROM raw_contracts a
    WHERE a.source LIKE 'eop:%'
      AND a.contract_number = c.contract_number
      AND COALESCE(a.unp, '') = COALESCE(c.unp, '')
      AND COALESCE(a.lot_id, '') = COALESCE(c.lot_id, '')
      AND COALESCE(a.contractor_eik, '') = COALESCE(c.contractor_eik, '')
      AND COALESCE(a.contractor_name, '') = COALESCE(c.contractor_name, '')
      AND (a.source > c.source OR (a.source = c.source AND a.id > c.id))
  )) OR (c.source LIKE 'ocds:%' AND NOT EXISTS (
    SELECT 1 FROM raw_contracts a WHERE a.source LIKE 'eop:%'
      AND a.contract_number = c.contract_number
  ));

-- The existing publication key picks the same raw version as derive-amendments and promotion.
-- Preserve its original delta and after-value for valuation, even if promotion corrects them.
CREATE VIEW IF NOT EXISTS raw_amendment_publications AS
WITH amendment_dedup AS (
  SELECT *,
    -- The value resolver can rewrite the link. Keep the original number in the publication key
    -- used by derive-amendments.sql and promote-amendments.sql.
    'am:' || COALESCE(unp, '') || ':' || COALESCE(NULLIF(contract_number_raw, ''), contract_number, '') || ':' ||
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
  FROM raw_amendments
), amendment_rn AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY natural_key ORDER BY source DESC, id DESC) AS rn
  FROM amendment_dedup
)
SELECT id, natural_key, unp, contract_number, contract_number_raw, link_method, value_anchor_kind,
  contractor_eik,
  value_before, value_after AS raw_after, COALESCE(value_after_restated, value_after) AS effective_after,
  value_delta AS raw_delta, currency, published_at, document_number, description, source,
  value_treatment, value_after_restated IS NOT NULL AS restated
FROM amendment_rn WHERE rn = 1;

CREATE VIEW IF NOT EXISTS raw_contract_value_staged_annexes AS
SELECT natural_key, unp, contract_number, value_before, raw_after, effective_after, raw_delta,
  currency, published_at, value_treatment, restated, 1 AS evidence_known, 0 AS legacy_suspect
FROM raw_amendment_publications;

-- The slice only reads served annex history for keys changed by the resolved window.
CREATE TABLE IF NOT EXISTS raw_contract_value_scope (
  unp TEXT NOT NULL,
  contract_number TEXT NOT NULL,
  PRIMARY KEY (unp, contract_number)
);

CREATE TABLE IF NOT EXISTS raw_contract_value_annexes (
  natural_key TEXT PRIMARY KEY,
  unp TEXT,
  contract_number TEXT,
  value_before REAL,
  raw_after REAL,
  effective_after REAL,
  value_delta REAL,
  currency TEXT,
  published_at TEXT,
  value_treatment TEXT,
  restated INTEGER,
  evidence_known INTEGER NOT NULL,
  legacy_suspect INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_contract_value_annexes
  ON raw_contract_value_annexes (unp, contract_number);

-- Annexes normally use one currency throughout a row. When linking amounts between rows,
-- compare in the same currency, or at the fixed peg for the BGN/EUR transition. For other
-- currency pairs a relative size alone is insufficient evidence of a doubled total.
CREATE VIEW IF NOT EXISTS raw_contract_value_annex_history AS
SELECT i.id, a.*,
  COALESCE(NULLIF(a.currency, ''), NULLIF(i.signing_currency, ''), 'BGN') AS ccy,
  a.value_before * CASE COALESCE(NULLIF(a.currency, ''), i.signing_currency) WHEN 'EUR' THEN 1.95583 ELSE 1 END AS before_basis,
  -- An untreated legacy row still exposes its effective after-value. For a restored publication,
  -- use the original amount, including NULL, for comparisons against the reported chain.
  CASE WHEN a.evidence_known = 0 AND a.restated = 0 THEN a.effective_after ELSE a.raw_after END AS reported_after,
  CASE WHEN a.evidence_known = 0 AND a.restated = 0 THEN a.effective_after ELSE a.raw_after END
    * CASE COALESCE(NULLIF(a.currency, ''), i.signing_currency) WHEN 'EUR' THEN 1.95583 ELSE 1 END AS after_basis
FROM raw_contract_value_inputs i
JOIN raw_contract_value_annexes a ON a.unp = i.unp AND a.contract_number = i.contract_number;

-- Each untreated double is a property of the annex row. An earlier suspect row can remain
-- marked in the public history even when a later annex drives a sound contract total.
CREATE VIEW IF NOT EXISTS raw_contract_suspect_annexes AS
SELECT a.id, a.natural_key
FROM raw_contract_value_annex_history a
JOIN raw_contract_value_inputs i ON i.id = a.id
WHERE i.signing_value > 0 AND a.value_treatment IS NULL
  AND a.restated = 0 AND a.value_before > 0
  AND (a.ccy = COALESCE(NULLIF(i.signing_currency, ''), 'BGN')
    OR (a.ccy IN ('BGN', 'EUR') AND COALESCE(NULLIF(i.signing_currency, ''), 'BGN') IN ('BGN', 'EUR')))
  AND (
    -- Keep the previously published legacy marker. A corrected delta cannot reconstruct
    -- whether the reported before, after and delta were consistent.
    (a.evidence_known = 0 AND a.legacy_suspect = 1)
    OR (a.evidence_known = 1
      AND a.reported_after >= 2 * a.value_before AND a.reported_after < 10 * a.value_before
      AND (a.value_delta IS NULL OR ABS(a.reported_after - (a.value_before + a.value_delta)) < 0.01 * a.reported_after)
      AND (
        ABS(a.before_basis - i.signing_value * CASE i.signing_currency WHEN 'EUR' THEN 1.95583 ELSE 1 END)
          < 0.01 * i.signing_value * CASE i.signing_currency WHEN 'EUR' THEN 1.95583 ELSE 1 END
        OR EXISTS (
          SELECT 1 FROM raw_contract_value_annex_history p
          WHERE p.id = i.id AND p.natural_key <> a.natural_key AND p.value_before > 0
            AND (p.ccy = a.ccy OR (p.ccy IN ('BGN', 'EUR') AND a.ccy IN ('BGN', 'EUR')))
            AND ABS(p.after_basis - a.before_basis) < 0.01 * a.before_basis
            AND p.reported_after < 2 * p.value_before
        )
        OR (
          ABS(a.reported_after - 2 * a.value_before) < 0.005 * a.value_before
          AND NOT EXISTS (
            SELECT 1 FROM raw_contract_value_annex_history p
            WHERE p.id = i.id AND p.natural_key <> a.natural_key
              AND (p.ccy = a.ccy OR (p.ccy IN ('BGN', 'EUR') AND a.ccy IN ('BGN', 'EUR')))
              AND ABS(p.after_basis - a.before_basis) < 0.01 * a.before_basis
          )
        )
      )
    )
  );

CREATE VIEW IF NOT EXISTS raw_contract_annex_evidence AS
SELECT i.id,
  EXISTS (
    SELECT 1 FROM raw_contract_value_annex_history a
    WHERE a.id = i.id AND a.value_before > 0
      AND a.reported_after >= 10 * a.value_before
  ) AS has_step10,
  EXISTS (
    SELECT 1 FROM raw_contract_suspect_annexes a
    WHERE a.id = i.id AND a.natural_key = i.current_annex_key
  ) OR (
    -- A later leading annex can carry forward the total of an earlier suspect annex: its before-value
    -- is that total (in lev or, at the peg, in euro) and its after-value repeats it, or moves it by
    -- less than 1% — a small step on the suspect base is still that base. Such an annex adds no
    -- evidence about the total, so the contract keeps the verdict of the suspect annex. An annex that
    -- changes the total by more is new evidence: a correction, or a real step, counts as it reads.
    i.signing_value > 0 AND EXISTS (
      SELECT 1 FROM raw_contract_value_annex_history a
      JOIN raw_contract_suspect_annexes s ON s.id = a.id AND s.natural_key <> a.natural_key
      JOIN raw_contract_value_annex_history p ON p.id = s.id AND p.natural_key = s.natural_key
      WHERE a.id = i.id AND a.natural_key = i.current_annex_key
        AND a.value_treatment IS NULL AND a.value_before > 0
        AND (p.ccy = a.ccy OR (p.ccy IN ('BGN', 'EUR') AND a.ccy IN ('BGN', 'EUR')))
        AND ABS(p.after_basis - a.before_basis) < 0.01 * a.before_basis
        AND ABS(a.reported_after - a.value_before) < 0.01 * a.value_before
    )
  ) OR (
    -- A later leading annex can inherit a total that a previous annex already restated down.
    i.signing_value > 0 AND EXISTS (
      SELECT 1 FROM raw_contract_value_annex_history a
      WHERE a.id = i.id AND a.natural_key = i.current_annex_key
        AND a.ccy = COALESCE(NULLIF(i.signing_currency, ''), 'BGN')
        AND a.value_treatment IS NULL AND a.value_before > 0
        AND EXISTS (
          SELECT 1 FROM raw_contract_value_annex_history p
          WHERE p.id = i.id AND p.natural_key <> a.natural_key AND p.ccy = a.ccy AND p.restated = 1 AND (
            (p.effective_after < p.raw_after AND ABS(p.raw_after - a.value_before) < 0.01 * a.value_before)
            -- Legacy restatements carry only the corrected value. Preserve the bounded heuristic
            -- until the actual source publication is replayed, without treating it as raw evidence.
            -- The bound includes the exact double: an unchanged restatement's raw total is twice the
            -- corrected one, so a later annex built on that raw total starts at 2x.
            OR (p.evidence_known = 0 AND a.value_before > p.effective_after
              AND a.value_before < 2.02 * p.effective_after)
          )
        )
    )
  ) AS has_suspect_total
FROM raw_contract_value_inputs i;

CREATE VIEW IF NOT EXISTS raw_contract_values AS
WITH currencies AS (
  SELECT i.id, i.signed_at, i.signing_value, i.current_value, i.proc_est_native, i.own_est_native,
    i.framework, i.keep_symbolic, i.prior_signing_rate,
    e.has_step10, e.has_suspect_total,
    COALESCE(NULLIF(signing_currency, ''), 'BGN') AS signing_ccy,
    COALESCE(NULLIF(current_currency, ''), NULLIF(signing_currency, ''), 'BGN') AS current_ccy,
    COALESCE(NULLIF(proc_est_currency, ''), 'BGN') AS proc_ccy,
    COALESCE(NULLIF(own_est_currency, ''), NULLIF(signing_currency, ''), 'BGN') AS own_ccy
  FROM raw_contract_value_inputs i
  JOIN raw_contract_annex_evidence e ON e.id = i.id
), rated AS (
  SELECT c.*,
    CASE WHEN signing_ccy NOT IN ('BGN', 'EUR') THEN COALESCE((
      SELECT eur_per_unit FROM fx_rates
      WHERE base_currency = signing_ccy AND rate_date BETWEEN date(signed_at, '-10 days') AND signed_at
      ORDER BY rate_date DESC LIMIT 1
    ), prior_signing_rate) END AS signing_rate
  FROM currencies c
), converted AS MATERIALIZED (
  SELECT c.*,
    CASE signing_ccy WHEN 'EUR' THEN signing_value WHEN 'BGN' THEN signing_value / 1.95583
      ELSE signing_value * signing_rate END AS signing_eur,
    CASE current_ccy WHEN 'EUR' THEN current_value WHEN 'BGN' THEN current_value / 1.95583
      ELSE current_value * CASE WHEN current_ccy = signing_ccy THEN signing_rate ELSE (
        SELECT eur_per_unit FROM fx_rates
        WHERE base_currency = current_ccy AND rate_date BETWEEN date(signed_at, '-10 days') AND signed_at
        ORDER BY rate_date DESC LIMIT 1
      ) END END AS current_eur,
    CASE proc_ccy WHEN 'EUR' THEN proc_est_native WHEN 'BGN' THEN proc_est_native / 1.95583
      ELSE proc_est_native * (SELECT eur_per_unit FROM fx_rates
        WHERE base_currency = proc_ccy AND rate_date BETWEEN date(signed_at, '-10 days') AND signed_at
        ORDER BY rate_date DESC LIMIT 1) END AS proc_est_eur,
    CASE own_ccy WHEN 'EUR' THEN own_est_native WHEN 'BGN' THEN own_est_native / 1.95583
      ELSE own_est_native * (SELECT eur_per_unit FROM fx_rates
        WHERE base_currency = own_ccy AND rate_date BETWEEN date(signed_at, '-10 days') AND signed_at
        ORDER BY rate_date DESC LIMIT 1) END AS own_est_eur
  FROM rated c
), compared AS (
  SELECT c.*,
    CASE WHEN current_value IS NULL THEN signing_eur ELSE current_eur END AS eff_eur,
    -- A same-currency ratio does not require an FX rate. For different currencies, a missing rate
    -- leaves the ratio unknown. A zero signing amount cannot establish an annex multiple.
    CASE WHEN signing_value > 0 THEN
      CASE WHEN signing_ccy = current_ccy THEN current_value / signing_value
        ELSE current_eur / NULLIF(signing_eur, 0) END
    END AS annex_ratio
  FROM converted c
), classified AS (
  SELECT c.*,
    CASE
      WHEN eff_eur > 2000000000
        OR (proc_est_eur >= 1000 AND (eff_eur > 200 * proc_est_eur
          OR eff_eur BETWEEN 95 * proc_est_eur AND 105 * proc_est_eur))
        -- A per-lot estimate can be a unit price. Require an implausible procedure multiple too.
        OR (own_est_eur >= 1000 AND proc_est_eur >= 1000 AND eff_eur >= 10 * proc_est_eur
          AND eff_eur BETWEEN 95 * own_est_eur AND 105 * own_est_eur) THEN 'value_suspect'
      -- Preserve non-positive face values, and symbolic signings relative to the own-row estimate.
      -- Currency conversion is unnecessary for the sign test, even if a foreign rate is missing.
      WHEN COALESCE(current_value, signing_value) <= 0
        OR (own_est_eur > 0 AND signing_eur < 1000 AND signing_eur / own_est_eur < 0.05)
        OR keep_symbolic THEN 'value_low'
      WHEN annex_ratio >= 100 OR (annex_ratio >= 5 AND has_step10) THEN 'annex_suspect'
      WHEN current_value IS NOT NULL AND signing_value > 0 AND has_suspect_total THEN 'annex_total_suspect'
      WHEN proc_est_eur > 0 AND eff_eur >= 10 * proc_est_eur THEN 'review'
      ELSE 'ok'
    END AS value_flag
  FROM compared c
)
SELECT id, value_flag, current_value,
  CASE value_flag
    WHEN 'value_suspect' THEN proc_est_native
    WHEN 'annex_suspect' THEN COALESCE(signing_value, current_value)
    WHEN 'annex_total_suspect' THEN COALESCE(signing_value, current_value)
    ELSE COALESCE(current_value, signing_value)
  END AS amount,
  CASE
    WHEN framework = 2 THEN NULL
    WHEN value_flag = 'value_suspect' THEN proc_est_eur
    WHEN value_flag IN ('annex_suspect', 'annex_total_suspect') AND signing_value IS NOT NULL THEN signing_eur
    ELSE eff_eur
  END AS amount_eur,
  CASE WHEN value_flag <> 'value_suspect' THEN signing_eur END AS signing_value_eur,
  CASE WHEN value_flag NOT IN ('value_suspect', 'annex_suspect', 'annex_total_suspect')
    THEN current_eur END AS current_value_eur,
  CASE WHEN current_value IS NULL THEN signing_ccy ELSE current_ccy END AS current_value_currency,
  signing_ccy NOT IN ('BGN', 'EUR') AS fx_converted,
  signing_rate AS fx_rate
FROM classified;
