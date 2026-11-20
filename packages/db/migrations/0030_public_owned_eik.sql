-- Public ownership the Trade Register records (ADR-0047), derived by the registry workflow for a company
-- the curated list (0029_state_owned_eik.sql) does not name. Read with it by
-- packages/db/src/queries/public-stakes.ts; until now created only by the ETL (scripts/normalize-raw.sql,
-- apps/etl/src/public-ownership.ts), so a database no import had touched answered a person page with
-- „no such table“. Same definition as the ETL's, IF NOT EXISTS, filled by the registry workflow.
CREATE TABLE IF NOT EXISTS public_owned_eik (
  eik TEXT PRIMARY KEY,
  ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('state', 'municipal'))
);
