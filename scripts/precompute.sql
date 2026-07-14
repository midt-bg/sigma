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

-- ── 7) Anomaly screen: cpv_price_stats + contract_anomalies ─────────────────────────────────────
-- Automated red-flag indicators over the clean corpus (value_flag = 'ok', amount_eur > 0). A row in
-- contract_anomalies means at least one PRICE signal fired; signals are indicators for public
-- scrutiny, never verdicts. Methodology (mirrored on /methodology):
--   • over_estimate  — signing value ≥ +10% above the authority's OWN pre-tender estimate. Compared
--     only when the estimate covers exactly this award: lot-level estimate for lot-scoped awards,
--     tender estimate for single-lot tenders; framework/DPS call-offs (more awards than lots — the
--     estimate is the whole ceiling, cf. details.ts frameworkAwards) are excluded, as are estimates
--     under €1k and signed values under €10k (noise floors). BGN/EUR only (foreign-currency
--     estimates have no stored rate).
--   • annex_growth   — current (post-annex) value ≥ +20% over the signing value, annexed rows only.
--     ЗОП чл. 116 caps most modifications at +10/50%, so ≥1.5 is scored higher.
--   • price_outlier  — contract value ≥ 5× the median of ≥10 clean contracts sharing the same FULL
--     CPV code, and ≥ €50k. A scope-vs-price proxy (a bigger buy is not a worse price), hence the
--     softest weight; the median + peer count are stored so every ratio is inspectable.
--   • single_bid / no_notice — competition context (one offer in a competitive procedure / a
--     direct no-notice procedure). Context only: they add score but never create a row.
-- Score = over_estimate 25/35/45 (≥1.1/1.5/3×) + annex_growth 20/30 (≥1.2/1.5×) +
--         price_outlier 15/25 (≥5/10×) + single_bid 10 + no_notice 5, capped at 100.

CREATE TABLE IF NOT EXISTS cpv_price_stats (
  cpv_code TEXT PRIMARY KEY, peers INTEGER NOT NULL, median_eur REAL NOT NULL
);
DELETE FROM cpv_price_stats;
INSERT INTO cpv_price_stats (cpv_code, peers, median_eur)
SELECT cpv, MAX(n), AVG(eur) FROM (
  SELECT t.cpv_code AS cpv, c.amount_eur AS eur,
         ROW_NUMBER() OVER (PARTITION BY t.cpv_code ORDER BY c.amount_eur) AS rn,
         COUNT(*) OVER (PARTITION BY t.cpv_code) AS n
  FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE c.value_flag = 'ok' AND c.amount_eur > 0 AND COALESCE(t.cpv_code, '') <> ''
)
WHERE rn IN ((n + 1) / 2, (n + 2) / 2)
GROUP BY cpv;

