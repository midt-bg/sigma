-- Sigma - normalise the EOP/OCDS staging into the domain tables
-- (authorities, tenders, lots, bidders, contracts). Run AFTER scripts/load-eop.mjs
-- (+ scripts/derive-amendments.sql for current_value/annex_count) have populated staging:
--   (cd apps/web && wrangler d1 execute sigma --local --file ../../scripts/normalize-raw.sql)
--
-- SOURCE MODEL (see docs/etl.md): the EOP open-data feed is the authoritative base for
-- 2020-2026 (raw_contracts + raw_tenders, source 'eop:%'). The OCDS JSON feed is the
-- go-forward delta for new 2026+ data (source 'ocds:%'); its rows carry their procedure fields on
-- the contract row, so they flow through here automatically and a UNP with no tenders-export row
-- gets a synthetic tender (step 2b). DEDUPE (step 5): where OCDS overlaps the EOP corpus,
-- EOP WINS - an OCDS contract is taken only when no EOP row shares its contract_number (the
-- public-procurement contract document number, common to both feeds; OCDS keeps its ocid in unp,
-- which never matches the EOP UNP format, so contract_number is the cross-source key). Genuinely new OCDS contracts
-- are added. This makes the OCDS go-live catch-up safe even though OCDS republishes contracts
-- already in EOP. data_freshness records the "current as of" boundary per feed.
--
-- FULL REBUILD: clears the derived tables and re-inserts from staging, so a re-run always
-- reflects the current rules and never leaves stale rows. wrangler runs this file as one
-- atomic D1 batch (explicit BEGIN/COMMIT is rejected), so a failed run rolls back.
--
-- Cleaning policy — staging stays 100% raw; cleaning happens only here:
--   * Currency is kept per row as it appears (BGN pre-2026, EUR from 2026, a few foreign) —
--     NOT coerced to one currency. Money sums must group/convert by currency downstream.
--   * Authorities dedupe on ЕИК (Вид на възложителя kept as `type`); a canonical name is kept.
--   * Bidders use a checksum-valid contractor ЕИК, then normalised name, then one unknown bucket;
--     is_consortium comes from the entity name, while awarded_to_group stays contract-scoped. Resolving the
--     members hidden behind a single consortium ЕИК needs the Търговски регистър (joined on ЕИК),
--     a parked future pipeline; for now the full value is attributed to the consortium entity.
--   * Tenders come from the tenders-export header row (one per УНП); lots from its lot rows.
--     11k+ УНП appear only in contracts (no tenders row) → a synthetic 'неизвестна' tender so
--     every contract has a parent. bids stays empty (the data has a bid COUNT, not bids).

-- Full clear in child→parent order (D1 enforces FKs).
DROP TABLE IF EXISTS joint_tender_leads;
DROP TABLE IF EXISTS unp_prefix_authorities;
DROP TABLE IF EXISTS joint_authority_members;
DROP TABLE IF EXISTS joint_tender_sources;
DELETE FROM search_index;
DELETE FROM flow_pairs;
DELETE FROM company_totals;
DELETE FROM authority_joint_participation;
DELETE FROM authority_totals;
DELETE FROM sector_totals;
DELETE FROM facet_counts;
DELETE FROM home_totals;
DELETE FROM contract_co_authorities;
DELETE FROM contracts;
DELETE FROM lots;
DELETE FROM tenders;
DELETE FROM bidders;
DELETE FROM authorities;

-- 1) Authorities — dedupe on ЕИК across both contracts and tenders staging, keep a
--    canonical display name and the authority type (Вид на възложителя).
--    Names use the mode per ЕИК, with deterministic presentation-quality tiebreaks.
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
      SELECT authority_eik, authority_name FROM raw_contracts WHERE authority_eik IS NOT NULL AND authority_eik NOT LIKE '%;%'
      UNION ALL
      SELECT authority_eik, authority_name FROM raw_tenders   WHERE authority_eik IS NOT NULL AND authority_eik NOT LIKE '%;%'
    )
    WHERE authority_name IS NOT NULL AND TRIM(authority_name) <> ''
    GROUP BY authority_eik, authority_name
  )
)
WHERE rn = 1;

