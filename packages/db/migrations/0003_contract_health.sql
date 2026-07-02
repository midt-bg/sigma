-- Health-index foundation: add the nine columns required by the Contract Quality / Health Index
-- spec (§7.1). Columns added after a table's creating migration live ONLY here — they are
-- intentionally NOT folded into 0000_init.sql, because SQLite has no ADD COLUMN IF NOT EXISTS and
-- `wrangler d1 migrations apply` on a fresh D1 runs the whole chain (0000 then 0003 would hit
-- "duplicate column"). The work-DB backfill (scripts/import.mjs) applies the full migration chain
-- for the same reason. The health rollup tables need no ALTERs here: they ship in 0000_init.sql
-- for fresh DBs and are (re)created idempotently by the ETL derives (scripts/derive-health.sql,
-- scripts/derive-contract-features.sql) on already-migrated DBs.
-- Numbered 0003 to leave 0002 to `0002_contracts_overrun_index` (PRs #170/#171).

ALTER TABLE contracts  ADD COLUMN exemption_legal_basis TEXT;
ALTER TABLE contracts  ADD COLUMN outside_zop           INTEGER;
ALTER TABLE contracts  ADD COLUMN dps_contract          INTEGER;
ALTER TABLE amendments ADD COLUMN reason                TEXT;
ALTER TABLE amendments ADD COLUMN circumstances         TEXT;
ALTER TABLE tenders    ADD COLUMN corrections_count     INTEGER;
ALTER TABLE tenders    ADD COLUMN estimated_value_eur   REAL;
ALTER TABLE flow_pairs ADD COLUMN first_date            TEXT;
ALTER TABLE flow_pairs ADD COLUMN last_date             TEXT;
