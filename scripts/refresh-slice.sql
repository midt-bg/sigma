-- Sigma — daily refresh: derive the OCDS go-forward delta into the domain + refresh ONLY the
-- affected rollup/FTS rows. Run by apps/etl's RefreshWorkflow after the OCDS staging is upserted;
-- also runnable via sqlite3/wrangler for tests and manual catch-up.
--
-- SCOPED + IDEMPOTENT. It replaces only c:e:/c:o: contracts represented by the transient window
-- and refreshes the rollup rows for c:e:/c:o: entities. Admin-derived c: rows are left alone.
-- EOP wins over OCDS when both feeds carry the same public contract document number. Re-running the
-- same window yields the same domain rows. Mirrors normalize-raw.sql steps 1/2b/4/5 plus
-- precompute.sql, scoped.

-- @refresh-batch resolve-annexes
-- Resolve the staged keys and collect affected value history before the FX loader runs.
-- Served annexes and freshness are changed only after FX succeeds.
CREATE INDEX IF NOT EXISTS idx_contracts_tender_id ON contracts(tender_id);
DROP TABLE IF EXISTS refresh_amendment_winners;
DROP TABLE IF EXISTS refresh_amendment_contract_resolve;
DROP TABLE IF EXISTS refresh_amendment_served_bridge;

-- #286: recover the УНП for OCDS amendments via the tender.id bridge before any raw_amendments read
-- below, mirroring derive-amendments.sql (raw_tenders first, then the raw_contracts synthetic-tender
-- fallback). In the slice path the raw tables hold only the loaded window, so an OCDS amendment whose
-- procedure was staged outside the window is not bridged by that UPDATE; the slice-only fallback right
-- after it asks the served `tenders` instead, which hold every procedure ever staged.
-- KEEP THE BRIDGE UPDATE BELOW IN LOCKSTEP with scripts/derive-amendments.sql: the UPDATE between the
-- @bridge-lockstep markers must stay byte-for-byte equivalent to the full path (packages/db/src/
-- amendments-bridge-lockstep.test.ts enforces it). The prefer-EOP dedup INTENTIONALLY DIVERGES from the
-- full path — the slice path also reconciles against the cumulative served `amendments` table (below and
-- before the promotion), which the full path never needs because promote-amendments.sql rebuilds it from
-- scratch. Index raw_contracts(tender_ext_id) so the fallback lookups don't full-scan raw_contracts per
-- OCDS row (raw_tenders(tender_id) is already indexed); ORDER BY unp keeps the recovered УНП deterministic.
CREATE INDEX IF NOT EXISTS idx_raw_contracts_tender_ext_id ON raw_contracts(tender_ext_id);
-- Remember the OCID each OCDS amendment arrived with: the bridges below overwrite it, and the clean-up
-- after them needs it to find the row an earlier window served under that OCID.
CREATE TABLE refresh_amendment_ocids AS
SELECT id, unp AS ocid
FROM raw_amendments
WHERE source LIKE 'ocds:%' AND unp LIKE 'ocds-%';
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

-- Slice-only fallback for the bridge above. A refresh window holds a few days of the feeds, and an annex
-- is usually signed long after its procedure was announced — so for most OCDS amendments the procedure
-- is in neither raw_tenders nor raw_contracts of this window, and the UPDATE above leaves the OCID in
-- place. Such a row then matched nothing: not its contract, and not the EOP annex it is the twin of, so
-- the prefer-EOP dedup below let it through and it was served as a dead row beside the real annex.
--
-- The served `tenders` are the cumulative form of the same two sources: eop_tender_id is the EOP
-- tenderId of a header procedure and, for a contract-only procedure, the id folded from its contracts
-- (normalize-raw.sql §2a/§2b, mirrored further down in this file), and source_id is the УНП. So ask
-- them — under the same rules as the window bridge:
--   - only for an amendment the window bridge had nothing to say about. Where the window names the
--     procedure it has already decided, including a refusal on ambiguity, and the served table does not
--     overrule it;
--   - only when the id resolves to exactly ONE served УНП; otherwise the OCID stays as the honest residual;
--   - never onto an OCDS-only procedure (source_id is itself an OCID) — that is no УНП.
-- `tenders` has no index on eop_tender_id, so this is written as ONE scan of the table probing the
-- window's handful of ids, never a lookup per amendment (which is a scan per amendment).
CREATE TABLE refresh_amendment_served_bridge AS
SELECT t.eop_tender_id AS tender_ext_id, MIN(t.source_id) AS unp
FROM tenders t
WHERE t.eop_tender_id IN (
    SELECT o.tender_ext_id
    FROM raw_amendments o
    WHERE o.source LIKE 'ocds:%'
      AND o.unp LIKE 'ocds-%'
      AND o.tender_ext_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM raw_tenders rt
                        WHERE rt.tender_id = o.tender_ext_id AND rt.unp IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM raw_contracts rc
                        WHERE rc.tender_ext_id = o.tender_ext_id AND rc.unp IS NOT NULL)
  )
  AND t.source_id NOT LIKE 'ocds-%'
GROUP BY t.eop_tender_id
HAVING COUNT(DISTINCT t.source_id) = 1;

UPDATE raw_amendments
SET unp = (
  SELECT b.unp FROM refresh_amendment_served_bridge b
  WHERE b.tender_ext_id = raw_amendments.tender_ext_id
)
WHERE source LIKE 'ocds:%'
  AND unp LIKE 'ocds-%'
  AND tender_ext_id IN (SELECT tender_ext_id FROM refresh_amendment_served_bridge);

-- Converge what earlier windows left behind. A window overlaps the previous ones, so an amendment that
-- was served under its OCID is staged again — and this time it is bridged. From here on it is either
-- dropped as the twin of an EOP annex or promoted under its УНП, and in both cases under a natural_key
-- that no longer matches the old row; nothing below would ever replace or remove that one. Drop it here,
-- matched on the OCID it was served under plus the contract and document numbers, so only the very row
-- this amendment used to be goes. A row whose OCID still carries contracts of its own (an OCDS-only
-- procedure) is left alone: there the OCID is the key the contract hangs on.
-- Retain the original aliases on a retry after a committed resolution batch. The EOP
-- filter can remove the raw OCDS row by then. A new staging lifecycle sweeps this table.
CREATE TABLE IF NOT EXISTS refresh_amendment_rekeyed AS
SELECT o.ocid, r.contract_number, r.document_number
FROM refresh_amendment_ocids o
JOIN raw_amendments r ON r.id = o.id
WHERE r.unp NOT LIKE 'ocds-%';

DROP TABLE IF EXISTS refresh_amendment_ocids;
DROP TABLE IF EXISTS refresh_amendment_served_bridge;

-- #306: resolve namespace-mismatched EOP annexes before dropping OCDS twins. Match the
-- full resolver against the current contract publications plus served rows which survive
-- this window's promotion. The contract and anchor lookups are scoped to affected procedures.
CREATE TABLE refresh_amendment_contract_resolve AS
WITH suppliers AS MATERIALIZED (
  SELECT * FROM raw_supplier_evidence
), staged_annexes AS MATERIALIZED (
  -- The publication key uses the original annex number, including after a committed retry.
  SELECT a.id AS amendment_id, a.natural_key, a.unp,
    COALESCE(NULLIF(a.contract_number_raw, ''), a.contract_number) AS annex_cnum,
    a.source, a.link_method, a.value_before, a.currency, s.eik AS contractor_eik,
    s.evidence_status AS contractor_status
  FROM raw_amendment_publications a
  JOIN suppliers s ON s.eik_raw IS a.contractor_eik
), window_annexes AS MATERIALIZED (
  SELECT * FROM staged_annexes
  WHERE source LIKE 'eop:%' AND unp IS NOT NULL AND annex_cnum IS NOT NULL
), window_unps AS (
  SELECT DISTINCT unp FROM window_annexes
), served_contracts AS MATERIALIZED (
  SELECT w.unp, c.id, c.contract_number, c.signing_value, c.currency,
    c.own_estimate_source, c.signing_currency_raw, c.signing_contractor_eik, c.signing_contractor_status
  FROM window_unps w CROSS JOIN contracts c ON c.tender_id = 't:' || w.unp
  WHERE c.contract_number IS NOT NULL
), admin_owners AS MATERIALIZED (
  SELECT DISTINCT unp, contract_number FROM served_contracts WHERE id NOT GLOB 'c:[eo]:*'
), staged_contracts AS MATERIALIZED (
  SELECT c.unp, c.contract_number, c.signing_value, c.currency,
    s.eik AS contractor_eik, s.evidence_status AS contractor_status
  FROM raw_contract_publications c
  JOIN suppliers s ON s.eik_raw IS c.contractor_eik
  WHERE c.unp IN (SELECT unp FROM window_unps) AND c.contract_number IS NOT NULL
    -- The daily OCDS promotion also respects already-served EOP and admin documents.
    AND (c.source NOT LIKE 'ocds:%' OR NOT EXISTS (
      SELECT 1 FROM contracts p
      WHERE p.contract_number = c.contract_number AND p.id NOT GLOB 'c:o:*'
    ))
), current_signings AS MATERIALIZED (
  SELECT *, 1 AS source_known FROM staged_contracts
  UNION ALL
  SELECT c.unp, c.contract_number, c.signing_value,
    CASE WHEN c.own_estimate_source IS NULL OR c.own_estimate_source = 'legacy:value_low'
      THEN c.currency ELSE c.signing_currency_raw END,
    c.signing_contractor_eik, c.signing_contractor_status, CASE
      WHEN c.id GLOB 'c:e:*' AND c.own_estimate_source LIKE 'eop:%' THEN 1
      WHEN c.id GLOB 'c:o:*' AND c.own_estimate_source LIKE 'ocds:%' THEN 1
      ELSE 0
    END
  FROM served_contracts c
  -- A staged change replaces served rows of its feed on this key, even if the current
  -- signing is NULL, zero, or missing currency. EOP also removes OCDS by document number.
  WHERE NOT EXISTS (
    SELECT 1 FROM raw_contracts r
    WHERE r.contract_number = c.contract_number AND (
      (c.id GLOB 'c:e:*' AND r.source LIKE 'eop:%' AND r.unp = c.unp)
      OR (c.id GLOB 'c:o:*' AND (r.source LIKE 'eop:%' OR (r.source LIKE 'ocds:%' AND r.unp = c.unp)))
    )
  )
), grp AS (
  -- A number match takes precedence regardless of signing value.
  SELECT a.*
  FROM window_annexes a
  WHERE NOT EXISTS (
    SELECT 1 FROM current_signings c WHERE c.unp = a.unp AND c.contract_number = a.annex_cnum
  )
), witnesses AS (
  SELECT amendment_id, unp, annex_cnum, value_before, currency, contractor_eik, contractor_status,
    NULL AS served_owner, natural_key
  FROM grp
  UNION ALL
  SELECT NULL, k.unp, k.annex_cnum, a.value_before, a.currency, a.value_anchor_contractor_eik,
    a.contractor_id_status, a.contract_number, a.natural_key
  FROM (SELECT DISTINCT unp, annex_cnum FROM grp) k
  CROSS JOIN amendments a ON a.unp = k.unp AND a.contract_number_raw = k.annex_cnum
  WHERE a.link_method = 'value_anchor' AND a.value_anchor_kind = 'direct'
    AND a.source LIKE 'eop:%' AND a.contract_number IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM staged_annexes staged WHERE staged.natural_key = a.natural_key
    )
), matches AS (
  SELECT w.amendment_id, w.unp, w.annex_cnum, w.served_owner,
    MIN(c.contract_number) AS resolved_cnum, COUNT(DISTINCT c.contract_number) AS n_match,
    MAX(CASE WHEN c.source_known = 1 AND p.contract_number IS NULL
      AND w.contractor_status IN ('absent', 'valid')
      AND c.contractor_status IN ('absent', 'valid') THEN 1 ELSE 0 END) AS has_proof
  FROM witnesses w
  JOIN current_signings c
    ON c.unp = w.unp AND c.currency = w.currency AND c.currency <> ''
    AND c.signing_value > 0 AND ABS(c.signing_value - w.value_before) < 0.005
    AND (w.contractor_eik IS NULL OR c.contractor_eik IS NULL OR w.contractor_eik = c.contractor_eik)
  -- Alternate-number links are applied by procedure and filing number. When a
  -- surviving admin shares that key, a value match cannot prove which physical
  -- signing the link would reach. Keep that owner in the set of possibilities.
  LEFT JOIN admin_owners p ON p.unp = c.unp AND p.contract_number = c.contract_number
  WHERE w.value_before > 0
  GROUP BY w.amendment_id, w.unp, w.annex_cnum, w.served_owner, w.natural_key
), direct AS (
  -- Legacy signings may indicate ambiguity, but lack original evidence to prove a match.
  SELECT amendment_id, unp, annex_cnum, resolved_cnum
  FROM matches
  WHERE n_match = 1 AND has_proof = 1
    AND (served_owner IS NULL OR served_owner = resolved_cnum)
), group_target AS (
  SELECT unp, annex_cnum, MIN(resolved_cnum) AS resolved_cnum
  -- An unverified or ambiguous match can veto inheritance to a different owner.
  -- At least one current direct witness must prove the sole possible owner.
  FROM matches GROUP BY unp, annex_cnum
  HAVING MAX(n_match) = 1 AND COUNT(DISTINCT resolved_cnum) = 1
    AND MAX(has_proof = 1 AND (served_owner IS NULL OR served_owner = resolved_cnum)) = 1
)
-- A member's own unique match stands even if the chain disagrees. An ambiguous
-- member cannot inherit. A previously served row is rekeyed only on publication replay.
SELECT a.amendment_id, a.annex_cnum, COALESCE(d.resolved_cnum, gt.resolved_cnum) AS resolved_cnum,
  CASE WHEN d.resolved_cnum IS NOT NULL THEN 'direct'
       WHEN gt.resolved_cnum IS NOT NULL THEN 'inherited' END AS value_anchor_kind
FROM window_annexes a
LEFT JOIN grp g ON g.amendment_id = a.amendment_id
LEFT JOIN matches m ON m.amendment_id = g.amendment_id
LEFT JOIN direct d ON d.amendment_id = g.amendment_id
LEFT JOIN group_target gt ON gt.unp = g.unp AND gt.annex_cnum = g.annex_cnum
  AND g.contractor_status IN ('absent', 'valid') AND COALESCE(m.has_proof, 1) = 1
WHERE g.amendment_id IS NOT NULL OR a.link_method = 'value_anchor';

UPDATE raw_amendments AS a
SET
  contract_number_raw = CASE WHEN r.resolved_cnum IS NOT NULL THEN r.annex_cnum END,
  link_method = CASE WHEN r.resolved_cnum IS NOT NULL THEN 'value_anchor' END,
  value_anchor_kind = r.value_anchor_kind,
  contract_number = COALESCE(r.resolved_cnum, r.annex_cnum)
FROM refresh_amendment_contract_resolve r
WHERE a.id = r.amendment_id AND (r.resolved_cnum IS NOT NULL OR a.link_method = 'value_anchor');

DROP TABLE IF EXISTS refresh_amendment_contract_resolve;

