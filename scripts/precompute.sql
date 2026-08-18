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
-- CANONICAL VALUE BASE: every money rollup sums rows where amount_eur IS NOT NULL, regardless of
-- value_flag. That includes review, annex_suspect, value_low and repaired value_suspect rows. Only a
-- row without a usable EUR value is excluded. The suspect KPI separately counts value_suspect rows;
-- home/list CORPUS counts use COUNT(*) and may therefore cover a broader row set than their sum.

-- ── 0) Per-contract EUR value timeline ────────────────────────────────────────────────────────
-- signing/current in EUR for the contract page's estimated→signing→current strip.
-- BGN at the fixed peg (÷1.95583), EUR as-is, foreign at the row's stored fx_rate (eur_per_unit).
-- Display rule: NULL where the figure is suspect, so the caller renders „данните се преглеждат",
-- never a fabricated number. signing suppressed for value_suspect; current suppressed for value_,
-- annex_suspect or annex_total_suspect (#305; the suspect annex is the bad part). estimated_value_eur
-- is derived per-request on
-- the contract detail loader from the tender (procurement-level, shared across a multi-lot prepiska).
UPDATE contracts SET
  signing_value_eur = CASE
    WHEN value_flag = 'value_suspect' OR signing_value IS NULL THEN NULL
    WHEN COALESCE(currency,'BGN') = 'EUR' THEN signing_value
    WHEN COALESCE(currency,'BGN') = 'BGN' THEN signing_value / 1.95583
    WHEN fx_rate IS NOT NULL THEN signing_value * fx_rate
    ELSE NULL END,
  current_value_eur = CASE
    WHEN value_flag IN ('value_suspect','annex_suspect','annex_total_suspect') OR current_value IS NULL THEN NULL
    WHEN COALESCE(NULLIF(current_value_currency, ''), NULLIF(currency, ''), 'BGN') = 'EUR' THEN current_value
    WHEN COALESCE(NULLIF(current_value_currency, ''), NULLIF(currency, ''), 'BGN') = 'BGN' THEN current_value / 1.95583
    WHEN fx_rate IS NOT NULL THEN current_value * fx_rate
    ELSE NULL END;

-- ── 1) home_totals shell (filled after company/authority rollups exist) ──────────────────────────
CREATE TABLE IF NOT EXISTS home_totals (
  id INTEGER PRIMARY KEY CHECK (id = 1), contracts INTEGER NOT NULL, value_eur REAL NOT NULL,
  authorities INTEGER NOT NULL, bidders INTEGER NOT NULL, suspect INTEGER NOT NULL,
  first_date TEXT, last_date TEXT, as_of TEXT, refreshed_at TEXT NOT NULL
);
DELETE FROM home_totals;

-- ── 2) company_totals (per bidder; canonical non-NULL amount_eur base) ────────────────────────────
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
-- Spend and the ordinary contract count remain lead-only, preserving the reconciliation invariant:
-- SUM(authority_totals.spent_eur) = the tender-authority-attributed contract sum.
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

-- Separate participation metrics. They count every joint-contract bridge association, including
-- the lead; the value is informational only and never feeds authority_totals or any national total.
CREATE TABLE IF NOT EXISTS authority_joint_participation (
  authority_id TEXT PRIMARY KEY REFERENCES authorities(id),
  joint_contract_participations INTEGER NOT NULL,
  joint_contract_value_eur REAL NOT NULL DEFAULT 0
);
DELETE FROM authority_joint_participation;
INSERT INTO authority_joint_participation
  (authority_id, joint_contract_participations, joint_contract_value_eur)
SELECT cca.authority_id, COUNT(*), COALESCE(SUM(c.amount_eur), 0)
FROM contract_co_authorities cca
JOIN contracts c ON c.id = cca.contract_id
GROUP BY cca.authority_id;

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

