-- A close relative an official declared a stake for, as the Trade Register itself records that relative in the
-- declared company: the official's profile names the relative, and a relative with a registry profile links
-- back. Rebuilt on every load from published family links, the declarations' related-person tables and the
-- registry's holders of the declared company (ADR-0044).
CREATE TABLE IF NOT EXISTS person_relatives (
  person_id       TEXT NOT NULL REFERENCES persons(id),
  relative_indent TEXT NOT NULL,   -- the register's identifier for the relative
  eik             TEXT NOT NULL,   -- the declared company the register lists the relative at
  relative_name   TEXT NOT NULL,   -- the register's spelling of the relative's name
  PRIMARY KEY (person_id, relative_indent, eik)
);
CREATE INDEX IF NOT EXISTS idx_person_relatives_relative ON person_relatives(relative_indent);
