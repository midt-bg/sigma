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
  type       TEXT,                        -- Вид на възложителя (министерство / община / агенция …)
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
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The АОП data carries a bid COUNT (tenders/contracts), not individual bids → bids stays empty
-- in the core; kept so the per-offer model has a home if a source ever provides it.
CREATE TABLE bids (
  id           TEXT PRIMARY KEY,
  tender_id    TEXT NOT NULL REFERENCES tenders(id),
  lot_id       TEXT REFERENCES lots(id),
  bidder_id    TEXT NOT NULL REFERENCES bidders(id),
  amount       REAL NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'BGN',
  is_winner    INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  eu_funded       INTEGER
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
  sme              TEXT
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
CREATE INDEX idx_bids_tender ON bids(tender_id);
CREATE INDEX idx_bids_bidder ON bids(bidder_id);
CREATE INDEX idx_contracts_tender ON contracts(tender_id);
CREATE INDEX idx_contracts_bidder ON contracts(bidder_id);
CREATE INDEX idx_contracts_value_flag ON contracts(value_flag);
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
