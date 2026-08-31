-- Partial index for the overrun predicate (annex_count > 0 AND current_value_eur > signing_value_eur
-- AND signing_value_eur >= 1000), shared by /overruns + /analytics (OVERRUN_WHERE in
-- packages/db/src/queries/overruns.ts). Those pages run several aggregates over that predicate; with no
-- index each one full-scans ~190k contracts. The annex_count > 0 partial keeps the index to the small
-- minority of contracts that carry annexes (the only rows that can ever be overruns), so every overrun
-- aggregate starts from that narrow set instead of the whole table.
--
-- Composite on (signing_value_eur, current_value_eur) rather than annex_count alone: EXPLAIN QUERY
-- PLAN against a ~190k-row fixture showed the annex_count-only index still needs a table lookup per
-- matching row to evaluate `current_value_eur > signing_value_eur`, while this composite answers the
-- predicate itself straight from the index (both value columns are covered) — ~4x fewer ms/run in
-- that benchmark. NOT fully covering for every OVERRUN_WHERE consumer: the by-authority/by-sector
-- breakdowns and the leaderboard also JOIN on c.tender_id and select further contracts columns
-- (c.id, c.bidder_id, c.eu_funded, ...), so those still take one table lookup per matching row. The
-- conditional-aggregate scan in getOverrunsAnalytics (total_overrun_eur/count/avg_pct, all gated by
-- OVERRUN_WHERE) is the one this index fully answers; `corpus_signing_eur` in that same query is a
-- corpus-wide SUM with no WHERE (it's the shareOfSigning denominator, not an overrun-scoped figure),
-- so it still full-scans contracts regardless of this index.
CREATE INDEX IF NOT EXISTS idx_contracts_overrun ON contracts(signing_value_eur, current_value_eur)
  WHERE annex_count > 0;

-- No down-migration: migrations in this repo are forward-only by convention (0000_init.sql,
-- 0001_flow_pairs_bidder_index.sql have none either), matching wrangler d1's migration tooling,
-- which has no built-in rollback.