-- Keep the type modal within rows carrying the winning name, so the two canonical fields describe
-- the same entity when an ЕИК has been shared or reused under multiple labels.
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
      UNION ALL
      SELECT t.authority_eik, t.authority_type
      FROM raw_tenders t
      JOIN authority_canonical_name acn
        ON acn.authority_eik = t.authority_eik AND acn.canonical_name = t.authority_name
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
  -- Composite joint-procurement EIKs ('EIK1; EIK2') must not mint standalone authorities —
  -- they are attributed via their individual members; an unguarded source mints orphan
  -- 'auth:EIK1; EIK2' rows referenced by nothing (verified on a full 2020-2026 rebuild).
  SELECT authority_eik FROM raw_contracts WHERE authority_eik IS NOT NULL AND authority_eik NOT LIKE '%;%'
  UNION
  SELECT authority_eik FROM raw_tenders WHERE authority_eik IS NOT NULL AND authority_eik NOT LIKE '%;%'
) s
LEFT JOIN authority_canonical_name acn ON acn.authority_eik = s.authority_eik
LEFT JOIN authority_canonical_type act ON act.authority_eik = s.authority_eik;

-- 1a) Joint procurements — split the parallel EIK/name lists once and reuse the mapping for tender
-- ownership and the contract bridge. The modal raw row per UNP wins when cumulative source buckets
-- repeat a tender; ties are deterministic. Existing standalone authority names stay untouched.
CREATE TABLE joint_tender_sources (
  unp TEXT PRIMARY KEY,
  authority_eiks TEXT NOT NULL,
  authority_name TEXT,
  authority_type TEXT
);
WITH observations AS (
  SELECT unp, authority_eik, authority_name, authority_type
  FROM raw_tenders
  WHERE unp IS NOT NULL AND authority_eik LIKE '%;%'
  UNION ALL
  SELECT unp, authority_eik, authority_name, authority_type
  FROM raw_contracts
  WHERE unp IS NOT NULL AND authority_eik LIKE '%;%'
), ranked AS (
  SELECT unp, authority_eik, authority_name, authority_type,
    ROW_NUMBER() OVER (
      PARTITION BY unp
      ORDER BY COUNT(*) DESC,
        CASE WHEN authority_name GLOB '*[a-zа-я]*' THEN 0 ELSE 1 END,
        LENGTH(COALESCE(authority_name, '')) DESC,
        authority_eik, COALESCE(authority_name, ''), COALESCE(authority_type, '')
    ) AS rn
  FROM observations
  GROUP BY unp, authority_eik, authority_name, authority_type
)
INSERT INTO joint_tender_sources (unp, authority_eiks, authority_name, authority_type)
SELECT unp, authority_eik, authority_name, authority_type
FROM ranked
WHERE rn = 1;

CREATE TABLE joint_authority_members (
  unp TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  member_name TEXT,
  authority_type TEXT,
  source_ordinal INTEGER NOT NULL,
  PRIMARY KEY (unp, authority_id)
);
WITH RECURSIVE split (
  unp, authority_eik, member_name, authority_type, source_ordinal, eik_rest, name_rest
) AS (
  SELECT
    unp,
    TRIM(CASE WHEN INSTR(authority_eiks, ';') > 0
      THEN SUBSTR(authority_eiks, 1, INSTR(authority_eiks, ';') - 1) ELSE authority_eiks END),
    TRIM(CASE WHEN INSTR(COALESCE(authority_name, ''), ';') > 0
      THEN SUBSTR(authority_name, 1, INSTR(authority_name, ';') - 1) ELSE authority_name END),
    authority_type,
    0,
    CASE WHEN INSTR(authority_eiks, ';') > 0
      THEN SUBSTR(authority_eiks, INSTR(authority_eiks, ';') + 1) ELSE '' END,
    CASE WHEN INSTR(COALESCE(authority_name, ''), ';') > 0
      THEN SUBSTR(authority_name, INSTR(authority_name, ';') + 1) ELSE '' END
  FROM joint_tender_sources
  UNION ALL
  SELECT
    unp,
    TRIM(CASE WHEN INSTR(eik_rest, ';') > 0
      THEN SUBSTR(eik_rest, 1, INSTR(eik_rest, ';') - 1) ELSE eik_rest END),
    TRIM(CASE WHEN INSTR(name_rest, ';') > 0
      THEN SUBSTR(name_rest, 1, INSTR(name_rest, ';') - 1) ELSE name_rest END),
    authority_type,
    source_ordinal + 1,
    CASE WHEN INSTR(eik_rest, ';') > 0
      THEN SUBSTR(eik_rest, INSTR(eik_rest, ';') + 1) ELSE '' END,
    CASE WHEN INSTR(name_rest, ';') > 0
      THEN SUBSTR(name_rest, INSTR(name_rest, ';') + 1) ELSE '' END
  FROM split
  WHERE TRIM(eik_rest) <> ''
)
INSERT OR IGNORE INTO joint_authority_members
  (unp, authority_id, member_name, authority_type, source_ordinal)
