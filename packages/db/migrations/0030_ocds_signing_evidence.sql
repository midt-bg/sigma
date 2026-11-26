-- A numbered signing can have an unadmitted sibling with missing source value or currency.
-- Retain that veto on the admitted rows for amendment-only refreshes and the served gate.
ALTER TABLE contracts ADD COLUMN ocds_signing_incomplete INTEGER NOT NULL DEFAULT 0;