-- #286: prefer the EOP annex — drop OCDS twins so annex_count and the served timeline aren't doubled.
-- The full path (derive-amendments.sql) only checks raw_amendments because it re-stages the whole corpus
-- every run. The slice path must ALSO consult the cumulative served `amendments`: an EOP annex promoted by
-- an EARLIER window is not in this window's raw_amendments, yet its OCDS twin must still be dropped, or the
-- INSERT OR REPLACE promotion below (keyed by a natural_key that never matches across sources) would leave
-- both rows and double annex_count (issue #286, review nikimilenkov HIGH 1).
DELETE FROM raw_amendments
WHERE source LIKE 'ocds:%'
  AND (
    EXISTS (
      SELECT 1 FROM raw_amendments e
      WHERE e.source LIKE 'eop:%'
        AND e.unp = raw_amendments.unp
        AND e.contract_number = raw_amendments.contract_number
    )
    OR EXISTS (
      SELECT 1 FROM amendments s
      WHERE s.source LIKE 'eop:%'
        AND s.unp = raw_amendments.unp
        AND s.contract_number = raw_amendments.contract_number
    )
  );

DELETE FROM raw_contract_value_scope;
INSERT INTO raw_contract_value_scope
SELECT unp, contract_number FROM raw_contracts
WHERE unp IS NOT NULL AND contract_number IS NOT NULL
  AND (source LIKE 'eop:%' OR source LIKE 'ocds:%')
UNION
SELECT unp, contract_number FROM raw_amendments
WHERE unp IS NOT NULL AND contract_number IS NOT NULL;

DELETE FROM raw_contract_value_annexes;
INSERT INTO raw_contract_value_annexes SELECT * FROM raw_contract_value_staged_annexes;
-- Match promotion's source precedence and publication-key replacement in the price input.
INSERT OR IGNORE INTO raw_contract_value_annexes
SELECT a.natural_key, a.unp, a.contract_number, a.value_before, a.raw_value_after, a.value_after,
  a.raw_value_delta, a.currency, a.published_at, a.value_treatment, a.value_restated,
  a.value_evidence_known, a.value_suspect
FROM raw_contract_value_scope k
CROSS JOIN amendments a ON a.unp = k.unp AND a.contract_number = k.contract_number
WHERE a.source NOT LIKE 'ocds:%' OR NOT EXISTS (
  SELECT 1 FROM raw_amendments e
  WHERE e.unp = k.unp AND e.contract_number = k.contract_number AND e.source LIKE 'eop:%'
);

CREATE TABLE refresh_amendment_winners AS
WITH winners AS (
  SELECT natural_key, unp, contract_number, currency, effective_after,
    COUNT(*) OVER (PARTITION BY unp, contract_number) AS annex_count,
    ROW_NUMBER() OVER (
      PARTITION BY unp, contract_number
      ORDER BY effective_after IS NULL, published_at DESC, natural_key DESC
    ) AS win_rn
  FROM raw_contract_value_annexes
)
SELECT natural_key, unp, contract_number, currency, effective_after, annex_count
FROM winners WHERE win_rn = 1;
CREATE INDEX idx_refresh_amendment_winners
  ON refresh_amendment_winners(unp, contract_number);

-- @refresh-batch setup
-- Invalidate the freshness markers BEFORE anything is rebuilt; `@refresh-batch globals` writes the true
-- values back at the end. The groups below run as separate batches with nothing transactional spanning
-- them, so a failure part-way through leaves the domain tables advanced while `data_freshness` and
-- `home_totals` still advertise the PREVIOUS slice — a reader is then told a date that is confidently
-- wrong rather than unknown. Nulling `as_of` first makes an interrupted refresh read as „unknown slice":
-- getCoverageMeta already coalesces a missing as_of to null, and the ETL catch-up planner falls back to
-- raw_contracts. Only `as_of` is touched: `refreshed_at` is NOT NULL, and the row counts stay readable.
UPDATE data_freshness SET as_of = NULL;
UPDATE home_totals SET as_of = NULL;

-- The base-wins dedup probes contracts by АОП document number — index it (no-op if already present).
CREATE INDEX IF NOT EXISTS idx_contracts_cnum ON contracts(contract_number);
CREATE INDEX IF NOT EXISTS idx_contracts_tender_id ON contracts(tender_id);

-- Per-window scratch: rebuilt from THIS window's raw rows, so dropping them is right.
DROP TABLE IF EXISTS refresh_joint_tender_leads;
DROP TABLE IF EXISTS refresh_unp_prefix_authorities;
DROP TABLE IF EXISTS refresh_joint_authority_members;
DROP TABLE IF EXISTS refresh_joint_tender_sources;
-- The touched sets are the one kind of scratch that carries meaning ACROSS runs, so they are created IF
-- NOT EXISTS and never dropped or cleared here. Every batch that inserts or re-values a contract records
-- the contract/bidder/authority ids it touched, and company-totals / authority-totals recompute exactly
-- those ids. Each @refresh-batch is its own atomic D1 batch with nothing transactional spanning them, so
-- a run that dies between `contracts` and the rollups has ALREADY committed the new contracts and the ids
-- they touched — only the rollups are missing. Dropping the tables at the start of the next run (the
-- shape this file had until 2026-09-02) threw those ids away, and because the next window is a short
-- lookback the affected entities never got touched again: nineteen days of runs dying at `amendments`
-- (SQLITE_NOMEM, #342) left 276 authorities and 481 bidders with rollups that no longer summed to their
-- contracts (−139 M€ / −200 M€), tripping rollup-reconciliation on the first run that survived.
-- Kept across runs, an aborted run's ids simply ride into the next run's union and are recomputed.
-- Carrying a stale id is harmless by construction: every reader of these tables is an idempotent
-- recompute from served or reference tables (region from nuts_regions, rollups and the contract search
-- index DELETE+INSERT from contracts), never a rebuild from this window's raw rows.
-- Lifecycle: created here → filled by the batches below → consumed by the rollups → dropped ONLY by
-- `@refresh-batch cleanup` after every reader. dropTransientStagingStatements() (the abort path in
-- packages/ingest/src/refresh.ts) deliberately leaves them alone, and the Worker refuses to skip the
-- derive on an empty window while any of them still holds rows (pendingTouchedRows). All of that is
-- pinned by packages/ingest/src/refresh-touched-durability.test.ts.
CREATE TABLE IF NOT EXISTS refresh_touched_contracts (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS refresh_touched_bidders (bidder_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS refresh_touched_authorities (authority_id TEXT PRIMARY KEY);

-- @refresh-batch ocds-publication
-- @ocds-party-publication start
-- Keep supplier-role knowledge monotonic for exact source appearances. Stage the screening
-- result once so publication and authority projection use the same decision.
DELETE FROM raw_ocds_party_screening;
INSERT INTO raw_ocds_party_screening (party_row_id, evidence_status)
SELECT p.id, s.evidence_status
FROM raw_ocds_parties p
JOIN raw_supplier_evidence s ON s.eik_raw IS p.eik
WHERE p.is_supplier = 1;

INSERT OR IGNORE INTO ocds_supplier_appearances (appearance)
SELECT p.appearance
FROM raw_ocds_party_screening s JOIN raw_ocds_parties p ON p.id = s.party_row_id
WHERE s.evidence_status = 'unverified' AND p.appearance IS NOT NULL;

INSERT OR IGNORE INTO raw_ocds_party_screening (party_row_id, evidence_status)
SELECT p.id, 'unverified'
FROM raw_ocds_parties p JOIN ocds_supplier_appearances f ON f.appearance = p.appearance
WHERE p.is_supplier = 0;

INSERT OR REPLACE INTO parties (
  party_key, eik, source, ocid, party_id, name, street_address, locality, region_nuts,
  contact_email, contact_phone
)
SELECT party_key, eik, source, ocid, party_id, name, street_address, locality, region_nuts,
  contact_email, contact_phone
FROM raw_serving_ocds_parties;
DELETE FROM parties WHERE party_key IN (SELECT party_key FROM raw_ocds_party_retirements);

-- Only a buyer matched to supplier evidence loses the raw authority identifier. The safe
-- key is scoped to the OCDS procedure. It cannot collide with a legacy auth: identifier.
DELETE FROM raw_ocds_authority_moves;
DELETE FROM raw_ocds_authority_keys;
INSERT INTO raw_ocds_authority_keys (contract_row_id, authority_id)
SELECT c.id, CASE WHEN NULLIF(c.unp, '') IS NOT NULL THEN 'ocds-auth:' || lower(hex(c.unp)) END
FROM raw_contracts c
LEFT JOIN ocds_supplier_appearances f ON f.appearance = c.buyer_appearance
WHERE f.appearance IS NOT NULL OR (
  c.buyer_is_supplier = 1 AND c.buyer_appearance IS NULL AND EXISTS (
    SELECT 1 FROM raw_ocds_parties p
    JOIN raw_ocds_party_screening s ON s.party_row_id = p.id
    WHERE p.source = c.source AND p.ocid IS c.unp AND p.eik IS c.authority_eik
      AND p.is_supplier = 1 AND s.evidence_status = 'unverified'
  )
);

-- @ocds-party-publication end

-- Repair an already-published relationship only when the recorded buyer appearance is
-- itself now known as an unverified supplier. A party-only packet can carry this proof.
INSERT INTO raw_ocds_authority_moves (tender_id, old_id, authority_id, name)
SELECT t.id, t.authority_id, 'ocds-auth:' || lower(hex(t.source_id)),
  COALESCE(
    (SELECT MIN(NULLIF(NULLIF(NULLIF(TRIM(c.ordering_unit_name), a.bulstat), ''), '(без име)'))
     FROM contracts c WHERE c.tender_id = t.id),
    '(без име)'
  )
FROM raw_ocds_party_screening s
JOIN raw_ocds_parties p ON p.id = s.party_row_id
JOIN ocds_tender_buyers b ON b.appearance = p.appearance
JOIN tenders t ON t.id = b.tender_id AND t.source_id = p.ocid AND t.authority_id = b.authority_id
JOIN authorities a ON a.id = t.authority_id
WHERE s.evidence_status = 'unverified' AND t.authority_id LIKE 'auth:%'
GROUP BY t.id;

INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT authority_id FROM raw_ocds_scoped_names;

-- @ocds-authority-names start
INSERT INTO authorities (id, name, bulstat)
SELECT authority_id, name, NULL FROM raw_ocds_scoped_names WHERE 1 = 1
ON CONFLICT(id) DO UPDATE SET name = excluded.name, type_group = NULL;
-- @ocds-authority-names end

INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT old_id FROM raw_ocds_authority_moves
UNION SELECT authority_id FROM raw_ocds_authority_moves;

INSERT OR IGNORE INTO refresh_touched_contracts (id)
SELECT m.contract_id FROM raw_ocds_contract_buyer_moves m
JOIN contracts c ON c.id = m.contract_id AND c.ordering_unit_name = m.bulstat;
UPDATE contracts SET ordering_unit_name = NULL
FROM raw_ocds_contract_buyer_moves m
WHERE contracts.id = m.contract_id AND contracts.ordering_unit_name = m.bulstat;
UPDATE ocds_contract_buyers SET authority_id = m.authority_id
FROM raw_ocds_contract_buyer_moves m WHERE ocds_contract_buyers.contract_id = m.contract_id;

UPDATE contracts SET ordering_unit_name = NULL
WHERE tender_id IN (SELECT tender_id FROM raw_ocds_authority_moves)
  AND ordering_unit_name = (SELECT bulstat FROM authorities a
    JOIN raw_ocds_authority_moves m ON m.old_id = a.id WHERE m.tender_id = contracts.tender_id);
UPDATE tenders SET authority_id = m.authority_id
FROM raw_ocds_authority_moves m WHERE m.tender_id = tenders.id;
UPDATE ocds_tender_buyers SET authority_id = m.authority_id
FROM raw_ocds_authority_moves m WHERE m.tender_id = ocds_tender_buyers.tender_id;

INSERT OR IGNORE INTO refresh_touched_contracts (id)
SELECT c.id FROM raw_ocds_authority_moves m JOIN contracts c ON c.tender_id = m.tender_id;
INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT DISTINCT c.bidder_id FROM raw_ocds_authority_moves m
JOIN contracts c ON c.tender_id = m.tender_id
WHERE c.bidder_id IS NOT NULL;
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT DISTINCT ca.authority_id
FROM contract_co_authorities ca
WHERE ca.contract_id IN (
  SELECT c.id FROM raw_ocds_authority_moves m JOIN contracts c ON c.tender_id = m.tender_id
);

-- An authority with independent references still represents those relationships. Retire
-- only a now-unused legacy authority and all of its serving artifacts in this batch.
DELETE FROM raw_ocds_authority_moves
WHERE EXISTS (SELECT 1 FROM tenders t WHERE t.authority_id = old_id)
   OR EXISTS (SELECT 1 FROM ocds_contract_buyers b WHERE b.authority_id = old_id)
   OR EXISTS (SELECT 1 FROM contract_co_authorities c WHERE c.authority_id = old_id)
   OR EXISTS (SELECT 1 FROM interest_link_authorities i WHERE i.authority_id = old_id);
DELETE FROM search_index WHERE rowid IN (
  SELECT s.rowid
  FROM (SELECT COUNT(*) AS n FROM raw_ocds_authority_moves HAVING COUNT(*) > 0) moves
  CROSS JOIN search_index s
  WHERE s.kind = 'authority' AND s.ref IN (SELECT old_id FROM raw_ocds_authority_moves)
);
DELETE FROM flow_pairs WHERE authority_id IN (SELECT old_id FROM raw_ocds_authority_moves);
DELETE FROM authority_totals WHERE authority_id IN (SELECT old_id FROM raw_ocds_authority_moves);
DELETE FROM authority_joint_participation WHERE authority_id IN (SELECT old_id FROM raw_ocds_authority_moves);
DELETE FROM authorities WHERE id IN (SELECT old_id FROM raw_ocds_authority_moves);

-- @refresh-batch authorities-bidders
-- ── 1) Authorities referenced by OCDS staging (new ones only; INSERT OR IGNORE) ────────────────────
DROP TABLE IF EXISTS authority_canonical_name;
CREATE TABLE authority_canonical_name (authority_eik TEXT PRIMARY KEY, canonical_name TEXT);
INSERT INTO authority_canonical_name (authority_eik, canonical_name)
SELECT authority_eik, authority_name
FROM (
  SELECT
    authority_eik,
    authority_name,
    ROW_NUMBER() OVER (
      PARTITION BY authority_eik
      ORDER BY
        cnt DESC,
        CASE WHEN authority_name GLOB '*[a-zа-я]*' THEN 0 ELSE 1 END,
        LENGTH(authority_name) DESC,
        authority_name
    ) AS rn
  FROM (
    SELECT authority_eik, authority_name, COUNT(*) AS cnt
    FROM (
      SELECT source, authority_eik, authority_name FROM raw_serving_contract_authorities
      UNION ALL
      SELECT source, authority_eik, authority_name FROM raw_tenders
    )
    WHERE (source LIKE 'eop:%' OR source LIKE 'ocds:%')
      AND authority_eik IS NOT NULL
      AND authority_eik NOT LIKE '%;%'
      AND authority_name IS NOT NULL AND TRIM(authority_name) <> ''
    GROUP BY authority_eik, authority_name
  )
)
WHERE rn = 1;

DROP TABLE IF EXISTS authority_canonical_type;
CREATE TABLE authority_canonical_type (authority_eik TEXT PRIMARY KEY, canonical_type TEXT);
INSERT INTO authority_canonical_type (authority_eik, canonical_type)
SELECT authority_eik, authority_type
FROM (
  SELECT
    authority_eik,
    authority_type,
    ROW_NUMBER() OVER (
      PARTITION BY authority_eik
      ORDER BY cnt DESC, authority_type
    ) AS rn
  FROM (
    SELECT authority_eik, authority_type, COUNT(*) AS cnt
    FROM (
      SELECT c.authority_eik, c.authority_type
      FROM raw_serving_contract_authorities c
      JOIN authority_canonical_name acn
        ON acn.authority_eik = c.authority_eik AND acn.canonical_name = c.authority_name
      WHERE c.source LIKE 'eop:%' OR c.source LIKE 'ocds:%'
      UNION ALL
      SELECT t.authority_eik, t.authority_type
      FROM raw_tenders t
      JOIN authority_canonical_name acn
        ON acn.authority_eik = t.authority_eik AND acn.canonical_name = t.authority_name
      WHERE t.source LIKE 'eop:%' OR t.source LIKE 'ocds:%'
    )
    WHERE authority_type IS NOT NULL AND TRIM(authority_type) <> ''
    GROUP BY authority_eik, authority_type
  )
)
WHERE rn = 1;

INSERT OR IGNORE INTO authorities (id, name, bulstat, type)
SELECT
  'auth:' || s.authority_eik,
  COALESCE(acn.canonical_name, s.authority_eik),
  s.authority_eik,
  act.canonical_type
FROM (
  SELECT authority_eik FROM raw_serving_contract_authorities
  WHERE (source LIKE 'eop:%' OR source LIKE 'ocds:%') AND authority_eik IS NOT NULL
    AND authority_eik NOT LIKE '%;%'
  UNION
  SELECT authority_eik FROM raw_tenders
  WHERE (source LIKE 'eop:%' OR source LIKE 'ocds:%') AND authority_eik IS NOT NULL
    AND authority_eik NOT LIKE '%;%'
) s
LEFT JOIN authority_canonical_name acn ON acn.authority_eik = s.authority_eik
LEFT JOIN authority_canonical_type act ON act.authority_eik = s.authority_eik;

-- Split joint EIK/name lists once for lead selection and bridge population. This is the scoped
-- mirror of normalize-raw.sql step 1a; it deliberately does not rewrite existing display names.
CREATE TABLE refresh_joint_tender_sources (
  unp TEXT PRIMARY KEY,
  authority_eiks TEXT NOT NULL,
  authority_name TEXT,
  authority_type TEXT
);
WITH observations AS (
  SELECT unp, authority_eik, authority_name, authority_type
  FROM raw_tenders
  WHERE unp IS NOT NULL AND authority_eik LIKE '%;%'
    AND (source LIKE 'eop:%' OR source LIKE 'ocds:%')
  UNION ALL
  SELECT unp, authority_eik, authority_name, authority_type
  FROM raw_serving_contract_authorities
  WHERE unp IS NOT NULL AND authority_eik LIKE '%;%'
    AND (source LIKE 'eop:%' OR source LIKE 'ocds:%')
), ranked AS (
  SELECT unp, authority_eik, authority_name, authority_type,
    ROW_NUMBER() OVER (
      PARTITION BY unp
      ORDER BY COUNT(*) DESC,
        CASE WHEN authority_name GLOB '*[a-zа-я]*' THEN 0 ELSE 1 END,
        LENGTH(COALESCE(authority_name, '')) DESC,
        authority_eik, COALESCE(authority_name, ''), COALESCE(authority_type, '')
    ) AS rn
  FROM observations
  GROUP BY unp, authority_eik, authority_name, authority_type
)
INSERT INTO refresh_joint_tender_sources (unp, authority_eiks, authority_name, authority_type)
SELECT unp, authority_eik, authority_name, authority_type FROM ranked WHERE rn = 1;

CREATE TABLE refresh_joint_authority_members (
  unp TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  member_name TEXT,
  authority_type TEXT,
  source_ordinal INTEGER NOT NULL,
  PRIMARY KEY (unp, authority_id)
);
WITH RECURSIVE split (
  unp, authority_eik, member_name, authority_type, source_ordinal, eik_rest, name_rest
) AS (
  SELECT
    unp,
    TRIM(CASE WHEN INSTR(authority_eiks, ';') > 0
      THEN SUBSTR(authority_eiks, 1, INSTR(authority_eiks, ';') - 1) ELSE authority_eiks END),
    TRIM(CASE WHEN INSTR(COALESCE(authority_name, ''), ';') > 0
      THEN SUBSTR(authority_name, 1, INSTR(authority_name, ';') - 1) ELSE authority_name END),
    authority_type,
    0,
    CASE WHEN INSTR(authority_eiks, ';') > 0
      THEN SUBSTR(authority_eiks, INSTR(authority_eiks, ';') + 1) ELSE '' END,
    CASE WHEN INSTR(COALESCE(authority_name, ''), ';') > 0
      THEN SUBSTR(authority_name, INSTR(authority_name, ';') + 1) ELSE '' END
  FROM refresh_joint_tender_sources
  UNION ALL
  SELECT
    unp,
    TRIM(CASE WHEN INSTR(eik_rest, ';') > 0
      THEN SUBSTR(eik_rest, 1, INSTR(eik_rest, ';') - 1) ELSE eik_rest END),
    TRIM(CASE WHEN INSTR(name_rest, ';') > 0
      THEN SUBSTR(name_rest, 1, INSTR(name_rest, ';') - 1) ELSE name_rest END),
    authority_type,
    source_ordinal + 1,
    CASE WHEN INSTR(eik_rest, ';') > 0
      THEN SUBSTR(eik_rest, INSTR(eik_rest, ';') + 1) ELSE '' END,
    CASE WHEN INSTR(name_rest, ';') > 0
      THEN SUBSTR(name_rest, INSTR(name_rest, ';') + 1) ELSE '' END
  FROM split
  WHERE TRIM(eik_rest) <> ''
)
-- Guard composite EIKs the split could not decompose (see normalize-raw.sql): a ';'-bearing member
-- is not a real single authority and must not seed a member row or an orphan 'auth:EIK1; EIK2'.
INSERT OR IGNORE INTO refresh_joint_authority_members
  (unp, authority_id, member_name, authority_type, source_ordinal)
SELECT unp, 'auth:' || authority_eik, NULLIF(member_name, ''), authority_type, source_ordinal
FROM split
WHERE authority_eik <> '' AND authority_eik NOT LIKE '%;%';

WITH name_counts AS (
  SELECT authority_id, member_name,
    ROW_NUMBER() OVER (
      PARTITION BY authority_id
      ORDER BY COUNT(*) DESC,
        CASE WHEN member_name GLOB '*[a-zа-я]*' THEN 0 ELSE 1 END,
        LENGTH(member_name) DESC, member_name
    ) AS rn
  FROM refresh_joint_authority_members
  WHERE member_name IS NOT NULL
  GROUP BY authority_id, member_name
), member_defaults AS (
  SELECT m.authority_id,
    COALESCE(n.member_name, SUBSTR(m.authority_id, 6)) AS authority_name,
    MIN(SUBSTR(m.authority_id, 6)) AS authority_eik,
    MAX(m.authority_type) AS authority_type
  FROM refresh_joint_authority_members m
  LEFT JOIN name_counts n ON n.authority_id = m.authority_id AND n.rn = 1
  GROUP BY m.authority_id
)
INSERT OR IGNORE INTO authorities (id, name, bulstat, type)
SELECT authority_id, authority_name, authority_eik, authority_type FROM member_defaults;

-- Learn the modal authority for each valid УНП prefix from the full existing tender history. Raw
-- staging contains only the touched slice here, so it cannot provide a stable corpus-wide map.
-- Only the prefixes this window's joint tenders ask for (the table's one reader joins on them): every
-- prefix of the history was a scan of all tenders and some four thousand rows written on each run.
-- `source_id` is unique, so each prefix's tenders are an index range: those starting `ppppp-`.
CREATE TABLE refresh_unp_prefix_authorities (
  prefix TEXT PRIMARY KEY,
  authority_eik TEXT NOT NULL
);
WITH wanted AS (
  SELECT DISTINCT SUBSTR(unp, 1, 5) AS prefix
  FROM refresh_joint_authority_members
  WHERE unp GLOB '[0-9][0-9][0-9][0-9][0-9]-*'
), prefix_observations AS (
  SELECT w.prefix, SUBSTR(t.authority_id, 6) AS authority_eik
  FROM wanted w
  CROSS JOIN tenders t ON t.source_id >= w.prefix || '-' AND t.source_id < w.prefix || '.'
  WHERE t.authority_id NOT LIKE '%;%'
    AND t.source_id GLOB '[0-9][0-9][0-9][0-9][0-9]-*'
), ranked AS (
  SELECT prefix, authority_eik,
    ROW_NUMBER() OVER (
      PARTITION BY prefix
      ORDER BY COUNT(*) DESC, authority_eik
    ) AS rn
  FROM prefix_observations
  GROUP BY prefix, authority_eik
)
INSERT INTO refresh_unp_prefix_authorities (prefix, authority_eik)
SELECT prefix, authority_eik FROM ranked WHERE rn = 1;

CREATE TABLE refresh_joint_tender_leads (
  unp TEXT PRIMARY KEY,
  authority_id TEXT NOT NULL REFERENCES authorities(id)
);
WITH standalone_observations AS (
  SELECT authority_eik, authority_name FROM raw_serving_contract_authorities
  WHERE authority_eik IS NOT NULL AND authority_eik NOT LIKE '%;%' AND authority_name IS NOT NULL
    AND (source LIKE 'eop:%' OR source LIKE 'ocds:%')
  UNION ALL
  SELECT authority_eik, authority_name FROM raw_tenders
  WHERE authority_eik IS NOT NULL AND authority_eik NOT LIKE '%;%' AND authority_name IS NOT NULL
    AND (source LIKE 'eop:%' OR source LIKE 'ocds:%')
), canonical_names AS (
  SELECT authority_eik, authority_name
  FROM (
    SELECT authority_eik, authority_name,
      ROW_NUMBER() OVER (
        PARTITION BY authority_eik
        ORDER BY COUNT(*) DESC,
          CASE WHEN authority_name GLOB '*[a-zа-я]*' THEN 0 ELSE 1 END,
          LENGTH(authority_name) DESC, authority_name
      ) AS rn
    FROM standalone_observations
    GROUP BY authority_eik, authority_name
  )
  WHERE rn = 1
), ranked AS (
  SELECT m.unp, m.authority_id,
    ROW_NUMBER() OVER (
      PARTITION BY m.unp
      ORDER BY CASE WHEN p.authority_eik = SUBSTR(m.authority_id, 6) THEN 0 ELSE 1 END,
        CASE WHEN c.authority_name = s.authority_name THEN 0 ELSE 1 END,
        m.source_ordinal, m.authority_id
    ) AS rn
  FROM refresh_joint_authority_members m
  JOIN refresh_joint_tender_sources s ON s.unp = m.unp
  LEFT JOIN canonical_names c ON c.authority_eik = SUBSTR(m.authority_id, 6)
  LEFT JOIN refresh_unp_prefix_authorities p
    ON p.prefix = CASE
      WHEN m.unp GLOB '[0-9][0-9][0-9][0-9][0-9]-*' THEN SUBSTR(m.unp, 1, 5)
    END
)
INSERT INTO refresh_joint_tender_leads (unp, authority_id)
SELECT unp, authority_id FROM ranked WHERE rn = 1;

-- type_group for any authority still missing it (covers the rows just inserted) — same heuristic as
-- normalize-raw.sql step 1b. It is a GLOBAL fill, so it can touch authorities outside this window;
-- record exactly the rows it is about to change, in this batch, BEFORE it changes them (afterwards
-- the predicate no longer identifies them).
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT id FROM authorities WHERE type_group IS NULL;
UPDATE authorities SET type_group = CASE
  WHEN name LIKE 'Община%' OR name LIKE 'ОБЩИНА%' OR name LIKE '%Столична община%' OR name LIKE '%СТОЛИЧНА ОБЩИНА%' THEN 'община'
  WHEN name LIKE 'Министерство%' OR name LIKE 'МИНИСТЕРСТВО%' THEN 'министерство'
  WHEN name LIKE '%болница%' OR name LIKE '%БОЛНИЦА%' OR name LIKE 'МБАЛ%' OR name LIKE '%МБАЛ%' OR name LIKE '%СБАЛ%' OR name LIKE '%ДКЦ%' OR name LIKE '%лечебно заведение%' THEN 'болница'
  WHEN name LIKE '%университет%' OR name LIKE '%УНИВЕРСИТЕТ%' OR name LIKE '%училище%' OR name LIKE '%УЧИЛИЩЕ%' OR name LIKE '%гимназия%' OR name LIKE '%ГИМНАЗИЯ%' OR name LIKE '%детска градина%' OR name LIKE '%ДЕТСКА ГРАДИНА%' OR name LIKE '%академия%' THEN 'образование'
  WHEN name LIKE '%агенция%' OR name LIKE '%Агенция%' OR name LIKE '%АГЕНЦИЯ%' THEN 'агенция'
  WHEN EXISTS (
    SELECT 1
    FROM (
      SELECT source, authority_eik, authority_type FROM raw_serving_contract_authorities
      UNION ALL
      SELECT source, authority_eik, authority_type FROM raw_tenders
    ) raw_authority_types
    WHERE (raw_authority_types.source LIKE 'eop:%' OR raw_authority_types.source LIKE 'ocds:%')
      AND raw_authority_types.authority_eik = authorities.bulstat
      AND (
        raw_authority_types.authority_type LIKE 'Публично предприятие%'
        OR raw_authority_types.authority_type LIKE 'Комунални услуги%'
      )
  ) THEN 'държавна компания'
  ELSE 'друго'
END
WHERE type_group IS NULL;

-- ── 2) Winning-contractor identity — derive the checksum and three-rung key once for this slice. ──
DROP TABLE IF EXISTS contractor_identity;
CREATE TABLE contractor_identity (
  eik_raw    TEXT,
  name_raw   TEXT,
  name_norm  TEXT,
  eik_clean  TEXT,
  eik_valid  INTEGER NOT NULL,
  eik_status TEXT NOT NULL,
  bidder_key TEXT NOT NULL,
  PRIMARY KEY (eik_raw, name_raw)
);

INSERT INTO contractor_identity (eik_raw, name_raw, name_norm, eik_clean, eik_valid, eik_status, bidder_key)
WITH suppliers AS MATERIALIZED (SELECT * FROM raw_supplier_evidence)
SELECT c.contractor_eik, c.contractor_name, c.contractor_name, s.eik, s.eik IS NOT NULL, s.evidence_status,
  CASE WHEN s.eik IS NOT NULL THEN 'eik:' || s.eik ELSE 'pending' END
FROM (
  SELECT DISTINCT contractor_eik, contractor_name FROM raw_contracts
  WHERE source LIKE 'eop:%' OR source LIKE 'ocds:%'
) c
JOIN suppliers s ON s.eik_raw IS c.contractor_eik;

UPDATE contractor_identity
SET name_norm = TRIM(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(name_norm, char(160), ' '), char(9), ' '), char(10), ' '), char(13), ' '), '  ', ' '), '  ', ' '), '  ', ' '));

