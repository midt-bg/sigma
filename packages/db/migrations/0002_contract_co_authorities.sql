-- Joint procurements retain one lead authority on tenders, while this bridge records every
-- participating authority. ordinal = 0 is always the lead; remaining members keep source order.
CREATE TABLE IF NOT EXISTS contract_co_authorities (
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  authority_id TEXT NOT NULL REFERENCES authorities(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (contract_id, authority_id)
);

CREATE INDEX IF NOT EXISTS idx_contract_co_authorities_authority
  ON contract_co_authorities(authority_id, contract_id);

-- Non-monetary participation stays outside authority_totals, whose spend/count reconciliation is
-- intentionally unchanged and lead-only.
CREATE TABLE IF NOT EXISTS authority_joint_participation (
  authority_id                  TEXT PRIMARY KEY REFERENCES authorities(id),
  joint_contract_participations INTEGER NOT NULL
);
