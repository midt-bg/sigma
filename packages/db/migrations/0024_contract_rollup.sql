-- The contracts list's headline — how many contracts, their value, how many of them have no confirmed value —
-- for every combination of the list's rail filters, so a page reads it by primary key instead of summing the
-- corpus. Summing it per request was most of what an uncached page of /contracts cost (some 800 thousand
-- rows read for the unfiltered list), and a crawler walking the list's pages and filters turns that into an
-- overloaded database.
--
-- One row per combination of the six dimensions, each either a value or '(all)' when the filter is not set:
-- the unfiltered list is the row with '(all)' everywhere. Only contracts the list shows are counted (those
-- with a tender, an authority and a bidder). The values are the list's own expressions:
--   procedure_type  the tender's procedure type, as stored
--   eu              '1' when eu_funded = 1, '0' when it is 0 or NULL, '?' for anything else
--   sector          substr(cpv_code, 1, 2), '' when the tender has no code
--   one_offer       '1' when bids_received = 1, else '0'
--   value_bucket    the VALUE_BUCKETS key the amount falls in (contracts.ts), '' for no amount or a negative one
--   year            the four digits that start signed_at, else 'unknown'
--
-- Filled by precompute.sql and kept by every refresh, which writes only the rows that changed. Both create the
-- table IF NOT EXISTS, so a served database that predates this migration gets it on its next refresh; until
-- then the list counts live, as before.
CREATE TABLE IF NOT EXISTS contract_rollup (
  procedure_type TEXT NOT NULL,
  eu             TEXT NOT NULL,
  sector         TEXT NOT NULL,
  one_offer      TEXT NOT NULL,
  value_bucket   TEXT NOT NULL,
  year           TEXT NOT NULL,
  contracts      INTEGER NOT NULL,
  value_eur      REAL NOT NULL,
  unverified     INTEGER NOT NULL,
  PRIMARY KEY (procedure_type, eu, sector, one_offer, value_bucket, year)
) WITHOUT ROWID;
