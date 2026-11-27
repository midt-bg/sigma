ALTER TABLE contracts ADD COLUMN signing_value_original REAL;
ALTER TABLE contracts ADD COLUMN signing_value_mills TEXT;
ALTER TABLE amendments ADD COLUMN published_at_utc TEXT;

-- Retain the contractor evidence needed to reconsider an alternate-number EOP annex.
ALTER TABLE amendments ADD COLUMN anchor_candidate_contractor_eik TEXT;

-- Record the latest source version even when its projection is excluded from history.
CREATE TABLE IF NOT EXISTS ocds_amendment_publications (
  ocid TEXT NOT NULL,
  contract_number TEXT NOT NULL,
  document_number TEXT NOT NULL,
  tender_ext_id TEXT,
  signed_at TEXT,
  published_at TEXT NOT NULL,
  currency TEXT,
  amount REAL,
  amount_mills TEXT,
  source TEXT NOT NULL,
  version_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('correction', 'contractual', 'metadata')),
  PRIMARY KEY (ocid, contract_number, document_number)
);

CREATE VIEW IF NOT EXISTS contract_signing_corrections AS
SELECT ocid, contract_number, document_number, tender_ext_id, signed_at, published_at,
  currency, amount, amount_mills, source
FROM ocds_amendment_publications WHERE kind = 'correction';

CREATE INDEX IF NOT EXISTS idx_tenders_eop_tender_id ON tenders(eop_tender_id);
CREATE INDEX IF NOT EXISTS idx_contracts_corrected_signing ON contracts(tender_id, contract_number)
  WHERE signing_value_original IS NOT NULL AND signing_value IS NOT signing_value_original;

-- Recover the EOP alias at read time. The signing lookup below can still use the OCID.
CREATE VIEW IF NOT EXISTS ocds_amendment_publication_reports AS
SELECT r.*, COALESCE((
  SELECT MIN(t.source_id) FROM tenders t
  WHERE t.eop_tender_id = r.tender_ext_id AND t.source_id NOT LIKE 'ocds-%'
  HAVING COUNT(DISTINCT t.source_id) = 1
), r.ocid) AS unp
FROM ocds_amendment_publications r;

CREATE VIEW IF NOT EXISTS contract_signing_correction_reports AS
SELECT * FROM ocds_amendment_publication_reports WHERE kind = 'correction';

CREATE VIEW IF NOT EXISTS contract_signing_correction_values AS
WITH reports AS MATERIALIZED (SELECT * FROM contract_signing_correction_reports),
owners AS MATERIALIZED (
  SELECT r.*, CASE WHEN EXISTS (
    SELECT 1 FROM contracts c
    WHERE c.tender_id = 't:' || r.unp AND c.contract_number = r.contract_number
      AND c.id GLOB 'c:e:*'
  ) THEN r.unp ELSE r.ocid END AS owner_unp
  FROM reports r
),
signings AS (
  SELECT k.unp, k.contract_number, MIN(c.signing_currency_raw) AS currency,
    MIN(c.signed_at) AS signed_at, MIN(COALESCE(c.signing_value_original, c.signing_value)) AS original,
    MIN(c.signing_value_mills) AS original_mills
  FROM (SELECT DISTINCT owner_unp AS unp, contract_number FROM owners) k
  CROSS JOIN contracts c ON c.tender_id = 't:' || k.unp AND c.contract_number = k.contract_number
  WHERE c.id GLOB 'c:[eo]:*'
  GROUP BY k.unp, k.contract_number
  HAVING MAX(c.ocds_signing_incomplete) = 0
    AND COUNT(COALESCE(c.signing_value_original, c.signing_value)) = COUNT(*)
    AND MIN(COALESCE(c.signing_value_original, c.signing_value)) = MAX(COALESCE(c.signing_value_original, c.signing_value))
    AND COUNT(DISTINCT c.signing_value_mills) <= 1
    AND COUNT(c.signing_currency_raw) = COUNT(*) AND MIN(c.signing_currency_raw) = MAX(c.signing_currency_raw)
    AND COUNT(c.signed_at) = COUNT(*) AND MIN(c.signed_at) = MAX(c.signed_at)
), ranked AS (
  SELECT s.unp, s.contract_number, s.original, r.amount, s.original_mills, r.amount_mills,
    ROW_NUMBER() OVER (PARTITION BY s.unp, s.contract_number
      ORDER BY RTRIM(r.published_at, 'Z') DESC, r.document_number DESC, r.ocid DESC) AS rn
  FROM signings s
  JOIN owners r ON r.owner_unp = s.unp AND r.contract_number = s.contract_number
    AND r.signed_at = s.signed_at AND r.currency = s.currency
  WHERE r.published_at >= r.signed_at AND r.currency <> '' AND r.amount > 0
), decimal_comparison AS (
  SELECT *,
    CAST(amount_mills AS INTEGER) - CAST(original_mills AS INTEGER) AS diff_mills,
    substr(amount_mills, instr(amount_mills, '.') + 1) AS amount_tail,
    substr(original_mills, instr(original_mills, '.') + 1) AS original_tail
  FROM ranked WHERE rn = 1
)
SELECT unp, contract_number,
  CASE
    -- Compare exact whole mills first and use the fractional remainder at the boundary.
    WHEN instr(amount_mills, '.') BETWEEN 2 AND 19 AND instr(original_mills, '.') BETWEEN 2 AND 19
      THEN CASE WHEN diff_mills > 5 OR (diff_mills = 5 AND amount_tail >= original_tail)
          OR diff_mills < -5 OR (diff_mills = -5 AND amount_tail <= original_tail)
        THEN amount ELSE original END
    -- Legacy REAL values have no source decimal. Compare against shifted endpoints.
    WHEN amount <> original AND (amount >= original + 0.005 OR amount <= original - 0.005) THEN amount
    ELSE original
  END AS signing_value
FROM decimal_comparison;
