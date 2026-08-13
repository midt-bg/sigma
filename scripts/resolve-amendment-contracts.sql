-- Sigma — #306: link EOP annexes whose annex-side number is in a different namespace than the contract
-- number. The annex carries an internal number (e.g. 148846) while the contract on the same procedure
-- carries the buyer's filing number (e.g. Д-226), so the (unp, contract_number) join drops ~7% of EOP
-- annexes out of every annex→contract→company/authority rollup. String normalisation recovers almost none
-- of them (measured), because the two numbers are genuinely unrelated identifiers. Resolve by VALUE
-- instead: an annex's value_before is the contract's value at amendment time, so it equals the target
-- contract's signing_value. Link only when value_before matches EXACTLY (< 0.5 стотинка), currency- and
-- contractor-matched, uniquely one contract on the procedure — measured 99.99% precision on the already-
-- linked corpus (9348/9349). Rows that match 2+ contracts (value-ambiguous) or none (target not yet
-- ingested — the #249 class) are LEFT unlinked: an honest gap beats a wrong contract on a transparency site.
--
-- FULL-PATH ONLY (review nikimilenkov HIGH 1 + todorkolev #3). This file runs from runFullDerive /
-- runWorkBackfill in scripts/import.mjs, BEFORE derive-amendments.sql. It is deliberately NOT run on the
-- slice path (runSliceDerive): the slice's raw_contracts holds only the current window, so "unique on the
-- procedure" would mean "unique in the window", not in the corpus — a corpus-ambiguous annex would look
-- unique in a narrow window and mislink, and the measured precision (a full-corpus number) would not carry.
-- Per the #286 "the full pipeline is authoritative" precedent, the full rebuild fixes the whole measured
-- backlog; go-forward namespace-mismatched annexes stay unlinked only until the next full rebuild. A slice-
-- safe resolver (candidates from served `contracts` + touched-target wiring) is a separate, carefully-tested
-- change — see docs/implementation-plans/306-amendment-contract-namespace-link.md §4.
--
-- ORDER (review todorkolev #1, the blocker): this runs BEFORE the #286 prefer-EOP dedup DELETE in
-- derive-amendments.sql. Rewriting an EOP annex onto a contract that already kept an OCDS twin would
-- resurrect that twin (annex_count = 2 on a one-annex contract) and trip the amendment-twin-dedup integrity
-- gate (#303), failing the whole derive. Running first — and above the #286 diagnostics, so their dropped/
-- excess counts stay honest bounds on what the dedup actually removes — keeps the dedup the sole twin guard.
-- The resolver reads only source LIKE 'eop:%' rows + raw_contracts, so it has no dependency on the OCDS
-- bridge and is safe to run first.

-- Candidate contracts, deduped to one row per LOGICAL contract. raw_contracts is CUMULATIVE — the EOP daily
-- open-data buckets repeat the same contract across consecutive days, and the collapse to one row per
-- (unp, contract_number) happens later in normalize-raw.sql, NOT in staging (review nikimilenkov HIGH 2).
-- Without this dedup, COUNT(*) OVER below would count staging ROWS, not contracts: a contract present in N
-- daily buckets would read as n_match = N and fail-close every real link, and a superseded row could match
-- an annex to a stale value. Mirror normalize-raw's rule (latest source-day, then highest id, wins).
DROP TABLE IF EXISTS amendment_contract_resolve;
CREATE TABLE amendment_contract_resolve AS
WITH contract_candidates AS (
  SELECT unp, contract_number, signing_value, currency, contractor_eik
  FROM (
    SELECT c.unp, c.contract_number, c.signing_value, c.currency, c.contractor_eik,
      ROW_NUMBER() OVER (
        PARTITION BY c.unp, c.contract_number
        ORDER BY c.source DESC, c.id DESC
      ) AS rn
    FROM raw_contracts c
    WHERE c.contract_number IS NOT NULL
      AND c.signing_value IS NOT NULL AND c.signing_value > 0
  )
  WHERE rn = 1
),
-- Every EOP annex whose (unp, contract_number) matches no contract — the namespace-mismatch group. Includes
-- value-less members (value_before NULL/≤0): an admin/term annex mid-chain carries no signing value of its
-- own but must still inherit the chain's target (review nikimilenkov MEDIUM 2), else the chain breaks and
-- current_value stops early. Grouped by the shared annex-side number (unp, annex_cnum) = one contract's chain.
grp AS (
  SELECT a.id AS amendment_id, a.unp, a.contract_number AS annex_cnum,
         a.value_before, a.currency, a.contractor_eik
  FROM raw_amendments a
  WHERE a.source LIKE 'eop:%'
    AND a.unp IS NOT NULL AND a.contract_number IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM raw_contracts c
      WHERE c.unp = a.unp AND c.contract_number = a.contract_number
    )
),
-- Exact, currency- and contractor-matched value anchor. Only members that carry a usable value_before
-- participate in matching. The currency guard requires an EXPLICIT currency on both sides (review
-- nikimilenkov LOW 1): a blank-vs-blank pair must not silently agree via a 'BGN' default under so tight a
-- gate. The EIK guard (review nikimilenkov MEDIUM 5) is null-tolerant — the annex already carries the
-- contractor, so a value collision onto a DIFFERENT contractor's contract is refused for free.
vmatch AS (
  SELECT g.amendment_id, g.unp, g.annex_cnum, c.contract_number AS resolved_cnum,
    COUNT(*) OVER (PARTITION BY g.amendment_id) AS n_match
  FROM grp g
  JOIN contract_candidates c
    ON c.unp = g.unp
    AND ABS(c.signing_value - g.value_before) < 0.005
    AND NULLIF(c.currency, '') IS NOT NULL
    AND NULLIF(g.currency, '') IS NOT NULL
    AND c.currency = g.currency
    AND (g.contractor_eik IS NULL OR c.contractor_eik IS NULL OR g.contractor_eik = c.contractor_eik)
  WHERE g.value_before IS NOT NULL AND g.value_before > 0
),
-- Per group (unp, annex_cnum): the only evidence-bearing anchors are the UNIQUE (n_match = 1) matches.
--   * one_target       — the single target the unique members agree on (NULL if none)
--   * distinct_targets — how many distinct targets the unique members point at
-- distinct_targets = 1 means "exactly one agreed anchor"; ≥2 means the unique members disagree (evidence
-- that value-matching mis-fired for at least one member) → refuse the whole group, voiding even the direct
-- hits (review nikimilenkov MEDIUM 1). 0 means no unique anchor at all → nothing to propagate.
group_eval AS (
  SELECT unp, annex_cnum,
    MIN(CASE WHEN n_match = 1 THEN resolved_cnum END) AS one_target,
    COUNT(DISTINCT CASE WHEN n_match = 1 THEN resolved_cnum END) AS distinct_targets
  FROM vmatch
  GROUP BY unp, annex_cnum
),
clean_group AS (
  SELECT unp, annex_cnum, one_target AS resolved_cnum
  FROM group_eval
  WHERE distinct_targets = 1
)
-- A member links to the group's agreed target iff the member is NOT itself value-ambiguous. Unique members
-- link to the (agreed) target; value-less members inherit it; a member that matched 2+ contracts carries its
-- own contradicting evidence and stays unlinked (review todorkolev #2). The chain identity (unp, annex_cnum)
-- makes propagation to value-less members sound while the anchor stays a full-corpus unique value match.
SELECT g.amendment_id, cg.resolved_cnum
FROM grp g
JOIN clean_group cg ON cg.unp = g.unp AND cg.annex_cnum = g.annex_cnum
WHERE NOT EXISTS (
  SELECT 1 FROM vmatch v WHERE v.amendment_id = g.amendment_id AND v.n_match >= 2
);

-- The rewrite UPDATE below correlates raw_amendments.id to amendment_contract_resolve.amendment_id once per
-- unlinked row; index the resolve table so that is a lookup, not a scan (review nikimilenkov LOW 4).
CREATE INDEX IF NOT EXISTS idx_amendment_contract_resolve_id
  ON amendment_contract_resolve(amendment_id);

-- Rewrite contract_number in place — exactly like the #286 УНП bridge — and PRESERVE PROVENANCE (review
-- nikimilenkov MEDIUM 4): keep the original annex-side number in contract_number_raw and stamp link_method
-- so the value-linked rows stay enumerable in staging, through promote, and in the served `amendments`
-- table. contract_number_raw also keeps the annex number in the amendment natural_key (see derive-
-- amendments.sql / promote-amendments.sql), so a resolved row never collides with a native annex that
-- happens to share document_number on the target contract (review nikimilenkov MEDIUM 3).
UPDATE raw_amendments
SET
  contract_number_raw = contract_number,
  link_method = 'value_anchor',
  contract_number = (
    SELECT r.resolved_cnum FROM amendment_contract_resolve r WHERE r.amendment_id = raw_amendments.id
  )
WHERE id IN (SELECT amendment_id FROM amendment_contract_resolve WHERE resolved_cnum IS NOT NULL);

-- #306 diagnostic (printed by wrangler): annexes linked by the value anchor, and those still unlinked. The
-- two predicates are complementary — both count over the SAME namespace-mismatch population (review
-- nikimilenkov LOW 3) — so linked + still_unlinked = the original mismatch count on a healthy run.
SELECT
  (SELECT COUNT(*) FROM raw_amendments WHERE link_method = 'value_anchor') AS annexes_value_linked,
  (SELECT COUNT(*) FROM raw_amendments a
     WHERE a.source LIKE 'eop:%' AND a.unp IS NOT NULL AND a.contract_number IS NOT NULL
       AND a.link_method IS NULL
       AND NOT EXISTS (SELECT 1 FROM raw_contracts c
                         WHERE c.unp = a.unp AND c.contract_number = a.contract_number)) AS eop_annexes_still_unlinked;

DROP TABLE IF EXISTS amendment_contract_resolve;
