-- Sigma — daily refresh: derive the OCDS go-forward delta into the domain + refresh ONLY the
-- affected rollup/FTS rows. Run by apps/etl's RefreshWorkflow after the OCDS staging is upserted;
-- also runnable via sqlite3/wrangler for tests and manual catch-up.
--
-- SCOPED + IDEMPOTENT. It replaces only c:e:/c:o: contracts represented by the transient window
-- and refreshes the rollup rows for c:e:/c:o: entities. Admin-derived c: rows are left alone.
-- EOP wins over OCDS when both feeds carry the same public contract document number. Re-running the
-- same window yields the same domain rows. Mirrors normalize-raw.sql steps 1/2b/4/5 plus
-- precompute.sql, scoped.

-- @refresh-batch setup
-- The base-wins dedup probes contracts by АОП document number — index it (no-op if already present).
CREATE INDEX IF NOT EXISTS idx_contracts_cnum ON contracts(contract_number);
CREATE INDEX IF NOT EXISTS idx_contracts_tender_id ON contracts(tender_id);

DROP TABLE IF EXISTS refresh_touched_contracts;
DROP TABLE IF EXISTS refresh_touched_bidders;
DROP TABLE IF EXISTS refresh_touched_authorities;
CREATE TABLE refresh_touched_contracts (id TEXT PRIMARY KEY);
CREATE TABLE refresh_touched_bidders (bidder_id TEXT PRIMARY KEY);
CREATE TABLE refresh_touched_authorities (authority_id TEXT PRIMARY KEY);

-- @refresh-batch authorities-bidders
-- ── 1) Authorities referenced by OCDS staging (new ones only; INSERT OR IGNORE) ────────────────────
DROP TABLE IF EXISTS authority_canonical_name;
CREATE TABLE authority_canonical_name (authority_eik TEXT PRIMARY KEY, canonical_name TEXT);
INSERT INTO authority_canonical_name (authority_eik, canonical_name)
SELECT authority_eik, authority_name
FROM (
  SELECT
    authority_eik,
    authority_name,
    ROW_NUMBER() OVER (
      PARTITION BY authority_eik
      ORDER BY
        cnt DESC,
        CASE WHEN authority_name GLOB '*[a-zа-я]*' THEN 0 ELSE 1 END,
        LENGTH(authority_name) DESC,
        authority_name
    ) AS rn
  FROM (
    SELECT authority_eik, authority_name, COUNT(*) AS cnt
    FROM (
      SELECT source, authority_eik, authority_name FROM raw_contracts
      UNION ALL
      SELECT source, authority_eik, authority_name FROM raw_tenders
    )
    WHERE (source LIKE 'eop:%' OR source LIKE 'ocds:%')
      AND authority_eik IS NOT NULL AND authority_eik NOT LIKE '%;%'
      AND authority_name IS NOT NULL AND TRIM(authority_name) <> ''
    GROUP BY authority_eik, authority_name
  )
)
WHERE rn = 1;

DROP TABLE IF EXISTS authority_canonical_type;
CREATE TABLE authority_canonical_type (authority_eik TEXT PRIMARY KEY, canonical_type TEXT);
INSERT INTO authority_canonical_type (authority_eik, canonical_type)
SELECT authority_eik, authority_type
FROM (
  SELECT
    authority_eik,
    authority_type,
    ROW_NUMBER() OVER (
      PARTITION BY authority_eik
      ORDER BY cnt DESC, authority_type
    ) AS rn
  FROM (
    SELECT authority_eik, authority_type, COUNT(*) AS cnt
    FROM (
      SELECT c.authority_eik, c.authority_type
      FROM raw_contracts c
      JOIN authority_canonical_name acn
        ON acn.authority_eik = c.authority_eik AND acn.canonical_name = c.authority_name
      WHERE c.source LIKE 'eop:%' OR c.source LIKE 'ocds:%'
      UNION ALL
      SELECT t.authority_eik, t.authority_type
      FROM raw_tenders t
      JOIN authority_canonical_name acn
        ON acn.authority_eik = t.authority_eik AND acn.canonical_name = t.authority_name
      WHERE t.source LIKE 'eop:%' OR t.source LIKE 'ocds:%'
    )
    WHERE authority_type IS NOT NULL AND TRIM(authority_type) <> ''
    GROUP BY authority_eik, authority_type
  )
)
WHERE rn = 1;

INSERT OR IGNORE INTO authorities (id, name, bulstat, type)
SELECT
  'auth:' || s.authority_eik,
  COALESCE(acn.canonical_name, s.authority_eik),
  s.authority_eik,
  act.canonical_type
FROM (
  -- Composite joint EIKs must not mint standalone authorities (see normalize-raw.sql).
  SELECT authority_eik FROM raw_contracts
  WHERE (source LIKE 'eop:%' OR source LIKE 'ocds:%') AND authority_eik IS NOT NULL AND authority_eik NOT LIKE '%;%'
  UNION
  SELECT authority_eik FROM raw_tenders
  WHERE (source LIKE 'eop:%' OR source LIKE 'ocds:%') AND authority_eik IS NOT NULL AND authority_eik NOT LIKE '%;%'
) s
LEFT JOIN authority_canonical_name acn ON acn.authority_eik = s.authority_eik
LEFT JOIN authority_canonical_type act ON act.authority_eik = s.authority_eik;

-- type_group for any authority still missing it (covers the rows just inserted) — same heuristic as
-- normalize-raw.sql step 1b.
UPDATE authorities SET type_group = CASE
  WHEN name LIKE 'Община%' OR name LIKE 'ОБЩИНА%' OR name LIKE '%Столична община%' OR name LIKE '%СТОЛИЧНА ОБЩИНА%' THEN 'община'
  WHEN name LIKE 'Министерство%' OR name LIKE 'МИНИСТЕРСТВО%' THEN 'министерство'
  WHEN name LIKE '%болница%' OR name LIKE '%БОЛНИЦА%' OR name LIKE 'МБАЛ%' OR name LIKE '%МБАЛ%' OR name LIKE '%СБАЛ%' OR name LIKE '%ДКЦ%' OR name LIKE '%лечебно заведение%' THEN 'болница'
  WHEN name LIKE '%университет%' OR name LIKE '%УНИВЕРСИТЕТ%' OR name LIKE '%училище%' OR name LIKE '%УЧИЛИЩЕ%' OR name LIKE '%гимназия%' OR name LIKE '%ГИМНАЗИЯ%' OR name LIKE '%детска градина%' OR name LIKE '%ДЕТСКА ГРАДИНА%' OR name LIKE '%академия%' THEN 'образование'
  WHEN name LIKE '%агенция%' OR name LIKE '%Агенция%' OR name LIKE '%АГЕНЦИЯ%' THEN 'агенция'
  WHEN EXISTS (
    SELECT 1
    FROM (
      SELECT source, authority_eik, authority_type FROM raw_contracts
      UNION ALL
      SELECT source, authority_eik, authority_type FROM raw_tenders
    ) raw_authority_types
    WHERE (raw_authority_types.source LIKE 'eop:%' OR raw_authority_types.source LIKE 'ocds:%')
      AND raw_authority_types.authority_eik = authorities.bulstat
      AND (
        raw_authority_types.authority_type LIKE 'Публично предприятие%'
        OR raw_authority_types.authority_type LIKE 'Комунални услуги%'
      )
  ) THEN 'държавна компания'
  ELSE 'друго'
END
WHERE type_group IS NULL;

-- ── 2) Winning-contractor identity — derive the checksum and three-rung key once for this slice. ──
DROP TABLE IF EXISTS contractor_identity;
CREATE TABLE contractor_identity (
  eik_raw    TEXT,
  name_raw   TEXT,
  name_norm  TEXT,
  eik_clean  TEXT,
  eik_valid  INTEGER NOT NULL,
  bidder_key TEXT NOT NULL,
  PRIMARY KEY (eik_raw, name_raw)
);

INSERT INTO contractor_identity (eik_raw, name_raw, name_norm, eik_clean, eik_valid, bidder_key)
SELECT
  eik_raw,
  name_raw,
  name_raw,
  eik_clean,
  eik_valid,
  CASE
    WHEN eik_valid = 1 THEN 'eik:' || eik_clean
    ELSE 'pending'
  END