CREATE TABLE IF NOT EXISTS contract_anomalies (
  contract_id TEXT PRIMARY KEY REFERENCES contracts(id),
  score INTEGER NOT NULL, rank_value REAL NOT NULL,
  flag_over_estimate INTEGER NOT NULL DEFAULT 0, flag_annex_growth INTEGER NOT NULL DEFAULT 0,
  flag_price_outlier INTEGER NOT NULL DEFAULT 0, flag_single_bid INTEGER NOT NULL DEFAULT 0,
  flag_no_notice INTEGER NOT NULL DEFAULT 0,
  over_estimate_ratio REAL, estimated_eur REAL, annex_growth_ratio REAL,
  price_ratio REAL, peer_median_eur REAL, peer_count INTEGER,
  amount_eur REAL NOT NULL, signed_at TEXT, cpv_division TEXT,
  authority_id TEXT NOT NULL, bidder_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anomalies_rank ON contract_anomalies(rank_value DESC);
CREATE INDEX IF NOT EXISTS idx_anomalies_amount ON contract_anomalies(amount_eur);
CREATE INDEX IF NOT EXISTS idx_anomalies_signed ON contract_anomalies(signed_at);
CREATE INDEX IF NOT EXISTS idx_anomalies_authority ON contract_anomalies(authority_id);
CREATE INDEX IF NOT EXISTS idx_anomalies_bidder ON contract_anomalies(bidder_id);
DELETE FROM contract_anomalies;
INSERT INTO contract_anomalies (
  contract_id, score, rank_value,
  flag_over_estimate, flag_annex_growth, flag_price_outlier, flag_single_bid, flag_no_notice,
  over_estimate_ratio, estimated_eur, annex_growth_ratio, price_ratio, peer_median_eur, peer_count,
  amount_eur, signed_at, cpv_division, authority_id, bidder_id)
SELECT
  id,
  MIN(100,
      CASE WHEN flag_over = 1 THEN CASE WHEN over_ratio >= 3 THEN 45 WHEN over_ratio >= 1.5 THEN 35 ELSE 25 END ELSE 0 END
    + CASE WHEN flag_annex = 1 THEN CASE WHEN growth >= 1.5 THEN 30 ELSE 20 END ELSE 0 END
    + CASE WHEN flag_outlier = 1 THEN CASE WHEN ratio >= 10 THEN 25 ELSE 15 END ELSE 0 END
    + CASE WHEN single_bid = 1 THEN 10 ELSE 0 END
    + CASE WHEN no_notice = 1 THEN 5 ELSE 0 END) AS score,
  MIN(100,
      CASE WHEN flag_over = 1 THEN CASE WHEN over_ratio >= 3 THEN 45 WHEN over_ratio >= 1.5 THEN 35 ELSE 25 END ELSE 0 END
    + CASE WHEN flag_annex = 1 THEN CASE WHEN growth >= 1.5 THEN 30 ELSE 20 END ELSE 0 END
    + CASE WHEN flag_outlier = 1 THEN CASE WHEN ratio >= 10 THEN 25 ELSE 15 END ELSE 0 END
    + CASE WHEN single_bid = 1 THEN 10 ELSE 0 END
    + CASE WHEN no_notice = 1 THEN 5 ELSE 0 END) * 1e12 + amount_eur AS rank_value,
  flag_over, flag_annex, flag_outlier, single_bid, no_notice,
  over_ratio, est_eur, growth, ratio, median_eur, peers,
  amount_eur, signed_at, cpv_division, authority_id, bidder_id
FROM (
  SELECT x.*,
    CASE WHEN x.est_eur >= 1000 AND x.paid_eur >= 10000 AND x.paid_eur / x.est_eur >= 1.10 THEN 1 ELSE 0 END AS flag_over,
    CASE WHEN x.est_eur > 0 THEN x.paid_eur / x.est_eur END AS over_ratio,
    CASE WHEN x.growth >= 1.20 THEN 1 ELSE 0 END AS flag_annex,
    CASE WHEN x.ratio >= 5 AND x.amount_eur >= 50000 THEN 1 ELSE 0 END AS flag_outlier
  FROM (
    SELECT c.id, c.amount_eur, c.signed_at,
      substr(t.cpv_code, 1, 2) AS cpv_division, t.authority_id, c.bidder_id,
      COALESCE(c.signing_value_eur, c.amount_eur) AS paid_eur,
      -- The comparable estimate: only when it covers exactly this award (see header note).
      CASE WHEN aw.n <= MAX(COALESCE(t.num_lots, 0), 1) THEN
        CASE
          WHEN c.lot_id IS NOT NULL AND l.estimated_value > 0
               AND COALESCE(l.value_currency, t.currency, 'BGN') IN ('BGN', 'EUR')
            THEN CASE WHEN COALESCE(l.value_currency, t.currency, 'BGN') = 'EUR'
                      THEN l.estimated_value ELSE l.estimated_value / 1.95583 END
          WHEN c.lot_id IS NULL AND COALESCE(t.num_lots, 1) <= 1 AND t.estimated_value > 0
               AND COALESCE(t.currency, 'BGN') IN ('BGN', 'EUR')
            THEN CASE WHEN COALESCE(t.currency, 'BGN') = 'EUR'
                      THEN t.estimated_value ELSE t.estimated_value / 1.95583 END
        END
      END AS est_eur,
      CASE WHEN c.annex_count > 0 AND c.signing_value_eur > 0 AND c.current_value_eur > 0
           THEN c.current_value_eur / c.signing_value_eur END AS growth,
      CASE WHEN ps.peers >= 10 AND ps.median_eur > 0 THEN c.amount_eur / ps.median_eur END AS ratio,
      ps.median_eur, ps.peers,
      CASE WHEN c.bids_received = 1 AND t.procedure_type IN (
        'Открита процедура', 'Ограничена процедура', 'Ограничена процедура по ДСП',
        'Ограничена процедура по КС', 'Публично състезание', 'Състезателна процедура с договаряне',
        'Събиране на оферти с обява') THEN 1 ELSE 0 END AS single_bid,
      CASE WHEN t.procedure_type IN (
        'Договаряне без предварително обявление', 'Пряко договаряне',
        'Договаряне без предварителна покана за участие',
        'Договаряне без публикуване на обявление за поръчка') THEN 1 ELSE 0 END AS no_notice
    FROM contracts c
    JOIN tenders t ON t.id = c.tender_id
    LEFT JOIN lots l ON l.id = c.lot_id
    LEFT JOIN cpv_price_stats ps ON ps.cpv_code = t.cpv_code
    LEFT JOIN (SELECT tender_id, COUNT(*) AS n FROM contracts GROUP BY tender_id) aw
      ON aw.tender_id = c.tender_id
    WHERE c.value_flag = 'ok' AND c.amount_eur > 0
  ) x
)
WHERE flag_over = 1 OR flag_annex = 1 OR flag_outlier = 1;

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
  (SELECT COUNT(*) FROM contracts WHERE signing_value_eur IS NOT NULL) AS signing_eur_rows,
  (SELECT COUNT(*) FROM cpv_price_stats)     AS cpv_stat_rows,
  (SELECT COUNT(*) FROM contract_anomalies)  AS anomaly_rows;