SELECT unp, 'auth:' || authority_eik, NULLIF(member_name, ''), authority_type, source_ordinal
FROM split
-- A member EIK still carrying ';' is a composite the split could not decompose - not a real
-- single authority; it must not seed a member row or mint an orphan 'auth:EIK1; EIK2'.
WHERE authority_eik <> '' AND authority_eik NOT LIKE '%;%';

-- A minority of co-authorities never occur standalone. Mint those real EIK identities from the
-- positionally corresponding name component; INSERT OR IGNORE preserves every standalone row.
WITH name_counts AS (
  SELECT authority_id, member_name, COUNT(*) AS uses,
    ROW_NUMBER() OVER (
      PARTITION BY authority_id
      ORDER BY COUNT(*) DESC,
        CASE WHEN member_name GLOB '*[a-zа-я]*' THEN 0 ELSE 1 END,
        LENGTH(member_name) DESC, member_name
    ) AS rn
  FROM joint_authority_members
  WHERE member_name IS NOT NULL
  GROUP BY authority_id, member_name
), member_defaults AS (
  SELECT m.authority_id,
    COALESCE(n.member_name, SUBSTR(m.authority_id, 6)) AS authority_name,
    MIN(SUBSTR(m.authority_id, 6)) AS authority_eik,
    MAX(m.authority_type) AS authority_type
  FROM joint_authority_members m
  LEFT JOIN name_counts n ON n.authority_id = m.authority_id AND n.rn = 1
  GROUP BY m.authority_id
)
INSERT OR IGNORE INTO authorities (id, name, bulstat, type)
SELECT authority_id, authority_name, authority_eik, authority_type
FROM member_defaults;

-- Learn the modal standalone authority for each valid УНП prefix. The prefix identifies the
-- authority that registered the procedure and therefore outranks the name/first-EIK fallbacks.
CREATE TABLE unp_prefix_authorities (
  prefix TEXT PRIMARY KEY,
  authority_eik TEXT NOT NULL
);
WITH prefix_observations AS (
  SELECT SUBSTR(unp, 1, 5) AS prefix, authority_eik FROM raw_contracts
  WHERE authority_eik IS NOT NULL AND authority_eik NOT LIKE '%;%'
    AND unp GLOB '[0-9][0-9][0-9][0-9][0-9]-*'
  UNION ALL
  SELECT SUBSTR(unp, 1, 5) AS prefix, authority_eik FROM raw_tenders
  WHERE authority_eik IS NOT NULL AND authority_eik NOT LIKE '%;%'
    AND unp GLOB '[0-9][0-9][0-9][0-9][0-9]-*'
), ranked AS (
  SELECT prefix, authority_eik,
    ROW_NUMBER() OVER (
      PARTITION BY prefix
      ORDER BY COUNT(*) DESC, authority_eik
    ) AS rn
  FROM prefix_observations
  GROUP BY prefix, authority_eik
)
INSERT INTO unp_prefix_authorities (prefix, authority_eik)
SELECT prefix, authority_eik FROM ranked WHERE rn = 1;

