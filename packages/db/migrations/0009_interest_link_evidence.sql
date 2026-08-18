-- Trade Register evidence seal for a свързани-лица link (#279 §8, ADR-0033).
--
-- WHY A SIDE TABLE and not columns on interest_links, since both were on the table:
--   1. SQLite's ALTER TABLE ... ADD COLUMN has no IF NOT EXISTS, and migrations here are applied by a
--      bare `wrangler d1 execute --file` with no applied-migrations tracking (see the workflow steps),
--      so a re-apply MUST be a no-op. `CREATE TABLE IF NOT EXISTS` is; ADD COLUMN is not.
--   2. scripts/cacbg/load.mjs rebuilds the CACBG tables from 0003 ALONE. A column added here would have
--      to be duplicated into 0003 and kept in step with it forever, and the day the two diverge the
--      loader silently drops the evidence for every link it writes.
--   3. §8 describes the seal as an attached artefact of a link, which is what this is.
--
-- A seal is written for EVERY link, not only published ones. The seals on held and withdrawn links are
-- what make the review queue reviewable — without them „why is this one hidden?" has no answer.
--
-- PII rail: `matched_fact` is a CLOSED VOCABULARY — 'seat:<CITY>' | 'role:owner:<FIELD>' |
-- 'role:manager:<FIELD>' | 'eik'. It must NEVER carry the matched name. The registry deed's names are
-- read only to produce a boolean and never leave git-ignored scratch (ADR-0033 decision 5); storing one
-- here would put third-party personal data on the served surface, which #279 §9 forbids outright. The
-- audit enforces the vocabulary with a pattern check, because a schema cannot.

CREATE TABLE IF NOT EXISTS interest_link_evidence (
  link_key      TEXT PRIMARY KEY REFERENCES interest_links(link_key),
  -- ADR-0033 decision 1, plus document_uncorroborated (ADR-0035: a name match whose COMPANY nothing
  -- corroborated). CHECKed because the read gate filters on this column — SURFACED_OWNERSHIP admits
  -- exactly 'document' and 'confirmed' — so an unlisted value is either a link that silently stops
  -- surfacing or, if it collides with a publishing name, one that surfaces unproven.
  evidence_kind TEXT NOT NULL
                CHECK (evidence_kind IN ('document','confirmed','document_uncorroborated','refuted',
                                         'bar_joint_stock','unknown','outside_tr')),
  -- owner | manager | NULL — only meaningful for evidence_kind='document'. The card renders this as
  -- „вписан като …", so a stray value becomes a public claim about a named person's registry role.
  registry_role TEXT CHECK (registry_role IS NULL OR registry_role IN ('owner','manager')),
  matched_fact  TEXT,             -- the closed vocabulary above. NEVER a name.
  -- TEXT, not INTEGER: a fieldEntryNumber like 20130716101007 is already 14 digits and exceeds the
  -- exact-integer range once it round-trips through JSON/JS.
  entry_number  TEXT,
  entry_date    TEXT,             -- ISO date of the registry entry the evidence rests on
  lookup_date   TEXT NOT NULL,    -- when the deed was fetched — the freshness bound on the claim
  rules_version TEXT NOT NULL,    -- evidence.mjs RULES_VERSION; §8's monotonicity gate keys on this
  -- live | terminated_owner_still | terminated_manager_still | terminated.
  -- RE-DERIVED on every run and deliberately NOT part of the seal's permanence: it asserts a present
  -- tense about a named person, and its freshness is bounded by the cache refresh cycle (ADR-0033 R3).
  live_status   TEXT NOT NULL
                CHECK (live_status IN ('live','terminated_owner_still','terminated_manager_still',
                                       'terminated')),
  sealed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The surface filters on evidence_kind ('document' | 'confirmed' publish); the audit scans by kind too.
CREATE INDEX IF NOT EXISTS idx_ile_kind ON interest_link_evidence(evidence_kind);
