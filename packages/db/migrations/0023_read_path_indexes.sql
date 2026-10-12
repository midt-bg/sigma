-- Read-path indexes, where the query planner otherwise reaches the rows the hard way.
--
-- A company's published links are asked for by ЕИК and status together — the person activity per contract,
-- the link cards, the disputed-year check. With only the single-column indexes to choose from, the planner
-- took the status one and read every published link for each contract it looked at (744 thousand rows for
-- one heavy profile's activity, 50 thousand with this index). Applied by name on every deploy and kept by the
-- declarations publication, whose swap re-creates the served table's indexes on each new generation.
CREATE INDEX IF NOT EXISTS idx_interest_links_eik_status ON interest_links(eik, status);
-- …and a person's published links by person and status together: the list of registry people checks, per
-- person, that none of their links is published, and the status index read all of them for each person.
CREATE INDEX IF NOT EXISTS idx_interest_links_person_status ON interest_links(person_id, status);
-- …a company's published links by bidder and status together: counting each supplier's or graph node's
-- surfaced conflicts read every published link for every row (some 60 thousand rows for a large authority's
-- suppliers, 1.5 thousand with this index).
CREATE INDEX IF NOT EXISTS idx_interest_links_bidder_status ON interest_links(bidder_id, status);
-- …and the observations by timing and year: a link's disputed years are its 'not_listed' observations, which
-- were found by reading all of them for every link.
CREATE INDEX IF NOT EXISTS idx_interest_observations_timing ON interest_link_observations(timing, reported_year);
