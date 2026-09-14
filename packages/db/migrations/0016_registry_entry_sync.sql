-- Independent of the historical API load-day cursor. Entry passes remain retryable until complete.
CREATE TABLE IF NOT EXISTS registry_entry_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), seeded_through TEXT NOT NULL,
  xml_retry_at TEXT,
  portal_retry_at TEXT, initial_refresh_queued INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS registry_entry_passes (
  day TEXT NOT NULL, delay INTEGER NOT NULL CHECK (delay IN (1,3,7,14,33)),
  due_on TEXT NOT NULL, next_page INTEGER NOT NULL DEFAULT 1,
  first_count INTEGER, rows_seen INTEGER NOT NULL DEFAULT 0, last_page_key TEXT,
  completed_at TEXT, PRIMARY KEY(day, delay)
);
CREATE INDEX IF NOT EXISTS idx_registry_pass_due ON registry_entry_passes(completed_at, due_on);
CREATE TABLE IF NOT EXISTS registry_entry_signals (
  eik TEXT NOT NULL, entry_date TEXT NOT NULL, detected_at TEXT NOT NULL,
  confirmed_at TEXT, PRIMARY KEY(eik, entry_date)
);
CREATE INDEX IF NOT EXISTS idx_registry_signal_pending ON registry_entry_signals(eik, confirmed_at);
