-- Entity "newest contracts" feeds (RSS) paginate with
--   ORDER BY COALESCE(signed_at, published_at) DESC, id DESC LIMIT 50
-- scoped to one company or one authority. Without a matching index SQLite gathers ALL of the entity's
-- contracts and does a full USE TEMP B-TREE FOR ORDER BY to return 50 — a public, unauthenticated
-- Denial-of-Wallet vector on a big supplier / ministry (D1 bills rows SCANNED). These two composite
-- indexes let each feed walk the index scoped to the entity and stop at LIMIT.

-- Company feed: WHERE bidder_id = ? (already a column on contracts).
CREATE INDEX IF NOT EXISTS idx_contracts_bidder_recent
  ON contracts(bidder_id, COALESCE(signed_at, published_at) DESC, id DESC);

-- Authority feed: WHERE authority_id = ?. authority_id lives on `tenders`, not `contracts`, so a
-- scoped index is impossible without denormalising it onto the contract row. Add the column, backfill
-- it from the parent tender, and index it. The ETL keeps it populated (scripts/normalize-raw.sql and
-- scripts/refresh-slice.sql set it right after inserting contracts). SQLite ALTER ADD COLUMN has no
-- IF NOT EXISTS, but migrations apply once; the backfill covers rows that predate this migration.
ALTER TABLE contracts ADD COLUMN authority_id TEXT;
UPDATE contracts
   SET authority_id = (SELECT t.authority_id FROM tenders t WHERE t.id = contracts.tender_id)
 WHERE authority_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_contracts_authority_recent
  ON contracts(authority_id, COALESCE(signed_at, published_at) DESC, id DESC);
