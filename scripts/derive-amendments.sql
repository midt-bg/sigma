-- Sigma — roll raw_amendments up onto raw_contracts.
-- Run AFTER scripts/load-eop.mjs (which stages the EOP base + in-bucket OCDS amendments).
-- Re-runnable: resets the rollup, then matches amendments by (unp, contract_number).
-- current_value = the after-value of the LATEST amendment; annex_count = how many.
-- Contracts without amendments keep annex_count = 0 and current_value = NULL (the
-- convention downstream is COALESCE(current_value, signing_value)).

-- #286: OCDS amendments stage the OCID in `unp` (the УНП is absent from the OCDS release), so they
-- match no contract. Recover the real УНП through the same bridge the OCDS-lots enrichment uses
-- (normalize-raw.sql): OCDS tender.id (staged as raw_amendments.tender_ext_id) → EOP tenderId → УНП.
-- The EOP tenderId lives in raw_tenders.tender_id for procedures in the поръчки feed AND in
-- raw_contracts.tender_ext_id for procedures that appear only as contracts (the "synthetic tenders"
-- of normalize-raw §2b) — so try raw_tenders first, then fall back to raw_contracts, else leave the
-- ocid untouched. The ocid stays only as a surrogate. Idempotent: a full run re-stages raw_amendments
-- and recomputes the same УНП. Being the first amendment step in the full pipeline, it leaves
-- raw_amendments corrected for promote-amendments.sql.
UPDATE raw_amendments
SET unp = COALESCE(
  (SELECT rt.unp FROM raw_tenders rt
     WHERE rt.tender_id = raw_amendments.tender_ext_id AND rt.unp IS NOT NULL LIMIT 1),
  (SELECT rc.unp FROM raw_contracts rc
     WHERE rc.tender_ext_id = raw_amendments.tender_ext_id AND rc.unp IS NOT NULL LIMIT 1)
)
WHERE source LIKE 'ocds:%'
  AND tender_ext_id IS NOT NULL
  AND (
    EXISTS (SELECT 1 FROM raw_tenders rt
              WHERE rt.tender_id = raw_amendments.tender_ext_id AND rt.unp IS NOT NULL)
    OR EXISTS (SELECT 1 FROM raw_contracts rc
                 WHERE rc.tender_ext_id = raw_amendments.tender_ext_id AND rc.unp IS NOT NULL)
  );

-- #286: prefer the EOP annex. ~99% of OCDS amendments duplicate an EOP annex for the same contract;
-- keeping both would double annex_count and duplicate the served timeline. Drop the OCDS twin when an
-- EOP annex already exists for the same (unp, contract_number). Genuinely OCDS-only annexes survive
-- (they carry value_after = NULL from ingest, so they never drive current_value — issue #286).
DELETE FROM raw_amendments
WHERE source LIKE 'ocds:%'
  AND EXISTS (
    SELECT 1 FROM raw_amendments e
    WHERE e.source LIKE 'eop:%'
      AND e.unp = raw_amendments.unp
      AND e.contract_number = raw_amendments.contract_number
  );

UPDATE raw_contracts SET annex_count = 0, current_value = NULL;

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
UPDATE raw_contracts
SET
  annex_count = (
    SELECT COUNT(*) FROM dedup a
    WHERE a.unp = raw_contracts.unp
      AND a.contract_number = raw_contracts.contract_number
      AND a.rn = 1
  ),
  current_value = (
    SELECT a.value_after FROM dedup a
    WHERE a.unp = raw_contracts.unp
      AND a.contract_number = raw_contracts.contract_number
      AND a.value_after IS NOT NULL
      AND a.rn = 1
    ORDER BY a.published_at DESC, a.natural_key DESC
    LIMIT 1
  )
WHERE EXISTS (
  SELECT 1 FROM dedup a
  WHERE a.unp = raw_contracts.unp
    AND a.contract_number = raw_contracts.contract_number
    AND a.rn = 1
);

-- Summary (printed by wrangler)
SELECT
  (SELECT COUNT(*) FROM raw_amendments)                              AS amendments,
  (SELECT COUNT(*) FROM raw_contracts WHERE annex_count > 0)         AS contracts_amended,
  (SELECT COUNT(*) FROM raw_contracts WHERE current_value IS NOT NULL) AS with_current_value,
  (SELECT COUNT(*) FROM raw_contracts
     WHERE current_value IS NOT NULL AND current_value > signing_value)   AS grew_in_value;
