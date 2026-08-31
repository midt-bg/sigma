-- Health-index foundation: add the nine columns required by the Contract Quality / Health Index
-- spec (§7.1). Columns added after a table's creating migration live ONLY here — they are
-- intentionally NOT folded into 0000_init.sql, because SQLite has no ADD COLUMN IF NOT EXISTS and
-- `wrangler d1 migrations apply` on a fresh D1 runs the whole chain (0000 then 0012 would hit
-- "duplicate column"). The work-DB backfill (scripts/import.mjs) applies the full migration chain
-- for the same reason. The health rollup tables need no ALTERs here: authority_health_rollup,
-- bidder_health_rollup, sector_concentration, and health_percentiles ship in 0000_init.sql for
-- fresh DBs and are (re)created idempotently (CREATE TABLE IF NOT EXISTS + DELETE + INSERT) by
-- derive-health.sql on already-migrated DBs. contract_features is different: it also ships in
-- 0000_init.sql, but derive-contract-features.sql rebuilds it via an atomic staging swap — build
-- into a disposable contract_features_next, then `DROP TABLE IF EXISTS contract_features; ALTER
-- TABLE contract_features_next RENAME TO contract_features;` in the same execute batch — not a
-- plain CREATE-IF-NOT-EXISTS recreate. Either idiom needs no ALTER here; both are noted for anyone
-- diffing this migration against the derive scripts.
--
-- Numbered 0012 to leave 0011 to `0011_contracts_overrun_index` (PRs #169/#170/#171/#172/#193).
-- CONFIRMED wrangler/deploy behaviour (verified against .github/workflows/deploy.yml 2026-08-31):
-- production's D1 migration ledger is NOT used for this chain — the base schema was created
-- out-of-band via `d1 execute --file`, so `wrangler d1 migrations apply` would try to replay 0000
-- and collide (the same reason 0003/0009/0010 each get their own hand-rolled, idempotent
-- `d1 execute --file <migration>` step in deploy.yml instead of a bulk `migrations apply`). This
-- file currently has NO such deploy.yml step, so these nine ALTERs do not yet reach production
-- through the existing deploy pipeline — tracked as a follow-up, out of scope for this migration
-- file. Filename-sort ordering between 0011 and 0012 therefore only matters for paths that DO run
-- the full chain from scratch in sorted order — a fresh D1 via `wrangler d1 migrations apply`, CI,
-- and the work-DB backfill (scripts/import.mjs) — where 0011 always applies before 0012
-- deterministically, every run, regardless of what was "already applied" (there is no partial
-- ledger state to race against). These nine ALTERs are purely additive (new nullable columns on
-- existing tables) and read no state introduced by 0011, so that deterministic ordering is safe
-- either way — but any FUTURE 0011 migration that these columns/tables depend on would need
-- re-numbering above 0012 instead.

ALTER TABLE contracts  ADD COLUMN exemption_legal_basis TEXT;
ALTER TABLE contracts  ADD COLUMN outside_zop           INTEGER;
ALTER TABLE contracts  ADD COLUMN dps_contract          INTEGER;
ALTER TABLE amendments ADD COLUMN reason                TEXT;
ALTER TABLE amendments ADD COLUMN circumstances         TEXT;
ALTER TABLE tenders    ADD COLUMN corrections_count     INTEGER;
ALTER TABLE tenders    ADD COLUMN estimated_value_eur   REAL;
ALTER TABLE flow_pairs ADD COLUMN first_date            TEXT;
ALTER TABLE flow_pairs ADD COLUMN last_date             TEXT;
