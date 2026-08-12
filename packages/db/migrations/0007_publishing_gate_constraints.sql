-- Retrofit the publishing-gate constraints onto an ALREADY-DEPLOYED database (#279 §2).
--
-- WHY THIS EXISTS AT ALL, given 0003 and 0006 now declare the same constraints:
--   `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists, and
--   `scripts/ship-related-persons.mjs` wipes ROWS (`DELETE FROM`, WIPE_ORDER) and never table
--   definitions. So every environment that applied 0003 before today keeps the unconstrained shape
--   forever, no matter how many times the data is reloaded. Only a rebuild can change it.
--
-- WHY IT IS SAFE TO RE-RUN: migrations here are applied by a bare `wrangler d1 execute --file` with no
-- applied-migrations tracking (see related-persons-data.yml / deploy.yml), so re-application MUST be a
-- no-op. Everything below is `IF NOT EXISTS` over statements that converge.
--
-- WHY TRIGGERS AND NOT A TABLE REBUILD: SQLite cannot add a CHECK in place, so the textbook route is
-- create-copy-drop-rename. That route is WRONG here, and a real `wrangler d1 migrations apply` proved it:
-- `interest_link_evidence` references interest_links(link_key), D1 enforces foreign keys, and
-- `PRAGMA defer_foreign_keys` does not survive the statement-by-statement execution wrangler performs —
-- the rebuild aborts with SQLITE_CONSTRAINT_FOREIGNKEY and the Durable Object rolls back. Dropping the
-- child first would work mechanically but would strip every evidence seal, and since the read gate
-- REQUIRES a seal that empties the public surface until the next monthly data run.
--
-- A BEFORE INSERT/UPDATE trigger that RAISEs enforces the identical invariant for every writer —
-- including a hand-run UPDATE during an incident, which is when a bad value is most likely typed — with
-- no rebuild, no FK exposure and no seal loss. Freshly created databases still get true CHECK constraints
-- from 0003/0006; this is the retrofit path for databases that already exist.

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
-- No table rebuild is needed for this one: dropping the old constraint means dropping the table it lives
-- on, but the same effect is had by creating the correct index — and the stale UNIQUE, being strictly
-- weaker, rejects nothing the new index accepts. Duplicates ALREADY stored under the old non-constraint
-- would block the new index, so they are collapsed first, keeping the earliest row per natural key.
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
