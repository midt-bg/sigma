-- Sigma — consolidated schema (D1 / SQLite). Single source of truth for the database.
--
-- Sigma is pre-production and every import starts from a FRESH database (no deployed data to
-- preserve), so the schema is ONE file rather than an incremental migration chain — re-introduce
-- incremental migrations only once there is deployed data you cannot drop. Applied by
-- `wrangler d1 migrations apply sigma [--local|--remote]`; the full import is `node scripts/import.mjs`
-- (migrations → load-admin → derive-amendments → load-fx → normalize-egov).
--
-- Modelling rationale (cleaning policy, value_flag, consortium model, canonical EUR + FX, the
-- synthetic-tender rule) lives in docs/etl-pipeline.md and docs/core-scope.md.
--
-- Layout: (1) domain tables the explorer reads, (2) raw_egov_* staging from the admin export,
-- (3) fx_rates reference, (4) indexes, (5) contract_participants view (parked owner attribution).

-- ===================================================================================
-- 1) DOMAIN — what the explorer reads (built by scripts/normalize-egov.sql)
-- ===================================================================================

CREATE TABLE authorities (
  id         TEXT PRIMARY KEY,           -- 'auth:' || ЕИК
  name       TEXT NOT NULL,
  bulstat    TEXT,                        -- ЕИК / Булстат
  region     TEXT,
  type       TEXT,                        -- Вид на възложителя (ЗОП controlled vocab: Публичноправна организация / Орган на централната власт …)
  type_group TEXT,                        -- friendly bucket (министерство/община/агенция/болница/образование/държавна компания/друго) — heuristic from name + type (non-critical display)
  -- location — filled from OCDS parties / Trade Register / NSI ЕКАТТЕ; NULL until those loaders run
  nuts         TEXT,                       -- NUTS region code (e.g. BG411 София)
  settlement   TEXT,                       -- населено място (city/town)
  ekatte       TEXT,                       -- settlement ЕКАТТЕ code
  municipality TEXT,                       -- община
  address      TEXT,                       -- registered / seat address
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tenders (
  id              TEXT PRIMARY KEY,        -- 't:' || УНП
  source_id       TEXT NOT NULL UNIQUE,    -- УНП (ЦАИС ЕОП identifier)
  title           TEXT NOT NULL,
  authority_id    TEXT NOT NULL REFERENCES authorities(id),
  cpv_code        TEXT,
  cpv_description TEXT,                     -- human-readable CPV label (no external dictionary needed)
  estimated_value REAL,
  currency        TEXT NOT NULL DEFAULT 'BGN',
  procedure_type  TEXT NOT NULL,           -- 'неизвестна' for synthetic (contract-only) tenders
  contract_kind   TEXT,                    -- Доставки / Услуги / Строителство
  num_lots        INTEGER,
  status          TEXT NOT NULL DEFAULT 'planned',  -- 'awarded' if it has a contract, else 'published'
  published_at    TEXT,
  deadline_at     TEXT,
  legal_basis     TEXT,                    -- Правно основание за откриване
  award_criteria  TEXT,                    -- Критерий за възлагане
  main_activity   TEXT,                    -- Основна дейност на възложителя
  notice_type     TEXT,                    -- Вид обявление
  place_of_performance TEXT,               -- Място на изпълнение
  start_date      TEXT,                    -- Начална дата
  end_date        TEXT,                    -- Крайна дата
  duration        TEXT,                    -- Продължителност
  duration_unit   TEXT,                    -- Продължителност - мерна единица
  eu_programme    TEXT,                    -- Европейска програма (tender-level)
  green           INTEGER,                 -- Екологосъобразна поръчка
  social          INTEGER,                 -- Постигане на социални цели
  innovation      INTEGER,                 -- Поръчка за новаторски решения
  eauction        INTEGER,                 -- Електронен търг
  cancelled       INTEGER,                 -- Отменена
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lots (
  id              TEXT PRIMARY KEY,        -- 'lot:' || УНП || ':' || lot_id
  tender_id       TEXT NOT NULL REFERENCES tenders(id),
  title           TEXT NOT NULL,
  cpv_code        TEXT,
  estimated_value REAL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bidders (
  id             TEXT PRIMARY KEY,         -- 'eik:' || ЕИК when valid, else 'name:' || normalised name
  name           TEXT NOT NULL,
  bulstat        TEXT UNIQUE,              -- raw ЕИК as it appears (verbatim); NULL for name-keyed bidders
  eik_normalized TEXT,                     -- digits-only ЕИК when recoverable, else NULL
  eik_valid      INTEGER NOT NULL DEFAULT 0,  -- 1 if eik_normalized is a valid 9/13-digit ЕИК
  is_consortium  INTEGER NOT NULL DEFAULT 0,  -- 1 if the name is a JV (ДЗЗД / ОБЕДИНЕНИЕ / КОНСОРЦИУМ / member list)
  kind           TEXT NOT NULL DEFAULT 'company',  -- 'company' | 'consortium'
  -- company master data — filled from Trade Register / OCDS parties; NULL until those loaders run
  legal_form   TEXT,                       -- правна форма (ООД / ЕООД / АД / ЕТ / ДЗЗД …)
  nuts         TEXT,                        -- NUTS region code
  settlement   TEXT,                        -- населено място (seat)
  ekatte       TEXT,                        -- settlement ЕКАТТЕ code
  municipality TEXT,                        -- община
  address      TEXT,                        -- seat address
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- NB: there is intentionally NO `bids` table. No available source (admin export or OCDS) publishes
-- per-bidder offer lines — only an aggregate COUNT (`contracts.bids_received`) and, in OCDS, bid
-- statistics (SME / electronic / foreign counts, captured in the OCDS staging). Re-introduce a bids
-- table only if a per-offer source ever appears.

CREATE TABLE contracts (
  id               TEXT PRIMARY KEY,       -- 'c:' || staging row id
  tender_id        TEXT NOT NULL REFERENCES tenders(id),
  bidder_id        TEXT NOT NULL REFERENCES bidders(id),
  amount           REAL NOT NULL,          -- as-recorded headline value in `currency` (display); signing for annex_suspect
  currency         TEXT NOT NULL DEFAULT 'BGN',
  signed_at        TEXT,
  contract_number  TEXT,
  signing_value    REAL,                   -- Стойност при сключване
  current_value    REAL,                   -- latest post-annex value (derive-amendments.sql)
  annex_count      INTEGER NOT NULL DEFAULT 0,
  eu_funded        INTEGER,
  bids_received    INTEGER,
  contract_kind    TEXT,                   -- Доставки / Услуги / Строителство
  awarded_to_group INTEGER,                -- this AWARD went to an обединение (per-contract, distinct from bidders.is_consortium)
  value_flag       TEXT NOT NULL DEFAULT 'ok',  -- ok | review | annex_suspect | value_suspect (data-quality verdict)
  amount_eur       REAL,                   -- canonical EUR, SAFE TO SUM; NULL = excluded (value_suspect)
  fx_converted     INTEGER NOT NULL DEFAULT 0,  -- 1 = amount_eur came from a foreign-currency market rate
  fx_rate          REAL,                   -- EUR per 1 unit of `currency` for foreign rows (amount × fx_rate = amount_eur)
  signing_value_eur REAL,                  -- signing_value in EUR (peg/fx); NULL for value_suspect — for the contract value timeline
  current_value_eur REAL,                  -- current_value in EUR; NULL for value_suspect/annex_suspect (suspect annex suppressed)
  lot_id           TEXT,                   -- domain lot id ('lot:'||УНП||':'||raw) when the award is lot-scoped; soft-links lots(id)
  document_number  TEXT,                   -- Номер на документ
  published_at     TEXT,                   -- Публикуван на
  contract_subject TEXT,                   -- Предмет на договора (distinct from the procurement subject)
  eu_programme       TEXT,                 -- Европейска програма (operational programme name)
  duration_days      INTEGER,              -- Срок на договора в дни
  winner_size        TEXT,                 -- Размер на победителя (micro/small/medium/large)
  contractor_country TEXT,                 -- Код на държавата на изпълнителя
  bids_sme           INTEGER,              -- Брой оферти от МСП
  bids_rejected      INTEGER,              -- Брой отстранени оферти
  bids_non_eea       INTEGER,              -- Брой оферти извън ЕИП
  subcontractor_eik  TEXT,                 -- ЕИК на подизпълнителя
  subcontractor_name TEXT,                 -- Наименование на подизпълнителя
  subcontract_value  REAL,                 -- Стойност, възложена на подизпълнител
  eauction         INTEGER,                -- Електронен търг
  framework        INTEGER,                -- Договор по рамково споразумение
  accelerated      INTEGER,                -- Ускорена процедура
  strategic        INTEGER,                -- Стратегическа поръчка
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Parked (signals layer): composite risk per tender. Recomputed by apps/etl; empty in the core.
CREATE TABLE risk_scores (
  tender_id   TEXT PRIMARY KEY REFERENCES tenders(id),
  score       REAL NOT NULL,
  band        TEXT NOT NULL,
  signals     TEXT NOT NULL DEFAULT '{}',  -- JSON signal breakdown
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Parked (owner layer): members of a consortium/обединение. Populated later from the Търговски
-- регистър joined on ЕИК (and any in-field ЕИК lists). Empty in the core.
CREATE TABLE bidder_members (
  consortium_id TEXT NOT NULL REFERENCES bidders(id),
  member_eik    TEXT NOT NULL,            -- normalized ЕИК of a participant company
  member_id     TEXT REFERENCES bidders(id),  -- linked bidder row when the member also bids/wins itself
  share_pct     REAL,                     -- documented share if known, else NULL (never invented)
  source        TEXT NOT NULL,            -- 'in_field' | 'bulstat' | 'tr' | 'name_match'
  PRIMARY KEY (consortium_id, member_eik)
);

-- ===================================================================================
-- 1b) ROLLUPS + SEARCH — read-optimised artifacts the explorer reads INSTEAD of a
--     per-request GROUP BY over 190k contracts × joins (D1 meters rows read). Built by
--     scripts/precompute.sql (full rebuild after normalize; scoped re-derive on the daily
--     Workflow). Leaderboards/home/flows/sector-facet read these; detail pages still scope
--     a GROUP BY to one entity. See docs/v1-implementation-plan.md "Precompute layer".
-- ===================================================================================

-- One row (id = 1). Index KPIs + freshness for the home page.
CREATE TABLE home_totals (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  contracts    INTEGER NOT NULL,          -- contracts with a clean (non-NULL) amount_eur
  value_eur    REAL NOT NULL,             -- SUM(amount_eur) over those same rows (count/sum cover one set)
  authorities  INTEGER NOT NULL,
  bidders      INTEGER NOT NULL,
  suspect      INTEGER NOT NULL,          -- value_suspect rows (NULL amount_eur): surfaced, never summed
  first_date   TEXT,
  last_date    TEXT,
  as_of        TEXT,                       -- data_freshness 'admin' as_of (latest real contract date)
  refreshed_at TEXT NOT NULL
);

-- Per winning entity (bidder). Companies leaderboard (default sort) + company headline + home top-10.
CREATE TABLE company_totals (
  bidder_id      TEXT PRIMARY KEY REFERENCES bidders(id),
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,            -- company | consortium
  eik            TEXT,                      -- eik_normalized (NULL when name-keyed)
  eik_valid      INTEGER NOT NULL DEFAULT 0,
  settlement     TEXT,
  won_eur        REAL NOT NULL,            -- SUM(amount_eur) of contracts won (clean rows only)
  contracts      INTEGER NOT NULL,
  authorities    INTEGER NOT NULL,         -- distinct paying authorities
  primary_sector TEXT,                      -- CPV division carrying the most won €
  eu_eur         REAL NOT NULL DEFAULT 0,  -- won € on EU-funded contracts
  first_date     TEXT,
  last_date      TEXT
);

-- Per authority. Authorities leaderboard (default sort) + authority headline + home slices.
CREATE TABLE authority_totals (
  authority_id   TEXT PRIMARY KEY REFERENCES authorities(id),
  name           TEXT NOT NULL,
  type_group     TEXT,
  settlement     TEXT,
  region         TEXT,
  spent_eur      REAL NOT NULL,
  contracts      INTEGER NOT NULL,
  suppliers      INTEGER NOT NULL,         -- distinct winning bidders
  avg_eur        REAL NOT NULL,
  primary_sector TEXT,
  eu_eur         REAL NOT NULL DEFAULT 0,
  first_date     TEXT,
  last_date      TEXT
);

-- Per CPV division. Sector facet + filter counts on the list pages.
CREATE TABLE sector_totals (
  division   TEXT PRIMARY KEY,             -- 2-digit CPV division (joins @sigma/config CPV_SECTORS)
  contracts  INTEGER NOT NULL,
  value_eur  REAL NOT NULL
);

-- Global filter-facet counts (year / raw procedure_type / EU) so the list rails never scan 190k rows
-- per request. `procedure` rows are per raw procedure_type; the loader folds them into the 7
-- @sigma/config groups (so the SQL stays free of the taxonomy). Counts are unfiltered (the mock shows
-- global per-facet totals).
CREATE TABLE facet_counts (
  facet     TEXT NOT NULL,                 -- 'year' | 'procedure' | 'eu'
  key       TEXT NOT NULL,                 -- year YYYY | raw procedure_type | '1'/'0'
  contracts INTEGER NOT NULL,
  value_eur REAL NOT NULL,
  PRIMARY KEY (facet, key)
);

-- Per (authority, bidder). Flows Sankey + table (default, all-sector view).
CREATE TABLE flow_pairs (
  authority_id   TEXT NOT NULL REFERENCES authorities(id),
  bidder_id      TEXT NOT NULL REFERENCES bidders(id),
  authority_name TEXT NOT NULL,
  bidder_name    TEXT NOT NULL,
  bidder_kind    TEXT NOT NULL,
  won_eur        REAL NOT NULL,
  contracts      INTEGER NOT NULL,
  PRIMARY KEY (authority_id, bidder_id)
);

-- FTS5 search over authority names, bidder names + ЕИК, contract subjects + УНП. Cyrillic+Latin,
-- accent/case-folded (unicode61 remove_diacritics 2) so „ГБС"≈„GBS" and case/diacritics don't matter.
-- Replaces a naive LIKE (can't case-fold Cyrillic, full-scans). Searchable: title, ident. The rest
-- are UNINDEXED display fields so a result card renders without re-joining. Rebuilt by precompute.
CREATE VIRTUAL TABLE search_index USING fts5(
  kind UNINDEXED,          -- 'authority' | 'company' | 'contract'
  ref UNINDEXED,           -- route slug (ЕИК / contract id)
  title,                   -- entity name / contract subject
  ident,                   -- ЕИК / УНП
  subtitle UNINDEXED,      -- prerendered meta line (settlement / parties / date)
  amount UNINDEXED,        -- € figure for display (won / spent / value)
  tokenize = "unicode61 remove_diacritics 2"
);

-- ===================================================================================
-- 2) STAGING — admin ЦАИС ЕОП export (data/Open_data_resources.zip), by scripts/load-admin.mjs.
--    100% raw landing (source 'admin:<cat>:<year>'); all cleaning happens in normalize-egov.sql.
-- ===================================================================================

CREATE TABLE raw_egov_contracts (
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

  -- full capture — every remaining admin Contracts header (see scripts/load-admin.mjs CATS.contracts)
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
CREATE TABLE raw_egov_tenders (
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
  -- full capture — every remaining admin Tenders header (see scripts/load-admin.mjs CATS.tenders)
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
CREATE TABLE raw_egov_amendments (
  id               INTEGER PRIMARY KEY,
  source           TEXT NOT NULL,          -- 'admin:annexes:2023'
  dataset_uri      TEXT,
  resource_uri     TEXT,
  dataset_year     INTEGER,
  dataset_variant  TEXT,
  fetched_at       TEXT NOT NULL,
  seq_no               TEXT,
  document_number      TEXT,
  contract_number      TEXT,              -- ← link to raw_egov_contracts
  contract_date        TEXT,
  published_at         TEXT,              -- amendment publication date (ordering key)
  unp                  TEXT,              -- ← link to raw_egov_contracts
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
  currency         TEXT,
  description      TEXT,                  -- Описание на измененията
  reason           TEXT,                  -- Причини за изменение (ЗОП основание)
  circumstances    TEXT,                  -- Обстоятелства
  sme              TEXT,
  -- full capture — every remaining admin Annexes header (see scripts/load-admin.mjs CATS.annexes)
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

-- OCDS parties (data.egov.bg OCDS feed) — full party records: ЕИК + address (city + NUTS region) +
-- roles + contact. Captured by scripts/load-ocds.mjs; normalize-egov.sql enriches authorities/bidders
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

-- OCDS award suppliers — every supplier on every award (supplier_count > 1 = joint venture /
-- consortium, the member breakdown OCDS exposes). Captured by scripts/load-ocds.mjs. Source 'ocds:%'.
CREATE TABLE raw_ocds_award_suppliers (
  id             INTEGER PRIMARY KEY,
  source         TEXT NOT NULL,
  dataset_uri    TEXT,
  resource_uri   TEXT,
  fetched_at     TEXT NOT NULL,
  ocid           TEXT,
  award_id       TEXT,
  supplier_count INTEGER,                   -- suppliers on this award (>1 = joint / consortium)
  supplier_eik   TEXT,
  supplier_name  TEXT
);

-- Trade Register (Агенция по вписванията; data.egov.bg dataset 2df0c2af-…) — daily XML deltas, by
-- scripts/load-tr.mjs. One company row per <Deed> (current state).
-- Source 'tr:<file date>'; latest file_date wins on dedup. Personal IDs are hashed at source.
CREATE TABLE raw_tr_companies (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  file_date     TEXT,                        -- date of the daily file (latest wins)
  deed_guid     TEXT,
  uic           TEXT,                         -- ЕИК
  company_name  TEXT,
  legal_form    TEXT,                         -- EOOD / OOD / AD / ET / DZZD …
  deed_status   TEXT,
  subject_of_activity TEXT,                   -- предмет на дейност
  nkid          TEXT,                         -- НКИД economic-activity code
  country       TEXT,
  district      TEXT, district_ekatte TEXT,
  municipality  TEXT, municipality_ekatte TEXT,
  settlement    TEXT, settlement_ekatte TEXT,
  post_code     TEXT, street TEXT, street_number TEXT
);

-- ===================================================================================
-- 3) REFERENCE — ECB euro reference rates for foreign-currency signing dates (scripts/load-fx.mjs)
-- ===================================================================================

CREATE TABLE fx_rates (
  base_currency TEXT NOT NULL,            -- 'USD', 'CHF', …
  rate_date     TEXT NOT NULL,            -- the contract date we priced (ISO)
  eur_per_unit  REAL NOT NULL,            -- 1 base_currency = eur_per_unit EUR
  source        TEXT NOT NULL,            -- 'ecb:frankfurter'
  fetched_at    TEXT NOT NULL,
  PRIMARY KEY (base_currency, rate_date)
);

-- NUTS region reference (Eurostat/НСИ classification for BG, stable) — 28 области (NUTS3) grouped into
-- 6 NUTS2 + 2 NUTS1 macro-regions. Lets the UI label/aggregate the NUTS codes captured from OCDS
-- (authorities.nuts / bidders.nuts) and fills authorities.region. Seeded by scripts/load-nuts.sql.
-- (The full settlement-level ЕКАТТЕ classifier is deferred — no working open download today.)
CREATE TABLE nuts_regions (
  nuts3      TEXT PRIMARY KEY,             -- e.g. BG411
  nuts3_name TEXT NOT NULL,                -- София (столица)
  nuts2      TEXT NOT NULL,                -- BG41
  nuts2_name TEXT NOT NULL,                -- Югозападен
  nuts1      TEXT NOT NULL,                -- BG4
  nuts1_name TEXT NOT NULL
);

-- "Data current as of" per feed — the latest real contract date covered + row count, recomputed
-- by normalize-egov.sql. Surfaces the freshness date the UI needs and lets the OCDS go-forward
-- catch-up verify the admin↔OCDS boundary (admin wins on overlap; see normalize-egov.sql step 5).
CREATE TABLE data_freshness (
  source       TEXT PRIMARY KEY,          -- 'admin' | 'ocds'
  as_of        TEXT,                       -- MAX(contract_date) ≤ today
  rows         INTEGER,
  refreshed_at TEXT NOT NULL
);

-- ===================================================================================
-- 4) INDEXES
-- ===================================================================================

CREATE INDEX idx_tenders_authority ON tenders(authority_id);
CREATE INDEX idx_tenders_status ON tenders(status);
CREATE INDEX idx_tenders_published ON tenders(published_at);
CREATE INDEX idx_lots_tender ON lots(tender_id);
CREATE INDEX idx_bidders_eik_norm ON bidders(eik_normalized);
CREATE INDEX idx_contracts_lot ON contracts(lot_id);
CREATE INDEX idx_bidders_ekatte ON bidders(ekatte);
CREATE INDEX idx_authorities_ekatte ON authorities(ekatte);
CREATE INDEX idx_contracts_tender ON contracts(tender_id);
CREATE INDEX idx_contracts_bidder ON contracts(bidder_id);
CREATE INDEX idx_contracts_value_flag ON contracts(value_flag);
CREATE INDEX idx_contracts_signed ON contracts(signed_at);            -- contracts list date sort/filter
CREATE INDEX idx_contracts_cnum ON contracts(contract_number);        -- daily-refresh base-wins dedup
CREATE INDEX idx_contracts_amount_eur ON contracts(amount_eur);       -- contracts list value sort + keyset
CREATE INDEX idx_contracts_value_desc ON contracts(COALESCE(amount_eur, -1));
CREATE INDEX idx_contracts_value_asc ON contracts(COALESCE(amount_eur, 1e18));
CREATE INDEX idx_tenders_cpv ON tenders(cpv_code);                     -- sector (CPV-division) filtered fallbacks
-- Rollups: keyed on grain (PK) + sorted by the leaderboard sort column.
CREATE INDEX idx_company_totals_won ON company_totals(won_eur DESC);
CREATE INDEX idx_company_totals_kind ON company_totals(kind);
CREATE INDEX idx_company_totals_name ON company_totals(name);
CREATE INDEX idx_authority_totals_spent ON authority_totals(spent_eur DESC);
CREATE INDEX idx_authority_totals_type ON authority_totals(type_group);
CREATE INDEX idx_authority_totals_name ON authority_totals(name);
CREATE INDEX idx_flow_pairs_won ON flow_pairs(won_eur DESC);
CREATE INDEX idx_flow_pairs_authority ON flow_pairs(authority_id);
CREATE INDEX idx_risk_band ON risk_scores(band);
CREATE INDEX idx_bidder_members_member ON bidder_members(member_eik);
CREATE INDEX idx_egov_unp ON raw_egov_contracts(unp);
CREATE INDEX idx_egov_unp_cnum ON raw_egov_contracts(unp, contract_number);
CREATE INDEX idx_egov_cnum ON raw_egov_contracts(contract_number);  -- admin↔OCDS dedup key (normalize step 5)
CREATE INDEX idx_egov_eik ON raw_egov_contracts(contractor_eik);
CREATE INDEX idx_egov_year ON raw_egov_contracts(dataset_year);
CREATE INDEX idx_egov_needs_enrichment ON raw_egov_contracts(needs_enrichment);
CREATE INDEX idx_egov_tenders_unp ON raw_egov_tenders(unp);
CREATE INDEX idx_egov_tenders_source ON raw_egov_tenders(source);
CREATE INDEX idx_egov_amend_contract ON raw_egov_amendments(unp, contract_number);
CREATE INDEX idx_egov_amend_source ON raw_egov_amendments(source);
CREATE INDEX idx_ocds_parties_eik ON raw_ocds_parties(eik);
CREATE INDEX idx_ocds_parties_source ON raw_ocds_parties(source);
CREATE INDEX idx_ocds_award_suppliers_eik ON raw_ocds_award_suppliers(supplier_eik);
CREATE INDEX idx_ocds_award_suppliers_source ON raw_ocds_award_suppliers(source);
CREATE INDEX idx_tr_companies_uic ON raw_tr_companies(uic);

-- ===================================================================================
-- 5) VIEWS — contract_participants (parked owner attribution; SUM-safe per company).
--    Sole winner → one row; resolved consortium → one row per member; unresolved consortium →
--    the consortium entity itself (role says which). allocated_amount splits the headline value.
-- ===================================================================================

CREATE VIEW contract_participants AS
SELECT
  c.id            AS contract_id,
  c.tender_id     AS tender_id,
  bm.member_eik   AS participant_eik,
  'member'        AS role,
  c.amount / mc.n AS allocated_amount,
  mc.n            AS member_count,
  1               AS is_estimated_split
FROM contracts c
JOIN bidders b ON b.id = c.bidder_id AND b.kind = 'consortium'
JOIN bidder_members bm ON bm.consortium_id = c.bidder_id
JOIN (SELECT consortium_id, COUNT(*) AS n FROM bidder_members GROUP BY consortium_id) mc
  ON mc.consortium_id = c.bidder_id
UNION ALL
SELECT
  c.id,
  c.tender_id,
  b.eik_normalized,
  CASE WHEN b.kind = 'consortium' THEN 'consortium_unresolved' ELSE 'sole' END,
  c.amount,
  1,
  0
FROM contracts c
JOIN bidders b ON b.id = c.bidder_id
WHERE NOT (b.kind = 'consortium'
           AND EXISTS (SELECT 1 FROM bidder_members bm WHERE bm.consortium_id = c.bidder_id));
