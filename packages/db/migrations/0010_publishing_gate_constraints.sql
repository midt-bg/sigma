-- The publishing-gate constraints, for EVERY database — freshly built and already-deployed alike (#279 §2).
--
-- WHY THIS MIGRATION OWNS THEM RATHER THAN 0003 (todorkolev, #309). The obvious move is to add the CHECKs
-- to `interest_links` in 0003, where the table is declared. That does not work and is worse than not
-- trying: 0003 is ALREADY APPLIED everywhere, `CREATE TABLE IF NOT EXISTS` is a no-op against an existing
-- table, and `ship-related-persons.mjs` wipes ROWS (`DELETE FROM`, WIPE_ORDER), never definitions. So an
-- in-place CHECK would exist only on databases built after the edit — putting two different schemas under
-- one name, with the constraint absent precisely on the served database. That is where a hand-run
-- `UPDATE … SET status='published '` during an incident actually lands.
--
-- So 0003 stays byte-identical to what was applied, and enforcement lives here, reached by both paths:
-- a fresh chain runs 0007 after 0003, and a deployed database gets it as a retrofit. One shape, one
-- mechanism. `packages/db/src/migrations.test.ts` holds the two shapes to the same rejections and the same
-- acceptances, so this stays true rather than merely intended.
--
-- WHY TRIGGERS AND NOT A TABLE REBUILD: SQLite cannot add a CHECK in place, so the textbook route is
-- create-copy-drop-rename. That route is WRONG here, and a real `wrangler d1 migrations apply` proved it:
-- `interest_link_evidence` references interest_links(link_key), D1 enforces foreign keys, and
-- `PRAGMA defer_foreign_keys` does not survive the statement-by-statement execution wrangler performs —
-- the rebuild aborts with SQLITE_CONSTRAINT_FOREIGNKEY and the Durable Object rolls back. Dropping the
-- child first would work mechanically but would strip every evidence seal, and since the read gate
-- REQUIRES a seal that empties the public surface until the next monthly data run.
--
-- A BEFORE INSERT/UPDATE trigger that RAISEs enforces the identical invariant for every writer — including
-- the hand-run UPDATE above, which no CHECK on a legacy table would ever have covered — with no rebuild,
-- no FK exposure and no seal loss. 0006 keeps its own CHECKs: it is NEW in this change, has never been
-- applied to a served environment, so declaring them there edits no applied history.
--
-- WHY IT IS SAFE TO RE-RUN: migrations here are applied by a bare `wrangler d1 execute --file` with no
-- applied-migrations tracking (see related-persons-data.yml / deploy.yml), so re-application MUST be a
-- no-op. Everything below is `IF NOT EXISTS` over statements that converge.

-- ── declarations ────────────────────────────────────────────────────────────────────────────────────
-- The table-level `UNIQUE (xml_file, control_hash)` did not constrain what it was written for. SQLite
-- counts NULLs as DISTINCT and `control_hash` is genuinely optional at the source (the register omits
-- <ControlHash> on some declarations), so every hashless declaration was mutually unique and re-imported
-- as a NEW row on each run, double-counting the stakes it carries. `xml_file` is also not unique across
-- folders — the register reuses basenames per year — which load.mjs already handles by namespacing the
-- declaration id with the folder.
--
-- Replaced by an expression index over COALESCE(control_hash, '') plus folder_year: NULL-proof, and the
-- same natural key `id` already encodes. The column stays NULLABLE on purpose — NOT NULL would convert an
-- optional source field into a run-stopping loader failure, and a fabricated placeholder hash would
-- assert an integrity check nobody performed.
--
-- No table rebuild is needed for this one: the table-level `UNIQUE (xml_file, control_hash)` declared in
-- 0003 STAYS (0003 is not edited — see the header), and the correct index is simply added alongside it.
-- The stale constraint is strictly WEAKER than the index — it treats NULLs as distinct, so it accepts a
-- superset — and therefore rejects nothing the index accepts. The index governs.
--
-- Duplicates ALREADY stored under the old non-constraint would block the index, so they are collapsed
-- first, keeping the earliest row per natural key.
--
-- The DELETE below changes live data, so it ANNOUNCES itself first (cefothe, #309): the count is emitted
-- before the rows go, and a run that removes nothing says so. Without it the only evidence a deployment
-- silently dropped declarations would be a row count nobody recorded beforehand. It needs no explicit
-- transaction — `wrangler d1 execute --file` runs the file as one implicit transaction, so a failure
-- anywhere below rolls the DELETE back with it rather than leaving a half-collapsed table.
-- The subtraction is parenthesised deliberately: `||` binds TIGHTER than `-` in SQLite, so without it
-- this reads as ('…' || countA) - (countB || '…') — two strings coerced to numbers — and reports a
-- meaningless figure instead of the row count. It did, before a real apply showed „notice: -2".
SELECT 'migration 0007: collapsing ' ||
       ((SELECT COUNT(*) FROM declarations) -
        (SELECT COUNT(*) FROM (SELECT 1 FROM declarations
                               GROUP BY xml_file, folder_year, COALESCE(control_hash, '')))) ||
       ' duplicate declaration row(s) before the natural-key index' AS notice;
DELETE FROM declarations WHERE id NOT IN (
  SELECT MIN(id) FROM declarations GROUP BY xml_file, folder_year, COALESCE(control_hash, '')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_declarations_natural_key
  ON declarations(xml_file, folder_year, COALESCE(control_hash, ''));

-- ── interest_links: status / interest_class ─────────────────────────────────────────────────────────
-- These two ARE the publishing gate: the surface is `status = 'published'` AND a surfaced
-- `interest_class`. A value that merely resembles one — 'published ' with a trailing space, the case
-- #279 §2 names — passes every writer and then fails the gate silently, hiding a link that should show.
--
-- One trigger per operation, since SQLite triggers are per-event. `RAISE(ABORT)` rolls back the
-- statement, so a bad write fails loudly at its source instead of surfacing later as a missing link.
DROP TRIGGER IF EXISTS trg_interest_links_status_ins;
CREATE TRIGGER trg_interest_links_status_ins
BEFORE INSERT ON interest_links
WHEN NEW.status NOT IN ('published','internal','held','withdrawn','suppressed')
   OR NEW.interest_class NOT IN ('private_ownership','family_ownership','ex_officio_board','management_role')
BEGIN
  SELECT RAISE(ABORT, 'CHECK failed: interest_links.status/interest_class outside the publishing-gate enum');
END;

DROP TRIGGER IF EXISTS trg_interest_links_status_upd;
CREATE TRIGGER trg_interest_links_status_upd
BEFORE UPDATE ON interest_links
WHEN NEW.status NOT IN ('published','internal','held','withdrawn','suppressed')
   OR NEW.interest_class NOT IN ('private_ownership','family_ownership','ex_officio_board','management_role')
BEGIN
  SELECT RAISE(ABORT, 'CHECK failed: interest_links.status/interest_class outside the publishing-gate enum');
END;

-- ── interest_link_evidence: evidence_kind ───────────────────────────────────────────────────────────
-- The read gate filters on this column — SURFACED_OWNERSHIP admits exactly 'document' and 'confirmed' —
-- so an unlisted value either silently stops a link surfacing or, if it collides with a publishing name,
-- surfaces one that was never proven. 0006 declares this as a CHECK for new databases; the trigger is
-- the same rule for those provisioned before it.
DROP TRIGGER IF EXISTS trg_ile_kind_ins;
CREATE TRIGGER trg_ile_kind_ins
BEFORE INSERT ON interest_link_evidence
WHEN NEW.evidence_kind NOT IN ('document','confirmed','document_uncorroborated','refuted',
                               'bar_joint_stock','unknown','outside_tr')
   OR (NEW.registry_role IS NOT NULL AND NEW.registry_role NOT IN ('owner','manager'))
   OR NEW.live_status NOT IN ('live','terminated_owner_still','terminated_manager_still','terminated')
BEGIN
  SELECT RAISE(ABORT, 'CHECK failed: interest_link_evidence enum outside the ADR-0033/0035 vocabulary');
END;

DROP TRIGGER IF EXISTS trg_ile_kind_upd;
CREATE TRIGGER trg_ile_kind_upd
BEFORE UPDATE ON interest_link_evidence
WHEN NEW.evidence_kind NOT IN ('document','confirmed','document_uncorroborated','refuted',
                               'bar_joint_stock','unknown','outside_tr')
   OR (NEW.registry_role IS NOT NULL AND NEW.registry_role NOT IN ('owner','manager'))
   OR NEW.live_status NOT IN ('live','terminated_owner_still','terminated_manager_still','terminated')
BEGIN
  SELECT RAISE(ABORT, 'CHECK failed: interest_link_evidence enum outside the ADR-0033/0035 vocabulary');
END;
