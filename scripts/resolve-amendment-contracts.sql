-- #306: an EOP annex may carry a different number from the contract's filing number.
-- Match an exact signing value in the same source currency, subject to contractor
-- evidence. A direct match may support other publications with the same annex number.
-- Run before derive-amendments.sql clears OCDS twins. The slice resolver in
-- refresh-slice.sql also considers contracts and direct witnesses served by past windows.
DROP TABLE IF EXISTS amendment_contract_resolve;
CREATE TABLE amendment_contract_resolve AS
WITH suppliers AS MATERIALIZED (
  SELECT * FROM raw_supplier_evidence
), corrected AS MATERIALIZED (
  SELECT * FROM raw_corrected_signing_values
), publications AS MATERIALIZED (
  SELECT a.id AS amendment_id, a.unp,
    COALESCE(NULLIF(a.contract_number_raw, ''), a.contract_number) AS annex_cnum,
    a.link_method, a.value_before, a.currency, s.eik AS contractor_eik, s.evidence_status AS contractor_status
  FROM raw_amendment_publications a
  JOIN suppliers s ON s.eik_raw IS a.contractor_eik
  WHERE a.source LIKE 'eop:%' AND a.unp IS NOT NULL AND a.contract_number IS NOT NULL
), grp AS (
  SELECT a.*
  FROM publications a
  WHERE NOT EXISTS (
    SELECT 1 FROM raw_contract_publications c WHERE c.unp = a.unp AND c.contract_number = a.annex_cnum
  )
), matches AS (
  SELECT g.amendment_id, g.unp, g.annex_cnum,
    MIN(c.contract_number) AS resolved_cnum, COUNT(DISTINCT c.contract_number) AS n_match,
    MAX(CASE WHEN g.contractor_status IN ('absent', 'valid')
      AND s.evidence_status IN ('absent', 'valid') THEN 1 ELSE 0 END) AS has_proof
  FROM grp g
  JOIN raw_contract_publications c
    ON c.unp = g.unp AND c.contract_number IS NOT NULL AND c.currency = g.currency AND c.currency <> ''
  LEFT JOIN corrected v ON v.unp = c.unp AND v.contract_number = c.contract_number
  JOIN suppliers s ON s.eik_raw IS c.contractor_eik
    AND (g.contractor_eik IS NULL OR s.eik IS NULL OR g.contractor_eik = s.eik)
  WHERE g.value_before > 0 AND (
    (c.signing_value > 0 AND ROUND(ABS(c.signing_value - g.value_before), 6) < 0.005)
    OR (v.signing_value > 0 AND ROUND(ABS(v.signing_value - g.value_before), 6) < 0.005)
  )
  GROUP BY g.amendment_id, g.unp, g.annex_cnum
), direct AS (
  SELECT * FROM matches WHERE n_match = 1 AND has_proof = 1
), group_target AS (
  SELECT unp, annex_cnum, MIN(resolved_cnum) AS resolved_cnum
  -- An unverified or ambiguous match can veto inheritance to a different owner.
  FROM matches GROUP BY unp, annex_cnum
  HAVING MAX(n_match) = 1 AND COUNT(DISTINCT resolved_cnum) = 1 AND MAX(has_proof) = 1
)
SELECT a.amendment_id, a.annex_cnum, COALESCE(d.resolved_cnum, gt.resolved_cnum) AS resolved_cnum,
  CASE WHEN d.resolved_cnum IS NOT NULL THEN 'direct'
       WHEN gt.resolved_cnum IS NOT NULL THEN 'inherited' END AS value_anchor_kind,
  g.amendment_id IS NOT NULL AS namespace_mismatch
FROM publications a
LEFT JOIN grp g ON g.amendment_id = a.amendment_id
LEFT JOIN matches m ON m.amendment_id = g.amendment_id
LEFT JOIN direct d ON d.amendment_id = g.amendment_id
LEFT JOIN group_target gt ON gt.unp = g.unp AND gt.annex_cnum = g.annex_cnum
  AND g.contractor_status IN ('absent', 'valid') AND COALESCE(m.has_proof, 1) = 1
WHERE g.amendment_id IS NOT NULL OR a.link_method = 'value_anchor';

-- Keep the original annex-side number in the natural key through promotion.
UPDATE raw_amendments AS a
SET
  contract_number_raw = CASE WHEN r.resolved_cnum IS NOT NULL THEN r.annex_cnum END,
  link_method = CASE WHEN r.resolved_cnum IS NOT NULL THEN 'value_anchor' END,
  value_anchor_kind = r.value_anchor_kind,
  contract_number = COALESCE(r.resolved_cnum, r.annex_cnum)
FROM amendment_contract_resolve r
WHERE a.id = r.amendment_id AND (r.resolved_cnum IS NOT NULL OR a.link_method = 'value_anchor');

SELECT
  (SELECT COUNT(*) FROM amendment_contract_resolve WHERE resolved_cnum IS NOT NULL) AS annexes_value_linked,
  (SELECT COUNT(*) FROM amendment_contract_resolve WHERE namespace_mismatch AND resolved_cnum IS NULL)
    AS eop_annexes_still_unlinked;

DROP TABLE IF EXISTS amendment_contract_resolve;
