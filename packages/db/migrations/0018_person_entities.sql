-- Durable identity, independent of display names and the rebuilt declaration tables.
CREATE TABLE IF NOT EXISTS person_entities (
  id TEXT PRIMARY KEY, registry_indent TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS person_sources (
  id TEXT PRIMARY KEY, namespace TEXT NOT NULL, source_key TEXT NOT NULL,
  source_hash TEXT NOT NULL, name TEXT NOT NULL, legacy_person_id TEXT,
  entity_id TEXT REFERENCES person_entities(id), resolution_reason TEXT, active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(namespace,source_key)
);
CREATE INDEX IF NOT EXISTS idx_person_sources_entity ON person_sources(entity_id,active);
CREATE INDEX IF NOT EXISTS idx_person_sources_legacy ON person_sources(legacy_person_id,active);
CREATE TABLE IF NOT EXISTS person_identity_evidence (
  id TEXT PRIMARY KEY, left_source TEXT NOT NULL REFERENCES person_sources(id),
  right_source TEXT NOT NULL REFERENCES person_sources(id),
  left_hash TEXT NOT NULL, right_hash TEXT NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('same','different')),
  decision TEXT NOT NULL CHECK(decision IN ('accepted','candidate','revoked')),
  origin TEXT NOT NULL CHECK(origin IN ('automatic','reviewed')),
  rule_version TEXT NOT NULL, facts TEXT NOT NULL, observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_person_evidence_left ON person_identity_evidence(left_source,decision);
CREATE INDEX IF NOT EXISTS idx_person_evidence_right ON person_identity_evidence(right_source,decision);
-- Membership, rather than a frozen redirect, lets an old URL survive a later split.
CREATE TABLE IF NOT EXISTS person_source_aliases (
  alias_id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES person_sources(id),
  PRIMARY KEY(alias_id,source_id)
);
