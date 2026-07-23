-- Sigma — precompute the read-optimised artifacts the explorer reads (rollups + FTS) and the
-- per-contract EUR value timeline. Run AFTER scripts/normalize-raw.sql has (re)built the domain
-- tables:
--   (cd apps/web && wrangler d1 execute sigma --local --file ../../scripts/precompute.sql)
--
-- WHY: the explorer must NOT recompute aggregates per request — every leaderboard, the home KPIs,
-- the sector facet and the flows Sankey would otherwise be full GROUP BY scans over 190k contracts ×
-- joins, and D1 meters rows read. So normalize (full rebuild) and the daily Workflow (scoped
-- re-derive) precompute these tables and the explorer reads them. See docs/v1-implementation-plan.md.
--
-- IDEMPOTENT: CREATE … IF NOT EXISTS + DELETE/INSERT, so a re-run always reflects current rules and
-- never leaves stale rows. Runs as one atomic D1 batch (no explicit BEGIN/COMMIT). The rollup/FTS
-- table definitions live canonically in migrations/0000_init.sql; the IF NOT EXISTS guards here let
-- the same file also bootstrap a database created before these tables existed.
--
-- COUNT/SUM CONSISTENCY: a paired (count, sum) covers ONE row set — contracts with a clean
-- amount_eur. NULL amount_eur rows are excluded from sums; the suspect KPI specifically counts
-- value_suspect rows, so FX-rateless foreign rows are not mislabeled as suspect. The home/list
-- CORPUS counts use COUNT(*) (a record count, not the count behind a sum) and pair that tally alongside.

-- ── 0) Per-contract EUR value timeline ────────────────────────────────────────────────────────
-- signing/current in EUR for the contract page's estimated→signing→current strip.
-- BGN at the fixed peg (÷1.95583), EUR as-is, foreign at the row's stored fx_rate (eur_per_unit).
-- Display rule: NULL where the figure is suspect, so the caller renders „данните се преглеждат",
-- never a fabricated number. signing suppressed for value_suspect; current suppressed for value_ or
-- annex_suspect (the suspect annex is the bad part). estimated_value_eur is derived per-request on
-- the contract detail loader from the tender (procurement-level, shared across a multi-lot prepiska).
UPDATE contracts SET
  signing_value_eur = CASE
    WHEN value_flag = 'value_suspect' OR signing_value IS NULL THEN NULL
    WHEN COALESCE(currency,'BGN') = 'EUR' THEN signing_value
    WHEN COALESCE(currency,'BGN') = 'BGN' THEN signing_value / 1.95583
    WHEN fx_rate IS NOT NULL THEN signing_value * fx_rate
    ELSE NULL END,
  current_value_eur = CASE
    WHEN value_flag IN ('value_suspect','annex_suspect') OR current_value IS NULL THEN NULL
    WHEN COALESCE(currency,'BGN') = 'EUR' THEN current_value
    WHEN COALESCE(currency,'BGN') = 'BGN' THEN current_value / 1.95583
    WHEN fx_rate IS NOT NULL THEN current_value * fx_rate
    ELSE NULL END;

-- ── 1) home_totals shell (filled after company/authority rollups exist) ──────────────────────────
CREATE TABLE IF NOT EXISTS home_totals (
  id INTEGER PRIMARY KEY CHECK (id = 1), contracts INTEGER NOT NULL, value_eur REAL NOT NULL,
  authorities INTEGER NOT NULL, bidders INTEGER NOT NULL, suspect INTEGER NOT NULL,
  first_date TEXT, last_date TEXT, as_of TEXT, refreshed_at TEXT NOT NULL
);
DELETE FROM home_totals;

-- ── 2) company_totals (per bidder; clean rows only so won_eur pairs with contracts) ───────────────
CREATE TABLE IF NOT EXISTS company_totals (
  bidder_id TEXT PRIMARY KEY REFERENCES bidders(id), name TEXT NOT NULL, kind TEXT NOT NULL,
  ownership_kind TEXT, eik TEXT, eik_valid INTEGER NOT NULL DEFAULT 0, settlement TEXT, won_eur REAL NOT NULL,
  contracts INTEGER NOT NULL, authorities INTEGER NOT NULL, primary_sector TEXT,
  eu_eur REAL NOT NULL DEFAULT 0, first_date TEXT, last_date TEXT
);
DELETE FROM company_totals;
INSERT INTO company_totals (bidder_id, name, kind, ownership_kind, eik, eik_valid, settlement, won_eur, contracts, authorities, eu_eur, first_date, last_date)
SELECT b.id, b.name, b.kind, b.ownership_kind, b.eik_normalized, b.eik_valid, b.settlement,
  SUM(c.amount_eur), COUNT(*), COUNT(DISTINCT t.authority_id),
  SUM(CASE WHEN c.eu_funded = 1 THEN c.amount_eur ELSE 0 END),
  MIN(c.signed_at), MAX(c.signed_at)
