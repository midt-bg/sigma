-- Sigma — daily refresh: derive the OCDS go-forward delta into the domain + refresh ONLY the
-- affected rollup/FTS rows. Run by apps/etl's RefreshWorkflow after the OCDS staging is upserted;
-- also runnable via sqlite3/wrangler for tests and manual catch-up.
--
-- SCOPED + IDEMPOTENT. It touches only OCDS-refresh-derived contracts (id 'c:o:%') and the rollup
-- rows of the entities they involve; the 190k admin-derived rows and unaffected rollups are left
-- alone. Dedup keeps it from double-counting a contract the admin base (or a prior full normalize)
-- already holds: an OCDS row is derived only when no NON-'c:o:%' contract shares its contract_number.
-- Re-running yields the same state (the 'c:o:%' wipe + re-derive is deterministic). A periodic full
-- normalize-egov.sql re-bases everything (it rebuilds all contracts as 'c:'||rowid), which a later
-- refresh then no-ops against. Mirrors normalize-egov.sql steps 1/2b/4/5 + precompute.sql, scoped.

-- The base-wins dedup probes contracts by АОП document number — index it (no-op if already present).
CREATE INDEX IF NOT EXISTS idx_contracts_cnum ON contracts(contract_number);

-- ── 1) Authorities referenced by OCDS staging (new ones only; INSERT OR IGNORE) ────────────────────
INSERT OR IGNORE INTO authorities (id, name, bulstat, type)
SELECT 'auth:' || authority_eik, MIN(authority_name), authority_eik, NULL
FROM raw_egov_contracts
WHERE source LIKE 'ocds:%' AND authority_eik IS NOT NULL
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
    CASE WHEN UPPER(contractor_name) LIKE '%ДЗЗД%' OR UPPER(contractor_name) LIKE '%ОБЕДИНЕНИЕ%' OR UPPER(contractor_name) LIKE '%КОНСОРЦИУМ%' THEN 1 ELSE 0 END AS grp
  FROM (
    SELECT contractor_name,
      TRIM(CASE WHEN contractor_eik LIKE 'ЕИК %' THEN SUBSTR(contractor_eik, 5) ELSE contractor_eik END) AS eik_clean
    FROM raw_egov_contracts WHERE source LIKE 'ocds:%'
  )
)
WHERE bidder_key IS NOT NULL
GROUP BY bidder_key;

-- ── 3) Synthetic 'неизвестна' tenders for OCDS УНП (ocid) — matches normalize step 2b ───────────────
INSERT OR IGNORE INTO tenders
  (id, source_id, title, authority_id, cpv_code, estimated_value, currency, procedure_type, contract_kind, status, legal_basis, award_criteria)
SELECT
  't:' || c.unp, c.unp, COALESCE(MIN(c.procurement_subject), '(без предмет)'),
  'auth:' || MIN(c.authority_eik), MIN(c.cpv_code), MIN(c.estimated_value),
  COALESCE(MIN(c.currency), 'BGN'), 'неизвестна', MIN(c.contract_kind), 'awarded', NULL, NULL
FROM raw_egov_contracts c
WHERE c.source LIKE 'ocds:%' AND c.unp IS NOT NULL
  AND EXISTS (SELECT 1 FROM authorities a WHERE a.id = 'auth:' || c.authority_eik)
GROUP BY c.unp;

-- ── 4) Contracts — wipe the refresh-derived set + re-derive the OCDS delta (admin/base wins) ─────────
DELETE FROM contracts WHERE id GLOB 'c:o:*';
INSERT OR IGNORE INTO contracts
  (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, signing_value, current_value,
   annex_count, eu_funded, bids_received, contract_kind, value_flag, amount_eur, fx_converted, fx_rate,
   signing_value_eur, current_value_eur, published_at, contract_subject)
SELECT
  'c:o:' || x.unp || ':' || x.contract_number,
  't:' || x.unp,
  x.bidder_key,
  COALESCE(x.current_value, x.signing_value),
  COALESCE(x.currency, 'BGN'),
  x.contract_date,
  x.contract_number,
  x.signing_value,
  x.current_value,
  0,
  x.eu_funded,
  x.bids_received,
  x.contract_kind,
  x.value_flag,
  x.amount_eur,
  CASE WHEN COALESCE(x.currency, 'BGN') NOT IN ('BGN', 'EUR') THEN 1 ELSE 0 END,
  x.fx_rate,
  CASE WHEN x.value_flag = 'value_suspect' THEN NULL ELSE x.amount_eur END,
  CASE WHEN x.value_flag IN ('value_suspect', 'annex_suspect') THEN NULL
       WHEN x.current_value IS NULL THEN NULL ELSE x.amount_eur END,
  x.published_at,
  x.contract_subject
