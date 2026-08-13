-- #305 Tier-2 text-based value correction (packages/ingest/src/amendment-total.ts). Some ЦАИС ЕОП
-- annexes put the announced NEW TOTAL into the change field, doubling value_after. The основание text
-- resolves each: a restated total drives the corrected value_after (and current_value), a genuine
-- increment is confirmed correct. The served amendments row records the outcome so the UI can mark a
-- corrected row and the refresh-slice reconciliation can skip text-treated annexes when arithmetic-flagging.
--
--   value_restated  = 1 when value_after was rewritten to the text-confirmed true total, else 0.
--   value_treatment = the raw treatment label ('total_restated' / 'unchanged_restated' /
--                     'genuine_increment', NULL when the text carried no signal). Kept alongside
--                     value_restated because the slice reconciliation re-classifies from the served
--                     amendments and must skip confirmed-genuine increments (value_restated stays 0 there).
-- Additive columns. On the live stage DB (whose migration ledger is empty — base schema imported
-- out-of-band) these are applied by the column probe in .github/workflows/deploy.yml, which ALTERs only
-- when the column is missing; on a fresh ledger `d1 migrations apply` runs this file exactly once. SQLite
-- has no `ADD COLUMN IF NOT EXISTS`, so do not replay this file against a DB that already has the columns.
ALTER TABLE amendments ADD COLUMN value_restated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE amendments ADD COLUMN value_treatment TEXT;
