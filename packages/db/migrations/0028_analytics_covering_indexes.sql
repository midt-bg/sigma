-- Analytical scans need only these small columns, not the full contract/tender rows (including source
-- payloads). Pin the covering access paths in competition.ts and trend.ts: on the served D1 corpus the
-- default planner kept choosing amount/date indexes followed by hundreds of thousands of table reads.
-- No derived values or refresh lifecycle: SQLite maintains these on every insert/update/delete.
CREATE INDEX IF NOT EXISTS idx_contracts_analytics_cover
  ON contracts(tender_id, bidder_id, amount_eur, signed_at, eu_funded, bids_received);
CREATE INDEX IF NOT EXISTS idx_tenders_analytics_cover
  ON tenders(id, authority_id, cpv_code, procedure_type);
CREATE INDEX IF NOT EXISTS idx_contracts_trend_cover
  ON contracts(signed_at, amount_eur, eu_funded) WHERE amount_eur IS NOT NULL;

-- The recurring-pairs panel ranks by count; the existing flow index ranks by value. Avoid reading and
-- sorting every pair just to take the first page.
CREATE INDEX IF NOT EXISTS idx_flow_pairs_recurrence
  ON flow_pairs(contracts DESC, won_eur DESC);