-- ── 4c) cpv_division_stats (value percentiles per CPV division - „Подобни договори" benchmark) ──
-- Nearest-rank percentiles (k = ceil(q*n), emulated as CAST(n*q + 0.9999999 AS INTEGER) because
-- SQLite lacks ceil()) over the clean-value cohort: value_flag = 'ok', amount_eur > 0, known CPV.
-- The contract page reads ONE row here instead of scanning its whole division per view (D1 meters
-- rows read). The cohort includes the candidate itself - the shown band is display context and is
-- deliberately coarse, unlike scripts/anomaly-report.mjs which needs leave-one-out p95 for flagging.
CREATE TABLE IF NOT EXISTS cpv_division_stats (
  division TEXT PRIMARY KEY, priced_contracts INTEGER NOT NULL,
  p25_eur REAL NOT NULL, median_eur REAL NOT NULL, p75_eur REAL NOT NULL,
  p90_eur REAL NOT NULL, p95_eur REAL NOT NULL, p99_eur REAL NOT NULL
);
DELETE FROM cpv_division_stats;
INSERT INTO cpv_division_stats (division, priced_contracts, p25_eur, median_eur, p75_eur, p90_eur, p95_eur, p99_eur)
SELECT division, MAX(cnt),
       MAX(CASE WHEN rn = CAST(cnt * 0.25 + 0.9999999 AS INTEGER) THEN amount_eur END),
       MAX(CASE WHEN rn = CAST(cnt * 0.50 + 0.9999999 AS INTEGER) THEN amount_eur END),
       MAX(CASE WHEN rn = CAST(cnt * 0.75 + 0.9999999 AS INTEGER) THEN amount_eur END),
       MAX(CASE WHEN rn = CAST(cnt * 0.90 + 0.9999999 AS INTEGER) THEN amount_eur END),
       MAX(CASE WHEN rn = CAST(cnt * 0.95 + 0.9999999 AS INTEGER) THEN amount_eur END),
       MAX(CASE WHEN rn = CAST(cnt * 0.99 + 0.9999999 AS INTEGER) THEN amount_eur END)
FROM (
  SELECT substr(t.cpv_code, 1, 2) AS division, c.amount_eur,
         ROW_NUMBER() OVER (PARTITION BY substr(t.cpv_code, 1, 2) ORDER BY c.amount_eur, c.id) AS rn,
         COUNT(*)     OVER (PARTITION BY substr(t.cpv_code, 1, 2)) AS cnt
  FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE c.amount_eur IS NOT NULL AND c.amount_eur > 0 AND c.value_flag = 'ok'
    AND COALESCE(t.cpv_code, '') <> ''
)
GROUP BY division;

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
FROM company_totals ct
WHERE ct.bidder_id <> 'unknown:анонимен';
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'contract', c.id, COALESCE(NULLIF(c.contract_subject, ''), t.title),
  COALESCE(t.source_id, ''),
  a.name || ' → ' || b.name, c.amount_eur
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
JOIN bidders b ON b.id = c.bidder_id
WHERE COALESCE(NULLIF(c.contract_subject, ''), t.title) IS NOT NULL;
-- Свързани лица: one row per official with a PUBLISHED ownership conflict link — self OR a relative's stake
-- (ADR-0032) — so a NAME search reaches their /conflicts/official profile. ref = person_id (→ personSlug at
-- read), title = name, subtitle = latest declared institution (disambiguates homonyms), amount = contract €
-- of their linked winners, each winner counted once. Published-only inherits the surface's expiry — a
-- withdrawn/left-office official drops out.
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'official', il.person_id, p.name, NULL,
  (SELECT d.institution FROM declarations d WHERE d.person_id = il.person_id
   ORDER BY d.declared_year DESC LIMIT 1),
  -- amount = the CONTEMPORANEOUS conflict-window € (contracts signed while the stake was declared), the same
  -- per-link subquery as LINK_SELECT.contemporaneous_value_eur, summed across the official's SURFACED links.
  -- The redundant-family collapse (WHERE below) leaves at most one link per (official, ЕИК), so no winner's €
  -- is double-counted. family_ownership reaches the index identically to self (ADR-0032) — the office-holder
  -- is searchable, the relative never named. Never the lifetime total.
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
-- Self OR family stake (ADR-0032). Two guards mirror the /conflicts read layer (related-persons.ts):
--  (N9) index only a link whose winner has LIVE contracts, so a stale-zero-contract link never becomes a dead
--       search hit that 404s on click;
--  (collapse) drop a family link when the SAME official already has a published OWN stake in that winner —
--       rendering both re-identifies the relative via a ТР owner lookup, and the company is already surfaced
--       by the self row.
WHERE il.status = 'published' AND il.interest_class IN ('private_ownership', 'family_ownership')
  -- …and the identity rests on a Trade Register fact (#279, ADR-0033). This predicate is the THIRD copy
  -- of the surface gate — the other two are SURFACED_OWNERSHIP in packages/db/src/queries/related-persons.ts
  -- and the sibling block in the other of precompute.sql / refresh-slice.sql. All three must move
  -- together: this one feeds the officials search index, so omitting it would keep officials findable
  -- whose links no longer surface.
  AND EXISTS (SELECT 1 FROM interest_link_evidence e
              WHERE e.link_key = il.link_key AND e.evidence_kind IN ('document','confirmed'))
  AND EXISTS (SELECT 1 FROM contracts cc JOIN bidders bb ON bb.id = cc.bidder_id
              WHERE bb.eik_normalized = il.eik)
  AND NOT (il.interest_class = 'family_ownership' AND EXISTS (
    SELECT 1 FROM interest_links s
    WHERE s.person_id = il.person_id AND s.eik = il.eik
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
