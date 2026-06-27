-- Support company-centered network hop-1 lookups.
CREATE INDEX IF NOT EXISTS idx_flow_pairs_bidder ON flow_pairs(bidder_id);
