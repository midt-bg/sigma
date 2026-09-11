-- The Trade Register layer (ADR-0041): who manages, represents, owns and controls the procurement winners, read
-- from the register's API by the daily ETL. Facts as registered, each with the entry it rests on.
CREATE TABLE IF NOT EXISTS registry_deeds (
  eik        TEXT PRIMARY KEY,   -- the partida's ЕИК
  name       TEXT,               -- the firm as registered
  legal_form TEXT,
  status     TEXT,               -- the partida's status as the register gives it
  outcome    TEXT NOT NULL CHECK (outcome IN ('ok', 'absent')), -- absent: the register has no partida for it
  fetched_at TEXT NOT NULL       -- when it was last read
);

-- A natural person as the register identifies them: the salted identifier the register publishes in place of
-- the personal number, and the latest registered spelling of the name.
CREATE TABLE IF NOT EXISTS registry_persons (
  indent      TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  indent_type TEXT
);

-- One registered fact: a person or an entity in a role at a company, from the entry that added it until the
-- entry that struck it off.
CREATE TABLE IF NOT EXISTS registry_roles (
  eik          TEXT NOT NULL,     -- the company
  field_ident  TEXT NOT NULL,     -- the register field (00070 managers … 05500 actual owners)
  record_id    TEXT NOT NULL,     -- the register's record within the field
  role         TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('person', 'entity')),
  subject_id   TEXT NOT NULL,     -- the register's person identifier, or the entity's ЕИК / name
  subject_name TEXT NOT NULL,
  share        TEXT,              -- as registered, where the field carries one
  country      TEXT,
  entry_number TEXT NOT NULL,     -- the registration that added it
  added_on     TEXT NOT NULL,
  removed_on   TEXT,              -- the registration date that struck it off; NULL while it stands
  PRIMARY KEY (eik, field_ident, record_id, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_registry_roles_subject ON registry_roles (subject_id);

-- The partidas still to read: winners never read yet, and read ones the register has since changed.
CREATE TABLE IF NOT EXISTS registry_queue (
  eik       TEXT PRIMARY KEY,
  reason    TEXT NOT NULL CHECK (reason IN ('new', 'changed')),
  queued_at TEXT NOT NULL
);

-- The run's lease and how far the changes feed has been followed.
CREATE TABLE IF NOT EXISTS registry_sync (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  changes_through TEXT,           -- the last load day of the API whose changes were queued
  holder          TEXT,
  expires_at      TEXT
);
