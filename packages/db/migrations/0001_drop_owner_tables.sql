-- C2 compliance remediation: remove unserved owner/beneficial-owner tables and staging tables.
-- Because 0000_init.sql was edited after being applied, existing D1 deployments may require
-- a migration checksum reset before this incremental migration can be applied.

DROP INDEX IF EXISTS idx_tr_owners_uic;
DROP INDEX IF EXISTS idx_tr_actual_owners_uic;
DROP INDEX IF EXISTS idx_company_owners_company;
DROP INDEX IF EXISTS idx_company_owners_owner;
DROP INDEX IF EXISTS idx_beneficial_owners_company;

DROP TABLE IF EXISTS company_owners;
DROP TABLE IF EXISTS beneficial_owners;
DROP TABLE IF EXISTS raw_tr_owners;
DROP TABLE IF EXISTS raw_tr_actual_owners;

CREATE INDEX IF NOT EXISTS idx_company_totals_name ON company_totals(name);
CREATE INDEX IF NOT EXISTS idx_authority_totals_name ON authority_totals(name);

CREATE INDEX IF NOT EXISTS idx_contracts_value_desc ON contracts(COALESCE(amount_eur, -1));
CREATE INDEX IF NOT EXISTS idx_contracts_value_asc ON contracts(COALESCE(amount_eur, 1e18));