FROM (
  SELECT
    eik_raw,
    name_raw,
    eik_clean,
    -- Bulgarian ЕИК/Булстат control-digit (checksum) validation. A merely SYNTACTIC 9/13-digit
    -- check let the fake/service code „000000001" and wrong-digit typo twins pass, collapsing
    -- unrelated foreign suppliers (Elsevier + Clarivate/Web of Science + a gas consultancy + a
    -- 102 EUR construction line) onto one node (#195). Enforce the real checksum so invalid codes
    -- get eik_valid = 0 and fall back to the name-based key, which splits them apart again.
    --   9-digit: weight positions 1..8 by 1..8; control = sum % 11. If that is 10, re-weight by
    --            3..10; a second 10 → 0. The 9th digit must equal the control.
    --   13-digit: the leading 9 digits must themselves be a valid 9-digit ЕИК, then weight
    --            positions 9..12 by 2,7,3,5 (fallback 4,9,5,7; second 10 → 0). The 13th digit
    --            must equal that control.
    CASE
      WHEN eik_clean IS NULL OR eik_clean IN ('000000000', '0000000000000') OR eik_clean GLOB '*[^0-9]*' OR LENGTH(eik_clean) NOT IN (9, 13) THEN 0
      WHEN (
        CASE
          WHEN (1 * CAST(SUBSTR(eik_clean, 1, 1) AS INTEGER) + 2 * CAST(SUBSTR(eik_clean, 2, 1) AS INTEGER) + 3 * CAST(SUBSTR(eik_clean, 3, 1) AS INTEGER) + 4 * CAST(SUBSTR(eik_clean, 4, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 5, 1) AS INTEGER) + 6 * CAST(SUBSTR(eik_clean, 6, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 7, 1) AS INTEGER) + 8 * CAST(SUBSTR(eik_clean, 8, 1) AS INTEGER)) % 11 < 10 THEN (1 * CAST(SUBSTR(eik_clean, 1, 1) AS INTEGER) + 2 * CAST(SUBSTR(eik_clean, 2, 1) AS INTEGER) + 3 * CAST(SUBSTR(eik_clean, 3, 1) AS INTEGER) + 4 * CAST(SUBSTR(eik_clean, 4, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 5, 1) AS INTEGER) + 6 * CAST(SUBSTR(eik_clean, 6, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 7, 1) AS INTEGER) + 8 * CAST(SUBSTR(eik_clean, 8, 1) AS INTEGER)) % 11
          WHEN (3 * CAST(SUBSTR(eik_clean, 1, 1) AS INTEGER) + 4 * CAST(SUBSTR(eik_clean, 2, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 3, 1) AS INTEGER) + 6 * CAST(SUBSTR(eik_clean, 4, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 5, 1) AS INTEGER) + 8 * CAST(SUBSTR(eik_clean, 6, 1) AS INTEGER) + 9 * CAST(SUBSTR(eik_clean, 7, 1) AS INTEGER) + 10 * CAST(SUBSTR(eik_clean, 8, 1) AS INTEGER)) % 11 < 10 THEN (3 * CAST(SUBSTR(eik_clean, 1, 1) AS INTEGER) + 4 * CAST(SUBSTR(eik_clean, 2, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 3, 1) AS INTEGER) + 6 * CAST(SUBSTR(eik_clean, 4, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 5, 1) AS INTEGER) + 8 * CAST(SUBSTR(eik_clean, 6, 1) AS INTEGER) + 9 * CAST(SUBSTR(eik_clean, 7, 1) AS INTEGER) + 10 * CAST(SUBSTR(eik_clean, 8, 1) AS INTEGER)) % 11
          ELSE 0
        END
      ) <> CAST(SUBSTR(eik_clean, 9, 1) AS INTEGER) THEN 0
      WHEN LENGTH(eik_clean) = 9 THEN 1
      WHEN (
        CASE
          WHEN (2 * CAST(SUBSTR(eik_clean, 9, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 10, 1) AS INTEGER) + 3 * CAST(SUBSTR(eik_clean, 11, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 12, 1) AS INTEGER)) % 11 < 10 THEN (2 * CAST(SUBSTR(eik_clean, 9, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 10, 1) AS INTEGER) + 3 * CAST(SUBSTR(eik_clean, 11, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 12, 1) AS INTEGER)) % 11
          WHEN (4 * CAST(SUBSTR(eik_clean, 9, 1) AS INTEGER) + 9 * CAST(SUBSTR(eik_clean, 10, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 11, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 12, 1) AS INTEGER)) % 11 < 10 THEN (4 * CAST(SUBSTR(eik_clean, 9, 1) AS INTEGER) + 9 * CAST(SUBSTR(eik_clean, 10, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 11, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 12, 1) AS INTEGER)) % 11
          ELSE 0
        END
      ) = CAST(SUBSTR(eik_clean, 13, 1) AS INTEGER) THEN 1
      ELSE 0
    END AS eik_valid
  FROM (
    SELECT
      contractor_eik AS eik_raw,
      contractor_name AS name_raw,
      TRIM(CASE WHEN contractor_eik LIKE 'ЕИК %' THEN SUBSTR(contractor_eik, 5) ELSE contractor_eik END) AS eik_clean
    FROM (SELECT DISTINCT contractor_eik, contractor_name FROM raw_contracts WHERE source LIKE 'eop:%' OR source LIKE 'ocds:%')
  )
);

UPDATE contractor_identity
SET name_norm = TRIM(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(name_norm, char(160), ' '), char(9), ' '), char(10), ' '), char(13), ' '), '  ', ' '), '  ', ' '), '  ', ' '));

