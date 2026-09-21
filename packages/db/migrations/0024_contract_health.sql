-- Health-index foundation: add the nine columns required by the Contract Quality / Health Index
-- spec (§7.1). Columns added after a table's creating migration live ONLY here — they are
-- intentionally NOT folded into 0000_init.sql, because SQLite has no ADD COLUMN IF NOT EXISTS and
-- `wrangler d1 migrations apply` on a fresh D1 runs the whole chain (0000 then 0024 would hit
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
-- Numbered 0024: main ships 0000-0022 (0012 is `0012_person_redirects`) and 0023 is reserved for the
-- dashboard spine's `contracts_overrun_index`, so this is the next free slot.
-- Production: the D1 migration ledger is NOT used for this chain (the base schema was created
-- out-of-band via `d1 execute --file`, so `wrangler d1 migrations apply` would replay 0000 and
-- collide). deploy.yml therefore applies these nine ALTERs itself in the "Ensure contract-health
-- columns exist" step (probe pragma_table_info, ALTER only when absent). The served D1 does need
-- them: ship-domain.mjs copies every source column and derive-contract-features.sql reads them.
-- These nine ALTERs are purely additive (new nullable columns on existing tables) and read
-- no state introduced by 0012-0023, so applying after them in sorted order (fresh D1, CI, and the
-- work-DB backfill in scripts/import.mjs) is deterministic and safe.

ALTER TABLE contracts  ADD COLUMN exemption_legal_basis TEXT;
ALTER TABLE contracts  ADD COLUMN outside_zop           INTEGER;
ALTER TABLE contracts  ADD COLUMN dps_contract          INTEGER;
ALTER TABLE amendments ADD COLUMN reason                TEXT;
ALTER TABLE amendments ADD COLUMN circumstances         TEXT;
ALTER TABLE tenders    ADD COLUMN corrections_count     INTEGER;
ALTER TABLE tenders    ADD COLUMN estimated_value_eur   REAL;
ALTER TABLE flow_pairs ADD COLUMN first_date            TEXT;
ALTER TABLE flow_pairs ADD COLUMN last_date             TEXT;