FROM contracts c JOIN bidders b ON b.id = c.bidder_id JOIN tenders t ON t.id = c.tender_id
WHERE c.amount_eur IS NOT NULL
GROUP BY b.id;
-- primary sector = CPV division carrying the most won € for the bidder (tiebreak by code for determinism)
UPDATE company_totals SET primary_sector = (
  SELECT substr(t.cpv_code, 1, 2) FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE c.bidder_id = company_totals.bidder_id AND c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'') <> ''
  GROUP BY substr(t.cpv_code, 1, 2) ORDER BY SUM(c.amount_eur) DESC, substr(t.cpv_code, 1, 2) LIMIT 1);

-- ── 3) authority_totals (per authority) ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS authority_totals (
  authority_id TEXT PRIMARY KEY REFERENCES authorities(id), name TEXT NOT NULL, type_group TEXT,
  settlement TEXT, region TEXT, spent_eur REAL NOT NULL, contracts INTEGER NOT NULL,
  suppliers INTEGER NOT NULL, avg_eur REAL NOT NULL, primary_sector TEXT,
  eu_eur REAL NOT NULL DEFAULT 0, first_date TEXT, last_date TEXT
);
DELETE FROM authority_totals;
INSERT INTO authority_totals (authority_id, name, type_group, settlement, region, spent_eur, contracts, suppliers, avg_eur, eu_eur, first_date, last_date)
SELECT a.id, a.name, a.type_group, a.settlement, a.region,
  SUM(c.amount_eur), COUNT(*), COUNT(DISTINCT c.bidder_id), SUM(c.amount_eur) / COUNT(*),
  SUM(CASE WHEN c.eu_funded = 1 THEN c.amount_eur ELSE 0 END),
  MIN(c.signed_at), MAX(c.signed_at)
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
WHERE c.amount_eur IS NOT NULL
GROUP BY a.id;
UPDATE authority_totals SET primary_sector = (
  SELECT substr(t.cpv_code, 1, 2) FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE t.authority_id = authority_totals.authority_id AND c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'') <> ''
  GROUP BY substr(t.cpv_code, 1, 2) ORDER BY SUM(c.amount_eur) DESC, substr(t.cpv_code, 1, 2) LIMIT 1);

-- home_totals uses the browsable leaderboard grains for authority/bidder counts, and the same
-- freshness definition as refresh-slice.sql: latest in-corpus signed contract date.
INSERT INTO home_totals (id, contracts, value_eur, authorities, bidders, suspect, first_date, last_date, as_of, refreshed_at)
SELECT 1,
  (SELECT COUNT(*) FROM contracts),
  (SELECT COALESCE(SUM(amount_eur), 0) FROM contracts),
  (SELECT COUNT(*) FROM authority_totals),
  (SELECT COUNT(*) FROM company_totals),
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'value_suspect'),
  (SELECT MIN(signed_at) FROM contracts WHERE signed_at >= '2020-01-01' AND signed_at <= date('now')),
  (SELECT MAX(signed_at) FROM contracts WHERE signed_at <= date('now')),
  (SELECT MAX(signed_at) FROM contracts WHERE signed_at <= date('now')),
  datetime('now');

-- ── 4) sector_totals (per CPV division) ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sector_totals (
  division TEXT PRIMARY KEY, contracts INTEGER NOT NULL, value_eur REAL NOT NULL
);
DELETE FROM sector_totals;
INSERT INTO sector_totals (division, contracts, value_eur)
SELECT substr(t.cpv_code, 1, 2), COUNT(*), COALESCE(SUM(c.amount_eur), 0)
FROM contracts c JOIN tenders t ON t.id = c.tender_id
WHERE c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'') <> ''
GROUP BY substr(t.cpv_code, 1, 2);

-- ── 4b) facet_counts (procedure_type / EU; year is recomputed live by getContractFacets) ───────────
CREATE TABLE IF NOT EXISTS facet_counts (
  facet TEXT NOT NULL, key TEXT NOT NULL, contracts INTEGER NOT NULL, value_eur REAL NOT NULL,
  PRIMARY KEY (facet, key)
);
DELETE FROM facet_counts;
INSERT INTO facet_counts (facet, key, contracts, value_eur)
SELECT 'procedure', t.procedure_type, COUNT(*), COALESCE(SUM(c.amount_eur), 0)
FROM contracts c JOIN tenders t ON t.id = c.tender_id
GROUP BY t.procedure_type;
INSERT INTO facet_counts (facet, key, contracts, value_eur)
SELECT 'eu', CASE WHEN c.eu_funded = 1 THEN '1' ELSE '0' END, COUNT(*), COALESCE(SUM(c.amount_eur), 0)
FROM contracts c GROUP BY CASE WHEN c.eu_funded = 1 THEN '1' ELSE '0' END;

