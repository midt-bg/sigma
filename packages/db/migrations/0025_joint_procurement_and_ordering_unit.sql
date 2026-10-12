-- Joint procurements and the verbatim ordering unit (#251, #253).
--
-- These objects first entered the schema as edits to 0000_init.sql, after 0000 had already been applied to
-- served databases. A database that applied the original 0000 never received them, and wrangler's ledger
-- would never apply 0000 again. 0000_init.sql is back to the text that was applied, and the objects live
-- here, so every database reaches them through the ledger. A database that already holds them — one built
-- from the edited 0000 — records this migration as applied instead of running it (scripts/release-schema.mjs).

-- Verbatim "Възложител" (raw authority_name) on the row; preserves sub-unit identity collapsed by the
-- canonical authorities.name (mode).
ALTER TABLE tenders ADD COLUMN ordering_unit_name TEXT;
ALTER TABLE contracts ADD COLUMN ordering_unit_name TEXT;

-- Joint procurements retain one lead authority on tenders (the only authority that receives spend),
-- while this bridge records every participating authority. ordinal 0 is always the lead.
CREATE TABLE contract_co_authorities (
  contract_id  TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  authority_id TEXT NOT NULL REFERENCES authorities(id),
  ordinal      INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (contract_id, authority_id)
);
CREATE INDEX idx_contract_co_authorities_authority
  ON contract_co_authorities(authority_id, contract_id);

-- Joint-procurement participation rollup. joint_contract_value_eur is the total value of the joint
-- procurements the authority took part in; it is informational only and must NEVER be summed into
-- authority_totals.spent_eur or any national/leaderboard total.
CREATE TABLE authority_joint_participation (
  authority_id                 TEXT PRIMARY KEY REFERENCES authorities(id),
  joint_contract_participations INTEGER NOT NULL,
  joint_contract_value_eur      REAL NOT NULL DEFAULT 0
);
