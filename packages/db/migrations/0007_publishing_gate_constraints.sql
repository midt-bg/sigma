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
-- no-op. Both blocks below are written to converge: the index block is `IF NOT EXISTS` over a de-duplicated
-- table, and the rebuild block copies the CURRENT table into a constrained one — run a second time it
-- copies an already-constrained table into an identical one. Idempotent by construction, no version flag.
--
-- WHY A REBUILD FOR interest_links AND NOT `ALTER TABLE`: SQLite cannot add a CHECK in place, so
-- create-copy-drop-rename is the documented route. `declarations` needs no rebuild — its defect was a
-- constraint that failed to constrain, which a correct index fixes without touching the table.
--
-- FOREIGN KEYS: `interest_link_evidence` references interest_links(link_key), and D1 enforces foreign
-- keys, so dropping the parent mid-rebuild would be refused. `defer_foreign_keys` postpones the check to
-- the end of the transaction — the documented way to rebuild a referenced table — by which point the
-- renamed table satisfies it. D1 runs each file in one implicit transaction, so a failure rolls the whole
-- file back rather than leaving a half-swapped table.
PRAGMA defer_foreign_keys = true;

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

-- ── interest_links ──────────────────────────────────────────────────────────────────────────────────
-- `status` and `interest_class` ARE the publishing gate. The public surface is `status = 'published'`
-- AND a surfaced `interest_class`, so a value that merely resembles one — 'published ' with a trailing
-- space, the case #279 §2 names — passes every writer and then fails the gate silently. A CHECK binds
-- every writer at once, including a hand-run UPDATE during an incident, which is when it is most likely
-- to be typed.
--
-- Rows violating the new CHECKs are dropped by INSERT OR IGNORE rather than rewritten: a status we cannot
-- interpret is not a link we should publish or guess at, and the loader rebuilds the table on every run.
CREATE TABLE IF NOT EXISTS interest_links_0007 (
  id                  TEXT PRIMARY KEY,
  link_key            TEXT NOT NULL UNIQUE,
  person_id           TEXT NOT NULL REFERENCES persons(id),
  bidder_id           TEXT NOT NULL,
  eik                 TEXT NOT NULL,
  entity_key          TEXT NOT NULL,
  match_method        TEXT,
  matcher_version     TEXT NOT NULL,
  publish_tier        TEXT NOT NULL,
  relation            TEXT NOT NULL,
  interest_class      TEXT NOT NULL DEFAULT 'management_role'
                      CHECK (interest_class IN ('private_ownership','family_ownership',
                                                'ex_officio_board','management_role')),
  contemporaneous     INTEGER NOT NULL DEFAULT 0,
  own_institution     TEXT NOT NULL DEFAULT 'none',
  evidence_count      INTEGER NOT NULL DEFAULT 1,
  first_declared_year TEXT,
  last_declared_year  TEXT,
  contract_count      INTEGER NOT NULL DEFAULT 0,
  contract_value_eur  REAL,
  first_contract_year TEXT,
  last_contract_year  TEXT,
  status              TEXT NOT NULL DEFAULT 'held'
                      CHECK (status IN ('published','internal','held','withdrawn','suppressed')),
  verified_by         TEXT,
  verified_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO interest_links_0007
  (id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version, publish_tier,
   relation, interest_class, contemporaneous, own_institution, evidence_count, first_declared_year,
   last_declared_year, contract_count, contract_value_eur, first_contract_year, last_contract_year,
   status, verified_by, verified_at, created_at)
SELECT id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version, publish_tier,
       relation, interest_class, contemporaneous, own_institution, evidence_count, first_declared_year,
       last_declared_year, contract_count, contract_value_eur, first_contract_year, last_contract_year,
       status, verified_by, verified_at, created_at
FROM interest_links
WHERE status IN ('published','internal','held','withdrawn','suppressed')
  AND interest_class IN ('private_ownership','family_ownership','ex_officio_board','management_role');
DROP TABLE interest_links;
ALTER TABLE interest_links_0007 RENAME TO interest_links;
CREATE INDEX IF NOT EXISTS idx_interest_links_eik ON interest_links(eik);
CREATE INDEX IF NOT EXISTS idx_interest_links_person ON interest_links(person_id);
CREATE INDEX IF NOT EXISTS idx_interest_links_status ON interest_links(status);
