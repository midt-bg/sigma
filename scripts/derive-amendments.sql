-- Sigma — roll raw_amendments up onto raw_contracts.
-- Run AFTER scripts/load-eop.mjs (which stages the EOP base + in-bucket OCDS amendments).
-- Re-runnable. First recovers the УНП for OCDS amendments via the tender.id bridge (#286), then
-- prefers the EOP annex over its OCDS twin (dropping the twin), then matches amendments by
-- (unp, contract_number).
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
-- KEEP THE BRIDGE UPDATE BELOW IN LOCKSTEP with scripts/refresh-slice.sql: the UPDATE between the
-- @bridge-lockstep markers must stay byte-for-byte equivalent across both scripts (enforced by
-- packages/db/src/amendments-bridge-lockstep.test.ts). The prefer-EOP dedup DELETE deliberately does NOT
-- match — the slice path additionally reconciles against the cumulative served `amendments`, which this
-- full path never needs (promote-amendments.sql rebuilds it from scratch). raw_tenders(tender_id) is
-- indexed in work-staging-schema.sql, but raw_contracts(tender_ext_id) is not, so the fallback lookups
-- below would full-scan raw_contracts once per OCDS row — index it defensively (mirrors the lots bridge,
-- which indexes raw_tenders.tender_id before its join in normalize-raw.sql). The WHERE bridges only when
-- the chosen source maps the tender_ext_id to exactly ONE distinct УНП — see the refuse-on-ambiguity note
-- inside the block; the ocds_ambiguous_bridges diagnostic below surfaces any refusal.
CREATE INDEX IF NOT EXISTS idx_raw_contracts_tender_ext_id ON raw_contracts(tender_ext_id);
-- @bridge-lockstep start
UPDATE raw_amendments
SET unp = COALESCE(
  (SELECT rt.unp FROM raw_tenders rt
     WHERE rt.tender_id = raw_amendments.tender_ext_id AND rt.unp IS NOT NULL ORDER BY rt.unp LIMIT 1),
  (SELECT rc.unp FROM raw_contracts rc
     WHERE rc.tender_ext_id = raw_amendments.tender_ext_id AND rc.unp IS NOT NULL ORDER BY rc.unp LIMIT 1)
)
WHERE source LIKE 'ocds:%'
  AND tender_ext_id IS NOT NULL
  AND (
    -- raw_tenders wins when it resolves the procedure to exactly ONE УНП; else fall back to raw_contracts
    -- when IT is unambiguous. Refuse to bridge (leave the OCID as an honest residual) when the chosen
    -- source maps one tender_ext_id to more than one distinct УНП — the domain is 1-to-1, so this guards a
    -- feed anomaly rather than silently mis-attributing every annex of the losing procedure (issue #286).
    (SELECT COUNT(DISTINCT rt.unp) FROM raw_tenders rt
       WHERE rt.tender_id = raw_amendments.tender_ext_id AND rt.unp IS NOT NULL) = 1
    OR (
      NOT EXISTS (SELECT 1 FROM raw_tenders rt
                    WHERE rt.tender_id = raw_amendments.tender_ext_id AND rt.unp IS NOT NULL)
      AND (SELECT COUNT(DISTINCT rc.unp) FROM raw_contracts rc
             WHERE rc.tender_ext_id = raw_amendments.tender_ext_id AND rc.unp IS NOT NULL) = 1
    )
  );
-- @bridge-lockstep end

-- #286 diagnostic (printed by wrangler, review nikimilenkov LOW 1): count OCDS amendments the bridge
-- REFUSED because their tender_ext_id resolves to more than one distinct УНП in the chosen source. The
-- domain is 1-to-1, so this must be 0 on a healthy feed; a non-zero value is a feed anomaly to investigate,
-- not a silent mis-attribution. Runs after the bridge, so refused rows still carry their OCID.
SELECT COUNT(*) AS ocds_ambiguous_bridges
FROM raw_amendments o
WHERE o.source LIKE 'ocds:%'
  AND o.tender_ext_id IS NOT NULL
  AND o.unp LIKE 'ocds-%'
  AND (
    (SELECT COUNT(DISTINCT rt.unp) FROM raw_tenders rt
       WHERE rt.tender_id = o.tender_ext_id AND rt.unp IS NOT NULL) > 1
    OR (
      NOT EXISTS (SELECT 1 FROM raw_tenders rt
                    WHERE rt.tender_id = o.tender_ext_id AND rt.unp IS NOT NULL)
      AND (SELECT COUNT(DISTINCT rc.unp) FROM raw_contracts rc
             WHERE rc.tender_ext_id = o.tender_ext_id AND rc.unp IS NOT NULL) > 1
    )
  );

-- #286 diagnostic (printed by wrangler, BEFORE the drop below): keep the residual OCDS under-count
-- OBSERVABLE. The prefer-EOP dedup is contract-level — it drops EVERY OCDS annex on a contract that
-- already has an EOP annex, so a genuinely OCDS-only *extra* amendment there is lost. Per-annex twin
-- matching can't rescue it: OCDS document_number is the release id (ocds-…) while EOP's is the АОП
-- document number — different id spaces that never align, so we cannot prove per-annex which drops are
-- true twins. Report bounds instead (run after the bridge above, so o.unp is the recovered УНП):
--   dropped         = every OCDS annex removed by the dedup          (UPPER bound on annexes lost)
--   excess_over_eop = Σ max(0, ocds_on_contract − eop_on_contract)   (LOWER bound: cannot all be twins)
SELECT
  COALESCE(SUM(g.ocds_n), 0) AS ocds_annexes_dropped,
  COALESCE(SUM(CASE WHEN g.ocds_n > g.eop_n THEN g.ocds_n - g.eop_n ELSE 0 END), 0)
    AS ocds_annexes_excess_over_eop
FROM (
  SELECT o.unp, o.contract_number,
    COUNT(*) AS ocds_n,
    (SELECT COUNT(*) FROM raw_amendments e
       WHERE e.source LIKE 'eop:%' AND e.unp = o.unp AND e.contract_number = o.contract_number) AS eop_n
  FROM raw_amendments o
  WHERE o.source LIKE 'ocds:%'
    AND EXISTS (SELECT 1 FROM raw_amendments e
                  WHERE e.source LIKE 'eop:%' AND e.unp = o.unp AND e.contract_number = o.contract_number)
  GROUP BY o.unp, o.contract_number
) g;

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
  -- #305 Tier-2: a text-confirmed double-count carries the corrected total in value_after_restated; use
  -- it as the effective after so current_value reflects the true total, not the raw doubled value_after.
  current_value = (
    SELECT COALESCE(a.value_after_restated, a.value_after) FROM dedup a
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
