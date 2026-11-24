-- A NULL in a newly staged publication is source evidence. Legacy amendments have only
-- effective public values, and their recalculated deltas cannot recover the source fields.
ALTER TABLE amendments ADD COLUMN value_evidence_known INTEGER NOT NULL DEFAULT 0;
ALTER TABLE amendments ADD COLUMN raw_value_after REAL;
ALTER TABLE amendments ADD COLUMN raw_value_delta REAL;

-- The contract publication's own estimate is independent of the procedure estimate in tenders.
-- NULL source denotes a legacy row. 'legacy:value_low' preserves an established symbolic
-- signing for legacy rows until the original publication supplies its estimate evidence.
ALTER TABLE contracts ADD COLUMN own_estimate_source TEXT;
ALTER TABLE contracts ADD COLUMN own_estimate_value REAL;
ALTER TABLE contracts ADD COLUMN own_estimate_currency TEXT;

-- Only a verified direct value match may support a later sibling. Legacy links have unknown
-- provenance, and an inherited link never becomes a vote solely because it already has an owner.
ALTER TABLE amendments ADD COLUMN value_anchor_kind TEXT
  CHECK (value_anchor_kind IN ('direct', 'inherited'));
ALTER TABLE amendments ADD COLUMN contractor_id_status TEXT
  CHECK (contractor_id_status IN ('absent', 'valid', 'unverified'));
ALTER TABLE amendments ADD COLUMN value_anchor_contractor_eik TEXT
  CHECK (value_anchor_contractor_eik IS NULL OR (
    value_anchor_kind IS 'direct' AND contractor_id_status IS 'valid'
    AND LENGTH(value_anchor_contractor_eik) IN (9, 13) AND INSTR(value_anchor_contractor_eik, char(0)) = 0
    AND value_anchor_contractor_eik NOT GLOB '*[^0-9]*'
  ));

-- Keep the signing currency before public defaults, and only checksum-validated supplier IDs.
-- The evidence status distinguishes missing IDs and supplied but unverified IDs.
ALTER TABLE contracts ADD COLUMN signing_currency_raw TEXT;
ALTER TABLE contracts ADD COLUMN signing_contractor_status TEXT
  CHECK (signing_contractor_status IN ('absent', 'valid', 'unverified'));
ALTER TABLE contracts ADD COLUMN signing_contractor_eik TEXT
  CHECK ((signing_contractor_status IS 'valid') = (signing_contractor_eik IS NOT NULL) AND (
    signing_contractor_eik IS NULL OR (
      LENGTH(signing_contractor_eik) IN (9, 13) AND INSTR(signing_contractor_eik, char(0)) = 0
      AND signing_contractor_eik NOT GLOB '*[^0-9]*'
    )
  ));

-- Look up direct anchors only for the original annex numbers in this slice.
CREATE INDEX idx_amendments_value_anchor ON amendments(unp, contract_number_raw)
  WHERE link_method = 'value_anchor' AND value_anchor_kind = 'direct';

-- Internal publication state. The assistant table allowlist excludes these tables.
-- A witness compares exact source appearances. It does not confer identity or act as a public key.
CREATE TABLE ocds_supplier_appearances (
  appearance TEXT PRIMARY KEY NOT NULL
);

-- The buyer actually used to publish an OCDS tender, for a later scoped privacy correction.
CREATE TABLE ocds_tender_buyers (
  tender_id TEXT PRIMARY KEY NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  appearance TEXT,
  source TEXT NOT NULL,
  authority_id TEXT NOT NULL
);
CREATE INDEX idx_ocds_tender_buyers_appearance ON ocds_tender_buyers(appearance);

-- Buyer evidence follows each admitted OCDS signing while OCDS can own the procedure.
CREATE TABLE ocds_contract_buyers (
  contract_id TEXT PRIMARY KEY NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  appearance TEXT,
  source TEXT NOT NULL,
  authority_id TEXT NOT NULL REFERENCES authorities(id)
);
CREATE INDEX idx_ocds_contract_buyers_appearance ON ocds_contract_buyers(appearance);
CREATE INDEX idx_ocds_contract_buyers_authority ON ocds_contract_buyers(authority_id);

-- A contract-only procedure can have metadata without any eligible signing buyer.
-- Keep it open to a later admission without treating a header as unbound.
CREATE TABLE synthetic_tenders_awaiting_buyer (
  tender_id TEXT PRIMARY KEY NOT NULL REFERENCES tenders(id) ON DELETE CASCADE
);
