-- Health-index foundation: add the nine columns required by the Contract Quality / Health Index spec
-- (docs/contract-quality-spec.local.md §7.1).  All nine use ADD COLUMN which is idempotent-safe when
-- run once against an already-seeded local D1 (D1/SQLite silently ignores duplicate ADD COLUMN only
-- via IF NOT EXISTS — not supported — so this migration must be applied exactly once).
-- The same columns are also folded into 0000_init.sql so fresh imports include them directly.

ALTER TABLE contracts  ADD COLUMN exemption_legal_basis TEXT;
ALTER TABLE contracts  ADD COLUMN outside_zop           INTEGER;
ALTER TABLE contracts  ADD COLUMN dps_contract          INTEGER;
ALTER TABLE amendments ADD COLUMN reason                TEXT;
ALTER TABLE amendments ADD COLUMN circumstances         TEXT;
ALTER TABLE tenders    ADD COLUMN corrections_count     INTEGER;
ALTER TABLE tenders    ADD COLUMN estimated_value_eur   REAL;
ALTER TABLE flow_pairs ADD COLUMN first_date            TEXT;
ALTER TABLE flow_pairs ADD COLUMN last_date             TEXT;