FROM (
  SELECT y.*,
    -- fx: EUR as-is, BGN at the peg, foreign at the signing-date ECB rate (NULL if missing)
    CASE WHEN COALESCE(y.currency,'BGN') NOT IN ('BGN','EUR')
      THEN (SELECT f.eur_per_unit FROM fx_rates f WHERE f.base_currency = y.currency AND f.rate_date = y.contract_date)
      ELSE NULL END AS fx_rate,
    CASE
      WHEN y.value_flag = 'value_suspect' THEN NULL
      WHEN COALESCE(y.currency,'BGN') = 'EUR' THEN COALESCE(y.current_value, y.signing_value)
      WHEN COALESCE(y.currency,'BGN') = 'BGN' THEN COALESCE(y.current_value, y.signing_value) / 1.95583
      ELSE COALESCE(y.current_value, y.signing_value) * (SELECT f.eur_per_unit FROM fx_rates f WHERE f.base_currency = y.currency AND f.rate_date = y.contract_date)
    END AS amount_eur
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
  ) y
) x
WHERE x.bidder_key IS NOT NULL
  AND COALESCE(x.current_value, x.signing_value) IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || x.unp)
  AND EXISTS (SELECT 1 FROM bidders b WHERE b.id = x.bidder_key)
  -- base wins: skip if any non-refresh contract already represents this АОП document number
  AND NOT EXISTS (SELECT 1 FROM contracts c2 WHERE c2.contract_number = x.contract_number AND c2.id NOT GLOB 'c:o:*')
GROUP BY 'c:o:' || x.unp || ':' || x.contract_number;

-- ── 5) Refresh rollups + FTS for the AFFECTED entities only, then the small globals ─────────────────
-- Affected = entities involved in a refresh-derived ('c:o:%') contract. The two affected-sets are
-- inlined as subqueries (not TEMP tables) so the whole script runs as one D1 .batch() transaction.
DELETE FROM company_totals WHERE bidder_id IN (SELECT DISTINCT bidder_id FROM contracts WHERE id GLOB 'c:o:*');
INSERT INTO company_totals (bidder_id, name, kind, eik, eik_valid, settlement, won_eur, contracts, authorities, eu_eur, first_date, last_date)
SELECT b.id, b.name, b.kind, b.eik_normalized, b.eik_valid, b.settlement,
  SUM(c.amount_eur), COUNT(*), COUNT(DISTINCT t.authority_id),
  SUM(CASE WHEN c.eu_funded = 1 THEN c.amount_eur ELSE 0 END), MIN(c.signed_at), MAX(c.signed_at)
FROM contracts c JOIN bidders b ON b.id = c.bidder_id JOIN tenders t ON t.id = c.tender_id
WHERE c.amount_eur IS NOT NULL AND c.bidder_id IN (SELECT DISTINCT bidder_id FROM contracts WHERE id GLOB 'c:o:*')
GROUP BY b.id;
UPDATE company_totals SET primary_sector = (
  SELECT substr(t.cpv_code, 1, 2) FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE c.bidder_id = company_totals.bidder_id AND c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'') <> ''
  GROUP BY substr(t.cpv_code, 1, 2) ORDER BY SUM(c.amount_eur) DESC, substr(t.cpv_code, 1, 2) LIMIT 1)
WHERE bidder_id IN (SELECT DISTINCT bidder_id FROM contracts WHERE id GLOB 'c:o:*');

DELETE FROM authority_totals WHERE authority_id IN (SELECT DISTINCT t2.authority_id FROM contracts c2 JOIN tenders t2 ON t2.id = c2.tender_id WHERE c2.id GLOB 'c:o:*');
INSERT INTO authority_totals (authority_id, name, type_group, settlement, region, spent_eur, contracts, suppliers, avg_eur, eu_eur, first_date, last_date)
SELECT a.id, a.name, a.type_group, a.settlement, a.region,
  SUM(c.amount_eur), COUNT(*), COUNT(DISTINCT c.bidder_id), SUM(c.amount_eur) / COUNT(*),
  SUM(CASE WHEN c.eu_funded = 1 THEN c.amount_eur ELSE 0 END), MIN(c.signed_at), MAX(c.signed_at)
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
WHERE c.amount_eur IS NOT NULL AND t.authority_id IN (SELECT DISTINCT t2.authority_id FROM contracts c2 JOIN tenders t2 ON t2.id = c2.tender_id WHERE c2.id GLOB 'c:o:*')
GROUP BY a.id;
UPDATE authority_totals SET primary_sector = (
  SELECT substr(t.cpv_code, 1, 2) FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE t.authority_id = authority_totals.authority_id AND c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'') <> ''
  GROUP BY substr(t.cpv_code, 1, 2) ORDER BY SUM(c.amount_eur) DESC, substr(t.cpv_code, 1, 2) LIMIT 1)
