-- A daily entry scan is valid only after a complete registry import establishes its baseline.
-- Existing databases deliberately migrate to unknown: their coverage must be proved or rebuilt.
ALTER TABLE registry_entry_state ADD COLUMN baseline_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (baseline_status IN ('unknown','building','ready'));
ALTER TABLE registry_entry_state ADD COLUMN baseline_through TEXT;
ALTER TABLE registry_entry_state ADD COLUMN baseline_started_at TEXT;
ALTER TABLE registry_entry_state ADD COLUMN baseline_generation TEXT;
ALTER TABLE registry_entry_state ADD COLUMN baseline_run_id TEXT;
ALTER TABLE registry_entry_state ADD COLUMN baseline_completed_at TEXT;
