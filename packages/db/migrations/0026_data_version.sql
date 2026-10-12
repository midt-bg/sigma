-- The version of the computation rules a slot's rows were built with (docs/deploy.md, „Версията на
-- данните“). One row, written by the slot rebuild once the slot is verified; absent on a database no
-- rebuild has finished. A production deploy compares it with packages/db/data-version.json and refuses to
-- release in place over rows built by other rules: those are rebuilt in the idle slot and switched to.
CREATE TABLE data_version (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  version       INTEGER NOT NULL,
  source_commit TEXT,
  built_at      TEXT NOT NULL,
  run_id        TEXT
);
