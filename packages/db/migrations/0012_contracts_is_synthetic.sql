-- Add is_synthetic to contracts: denormalizes the tenders.procedure_type='неизвестна' sentinel so
-- aggregate queries can filter synthetic orphan contracts without a JOIN to tenders.
-- Populated from the parent tender at insert time in normalize-raw.sql; 1 for synthetic tenders
-- (procedure_type='неизвестна'), 0 for all normal tenders.
ALTER TABLE contracts ADD COLUMN is_synthetic INTEGER NOT NULL DEFAULT 0;

UPDATE contracts
   SET is_synthetic = CASE WHEN t.procedure_type = 'неизвестна' THEN 1 ELSE 0 END
  FROM tenders t
 WHERE t.id = contracts.tender_id;

CREATE INDEX idx_contracts_is_synthetic ON contracts(is_synthetic) WHERE is_synthetic = 0;
