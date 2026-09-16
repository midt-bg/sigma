-- Source metadata and an evidenced bridge between the two person namespaces.
CREATE TABLE IF NOT EXISTS declaration_metadata (
  declaration_id TEXT PRIMARY KEY REFERENCES declarations(id),
  declaration_type TEXT,
  declared_on TEXT,
  submitted_on TEXT
);
CREATE TABLE IF NOT EXISTS person_registry_links (
  person_id TEXT PRIMARY KEY REFERENCES persons(id),
  registry_indent TEXT NOT NULL,
  evidence_link_key TEXT NOT NULL,
  evidence_entry_number TEXT NOT NULL,
  matched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_person_registry_links_indent ON person_registry_links(registry_indent);

-- Exact document-to-company resolution, independent of trade-name spelling.
-- A name key cannot distinguish two companies explicitly identified by different EIKs.
CREATE TABLE IF NOT EXISTS declaration_companies (
  declaration_id TEXT NOT NULL REFERENCES declarations(id),
  eik TEXT NOT NULL,
  match_method TEXT NOT NULL,
  PRIMARY KEY (declaration_id, eik)
);
CREATE INDEX IF NOT EXISTS idx_declaration_companies_eik ON declaration_companies(eik, declaration_id);

-- Temporal provenance is independent of publication confidence. A later omission
-- is not a sale date; a registry role's end is the date for THAT role only.
CREATE TABLE IF NOT EXISTS interest_link_history (
  link_key TEXT PRIMARY KEY REFERENCES interest_links(link_key),
  later_declaration_year TEXT,
  registry_role_ended_on TEXT
);
