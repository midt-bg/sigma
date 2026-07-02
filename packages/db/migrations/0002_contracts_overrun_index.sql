-- Partial index for the overrun predicate (annex_count > 0 AND current_value_eur > signing_value_eur
-- AND signing_value_eur >= 1000), shared by /overruns + /analytics (OVERRUN_WHERE in
-- packages/db/src/queries/overruns.ts). Those pages run several aggregates over that predicate; with no
-- index each one full-scans ~190k contracts. The annex_count > 0 partial keeps the index to the small
-- minority of contracts that carry annexes (the only rows that can ever be overruns), so every overrun
-- aggregate starts from that narrow set instead of the whole table.
CREATE INDEX IF NOT EXISTS idx_contracts_overrun ON contracts(annex_count) WHERE annex_count > 0;
