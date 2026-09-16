-- A source identity is supported by specific registry entries, independently of
-- whether its company interest currently qualifies for public display.
CREATE TABLE IF NOT EXISTS declaration_identity_evidence (
  declaration_id TEXT NOT NULL REFERENCES declarations(id),
  registry_indent TEXT NOT NULL,
  eik TEXT NOT NULL,
  entry_number TEXT NOT NULL,
  document_name TEXT NOT NULL,
  listed_names TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  PRIMARY KEY(declaration_id, registry_indent, eik)
);
CREATE INDEX IF NOT EXISTS idx_declaration_identity_indent ON declaration_identity_evidence(registry_indent);

-- An observed fact is not an inferred ownership interval. Historical-only links
-- can have observations while first_declared_year/last_declared_year stay NULL.
CREATE TABLE IF NOT EXISTS interest_link_observations (
  link_key TEXT NOT NULL REFERENCES interest_links(link_key),
  declaration_id TEXT NOT NULL REFERENCES declarations(id),
  kind TEXT NOT NULL,
  timing TEXT NOT NULL,
  reported_year TEXT,
  PRIMARY KEY(link_key, declaration_id, kind, timing)
);
CREATE INDEX IF NOT EXISTS idx_interest_observations_document ON interest_link_observations(declaration_id);
