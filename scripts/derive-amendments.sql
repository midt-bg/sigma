-- Sigma — roll raw_amendments up onto raw_contracts.
-- Run AFTER scripts/load-eop.mjs (which stages the EOP base + in-bucket OCDS amendments).
-- Re-runnable. On the full-derive path scripts/resolve-amendment-contracts.sql (#306) has already rewritten
-- namespace-mismatched EOP annexes onto their target contract_number BEFORE this file runs. This file then
-- recovers the УНП for OCDS amendments via the tender.id bridge (#286), prefers the EOP annex over its OCDS
-- twin (dropping the twin), lets the latest OCDS release carry a source-corrected value on a contract
-- with no EOP annex, and matches amendments by (unp, contract_number).
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
       WHERE e.source LIKE 'eop:%' AND e.unp = o.unp
         AND (e.contract_number = o.contract_number OR e.contract_number_raw = o.contract_number)) AS eop_n
  FROM raw_amendments o
  WHERE o.source LIKE 'ocds:%'
    AND EXISTS (SELECT 1 FROM raw_amendments e
                  WHERE e.source LIKE 'eop:%' AND e.unp = o.unp
                    AND (e.contract_number = o.contract_number OR e.contract_number_raw = o.contract_number))
  GROUP BY o.unp, o.contract_number
) g;

-- #286: prefer the EOP annex. ~99% of OCDS amendments duplicate an EOP annex for the same contract;
-- keeping both would double annex_count and duplicate the served timeline. Drop the OCDS twin when an
-- EOP annex already exists for the same (unp, contract_number). Genuinely OCDS-only annexes survive
-- (they carry value_after = NULL from ingest, so they never drive current_value — issue #286 — except the
-- latest release of a contract whose value the source corrected, see the block below).
-- The value resolver has already moved a namespace-mismatched EOP annex onto its contract and kept the
-- annex-side number in contract_number_raw; the OCDS release of the same annex still carries that
-- annex-side number. So an EOP annex is matched on either number: on the one it now links by, and on the
-- one it was published under. The resolver rewrites only an annex whose own number names no contract, so
-- the OCDS row matched through contract_number_raw hangs on no contract either.
DELETE FROM raw_amendments
WHERE source LIKE 'ocds:%'
  AND EXISTS (
    SELECT 1 FROM raw_amendments e
    WHERE e.source LIKE 'eop:%'
      AND e.unp = raw_amendments.unp
      AND (e.contract_number = raw_amendments.contract_number
        OR e.contract_number_raw = raw_amendments.contract_number)
  );

