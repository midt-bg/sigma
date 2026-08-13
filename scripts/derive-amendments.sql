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

-- #306: link EOP annexes whose annex-side number is in a different namespace than the contract number.
-- The annex carries an internal number (e.g. 148846) while the contract on the same procedure carries the
-- buyer's filing number (e.g. Д-226), so the (unp, contract_number) join below drops ~7% of EOP annexes out
-- of every annex→contract→company/authority rollup. String normalisation recovers almost none of them
-- (measured), because the two numbers are genuinely unrelated identifiers. Resolve by VALUE instead: an
-- annex's value_before is the contract's value at amendment time, so it equals the target contract's
-- signing_value. Link only when value_before matches EXACTLY (< 0.5 стотинка), currency-matched, exactly
-- ONE contract on the procedure — measured 99.99% precision on the already-linked corpus (8348/8349). Rows
-- that match 2+ contracts (value-ambiguous) or none (target not yet ingested — the #249 class) are LEFT
-- unlinked: an honest gap beats a wrong contract on a transparency site. A chain of annexes shares one
-- annex-side number but only its FIRST carries value_before = signing_value (later steps carry the prior
-- cumulative), so once any sibling resolves, propagate that target across the whole (unp, annex-number)
-- group when the resolved members agree — otherwise the chain's later annexes stay unlinked and the
-- contract's current_value would stop at the first step. Rewrites raw_amendments.contract_number in place,
-- exactly like the УНП bridge above; the rollup below, promote-amendments.sql, and the serving join then
-- link with no further change. NOT under a byte-identical @…-lockstep marker: the slice path
-- (refresh-slice.sql) runs the same logic but also draws candidate contracts from the served `contracts`
-- table (its raw_contracts holds only the current window), so the two intentionally diverge — like the
-- prefer-EOP dedup above. See docs/implementation-plans and issue #306.
DROP TABLE IF EXISTS amendment_contract_resolve;
CREATE TABLE amendment_contract_resolve AS
WITH unlinked AS (
  SELECT a.id AS amendment_id, a.unp, a.contract_number AS annex_cnum, a.value_before, a.currency
  FROM raw_amendments a
  WHERE a.source LIKE 'eop:%'
    AND a.unp IS NOT NULL AND a.contract_number IS NOT NULL
    AND a.value_before IS NOT NULL AND a.value_before > 0
    AND NOT EXISTS (
      SELECT 1 FROM raw_contracts c
      WHERE c.unp = a.unp AND c.contract_number = a.contract_number
    )
),
-- exact, currency-matched value anchor; COUNT(*) OVER distinguishes a unique hit from an ambiguous one.
vmatch AS (
  SELECT u.amendment_id, u.unp, u.annex_cnum, c.contract_number AS resolved_cnum,
    COUNT(*) OVER (PARTITION BY u.amendment_id) AS n_match
  FROM unlinked u
  JOIN raw_contracts c
    ON c.unp = u.unp
    AND c.contract_number IS NOT NULL
    AND c.signing_value IS NOT NULL AND c.signing_value > 0
    AND ABS(c.signing_value - u.value_before) < 0.005
    AND COALESCE(NULLIF(c.currency, ''), 'BGN') = COALESCE(NULLIF(u.currency, ''), 'BGN')
),
direct AS (
  SELECT amendment_id, unp, annex_cnum, resolved_cnum FROM vmatch WHERE n_match = 1
),
-- propagate one agreed target across a chain sharing the same annex-side number (refuse if they disagree).
group_target AS (
  SELECT unp, annex_cnum, MIN(resolved_cnum) AS resolved_cnum
  FROM direct GROUP BY unp, annex_cnum HAVING COUNT(DISTINCT resolved_cnum) = 1
)
SELECT u.amendment_id,
  COALESCE(
    (SELECT d.resolved_cnum FROM direct d WHERE d.amendment_id = u.amendment_id),
    (SELECT g.resolved_cnum FROM group_target g WHERE g.unp = u.unp AND g.annex_cnum = u.annex_cnum)
  ) AS resolved_cnum
FROM unlinked u;

UPDATE raw_amendments
SET contract_number = (
  SELECT r.resolved_cnum FROM amendment_contract_resolve r WHERE r.amendment_id = raw_amendments.id
)
WHERE id IN (SELECT amendment_id FROM amendment_contract_resolve WHERE resolved_cnum IS NOT NULL);

-- #306 diagnostic (printed by wrangler): annexes linked by the value anchor, and those still unlinked.
SELECT
  (SELECT COUNT(*) FROM amendment_contract_resolve WHERE resolved_cnum IS NOT NULL) AS annexes_value_linked,
  (SELECT COUNT(*) FROM raw_amendments a
     WHERE a.source LIKE 'eop:%' AND a.unp IS NOT NULL AND a.contract_number IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM raw_contracts c
                         WHERE c.unp = a.unp AND c.contract_number = a.contract_number)) AS eop_annexes_still_unlinked;

DROP TABLE IF EXISTS amendment_contract_resolve;

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