UPDATE contractor_identity
SET name_norm = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(name_norm, '"', ''), '''', ''), '`', ''), '„', ''), '“', ''), '”', ''), '‚', ''), '‘', ''), '’', ''), '«', ''), '»', ''), '′', ''), '″', '');

UPDATE contractor_identity
SET name_norm = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(name_norm, '‐', '-'), '‑', '-'), '‒', '-'), '–', '-'), '—', '-'), '―', '-'), '−', '-'), char(173), ''), char(8203), '');

UPDATE contractor_identity
SET name_norm = TRIM(REPLACE(REPLACE(REPLACE(name_norm, '  ', ' '), '  ', ' '), '  ', ' '));

UPDATE contractor_identity
SET name_norm = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(name_norm, 'а', 'А'), 'б', 'Б'), 'в', 'В'), 'г', 'Г'), 'д', 'Д'), 'е', 'Е'), 'ж', 'Ж'), 'з', 'З'), 'и', 'И'), 'й', 'Й'), 'к', 'К'), 'л', 'Л'), 'м', 'М'), 'н', 'Н'), 'о', 'О');

UPDATE contractor_identity
SET name_norm = UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(name_norm, 'п', 'П'), 'р', 'Р'), 'с', 'С'), 'т', 'Т'), 'у', 'У'), 'ф', 'Ф'), 'х', 'Х'), 'ц', 'Ц'), 'ч', 'Ч'), 'ш', 'Ш'), 'щ', 'Щ'), 'ъ', 'Ъ'), 'ь', 'Ь'), 'ю', 'Ю'), 'я', 'Я'));

UPDATE contractor_identity
SET bidder_key = CASE
  WHEN eik_valid = 1 THEN bidder_key
  WHEN name_raw IS NOT NULL AND TRIM(name_raw) <> '' THEN 'name:' || name_norm
  ELSE 'unknown:анонимен'
END;

-- 4a-pre) Canonical display name by frequency mode (#251), rebuilt on top of the checksum-based
--   contractor_identity keys (#252). contractor_identity is DISTINCT-ed over (eik,name), so the
--   occurrence counts the mode needs must be re-derived from raw_contracts.
DROP TABLE IF EXISTS bidder_canonical_name;
CREATE TABLE bidder_canonical_name (bidder_key TEXT PRIMARY KEY, canonical_name TEXT);
INSERT INTO bidder_canonical_name (bidder_key, canonical_name)
SELECT bidder_key, name_raw
FROM (
  SELECT
    ci.bidder_key AS bidder_key,
    ci.name_raw AS name_raw,
    ROW_NUMBER() OVER (
      PARTITION BY ci.bidder_key
      ORDER BY
        r.cnt DESC,
        CASE WHEN ci.name_raw GLOB '*[a-zа-я]*' THEN 0 ELSE 1 END,
        LENGTH(ci.name_raw) DESC,
        ci.name_raw
    ) AS rn
  FROM contractor_identity ci
  JOIN (
    SELECT contractor_eik, contractor_name, COUNT(*) AS cnt
    FROM raw_contracts WHERE source LIKE 'eop:%' OR source LIKE 'ocds:%'
    GROUP BY contractor_eik, contractor_name
  ) r ON r.contractor_eik IS ci.eik_raw AND r.contractor_name IS ci.name_raw
  WHERE ci.name_raw IS NOT NULL AND TRIM(ci.name_raw) <> ''
)
WHERE rn = 1;

INSERT OR IGNORE INTO bidders (id, name, bulstat, eik_normalized, eik_valid, is_consortium, kind)
SELECT
  bidder_key,
  CASE WHEN bidder_key = 'unknown:анонимен' THEN 'Неизвестен изпълнител'
       ELSE COALESCE((SELECT bcn.canonical_name FROM bidder_canonical_name bcn WHERE bcn.bidder_key = contractor_identity.bidder_key), MIN(name_raw)) END,
  MIN(CASE WHEN eik_valid = 1 THEN eik_clean END),
  MIN(CASE WHEN eik_valid = 1 THEN eik_clean END),
  MAX(eik_valid),
  MAX(CASE
    WHEN name_raw LIKE '%;%'
      OR UPPER(name_raw) LIKE '%ДЗЗД%'
      OR UPPER(name_raw) LIKE '%ОБЕДИНЕНИЕ%'
      OR UPPER(name_raw) LIKE '%КОНСОРЦИУМ%'
    THEN 1 ELSE 0
  END),
  CASE
    WHEN bidder_key = 'unknown:анонимен' THEN 'unknown'
    WHEN MAX(CASE
      WHEN name_raw LIKE '%;%'
        OR UPPER(name_raw) LIKE '%ДЗЗД%'
        OR UPPER(name_raw) LIKE '%ОБЕДИНЕНИЕ%'
        OR UPPER(name_raw) LIKE '%КОНСОРЦИУМ%'
      THEN 1 ELSE 0
    END) = 1 THEN 'consortium'
    ELSE 'company'
  END
FROM contractor_identity
GROUP BY bidder_key
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  bulstat = COALESCE(bidders.bulstat, excluded.bulstat),
  eik_normalized = COALESCE(bidders.eik_normalized, excluded.eik_normalized),
  eik_valid = max(bidders.eik_valid, excluded.eik_valid),
  is_consortium = max(bidders.is_consortium, excluded.is_consortium),
  -- The parties to a framework agreement keep their kind; `@refresh-batch company-totals` settles it.
  kind = CASE
    WHEN bidders.kind = 'framework_parties' THEN bidders.kind
    WHEN max(bidders.is_consortium, excluded.is_consortium) = 1 THEN 'consortium'
    ELSE bidders.kind
  END;

-- Curated public-owned winner classification. Exact EIK matches cover the allowlist; a valid 13-digit
-- EIK is a branch and carries the ownership of the enterprise in its first nine digits.
CREATE TABLE IF NOT EXISTS state_owned_eik (
  eik TEXT PRIMARY KEY,
  ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('state', 'municipal', 'mixed')),
  canonical_name TEXT NOT NULL
);

UPDATE bidders
SET ownership_kind = (
  SELECT s.ownership_kind
  FROM state_owned_eik s
  WHERE bidders.eik_valid = 1
    AND (
      bidders.eik_normalized = s.eik
      -- A valid 13-digit EIK is a branch of the enterprise in its first nine digits.
      OR (length(bidders.eik_normalized) = 13 AND substr(bidders.eik_normalized, 1, 9) = s.eik)
    )
  LIMIT 1
);

-- Public ownership the Trade Register records (ADR-0047), derived by the registry workflow, for a company the
-- curated list does not name.
CREATE TABLE IF NOT EXISTS public_owned_eik (
  eik TEXT PRIMARY KEY,
  ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('state', 'municipal'))
);

UPDATE bidders
SET ownership_kind = (
  SELECT p.ownership_kind FROM public_owned_eik p
  WHERE p.eik = CASE WHEN length(bidders.eik_normalized) = 13 THEN substr(bidders.eik_normalized, 1, 9)
                     ELSE bidders.eik_normalized END
)
WHERE ownership_kind IS NULL AND eik_valid = 1
  AND (eik_normalized IN (SELECT eik FROM public_owned_eik)
       OR (length(eik_normalized) = 13 AND substr(eik_normalized, 1, 9) IN (SELECT eik FROM public_owned_eik)));

INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT b.id
FROM bidders b
JOIN company_totals ct ON ct.bidder_id = b.id
WHERE ct.ownership_kind IS NOT b.ownership_kind;

-- Record in THIS batch what it upserted: every authority and bidder named by this window's raw rows
-- (names, ownership_kind, consortium flags flow into the rollup rows and the search index). The same
-- sets are recorded again downstream — harmless under OR IGNORE — but an abort right after this batch
-- must not lose them.
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT DISTINCT authority_id FROM refresh_joint_authority_members;
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT a.id
FROM authorities a
WHERE a.bulstat IN (
    SELECT authority_eik FROM raw_serving_contract_authorities WHERE authority_eik IS NOT NULL
    UNION
    SELECT authority_eik FROM raw_tenders WHERE authority_eik IS NOT NULL
    UNION
    SELECT eik FROM raw_ocds_parties WHERE eik IS NOT NULL
  );
INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT b.id
FROM bidders b
WHERE b.eik_normalized IN (SELECT eik FROM raw_ocds_parties WHERE eik IS NOT NULL)
  OR b.id IN (SELECT bidder_key FROM contractor_identity);
-- @refresh-batch tenders
-- Record the existing relationships before promoting an EOP header.
INSERT OR IGNORE INTO refresh_touched_contracts (id)
SELECT c.id
FROM raw_tenders t
JOIN contracts c ON c.tender_id = 't:' || t.unp;
INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT DISTINCT c.bidder_id
FROM contracts c
WHERE c.id IN (SELECT id FROM refresh_touched_contracts)
  AND c.bidder_id IS NOT NULL;
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT DISTINCT t.authority_id
FROM contracts c JOIN tenders t ON t.id = c.tender_id
WHERE c.id IN (SELECT id FROM refresh_touched_contracts)
  AND t.authority_id IS NOT NULL;

-- EOP tender headers and lots loaded since the last full normalize.
DELETE FROM ocds_contract_buyers
WHERE contract_id IN (
  SELECT c.id FROM raw_tenders t JOIN contracts c ON c.tender_id = 't:' || t.unp
  WHERE t.lot_id IS NULL
    AND EXISTS (
      SELECT 1 FROM authorities a WHERE a.id = COALESCE(
        (SELECT j.authority_id FROM refresh_joint_tender_leads j WHERE j.unp = t.unp),
        'auth:' || t.authority_eik
      )
    )
);

DELETE FROM ocds_tender_buyers
WHERE tender_id IN (
  SELECT 't:' || t.unp FROM raw_tenders t
  WHERE t.lot_id IS NULL
    AND EXISTS (
      SELECT 1 FROM authorities a WHERE a.id = COALESCE(
        (SELECT j.authority_id FROM refresh_joint_tender_leads j WHERE j.unp = t.unp),
        'auth:' || t.authority_eik
      )
    )
);

DELETE FROM synthetic_tenders_awaiting_buyer
WHERE tender_id IN (
  SELECT 't:' || t.unp FROM raw_tenders t
  WHERE t.lot_id IS NULL
    AND EXISTS (
      SELECT 1 FROM authorities a WHERE a.id = COALESCE(
        (SELECT j.authority_id FROM refresh_joint_tender_leads j WHERE j.unp = t.unp),
        'auth:' || t.authority_eik
      )
    )
);

INSERT INTO tenders
  (id, source_id, title, authority_id, ordering_unit_name, cpv_code, cpv_description, estimated_value, currency,
   procedure_type, contract_kind, num_lots, status, published_at, deadline_at,
   legal_basis, award_criteria, main_activity, notice_type,
   place_of_performance, start_date, end_date, duration, duration_unit,
   eu_programme, green, social, innovation, eauction, cancelled, eop_tender_id)
SELECT
  't:' || t.unp,
  t.unp,
  COALESCE(t.procurement_subject, '(без предмет)'),
  COALESCE((SELECT j.authority_id FROM refresh_joint_tender_leads j WHERE j.unp = t.unp),
    'auth:' || t.authority_eik),
  NULLIF(TRIM(t.authority_name), ''),
  t.cpv_code,
  t.cpv_description,
  t.estimated_value,
  COALESCE(t.currency, 'BGN'),
  COALESCE(t.procedure_type, 'неизвестна'),
  t.contract_kind,
  t.num_lots,
  CASE WHEN EXISTS (SELECT 1 FROM raw_contracts c WHERE c.unp = t.unp) THEN 'awarded' ELSE 'published' END,
  t.published_at,
  t.deadline,
  t.legal_basis,
  t.award_criteria,
  t.main_activity,
  t.notice_type,
  t.place_of_performance,
  t.start_date,
  t.end_date,
  t.duration,
  t.duration_unit,
  t.eu_programme,
  t.green,
  t.social,
  t.innovation,
  t.eauction,
  t.cancelled,
  NULLIF(t.tender_id, '')                 -- raw EOP numeric tenderId from the header row
FROM raw_tenders t
WHERE t.lot_id IS NULL
  AND EXISTS (
    SELECT 1 FROM authorities a
    WHERE a.id = COALESCE(
      (SELECT j.authority_id FROM refresh_joint_tender_leads j WHERE j.unp = t.unp),
      'auth:' || t.authority_eik
    )
  )
ON CONFLICT(id) DO UPDATE SET
  source_id = CASE WHEN tenders.procedure_type = 'неизвестна' THEN excluded.source_id ELSE tenders.source_id END,
  title = CASE WHEN tenders.procedure_type = 'неизвестна' THEN excluded.title ELSE tenders.title END,
  authority_id = CASE WHEN tenders.procedure_type = 'неизвестна' THEN excluded.authority_id ELSE tenders.authority_id END,
  ordering_unit_name = excluded.ordering_unit_name,
  cpv_code = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.cpv_code, tenders.cpv_code) ELSE tenders.cpv_code END,
  cpv_description = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.cpv_description, tenders.cpv_description) ELSE tenders.cpv_description END,
  estimated_value = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.estimated_value, tenders.estimated_value) ELSE tenders.estimated_value END,
  currency = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.currency, tenders.currency) ELSE tenders.currency END,
  procedure_type = CASE WHEN tenders.procedure_type = 'неизвестна' THEN excluded.procedure_type ELSE tenders.procedure_type END,
  contract_kind = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.contract_kind, tenders.contract_kind) ELSE tenders.contract_kind END,
  num_lots = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.num_lots, tenders.num_lots) ELSE tenders.num_lots END,
  status = CASE WHEN excluded.status = 'awarded' THEN 'awarded' ELSE tenders.status END,
  published_at = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.published_at, tenders.published_at) ELSE tenders.published_at END,
  deadline_at = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.deadline_at, tenders.deadline_at) ELSE tenders.deadline_at END,
  legal_basis = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.legal_basis, tenders.legal_basis) ELSE tenders.legal_basis END,
  award_criteria = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.award_criteria, tenders.award_criteria) ELSE tenders.award_criteria END,
  main_activity = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.main_activity, tenders.main_activity) ELSE tenders.main_activity END,
  notice_type = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.notice_type, tenders.notice_type) ELSE tenders.notice_type END,
  place_of_performance = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.place_of_performance, tenders.place_of_performance) ELSE tenders.place_of_performance END,
  start_date = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.start_date, tenders.start_date) ELSE tenders.start_date END,
  end_date = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.end_date, tenders.end_date) ELSE tenders.end_date END,
  duration = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.duration, tenders.duration) ELSE tenders.duration END,
  duration_unit = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.duration_unit, tenders.duration_unit) ELSE tenders.duration_unit END,
  eu_programme = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.eu_programme, tenders.eu_programme) ELSE tenders.eu_programme END,
  green = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.green, tenders.green) ELSE tenders.green END,
  social = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.social, tenders.social) ELSE tenders.social END,
  innovation = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.innovation, tenders.innovation) ELSE tenders.innovation END,
  eauction = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.eauction, tenders.eauction) ELSE tenders.eauction END,
  cancelled = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.cancelled, tenders.cancelled) ELSE tenders.cancelled END,
  -- Promoting a synthetic tender to real: the header's EOP id wins (it is the authoritative source),
  -- falling back to the contract-derived id only if the header lacks one. For a row that is already
  -- real, keep its id but backfill from the header if it was somehow missing.
  eop_tender_id = CASE WHEN tenders.procedure_type = 'неизвестна'
    THEN COALESCE(excluded.eop_tender_id, tenders.eop_tender_id)
    ELSE COALESCE(tenders.eop_tender_id, excluded.eop_tender_id) END;

INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT t.authority_id FROM raw_tenders h JOIN tenders t ON t.id = 't:' || h.unp
WHERE h.lot_id IS NULL;

-- @refresh-batch lots
INSERT OR IGNORE INTO lots (id, tender_id, title, cpv_code, estimated_value)
SELECT
  'lot:' || t.unp || ':' || CASE
    WHEN t.lot_id LIKE 'LOT-%' AND REPLACE(t.lot_id, 'LOT-', '') <> '' AND REPLACE(t.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(t.lot_id, 'LOT-', '') AS INTEGER)
    WHEN t.lot_id <> '' AND t.lot_id NOT GLOB '*[^0-9]*' THEN CAST(t.lot_id AS INTEGER)
    ELSE t.lot_id
  END,
  't:' || t.unp,
  COALESCE(t.lot_name, '(без предмет)'),
  t.cpv_code,
  t.estimated_value
FROM raw_tenders t
WHERE t.lot_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || t.unp);

-- @refresh-batch enrich-authorities
-- Party/contact enrichment for entities touched by the refreshed staging. The five fields are computed for
-- every authority with a party, as before, but a row is written only when one of them changes: rewriting
-- each such authority on every run, though nearly none had changed, made this one of the refresh's
-- larger writers. The same holds for the bidders below.
WITH fresh AS (
  SELECT a.id,
    COALESCE((SELECT p.region_nuts FROM parties p WHERE p.eik = a.bulstat AND NULLIF(p.region_nuts, '') IS NOT NULL
      ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), a.nuts) AS nuts,
    COALESCE((SELECT p.locality FROM parties p WHERE p.eik = a.bulstat AND NULLIF(p.locality, '') IS NOT NULL
      ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), a.settlement) AS settlement,
    COALESCE((SELECT p.street_address FROM parties p WHERE p.eik = a.bulstat AND NULLIF(p.street_address, '') IS NOT NULL
      ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), a.address) AS address,
    COALESCE((SELECT p.contact_email FROM parties p WHERE p.eik = a.bulstat AND NULLIF(p.contact_email, '') IS NOT NULL
      ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), a.contact_email) AS contact_email,
    COALESCE((SELECT p.contact_phone FROM parties p WHERE p.eik = a.bulstat AND NULLIF(p.contact_phone, '') IS NOT NULL
      ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), a.contact_phone) AS contact_phone
  FROM authorities a
  WHERE EXISTS (SELECT 1 FROM parties p WHERE p.eik = a.bulstat)
)
UPDATE authorities
SET nuts = f.nuts, settlement = f.settlement, address = f.address,
  contact_email = f.contact_email, contact_phone = f.contact_phone
FROM fresh f
WHERE f.id = authorities.id
  AND (authorities.nuts IS NOT f.nuts OR authorities.settlement IS NOT f.settlement OR authorities.address IS NOT f.address
    OR authorities.contact_email IS NOT f.contact_email OR authorities.contact_phone IS NOT f.contact_phone);

-- Same batch as the UPDATE above: settlement/region/contact land in authority_totals.
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT a.id
FROM authorities a
WHERE a.bulstat IN (
    SELECT authority_eik FROM raw_contracts WHERE authority_eik IS NOT NULL
    UNION
    SELECT authority_eik FROM raw_tenders WHERE authority_eik IS NOT NULL
    UNION
    SELECT eik FROM raw_ocds_parties WHERE eik IS NOT NULL
  );
-- @refresh-batch enrich-bidders
WITH fresh AS (
  SELECT b.id,
    COALESCE((SELECT p.region_nuts FROM parties p WHERE p.eik = b.eik_normalized AND NULLIF(p.region_nuts, '') IS NOT NULL
      ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), b.nuts) AS nuts,
    COALESCE((SELECT p.locality FROM parties p WHERE p.eik = b.eik_normalized AND NULLIF(p.locality, '') IS NOT NULL
      ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), b.settlement) AS settlement,
    COALESCE((SELECT p.street_address FROM parties p WHERE p.eik = b.eik_normalized AND NULLIF(p.street_address, '') IS NOT NULL
      ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), b.address) AS address,
    COALESCE((SELECT p.contact_email FROM parties p WHERE p.eik = b.eik_normalized AND NULLIF(p.contact_email, '') IS NOT NULL
      ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), b.contact_email) AS contact_email,
    COALESCE((SELECT p.contact_phone FROM parties p WHERE p.eik = b.eik_normalized AND NULLIF(p.contact_phone, '') IS NOT NULL
      ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), b.contact_phone) AS contact_phone
  FROM bidders b
  WHERE EXISTS (SELECT 1 FROM parties p WHERE p.eik = b.eik_normalized)
)
UPDATE bidders
SET nuts = f.nuts, settlement = f.settlement, address = f.address,
  contact_email = f.contact_email, contact_phone = f.contact_phone
FROM fresh f
WHERE f.id = bidders.id
  AND (bidders.nuts IS NOT f.nuts OR bidders.settlement IS NOT f.settlement OR bidders.address IS NOT f.address
    OR bidders.contact_email IS NOT f.contact_email OR bidders.contact_phone IS NOT f.contact_phone);

-- Same batch as the UPDATE above: settlement lands in company_totals.
INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT b.id
FROM bidders b
WHERE b.eik_normalized IN (SELECT eik FROM raw_ocds_parties WHERE eik IS NOT NULL)
  OR b.id IN (SELECT bidder_key FROM contractor_identity);
-- @refresh-batch touch-entities
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT a.id
FROM authorities a
WHERE a.bulstat IN (
    SELECT authority_eik FROM raw_contracts WHERE authority_eik IS NOT NULL
    UNION
    SELECT authority_eik FROM raw_tenders WHERE authority_eik IS NOT NULL
    UNION
    SELECT eik FROM raw_ocds_parties WHERE eik IS NOT NULL
  );

-- @refresh-batch authority-region
-- Re-label a touched authority from its NUTS code — the SAME result a full rebuild gives, so the two
-- paths converge: region is only ever derived from nuts (normalize-raw.sql step 7 fills it from the
-- same lookup on a rebuilt table), so a code with no mapping yields NULL there and must yield NULL
-- here too, even for an id carried over from an aborted run. Only an authority with NO code is left
-- alone: there is nothing to derive from, and a rebuild would not touch it either.
UPDATE authorities
SET region = (SELECT n.nuts3_name FROM nuts_regions n WHERE n.nuts3 = authorities.nuts)
WHERE id IN (SELECT authority_id FROM refresh_touched_authorities)
  AND nuts IS NOT NULL;

-- @refresh-batch lot-values
CREATE INDEX IF NOT EXISTS idx_raw_tenders_tender_id ON raw_tenders(tender_id);
-- `rn = 1` is applied inside `mapped`, not next to the join. Outside, it was the only equality on the CTE the
-- planner could index, so it scanned every served lot and, for each, every first-ranked row of the window:
-- the most expensive statement of the refresh (≈ 100 million rows read per run). Filtered inside, the window's
-- lots drive the update and each finds its row by the primary key; `lots.id IN (…)` keeps that order should
-- the planner reconsider. A lot with both values already set is skipped — COALESCE could only rewrite them.
WITH mapped AS (
  SELECT domain_lot_id, value_amount, value_currency
  FROM (
    SELECT
      'lot:' || rt.unp || ':' || CASE
        WHEN rl.lot_id LIKE 'LOT-%' AND REPLACE(rl.lot_id, 'LOT-', '') <> '' AND REPLACE(rl.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(rl.lot_id, 'LOT-', '') AS INTEGER)
        WHEN rl.lot_id <> '' AND rl.lot_id NOT GLOB '*[^0-9]*' THEN CAST(rl.lot_id AS INTEGER)
        ELSE rl.lot_id
      END AS domain_lot_id,
      rl.value_amount,
      rl.value_currency,
      ROW_NUMBER() OVER (
        PARTITION BY 'lot:' || rt.unp || ':' || CASE
          WHEN rl.lot_id LIKE 'LOT-%' AND REPLACE(rl.lot_id, 'LOT-', '') <> '' AND REPLACE(rl.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(rl.lot_id, 'LOT-', '') AS INTEGER)
          WHEN rl.lot_id <> '' AND rl.lot_id NOT GLOB '*[^0-9]*' THEN CAST(rl.lot_id AS INTEGER)
          ELSE rl.lot_id
        END
        ORDER BY rl.id DESC
      ) AS rn
    FROM raw_ocds_lots rl
    JOIN raw_tenders rt ON rt.tender_id = rl.tender_id
    WHERE rl.tender_id IS NOT NULL
      AND rl.lot_id IS NOT NULL
      AND rt.unp IS NOT NULL
  )
  WHERE rn = 1
)
UPDATE lots
SET
  value_amount = COALESCE(lots.value_amount, mapped.value_amount),
  value_currency = COALESCE(lots.value_currency, mapped.value_currency)
FROM mapped
WHERE mapped.domain_lot_id = lots.id
  AND lots.id IN (SELECT domain_lot_id FROM mapped)
  AND (lots.value_amount IS NULL OR lots.value_currency IS NULL);

-- @refresh-batch contracts
-- ── 3) Synthetic 'неизвестна' tenders for contract-only procedures — matches normalize step 2b ──
-- Fold procedure metadata before valuation, which uses its estimate. Record which
-- synthetic parents are new so an existing buyer owned by another source stays protected.
DELETE FROM raw_new_synthetic_tenders;
INSERT INTO raw_new_synthetic_tenders
SELECT DISTINCT 't:' || c.unp
FROM raw_contracts c
WHERE c.unp IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM tenders t WHERE t.id = 't:' || c.unp)
  AND NOT EXISTS (SELECT 1 FROM raw_tenders h WHERE h.unp = c.unp);

WITH folded AS (
  SELECT
    c.unp,
    MIN(c.procurement_subject) AS raw_title,
    COALESCE(
      (SELECT j.authority_id FROM refresh_joint_tender_leads j WHERE j.unp = c.unp),
      CASE WHEN NOT MAX(c.source LIKE 'eop:%' AND eligible.id IS NOT NULL) THEN
        MIN(CASE WHEN c.source LIKE 'ocds:%' THEN eligible.id END)
      END,
      CASE WHEN MAX(c.source LIKE 'ocds:%') THEN
        MIN(CASE WHEN c.source LIKE 'eop:%' THEN a.authority_id END)
      END,
      MIN(a.authority_id)
    ) AS authority_id,
    MIN(c.cpv_code) AS cpv_code,
    MIN(c.estimated_value) AS estimated_value,
    MIN(c.currency) AS raw_currency,
    MIN(c.contract_kind) AS contract_kind,
    MIN(c.legal_basis) AS legal_basis,
    MIN(c.award_criteria) AS award_criteria,
    MIN(NULLIF(c.tender_ext_id, '')) AS eop_tender_id  -- synthetic tenders inherit the EOP id from contracts
  FROM raw_contracts c
  JOIN raw_serving_contract_authorities a ON a.id = c.id
  LEFT JOIN authorities eligible ON eligible.id = a.authority_id
  WHERE (c.source LIKE 'eop:%' OR c.source LIKE 'ocds:%')
    AND c.unp IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM raw_tenders t WHERE t.unp = c.unp)
  GROUP BY c.unp
)
INSERT INTO tenders
  (id, source_id, title, authority_id, cpv_code, estimated_value, currency,
   procedure_type, contract_kind, status, legal_basis, award_criteria, eop_tender_id)
SELECT
  't:' || unp,
  unp,
  COALESCE(raw_title, '(без предмет)'),
  authority_id,
  cpv_code,
  estimated_value,
  COALESCE(raw_currency, 'BGN'),
  'неизвестна',
  contract_kind,
  'awarded',
  legal_basis,
  award_criteria,
  eop_tender_id
FROM folded
WHERE EXISTS (SELECT 1 FROM authorities a WHERE a.id = folded.authority_id)
ON CONFLICT(id) DO UPDATE SET
  title = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.title = '(без предмет)' THEN tenders.title
      WHEN tenders.title = '(без предмет)' THEN excluded.title
      ELSE min(tenders.title, excluded.title)
    END
    ELSE tenders.title END,
  cpv_code = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.cpv_code IS NULL THEN tenders.cpv_code
      WHEN tenders.cpv_code IS NULL THEN excluded.cpv_code
      ELSE min(tenders.cpv_code, excluded.cpv_code)
    END
    ELSE tenders.cpv_code END,
  estimated_value = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.estimated_value IS NULL THEN tenders.estimated_value
      WHEN tenders.estimated_value IS NULL THEN excluded.estimated_value
      ELSE min(tenders.estimated_value, excluded.estimated_value)
    END
    ELSE tenders.estimated_value END,
  currency = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.currency = 'BGN' AND tenders.currency <> 'BGN' THEN tenders.currency
      WHEN tenders.currency = 'BGN' AND excluded.currency <> 'BGN' THEN excluded.currency
      ELSE min(tenders.currency, excluded.currency)
    END
    ELSE tenders.currency END,
  contract_kind = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.contract_kind IS NULL THEN tenders.contract_kind
      WHEN tenders.contract_kind IS NULL THEN excluded.contract_kind
      ELSE min(tenders.contract_kind, excluded.contract_kind)
    END
    ELSE tenders.contract_kind END,
  legal_basis = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.legal_basis IS NULL THEN tenders.legal_basis
      WHEN tenders.legal_basis IS NULL THEN excluded.legal_basis
      ELSE min(tenders.legal_basis, excluded.legal_basis)
    END
    ELSE tenders.legal_basis END,
  award_criteria = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.award_criteria IS NULL THEN tenders.award_criteria
      WHEN tenders.award_criteria IS NULL THEN excluded.award_criteria
      ELSE min(tenders.award_criteria, excluded.award_criteria)
    END
    ELSE tenders.award_criteria END,
  eop_tender_id = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.eop_tender_id IS NULL THEN tenders.eop_tender_id
      WHEN tenders.eop_tender_id IS NULL THEN excluded.eop_tender_id
      ELSE min(tenders.eop_tender_id, excluded.eop_tender_id)
    END
    ELSE tenders.eop_tender_id END;

-- 4) Contracts - replace rows represented by the transient window, then re-derive deltas.
DROP TABLE IF EXISTS raw_contract_value_existing;
CREATE TABLE raw_contract_value_existing AS
SELECT id, tender_id, amount FROM contracts
WHERE id IN (
  SELECT DISTINCT c.id
  FROM raw_contracts r
  JOIN contracts c ON c.contract_number = r.contract_number AND c.tender_id = 't:' || r.unp
  WHERE r.contract_number IS NOT NULL
    AND c.id GLOB 'c:[eo]:*'
    AND (
      (c.id LIKE 'c:e:%' AND r.source LIKE 'eop:%')
      OR (c.id LIKE 'c:o:%' AND r.source LIKE 'ocds:%')
    )
  UNION
  SELECT DISTINCT c.id
  FROM raw_contracts r
  JOIN contracts c ON c.contract_number IS NULL AND c.tender_id = 't:' || r.unp
  WHERE r.contract_number IS NULL
    AND c.id GLOB 'c:[eo]:*'
    AND (
      (c.id LIKE 'c:e:%' AND r.source LIKE 'eop:%')
      OR (c.id LIKE 'c:o:%' AND r.source LIKE 'ocds:%')
    )
  -- EOP suppresses the served OCDS twin by document number, including when the
  -- EOP row has no admissible value or is served under a different tender key.
  UNION
  SELECT DISTINCT c.id
  FROM raw_contracts e
  JOIN contracts c ON c.contract_number = e.contract_number
  WHERE e.source LIKE 'eop:%'
    AND e.contract_number IS NOT NULL
    AND c.id GLOB 'c:o:*'
  UNION
  SELECT DISTINCT c.id
  FROM raw_contracts e
  JOIN contracts c ON c.contract_number IS NULL
  WHERE e.source LIKE 'eop:%'
    AND e.contract_number IS NULL
    AND c.id GLOB 'c:o:*'
);
CREATE UNIQUE INDEX idx_raw_contract_value_existing ON raw_contract_value_existing(id);
INSERT OR IGNORE INTO refresh_touched_contracts (id)
SELECT id FROM raw_contract_value_existing;
INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT DISTINCT c.bidder_id
FROM contracts c
WHERE c.id IN (SELECT id FROM refresh_touched_contracts)
  AND c.bidder_id IS NOT NULL;
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT DISTINCT t.authority_id
FROM contracts c JOIN tenders t ON t.id = c.tender_id
WHERE c.id IN (SELECT id FROM refresh_touched_contracts)
  AND t.authority_id IS NOT NULL;
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT DISTINCT ca.authority_id
FROM contract_co_authorities ca
WHERE ca.contract_id IN (SELECT id FROM refresh_touched_contracts);

-- Stage the native amounts and their currencies for the shared valuation rule.
DELETE FROM raw_contract_value_inputs;
INSERT INTO raw_contract_value_inputs
SELECT c.id, c.unp, c.contract_number, c.contract_date, c.signing_value, c.currency, COALESCE(aw.effective_after, c.current_value), aw.currency,
  t.estimated_value, t.currency, c.estimated_value, c.procurement_currency,
  CASE WHEN c.framework_contract = 1 THEN 1 WHEN c.framework_notice = 1 THEN 2 END,
  0, NULL, aw.natural_key
FROM raw_contracts c
LEFT JOIN tenders t ON t.id = 't:' || c.unp
LEFT JOIN refresh_amendment_winners aw
  ON aw.unp = c.unp AND aw.contract_number = c.contract_number
WHERE c.source LIKE 'eop:%' OR c.source LIKE 'ocds:%';
DROP TABLE IF EXISTS raw_contract_value_results;
CREATE TABLE raw_contract_value_results AS SELECT * FROM raw_contract_values;
CREATE UNIQUE INDEX idx_raw_contract_value_results ON raw_contract_value_results(id);

-- Use the same admission rows to publish contracts and select their source buyer.
-- Snapshot prior amounts before replacing the window's rows. A prior EOP row being
-- replaced here also has a staged EOP document that already vetoes its OCDS twin.
DELETE FROM raw_contract_admissions;
INSERT INTO raw_contract_admissions (raw_id, contract_id, bidder_id, amount, lot_id)
SELECT x.id, x.derived_id, x.bidder_key, COALESCE(x.amount, previous.amount),
  CASE WHEN x.lot_id IS NOT NULL AND TRIM(x.lot_id) <> '' THEN 'lot:' || x.unp || ':' || x.lot_id END
FROM (
  SELECT ranked.*, 'c:o:' || COALESCE(ranked.unp, '') || ':' || COALESCE(ranked.contract_number, '') || ':' ||
    COALESCE(NULLIF(ranked.lot_id, ''), '_') || ':' || ranked.bidder_key || ':' || ranked.contract_ordinal AS derived_id
  FROM (
    SELECT z.*,
      ROW_NUMBER() OVER (
        PARTITION BY z.unp, COALESCE(z.contract_number, ''), z.bidder_key, COALESCE(NULLIF(z.lot_id, ''), '_')
        ORDER BY z.signing_value, z.contract_date, z.document_number, z.id
      ) AS contract_ordinal
    FROM (
      SELECT c.id, c.unp, c.source, c.contract_number, c.lot_id, c.signing_value, c.contract_date,
        c.document_number, ci.bidder_key,
        v.amount
      FROM raw_contracts c
      JOIN contractor_identity ci
        ON c.contractor_eik IS ci.eik_raw AND c.contractor_name IS ci.name_raw
      JOIN raw_contract_value_results v ON v.id = c.id
      WHERE c.source LIKE 'ocds:%'
    ) z
  ) ranked
) x
LEFT JOIN raw_contract_value_existing previous ON previous.id = x.derived_id
WHERE COALESCE(x.amount, previous.amount) IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || x.unp)
  AND EXISTS (SELECT 1 FROM bidders b WHERE b.id = x.bidder_key)
  -- EOP wins: skip OCDS rows when the transient window has an EOP row for the same document.
  AND NOT EXISTS (
    SELECT 1 FROM raw_contracts e
    WHERE e.source LIKE 'eop:%'
      AND COALESCE(e.contract_number, '') = COALESCE(x.contract_number, '')
  )
  -- Existing admin rows also win.
  AND NOT EXISTS (SELECT 1 FROM contracts c2 WHERE COALESCE(c2.contract_number, '') = COALESCE(x.contract_number, '') AND c2.id NOT GLOB 'c:[eo]:*')
  -- Existing EOP rows win over later OCDS-only windows too.
  AND NOT EXISTS (SELECT 1 FROM contracts c3 WHERE c3.id GLOB 'c:e:*' AND COALESCE(c3.contract_number, '') = COALESCE(x.contract_number, ''));

INSERT INTO raw_contract_admissions (raw_id, contract_id, bidder_id, amount, lot_id)
SELECT x.id, x.derived_id, x.bidder_key, COALESCE(x.amount, previous.amount),
  CASE WHEN x.lot_norm IS NOT NULL AND TRIM(x.lot_norm) <> '' THEN 'lot:' || x.unp || ':' || x.lot_norm END
FROM (
  SELECT ranked.*, 'c:e:' || COALESCE(ranked.unp, '') || ':' || COALESCE(ranked.contract_number, '') || ':' ||
    COALESCE(NULLIF(ranked.lot_norm, ''), '_') || ':' || ranked.bidder_key || ':' || ranked.contract_ordinal AS derived_id
  FROM (
    SELECT z.*,
      ROW_NUMBER() OVER (
        PARTITION BY z.unp, COALESCE(z.contract_number, ''), z.bidder_key,
          COALESCE(NULLIF(z.lot_norm, ''), '_')
        ORDER BY z.signing_value, z.contract_date, z.document_number, z.id
      ) AS contract_ordinal
    FROM (
      SELECT c.id, c.unp, c.source, c.contract_number, c.lot_id, c.signing_value, c.contract_date,
        c.document_number, ci.bidder_key,
        v.amount,
        CASE
          WHEN c.lot_id LIKE 'LOT-%' AND REPLACE(c.lot_id, 'LOT-', '') <> '' AND REPLACE(c.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(c.lot_id, 'LOT-', '') AS INTEGER)
          WHEN c.lot_id <> '' AND c.lot_id NOT GLOB '*[^0-9]*' THEN CAST(c.lot_id AS INTEGER)
          ELSE c.lot_id
        END AS lot_norm
      FROM raw_contract_publications c
      JOIN contractor_identity ci
        ON c.contractor_eik IS ci.eik_raw AND c.contractor_name IS ci.name_raw
      JOIN raw_contract_value_results v ON v.id = c.id
      WHERE c.source LIKE 'eop:%'
    ) z
  ) ranked
) x
LEFT JOIN raw_contract_value_existing previous ON previous.id = x.derived_id
WHERE COALESCE(x.amount, previous.amount) IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || x.unp)
  AND EXISTS (SELECT 1 FROM bidders b WHERE b.id = x.bidder_key)
  AND NOT EXISTS (
    SELECT 1 FROM contracts c2
    WHERE c2.id NOT GLOB 'c:[eo]:*'
      AND c2.contract_number = x.contract_number
      AND c2.tender_id = 't:' || x.unp
      AND COALESCE(c2.lot_id, '') = COALESCE(CASE WHEN x.lot_norm IS NOT NULL AND TRIM(x.lot_norm) <> '' THEN 'lot:' || x.unp || ':' || x.lot_norm ELSE NULL END, '')
      AND c2.bidder_id = x.bidder_key
  );

DELETE FROM raw_contract_buyer_tenders;
DELETE FROM raw_previous_ocds_contract_buyers;
INSERT OR IGNORE INTO raw_contract_buyer_tenders (tender_id)
SELECT DISTINCT tender_id FROM raw_contract_value_existing WHERE id GLOB 'c:o:*';

INSERT INTO raw_previous_ocds_contract_buyers (contract_id, appearance, source, authority_id)
SELECT DISTINCT b.contract_id, b.appearance, b.source, b.authority_id
FROM raw_contract_admissions p CROSS JOIN ocds_contract_buyers b ON b.contract_id = p.contract_id;

DELETE FROM contracts WHERE id IN (SELECT id FROM raw_contract_value_existing);

INSERT OR IGNORE INTO contracts
  (id, tender_id, bidder_id, ordering_unit_name, amount, currency, signed_at, contract_number, signing_value, current_value,
   current_value_currency,
   annex_count, eu_funded, bids_received, contract_kind, awarded_to_group, value_flag, date_flag, amount_eur,
   fx_converted, fx_rate, signing_value_eur, current_value_eur,
   lot_id, document_number, published_at, contract_subject,
   eu_programme, duration_days, winner_size, contractor_country,
   bids_sme, bids_rejected, bids_non_eea,
   subcontractor_eik, subcontractor_name, subcontract_value,
   eauction, framework, accelerated, strategic, own_estimate_source, own_estimate_value, own_estimate_currency,
   signing_currency_raw, signing_contractor_eik, signing_contractor_status)
SELECT
  p.contract_id,
  't:' || x.unp,
  p.bidder_id,
  NULLIF(TRIM(a.authority_name), ''),
  p.amount,
  COALESCE(x.currency, 'BGN'),
  x.contract_date,
  x.contract_number,
  x.signing_value,
  v.current_value,
  v.current_value_currency,
  CASE WHEN x.source LIKE 'eop:%' THEN COALESCE(x.annex_count, 0) ELSE 0 END,
  x.eu_funded,
  x.bids_received,
  x.contract_kind,
  x.awarded_to_group,
  v.value_flag,
  CASE WHEN x.contract_date IS NOT NULL AND x.published_at IS NOT NULL
    AND x.contract_date > date(x.published_at, '+2 day') THEN 'signed_after_publication' ELSE 'ok' END,
  v.amount_eur,
  v.fx_converted,
  v.fx_rate,
  v.signing_value_eur,
  v.current_value_eur,
  p.lot_id,
  x.document_number,
  x.published_at,
  x.contract_subject,
  x.eu_programme,
  x.duration_days,
  x.winner_size,
  x.contractor_country,
  x.bids_sme,
  x.bids_rejected,
  x.bids_non_eea,
  x.subcontractor_eik,
  x.subcontractor_name,
  x.subcontract_value,
  x.eauction,
  CASE WHEN x.framework_contract = 1 THEN 1 WHEN x.framework_notice = 1 THEN 2 END,
  x.accelerated,
  x.strategic,
  x.source,
  x.estimated_value,
  x.procurement_currency,
  x.currency,
  ci.eik_clean,
  ci.eik_status
FROM raw_contract_admissions p
JOIN raw_contracts x ON x.id = p.raw_id
JOIN raw_serving_contract_authorities a ON a.id = x.id
JOIN raw_contract_value_results v ON v.id = x.id
JOIN contractor_identity ci ON x.contractor_eik IS ci.eik_raw AND x.contractor_name IS ci.name_raw;

-- @ocds-buyer-selection start
INSERT OR IGNORE INTO raw_contract_buyer_tenders (tender_id)
SELECT tender_id FROM raw_new_synthetic_tenders
UNION
SELECT c.tender_id FROM raw_contract_admissions p JOIN contracts c ON c.id = p.contract_id;

-- A same-key readmission can replay an older appearance. Keep the best evidence for
-- that key while it survives. A deleted contract that is not readmitted loses its evidence.
WITH candidates AS (
  SELECT contract_id, appearance, source, a.authority_id, 1 AS incoming
  FROM raw_contract_buyer_candidates a
  JOIN raw_open_synthetic_buyers t ON t.tender_id = a.tender_id
  WHERE a.source LIKE 'ocds:%'
  UNION ALL
  SELECT b.contract_id, b.appearance, b.source, b.authority_id, 0 AS incoming
  FROM raw_previous_ocds_contract_buyers b JOIN contracts c ON c.id = b.contract_id
  JOIN raw_open_synthetic_buyers t ON t.tender_id = c.tender_id
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY contract_id
    ORDER BY source DESC, COALESCE(appearance, '') DESC,
      CASE WHEN appearance IS NOT NULL THEN incoming END, authority_id
  ) AS rank
  FROM candidates
)
INSERT INTO ocds_contract_buyers (contract_id, appearance, source, authority_id)
SELECT contract_id, appearance, source, authority_id FROM ranked WHERE rank = 1
ON CONFLICT(contract_id) DO NOTHING;

-- Rank the remaining admitted signings, including those outside this window. A
-- published EOP signing takes precedence. A removed winner supplies no candidate.
DELETE FROM raw_ocds_tender_selections;
WITH candidates AS (
  SELECT t.tender_id, b.authority_id, b.source, b.appearance
  FROM raw_open_synthetic_buyers t
  CROSS JOIN contracts c ON c.tender_id = t.tender_id
  CROSS JOIN ocds_contract_buyers b ON b.contract_id = c.id
  UNION ALL
  SELECT a.tender_id, a.authority_id, NULL, NULL
  FROM raw_contract_buyer_candidates a
  JOIN raw_open_synthetic_buyers t ON t.tender_id = a.tender_id
  WHERE a.source LIKE 'eop:%'
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY tender_id
    ORDER BY source IS NULL DESC, source DESC, COALESCE(appearance, '') DESC, authority_id
  ) AS rank
  FROM candidates
)
INSERT INTO raw_ocds_tender_selections (tender_id, authority_id, old_authority_id, source, appearance)
SELECT t.tender_id, r.authority_id, t.authority_id, r.source, r.appearance
FROM raw_open_synthetic_buyers t LEFT JOIN ranked r ON r.tender_id = t.tender_id AND r.rank = 1;
-- @ocds-buyer-selection end

UPDATE raw_ocds_tender_selections
SET authority_id = j.authority_id
FROM refresh_joint_tender_leads j
WHERE raw_ocds_tender_selections.tender_id = 't:' || j.unp
  AND raw_ocds_tender_selections.source IS NULL
  AND raw_ocds_tender_selections.authority_id IS NOT NULL;

-- @ocds-buyer-update start
UPDATE tenders
SET authority_id = s.authority_id
FROM raw_ocds_tender_selections s
WHERE tenders.id = s.tender_id AND tenders.authority_id <> s.authority_id;
-- @ocds-buyer-update end

-- @ocds-buyer-binding start
-- An EOP takeover closes the synthetic procedure to OCDS evidence. With no eligible
-- signing left, keep the parent metadata and let a future admission choose a buyer.
DELETE FROM ocds_contract_buyers
WHERE contract_id IN (
  SELECT c.id FROM raw_ocds_tender_selections s CROSS JOIN contracts c ON c.tender_id = s.tender_id
  WHERE s.source IS NULL AND s.authority_id IS NOT NULL
);
DELETE FROM ocds_tender_buyers
WHERE tender_id IN (SELECT tender_id FROM raw_ocds_tender_selections WHERE source IS NULL);

INSERT INTO ocds_tender_buyers (tender_id, appearance, source, authority_id)
SELECT tender_id, appearance, source, authority_id
FROM raw_ocds_tender_selections WHERE source IS NOT NULL
ON CONFLICT(tender_id) DO UPDATE SET
  appearance = excluded.appearance, source = excluded.source, authority_id = excluded.authority_id;
DELETE FROM synthetic_tenders_awaiting_buyer
WHERE tender_id IN (SELECT tender_id FROM raw_ocds_tender_selections WHERE authority_id IS NOT NULL);

INSERT OR IGNORE INTO synthetic_tenders_awaiting_buyer (tender_id)
SELECT tender_id FROM raw_ocds_tender_selections WHERE authority_id IS NULL;
-- @ocds-buyer-binding end

-- Record both sides of a buyer change with the changed tender, including the
-- contracts and bidders that were already served before this packet.
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT old_authority_id FROM raw_ocds_tender_selections
WHERE old_authority_id <> authority_id
UNION
SELECT authority_id FROM raw_ocds_tender_selections WHERE old_authority_id <> authority_id;
INSERT OR IGNORE INTO refresh_touched_contracts (id)
SELECT c.id FROM raw_ocds_tender_selections s JOIN contracts c ON c.tender_id = s.tender_id
WHERE s.old_authority_id <> s.authority_id;
INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT c.bidder_id FROM raw_ocds_tender_selections s JOIN contracts c ON c.tender_id = s.tender_id
WHERE s.old_authority_id <> s.authority_id AND c.bidder_id IS NOT NULL;
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT ca.authority_id FROM contract_co_authorities ca
JOIN contracts c ON c.id = ca.contract_id
JOIN raw_ocds_tender_selections s ON s.tender_id = c.tender_id
WHERE s.old_authority_id <> s.authority_id;

DELETE FROM raw_previous_ocds_contract_buyers;
DELETE FROM raw_contract_buyer_tenders;
DELETE FROM raw_contract_admissions;
DELETE FROM raw_new_synthetic_tenders;
DROP TABLE raw_contract_value_results;
DROP TABLE raw_contract_value_existing;
DELETE FROM raw_contract_value_inputs;

-- Rebuild joint-participation links for contracts represented by this window. Contract deletes
-- cascade old bridge rows; this inserts every member again with the lead forced to ordinal 0.
INSERT OR IGNORE INTO contract_co_authorities (contract_id, authority_id, ordinal)
SELECT contract_id, authority_id, bridge_ordinal
FROM (
  SELECT c.id AS contract_id, m.authority_id,
    ROW_NUMBER() OVER (
      PARTITION BY c.id
      ORDER BY CASE WHEN m.authority_id = l.authority_id THEN 0 ELSE 1 END,
        m.source_ordinal, m.authority_id
    ) - 1 AS bridge_ordinal
  FROM contracts c
  JOIN refresh_joint_authority_members m ON c.tender_id = 't:' || m.unp
  JOIN refresh_joint_tender_leads l ON l.unp = m.unp
);
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT DISTINCT authority_id FROM refresh_joint_authority_members;

-- By the tender's key: inside EXISTS, `'t:' || c.unp = tenders.id` could use no index, so every tender not
-- yet awarded scanned the window's contracts.
UPDATE tenders
SET status = 'awarded'
WHERE status <> 'awarded'
  AND id IN (SELECT 't:' || unp FROM raw_contracts);

-- Record what THIS batch inserted or replaced — in THIS batch. Every @refresh-batch is one atomic D1
-- batch and nothing spans them, so the ids a batch touches must be written in the same batch as the
-- rows it changes, or a death anywhere before the rollups loses the record of what still needs
-- recomputing. Until 2026-09-02 this block sat at the END of `@refresh-batch amendments`, one batch
-- later: nineteen days of runs dying inside `amendments` (SQLITE_NOMEM, #342) each committed their
-- new contracts here and then never recorded them, so no later run rolled them up (276 authorities
-- and 481 bidders drifted from their contracts, −139 M€ / −200 M€, and rollup-reconciliation tripped
-- on the first run that survived). The touched tables themselves survive an abort (see `setup`); this
-- is the other half — an id must be IN them before the batch that changed the row commits.
-- Window-driven by construction: joins THIS window's raw_contracts / raw_amendments to the served
-- contracts (both after the INSERTs above), plus every authority and bidder whose ЕИК appears in the
-- window's parties, so re-attributed or re-named entities are re-rolled too.
INSERT OR IGNORE INTO refresh_touched_contracts (id)
SELECT DISTINCT c.id
FROM raw_contracts rc
JOIN contracts c ON c.contract_number = rc.contract_number AND c.tender_id = 't:' || rc.unp
WHERE rc.contract_number IS NOT NULL
  AND c.id GLOB 'c:[eo]:*'
UNION
SELECT DISTINCT c.id
FROM raw_contracts rc
JOIN contracts c ON c.contract_number IS NULL AND c.tender_id = 't:' || rc.unp
WHERE rc.contract_number IS NULL
  AND c.id GLOB 'c:[eo]:*'
UNION
SELECT DISTINCT c.id
FROM raw_amendments ra
JOIN contracts c ON c.contract_number = ra.contract_number AND c.tender_id = 't:' || ra.unp
WHERE ra.contract_number IS NOT NULL
UNION
SELECT DISTINCT c.id
FROM raw_amendments ra
JOIN contracts c ON c.contract_number IS NULL AND c.tender_id = 't:' || ra.unp
WHERE ra.contract_number IS NULL;
INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT DISTINCT c.bidder_id
FROM contracts c
WHERE c.id IN (SELECT id FROM refresh_touched_contracts)
  AND c.bidder_id IS NOT NULL;
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT DISTINCT t.authority_id
FROM contracts c JOIN tenders t ON t.id = c.tender_id
WHERE c.id IN (SELECT id FROM refresh_touched_contracts)
  AND t.authority_id IS NOT NULL;
-- Joint procurement: every co-authority of a touched contract, so the scoped joint rollup
-- (authority_joint_participation) is recomputed for non-leads too, not only for the lead.
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT DISTINCT ca.authority_id
FROM contract_co_authorities ca
WHERE ca.contract_id IN (SELECT id FROM refresh_touched_contracts);
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT a.id
FROM authorities a
WHERE a.bulstat IN (
    SELECT authority_eik FROM raw_contracts WHERE authority_eik IS NOT NULL
    UNION
    SELECT authority_eik FROM raw_tenders WHERE authority_eik IS NOT NULL
    UNION
    SELECT eik FROM raw_ocds_parties WHERE eik IS NOT NULL
  );
INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT b.id
FROM bidders b
WHERE b.eik_normalized IN (SELECT eik FROM raw_ocds_parties WHERE eik IS NOT NULL)
  OR b.id IN (SELECT bidder_key FROM contractor_identity);



-- 5) Promote window amendments into served domain history and roll touched contracts.
-- @refresh-batch amendments
-- Remove the superseded OCID alias only after FX has succeeded.
DELETE FROM amendments
WHERE source LIKE 'ocds:%'
  AND unp IN (SELECT ocid FROM refresh_amendment_rekeyed)
  AND EXISTS (
    SELECT 1 FROM refresh_amendment_rekeyed k
    WHERE k.ocid = amendments.unp
      AND k.contract_number IS amendments.contract_number
      AND k.document_number IS amendments.document_number
  )
  AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.tender_id = 't:' || amendments.unp);

-- #286 convergence (review nikimilenkov HIGH 1), the other direction of the served-table reconciliation
-- above: an EOP annex arriving in THIS window supersedes an OCDS twin a PRIOR slice already served for the
-- same (unp, contract_number). Drop the stale served OCDS row before promotion so the rollup never counts
-- both. The full path needs no equivalent — promote-amendments.sql rebuilds `amendments` wholesale.
DELETE FROM amendments
WHERE source LIKE 'ocds:%'
  AND EXISTS (
    SELECT 1 FROM raw_amendments e
    WHERE e.source LIKE 'eop:%'
      AND e.unp = amendments.unp
      AND e.contract_number = amendments.contract_number
  );

INSERT OR REPLACE INTO amendments (
  id, natural_key, contract_number, contract_number_raw, link_method, unp,
  value_before, value_after, value_delta, currency,
  published_at, document_number, description, source,
  value_restated, value_treatment, value_suspect, value_evidence_known, raw_value_after, raw_value_delta,
  value_anchor_kind, value_anchor_contractor_eik, contractor_id_status
)
WITH suppliers AS MATERIALIZED (SELECT * FROM raw_supplier_evidence)
SELECT
  natural_key, natural_key, contract_number, contract_number_raw, link_method, unp,
  value_before, effective_after, effective_after - value_before, currency,
  published_at, document_number, description, source,
  restated, value_treatment, 0, 1, raw_after, raw_delta,
  value_anchor_kind, CASE WHEN value_anchor_kind = 'direct' THEN ids.eik END, ids.evidence_status
FROM raw_amendment_publications a
JOIN suppliers ids ON ids.eik_raw IS a.contractor_eik;

-- Materialise affected inputs before the UPDATE to bound D1's statement compiler.
DROP TABLE IF EXISTS amend_contract_base;

CREATE TABLE amend_contract_base AS
SELECT c.id, k.unp, k.contract_number, c.signed_at, c.currency, c.signing_value,
  c.fx_rate AS prior_signing_rate, c.framework, w.effective_after AS current_value,
  COALESCE(NULLIF(CASE WHEN w.effective_after IS NOT NULL THEN w.currency END, ''), NULLIF(c.currency, ''), 'BGN')
    AS current_value_currency,
  t.estimated_value AS proc_est_native, t.currency AS proc_est_currency,
  c.own_estimate_value, c.own_estimate_currency,
  COALESCE(c.own_estimate_source, CASE
    WHEN c.value_flag = 'value_low' AND COALESCE(c.current_value, c.signing_value) > 0
    THEN 'legacy:value_low'
  END) AS own_estimate_source,
  COALESCE(w.annex_count, 0) AS annex_count, w.natural_key
FROM raw_contract_value_scope k
CROSS JOIN contracts c ON c.tender_id = 't:' || k.unp AND c.contract_number = k.contract_number
JOIN tenders t ON t.id = c.tender_id
LEFT JOIN refresh_amendment_winners w ON w.unp = k.unp AND w.contract_number = k.contract_number
WHERE c.id GLOB 'c:[eo]:*' OR EXISTS (
  SELECT 1 FROM raw_amendments a WHERE a.unp = k.unp AND a.contract_number = k.contract_number
);

INSERT INTO raw_contract_value_inputs
SELECT id, unp, contract_number, signed_at, signing_value, currency, current_value, current_value_currency,
  proc_est_native, proc_est_currency, own_estimate_value, own_estimate_currency, framework,
  own_estimate_source = 'legacy:value_low', prior_signing_rate, natural_key
FROM amend_contract_base WHERE annex_count > 0;

-- Re-evaluate known evidence on affected histories only. Legacy rows keep their published marker
-- until the source publication is staged again.
UPDATE amendments SET value_suspect = 0
WHERE id IN (SELECT natural_key FROM raw_contract_value_annexes WHERE evidence_known = 1)
  AND value_suspect <> 0;
UPDATE amendments SET value_suspect = 1
WHERE id IN (SELECT natural_key FROM raw_contract_suspect_annexes)
  AND value_evidence_known = 1 AND value_suspect = 0;

DROP TABLE IF EXISTS raw_contract_value_results;
CREATE TABLE raw_contract_value_results AS SELECT * FROM raw_contract_values;
CREATE UNIQUE INDEX idx_raw_contract_value_results ON raw_contract_value_results(id);

UPDATE contracts
SET
  annex_count = b.annex_count,
  own_estimate_source = b.own_estimate_source,
  current_value = b.current_value,
  current_value_currency = b.current_value_currency,
  value_flag = CASE WHEN v.id IS NOT NULL THEN v.value_flag ELSE contracts.value_flag END,
  -- An already served contract can lose its usable amount if no procedure estimate can repair it.
  -- Keep its native value for provenance while leaving amount_eur NULL.
  amount = COALESCE(v.amount, contracts.amount),
  amount_eur = CASE WHEN v.id IS NOT NULL THEN v.amount_eur ELSE contracts.amount_eur END,
  signing_value_eur = CASE WHEN v.id IS NOT NULL THEN v.signing_value_eur ELSE contracts.signing_value_eur END,
  current_value_eur = CASE WHEN v.id IS NOT NULL THEN v.current_value_eur ELSE contracts.current_value_eur END,
  fx_rate = CASE WHEN v.id IS NOT NULL THEN v.fx_rate ELSE contracts.fx_rate END,
  fx_converted = CASE WHEN v.id IS NOT NULL THEN v.fx_converted ELSE contracts.fx_converted END
FROM amend_contract_base b
LEFT JOIN raw_contract_value_results v ON v.id = b.id
WHERE b.id = contracts.id;

DROP TABLE raw_contract_value_results;
DELETE FROM raw_contract_value_inputs;
DELETE FROM raw_contract_value_annexes;

-- Record what the UPDATE above could have re-valued — exactly the rows of amend_contract_base — in
-- THIS batch, so a run that dies after it still carries the ids into the next run's rollups. The
-- window-driven recording (raw_contracts / raw_amendments / party ЕИК) already happened at the end of
-- `@refresh-batch contracts`; this is the batch-local guarantee for the value change itself.
INSERT OR IGNORE INTO refresh_touched_contracts (id)
SELECT id FROM amend_contract_base;
INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT DISTINCT c.bidder_id
FROM contracts c
WHERE c.id IN (SELECT id FROM amend_contract_base)
  AND c.bidder_id IS NOT NULL;
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT DISTINCT t.authority_id
FROM contracts c JOIN tenders t ON t.id = c.tender_id
WHERE c.id IN (SELECT id FROM amend_contract_base)
  AND t.authority_id IS NOT NULL;
-- Joint procurement: a re-valued contract changes every co-authority's joint rollup, not only the
-- lead's. contract_co_authorities is served (filled by `contracts` above), so this is complete here.
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT DISTINCT ca.authority_id
FROM contract_co_authorities ca
WHERE ca.contract_id IN (SELECT id FROM amend_contract_base);
-- The transient table exists only for the statements above; drop it so a later batch
-- (or a re-run) never reads a stale slice.
DROP TABLE IF EXISTS amend_contract_base;

DROP TABLE contractor_identity;

-- 6) Refresh rollups + FTS. Only the D1-hot rollups are scoped to touched rows; cheaper rollups stay
-- full-recomputed in isolated batches so convergence stays simple.
-- @refresh-batch company-totals
-- The parties to a framework agreement (normalize-raw.sql step 5z), for the contractors this slice
-- touched: one whose every contract is an agreement record is its parties, and one that also holds an
-- ordinary contract is a joint bidder again. Settled before the totals, which carry the kind.
UPDATE bidders SET kind = 'framework_parties'
WHERE id IN (SELECT bidder_id FROM refresh_touched_bidders)
  AND kind = 'consortium' AND name LIKE '%;%'
  AND EXISTS (SELECT 1 FROM contracts c WHERE c.bidder_id = bidders.id AND c.framework = 2)
  AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.bidder_id = bidders.id AND c.framework IS NOT 2);
UPDATE bidders SET kind = 'consortium'
WHERE id IN (SELECT bidder_id FROM refresh_touched_bidders)
  AND kind = 'framework_parties'
  AND EXISTS (SELECT 1 FROM contracts c WHERE c.bidder_id = bidders.id AND c.framework IS NOT 2);
-- Like every batch that writes bidders, this one records them itself, after the write (the two updates
-- above only ever reach bidders already in the set, so this keeps the rule rather than adding ids).
INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT id FROM bidders
WHERE id IN (SELECT bidder_id FROM refresh_touched_bidders) AND kind IN ('framework_parties', 'consortium');
DELETE FROM company_totals WHERE bidder_id IN (SELECT bidder_id FROM refresh_touched_bidders);
INSERT INTO company_totals (bidder_id, name, kind, ownership_kind, eik, eik_valid, settlement, won_eur, contracts, authorities, eu_eur, first_date, last_date)
SELECT b.id, b.name, b.kind, b.ownership_kind, b.eik_normalized, b.eik_valid, b.settlement,
  SUM(c.amount_eur), COUNT(*), COUNT(DISTINCT t.authority_id),
  SUM(CASE WHEN c.eu_funded = 1 THEN c.amount_eur ELSE 0 END), MIN(c.signed_at), MAX(c.signed_at)
FROM contracts c JOIN bidders b ON b.id = c.bidder_id JOIN tenders t ON t.id = c.tender_id
WHERE c.amount_eur IS NOT NULL AND c.bidder_id IN (SELECT bidder_id FROM refresh_touched_bidders)
GROUP BY b.id;
UPDATE company_totals SET primary_sector = (
  SELECT substr(t.cpv_code, 1, 2) FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE c.bidder_id = company_totals.bidder_id AND c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'') <> ''
  GROUP BY substr(t.cpv_code, 1, 2) ORDER BY SUM(c.amount_eur) DESC, substr(t.cpv_code, 1, 2) LIMIT 1)
WHERE bidder_id IN (SELECT bidder_id FROM refresh_touched_bidders);

-- @refresh-batch authority-totals
DELETE FROM authority_totals WHERE authority_id IN (SELECT authority_id FROM refresh_touched_authorities);
INSERT INTO authority_totals (authority_id, name, type_group, settlement, region, spent_eur, contracts, suppliers, avg_eur, eu_eur, first_date, last_date)
SELECT a.id, a.name, a.type_group, a.settlement, a.region,
  SUM(c.amount_eur), COUNT(*), COUNT(DISTINCT c.bidder_id), SUM(c.amount_eur) / COUNT(*),
  SUM(CASE WHEN c.eu_funded = 1 THEN c.amount_eur ELSE 0 END), MIN(c.signed_at), MAX(c.signed_at)
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
WHERE c.amount_eur IS NOT NULL AND t.authority_id IN (SELECT authority_id FROM refresh_touched_authorities)
GROUP BY a.id;
UPDATE authority_totals SET primary_sector = (
  SELECT substr(t.cpv_code, 1, 2) FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE t.authority_id = authority_totals.authority_id AND c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'') <> ''
  GROUP BY substr(t.cpv_code, 1, 2) ORDER BY SUM(c.amount_eur) DESC, substr(t.cpv_code, 1, 2) LIMIT 1)
WHERE authority_id IN (SELECT authority_id FROM refresh_touched_authorities);

-- Joint participation is separate from lead totals; its value is informational and non-summable.
DELETE FROM authority_joint_participation
WHERE authority_id IN (SELECT authority_id FROM refresh_touched_authorities);
INSERT INTO authority_joint_participation
  (authority_id, joint_contract_participations, joint_contract_value_eur)
SELECT cca.authority_id, COUNT(*), COALESCE(SUM(c.amount_eur), 0)
FROM contract_co_authorities cca
JOIN contracts c ON c.id = cca.contract_id
WHERE cca.authority_id IN (SELECT authority_id FROM refresh_touched_authorities)
GROUP BY cca.authority_id;

-- @refresh-batch flow-pairs
-- Still recomputed in full on every run, so the table keeps healing itself, but only a pair that changed is
-- written. Deleting and re-inserting every pair — about 72 thousand, each a row plus four index entries —
-- made this the refresh's biggest writer, some 360 thousand rows a run, nearly all identical to what they
-- replaced. A pair is replaced when a name, the kind or the count changed, or its sum moved by half a cent
-- or more: less is the float noise of adding the same contracts in another order, and the integrity gate's
-- tolerance over the whole table is 5 €.
DELETE FROM flow_pairs
WHERE (authority_id, bidder_id) NOT IN (
  SELECT t.authority_id, c.bidder_id
  FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id JOIN bidders b ON b.id = c.bidder_id
  WHERE c.amount_eur IS NOT NULL
);
INSERT INTO flow_pairs (authority_id, bidder_id, authority_name, bidder_name, bidder_kind, won_eur, contracts)
SELECT f.authority_id, f.bidder_id, f.authority_name, f.bidder_name, f.bidder_kind, f.won_eur, f.contracts
FROM (
  SELECT t.authority_id, c.bidder_id, a.name AS authority_name, b.name AS bidder_name, b.kind AS bidder_kind,
    SUM(c.amount_eur) AS won_eur, COUNT(*) AS contracts
  FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id JOIN bidders b ON b.id = c.bidder_id
  WHERE c.amount_eur IS NOT NULL
  GROUP BY t.authority_id, c.bidder_id
) f
WHERE NOT EXISTS (
  SELECT 1 FROM flow_pairs p
  WHERE p.authority_id = f.authority_id AND p.bidder_id = f.bidder_id
    AND p.authority_name IS f.authority_name AND p.bidder_name IS f.bidder_name
    AND p.bidder_kind IS f.bidder_kind AND p.contracts = f.contracts
    AND abs(p.won_eur - f.won_eur) < 0.005
)
ON CONFLICT (authority_id, bidder_id) DO UPDATE SET
  authority_name = excluded.authority_name,
  bidder_name = excluded.bidder_name,
  bidder_kind = excluded.bidder_kind,
  won_eur = excluded.won_eur,
  contracts = excluded.contracts;

-- @refresh-batch entity-search-index
-- The company and authority rows are rewritten only where they differ from their totals row. Deleting and
-- re-inserting all of them — some 22 thousand — rewrote the search index on every run although nearly
-- nothing in it had changed. A stale or vanished row is deleted, then every totals row the index no longer
-- holds is inserted: EXCEPT compares all the shown fields at once and treats NULLs as equal, like the IS
-- comparisons of the delete. The index is FTS5, where `kind` and `ref` are not indexed, so each statement
-- reads it once; the totals side is a lookup by its primary key.
DELETE FROM search_index WHERE rowid IN (
  SELECT s.rowid FROM search_index s
  LEFT JOIN company_totals ct ON ct.bidder_id = s.ref AND ct.bidder_id <> 'unknown:анонимен'
  WHERE s.kind = 'company'
    AND (ct.bidder_id IS NULL OR ct.name IS NOT s.title OR COALESCE(ct.eik, '') IS NOT s.ident
      OR COALESCE(ct.settlement, '') IS NOT s.subtitle OR ct.won_eur IS NOT s.amount)
);
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'company', ref, title, ident, subtitle, amount
FROM (
  SELECT ct.bidder_id AS ref, ct.name AS title, COALESCE(ct.eik, '') AS ident,
    COALESCE(ct.settlement, '') AS subtitle, ct.won_eur AS amount
  FROM company_totals ct
  WHERE ct.bidder_id <> 'unknown:анонимен'
  EXCEPT
  SELECT ref, title, ident, subtitle, amount FROM search_index WHERE kind = 'company'
);
DELETE FROM search_index WHERE rowid IN (
  SELECT s.rowid FROM search_index s
  LEFT JOIN authority_totals at ON at.authority_id = s.ref
  WHERE s.kind = 'authority'
    AND (at.authority_id IS NULL OR at.name IS NOT s.title
      OR CASE WHEN at.authority_id LIKE 'auth:%' THEN substr(at.authority_id, 6) ELSE '' END IS NOT s.ident
      OR COALESCE(at.settlement, '') IS NOT s.subtitle OR at.spent_eur IS NOT s.amount)
);
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'authority', ref, title, ident, subtitle, amount
FROM (
  SELECT at.authority_id AS ref, at.name AS title, CASE WHEN at.authority_id LIKE 'auth:%' THEN substr(at.authority_id, 6) ELSE '' END AS ident,
    COALESCE(at.settlement, '') AS subtitle, at.spent_eur AS amount
  FROM authority_totals at
  EXCEPT
  SELECT ref, title, ident, subtitle, amount FROM search_index WHERE kind = 'authority'
);
-- @refresh-batch official-search-index
-- Contract refreshes can only change the displayed amount for officials linked to a touched bidder.
-- Rebuild those officials from all of their links; a full related-persons publish owns withdrawals and
-- the full-corpus reindex. Keeping this batch incremental avoids scanning every contract for every official
-- on every daily EOP run, which exceeds D1's per-query CPU limit on the complete corpus.
DROP TABLE IF EXISTS refresh_official_reindex_scope;
CREATE TABLE refresh_official_reindex_scope (person_id TEXT PRIMARY KEY);
INSERT INTO refresh_official_reindex_scope (person_id)
SELECT DISTINCT affected.person_id
FROM interest_links affected
JOIN bidders affected_bidder ON affected_bidder.eik_normalized = affected.eik
JOIN refresh_touched_bidders touched ON touched.bidder_id = affected_bidder.id;
DELETE FROM search_index
WHERE kind = 'official' AND ref IN (SELECT person_id FROM refresh_official_reindex_scope);
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'official', il.person_id, p.name,
  (SELECT group_concat(DISTINCT s.name) FROM person_sources s
   WHERE s.active=1 AND s.namespace='cacbg' AND (s.entity_id=il.person_id OR (s.entity_id IS NULL AND s.legacy_person_id=il.person_id))),
  -- subtitle: „позиция · институция" from the official's latest filing — both from the same row.
  (SELECT CASE WHEN COALESCE(d.position, '') <> '' AND COALESCE(d.institution, '') <> ''
               THEN d.position || ' · ' || d.institution
               ELSE COALESCE(NULLIF(d.position, ''), d.institution) END
   FROM declarations d WHERE d.person_id = il.person_id
   ORDER BY d.declared_year DESC, d.id DESC LIMIT 1),
  -- amount = the CONTEMPORANEOUS conflict-window € (contracts signed while the stake was declared), the same
  -- per-link subquery as LINK_SELECT.contemporaneous_value_eur, summed across the official's SURFACED links.
  -- The redundant-family collapse (WHERE below) leaves at most one link per (official, ЕИК), so no winner's €
  -- is double-counted. family_ownership reaches the index identically to self (ADR-0032) — the office-holder
  -- is searchable, the relative never named. Never the lifetime total.
  SUM((SELECT SUM(cc.amount_eur) FROM contracts cc
         JOIN tenders tt ON tt.id = cc.tender_id
         JOIN authorities aa ON aa.id = tt.authority_id
         JOIN bidders bb ON bb.id = cc.bidder_id
       WHERE bb.eik_normalized = il.eik
         AND il.first_declared_year IS NOT NULL AND il.last_declared_year IS NOT NULL
         AND cc.signed_at IS NOT NULL
         AND strftime('%Y',cc.signed_at) BETWEEN il.first_declared_year AND il.last_declared_year
         AND NOT EXISTS (
  SELECT 1 FROM interest_link_observations missing
  JOIN interest_links source_link ON source_link.link_key=missing.link_key
  WHERE missing.timing='not_listed' AND missing.reported_year=strftime('%Y',cc.signed_at)
    AND source_link.eik=il.eik AND source_link.interest_class=il.interest_class
    AND source_link.status='published'
    AND (source_link.person_id=il.person_id OR EXISTS (
      SELECT 1 FROM person_registry_links source_person JOIN person_registry_links target_person
        ON target_person.registry_indent=source_person.registry_indent
      WHERE source_person.person_id=source_link.person_id AND target_person.person_id=il.person_id))
)))
FROM interest_links il JOIN persons p ON p.id = il.person_id
-- Self OR family stake (ADR-0032). Two guards mirror the /conflicts read layer (related-persons.ts):
--  (N9) index only a link whose winner has LIVE contracts, so a stale-zero-contract link never becomes a dead
--       search hit that 404s on click;
--  (collapse) drop a family link when the SAME official already has a published OWN stake in that winner —
--       rendering both re-identifies the relative via a ТР owner lookup, and the company is already surfaced
--       by the self row.
WHERE il.status = 'published' AND il.interest_class IN ('private_ownership', 'family_ownership')
  AND il.person_id IN (SELECT person_id FROM refresh_official_reindex_scope)
  -- …and the identity rests on a Trade Register fact (#279, ADR-0033). This predicate is the THIRD copy
  -- of the surface gate — the other two are SURFACED_OWNERSHIP in packages/db/src/queries/related-persons.ts
  -- and the sibling block in the other of precompute.sql / refresh-slice.sql. All three must move
  -- together: this one feeds the officials search index, so omitting it would keep officials findable
  -- whose links no longer surface.
  AND EXISTS (SELECT 1 FROM interest_link_evidence e
              WHERE e.link_key = il.link_key AND e.evidence_kind IN ('document','confirmed'))
  AND EXISTS (SELECT 1 FROM contracts cc JOIN bidders bb ON bb.id = cc.bidder_id
              WHERE bb.eik_normalized = il.eik)
  AND NOT (il.interest_class = 'family_ownership' AND EXISTS (
    SELECT 1 FROM interest_links s
    WHERE s.person_id = il.person_id AND s.eik = il.eik
      AND s.status = 'published' AND s.interest_class = 'private_ownership'))
GROUP BY il.person_id, p.name;
DROP TABLE refresh_official_reindex_scope;

-- @refresh-batch contract-search-index
DELETE FROM search_index WHERE kind = 'contract' AND ref IN (SELECT id FROM refresh_touched_contracts);
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'contract', c.id, COALESCE(NULLIF(c.contract_subject, ''), t.title), COALESCE(t.source_id, ''),
  a.name || ' → ' || b.name, c.amount_eur
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id JOIN bidders b ON b.id = c.bidder_id
WHERE c.id IN (SELECT id FROM refresh_touched_contracts)
  AND COALESCE(NULLIF(c.contract_subject, ''), t.title) IS NOT NULL;

-- Small global rollups - recomputed in full (one-row / small facet tables; cheap per refresh).
-- @refresh-batch globals
-- One pass over the corpus for every corpus-wide count written from it — data_freshness, home_totals' contract
-- count, value and suspect rows, sector_totals, and the contracts list's facets (procedure, EU, sector, year):
-- grouped once into a small cube, a few thousand rows, then folded per total. They were eight scans of the
-- whole contracts table. The LEFT JOIN and `has_tender` keep each total's own base exactly as it was: the
-- tender-joined ones (procedure, sector, sector_totals) and the contracts-only ones (EU, year, home, freshness).
DROP TABLE IF EXISTS contract_cube;
CREATE TABLE contract_cube AS
SELECT
  t.id IS NOT NULL AS has_tender,
  -- A contract the contracts list shows: its FROM joins the tender, the authority and the bidder.
  t.id IS NOT NULL AND a.id IS NOT NULL AND b.id IS NOT NULL AS in_list,
  t.procedure_type AS procedure_type,
  -- '?' keeps a value other than 0, 1 or NULL apart: the list's „EU" filter is `= 1` and „national" is
  -- `IS NULL OR = 0`, so such a contract is in neither. The EU facet folds it into '0', as it always did.
  CASE WHEN c.eu_funded = 1 THEN '1' WHEN c.eu_funded = 0 OR c.eu_funded IS NULL THEN '0' ELSE '?' END AS eu,
  COALESCE(substr(t.cpv_code, 1, 2), '') AS sector,
  CASE WHEN substr(c.signed_at, 1, 4) GLOB '[0-9][0-9][0-9][0-9]' THEN substr(c.signed_at, 1, 4) ELSE 'unknown' END AS year,
  CASE WHEN c.id LIKE 'c:e:%' THEN 'eop' WHEN c.id LIKE 'c:o:%' THEN 'ocds' ELSE 'other' END AS src,
  CASE WHEN c.bids_received = 1 THEN '1' ELSE '0' END AS one_offer,
  -- A known number of offers: at least one. 0 is not a real count (an award needs an offer) and NULL is
  -- unknown. The base of the single-offer share (methodology §5), the rule competitionTotals applies.
  CASE WHEN c.bids_received >= 1 THEN 1 ELSE 0 END AS bids_known,
  -- The list's value buckets (VALUE_BUCKETS in contracts.ts), each [lower, upper).
  CASE
    WHEN c.amount_eur >= 100000000 THEN 'gt100m'
    WHEN c.amount_eur >= 10000000 THEN '10m-100m'
    WHEN c.amount_eur >= 1000000 THEN '1m-10m'
    WHEN c.amount_eur >= 100000 THEN '100k-1m'
    WHEN c.amount_eur >= 0 THEN 'lt100k'
    ELSE ''
  END AS value_bucket,
  COUNT(*) AS contracts,
  COUNT(c.amount_eur) AS priced,
  COALESCE(SUM(c.amount_eur), 0) AS value_eur,
  -- The single-offer value share sums positive amounts only, so a negative value_low row cannot push it
  -- outside [0, 1] (competition.ts, #153).
  COALESCE(SUM(CASE WHEN c.amount_eur > 0 THEN c.amount_eur ELSE 0 END), 0) AS value_pos,
  SUM(c.value_flag = 'value_suspect') AS suspect,
  -- The list's headline count of values that are probably wrong at the source (value_low, summed as
  -- published) or missing (no usable EUR figure, not summed). A framework agreement's own record is
  -- neither: its figure is a ceiling, not spending, whatever its verdict.
  SUM(c.framework IS NOT 2 AND (c.amount_eur IS NULL OR c.value_flag = 'value_low')) AS unverified,
  MAX(CASE WHEN c.signed_at <= date('now') THEN c.signed_at END) AS max_signed
FROM contracts c
LEFT JOIN tenders t ON t.id = c.tender_id
LEFT JOIN authorities a ON a.id = t.authority_id
LEFT JOIN bidders b ON b.id = c.bidder_id
-- By position: the dimensions are the first ten result columns, and an alias must not meet a column name.
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10;

DELETE FROM data_freshness;
INSERT INTO data_freshness (source, as_of, rows, refreshed_at)
SELECT src, MAX(max_signed), SUM(contracts), datetime('now')
FROM contract_cube
GROUP BY src;

DELETE FROM home_totals;
INSERT INTO home_totals (id, contracts, value_eur, authorities, bidders, suspect, first_date, last_date, as_of, refreshed_at)
SELECT 1,
  (SELECT COALESCE(SUM(contracts), 0) FROM contract_cube),
  (SELECT COALESCE(SUM(value_eur), 0) FROM contract_cube),
  (SELECT COUNT(*) FROM authority_totals),
  -- The companies the list and the search show (companies.ts): the bucket of winners with no identity is
  -- not a company.
  (SELECT COUNT(*) FROM company_totals WHERE kind <> 'unknown'),
  (SELECT COALESCE(SUM(suspect), 0) FROM contract_cube),
  (SELECT MIN(signed_at) FROM contracts WHERE signed_at >= '2020-01-01' AND signed_at <= date('now')),
  (SELECT MAX(signed_at) FROM contracts WHERE signed_at <= date('now')),
  -- Freshness is the latest in-corpus signed contract date. data_freshness is maintained above.
  (SELECT MAX(signed_at) FROM contracts WHERE signed_at <= date('now')),
  datetime('now');

DELETE FROM sector_totals;
INSERT INTO sector_totals (division, contracts, value_eur)
SELECT sector, SUM(priced), SUM(value_eur)
FROM contract_cube
WHERE has_tender = 1 AND sector <> ''
GROUP BY sector
HAVING SUM(priced) > 0;

DELETE FROM facet_counts;
INSERT INTO facet_counts (facet, key, contracts, value_eur)
SELECT 'procedure', procedure_type, SUM(contracts), SUM(value_eur)
FROM contract_cube WHERE has_tender = 1 GROUP BY procedure_type;
INSERT INTO facet_counts (facet, key, contracts, value_eur)
SELECT 'eu', CASE WHEN eu = '1' THEN '1' ELSE '0' END, SUM(contracts), SUM(value_eur)
FROM contract_cube GROUP BY CASE WHEN eu = '1' THEN '1' ELSE '0' END;
-- The contracts list's sector and year facets, which every uncached list page shows: read from here instead
-- of two full scans per request — those scans were the bulk of the rows D1 read, and what a crawler turned
-- into an overloaded database. Same expressions as getContractFacets' live fallback.
INSERT INTO facet_counts (facet, key, contracts, value_eur)
SELECT 'sector', sector, SUM(contracts), SUM(value_eur)
FROM contract_cube WHERE has_tender = 1 GROUP BY sector;
INSERT INTO facet_counts (facet, key, contracts, value_eur)
SELECT 'year', year, SUM(contracts), SUM(value_eur) FROM contract_cube GROUP BY year;
-- The national single-offer share, one base for the home page, /analytics and /competition (home.ts,
-- competition.ts): contracts with a known number of offers, and their one-offer subset — counted, and
-- valued on positive amounts. With a tender, as competitionTotals' live count joins it, so the national
-- figure is the sum of the per-sector ones.
INSERT INTO facet_counts (facet, key, contracts, value_eur)
SELECT 'single_offer', 'known', COALESCE(SUM(contracts), 0), COALESCE(SUM(value_pos), 0)
FROM contract_cube WHERE bids_known = 1 AND has_tender = 1;
INSERT INTO facet_counts (facet, key, contracts, value_eur)
SELECT 'single_offer', 'one', COALESCE(SUM(contracts), 0), COALESCE(SUM(value_pos), 0)
FROM contract_cube WHERE one_offer = '1' AND has_tender = 1;

-- @refresh-batch contract-rollup
-- The contracts list's headline for every combination of its filters (migration 0024): each of the six
-- dimensions either one of its values or '(all)', so 64 groupings of the listed contracts in the cube. Only a
-- row that changed is written: a vanished combination is deleted, a new or changed one upserted. A value is
-- compared to half a cent; adding the same contracts in another order moves it by far less.
CREATE TABLE IF NOT EXISTS contract_rollup (
  procedure_type TEXT NOT NULL,
  eu             TEXT NOT NULL,
  sector         TEXT NOT NULL,
  one_offer      TEXT NOT NULL,
  value_bucket   TEXT NOT NULL,
  year           TEXT NOT NULL,
  contracts      INTEGER NOT NULL,
  value_eur      REAL NOT NULL,
  unverified     INTEGER NOT NULL,
  PRIMARY KEY (procedure_type, eu, sector, one_offer, value_bucket, year)
) WITHOUT ROWID;
WITH RECURSIVE masks(m) AS (SELECT 0 UNION ALL SELECT m + 1 FROM masks WHERE m < 63)
DELETE FROM contract_rollup
WHERE (procedure_type, eu, sector, one_offer, value_bucket, year) NOT IN (
  SELECT
    CASE WHEN m & 1 THEN '(all)' ELSE procedure_type END,
    CASE WHEN m & 2 THEN '(all)' ELSE eu END,
    CASE WHEN m & 4 THEN '(all)' ELSE sector END,
    CASE WHEN m & 8 THEN '(all)' ELSE one_offer END,
    CASE WHEN m & 16 THEN '(all)' ELSE value_bucket END,
    CASE WHEN m & 32 THEN '(all)' ELSE year END
  FROM contract_cube CROSS JOIN masks
  WHERE in_list = 1
);
WITH RECURSIVE masks(m) AS (SELECT 0 UNION ALL SELECT m + 1 FROM masks WHERE m < 63),
fresh AS (
  SELECT
    CASE WHEN m & 1 THEN '(all)' ELSE procedure_type END AS procedure_type,
    CASE WHEN m & 2 THEN '(all)' ELSE eu END AS eu,
    CASE WHEN m & 4 THEN '(all)' ELSE sector END AS sector,
    CASE WHEN m & 8 THEN '(all)' ELSE one_offer END AS one_offer,
    CASE WHEN m & 16 THEN '(all)' ELSE value_bucket END AS value_bucket,
    CASE WHEN m & 32 THEN '(all)' ELSE year END AS year,
    SUM(contracts) AS contracts, SUM(value_eur) AS value_eur, SUM(unverified) AS unverified
  FROM contract_cube CROSS JOIN masks
  WHERE in_list = 1
  GROUP BY 1, 2, 3, 4, 5, 6
)
INSERT INTO contract_rollup (procedure_type, eu, sector, one_offer, value_bucket, year, contracts, value_eur, unverified)
SELECT f.procedure_type, f.eu, f.sector, f.one_offer, f.value_bucket, f.year, f.contracts, f.value_eur, f.unverified
FROM fresh f
WHERE NOT EXISTS (
  SELECT 1 FROM contract_rollup r
  WHERE r.procedure_type = f.procedure_type AND r.eu = f.eu AND r.sector = f.sector
    AND r.one_offer = f.one_offer AND r.value_bucket = f.value_bucket AND r.year = f.year
    AND r.contracts = f.contracts AND r.unverified = f.unverified
    AND abs(r.value_eur - f.value_eur) < 0.005
)
ON CONFLICT (procedure_type, eu, sector, one_offer, value_bucket, year) DO UPDATE SET
  contracts = excluded.contracts, value_eur = excluded.value_eur, unverified = excluded.unverified;
DROP TABLE IF EXISTS contract_cube;

-- @refresh-batch cohort-stats
-- cpv_division_stats: same full rebuild as scripts/precompute.sql §4c. Runs in its OWN batch (not in
-- `globals` with data_freshness/home_totals/sector_totals/facet_counts) because it is the heaviest
-- statement of the refresh - a full ~150k-row PARTITION BY window sort + rank over the whole corpus.
-- Bundling it into `globals` risked blowing that single D1 request's CPU budget and failing the entire
-- step; its own batch isolates that cost, matching how the other heavy rollups get dedicated batches
-- (review nedda76). IF NOT EXISTS bootstraps a served DB that predates the migration.
CREATE TABLE IF NOT EXISTS cpv_division_stats (
  division TEXT PRIMARY KEY, priced_contracts INTEGER NOT NULL,
  p25_eur REAL NOT NULL, median_eur REAL NOT NULL, p75_eur REAL NOT NULL,
  p90_eur REAL NOT NULL, p95_eur REAL NOT NULL, p99_eur REAL NOT NULL
);
DELETE FROM cpv_division_stats;
INSERT INTO cpv_division_stats (division, priced_contracts, p25_eur, median_eur, p75_eur, p90_eur, p95_eur, p99_eur)
SELECT division, MAX(cnt),
       MAX(CASE WHEN rn = CAST(cnt * 0.25 + 0.9999999 AS INTEGER) THEN amount_eur END),
       MAX(CASE WHEN rn = CAST(cnt * 0.50 + 0.9999999 AS INTEGER) THEN amount_eur END),
       MAX(CASE WHEN rn = CAST(cnt * 0.75 + 0.9999999 AS INTEGER) THEN amount_eur END),
       MAX(CASE WHEN rn = CAST(cnt * 0.90 + 0.9999999 AS INTEGER) THEN amount_eur END),
       MAX(CASE WHEN rn = CAST(cnt * 0.95 + 0.9999999 AS INTEGER) THEN amount_eur END),
       MAX(CASE WHEN rn = CAST(cnt * 0.99 + 0.9999999 AS INTEGER) THEN amount_eur END)
FROM (
  SELECT substr(t.cpv_code, 1, 2) AS division, c.amount_eur,
         ROW_NUMBER() OVER (PARTITION BY substr(t.cpv_code, 1, 2) ORDER BY c.amount_eur, c.id) AS rn,
         COUNT(*)     OVER (PARTITION BY substr(t.cpv_code, 1, 2)) AS cnt
  FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE c.amount_eur IS NOT NULL AND c.amount_eur > 0 AND c.value_flag = 'ok'
    AND COALESCE(t.cpv_code, '') <> ''
)
GROUP BY division;

-- @refresh-batch cleanup
DROP TABLE IF EXISTS refresh_joint_tender_leads;
DROP TABLE IF EXISTS refresh_unp_prefix_authorities;
DROP TABLE IF EXISTS refresh_joint_authority_members;
DROP TABLE IF EXISTS refresh_joint_tender_sources;
-- The touched sets go ONLY here — after the rollups and the contract search index have consumed them.
-- A run that dies before this batch keeps them for the next run on purpose (see `@refresh-batch setup`).
DROP TABLE IF EXISTS refresh_touched_contracts;
DROP TABLE IF EXISTS refresh_touched_bidders;
DROP TABLE IF EXISTS refresh_touched_authorities;
DROP TABLE IF EXISTS refresh_amendment_winners;
DROP TABLE IF EXISTS refresh_amendment_rekeyed;