-- Lead default: prefer the УНП-prefix authority, then match the tender's modal raw authority name
-- to a co-authority's modal standalone name. Unmatched rows fall back to the first EIK. This
-- scratch-only mode does not alter displayed canonical names (that remains the separate #194 concern).
CREATE TABLE joint_tender_leads (
  unp TEXT PRIMARY KEY,
  authority_id TEXT NOT NULL REFERENCES authorities(id)
);
WITH standalone_observations AS (
  SELECT authority_eik, authority_name FROM raw_contracts
  WHERE authority_eik IS NOT NULL AND authority_eik NOT LIKE '%;%' AND authority_name IS NOT NULL
  UNION ALL
  SELECT authority_eik, authority_name FROM raw_tenders
  WHERE authority_eik IS NOT NULL AND authority_eik NOT LIKE '%;%' AND authority_name IS NOT NULL
), canonical_names AS (
  SELECT authority_eik, authority_name
  FROM (
    SELECT authority_eik, authority_name,
      ROW_NUMBER() OVER (
        PARTITION BY authority_eik
        ORDER BY COUNT(*) DESC,
          CASE WHEN authority_name GLOB '*[a-zа-я]*' THEN 0 ELSE 1 END,
          LENGTH(authority_name) DESC, authority_name
      ) AS rn
    FROM standalone_observations
    GROUP BY authority_eik, authority_name
  )
  WHERE rn = 1
), ranked AS (
  SELECT m.unp, m.authority_id,
    ROW_NUMBER() OVER (
      PARTITION BY m.unp
      ORDER BY CASE WHEN p.authority_eik = SUBSTR(m.authority_id, 6) THEN 0 ELSE 1 END,
        CASE WHEN c.authority_name = s.authority_name THEN 0 ELSE 1 END,
        m.source_ordinal, m.authority_id
    ) AS rn
  FROM joint_authority_members m
  JOIN joint_tender_sources s ON s.unp = m.unp
  LEFT JOIN canonical_names c ON c.authority_eik = SUBSTR(m.authority_id, 6)
  LEFT JOIN unp_prefix_authorities p
    ON p.prefix = CASE
      WHEN m.unp GLOB '[0-9][0-9][0-9][0-9][0-9]-*' THEN SUBSTR(m.unp, 1, 5)
    END
)
INSERT INTO joint_tender_leads (unp, authority_id)
SELECT unp, authority_id FROM ranked WHERE rn = 1;

-- 1b) Friendly authority type buckets — heuristic from name + ЗОП type (non-critical display field;
--     name patterns cover Title- and UPPER-case Cyrillic since SQLite LIKE is case-sensitive for it).
UPDATE authorities SET type_group = CASE
  WHEN name LIKE 'Община%' OR name LIKE 'ОБЩИНА%' OR name LIKE '%Столична община%' OR name LIKE '%СТОЛИЧНА ОБЩИНА%' THEN 'община'
  WHEN name LIKE 'Министерство%' OR name LIKE 'МИНИСТЕРСТВО%' THEN 'министерство'
  WHEN name LIKE '%болница%' OR name LIKE '%БОЛНИЦА%' OR name LIKE 'МБАЛ%' OR name LIKE '%МБАЛ%' OR name LIKE '%СБАЛ%' OR name LIKE '%ДКЦ%' OR name LIKE '%лечебно заведение%' THEN 'болница'
  WHEN name LIKE '%университет%' OR name LIKE '%УНИВЕРСИТЕТ%' OR name LIKE '%училище%' OR name LIKE '%УЧИЛИЩЕ%' OR name LIKE '%гимназия%' OR name LIKE '%ГИМНАЗИЯ%' OR name LIKE '%детска градина%' OR name LIKE '%ДЕТСКА ГРАДИНА%' OR name LIKE '%академия%' THEN 'образование'
  WHEN name LIKE '%агенция%' OR name LIKE '%Агенция%' OR name LIKE '%АГЕНЦИЯ%' THEN 'агенция'
  WHEN EXISTS (
    SELECT 1
    FROM (
      SELECT authority_eik, authority_type FROM raw_contracts
      UNION ALL
      SELECT authority_eik, authority_type FROM raw_tenders
    ) raw_authority_types
    WHERE raw_authority_types.authority_eik = authorities.bulstat
      AND (
        raw_authority_types.authority_type LIKE 'Публично предприятие%'
        OR raw_authority_types.authority_type LIKE 'Комунални услуги%'
      )
  ) THEN 'държавна компания'
  ELSE 'друго'
END;

-- 2a) Tenders — the header row of each procurement (lot_id IS NULL): one per УНП, carrying
--     procedure type, CPV, the procurement-level estimated value, lot count and authority.
INSERT OR IGNORE INTO tenders
  (id, source_id, title, authority_id, ordering_unit_name, cpv_code, cpv_description, estimated_value, currency,
   procedure_type, contract_kind, num_lots, status, published_at, deadline_at,
   legal_basis, award_criteria, main_activity, notice_type,
   place_of_performance, start_date, end_date, duration, duration_unit,
   eu_programme, green, social, innovation, eauction, cancelled, eop_tender_id)
SELECT
  't:' || t.unp,
  t.unp,
  COALESCE(t.procurement_subject, '(без предмет)'),
  COALESCE((SELECT j.authority_id FROM joint_tender_leads j WHERE j.unp = t.unp),
    'auth:' || t.authority_eik),
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
  AND EXISTS (
    SELECT 1 FROM authorities a
    WHERE a.id = COALESCE(
      (SELECT j.authority_id FROM joint_tender_leads j WHERE j.unp = t.unp),
      'auth:' || t.authority_eik
    )
  );

