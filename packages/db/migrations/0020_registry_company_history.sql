-- Source-backed historic name/form pairs. An empty array also records a completed read.
CREATE TABLE IF NOT EXISTS registry_company_history (
  eik TEXT PRIMARY KEY,
  names_json TEXT NOT NULL CHECK(json_valid(names_json)),
  source_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
