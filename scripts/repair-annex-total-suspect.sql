-- Served-D1 repair: an annex_total_suspect contract sums at its SIGNING value, never at the doubled current
-- value its annex announced (#305; docs/etl.md flag table). normalize-raw.sql and refresh-slice.sql derive
-- it that way, but the one-time 0002 currency backfill (backfill-current-value-currency.sql, before its
-- fix) predates the flag and wrote COALESCE(current_value, signing_value) into amount_eur for every flag
-- but value_suspect/annex_suspect. A row the refresh never re-valued since then still carries the doubled
-- value in every total that sums amount_eur.
--
-- The expected value is refresh-slice.sql's served-table form of normalize-raw.sql's expression
-- (`@refresh-batch amendments`, the recalculated amount_eur): the signing value in the contract's own
-- currency, or — with no signing value — the current value in the winning amendment's currency
-- (current_value_currency), then EUR as-is, BGN at the peg, anything else at the row's fx_rate.
--
-- IDEMPOTENT and safe on every deploy: only a row whose amount_eur differs from that value by half a cent
-- or more is written, so a second run changes nothing. Each repaired contract, its bidder and its
-- authorities (lead and joint) go into the refresh's durable touched sets, so the next ordinary refresh
-- recomputes their company_totals / authority_totals and the contract search amounts (it runs its derive
-- while any touched row is pending — pendingTouchedRows), and rebuilds the corpus-wide rollups it always
-- rebuilds (home_totals, sector_totals, facet_counts, flow_pairs, contract_rollup) from the repaired
-- amounts. One file is one D1 transaction: the repair and its touched ids land together or not at all.

CREATE TABLE IF NOT EXISTS refresh_touched_contracts (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS refresh_touched_bidders (bidder_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS refresh_touched_authorities (authority_id TEXT PRIMARY KEY);

DROP TABLE IF EXISTS repair_annex_total_suspect;
CREATE TABLE repair_annex_total_suspect AS
WITH basis AS (
  SELECT id, amount_eur, fx_rate,
    COALESCE(signing_value, current_value) AS trusted_native,
    CASE
      WHEN signing_value IS NOT NULL THEN COALESCE(NULLIF(currency, ''), 'BGN')
      ELSE COALESCE(NULLIF(current_value_currency, ''), NULLIF(currency, ''), 'BGN')
    END AS trusted_currency
  FROM contracts
  WHERE value_flag = 'annex_total_suspect'
), expected AS (
  SELECT id, amount_eur,
    CASE
      WHEN trusted_native IS NULL THEN NULL
      WHEN trusted_currency = 'EUR' THEN trusted_native
      WHEN trusted_currency = 'BGN' THEN trusted_native / 1.95583
      WHEN fx_rate IS NOT NULL THEN trusted_native * fx_rate
      ELSE NULL
    END AS amount_eur_expected
  FROM basis
)
SELECT id, amount_eur_expected
FROM expected
WHERE (amount_eur IS NULL) <> (amount_eur_expected IS NULL)
   OR abs(amount_eur - amount_eur_expected) >= 0.005;

INSERT OR IGNORE INTO refresh_touched_contracts (id)
SELECT id FROM repair_annex_total_suspect;
INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT DISTINCT c.bidder_id
FROM contracts c
WHERE c.id IN (SELECT id FROM repair_annex_total_suspect)
  AND c.bidder_id IS NOT NULL;
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT DISTINCT t.authority_id
FROM contracts c JOIN tenders t ON t.id = c.tender_id
WHERE c.id IN (SELECT id FROM repair_annex_total_suspect)
  AND t.authority_id IS NOT NULL;
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT DISTINCT ca.authority_id
FROM contract_co_authorities ca
WHERE ca.contract_id IN (SELECT id FROM repair_annex_total_suspect);

UPDATE contracts
SET amount_eur = r.amount_eur_expected
FROM repair_annex_total_suspect r
WHERE r.id = contracts.id;

DROP TABLE repair_annex_total_suspect;