-- 2b) Synthetic tenders — УНП that appear only in contracts (no tenders-export row), so
--     every contract has a parent. Procedure type is unknown ('неизвестна'); subject/CPV/
--     estimated are taken from the contract line.
WITH folded AS (
  SELECT
    c.unp,
    MIN(c.procurement_subject) AS raw_title,
    COALESCE(
      (SELECT j.authority_id FROM joint_tender_leads j WHERE j.unp = c.unp),
      'auth:' || MIN(c.authority_eik)
    ) AS authority_id,
    MIN(c.cpv_code) AS cpv_code,
    MIN(c.estimated_value) AS estimated_value,
    MIN(c.currency) AS raw_currency,
    MIN(c.contract_kind) AS contract_kind,
    MIN(c.legal_basis) AS legal_basis,
    MIN(c.award_criteria) AS award_criteria,
    MIN(NULLIF(c.tender_ext_id, '')) AS eop_tender_id  -- synthetic tenders inherit the EOP id from contracts
  FROM raw_contracts c
  WHERE 1 = 1
    AND c.unp IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM raw_tenders t WHERE t.unp = c.unp)
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
WHERE EXISTS (SELECT 1 FROM authorities a WHERE a.id = folded.authority_id)
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

-- 3) Lots — the lot rows of each procurement (lot_id IS NOT NULL), linked to their tender.
-- Canonical lot id is `lot:UNP:N` with N the integer lot number. The two feeds disagree on the raw
-- form — the tender feed numbers lots 1..N, the contract feed (OCDS) uses 'LOT-000N' — so BOTH the
-- lots id here and the contracts.lot_id below normalise it the same way, or the lots↔contract link
-- (and the „Обособени позиции" table / current-lot highlight) breaks for the OCDS rows.
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

-- 4) Winning-contractor identity — derive the checksum and three-rung key exactly once, then use
--    the NULL-safe raw pair for every bidder/contract projection below.
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

-- 4a) Bidders — valid ЕИК first, then normalised name, then one labelled unknown bucket. The
--      bucket keeps identity-poor contracts attached without polluting bulstat/eik_normalized.
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
GROUP BY bidder_key;

-- 4b) Curated public-owned winner classification. Exact EIK matches cover the allowlist; a small
-- branch list handles valid 13-digit branch EIKs used by AПИ/ОПУ, ЕСО/МЕР, БНР and Информационно
-- обслужване. Private look-alikes stay absent from the seed table and therefore remain NULL.
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

-- 5) Contracts — awarded lines (1:1 with staging rows), linked to tender + winning bidder,
--    with the data-quality verdict (see 0007_data_quality.sql):
--      value_flag = 'value_suspect'  effective value >2bn EUR, or >200× the procedure estimate
--                                    when that estimate is at least 1000 EUR — repaired to the
--                                    procedure estimate for sums/display
--                 | 'value_low'      zero/negative, OR a tiny signed value (< 1000 EUR) that is also
--                                    < 5% of the estimate. KEPT IN the sums (amount_eur populated) but
--                                    LABELLED — large legitimate framework call-offs (a small share of
--                                    a huge ceiling but big in absolute terms) are excluded by the
--                                    < 1000 EUR floor, so they keep counting and stay unflagged
--                 | 'annex_suspect'  amendment pushed current_value ≥100× signing, or negative →
--                                    fall back to signing_value, or current_value if signing is
--                                    missing, so the contract still counts
--                 | 'review'         ≥10× the procedure estimate (kept, but flagged)
--                 | 'ok'
--    `amount` is the as-recorded display value (current_value when an annex legitimately raised it,
--    else signing; procedure estimate for value_suspect; signing/current fallback for annex_suspect).
--    `amount_eur` is the SAFE-TO-SUM canonical value:
--    BGN→EUR at the fixed peg (÷1.95583), EUR as-is, foreign at the latest prior ECB rate within
--    10 days of signing (fx_rates); value_suspect uses the procedure estimate in EUR, and foreign
--    rows without a bounded prior rate stay NULL. fx_converted = 1 for foreign rows, and
--    fx_rate carries the applied rate on the row (amount * fx_rate = amount_eur), so the original value,
--    the rate, and the EUR value are all auditable without joining fx_rates.
INSERT OR IGNORE INTO contracts
  (id, tender_id, bidder_id, ordering_unit_name, amount, currency, signed_at,
   contract_number, signing_value, current_value, annex_count, eu_funded, bids_received,
   contract_kind, awarded_to_group, value_flag, date_flag, amount_eur, fx_converted, fx_rate,
   lot_id, document_number, published_at, contract_subject,
   eu_programme, duration_days, winner_size, contractor_country,
   bids_sme, bids_rejected, bids_non_eea,
   subcontractor_eik, subcontractor_name, subcontract_value,
   eauction, framework, accelerated, strategic)
