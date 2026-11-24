-- Promote the source publication alongside the effective values read by the public timeline.
DELETE FROM amendments;

DELETE FROM raw_contract_value_annexes;
INSERT INTO raw_contract_value_annexes SELECT * FROM raw_contract_value_staged_annexes;
DELETE FROM raw_contract_value_inputs;
-- Read the contract projection selected by normalize-raw, including its source precedence.
INSERT INTO raw_contract_value_inputs (id, unp, contract_number, signing_value, signing_currency)
SELECT c.id, k.unp, k.contract_number, c.signing_value, c.currency
FROM (SELECT DISTINCT unp, contract_number FROM raw_contract_value_annexes) k
CROSS JOIN contracts c ON c.tender_id = 't:' || k.unp AND c.contract_number = k.contract_number;

INSERT INTO amendments (
  id, natural_key, contract_number, contract_number_raw, link_method, unp,
  value_before, value_after, value_delta, currency,
  published_at, document_number, description, source,
  value_restated, value_treatment, value_suspect, value_evidence_known, raw_value_after, raw_value_delta,
  value_anchor_kind, value_anchor_contractor_eik, contractor_id_status
)
WITH suppliers AS MATERIALIZED (SELECT * FROM raw_supplier_evidence)
SELECT
  a.natural_key, a.natural_key, a.contract_number, a.contract_number_raw, a.link_method, a.unp,
  a.value_before, a.effective_after, a.effective_after - a.value_before, a.currency,
  a.published_at, a.document_number, a.description, a.source,
  a.restated, a.value_treatment, s.natural_key IS NOT NULL, 1, a.raw_after, a.raw_delta,
  a.value_anchor_kind, CASE WHEN a.value_anchor_kind = 'direct' THEN ids.eik END, ids.evidence_status
FROM raw_amendment_publications a
JOIN suppliers ids ON ids.eik_raw IS a.contractor_eik
LEFT JOIN (SELECT DISTINCT natural_key FROM raw_contract_suspect_annexes) s USING (natural_key);

DELETE FROM raw_contract_value_inputs;
DELETE FROM raw_contract_value_annexes;

SELECT
  (SELECT COUNT(*) FROM amendments) AS amendments,
  (SELECT COUNT(*) FROM contracts WHERE annex_count > 0) AS contracts_amended,
  (SELECT COUNT(*) FROM contracts WHERE current_value IS NOT NULL) AS with_current_value,
  (SELECT COUNT(*) FROM contracts
     WHERE current_value IS NOT NULL AND current_value > signing_value) AS grew_in_value;
