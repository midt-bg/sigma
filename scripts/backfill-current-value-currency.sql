-- One-time served-D1 repair for 0002_current_value_currency.sql.
--
-- The column is NULL immediately after ALTER TABLE, so derive the same winning amendment used by
-- refresh-slice.sql (latest published_at, deterministic natural-key id tiebreak), then recompute the
-- canonical amount and detail-page current value. scripts/precompute.sql runs immediately after this
-- file in deploy.yml to rebuild every rollup and search_index amount from the repaired amount_eur.
WITH paired AS (
  SELECT
    c.*,
    CASE WHEN c.current_value IS NOT NULL THEN COALESCE((
      SELECT NULLIF(a.currency, '')
      FROM amendments a
      WHERE a.unp = substr(c.tender_id, 3)
        AND a.contract_number = c.contract_number
        AND a.value_after IS NOT NULL
      ORDER BY a.published_at DESC, a.id DESC
      LIMIT 1
    ), NULLIF(c.currency, ''), 'BGN')
    ELSE COALESCE(NULLIF(c.currency, ''), 'BGN')
    END AS derived_current_currency
  FROM contracts c
), selected AS (
  SELECT
    p.*,
    CASE p.value_flag
      WHEN 'value_suspect' THEN NULL
      WHEN 'annex_suspect' THEN COALESCE(p.signing_value, p.current_value)
      ELSE COALESCE(p.current_value, p.signing_value)
    END AS trusted_native,
    CASE p.value_flag
      WHEN 'value_suspect' THEN NULL
      WHEN 'annex_suspect' THEN CASE
        WHEN p.signing_value IS NOT NULL THEN COALESCE(NULLIF(p.currency, ''), 'BGN')
        ELSE p.derived_current_currency
      END
      ELSE CASE
        WHEN p.current_value IS NOT NULL THEN p.derived_current_currency
        ELSE COALESCE(NULLIF(p.currency, ''), 'BGN')
      END
    END AS trusted_currency
  FROM paired p
), repaired AS (
  SELECT
    id,
    derived_current_currency,
    CASE
      -- value_suspect is repaired from the procedure estimate upstream; do not replace that repair.
      WHEN value_flag = 'value_suspect' THEN amount_eur
      WHEN trusted_native IS NULL THEN NULL
      WHEN trusted_currency = 'EUR' THEN trusted_native
      WHEN trusted_currency = 'BGN' THEN trusted_native / 1.95583
      WHEN fx_rate IS NOT NULL THEN trusted_native * fx_rate
      ELSE NULL
    END AS repaired_amount_eur,
    CASE
      WHEN value_flag IN ('value_suspect', 'annex_suspect') OR current_value IS NULL THEN NULL
      WHEN derived_current_currency = 'EUR' THEN current_value
      WHEN derived_current_currency = 'BGN' THEN current_value / 1.95583
      WHEN fx_rate IS NOT NULL THEN current_value * fx_rate
      ELSE NULL
    END AS repaired_current_value_eur
  FROM selected
)
UPDATE contracts
SET
  current_value_currency = repaired.derived_current_currency,
  amount_eur = repaired.repaired_amount_eur,
  current_value_eur = repaired.repaired_current_value_eur
FROM repaired
WHERE repaired.id = contracts.id;

SELECT
  (SELECT COUNT(*) FROM contracts WHERE current_value_currency IS NOT NULL) AS currency_rows,
  (SELECT COUNT(*) FROM contracts
    WHERE value_flag = 'ok' AND current_value IS NOT NULL
      AND (amount_eur IS NULL OR current_value_eur IS NULL
        OR ABS(amount_eur - current_value_eur) > 0.01)) AS parity_mismatches;