-- ── 5) flow_pairs (per authority → bidder) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flow_pairs (
  authority_id TEXT NOT NULL REFERENCES authorities(id), bidder_id TEXT NOT NULL REFERENCES bidders(id),
  authority_name TEXT NOT NULL, bidder_name TEXT NOT NULL, bidder_kind TEXT NOT NULL,
  won_eur REAL NOT NULL, contracts INTEGER NOT NULL, PRIMARY KEY (authority_id, bidder_id)
);
DELETE FROM flow_pairs;
INSERT INTO flow_pairs (authority_id, bidder_id, authority_name, bidder_name, bidder_kind, won_eur, contracts)
SELECT t.authority_id, c.bidder_id, a.name, b.name, b.kind, SUM(c.amount_eur), COUNT(*)
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
JOIN bidders b ON b.id = c.bidder_id
WHERE c.amount_eur IS NOT NULL
GROUP BY t.authority_id, c.bidder_id;

-- ── 6) search_index (FTS5; Cyrillic+Latin, accent/case-folded) ─────────────────────────────────────
-- ref stores the RAW domain id; the app maps it to a route slug. title/ident are searchable; the
-- rest are UNINDEXED display fields. Contracts indexed only when they carry a subject (else nothing
-- to match on by text — they are still reachable via the list/detail pages).
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  kind UNINDEXED, ref UNINDEXED, title, ident, subtitle UNINDEXED, amount UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2"
);
DELETE FROM search_index;
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'authority', at.authority_id, at.name, COALESCE(substr(at.authority_id, 6), ''),
  COALESCE(at.settlement, ''), at.spent_eur
FROM authority_totals at;
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'company', ct.bidder_id, ct.name, COALESCE(ct.eik, ''), COALESCE(ct.settlement, ''), ct.won_eur
FROM company_totals ct;
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'contract', c.id, COALESCE(NULLIF(c.contract_subject, ''), t.title),
  COALESCE(t.source_id, ''),
  a.name || ' → ' || b.name, c.amount_eur
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
JOIN bidders b ON b.id = c.bidder_id
WHERE COALESCE(NULLIF(c.contract_subject, ''), t.title) IS NOT NULL;
-- Свързани лица: one row per official with a PUBLISHED conflict link (private/family ownership), so a NAME
-- search reaches their /conflicts/official profile. ref = person_id (→ personSlug at read), title = name,
-- subtitle = latest declared institution (disambiguates homonyms), amount = total contract € of their
-- linked winners. Published-only inherits the surface's expiry — a withdrawn/left-office official drops out.
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'official', il.person_id, p.name, NULL,
  (SELECT d.institution FROM declarations d WHERE d.person_id = il.person_id
   ORDER BY d.declared_year DESC LIMIT 1),
  -- amount = the CONTEMPORANEOUS conflict-window € (contracts signed while the stake was declared), NOT the
  -- lifetime contract_value_eur. Same per-link subquery as LINK_SELECT.contemporaneous_value_eur in
  -- packages/db/src/queries/related-persons.ts, summed across the official's links, so the search headline
  -- matches the /conflicts surface and never credits an award signed outside the declared window.
  SUM((SELECT SUM(cc.amount_eur) FROM contracts cc
         JOIN tenders tt ON tt.id = cc.tender_id
         JOIN authorities aa ON aa.id = tt.authority_id
         JOIN bidders bb ON bb.id = cc.bidder_id
       WHERE bb.eik_normalized = il.eik
         AND il.first_declared_year IS NOT NULL AND il.last_declared_year IS NOT NULL
         AND cc.signed_at IS NOT NULL
         AND CAST(strftime('%Y', cc.signed_at) AS INTEGER)
             BETWEEN CAST(il.first_declared_year AS INTEGER) AND CAST(il.last_declared_year AS INTEGER)))
FROM interest_links il JOIN persons p ON p.id = il.person_id
WHERE il.status = 'published' AND il.interest_class IN ('private_ownership', 'family_ownership')
  -- Drop the redundant family link when a published self stake exists for the same official+winner, so an
  -- official who declared BOTH their own and a relative's stake in one company isn't counted twice in the
  -- „по договори" total (mirrors NOT_REDUNDANT_FAMILY in packages/db/src/queries/related-persons.ts).
  AND NOT (il.interest_class = 'family_ownership' AND EXISTS (
    SELECT 1 FROM interest_links s WHERE s.person_id = il.person_id AND s.eik = il.eik
      AND s.status = 'published' AND s.interest_class = 'private_ownership'))
GROUP BY il.person_id, p.name;

-- Summary (last result set printed by `wrangler d1 execute`)
SELECT
  (SELECT contracts FROM home_totals)        AS home_contracts,
  (SELECT ROUND(value_eur/1e9, 2) FROM home_totals) AS home_value_bn,
  (SELECT suspect FROM home_totals)          AS suspect,
  (SELECT COUNT(*) FROM company_totals)      AS company_rows,
  (SELECT COUNT(*) FROM authority_totals)    AS authority_rows,
  (SELECT COUNT(*) FROM sector_totals)       AS sector_rows,
  (SELECT COUNT(*) FROM flow_pairs)          AS flow_rows,
  (SELECT COUNT(*) FROM search_index)        AS search_rows,
  (SELECT COUNT(*) FROM contracts WHERE signing_value_eur IS NOT NULL) AS signing_eur_rows;