SELECT
  CASE
    WHEN x.source LIKE 'eop:%' THEN 'c:e:' || COALESCE(x.unp, '') || ':' || COALESCE(x.contract_number, '') || ':' ||
      COALESCE(NULLIF(x.lot_norm, ''), '_') || ':' || x.bidder_key || ':' || x.contract_ordinal
    WHEN x.source LIKE 'ocds:%' THEN 'c:o:' || COALESCE(x.unp, '') || ':' || COALESCE(x.contract_number, '') || ':' ||
      COALESCE(NULLIF(x.lot_id, ''), '_') || ':' || x.bidder_key || ':' || x.contract_ordinal
    ELSE 'c:' || x.id
  END,
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
  CASE
    WHEN x.value_flag = 'value_suspect' THEN x.proc_est_eur
    WHEN x.trusted_native IS NULL THEN NULL
    WHEN COALESCE(x.currency, 'BGN') = 'EUR' THEN x.trusted_native
    WHEN COALESCE(x.currency, 'BGN') = 'BGN' THEN x.trusted_native / 1.95583
    ELSE x.trusted_native * x.fx_rate
  END,
  CASE WHEN COALESCE(x.currency, 'BGN') NOT IN ('BGN', 'EUR') THEN 1 ELSE 0 END,
  x.fx_rate,
  CASE WHEN x.lot_id IS NOT NULL AND TRIM(x.lot_id) <> '' THEN 'lot:' || x.unp || ':' || CASE
    WHEN x.lot_id LIKE 'LOT-%' AND REPLACE(x.lot_id, 'LOT-', '') <> '' AND REPLACE(x.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(x.lot_id, 'LOT-', '') AS INTEGER)
    WHEN x.lot_id <> '' AND x.lot_id NOT GLOB '*[^0-9]*' THEN CAST(x.lot_id AS INTEGER)
    ELSE x.lot_id
  END ELSE NULL END,
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
  SELECT y.*,
    CASE y.value_flag
      WHEN 'value_suspect' THEN y.proc_est_native
      WHEN 'annex_suspect' THEN COALESCE(y.signing_value, y.current_value)
      ELSE COALESCE(y.current_value, y.signing_value)
    END AS display_native,
    -- value_suspect is repaired directly from proc_est_eur in the outer amount_eur CASE; value_low and
    -- 'review' fall to the populated ELSE branch, so their amount_eur is set, NOT nulled.
    CASE y.value_flag
      WHEN 'value_suspect' THEN NULL
      WHEN 'annex_suspect' THEN COALESCE(y.signing_value, y.current_value)
      ELSE COALESCE(y.current_value, y.signing_value)
    END AS trusted_native,
    -- ECB rates are published on business days only; carry the latest prior rate forward for
    -- weekend/holiday signings, never future-dated, and cap the fallback at 10 calendar days.
    CASE WHEN COALESCE(y.currency, 'BGN') NOT IN ('BGN', 'EUR')
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
        PARTITION BY z.unp, COALESCE(z.contract_number, ''), z.bidder_key,
          CASE
            WHEN z.source LIKE 'eop:%' THEN COALESCE(NULLIF(z.lot_norm, ''), '_')
            ELSE COALESCE(NULLIF(z.lot_id, ''), '_')
          END
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
          -- Over-valuation + absurd are checked FIRST and repaired to the procedure estimate.
          -- value_low is a labelled-but-counted flag (see the amount_eur CASE).
          WHEN c.eff_eur > 2000000000 OR (c.proc_est_eur >= 1000 AND c.eff_eur > 200 * c.proc_est_eur) THEN 'value_suspect'
          -- value_low: zero/negative, OR a tiny signed value (< 1000 EUR) that is also < 5% of the
          -- estimate. Large legitimate framework call-offs (small share of a huge ceiling but big in
          -- absolute terms) are NOT caught — the < 1000 EUR floor keeps them OUT of value_low.
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
      -- EOP always; an OCDS row only when no EOP row shares its contract_number - EOP wins.
      -- Key is contract_number (the public-procurement contract document number, common to both feeds), NOT unp:
      -- OCDS stores its ocid in unp, which never matches the EOP UNP format. (idx_raw_cnum)
      -- EOP daily open-data buckets are CUMULATIVE: the same contract recurs across consecutive days,
      -- so keep exactly ONE row per logical contract (unp+contract_number+lot+contractor), choosing the
      -- latest source-day (then highest id). Without this, contracts and every EUR total double-count.
      -- The NOT EXISTS leads with contract_number so idx_raw_cnum/idx_raw_unp_cnum keep it cheap.
      WHERE (c.source LIKE 'eop:%' AND NOT EXISTS (
              SELECT 1 FROM raw_contracts a
              WHERE a.source LIKE 'eop:%'
                -- Bare equality (not COALESCE) so idx_raw_cnum drives the seek; contract_number is
                -- guaranteed non-null by the base keep-filter, so this is identical to COALESCE(...,'')
                -- but O(n log n) instead of the O(n^2) full scan COALESCE forces on a 380k-row corpus.
                AND a.contract_number = c.contract_number
                AND COALESCE(a.unp, '') = COALESCE(c.unp, '')
                AND COALESCE(a.lot_id, '') = COALESCE(c.lot_id, '')
                AND COALESCE(a.contractor_eik, '') = COALESCE(c.contractor_eik, '')
                AND COALESCE(a.contractor_name, '') = COALESCE(c.contractor_name, '')
                AND (a.source > c.source OR (a.source = c.source AND a.id > c.id))))
         OR (c.source LIKE 'ocds:%' AND NOT EXISTS (
              SELECT 1 FROM raw_contracts a
              WHERE a.source LIKE 'eop:%'
                AND a.contract_number = c.contract_number))  -- bare = -> idx_raw_cnum (see above)
    ) z
  ) y
) x
WHERE x.display_native IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || x.unp)
  AND EXISTS (SELECT 1 FROM bidders  b  WHERE b.id  = x.bidder_key);

