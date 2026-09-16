-- Old official ids → the id each became under the identity grain now in force (ADR-0040). An official page
-- requested under an id that no longer exists 301s to the one it became. The loader rebuilds the table on
-- every run from the same staging, so it never accumulates and never goes stale.
CREATE TABLE IF NOT EXISTS person_redirects (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL
);
