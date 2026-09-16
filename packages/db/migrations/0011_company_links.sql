-- Company↔company ties, precomputed.
--
-- The network on a company/authority profile drew `flow_pairs` only — authority ⇄ winner, i.e. money and
-- nothing else. The question a reader actually brings to a company profile is „who is this company tied
-- to", and the answer needs edges BETWEEN companies. Three kinds of tie are already in the corpus and
-- none of them requires a single personal name:
--
--   consortium     — both companies are named members of the same ДЗЗД/обединение that won a contract.
--                    3 944 edges over 1 851 companies. This is the strongest signal we have: joint
--                    bidding is a declared, documented relationship.
--   subcontract    — one company was recorded as the other's subcontractor on a contract (620 edges).
--   declared_stake — the same office-holder declared an interest in both companies (12 edges today,
--                    more as the Trade Register evidence lands). The PERSON is never a node and never
--                    named on an indexed page: the tie is drawn between the two companies and points at
--                    /conflicts, where the name is already published under the LIA.
--
-- Precomputed rather than derived per request because the consortium tie needs the member list split out
-- of `bidders.name`, which is a string operation over thousands of rows — a per-request cost the explorer
-- must not pay (same reasoning as flow_pairs).
--
-- Direction: `directed = 0` means the tie is symmetric and stored once with a_bidder_id < b_bidder_id.
-- `directed = 1` (subcontract) means a → b: a is the prime contractor, b the subcontractor.
CREATE TABLE IF NOT EXISTS company_links (
  a_bidder_id TEXT NOT NULL REFERENCES bidders(id),
  b_bidder_id TEXT NOT NULL REFERENCES bidders(id),
  kind        TEXT NOT NULL,            -- consortium | subcontract | declared_stake
  directed    INTEGER NOT NULL DEFAULT 0,
  -- Money behind the tie, for edge weight. The consortium sum is what the joint entities won together;
  -- the subcontract sum is the value of the contracts the pairing appears on. A declared_stake tie is not
  -- monetary — it carries 0 and the UI must not size it by money.
  weight_eur  REAL NOT NULL DEFAULT 0,
  -- How many distinct facts back the tie: shared consortia, contracts, or shared officials.
  occurrences INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (a_bidder_id, b_bidder_id, kind)
);

-- The graph is drawn from ONE company outwards, so both endpoints need a lookup.
CREATE INDEX IF NOT EXISTS idx_company_links_a ON company_links (a_bidder_id, weight_eur DESC);
CREATE INDEX IF NOT EXISTS idx_company_links_b ON company_links (b_bidder_id, weight_eur DESC);

-- Resolved consortium membership: which corpus company is a named member of which обединение. Kept as a
-- real table rather than a CTE because building the pair edges needs a self-join over it, and a CTE has no
-- index — the unmaterialised version turned a 20-second precompute into a multi-minute one.
CREATE TABLE IF NOT EXISTS consortium_members (
  consortium_id TEXT NOT NULL REFERENCES bidders(id),
  bidder_id     TEXT NOT NULL REFERENCES bidders(id),
  PRIMARY KEY (consortium_id, bidder_id)
);
CREATE INDEX IF NOT EXISTS idx_consortium_members_bidder ON consortium_members (bidder_id);
