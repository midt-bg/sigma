-- Sigma — roll raw_egov_amendments up onto raw_egov_contracts.
-- Run AFTER scripts/load-admin.mjs (admin amendments) and scripts/load-ocds.mjs (OCDS amendments).
-- Re-runnable: resets the rollup, then matches amendments by (unp, contract_number).
-- current_value = the after-value of the LATEST amendment; annex_count = how many.
-- Contracts without amendments keep annex_count = 0 and current_value = NULL (the
-- convention downstream is COALESCE(current_value, signing_value)).

UPDATE raw_egov_contracts SET annex_count = 0, current_value = NULL;

WITH keyed AS (
  SELECT
    *,
    'am:' || COALESCE(unp, '') || ':' || COALESCE(contract_number, '') || ':' ||
      COALESCE(
        NULLIF(document_number, ''),
        NULLIF(correction_number, ''),
        NULLIF(seq_no, ''),
        'content:' || COALESCE(published_at, '') || ':' ||
          COALESCE(CAST(value_before AS TEXT), '') || ':' ||
          COALESCE(CAST(value_after AS TEXT), '') || ':' ||
          COALESCE(CAST(value_delta AS TEXT), '') || ':' ||
          COALESCE(currency, '') || ':' ||
          COALESCE(description, '')
      ) AS natural_key
  FROM raw_egov_amendments
), dedup AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY natural_key
      ORDER BY source DESC, id DESC
    ) AS rn
  FROM keyed
)
UPDATE raw_egov_contracts
SET
  annex_count = (
    SELECT COUNT(*) FROM dedup a
    WHERE a.unp = raw_egov_contracts.unp
      AND a.contract_number = raw_egov_contracts.contract_number
      AND a.rn = 1
  ),
  current_value = (
    SELECT a.value_after FROM dedup a
    WHERE a.unp = raw_egov_contracts.unp
      AND a.contract_number = raw_egov_contracts.contract_number
      AND a.value_after IS NOT NULL
      AND a.rn = 1
    ORDER BY a.published_at DESC, a.natural_key DESC
    LIMIT 1
  )
WHERE EXISTS (
  SELECT 1 FROM dedup a
  WHERE a.unp = raw_egov_contracts.unp
    AND a.contract_number = raw_egov_contracts.contract_number
    AND a.rn = 1
);

-- Summary (printed by wrangler)
SELECT
  (SELECT COUNT(*) FROM raw_egov_amendments)                              AS amendments,
  (SELECT COUNT(*) FROM raw_egov_contracts WHERE annex_count > 0)         AS contracts_amended,
  (SELECT COUNT(*) FROM raw_egov_contracts WHERE current_value IS NOT NULL) AS with_current_value,
  (SELECT COUNT(*) FROM raw_egov_contracts
     WHERE current_value IS NOT NULL AND current_value > signing_value)   AS grew_in_value;