WHERE authority_id IN (SELECT DISTINCT t2.authority_id FROM contracts c2 JOIN tenders t2 ON t2.id = c2.tender_id WHERE c2.id GLOB 'c:o:*');

-- flow_pairs for affected authorities (rebuild every pair of an affected authority — bounded)
DELETE FROM flow_pairs WHERE authority_id IN (SELECT DISTINCT t2.authority_id FROM contracts c2 JOIN tenders t2 ON t2.id = c2.tender_id WHERE c2.id GLOB 'c:o:*');
INSERT INTO flow_pairs (authority_id, bidder_id, authority_name, bidder_name, bidder_kind, won_eur, contracts)
SELECT t.authority_id, c.bidder_id, a.name, b.name, b.kind, SUM(c.amount_eur), COUNT(*)
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id JOIN bidders b ON b.id = c.bidder_id
WHERE c.amount_eur IS NOT NULL AND t.authority_id IN (SELECT DISTINCT t2.authority_id FROM contracts c2 JOIN tenders t2 ON t2.id = c2.tender_id WHERE c2.id GLOB 'c:o:*')
GROUP BY t.authority_id, c.bidder_id;

-- search_index rows for affected entities (companies + authorities)
DELETE FROM search_index WHERE kind = 'company' AND ref IN (SELECT DISTINCT bidder_id FROM contracts WHERE id GLOB 'c:o:*');
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'company', ct.bidder_id, ct.name, COALESCE(ct.eik, ''), COALESCE(ct.settlement, ''), ct.won_eur
FROM company_totals ct WHERE ct.bidder_id IN (SELECT DISTINCT bidder_id FROM contracts WHERE id GLOB 'c:o:*');
DELETE FROM search_index WHERE kind = 'authority' AND ref IN (SELECT DISTINCT t2.authority_id FROM contracts c2 JOIN tenders t2 ON t2.id = c2.tender_id WHERE c2.id GLOB 'c:o:*');
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'authority', at.authority_id, at.name, COALESCE(substr(at.authority_id, 6), ''), COALESCE(at.settlement, ''), at.spent_eur
FROM authority_totals at WHERE at.authority_id IN (SELECT DISTINCT t2.authority_id FROM contracts c2 JOIN tenders t2 ON t2.id = c2.tender_id WHERE c2.id GLOB 'c:o:*');
-- contract search rows for the refresh-derived contracts
DELETE FROM search_index WHERE kind = 'contract' AND ref GLOB 'c:o:*';
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'contract', c.id, COALESCE(NULLIF(c.contract_subject, ''), t.title), COALESCE(t.source_id, ''),
  a.name || ' → ' || b.name, c.amount_eur
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id JOIN bidders b ON b.id = c.bidder_id
WHERE c.id GLOB 'c:o:*' AND COALESCE(NULLIF(c.contract_subject, ''), t.title) IS NOT NULL;

-- Small global rollups — recomputed in full (one-row / 45-row / 7-row results; cheap per refresh).
DELETE FROM home_totals;
INSERT INTO home_totals (id, contracts, value_eur, authorities, bidders, suspect, first_date, last_date, as_of, refreshed_at)
SELECT 1,
  (SELECT COUNT(*) FROM contracts),
  (SELECT COALESCE(SUM(amount_eur), 0) FROM contracts),
  (SELECT COUNT(*) FROM authorities),
  (SELECT COUNT(*) FROM bidders),
  (SELECT COUNT(*) FROM contracts WHERE amount_eur IS NULL),
  (SELECT MIN(signed_at) FROM contracts WHERE signed_at >= '2020-01-01' AND signed_at <= date('now')),
  (SELECT MAX(signed_at) FROM contracts WHERE signed_at <= date('now')),
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
SELECT 'year', substr(c.signed_at, 1, 4), COUNT(*), COALESCE(SUM(c.amount_eur), 0)
FROM contracts c WHERE c.signed_at >= '2020-01-01' AND c.signed_at < '2027-01-01' GROUP BY substr(c.signed_at, 1, 4);
INSERT INTO facet_counts (facet, key, contracts, value_eur)
SELECT 'procedure', t.procedure_type, COUNT(*), COALESCE(SUM(c.amount_eur), 0)
FROM contracts c JOIN tenders t ON t.id = c.tender_id GROUP BY t.procedure_type;
INSERT INTO facet_counts (facet, key, contracts, value_eur)
SELECT 'eu', CASE WHEN c.eu_funded = 1 THEN '1' ELSE '0' END, COUNT(*), COALESCE(SUM(c.amount_eur), 0)
FROM contracts c GROUP BY CASE WHEN c.eu_funded = 1 THEN '1' ELSE '0' END;

