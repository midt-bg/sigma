-- Promote work-DB staging amendments into the served domain table.
-- Backfill deliberately keeps derive-amendments.sql as the source for
-- contracts.current_value and contracts.annex_count before normalize, because
-- value_flag depends on that legacy staging rollup. The live refresh path will
-- switch contracts to the served amendments rollup in the next phase.

DELETE FROM amendments;

INSERT OR REPLACE INTO amendments (
  id, natural_key, contract_number, unp, value_before, value_after, value_delta, currency,
  published_at, document_number, description, source, value_restated, value_treatment, value_suspect
)
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
  unp,
  value_before,
  -- #305 Tier-2: serve the effective (text-corrected) after and a self-consistent delta; a restated
  -- annex carries the true total, an untreated one is unchanged.
  COALESCE(value_after_restated, value_after),
  COALESCE(value_after_restated, value_after) - value_before,
  currency,
  published_at,
  document_number,
  description,
  source,
  CASE WHEN value_after_restated IS NOT NULL THEN 1 ELSE 0 END,
  value_treatment,
  -- #305 residual: mark a suspected double-count that is NOT already text-treated so the UI suppresses
  -- the untrusted value_after. Mirrors normalize-raw.sql's annex_total_suspect arithmetic gate, but
  -- joined to raw_contracts for the contract's signing_value/currency (this served INSERT has no
  -- contract row to read). value_treatment IS NULL keeps a restated/genuine row out (value_restated
  -- already owns those). No current_value tie here: the tie in normalize-raw only decides whether the
  -- CONTRACT is flagged; the per-row marker suppresses any row whose after is an unbridgeable double.
  CASE WHEN value_treatment IS NULL
        AND value_before > 0
        AND value_after >= 2 * value_before AND value_after < 10 * value_before
        -- #305 M2 self-consistency: skip when value_delta is present and a ≉ b + d (model N/A).
        AND (value_delta IS NULL OR ABS(value_after - (value_before + value_delta)) < 0.01 * value_after)
        AND EXISTS (
          SELECT 1 FROM raw_contracts rc
          WHERE rc.unp = dedup.unp AND rc.contract_number = dedup.contract_number
            AND rc.signing_value > 0
            -- #305 multi-annex: value_before may be a prior cumulative total (a preceding annex's
            -- value_after), not signing. Anchor to signing OR a legitimately-grown prior total (prev not
            -- itself a double); a single ≥2× step violates ЗОП чл.116 wherever it sits (see normalize-raw.sql).
            AND (
              ABS(dedup.value_before - rc.signing_value) < 0.01 * rc.signing_value
              OR EXISTS (
                SELECT 1 FROM raw_amendments prev
                WHERE prev.unp = dedup.unp AND prev.contract_number = dedup.contract_number
                  AND prev.value_after > 0
                  AND ABS(prev.value_after - dedup.value_before) < 0.01 * dedup.value_before
                  -- ...and that prior total was itself reached legitimately (prev not a ≥2× double).
                  AND prev.value_before > 0 AND prev.value_after < 2 * prev.value_before
              )
              -- #305 84818-class: EXACT single-step 2× on an ORPHAN base (value_before ties neither signing
              -- nor any prior annex) — mark the row suspect; never rewrites (see normalize-raw.sql). The
              -- orphan guard leaves compounding chains untouched.
              OR (
                ABS(dedup.value_after - 2 * dedup.value_before) < 0.005 * dedup.value_before
                AND NOT EXISTS (
                  SELECT 1 FROM raw_amendments prev
                  WHERE prev.unp = dedup.unp AND prev.contract_number = dedup.contract_number
                    AND prev.value_after > 0
                    AND ABS(prev.value_after - dedup.value_before) < 0.01 * dedup.value_before
                )
              )
            )
            AND COALESCE(NULLIF(dedup.currency, ''), COALESCE(NULLIF(rc.currency, ''), 'BGN'))
              = COALESCE(NULLIF(rc.currency, ''), 'BGN')
        )
       THEN 1 ELSE 0 END
FROM dedup
WHERE rn = 1;

SELECT
  (SELECT COUNT(*) FROM amendments) AS amendments,
  (SELECT COUNT(*) FROM contracts WHERE annex_count > 0) AS contracts_amended,
  (SELECT COUNT(*) FROM contracts WHERE current_value IS NOT NULL) AS with_current_value,
  (SELECT COUNT(*) FROM contracts
     WHERE current_value IS NOT NULL AND current_value > signing_value) AS grew_in_value;
