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
  party_id       TEXT,                     -- party id within the release
  eik            TEXT,                     -- identifier.id when scheme = BG-EIK
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
CREATE INDEX idx_ocds_lots_source ON raw_ocds_lots(source);
CREATE INDEX idx_ocds_lots_ocid_lot ON raw_ocds_lots(ocid, lot_id);
CREATE INDEX idx_ocds_lots_tender_lot ON raw_ocds_lots(tender_id, lot_id);