-- Every joint contract is linked to every real co-authority. Lead is forced to ordinal 0; the
-- remaining members retain their relative source-list order. This bridge never drives money sums.
INSERT OR IGNORE INTO contract_co_authorities (contract_id, authority_id, ordinal)
SELECT contract_id, authority_id, bridge_ordinal
FROM (
  SELECT c.id AS contract_id, m.authority_id,
    ROW_NUMBER() OVER (
      PARTITION BY c.id
      ORDER BY CASE WHEN m.authority_id = l.authority_id THEN 0 ELSE 1 END,
        m.source_ordinal, m.authority_id
    ) - 1 AS bridge_ordinal
  FROM contracts c
  JOIN joint_authority_members m ON c.tender_id = 't:' || m.unp
  JOIN joint_tender_leads l ON l.unp = m.unp
);

-- Reconciliation guard: the final summary reports the contracts inserted alongside the surviving
-- staging candidates, so a future NOT NULL/foreign-key mismatch is visible instead of hidden by
-- INSERT OR IGNORE.

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

-- 6) Location enrichment from OCDS parties (parties, populated from raw_ocds_parties).
--    Match on ЕИК; take the most-recent non-null value (parties repeat across releases). OCDS covers
--    2026+ entities, so authorities/bidders absent from OCDS keep NULL location until the Trade
--    Register loader fills the rest. No-op when parties is empty (admin-only import).
UPDATE authorities SET
  nuts       = COALESCE((SELECT p.region_nuts    FROM parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.region_nuts, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), nuts),
  settlement = COALESCE((SELECT p.locality       FROM parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.locality, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), settlement),
  address    = COALESCE((SELECT p.street_address FROM parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.street_address, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), address),
  contact_email = COALESCE((SELECT p.contact_email FROM parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.contact_email, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_email),
  contact_phone = COALESCE((SELECT p.contact_phone FROM parties p WHERE p.eik = authorities.bulstat AND NULLIF(p.contact_phone, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_phone)
WHERE EXISTS (SELECT 1 FROM parties p WHERE p.eik = authorities.bulstat);

UPDATE bidders SET
  nuts       = COALESCE((SELECT p.region_nuts    FROM parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.region_nuts, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), nuts),
  settlement = COALESCE((SELECT p.locality       FROM parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.locality, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), settlement),
  address    = COALESCE((SELECT p.street_address FROM parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.street_address, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), address),
  contact_email = COALESCE((SELECT p.contact_email FROM parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.contact_email, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_email),
  contact_phone = COALESCE((SELECT p.contact_phone FROM parties p WHERE p.eik = bidders.eik_normalized AND NULLIF(p.contact_phone, '') IS NOT NULL ORDER BY p.source DESC, COALESCE(p.ocid, '') DESC, COALESCE(p.party_id, '') DESC, COALESCE(p.name, '') DESC, COALESCE(p.street_address, '') DESC, COALESCE(p.locality, '') DESC, COALESCE(p.contact_email, '') DESC, COALESCE(p.contact_phone, '') DESC LIMIT 1), contact_phone)
WHERE EXISTS (SELECT 1 FROM parties p WHERE p.eik = bidders.eik_normalized);

-- 6b) Per-lot value enrichment from OCDS. The bridge is OCDS tender.id -> EOP tenderId
--     (raw_tenders.tender_id) -> UNP -> domain lots. ocid is a surrogate and is never
--     treated as the UNP.
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

-- 7) Region from NUTS (nuts_regions, seeded by scripts/load-nuts.sql) — labels the OCDS-sourced NUTS
--    codes and fills authorities.region (област) where empty. No-op if nuts_regions is unseeded.
UPDATE authorities SET region = (SELECT n.nuts3_name FROM nuts_regions n WHERE n.nuts3 = authorities.nuts)
WHERE authorities.nuts IS NOT NULL AND authorities.region IS NULL;

-- Freshness boundary from the served domain contract ids. Staging is work-only.
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

-- Pipeline reconciliation stats (#97): persist the eligible-candidate count (the SAME expression
-- the summary below prints) and the resulting contracts count, so the integrity gate
-- (scripts/integrity-checks.mjs) and the printed summary read ONE computation and cannot disagree.
-- ETL-internal, single row, recomputed every full rebuild; NOT shipped to the served D1
-- (ship-domain.mjs ships domain/reference tables only), so the staging-reconciliation check
-- self-skips there.
CREATE TABLE IF NOT EXISTS pipeline_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  contract_candidates INTEGER NOT NULL,
  contracts_inserted INTEGER NOT NULL,
  computed_at TEXT NOT NULL
);
DELETE FROM pipeline_stats;
INSERT INTO pipeline_stats (id, contract_candidates, contracts_inserted, computed_at)
SELECT 1,
  (SELECT COUNT(*) FROM (
    SELECT c.id
    FROM (
      SELECT c.*,
        CASE
          -- Mirrors the main derive CASE above; value_low is checked AFTER over-valuation + absurd.
          WHEN c.eff_eur > 2000000000 OR (c.proc_est_eur >= 1000 AND c.eff_eur > 200 * c.proc_est_eur) THEN 'value_suspect'
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
        c.bidder_key
      FROM (
        SELECT c.*, ci.bidder_key,
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
      -- Eligibility must mirror the INSERT INTO contracts WHERE exactly, so this candidate count is a
      -- true superset of what lands (inserted <= candidates holds by construction; the gap is only the
      -- EOP cumulative-bucket dedup). The OCDS branch deliberately has NO `contract_number IS NOT NULL`
      -- guard — the INSERT's OCDS branch keeps a null-contract_number row (NOT EXISTS over a NULL join
      -- is TRUE), so requiring it here would undercount and make a real insert look like inserted>candidates.
      WHERE c.source LIKE 'eop:%'
         OR (c.source LIKE 'ocds:%' AND NOT EXISTS (
              SELECT 1 FROM raw_contracts a
              WHERE a.source LIKE 'eop:%' AND a.contract_number = c.contract_number))
    ) c
    WHERE CASE c.value_flag
        WHEN 'annex_suspect' THEN COALESCE(c.signing_value, c.current_value)
        ELSE COALESCE(c.current_value, c.signing_value)
      END IS NOT NULL
      AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || c.unp)
      AND EXISTS (SELECT 1 FROM bidders b WHERE b.id = c.bidder_key)
  )),
  (SELECT COUNT(*) FROM contracts),
  datetime('now');

