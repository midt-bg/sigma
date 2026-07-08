-- Ordering indexes for the non-default list sorts, so a keyset page walks an index and stops at
-- LIMIT instead of scanning + temp-B-tree-sorting the whole table on every request (D1 bills rows
-- SCANNED). The default sorts already had matching indexes (idx_contracts_value_desc/asc,
-- idx_company_totals_won/name, idx_authority_totals_spent/name); these cover the sorts that were
-- missing one. Each index matches the EXACT ORDER BY expression the query layer emits (the COALESCE
-- forms in queries/contracts.ts SORTS) plus the keyset id tiebreak in the same direction, so SQLite
-- neither sorts nor buffers. Additive + idempotent; the rollup tables are DELETE+INSERT-refreshed
-- (never dropped), so these survive every ETL ship.

-- /contracts ?sort=date-desc | date-asc — ORDER BY COALESCE(signed_at, …), c.id (queries/contracts.ts).
-- idx_contracts_signed is on the bare signed_at column and does NOT match the COALESCE expression.
CREATE INDEX IF NOT EXISTS idx_contracts_signed_desc
  ON contracts(COALESCE(signed_at, '') DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_contracts_signed_asc
  ON contracts(COALESCE(signed_at, '9999-99') ASC, id ASC);

-- /companies ?sort=count | authorities — ORDER BY <col> DESC, bidder_id DESC (queries/companies.ts).
CREATE INDEX IF NOT EXISTS idx_company_totals_count
  ON company_totals(contracts DESC, bidder_id DESC);
CREATE INDEX IF NOT EXISTS idx_company_totals_authorities
  ON company_totals(authorities DESC, bidder_id DESC);

-- /authorities ?sort=count | avg — ORDER BY <col> DESC, authority_id DESC (queries/authorities.ts).
CREATE INDEX IF NOT EXISTS idx_authority_totals_count
  ON authority_totals(contracts DESC, authority_id DESC);
CREATE INDEX IF NOT EXISTS idx_authority_totals_avg
  ON authority_totals(avg_eur DESC, authority_id DESC);
