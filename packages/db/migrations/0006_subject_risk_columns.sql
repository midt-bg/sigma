-- Subject-risk columns (issue #229) — canonical per-contract flags + per-subject rollups.
--
-- Added as a NUMBERED migration, NOT by editing 0000_init: the served D1 is persistent and
-- `wrangler d1 migrations apply` is filename-tracked, so an edit to the already-applied 0000_init reaches
-- the work DB (and green local CI) but NEVER prod — the #188/#239 applied-migration trap. New objects go
-- through a new migration; 0000_init is touched only on a full rebuild.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, so these columns live ONLY here — a fresh DB applies 0000_init
-- (without them) then this file. The `CREATE TABLE IF NOT EXISTS` mirror in scripts/precompute.sql stays a
-- no-op on the existing tables. Number 0006 clears the 0002 claimants (#226/#193/#172) to avoid a
-- duplicate-version at apply; a gap is harmless for filename-tracked application.

-- contracts: canonical per-contract flags, materialized by scripts/precompute.sql + refresh-slice.sql.
ALTER TABLE contracts ADD COLUMN is_single_offer INTEGER;  -- 1/0 = bids_received = 1; NULL = bid count unknown (never counted as 0 by the rollup shares)
ALTER TABLE contracts ADD COLUMN is_high_markup  INTEGER;  -- 1/0 = (current−signing)/signing > 0.2 on value_flag='ok' rows; NULL = ineligible (suspect / signing≤0 / EUR absent)

-- company_totals: per-subject risk rollups. Composite + band derived in the read layer (details.ts).
ALTER TABLE company_totals ADD COLUMN single_offer_k           INTEGER;  -- # flagged single-offer (is_single_offer = 1)
ALTER TABLE company_totals ADD COLUMN single_offer_n           INTEGER;  -- # eligible (bids_received >= 1) — count-share denominator
ALTER TABLE company_totals ADD COLUMN single_offer_value_share REAL;     -- Σ flagged amount_eur / Σ eligible amount_eur; NULL if no eligible value
ALTER TABLE company_totals ADD COLUMN high_markup_k            INTEGER;  -- # flagged high-markup (is_high_markup = 1)
ALTER TABLE company_totals ADD COLUMN high_markup_n            INTEGER;  -- # eligible (is_high_markup IS NOT NULL)
ALTER TABLE company_totals ADD COLUMN high_markup_value_share  REAL;     -- Σ flagged amount_eur / Σ eligible amount_eur; NULL if no eligible value

-- authority_totals: same rollups per authority (single_offer_n matches getAuthoritySingleOffer).
ALTER TABLE authority_totals ADD COLUMN single_offer_k           INTEGER;
ALTER TABLE authority_totals ADD COLUMN single_offer_n           INTEGER;
ALTER TABLE authority_totals ADD COLUMN single_offer_value_share REAL;
ALTER TABLE authority_totals ADD COLUMN high_markup_k            INTEGER;
ALTER TABLE authority_totals ADD COLUMN high_markup_n            INTEGER;
ALTER TABLE authority_totals ADD COLUMN high_markup_value_share  REAL;