DROP TABLE contractor_identity;
DROP TABLE joint_tender_leads;
DROP TABLE unp_prefix_authorities;
DROP TABLE joint_authority_members;
DROP TABLE joint_tender_sources;

-- Summary (last result set printed by `wrangler d1 execute`)
SELECT
  (SELECT COUNT(*) FROM authorities)                              AS authorities,
  (SELECT COUNT(*) FROM tenders)                                  AS tenders,
  (SELECT COUNT(*) FROM lots)                                     AS lots,
  (SELECT COUNT(*) FROM bidders)                                  AS bidders,
  (SELECT COUNT(*) FROM bidders WHERE eik_valid = 0)              AS bidders_name_keyed,
  (SELECT COUNT(*) FROM bidders WHERE kind = 'consortium')        AS consortia,
  (SELECT COUNT(*) FROM contracts)                                AS contracts,
  (SELECT COUNT(*) FROM contract_co_authorities)                   AS joint_participations,
  (SELECT contract_candidates FROM pipeline_stats)                AS contract_candidates,
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'value_suspect') AS value_suspect,
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'annex_suspect') AS annex_suspect,
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'review')    AS review,
  (SELECT COUNT(*) FROM contracts WHERE fx_converted = 1)         AS fx_converted,
  (SELECT ROUND(SUM(amount_eur) / 1e9, 2) FROM contracts)        AS clean_total_eur_bn,
  (SELECT GROUP_CONCAT(source || ':' || COALESCE(as_of, '?') || '(' || rows || ')', ' ') FROM data_freshness) AS data_as_of;
