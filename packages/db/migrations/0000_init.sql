-- Sigma — consolidated schema (D1 / SQLite). Single source of truth for the database.
--
-- Sigma is pre-production and every import starts from a FRESH database (no deployed data to
-- preserve), so the schema is ONE file rather than an incremental migration chain — re-introduce
-- incremental migrations only once there is deployed data you cannot drop. Applied by
-- `wrangler d1 migrations apply sigma [--local|--remote]`; the full import is `node scripts/import.mjs`
-- (work DB: load-eop → derive-amendments → load-fx → load-nuts → normalize-raw → promote-amendments,
-- then ship-domain copies the served tables into the served D1 and runs precompute on it).
--
-- Modelling rationale (cleaning policy, value_flag, consortium model, canonical EUR + FX, the
-- synthetic-tender rule) lives in docs/etl.md and docs/core-scope.md.
--
-- Layout: (1) domain tables the explorer reads (+ amendments history + the OCDS parties projection),
-- (1b) rollups + FTS search, (3) fx_rates / nuts_regions / data_freshness reference, (4) indexes.
-- No raw_* staging lives here — the load/transform staging schema is scripts/work-staging-schema.sql
-- (work DB only, never served).

-- ===================================================================================
-- 1) DOMAIN — what the explorer reads (built by scripts/normalize-raw.sql)
-- ===================================================================================

CREATE TABLE authorities (
  id         TEXT PRIMARY KEY,           -- 'auth:' || ЕИК
  name       TEXT NOT NULL,
  bulstat    TEXT,                        -- ЕИК / Булстат
  region     TEXT,
  type       TEXT,                        -- Вид на възложителя (ЗОП controlled vocab: Публичноправна организация / Орган на централната власт …)
  type_group TEXT,                        -- friendly bucket (министерство/община/агенция/болница/образование/държавна компания/друго) — heuristic from name + type (non-critical display)
  -- location — filled from OCDS parties / NSI ЕКАТТЕ; NULL until those loaders run
  nuts         TEXT,                       -- NUTS region code (e.g. BG411 София)
  settlement   TEXT,                       -- населено място (city/town)
  ekatte       TEXT,                       -- settlement ЕКАТТЕ code
  municipality TEXT,                       -- община
  address      TEXT,                       -- registered / seat address
  contact_email TEXT,
  contact_phone TEXT,
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
  eop_tender_id   TEXT,                    -- raw EOP numeric tenderId; documents deep-link https://app.eop.bg/today/<id> (NOT the УНП / noticeId)
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lots (
  id              TEXT PRIMARY KEY,        -- 'lot:' || УНП || ':' || lot_id
  tender_id       TEXT NOT NULL REFERENCES tenders(id),
  title           TEXT NOT NULL,
  cpv_code        TEXT,
  estimated_value REAL,
  value_amount    REAL,
  value_currency  TEXT,
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
  ownership_kind TEXT,                        -- state | municipal | mixed; curated public-owned winner allowlist
  -- company master data — filled from OCDS parties; NULL until those loaders run
  legal_form   TEXT,                       -- правна форма (ООД / ЕООД / АД / ЕТ / ДЗЗД …)
  nuts         TEXT,                        -- NUTS region code
  settlement   TEXT,                        -- населено място (seat)
  ekatte       TEXT,                        -- settlement ЕКАТТЕ code
  municipality TEXT,                        -- община
  address      TEXT,                        -- seat address
  contact_email TEXT,
  contact_phone TEXT,
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
  value_flag       TEXT NOT NULL DEFAULT 'ok',  -- ok | review | value_low | value_suspect | annex_suspect (data-quality verdict; assigned in scripts/normalize-raw.sql)
  date_flag        TEXT NOT NULL DEFAULT 'ok',  -- ok | signed_after_publication (non-destructive date-quality verdict)
  amount_eur       REAL,                   -- canonical EUR, SAFE TO SUM; populated for all flags (value_suspect repaired to the procedure estimate); NULL only when no trustworthy EUR figure (FX-rateless foreign / value_suspect w/o estimate / no signing+current)
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

-- Domain amendment history used to roll current_value/annex_count without staging. Natural-keyed so
-- re-imports are idempotent; built by scripts/promote-amendments.sql from the transient amendment feed.
CREATE TABLE amendments (
  id              TEXT PRIMARY KEY,
  natural_key     TEXT NOT NULL UNIQUE,
  contract_number TEXT,
  unp             TEXT,
  value_before    REAL,
  value_after     REAL,
  value_delta     REAL,
  currency        TEXT,
  published_at    TEXT,
  document_number TEXT,
  description     TEXT,
  source          TEXT NOT NULL
);
CREATE INDEX idx_amendments_contract ON amendments(unp, contract_number);

-- Curated OCDS party projection (served domain/reference data, not raw staging). Built from the
-- transient raw_ocds_parties by scripts/normalize-raw.sql; feeds authority/bidder nuts/address/contact
-- enrichment by ЕИК. Keyed ЕИК-first so distinct companies sharing a reused OCDS party slot never collide.
CREATE TABLE parties (
  party_key      TEXT PRIMARY KEY,
  eik            TEXT,
  source         TEXT NOT NULL,
  ocid           TEXT,
  party_id       TEXT,
  name           TEXT,
  street_address TEXT,
  locality       TEXT,
  region_nuts    TEXT,
  contact_email  TEXT,
  contact_phone  TEXT
);
CREATE INDEX idx_parties_eik ON parties(eik);

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
  contracts    INTEGER NOT NULL,          -- corpus record count: COUNT(*) over ALL contracts (precompute.sql), NOT the clean-amount_eur count behind value_eur
  value_eur    REAL NOT NULL,             -- SUM(amount_eur), clean rows only; paired with the (larger) corpus contracts count — the two do NOT cover one set
  authorities  INTEGER NOT NULL,
  bidders      INTEGER NOT NULL,
  suspect      INTEGER NOT NULL,          -- COUNT of value_suspect rows (data-quality KPI); summed via repair to the procedure estimate, except a value_suspect row with no estimate (amount_eur NULL, excluded like other NULL rows)
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
  ownership_kind TEXT,                      -- state | municipal | mixed; copied from bidders
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
-- by normalize-raw.sql. Surfaces the freshness date the UI needs and lets the OCDS go-forward
-- catch-up verify the admin↔OCDS boundary (admin wins on overlap; see normalize-raw.sql step 5).
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
CREATE INDEX idx_contracts_date_flag ON contracts(date_flag);
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