-- A contract value corrected at the source and published ONLY as OCDS contract updates. After the dedup above,
-- every surviving OCDS row sits on a contract with no EOP annex. An OCDS release carries the contract value as
-- it stands in that release, which is why a single OCDS row is never an after-value (#286): beside an EOP
-- annex it is the stale value before the change. Without any EOP annex, the value in the LATEST release is the
-- most recent value the source states for the contract. When it is in the signing currency and differs from
-- the signing value, the source has moved the value — a corrected decimal comma, say — so that release becomes
-- the leading annex: before = the signing value, after = the release value. Every other OCDS row keeps the
-- #286 shape (release value as value_before, no after-value), so annex_count and the timeline do not change
-- and the existing annex guards (the x100 ratio, the x10 step, the doubled total) judge the new value. Not
-- applied: a contract whose publications have missing or different signing values or currencies, a
-- release in another currency, a non-positive release value, and a release without a document number (its
-- publication key would then depend on the values rewritten here). The latest release is picked as the
-- leading annex is (published_at, then natural_key). The daily path makes the same decision over the window
-- and the served rows in `@refresh-batch amendments` (scripts/refresh-slice.sql). Re-runnable: a transformed
-- row keeps the release value as its after-value and is not touched again.
DROP TABLE IF EXISTS amendment_ocds_value_corrections;
CREATE TABLE amendment_ocds_value_corrections AS
WITH ocds AS (
  SELECT a.id, a.unp, a.contract_number, a.currency, a.document_number, a.raw_after,
    CASE WHEN a.raw_after IS NULL THEN a.value_before ELSE a.raw_after END AS release_value,
    ROW_NUMBER() OVER (
      PARTITION BY a.unp, a.contract_number ORDER BY a.published_at DESC, a.natural_key DESC
    ) AS rn
  FROM raw_amendment_publications a
  WHERE a.source LIKE 'ocds:%' AND a.unp IS NOT NULL AND a.contract_number IS NOT NULL
), signings AS (
  SELECT unp, contract_number, MIN(signing_value) AS signing_value,
    MIN(currency) AS currency
  FROM raw_contract_publications
  WHERE (source LIKE 'eop:%' OR source LIKE 'ocds:%') AND unp IS NOT NULL AND contract_number IS NOT NULL
  GROUP BY unp, contract_number
  HAVING COUNT(signing_value) = COUNT(*) AND COUNT(DISTINCT signing_value) = 1
    AND COUNT(NULLIF(TRIM(currency), '')) = COUNT(*) AND COUNT(DISTINCT currency) = 1
)
SELECT o.id, o.currency, s.signing_value AS value_before, o.release_value AS value_after
FROM ocds o
JOIN signings s ON s.unp = o.unp AND s.contract_number = o.contract_number
WHERE o.rn = 1 AND o.raw_after IS NULL
  AND NULLIF(o.document_number, '') IS NOT NULL
  AND o.currency = s.currency
  AND o.release_value > 0
  AND ABS(o.release_value - s.signing_value) >= 0.005;

UPDATE raw_amendments
SET value_before = (SELECT c.value_before FROM amendment_ocds_value_corrections c WHERE c.id = raw_amendments.id),
    value_after = (SELECT c.value_after FROM amendment_ocds_value_corrections c WHERE c.id = raw_amendments.id)
WHERE id IN (SELECT id FROM amendment_ocds_value_corrections);

SELECT 'OCDS source value (' || currency || ')' AS diagnostic,
  COUNT(*) AS corrections,
  SUM(value_after < value_before) AS downward_corrections,
  ROUND(SUM(value_after - value_before), 2) AS net_change
FROM amendment_ocds_value_corrections
GROUP BY currency;

DROP TABLE amendment_ocds_value_corrections;

-- #306: the value-anchor resolver that links namespace-mismatched EOP annexes (annex-side number ≠ the
-- contract's filing number) by rewriting raw_amendments.contract_number lives in
-- scripts/resolve-amendment-contracts.sql and runs BEFORE this file on the full-derive path only (see that
-- file's header for the ordering-blocker and slice-gating rationale — reviews todorkolev #1/#3, nikimilenkov
-- HIGH 1). By the time this rollup runs, resolved annexes already carry their target contract_number (and
-- keep the original annex number in contract_number_raw for the natural_key below), so the rollup links them
-- with no further change.

UPDATE raw_contracts SET annex_count = 0, current_value = NULL;

WITH dedup AS MATERIALIZED (SELECT * FROM raw_amendment_publications)
UPDATE raw_contracts
SET
  annex_count = (
    SELECT COUNT(*) FROM dedup a
    WHERE a.unp = raw_contracts.unp
      AND a.contract_number = raw_contracts.contract_number
  ),
  current_value = (
    SELECT a.effective_after FROM dedup a
    WHERE a.unp = raw_contracts.unp
      AND a.contract_number = raw_contracts.contract_number
      AND a.effective_after IS NOT NULL
    ORDER BY a.published_at DESC, a.natural_key DESC
    LIMIT 1
  )
WHERE EXISTS (
  SELECT 1 FROM dedup a
  WHERE a.unp = raw_contracts.unp
    AND a.contract_number = raw_contracts.contract_number
);

-- Summary (printed by wrangler)
SELECT
  (SELECT COUNT(*) FROM raw_amendments)                              AS amendments,
  (SELECT COUNT(*) FROM raw_contracts WHERE annex_count > 0)         AS contracts_amended,
  (SELECT COUNT(*) FROM raw_contracts WHERE current_value IS NOT NULL) AS with_current_value,
  (SELECT COUNT(*) FROM raw_contracts
     WHERE current_value IS NOT NULL AND current_value > signing_value)   AS grew_in_value;
