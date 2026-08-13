-- Promote work-DB staging amendments into the served domain table.
-- Backfill deliberately keeps derive-amendments.sql as the source for
-- contracts.current_value and contracts.annex_count before normalize, because
-- value_flag depends on that legacy staging rollup. The live refresh path will
-- switch contracts to the served amendments rollup in the next phase.

DELETE FROM amendments;

INSERT OR REPLACE INTO amendments (
  id, natural_key, contract_number, contract_number_raw, link_method, unp,
  value_before, value_after, value_delta, currency,
  published_at, document_number, description, source
)
WITH keyed AS (
  SELECT
    *,
    -- #306: key on the original annex-side number (contract_number_raw) when the value resolver rewrote a
    -- row — MUST match derive-amendments.sql's rollup key byte-for-byte, else annex_count and the served
    -- timeline disagree (review nikimilenkov MEDIUM 3). NULL raw → the plain number.
    'am:' || COALESCE(unp, '') || ':' || COALESCE(NULLIF(contract_number_raw, ''), contract_number, '') || ':' ||
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
  FROM raw_amendments
), dedup AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY natural_key
      ORDER BY source DESC, id DESC
    ) AS rn
  FROM keyed
)
SELECT
  natural_key,
  natural_key,
  contract_number,
  contract_number_raw,   -- #306 provenance: the annex-side number before the value resolver rewrote it
  link_method,           -- #306 provenance: 'value_anchor' for value-linked rows, else NULL
  unp,
  value_before,
  value_after,
  value_delta,
  currency,
  published_at,
  document_number,
  description,
  source
FROM dedup
WHERE rn = 1;

SELECT
  (SELECT COUNT(*) FROM amendments) AS amendments,
  (SELECT COUNT(*) FROM contracts WHERE annex_count > 0) AS contracts_amended,
  (SELECT COUNT(*) FROM contracts WHERE current_value IS NOT NULL) AS with_current_value,
  (SELECT COUNT(*) FROM contracts
     WHERE current_value IS NOT NULL AND current_value > signing_value) AS grew_in_value;
