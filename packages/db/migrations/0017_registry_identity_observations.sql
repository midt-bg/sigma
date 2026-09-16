-- Identity facts retain the name as it appeared in EACH entry, not only the last role spelling.
CREATE TABLE IF NOT EXISTS registry_identity_observations (
  eik TEXT NOT NULL, sub_uic TEXT NOT NULL, field_ident TEXT NOT NULL,
  entry_number TEXT NOT NULL, entry_on TEXT NOT NULL, holder_index INTEGER NOT NULL,
  registry_indent TEXT, indent_type TEXT, name TEXT NOT NULL, name_key TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('person','collective','other')),
  source_hash TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY(eik, sub_uic, field_ident, entry_number, holder_index)
);
CREATE INDEX IF NOT EXISTS idx_registry_identity_name ON registry_identity_observations(name_key,eik);
CREATE INDEX IF NOT EXISTS idx_registry_identity_indent ON registry_identity_observations(registry_indent);
CREATE TABLE IF NOT EXISTS registry_identity_snapshots (
  eik TEXT PRIMARY KEY, source_hash TEXT NOT NULL, fetched_at TEXT NOT NULL
);
-- Requests are sourced from declarations, whether or not the company has a procurement contract.
CREATE TABLE IF NOT EXISTS registry_requested_companies (
  eik TEXT NOT NULL, declaration_id TEXT NOT NULL, declared_name TEXT NOT NULL,
  PRIMARY KEY(eik,declaration_id)
);
ALTER TABLE registry_roles ADD COLUMN uncertain_after TEXT;