UPDATE contractor_identity
SET name_norm = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(name_norm, '"', ''), '''', ''), '`', ''), '„', ''), '“', ''), '”', ''), '‚', ''), '‘', ''), '’', ''), '«', ''), '»', ''), '′', ''), '″', '');

UPDATE contractor_identity
SET name_norm = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(name_norm, '‐', '-'), '‑', '-'), '‒', '-'), '–', '-'), '—', '-'), '―', '-'), '−', '-'), char(173), ''), char(8203), '');

UPDATE contractor_identity
SET name_norm = TRIM(REPLACE(REPLACE(REPLACE(name_norm, '  ', ' '), '  ', ' '), '  ', ' '));

UPDATE contractor_identity
SET name_norm = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(name_norm, 'а', 'А'), 'б', 'Б'), 'в', 'В'), 'г', 'Г'), 'д', 'Д'), 'е', 'Е'), 'ж', 'Ж'), 'з', 'З'), 'и', 'И'), 'й', 'Й'), 'к', 'К'), 'л', 'Л'), 'м', 'М'), 'н', 'Н'), 'о', 'О');

UPDATE contractor_identity
SET name_norm = UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(name_norm, 'п', 'П'), 'р', 'Р'), 'с', 'С'), 'т', 'Т'), 'у', 'У'), 'ф', 'Ф'), 'х', 'Х'), 'ц', 'Ц'), 'ч', 'Ч'), 'ш', 'Ш'), 'щ', 'Щ'), 'ъ', 'Ъ'), 'ь', 'Ь'), 'ю', 'Ю'), 'я', 'Я'));

UPDATE contractor_identity
SET bidder_key = CASE
  WHEN eik_valid = 1 THEN bidder_key
  WHEN name_raw IS NOT NULL AND TRIM(name_raw) <> '' THEN 'name:' || name_norm
  ELSE 'unknown:анонимен'
END;

-- 4a-pre) Canonical display name by frequency mode (#251), rebuilt on top of the checksum-based
--   contractor_identity keys (#252). contractor_identity is DISTINCT-ed over (eik,name), so the
--   occurrence counts the mode needs must be re-derived from raw_contracts.
DROP TABLE IF EXISTS bidder_canonical_name;
CREATE TABLE bidder_canonical_name (bidder_key TEXT PRIMARY KEY, canonical_name TEXT);
INSERT INTO bidder_canonical_name (bidder_key, canonical_name)
SELECT bidder_key, name_raw
FROM (
  SELECT
    ci.bidder_key AS bidder_key,
    ci.name_raw AS name_raw,
    ROW_NUMBER() OVER (
      PARTITION BY ci.bidder_key
      ORDER BY
        r.cnt DESC,
        CASE WHEN ci.name_raw GLOB '*[a-zа-я]*' THEN 0 ELSE 1 END,
        LENGTH(ci.name_raw) DESC,
        ci.name_raw
    ) AS rn
  FROM contractor_identity ci
  JOIN (
    SELECT contractor_eik, contractor_name, COUNT(*) AS cnt
    FROM raw_contracts WHERE source LIKE 'eop:%' OR source LIKE 'ocds:%'
    GROUP BY contractor_eik, contractor_name
  ) r ON r.contractor_eik IS ci.eik_raw AND r.contractor_name IS ci.name_raw
  WHERE ci.name_raw IS NOT NULL AND TRIM(ci.name_raw) <> ''
)
WHERE rn = 1;

INSERT OR IGNORE INTO bidders (id, name, bulstat, eik_normalized, eik_valid, is_consortium, kind)
SELECT
  bidder_key,
  CASE WHEN bidder_key = 'unknown:анонимен' THEN 'Неизвестен изпълнител'
       ELSE COALESCE((SELECT bcn.canonical_name FROM bidder_canonical_name bcn WHERE bcn.bidder_key = contractor_identity.bidder_key), MIN(name_raw)) END,
  MIN(CASE WHEN eik_valid = 1 THEN eik_clean END),
  MIN(CASE WHEN eik_valid = 1 THEN eik_clean END),
  MAX(eik_valid),
  MAX(CASE
    WHEN name_raw LIKE '%;%'
      OR UPPER(name_raw) LIKE '%ДЗЗД%'
      OR UPPER(name_raw) LIKE '%ОБЕДИНЕНИЕ%'
      OR UPPER(name_raw) LIKE '%КОНСОРЦИУМ%'
    THEN 1 ELSE 0
  END),
  CASE
    WHEN bidder_key = 'unknown:анонимен' THEN 'unknown'
    WHEN MAX(CASE
      WHEN name_raw LIKE '%;%'
        OR UPPER(name_raw) LIKE '%ДЗЗД%'
        OR UPPER(name_raw) LIKE '%ОБЕДИНЕНИЕ%'
        OR UPPER(name_raw) LIKE '%КОНСОРЦИУМ%'
      THEN 1 ELSE 0
    END) = 1 THEN 'consortium'
    ELSE 'company'
  END
FROM contractor_identity
GROUP BY bidder_key
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  bulstat = COALESCE(bidders.bulstat, excluded.bulstat),
  eik_normalized = COALESCE(bidders.eik_normalized, excluded.eik_normalized),
  eik_valid = max(bidders.eik_valid, excluded.eik_valid),
  is_consortium = max(bidders.is_consortium, excluded.is_consortium),
  kind = CASE WHEN max(bidders.is_consortium, excluded.is_consortium) = 1 THEN 'consortium' ELSE bidders.kind END;

-- Curated public-owned winner classification. Exact EIK matches cover the allowlist; a small branch
-- list handles valid 13-digit branch EIKs used by AПИ/ОПУ, ЕСО/МЕР, БНР and Информационно обслужване.
CREATE TABLE IF NOT EXISTS state_owned_eik (
  eik TEXT PRIMARY KEY,
  ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('state', 'municipal', 'mixed')),
  canonical_name TEXT NOT NULL
);

UPDATE bidders
SET ownership_kind = (
  SELECT s.ownership_kind
  FROM state_owned_eik s
  WHERE bidders.eik_valid = 1
    AND (
      bidders.eik_normalized = s.eik
      OR (s.eik = '000695089' AND bidders.eik_normalized GLOB '0006950890*')
      OR (s.eik = '175201304' AND bidders.eik_normalized GLOB '1752013040*')
      OR (s.eik = '000672343' AND bidders.eik_normalized GLOB '0006723430*')
      OR (s.eik = '831641791' AND bidders.eik_normalized GLOB '8316417910124*')
    )
  LIMIT 1
);

INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT b.id
FROM bidders b
JOIN company_totals ct ON ct.bidder_id = b.id
WHERE ct.ownership_kind IS NOT b.ownership_kind;

-- @refresh-batch touch-tenders
INSERT OR IGNORE INTO refresh_touched_contracts (id)
SELECT c.id
FROM raw_tenders t
JOIN contracts c ON c.tender_id = 't:' || t.unp;
INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT DISTINCT c.bidder_id
FROM contracts c
WHERE c.id IN (SELECT id FROM refresh_touched_contracts)
  AND c.bidder_id IS NOT NULL;
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT DISTINCT t.authority_id
FROM contracts c JOIN tenders t ON t.id = c.tender_id
WHERE c.id IN (SELECT id FROM refresh_touched_contracts)
  AND t.authority_id IS NOT NULL;

-- @refresh-batch tenders
-- EOP tender headers and lots loaded since the last full normalize.
INSERT INTO tenders
  (id, source_id, title, authority_id, ordering_unit_name, cpv_code, cpv_description, estimated_value, currency,
   procedure_type, contract_kind, num_lots, status, published_at, deadline_at,
   legal_basis, award_criteria, main_activity, notice_type,
   place_of_performance, start_date, end_date, duration, duration_unit,
   eu_programme, green, social, innovation, eauction, cancelled, eop_tender_id)
SELECT
  't:' || t.unp,
  t.unp,
  COALESCE(t.procurement_subject, '(без предмет)'),
  'auth:' || t.authority_eik,
  NULLIF(TRIM(t.authority_name), ''),
  t.cpv_code,
  t.cpv_description,
  t.estimated_value,
  COALESCE(t.currency, 'BGN'),
  COALESCE(t.procedure_type, 'неизвестна'),
  t.contract_kind,
  t.num_lots,
  CASE WHEN EXISTS (SELECT 1 FROM raw_contracts c WHERE c.unp = t.unp) THEN 'awarded' ELSE 'published' END,
  t.published_at,
  t.deadline,
  t.legal_basis,
  t.award_criteria,
  t.main_activity,
  t.notice_type,
  t.place_of_performance,
  t.start_date,
  t.end_date,
  t.duration,
  t.duration_unit,
  t.eu_programme,
  t.green,
  t.social,
  t.innovation,
  t.eauction,
  t.cancelled,
  NULLIF(t.tender_id, '')                 -- raw EOP numeric tenderId from the header row
FROM raw_tenders t
WHERE t.lot_id IS NULL
  AND EXISTS (SELECT 1 FROM authorities a WHERE a.id = 'auth:' || t.authority_eik)
ON CONFLICT(id) DO UPDATE SET
  source_id = CASE WHEN tenders.procedure_type = 'неизвестна' THEN excluded.source_id ELSE tenders.source_id END,
  title = CASE WHEN tenders.procedure_type = 'неизвестна' THEN excluded.title ELSE tenders.title END,
  authority_id = CASE WHEN tenders.procedure_type = 'неизвестна' THEN excluded.authority_id ELSE tenders.authority_id END,
  ordering_unit_name = excluded.ordering_unit_name,
  cpv_code = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.cpv_code, tenders.cpv_code) ELSE tenders.cpv_code END,
  cpv_description = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.cpv_description, tenders.cpv_description) ELSE tenders.cpv_description END,
  estimated_value = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.estimated_value, tenders.estimated_value) ELSE tenders.estimated_value END,
  currency = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.currency, tenders.currency) ELSE tenders.currency END,
  procedure_type = CASE WHEN tenders.procedure_type = 'неизвестна' THEN excluded.procedure_type ELSE tenders.procedure_type END,
  contract_kind = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.contract_kind, tenders.contract_kind) ELSE tenders.contract_kind END,
  num_lots = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.num_lots, tenders.num_lots) ELSE tenders.num_lots END,
  status = CASE WHEN excluded.status = 'awarded' THEN 'awarded' ELSE tenders.status END,
  published_at = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.published_at, tenders.published_at) ELSE tenders.published_at END,
  deadline_at = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.deadline_at, tenders.deadline_at) ELSE tenders.deadline_at END,
  legal_basis = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.legal_basis, tenders.legal_basis) ELSE tenders.legal_basis END,
  award_criteria = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.award_criteria, tenders.award_criteria) ELSE tenders.award_criteria END,
  main_activity = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.main_activity, tenders.main_activity) ELSE tenders.main_activity END,
  notice_type = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.notice_type, tenders.notice_type) ELSE tenders.notice_type END,
  place_of_performance = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.place_of_performance, tenders.place_of_performance) ELSE tenders.place_of_performance END,
  start_date = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.start_date, tenders.start_date) ELSE tenders.start_date END,
  end_date = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.end_date, tenders.end_date) ELSE tenders.end_date END,
  duration = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.duration, tenders.duration) ELSE tenders.duration END,
  duration_unit = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.duration_unit, tenders.duration_unit) ELSE tenders.duration_unit END,
  eu_programme = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.eu_programme, tenders.eu_programme) ELSE tenders.eu_programme END,
  green = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.green, tenders.green) ELSE tenders.green END,
  social = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.social, tenders.social) ELSE tenders.social END,
  innovation = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.innovation, tenders.innovation) ELSE tenders.innovation END,
  eauction = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.eauction, tenders.eauction) ELSE tenders.eauction END,
  cancelled = CASE WHEN tenders.procedure_type = 'неизвестна' THEN COALESCE(excluded.cancelled, tenders.cancelled) ELSE tenders.cancelled END,
  -- Promoting a synthetic tender to real: the header's EOP id wins (it is the authoritative source),
  -- falling back to the contract-derived id only if the header lacks one. For a row that is already
  -- real, keep its id but backfill from the header if it was somehow missing.
  eop_tender_id = CASE WHEN tenders.procedure_type = 'неизвестна'
    THEN COALESCE(excluded.eop_tender_id, tenders.eop_tender_id)
    ELSE COALESCE(tenders.eop_tender_id, excluded.eop_tender_id) END;

-- @refresh-batch lots
INSERT OR IGNORE INTO lots (id, tender_id, title, cpv_code, estimated_value)
SELECT
  'lot:' || t.unp || ':' || CASE
    WHEN t.lot_id LIKE 'LOT-%' AND REPLACE(t.lot_id, 'LOT-', '') <> '' AND REPLACE(t.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(t.lot_id, 'LOT-', '') AS INTEGER)
    WHEN t.lot_id <> '' AND t.lot_id NOT GLOB '*[^0-9]*' THEN CAST(t.lot_id AS INTEGER)
    ELSE t.lot_id
  END,
  't:' || t.unp,
  COALESCE(t.lot_name, '(без предмет)'),
  t.cpv_code,
  t.estimated_value
FROM raw_tenders t
WHERE t.lot_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || t.unp);

-- @refresh-batch parties
-- Promote transient/work OCDS party staging into the served parties projection.
WITH keyed AS (
  SELECT
    CASE
      -- ЕИК is the stable national identity, so key by it FIRST. The OCDS (ocid, party_id) pair is
      -- positional within a release ("ORG-0003" = the 3rd party in THIS package), and the same slot is
      -- reused for a different company on every republish — keying on it collapses genuinely-distinct
      -- companies onto one node, and source-DESC dedup then drops all but the latest occupant. Putting
      -- ЕИК first prevents that collision; the (ocid, party_id) suffix keeps one row per appearance so
      -- the per-field enrichment below can still pick the richest non-blank value across appearances.
      WHEN NULLIF(eik, '') IS NOT NULL THEN 'eik:' || eik || ':ocid:' || COALESCE(ocid, '') || ':party:' || COALESCE(party_id, '')
      WHEN NULLIF(ocid, '') IS NOT NULL AND NULLIF(party_id, '') IS NOT NULL THEN 'ocid:' || ocid || ':party:' || party_id
      ELSE 'content:' ||
        COALESCE(ocid, '') || ':' || COALESCE(party_id, '') || ':' || COALESCE(eik, '') || ':' ||
        COALESCE(name, '') || ':' || COALESCE(street_address, '') || ':' || COALESCE(locality, '') || ':' ||
        COALESCE(region_nuts, '') || ':' || COALESCE(contact_email, '') || ':' || COALESCE(contact_phone, '')
    END AS party_key,
    eik,
    source,
    ocid,
    party_id,
    name,
    street_address,
    locality,
    region_nuts,
    contact_email,
    contact_phone
  FROM raw_ocds_parties
), ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY party_key
      ORDER BY source DESC, COALESCE(ocid, '') DESC, COALESCE(party_id, '') DESC,
        COALESCE(name, '') DESC, COALESCE(street_address, '') DESC, COALESCE(locality, '') DESC,
        COALESCE(contact_email, '') DESC, COALESCE(contact_phone, '') DESC
    ) AS rn
  FROM keyed
)
INSERT OR REPLACE INTO parties (
  party_key, eik, source, ocid, party_id, name, street_address, locality, region_nuts,
  contact_email, contact_phone
)
SELECT
  party_key, eik, source, ocid, party_id, name, street_address, locality, region_nuts,
  contact_email, contact_phone
FROM ranked
WHERE rn = 1;

-- @refresh-batch enrich-authorities
-- Party/contact enrichment for entities touched by the refreshed staging.
UPDATE authorities SET
  nuts       = COALESCE((SELECT p.region_nuts    FROM parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.region_nuts, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), nuts),
  settlement = COALESCE((SELECT p.locality       FROM parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.locality, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), settlement),
  address    = COALESCE((SELECT p.street_address FROM parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.street_address, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), address),
  contact_email = COALESCE((SELECT p.contact_email FROM parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.contact_email, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_email),
  contact_phone = COALESCE((SELECT p.contact_phone FROM parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.contact_phone, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_phone)
WHERE EXISTS (SELECT 1 FROM parties p WHERE p.eik = authorities.bulstat);

-- @refresh-batch enrich-bidders
UPDATE bidders SET
  nuts       = COALESCE((SELECT p.region_nuts    FROM parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.region_nuts, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), nuts),
  settlement = COALESCE((SELECT p.locality       FROM parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.locality, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), settlement),
  address    = COALESCE((SELECT p.street_address FROM parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.street_address, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), address),
  contact_email = COALESCE((SELECT p.contact_email FROM parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.contact_email, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_email),
  contact_phone = COALESCE((SELECT p.contact_phone FROM parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.contact_phone, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_phone)
WHERE EXISTS (SELECT 1 FROM parties p WHERE p.eik = bidders.eik_normalized);

-- @refresh-batch touch-entities
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT a.id
FROM authorities a
WHERE a.bulstat IN (
    SELECT authority_eik FROM raw_contracts WHERE authority_eik IS NOT NULL
    UNION
    SELECT authority_eik FROM raw_tenders WHERE authority_eik IS NOT NULL
    UNION
    SELECT eik FROM raw_ocds_parties WHERE eik IS NOT NULL
  );

-- @refresh-batch authority-region
UPDATE authorities
SET region = (SELECT n.nuts3_name FROM nuts_regions n WHERE n.nuts3 = authorities.nuts)
WHERE id IN (SELECT authority_id FROM refresh_touched_authorities);

-- @refresh-batch lot-values
CREATE INDEX IF NOT EXISTS idx_raw_tenders_tender_id ON raw_tenders(tender_id);
WITH mapped AS (
  SELECT
    'lot:' || rt.unp || ':' || CASE
      WHEN rl.lot_id LIKE 'LOT-%' AND REPLACE(rl.lot_id, 'LOT-', '') <> '' AND REPLACE(rl.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(rl.lot_id, 'LOT-', '') AS INTEGER)
      WHEN rl.lot_id <> '' AND rl.lot_id NOT GLOB '*[^0-9]*' THEN CAST(rl.lot_id AS INTEGER)
      ELSE rl.lot_id
    END AS domain_lot_id,
    rl.value_amount,
    rl.value_currency,
    ROW_NUMBER() OVER (
      PARTITION BY 'lot:' || rt.unp || ':' || CASE
        WHEN rl.lot_id LIKE 'LOT-%' AND REPLACE(rl.lot_id, 'LOT-', '') <> '' AND REPLACE(rl.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(rl.lot_id, 'LOT-', '') AS INTEGER)
        WHEN rl.lot_id <> '' AND rl.lot_id NOT GLOB '*[^0-9]*' THEN CAST(rl.lot_id AS INTEGER)
        ELSE rl.lot_id
      END
      ORDER BY rl.id DESC
    ) AS rn
  FROM raw_ocds_lots rl
  JOIN raw_tenders rt ON rt.tender_id = rl.tender_id
  WHERE rl.tender_id IS NOT NULL
    AND rl.lot_id IS NOT NULL
    AND rt.unp IS NOT NULL
)
UPDATE lots
SET
  value_amount = COALESCE(lots.value_amount, mapped.value_amount),
  value_currency = COALESCE(lots.value_currency, mapped.value_currency)
FROM mapped
WHERE mapped.rn = 1
  AND mapped.domain_lot_id = lots.id;

-- @refresh-batch synthetic-tenders
-- ── 3) Synthetic 'неизвестна' tenders for OCDS УНП (ocid) — matches normalize step 2b ───────────────
WITH folded AS (
  SELECT
    c.unp,
    MIN(c.procurement_subject) AS raw_title,
    'auth:' || MIN(c.authority_eik) AS authority_id,
    MIN(c.cpv_code) AS cpv_code,
    MIN(c.estimated_value) AS estimated_value,
    MIN(c.currency) AS raw_currency,
    MIN(c.contract_kind) AS contract_kind,
    MIN(c.legal_basis) AS legal_basis,
    MIN(c.award_criteria) AS award_criteria,
    MIN(NULLIF(c.tender_ext_id, '')) AS eop_tender_id  -- synthetic tenders inherit the EOP id from contracts
  FROM raw_contracts c
  WHERE (c.source LIKE 'eop:%' OR c.source LIKE 'ocds:%')
    AND c.unp IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM raw_tenders t WHERE t.unp = c.unp)
    AND EXISTS (SELECT 1 FROM authorities a WHERE a.id = 'auth:' || c.authority_eik)
  GROUP BY c.unp
)
INSERT INTO tenders
  (id, source_id, title, authority_id, cpv_code, estimated_value, currency,
   procedure_type, contract_kind, status, legal_basis, award_criteria, eop_tender_id)
SELECT
  't:' || unp,
  unp,
  COALESCE(raw_title, '(без предмет)'),
  authority_id,
  cpv_code,
  estimated_value,
  COALESCE(raw_currency, 'BGN'),
  'неизвестна',
  contract_kind,
  'awarded',
  legal_basis,
  award_criteria,
  eop_tender_id
FROM folded
WHERE true
ON CONFLICT(id) DO UPDATE SET
  title = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.title = '(без предмет)' THEN tenders.title
      WHEN tenders.title = '(без предмет)' THEN excluded.title
      ELSE min(tenders.title, excluded.title)
    END
    ELSE tenders.title END,
  cpv_code = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.cpv_code IS NULL THEN tenders.cpv_code
      WHEN tenders.cpv_code IS NULL THEN excluded.cpv_code
      ELSE min(tenders.cpv_code, excluded.cpv_code)
    END
    ELSE tenders.cpv_code END,
  estimated_value = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.estimated_value IS NULL THEN tenders.estimated_value
      WHEN tenders.estimated_value IS NULL THEN excluded.estimated_value
      ELSE min(tenders.estimated_value, excluded.estimated_value)
    END
    ELSE tenders.estimated_value END,
  currency = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.currency = 'BGN' AND tenders.currency <> 'BGN' THEN tenders.currency
      WHEN tenders.currency = 'BGN' AND excluded.currency <> 'BGN' THEN excluded.currency
      ELSE min(tenders.currency, excluded.currency)
    END
    ELSE tenders.currency END,
  contract_kind = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.contract_kind IS NULL THEN tenders.contract_kind
      WHEN tenders.contract_kind IS NULL THEN excluded.contract_kind
      ELSE min(tenders.contract_kind, excluded.contract_kind)
    END
    ELSE tenders.contract_kind END,
  legal_basis = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.legal_basis IS NULL THEN tenders.legal_basis
      WHEN tenders.legal_basis IS NULL THEN excluded.legal_basis
      ELSE min(tenders.legal_basis, excluded.legal_basis)
    END
    ELSE tenders.legal_basis END,
  award_criteria = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.award_criteria IS NULL THEN tenders.award_criteria
      WHEN tenders.award_criteria IS NULL THEN excluded.award_criteria
      ELSE min(tenders.award_criteria, excluded.award_criteria)
    END
    ELSE tenders.award_criteria END,
  eop_tender_id = CASE WHEN tenders.procedure_type = 'неизвестна' THEN
    CASE
      WHEN excluded.eop_tender_id IS NULL THEN tenders.eop_tender_id
      WHEN tenders.eop_tender_id IS NULL THEN excluded.eop_tender_id
      ELSE min(tenders.eop_tender_id, excluded.eop_tender_id)
    END
    ELSE tenders.eop_tender_id END;

-- 4) Contracts - replace rows represented by the transient window, then re-derive deltas.
-- @refresh-batch contracts
INSERT OR IGNORE INTO refresh_touched_contracts (id)
SELECT DISTINCT c.id
FROM raw_contracts r
JOIN contracts c ON c.contract_number = r.contract_number AND c.tender_id = 't:' || r.unp
WHERE r.contract_number IS NOT NULL
  AND c.id GLOB 'c:[eo]:*'
  AND (
    (c.id LIKE 'c:e:%' AND r.source LIKE 'eop:%')
    OR (c.id LIKE 'c:o:%' AND r.source LIKE 'ocds:%')
  )
UNION
SELECT DISTINCT c.id
FROM raw_contracts r
JOIN contracts c ON c.contract_number IS NULL AND c.tender_id = 't:' || r.unp
WHERE r.contract_number IS NULL
  AND c.id GLOB 'c:[eo]:*'
  AND (
    (c.id LIKE 'c:e:%' AND r.source LIKE 'eop:%')
    OR (c.id LIKE 'c:o:%' AND r.source LIKE 'ocds:%')
  );
INSERT OR IGNORE INTO refresh_touched_contracts (id)
SELECT DISTINCT c.id
FROM raw_contracts e
JOIN contracts c ON c.contract_number = e.contract_number
WHERE e.source LIKE 'eop:%'
  AND e.contract_number IS NOT NULL
  AND c.id GLOB 'c:o:*'
UNION
SELECT DISTINCT c.id
FROM raw_contracts e
JOIN contracts c ON c.contract_number IS NULL
WHERE e.source LIKE 'eop:%'
  AND e.contract_number IS NULL
  AND c.id GLOB 'c:o:*';
INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT DISTINCT c.bidder_id
FROM contracts c
WHERE c.id IN (SELECT id FROM refresh_touched_contracts)
  AND c.bidder_id IS NOT NULL;
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT DISTINCT t.authority_id
FROM contracts c JOIN tenders t ON t.id = c.tender_id
WHERE c.id IN (SELECT id FROM refresh_touched_contracts)
  AND t.authority_id IS NOT NULL;

DELETE FROM contracts
WHERE id IN (
  SELECT DISTINCT c.id
  FROM raw_contracts r
  JOIN contracts c ON c.contract_number = r.contract_number AND c.tender_id = 't:' || r.unp
  WHERE r.contract_number IS NOT NULL
    AND c.id GLOB 'c:[eo]:*'
    AND (
      (c.id LIKE 'c:e:%' AND r.source LIKE 'eop:%')
      OR (c.id LIKE 'c:o:%' AND r.source LIKE 'ocds:%')
    )
  UNION
  SELECT DISTINCT c.id
  FROM raw_contracts r
  JOIN contracts c ON c.contract_number IS NULL AND c.tender_id = 't:' || r.unp
  WHERE r.contract_number IS NULL
    AND c.id GLOB 'c:[eo]:*'
    AND (
      (c.id LIKE 'c:e:%' AND r.source LIKE 'eop:%')
      OR (c.id LIKE 'c:o:%' AND r.source LIKE 'ocds:%')
    )
);
INSERT OR IGNORE INTO contracts
  (id, tender_id, bidder_id, ordering_unit_name, amount, currency, signed_at, contract_number, signing_value, current_value,
   annex_count, eu_funded, bids_received, contract_kind, awarded_to_group, value_flag, date_flag, amount_eur,
   fx_converted, fx_rate, signing_value_eur, current_value_eur,
   lot_id, document_number, published_at, contract_subject,
   eu_programme, duration_days, winner_size, contractor_country,
   bids_sme, bids_rejected, bids_non_eea,
   subcontractor_eik, subcontractor_name, subcontract_value,
   eauction, framework, accelerated, strategic)
SELECT
  'c:o:' || COALESCE(x.unp, '') || ':' || COALESCE(x.contract_number, '') || ':' ||
    COALESCE(NULLIF(x.lot_id, ''), '_') || ':' || x.bidder_key || ':' || x.contract_ordinal,
  't:' || x.unp,
  x.bidder_key,
  NULLIF(TRIM(x.authority_name_raw), ''),
  x.display_native,
  COALESCE(x.currency, 'BGN'),
  x.contract_date,
  x.contract_number,
  x.signing_value,
  x.current_value,
  0,
  x.eu_funded,
  x.bids_received,
  x.contract_kind,
  x.awarded_to_group,
  x.value_flag,
  x.date_flag,
  x.amount_eur,
  CASE WHEN COALESCE(x.currency, 'BGN') NOT IN ('BGN', 'EUR') THEN 1 ELSE 0 END,
  x.fx_rate,
  x.signing_value_eur,
  x.current_value_eur,
  CASE WHEN x.lot_id IS NOT NULL AND TRIM(x.lot_id) <> '' THEN 'lot:' || x.unp || ':' || x.lot_id ELSE NULL END,
  x.document_number,
  x.published_at,
  x.contract_subject,
  x.eu_programme,
  x.duration_days,
  x.winner_size,
  x.contractor_country,
  x.bids_sme,
  x.bids_rejected,
  x.bids_non_eea,
  x.subcontractor_eik,
  x.subcontractor_name,
  x.subcontract_value,
  x.eauction,
  x.framework_contract,
  x.accelerated,
  x.strategic
FROM (
  SELECT q.*,
    -- value_suspect is repaired directly from proc_est_eur. value_low (and 'review') is populated here,
    -- so it counts in every sum; it is merely labelled in the UI. annex_suspect uses trusted_native's signing fallback.
    CASE
      WHEN q.value_flag = 'value_suspect' THEN q.proc_est_eur
      WHEN COALESCE(q.currency,'BGN') = 'EUR' THEN q.trusted_native
      WHEN COALESCE(q.currency,'BGN') = 'BGN' THEN q.trusted_native / 1.95583
      ELSE q.trusted_native * q.fx_rate
    END AS amount_eur,
    CASE
      WHEN q.value_flag = 'value_suspect' OR q.signing_value IS NULL THEN NULL
      WHEN COALESCE(q.currency,'BGN') = 'EUR' THEN q.signing_value
      WHEN COALESCE(q.currency,'BGN') = 'BGN' THEN q.signing_value / 1.95583
      ELSE q.signing_value * q.fx_rate
    END AS signing_value_eur,
    CASE
      WHEN q.value_flag IN ('value_suspect', 'annex_suspect') OR q.current_value IS NULL THEN NULL
      WHEN COALESCE(q.currency,'BGN') = 'EUR' THEN q.current_value
      WHEN COALESCE(q.currency,'BGN') = 'BGN' THEN q.current_value / 1.95583
      ELSE q.current_value * q.fx_rate
    END AS current_value_eur
  FROM (
    SELECT y.*,
      CASE y.value_flag
        WHEN 'value_suspect' THEN y.proc_est_native
        WHEN 'annex_suspect' THEN COALESCE(y.signing_value, y.current_value)
        ELSE COALESCE(y.current_value, y.signing_value)
      END AS display_native,
      CASE y.value_flag
        WHEN 'value_suspect' THEN NULL
        WHEN 'annex_suspect' THEN COALESCE(y.signing_value, y.current_value)
        ELSE COALESCE(y.current_value, y.signing_value)
      END AS trusted_native,
      -- fx: EUR as-is, BGN at the peg, foreign at the signing-date ECB rate (NULL if missing)
      CASE WHEN COALESCE(y.currency,'BGN') NOT IN ('BGN','EUR')
        THEN (
          SELECT f.eur_per_unit
          FROM fx_rates f
          WHERE f.base_currency = y.currency
            AND f.rate_date <= y.contract_date
            AND f.rate_date >= date(y.contract_date, '-10 days')
          ORDER BY f.rate_date DESC
          LIMIT 1
        )
        ELSE NULL END AS fx_rate
    FROM (
      SELECT z.*,
        ROW_NUMBER() OVER (
          PARTITION BY z.unp, COALESCE(z.contract_number, ''), z.bidder_key, COALESCE(NULLIF(z.lot_id, ''), '_')
          ORDER BY z.signing_value, z.contract_date, z.document_number, z.id
        ) AS contract_ordinal
      FROM (
        SELECT c.*,
          CASE
            -- Over-valuation + absurd FIRST and repaired to the procedure estimate.
            -- value_low is labelled-but-counted (see the amount_eur CASE). Keep in sync with
            -- normalize-raw.sql and the EOP block below.
            WHEN c.eff_eur > 2000000000 OR (c.proc_est_eur >= 1000 AND c.eff_eur > 200 * c.proc_est_eur) THEN 'value_suspect'
            -- value_low: zero/negative, OR a tiny signed value (< 1000 EUR) that is also < 5% of the
            -- estimate. The < 1000 EUR floor keeps large legitimate framework call-offs OUT.
            WHEN COALESCE(c.current_value, c.signing_value) <= 0 THEN 'value_low'
            WHEN c.estimated_value > 0 AND c.signing_value IS NOT NULL AND (
              CASE
                WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN c.signing_value
                WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN c.signing_value / 1.95583
                ELSE c.signing_value * (
                  SELECT f.eur_per_unit
                  FROM fx_rates f
                  WHERE f.base_currency = c.currency
                    AND f.rate_date <= c.contract_date
                    AND f.rate_date >= date(c.contract_date, '-10 days')
                  ORDER BY f.rate_date DESC
                  LIMIT 1
                )
              END
            ) < 1000 AND (
              CASE
                WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN c.signing_value
                WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN c.signing_value / 1.95583
                ELSE c.signing_value * (
                  SELECT f.eur_per_unit
                  FROM fx_rates f
                  WHERE f.base_currency = c.currency
                    AND f.rate_date <= c.contract_date
                    AND f.rate_date >= date(c.contract_date, '-10 days')
                  ORDER BY f.rate_date DESC
                  LIMIT 1
                )
              END
            ) / NULLIF((
              CASE
                WHEN COALESCE(NULLIF(c.procurement_currency, ''), NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN c.estimated_value
                WHEN COALESCE(NULLIF(c.procurement_currency, ''), NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN c.estimated_value / 1.95583
                ELSE c.estimated_value * (
                  SELECT f.eur_per_unit
                  FROM fx_rates f
                  WHERE f.base_currency = COALESCE(NULLIF(c.procurement_currency, ''), NULLIF(c.currency, ''))
                    AND f.rate_date <= c.contract_date
                    AND f.rate_date >= date(c.contract_date, '-10 days')
                  ORDER BY f.rate_date DESC
                  LIMIT 1
                )
            END
          ), 0) < 0.05 THEN 'value_low'
            WHEN c.current_value IS NOT NULL AND (c.current_value < 0 OR (c.signing_value > 0 AND c.current_value / c.signing_value >= 100)) THEN 'annex_suspect'
            WHEN c.proc_est_eur > 0 AND c.eff_eur >= 10 * c.proc_est_eur THEN 'review'
            ELSE 'ok'
          END AS value_flag,
          CASE
            WHEN c.contract_date IS NOT NULL
             AND c.published_at IS NOT NULL
             AND c.contract_date > date(c.published_at, '+2 day') THEN 'signed_after_publication'
            ELSE 'ok'
          END AS date_flag,
          c.bidder_key
        FROM (
          SELECT c.*, ci.bidder_key,
          c.authority_name AS authority_name_raw,
            CASE
              WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN COALESCE(c.current_value, c.signing_value)
              WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN COALESCE(c.current_value, c.signing_value) / 1.95583
              ELSE COALESCE(c.current_value, c.signing_value) * (
                SELECT f.eur_per_unit
                FROM fx_rates f
                WHERE f.base_currency = NULLIF(c.currency, '')
                  AND f.rate_date <= c.contract_date
                  AND f.rate_date >= date(c.contract_date, '-10 days')
                ORDER BY f.rate_date DESC
                LIMIT 1
              )
            END AS eff_eur,
            CASE
              WHEN t.estimated_value IS NULL THEN NULL
              WHEN COALESCE(NULLIF(t.currency, ''), 'BGN') = 'EUR' THEN t.estimated_value
              WHEN COALESCE(NULLIF(t.currency, ''), 'BGN') = 'BGN' THEN t.estimated_value / 1.95583
              ELSE t.estimated_value * (
                SELECT f.eur_per_unit
                FROM fx_rates f
                WHERE f.base_currency = NULLIF(t.currency, '')
                  AND f.rate_date <= c.contract_date
                  AND f.rate_date >= date(c.contract_date, '-10 days')
                ORDER BY f.rate_date DESC
                LIMIT 1
              )
            END AS proc_est_eur,
            t.estimated_value AS proc_est_native
          FROM raw_contracts c
          JOIN contractor_identity ci
            ON c.contractor_eik IS ci.eik_raw AND c.contractor_name IS ci.name_raw
          LEFT JOIN tenders t ON t.id = 't:' || c.unp
        ) c
        WHERE c.source LIKE 'ocds:%'
      ) z
    ) y
  ) q
) x
WHERE x.display_native IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || x.unp)
  AND EXISTS (SELECT 1 FROM bidders b WHERE b.id = x.bidder_key)
  -- EOP wins: skip OCDS rows when the transient window has an EOP row for the same document.
  AND NOT EXISTS (
    SELECT 1 FROM raw_contracts e
    WHERE e.source LIKE 'eop:%'
      AND COALESCE(e.contract_number, '') = COALESCE(x.contract_number, '')
  )
  -- Existing admin rows also win.
  AND NOT EXISTS (SELECT 1 FROM contracts c2 WHERE COALESCE(c2.contract_number, '') = COALESCE(x.contract_number, '') AND c2.id NOT GLOB 'c:[eo]:*')
  -- Existing EOP rows win over later OCDS-only windows too.
  AND NOT EXISTS (SELECT 1 FROM contracts c3 WHERE c3.id GLOB 'c:e:*' AND COALESCE(c3.contract_number, '') = COALESCE(x.contract_number, ''));

-- EOP base rows loaded after the last full normalize. This mirrors normalize-raw.sql's EOP branch:
-- newest cumulative bucket wins, existing full-normalize rows win over refresh rows.
DELETE FROM contracts
WHERE id IN (
  SELECT DISTINCT c.id
  FROM raw_contracts e
  JOIN contracts c ON c.contract_number = e.contract_number
  WHERE e.source LIKE 'eop:%'
    AND e.contract_number IS NOT NULL
    AND c.id GLOB 'c:o:*'
  UNION
  SELECT DISTINCT c.id
  FROM raw_contracts e
  JOIN contracts c ON c.contract_number IS NULL
  WHERE e.source LIKE 'eop:%'
    AND e.contract_number IS NULL
    AND c.id GLOB 'c:o:*'
);

INSERT OR IGNORE INTO contracts
  (id, tender_id, bidder_id, ordering_unit_name, amount, currency, signed_at, contract_number, signing_value, current_value,
   annex_count, eu_funded, bids_received, contract_kind, awarded_to_group, value_flag, date_flag, amount_eur,
   fx_converted, fx_rate, signing_value_eur, current_value_eur,
   lot_id, document_number, published_at, contract_subject,
   eu_programme, duration_days, winner_size, contractor_country,
   bids_sme, bids_rejected, bids_non_eea,
   subcontractor_eik, subcontractor_name, subcontract_value,
   eauction, framework, accelerated, strategic)
SELECT
  'c:e:' || COALESCE(x.unp, '') || ':' || COALESCE(x.contract_number, '') || ':' ||
    COALESCE(NULLIF(x.lot_norm, ''), '_') || ':' || x.bidder_key || ':' || x.contract_ordinal,
  't:' || x.unp,
  x.bidder_key,
  NULLIF(TRIM(x.authority_name_raw), ''),
  x.display_native,
  COALESCE(x.currency, 'BGN'),
  x.contract_date,
  x.contract_number,
  x.signing_value,
  x.current_value,
  COALESCE(x.annex_count, 0),
  x.eu_funded,
  x.bids_received,
  x.contract_kind,
  x.awarded_to_group,
  x.value_flag,
  x.date_flag,
  x.amount_eur,
  CASE WHEN COALESCE(x.currency, 'BGN') NOT IN ('BGN', 'EUR') THEN 1 ELSE 0 END,
  x.fx_rate,
  x.signing_value_eur,
  x.current_value_eur,
  CASE WHEN x.lot_norm IS NOT NULL AND TRIM(x.lot_norm) <> '' THEN 'lot:' || x.unp || ':' || x.lot_norm ELSE NULL END,
  x.document_number,
  x.published_at,
  x.contract_subject,
  x.eu_programme,
  x.duration_days,
  x.winner_size,
  x.contractor_country,
  x.bids_sme,
  x.bids_rejected,
  x.bids_non_eea,
  x.subcontractor_eik,
  x.subcontractor_name,
  x.subcontract_value,
  x.eauction,
  x.framework_contract,
  x.accelerated,
  x.strategic
FROM (
  SELECT q.*,
    -- value_suspect is repaired directly from proc_est_eur. value_low (and 'review') is populated here,
    -- so it counts in every sum; it is merely labelled in the UI. annex_suspect uses trusted_native's signing fallback.
    CASE
      WHEN q.value_flag = 'value_suspect' THEN q.proc_est_eur
      WHEN COALESCE(q.currency,'BGN') = 'EUR' THEN q.trusted_native
      WHEN COALESCE(q.currency,'BGN') = 'BGN' THEN q.trusted_native / 1.95583
      ELSE q.trusted_native * q.fx_rate
    END AS amount_eur,
    CASE
      WHEN q.value_flag = 'value_suspect' OR q.signing_value IS NULL THEN NULL
      WHEN COALESCE(q.currency,'BGN') = 'EUR' THEN q.signing_value
      WHEN COALESCE(q.currency,'BGN') = 'BGN' THEN q.signing_value / 1.95583
      ELSE q.signing_value * q.fx_rate
    END AS signing_value_eur,
    CASE
      WHEN q.value_flag IN ('value_suspect', 'annex_suspect') OR q.current_value IS NULL THEN NULL
      WHEN COALESCE(q.currency,'BGN') = 'EUR' THEN q.current_value
      WHEN COALESCE(q.currency,'BGN') = 'BGN' THEN q.current_value / 1.95583
      ELSE q.current_value * q.fx_rate
    END AS current_value_eur
  FROM (
    SELECT y.*,
      CASE y.value_flag
        WHEN 'value_suspect' THEN y.proc_est_native
        WHEN 'annex_suspect' THEN COALESCE(y.signing_value, y.current_value)
        ELSE COALESCE(y.current_value, y.signing_value)
      END AS display_native,
      CASE y.value_flag
        WHEN 'value_suspect' THEN NULL
        WHEN 'annex_suspect' THEN COALESCE(y.signing_value, y.current_value)
        ELSE COALESCE(y.current_value, y.signing_value)
      END AS trusted_native,
      CASE WHEN COALESCE(y.currency,'BGN') NOT IN ('BGN','EUR')
        THEN (
          SELECT f.eur_per_unit
          FROM fx_rates f
          WHERE f.base_currency = y.currency
            AND f.rate_date <= y.contract_date
            AND f.rate_date >= date(y.contract_date, '-10 days')
          ORDER BY f.rate_date DESC
          LIMIT 1
        )
        ELSE NULL END AS fx_rate
    FROM (
      SELECT z.*,
        ROW_NUMBER() OVER (
          PARTITION BY z.unp, COALESCE(z.contract_number, ''), z.bidder_key, COALESCE(NULLIF(z.lot_norm, ''), '_')
          ORDER BY z.signing_value, z.contract_date, z.document_number, z.id
        ) AS contract_ordinal
      FROM (
        SELECT c.*,
          CASE
            WHEN c.lot_id LIKE 'LOT-%' AND REPLACE(c.lot_id, 'LOT-', '') <> '' AND REPLACE(c.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(c.lot_id, 'LOT-', '') AS INTEGER)
            WHEN c.lot_id <> '' AND c.lot_id NOT GLOB '*[^0-9]*' THEN CAST(c.lot_id AS INTEGER)
            ELSE c.lot_id
          END AS lot_norm,
          CASE
            -- Over-valuation + absurd FIRST and repaired to the procedure estimate.
            -- value_low is labelled-but-counted (see the amount_eur CASE). Keep in sync with
            -- normalize-raw.sql and the OCDS block above.
            WHEN c.eff_eur > 2000000000 OR (c.proc_est_eur >= 1000 AND c.eff_eur > 200 * c.proc_est_eur) THEN 'value_suspect'
            -- value_low: zero/negative, OR a tiny signed value (< 1000 EUR) that is also < 5% of the
            -- estimate. The < 1000 EUR floor keeps large legitimate framework call-offs OUT.
            WHEN COALESCE(c.current_value, c.signing_value) <= 0 THEN 'value_low'
            WHEN c.estimated_value > 0 AND c.signing_value IS NOT NULL AND (
              CASE
                WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN c.signing_value
                WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN c.signing_value / 1.95583
                ELSE c.signing_value * (
                  SELECT f.eur_per_unit
                  FROM fx_rates f
                  WHERE f.base_currency = c.currency
                    AND f.rate_date <= c.contract_date
                    AND f.rate_date >= date(c.contract_date, '-10 days')
                  ORDER BY f.rate_date DESC
                  LIMIT 1
                )
              END
            ) < 1000 AND (
              CASE
                WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN c.signing_value
                WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN c.signing_value / 1.95583
                ELSE c.signing_value * (
                  SELECT f.eur_per_unit
                  FROM fx_rates f
                  WHERE f.base_currency = c.currency
                    AND f.rate_date <= c.contract_date
                    AND f.rate_date >= date(c.contract_date, '-10 days')
                  ORDER BY f.rate_date DESC
                  LIMIT 1
                )
              END
            ) / NULLIF((
              CASE
                WHEN COALESCE(NULLIF(c.procurement_currency, ''), NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN c.estimated_value
                WHEN COALESCE(NULLIF(c.procurement_currency, ''), NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN c.estimated_value / 1.95583
                ELSE c.estimated_value * (
                  SELECT f.eur_per_unit
                  FROM fx_rates f
                  WHERE f.base_currency = COALESCE(NULLIF(c.procurement_currency, ''), NULLIF(c.currency, ''))
                    AND f.rate_date <= c.contract_date
                    AND f.rate_date >= date(c.contract_date, '-10 days')
                  ORDER BY f.rate_date DESC
                  LIMIT 1
                )
            END
          ), 0) < 0.05 THEN 'value_low'
            WHEN c.current_value IS NOT NULL AND (c.current_value < 0 OR (c.signing_value > 0 AND c.current_value / c.signing_value >= 100)) THEN 'annex_suspect'
            WHEN c.proc_est_eur > 0 AND c.eff_eur >= 10 * c.proc_est_eur THEN 'review'
            ELSE 'ok'
          END AS value_flag,
          CASE
            WHEN c.contract_date IS NOT NULL
             AND c.published_at IS NOT NULL
             AND c.contract_date > date(c.published_at, '+2 day') THEN 'signed_after_publication'
            ELSE 'ok'
          END AS date_flag,
          c.bidder_key
        FROM (
          SELECT c.*, ci.bidder_key,
          c.authority_name AS authority_name_raw,
            CASE
              WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN COALESCE(c.current_value, c.signing_value)
              WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN COALESCE(c.current_value, c.signing_value) / 1.95583
              ELSE COALESCE(c.current_value, c.signing_value) * (
                SELECT f.eur_per_unit
                FROM fx_rates f
                WHERE f.base_currency = NULLIF(c.currency, '')
                  AND f.rate_date <= c.contract_date
                  AND f.rate_date >= date(c.contract_date, '-10 days')
                ORDER BY f.rate_date DESC
                LIMIT 1
              )
            END AS eff_eur,
            CASE
              WHEN t.estimated_value IS NULL THEN NULL
              WHEN COALESCE(NULLIF(t.currency, ''), 'BGN') = 'EUR' THEN t.estimated_value
              WHEN COALESCE(NULLIF(t.currency, ''), 'BGN') = 'BGN' THEN t.estimated_value / 1.95583
              ELSE t.estimated_value * (
                SELECT f.eur_per_unit
                FROM fx_rates f
                WHERE f.base_currency = NULLIF(t.currency, '')
                  AND f.rate_date <= c.contract_date
                  AND f.rate_date >= date(c.contract_date, '-10 days')
                ORDER BY f.rate_date DESC
                LIMIT 1
              )
            END AS proc_est_eur,
            t.estimated_value AS proc_est_native
          FROM raw_contracts c
          JOIN contractor_identity ci
            ON c.contractor_eik IS ci.eik_raw AND c.contractor_name IS ci.name_raw
          LEFT JOIN tenders t ON t.id = 't:' || c.unp
        ) c
        WHERE c.source LIKE 'eop:%'
          AND NOT EXISTS (
            SELECT 1 FROM raw_contracts a
            WHERE a.source LIKE 'eop:%'
              -- Bare equality (not COALESCE) so idx_raw_cnum drives the seek; contract_number is
              -- non-null (base keep-filter), so this is identical to COALESCE(...,'') but avoids the
              -- O(n^2) full scan. Mirrors the same fix in normalize-raw.sql.
              AND a.contract_number = c.contract_number
              AND COALESCE(a.unp, '') = COALESCE(c.unp, '')
              AND COALESCE(a.lot_id, '') = COALESCE(c.lot_id, '')
              AND COALESCE(a.contractor_eik, '') = COALESCE(c.contractor_eik, '')
              AND COALESCE(a.contractor_name, '') = COALESCE(c.contractor_name, '')
              AND (a.source > c.source OR (a.source = c.source AND a.id > c.id)))
      ) z
    ) y
  ) q
) x
WHERE x.display_native IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || x.unp)
  AND EXISTS (SELECT 1 FROM bidders b WHERE b.id = x.bidder_key)
  AND NOT EXISTS (
    SELECT 1 FROM contracts c2
    WHERE c2.id NOT GLOB 'c:[eo]:*'
      AND c2.contract_number = x.contract_number
      AND c2.tender_id = 't:' || x.unp
      AND COALESCE(c2.lot_id, '') = COALESCE(CASE WHEN x.lot_norm IS NOT NULL AND TRIM(x.lot_norm) <> '' THEN 'lot:' || x.unp || ':' || x.lot_norm ELSE NULL END, '')
      AND c2.bidder_id = x.bidder_key
  );

UPDATE tenders
SET status = 'awarded'
WHERE status <> 'awarded'
  AND EXISTS (SELECT 1 FROM raw_contracts c WHERE 't:' || c.unp = tenders.id);


-- 5) Promote window amendments into served domain history and roll touched contracts.
-- @refresh-batch amendments
INSERT OR REPLACE INTO amendments (
  id, natural_key, contract_number, unp, value_before, value_after, value_delta, currency,
  published_at, document_number, description, source
)
WITH keyed AS (
  SELECT
    *,
    'am:' || COALESCE(unp, '') || ':' || COALESCE(contract_number, '') || ':' ||
      COALESCE(
        NULLIF(document_number, ''),
        NULLIF(correction_number, ''),
        NULLIF(seq_no, ''),
        'content:' || COALESCE(published_at, '') || ':' ||
          COALESCE(CAST(value_before AS TEXT), '') || ':' ||
          COALESCE(CAST(value_after AS TEXT), '') || ':' ||
          COALESCE(CAST(value_delta AS TEXT), '') || ':' ||
          COALESCE(currency, '') || ':' ||
          COALESCE(description, '')
      ) AS natural_key
  FROM raw_amendments
), dedup AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY natural_key
      ORDER BY source DESC, id DESC
    ) AS rn
  FROM keyed
)
SELECT
  natural_key,
  natural_key,
  contract_number,
  unp,
  value_before,
  value_after,
  value_delta,
  currency,
  published_at,
  document_number,
  description,
  source
FROM dedup
WHERE rn = 1;

UPDATE contracts
SET
  annex_count = (
    SELECT COUNT(*) FROM amendments a
    WHERE a.unp = substr(contracts.tender_id, 3)
      AND a.contract_number = contracts.contract_number
  ),
  current_value = (
    SELECT a.value_after FROM amendments a
    WHERE a.unp = substr(contracts.tender_id, 3)
      AND a.contract_number = contracts.contract_number
      AND a.value_after IS NOT NULL
    ORDER BY a.published_at DESC, a.id DESC
    LIMIT 1
  )
WHERE (id GLOB 'c:[eo]:*' AND EXISTS (
      SELECT 1 FROM raw_contracts rc
      WHERE rc.unp = substr(contracts.tender_id, 3)
        AND rc.contract_number = contracts.contract_number
   ))
   OR EXISTS (
      SELECT 1 FROM raw_amendments ra
      WHERE ra.unp = substr(contracts.tender_id, 3)
        AND ra.contract_number = contracts.contract_number
   );

WITH contract_base AS (
  SELECT c.id, c.currency, c.signing_value, c.current_value, c.fx_rate, c.value_flag,
    te.estimated_value AS proc_est_native,
    CASE
      WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'EUR' THEN COALESCE(c.current_value, c.signing_value)
      WHEN COALESCE(NULLIF(c.currency, ''), 'BGN') = 'BGN' THEN COALESCE(c.current_value, c.signing_value) / 1.95583
      WHEN c.fx_rate IS NOT NULL THEN COALESCE(c.current_value, c.signing_value) * c.fx_rate
      ELSE NULL
    END AS eff_eur,
    CASE
      WHEN te.estimated_value IS NULL THEN NULL
      WHEN COALESCE(NULLIF(te.currency, ''), 'BGN') = 'EUR' THEN te.estimated_value
      WHEN COALESCE(NULLIF(te.currency, ''), 'BGN') = 'BGN' THEN te.estimated_value / 1.95583
      ELSE te.estimated_value * (
        SELECT f.eur_per_unit
        FROM fx_rates f
        WHERE f.base_currency = NULLIF(te.currency, '')
          AND f.rate_date <= c.signed_at
          AND f.rate_date >= date(c.signed_at, '-10 days')
        ORDER BY f.rate_date DESC
        LIMIT 1
      )
    END AS proc_est_eur,
    te.estimated_value AS tender_estimated_value,
    COALESCE((
      SELECT rc.estimated_value
      FROM raw_contracts rc
      WHERE rc.unp = substr(c.tender_id, 3)
        AND rc.contract_number = c.contract_number
        AND (
          (c.id LIKE 'c:e:%' AND rc.source LIKE 'eop:%')
          OR (c.id LIKE 'c:o:%' AND rc.source LIKE 'ocds:%')
        )
      ORDER BY rc.source DESC, rc.id DESC
      LIMIT 1
    ), te.estimated_value) AS classifier_estimated_value
  FROM contracts c
  JOIN tenders te ON te.id = c.tender_id
  WHERE (
      (c.id GLOB 'c:[eo]:*' AND EXISTS (
        SELECT 1 FROM raw_contracts rc
        WHERE rc.unp = substr(c.tender_id, 3)
          AND rc.contract_number = c.contract_number
      ))
      OR EXISTS (
        SELECT 1 FROM raw_amendments ra
        WHERE ra.unp = substr(c.tender_id, 3)
          AND ra.contract_number = c.contract_number
      )
    )
    AND EXISTS (
      SELECT 1 FROM amendments a
      WHERE a.unp = substr(c.tender_id, 3)
        AND a.contract_number = c.contract_number
    )
), base AS (
  SELECT id, currency, signing_value, current_value, fx_rate, proc_est_eur, proc_est_native,
    CASE
      WHEN c.value_flag <> 'annex_suspect'
        AND NOT (c.current_value IS NOT NULL AND (c.current_value < 0 OR (c.signing_value > 0 AND c.current_value / c.signing_value >= 100)))
      THEN c.value_flag
      WHEN c.eff_eur > 2000000000 OR (c.proc_est_eur >= 1000 AND c.eff_eur > 200 * c.proc_est_eur) THEN 'value_suspect'
      WHEN c.current_value IS NOT NULL AND (c.current_value < 0 OR (c.signing_value > 0 AND c.current_value / c.signing_value >= 100)) THEN 'annex_suspect'
      WHEN c.proc_est_eur > 0 AND c.eff_eur >= 10 * c.proc_est_eur THEN 'review'
      ELSE 'ok'
    END AS new_value_flag
  FROM contract_base c
), calc AS (
  SELECT id, new_value_flag, proc_est_eur,
    CASE new_value_flag
      WHEN 'value_suspect' THEN proc_est_native
      WHEN 'annex_suspect' THEN COALESCE(signing_value, current_value)
      ELSE COALESCE(current_value, signing_value)
    END AS display_native,
    CASE new_value_flag
      WHEN 'value_suspect' THEN NULL
      WHEN 'annex_suspect' THEN COALESCE(signing_value, current_value)
      ELSE COALESCE(current_value, signing_value)
    END AS trusted_native,
    CASE
      WHEN new_value_flag IN ('value_suspect', 'annex_suspect') OR current_value IS NULL THEN NULL
      WHEN COALESCE(currency, 'BGN') = 'EUR' THEN current_value
      WHEN COALESCE(currency, 'BGN') = 'BGN' THEN current_value / 1.95583
      WHEN fx_rate IS NOT NULL THEN current_value * fx_rate
      ELSE NULL
    END AS new_current_value_eur,
    currency,
    fx_rate,
    signing_value
  FROM base
), recalculated AS (
  SELECT id, new_value_flag, display_native, trusted_native,
    CASE
      WHEN new_value_flag = 'value_suspect' THEN proc_est_eur
      WHEN trusted_native IS NULL THEN NULL
      WHEN COALESCE(currency, 'BGN') = 'EUR' THEN trusted_native
      WHEN COALESCE(currency, 'BGN') = 'BGN' THEN trusted_native / 1.95583
      WHEN fx_rate IS NOT NULL THEN trusted_native * fx_rate
      ELSE NULL
    END AS new_amount_eur,
    CASE
      WHEN new_value_flag = 'value_suspect' OR signing_value IS NULL THEN NULL
      WHEN COALESCE(currency, 'BGN') = 'EUR' THEN signing_value
      WHEN COALESCE(currency, 'BGN') = 'BGN' THEN signing_value / 1.95583
      WHEN fx_rate IS NOT NULL THEN signing_value * fx_rate
      ELSE NULL
    END AS new_signing_value_eur,
    new_current_value_eur
  FROM calc
)
UPDATE contracts
SET
  value_flag = recalculated.new_value_flag,
  amount = recalculated.display_native,
  amount_eur = recalculated.new_amount_eur,
  signing_value_eur = recalculated.new_signing_value_eur,
  current_value_eur = recalculated.new_current_value_eur
FROM recalculated
WHERE recalculated.id = contracts.id;

INSERT OR IGNORE INTO refresh_touched_contracts (id)
SELECT DISTINCT c.id
FROM raw_contracts rc
JOIN contracts c ON c.contract_number = rc.contract_number AND c.tender_id = 't:' || rc.unp
WHERE rc.contract_number IS NOT NULL
  AND c.id GLOB 'c:[eo]:*'
UNION
SELECT DISTINCT c.id
FROM raw_contracts rc
JOIN contracts c ON c.contract_number IS NULL AND c.tender_id = 't:' || rc.unp
WHERE rc.contract_number IS NULL
  AND c.id GLOB 'c:[eo]:*'
UNION
SELECT DISTINCT c.id
FROM raw_amendments ra
JOIN contracts c ON c.contract_number = ra.contract_number AND c.tender_id = 't:' || ra.unp
WHERE ra.contract_number IS NOT NULL
UNION
SELECT DISTINCT c.id
FROM raw_amendments ra
JOIN contracts c ON c.contract_number IS NULL AND c.tender_id = 't:' || ra.unp
WHERE ra.contract_number IS NULL;
INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT DISTINCT c.bidder_id
FROM contracts c
WHERE c.id IN (SELECT id FROM refresh_touched_contracts)
  AND c.bidder_id IS NOT NULL;
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT DISTINCT t.authority_id
FROM contracts c JOIN tenders t ON t.id = c.tender_id
WHERE c.id IN (SELECT id FROM refresh_touched_contracts)
  AND t.authority_id IS NOT NULL;
INSERT OR IGNORE INTO refresh_touched_authorities (authority_id)
SELECT a.id
FROM authorities a
WHERE a.bulstat IN (
    SELECT authority_eik FROM raw_contracts WHERE authority_eik IS NOT NULL
    UNION
    SELECT authority_eik FROM raw_tenders WHERE authority_eik IS NOT NULL
    UNION
    SELECT eik FROM raw_ocds_parties WHERE eik IS NOT NULL
  );
INSERT OR IGNORE INTO refresh_touched_bidders (bidder_id)
SELECT b.id
FROM bidders b
WHERE b.eik_normalized IN (SELECT eik FROM raw_ocds_parties WHERE eik IS NOT NULL)
  OR b.id IN (SELECT bidder_key FROM contractor_identity);

DROP TABLE contractor_identity;

-- 6) Refresh rollups + FTS. Only the D1-hot rollups are scoped to touched rows; cheaper rollups stay
-- full-recomputed in isolated batches so convergence stays simple.
-- @refresh-batch company-totals
DELETE FROM company_totals WHERE bidder_id IN (SELECT bidder_id FROM refresh_touched_bidders);
INSERT INTO company_totals (bidder_id, name, kind, ownership_kind, eik, eik_valid, settlement, won_eur, contracts, authorities, eu_eur, first_date, last_date)
SELECT b.id, b.name, b.kind, b.ownership_kind, b.eik_normalized, b.eik_valid, b.settlement,
  SUM(c.amount_eur), COUNT(*), COUNT(DISTINCT t.authority_id),
  SUM(CASE WHEN c.eu_funded = 1 THEN c.amount_eur ELSE 0 END), MIN(c.signed_at), MAX(c.signed_at)
FROM contracts c JOIN bidders b ON b.id = c.bidder_id JOIN tenders t ON t.id = c.tender_id
WHERE c.amount_eur IS NOT NULL AND c.bidder_id IN (SELECT bidder_id FROM refresh_touched_bidders)
GROUP BY b.id;
UPDATE company_totals SET primary_sector = (
  SELECT substr(t.cpv_code, 1, 2) FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE c.bidder_id = company_totals.bidder_id AND c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'') <> ''
  GROUP BY substr(t.cpv_code, 1, 2) ORDER BY SUM(c.amount_eur) DESC, substr(t.cpv_code, 1, 2) LIMIT 1)
WHERE bidder_id IN (SELECT bidder_id FROM refresh_touched_bidders);

-- @refresh-batch authority-totals
DELETE FROM authority_totals WHERE authority_id IN (SELECT authority_id FROM refresh_touched_authorities);
INSERT INTO authority_totals (authority_id, name, type_group, settlement, region, spent_eur, contracts, suppliers, avg_eur, eu_eur, first_date, last_date)
SELECT a.id, a.name, a.type_group, a.settlement, a.region,
  SUM(c.amount_eur), COUNT(*), COUNT(DISTINCT c.bidder_id), SUM(c.amount_eur) / COUNT(*),
  SUM(CASE WHEN c.eu_funded = 1 THEN c.amount_eur ELSE 0 END), MIN(c.signed_at), MAX(c.signed_at)
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
WHERE c.amount_eur IS NOT NULL AND t.authority_id IN (SELECT authority_id FROM refresh_touched_authorities)
GROUP BY a.id;
UPDATE authority_totals SET primary_sector = (
  SELECT substr(t.cpv_code, 1, 2) FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE t.authority_id = authority_totals.authority_id AND c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'') <> ''
  GROUP BY substr(t.cpv_code, 1, 2) ORDER BY SUM(c.amount_eur) DESC, substr(t.cpv_code, 1, 2) LIMIT 1)
WHERE authority_id IN (SELECT authority_id FROM refresh_touched_authorities);

-- @refresh-batch flow-pairs
DELETE FROM flow_pairs;
INSERT INTO flow_pairs (authority_id, bidder_id, authority_name, bidder_name, bidder_kind, won_eur, contracts)
SELECT t.authority_id, c.bidder_id, a.name, b.name, b.kind, SUM(c.amount_eur), COUNT(*)
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id JOIN bidders b ON b.id = c.bidder_id
WHERE c.amount_eur IS NOT NULL
GROUP BY t.authority_id, c.bidder_id;

-- @refresh-batch entity-search-index
DELETE FROM search_index WHERE kind = 'company';
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'company', ct.bidder_id, ct.name, COALESCE(ct.eik, ''), COALESCE(ct.settlement, ''), ct.won_eur
FROM company_totals ct
WHERE ct.bidder_id <> 'unknown:анонимен';
DELETE FROM search_index WHERE kind = 'authority';
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'authority', at.authority_id, at.name, COALESCE(substr(at.authority_id, 6), ''), COALESCE(at.settlement, ''), at.spent_eur
FROM authority_totals at;

-- @refresh-batch contract-search-index
DELETE FROM search_index WHERE kind = 'contract' AND ref IN (SELECT id FROM refresh_touched_contracts);
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'contract', c.id, COALESCE(NULLIF(c.contract_subject, ''), t.title), COALESCE(t.source_id, ''),
  a.name || ' → ' || b.name, c.amount_eur
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id JOIN bidders b ON b.id = c.bidder_id
WHERE c.id IN (SELECT id FROM refresh_touched_contracts)
  AND COALESCE(NULLIF(c.contract_subject, ''), t.title) IS NOT NULL;

-- Small global rollups - recomputed in full (one-row / small facet tables; cheap per refresh).
-- @refresh-batch globals
DELETE FROM data_freshness;
INSERT INTO data_freshness (source, as_of, rows, refreshed_at)
SELECT
  CASE
    WHEN id LIKE 'c:e:%' THEN 'eop'
    WHEN id LIKE 'c:o:%' THEN 'ocds'
    ELSE 'other'
  END AS src,
  MAX(CASE WHEN signed_at <= date('now') THEN signed_at END),
  COUNT(*),
  datetime('now')
FROM contracts
GROUP BY src;

DELETE FROM home_totals;
INSERT INTO home_totals (id, contracts, value_eur, authorities, bidders, suspect, first_date, last_date, as_of, refreshed_at)
SELECT 1,
  (SELECT COUNT(*) FROM contracts),
  (SELECT COALESCE(SUM(amount_eur), 0) FROM contracts),
  (SELECT COUNT(*) FROM authority_totals),
  (SELECT COUNT(*) FROM company_totals),
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'value_suspect'),
  (SELECT MIN(signed_at) FROM contracts WHERE signed_at >= '2020-01-01' AND signed_at <= date('now')),
  (SELECT MAX(signed_at) FROM contracts WHERE signed_at <= date('now')),
  -- Freshness is the latest in-corpus signed contract date. data_freshness is maintained above.
  (SELECT MAX(signed_at) FROM contracts WHERE signed_at <= date('now')),
  datetime('now');

DELETE FROM sector_totals;
INSERT INTO sector_totals (division, contracts, value_eur)
SELECT substr(t.cpv_code, 1, 2), COUNT(*), COALESCE(SUM(c.amount_eur), 0)
FROM contracts c JOIN tenders t ON t.id = c.tender_id
WHERE c.amount_eur IS NOT NULL AND COALESCE(t.cpv_code,'') <> ''
GROUP BY substr(t.cpv_code, 1, 2);

DELETE FROM facet_counts;
INSERT INTO facet_counts (facet, key, contracts, value_eur)
SELECT 'procedure', t.procedure_type, COUNT(*), COALESCE(SUM(c.amount_eur), 0)
FROM contracts c JOIN tenders t ON t.id = c.tender_id GROUP BY t.procedure_type;
INSERT INTO facet_counts (facet, key, contracts, value_eur)
SELECT 'eu', CASE WHEN c.eu_funded = 1 THEN '1' ELSE '0' END, COUNT(*), COALESCE(SUM(c.amount_eur), 0)
FROM contracts c GROUP BY CASE WHEN c.eu_funded = 1 THEN '1' ELSE '0' END;

-- @refresh-batch cleanup
DROP TABLE IF EXISTS refresh_touched_contracts;
DROP TABLE IF EXISTS refresh_touched_bidders;
DROP TABLE IF EXISTS refresh_touched_authorities;
