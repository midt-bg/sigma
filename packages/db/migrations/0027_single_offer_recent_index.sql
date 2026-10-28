-- The homepage's most recent single-offer contracts (queries/contracts.ts listSingleOfferContracts, mode
-- 'recent'): ORDER BY COALESCE(signed_at, published_at) DESC, id over the contracts with one offer and a
-- euro value. No index matched that expression, so every render read and sorted the whole contracts table
-- with its joins — about half a million rows for ten — and, the page being cached per colo, that was most
-- of the database's reads. This partial index holds exactly those contracts in exactly that order, so the
-- query walks it and stops at LIMIT. SYNC: the expression, directions and WHERE must stay identical to the
-- query; single-offer-index.test.ts checks the plan.
CREATE INDEX IF NOT EXISTS idx_contracts_single_offer_recent
  ON contracts(COALESCE(signed_at, published_at) DESC, id ASC)
  WHERE bids_received = 1 AND amount_eur IS NOT NULL;
