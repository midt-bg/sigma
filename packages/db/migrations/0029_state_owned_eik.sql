-- The curated list of public enterprises (the Public Enterprises and Control Agency's list, ADR-0047) that
-- the read path joins: a company's ownership chip and a person's public stakes
-- (packages/db/src/queries/public-stakes.ts). Until now only the ETL created it — scripts/seed-state-owned.sql,
-- scripts/normalize-raw.sql and apps/etl/src/public-ownership.ts each carry the same CREATE TABLE IF NOT
-- EXISTS — so a database no import had touched, like a fresh local one, answered a person page with
-- „no such table“.
--
-- The definition is the one the ETL already writes, and IF NOT EXISTS keeps this a no-op where the ETL got
-- there first. The ETL fills it; an empty table is the honest state of a database nothing was imported into.
-- One table per file on purpose: scripts/release-schema.mjs marks a file whose objects are all on the
-- target and refuses one that is only partly there, and the two ownership tables do not always arrive together.
CREATE TABLE IF NOT EXISTS state_owned_eik (
  eik TEXT PRIMARY KEY,
  ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('state', 'municipal', 'mixed')),
  canonical_name TEXT NOT NULL
);
