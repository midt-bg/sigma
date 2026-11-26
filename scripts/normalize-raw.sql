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
-- @full-clear — everything emptied between this marker and the blank line below is rebuilt from
-- staging alone, so a full derive driven by a partial window loses whatever the window misses.
-- scripts/import.mjs reads the list from here to decide whether refusing is warranted; keep new
-- DELETEs inside the block so the guard picks them up on its own.
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
DELETE FROM ocds_contract_buyers;
DELETE FROM contracts;
DELETE FROM parties;
DELETE FROM lots;
DELETE FROM synthetic_tenders_awaiting_buyer;
DELETE FROM ocds_tender_buyers;
DELETE FROM tenders;
DELETE FROM bidders;
DELETE FROM authorities;

-- @ocds-party-publication start
-- Keep supplier-role knowledge monotonic for exact source appearances. Stage the screening
-- result once so publication and authority projection use the same decision.
DELETE FROM raw_ocds_party_screening;
INSERT INTO raw_ocds_party_screening (party_row_id, evidence_status)
SELECT p.id, s.evidence_status
FROM raw_ocds_parties p
JOIN raw_supplier_evidence s ON s.eik_raw IS p.eik
WHERE p.is_supplier = 1;

INSERT OR IGNORE INTO ocds_supplier_appearances (appearance)
SELECT p.appearance
FROM raw_ocds_party_screening s JOIN raw_ocds_parties p ON p.id = s.party_row_id
WHERE s.evidence_status = 'unverified' AND p.appearance IS NOT NULL;

INSERT OR IGNORE INTO raw_ocds_party_screening (party_row_id, evidence_status)
SELECT p.id, 'unverified'
FROM raw_ocds_parties p JOIN ocds_supplier_appearances f ON f.appearance = p.appearance
WHERE p.is_supplier = 0;

INSERT OR REPLACE INTO parties (
  party_key, eik, source, ocid, party_id, name, street_address, locality, region_nuts,
  contact_email, contact_phone
)
SELECT party_key, eik, source, ocid, party_id, name, street_address, locality, region_nuts,
  contact_email, contact_phone
FROM raw_serving_ocds_parties;
DELETE FROM parties WHERE party_key IN (SELECT party_key FROM raw_ocds_party_retirements);

-- Only a buyer matched to supplier evidence loses the raw authority identifier. The safe
-- key is scoped to the OCDS procedure. It cannot collide with a legacy auth: identifier.
DELETE FROM raw_ocds_authority_moves;
DELETE FROM raw_ocds_authority_keys;
INSERT INTO raw_ocds_authority_keys (contract_row_id, authority_id)
SELECT c.id, CASE WHEN NULLIF(c.unp, '') IS NOT NULL THEN 'ocds-auth:' || lower(hex(c.unp)) END
FROM raw_contracts c
LEFT JOIN ocds_supplier_appearances f ON f.appearance = c.buyer_appearance
WHERE f.appearance IS NOT NULL OR (
  c.buyer_is_supplier = 1 AND c.buyer_appearance IS NULL AND EXISTS (
    SELECT 1 FROM raw_ocds_parties p
    JOIN raw_ocds_party_screening s ON s.party_row_id = p.id
    WHERE p.source = c.source AND p.ocid IS c.unp AND p.eik IS c.authority_eik
      AND p.is_supplier = 1 AND s.evidence_status = 'unverified'
  )
);

-- @ocds-party-publication end

-- @ocds-authority-names start
INSERT INTO authorities (id, name, bulstat)
SELECT authority_id, name, NULL FROM raw_ocds_scoped_names WHERE 1 = 1
ON CONFLICT(id) DO UPDATE SET name = excluded.name, type_group = NULL;
-- @ocds-authority-names end

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
      SELECT authority_eik, authority_name FROM raw_serving_contract_authorities WHERE authority_eik IS NOT NULL AND authority_eik NOT LIKE '%;%'
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
      FROM raw_serving_contract_authorities c
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
  -- Skip composite joint-procurement EIKs (`EIK1; EIK2`): they must not mint a standalone
  -- `auth:EIK1; EIK2` authority. Joint tenders are attributed to a single lead (joint_tender_leads)
  -- and split to individual co-authorities (contract_co_authorities); the composite is referenced by
  -- nothing, so it would only be an orphan row. Individual members still enter via their standalone
  -- occurrences and member_defaults.
  SELECT authority_eik FROM raw_serving_contract_authorities WHERE authority_eik IS NOT NULL AND authority_eik NOT LIKE '%;%'
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
  FROM raw_serving_contract_authorities
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
-- A member whose EIK still carries a ';' is a composite that the split could not decompose (unusual
-- delimiter/format). It is not a real single authority, so it must never seed a member row — otherwise
-- member_defaults mints an orphan 'auth:EIK1; EIK2' authority that nothing references. The lead is still
-- attributed via joint_tender_leads; only the (already-unusable) co-authority breakdown is skipped.
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
  SELECT SUBSTR(unp, 1, 5) AS prefix, authority_eik FROM raw_serving_contract_authorities
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
  SELECT authority_eik, authority_name FROM raw_serving_contract_authorities
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
      SELECT authority_eik, authority_type FROM raw_serving_contract_authorities
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
-- Fold procedure metadata before valuation, which uses its estimate. Record which
-- synthetic parents are new so an existing buyer owned by another source stays protected.
DELETE FROM raw_new_synthetic_tenders;
INSERT INTO raw_new_synthetic_tenders
SELECT DISTINCT 't:' || c.unp
FROM raw_contracts c
WHERE c.unp IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM tenders t WHERE t.id = 't:' || c.unp)
  AND NOT EXISTS (SELECT 1 FROM raw_tenders h WHERE h.unp = c.unp);

WITH folded AS (
  SELECT
    c.unp,
    MIN(c.procurement_subject) AS raw_title,
    COALESCE(
      (SELECT j.authority_id FROM joint_tender_leads j WHERE j.unp = c.unp),
      CASE WHEN NOT MAX(c.source LIKE 'eop:%' AND eligible.id IS NOT NULL) THEN
        MIN(CASE WHEN c.source LIKE 'ocds:%' THEN eligible.id END)
      END,
      CASE WHEN MAX(c.source LIKE 'ocds:%') THEN
        MIN(CASE WHEN c.source LIKE 'eop:%' THEN a.authority_id END)
      END,
      MIN(a.authority_id)
    ) AS authority_id,
    MIN(c.cpv_code) AS cpv_code,
    MIN(c.estimated_value) AS estimated_value,
    MIN(c.currency) AS raw_currency,
    MIN(c.contract_kind) AS contract_kind,
    MIN(c.legal_basis) AS legal_basis,
    MIN(c.award_criteria) AS award_criteria,
    MIN(NULLIF(c.tender_ext_id, '')) AS eop_tender_id  -- synthetic tenders inherit the EOP id from contracts
  FROM raw_contracts c
  JOIN raw_serving_contract_authorities a ON a.id = c.id
  LEFT JOIN authorities eligible ON eligible.id = a.authority_id
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
  eik_status TEXT NOT NULL,
  bidder_key TEXT NOT NULL,
  PRIMARY KEY (eik_raw, name_raw)
);

INSERT INTO contractor_identity (eik_raw, name_raw, name_norm, eik_clean, eik_valid, eik_status, bidder_key)
WITH suppliers AS MATERIALIZED (SELECT * FROM raw_supplier_evidence)
SELECT c.contractor_eik, c.contractor_name, c.contractor_name, s.eik, s.eik IS NOT NULL, s.evidence_status,
  CASE WHEN s.eik IS NOT NULL THEN 'eik:' || s.eik ELSE 'pending' END
FROM (
  SELECT DISTINCT contractor_eik, contractor_name FROM raw_contracts
  WHERE source LIKE 'eop:%' OR source LIKE 'ocds:%'
) c
JOIN suppliers s ON s.eik_raw IS c.contractor_eik;

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

-- 4b) Curated public-owned winner classification. Exact EIK matches cover the allowlist. A valid 13-digit
-- EIK is a branch: the first nine digits are the enterprise it belongs to, so a branch of a listed
-- enterprise (a forestry unit of a state forestry company, a regional station of the national radio, a
-- regional branch of the irrigation company) carries the enterprise's ownership. Private look-alikes stay
-- absent from the seed table and therefore remain NULL.
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
      OR (length(bidders.eik_normalized) = 13 AND substr(bidders.eik_normalized, 1, 9) = s.eik)
    )
  LIMIT 1
);

-- Public ownership the Trade Register records (ADR-0047), derived by the registry workflow, for a company the
-- curated list does not name.
CREATE TABLE IF NOT EXISTS public_owned_eik (
  eik TEXT PRIMARY KEY,
  ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('state', 'municipal'))
);

UPDATE bidders
SET ownership_kind = (
  SELECT p.ownership_kind FROM public_owned_eik p
  WHERE p.eik = CASE WHEN length(bidders.eik_normalized) = 13 THEN substr(bidders.eik_normalized, 1, 9)
                     ELSE bidders.eik_normalized END
)
WHERE ownership_kind IS NULL AND eik_valid = 1
  AND (eik_normalized IN (SELECT eik FROM public_owned_eik)
       OR (length(eik_normalized) = 13 AND substr(eik_normalized, 1, 9) IN (SELECT eik FROM public_owned_eik)));

-- 5) Contracts — price the staging rows, then apply the existing feed and identity precedence.
DELETE FROM raw_contract_value_annexes;
INSERT INTO raw_contract_value_annexes SELECT * FROM raw_contract_value_staged_annexes;

-- Stage the native amounts and their currencies for the shared valuation rule.
DELETE FROM raw_contract_value_inputs;
INSERT INTO raw_contract_value_inputs
WITH amendment_winner AS (
  SELECT unp, contract_number, currency, natural_key,
    ROW_NUMBER() OVER (
      PARTITION BY unp, contract_number ORDER BY published_at DESC, natural_key DESC
    ) AS win_rn
  FROM raw_contract_value_annexes
  WHERE effective_after IS NOT NULL
)
SELECT c.id, c.unp, c.contract_number, c.contract_date, c.signing_value, c.currency, c.current_value, aw.currency,
  t.estimated_value, t.currency, c.estimated_value, c.procurement_currency,
  CASE WHEN c.framework_contract = 1 THEN 1 WHEN c.framework_notice = 1 THEN 2 END,
  0, NULL, aw.natural_key
FROM raw_contracts c
LEFT JOIN tenders t ON t.id = 't:' || c.unp
LEFT JOIN amendment_winner aw
  ON aw.unp = c.unp AND aw.contract_number = c.contract_number AND aw.win_rn = 1
WHERE c.source LIKE 'eop:%' OR c.source LIKE 'ocds:%';
DROP TABLE IF EXISTS raw_contract_value_results;
CREATE TABLE raw_contract_value_results AS SELECT * FROM raw_contract_values;
CREATE UNIQUE INDEX idx_raw_contract_value_results ON raw_contract_value_results(id);

-- Share the admitted rows with buyer selection. Preserve full rebuild's publication ranking.
DELETE FROM raw_contract_admissions;
INSERT INTO raw_contract_admissions (raw_id, contract_id, bidder_id, amount, lot_id)
SELECT x.id,
  CASE WHEN x.source LIKE 'eop:%' THEN 'c:e:' ELSE 'c:o:' END ||
    COALESCE(x.unp, '') || ':' || COALESCE(x.contract_number, '') || ':' ||
    COALESCE(NULLIF(CASE WHEN x.source LIKE 'eop:%' THEN x.lot_norm ELSE x.lot_id END, ''), '_') ||
    ':' || x.bidder_key || ':' || x.contract_ordinal,
  x.bidder_key, x.amount,
  CASE WHEN x.lot_id IS NOT NULL AND TRIM(x.lot_id) <> ''
    THEN 'lot:' || x.unp || ':' || x.lot_norm END
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
    SELECT c.id, c.unp, c.source, c.contract_number, c.lot_id, c.signing_value, c.contract_date,
      c.document_number, ci.bidder_key,
      v.amount,
      CASE
        WHEN c.lot_id LIKE 'LOT-%' AND REPLACE(c.lot_id, 'LOT-', '') <> '' AND REPLACE(c.lot_id, 'LOT-', '') NOT GLOB '*[^0-9]*' THEN CAST(REPLACE(c.lot_id, 'LOT-', '') AS INTEGER)
        WHEN c.lot_id <> '' AND c.lot_id NOT GLOB '*[^0-9]*' THEN CAST(c.lot_id AS INTEGER)
        ELSE c.lot_id
      END AS lot_norm
    FROM raw_contract_publications c
    JOIN contractor_identity ci
      ON c.contractor_eik IS ci.eik_raw AND c.contractor_name IS ci.name_raw
    JOIN raw_contract_value_results v ON v.id = c.id
  ) z
) x
WHERE x.amount IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || x.unp)
  AND EXISTS (SELECT 1 FROM bidders  b  WHERE b.id  = x.bidder_key);

DELETE FROM raw_contract_buyer_tenders;
DELETE FROM raw_previous_ocds_contract_buyers;

WITH incomplete_signings AS MATERIALIZED (SELECT * FROM raw_incomplete_signing_keys)
INSERT OR IGNORE INTO contracts
  (id, tender_id, bidder_id, ordering_unit_name, amount, currency, signed_at,
   contract_number, signing_value, current_value, current_value_currency, annex_count, eu_funded, bids_received,
   contract_kind, awarded_to_group, value_flag, date_flag, amount_eur, fx_converted, fx_rate,
   signing_value_eur, current_value_eur,
   lot_id, document_number, published_at, contract_subject,
   eu_programme, duration_days, winner_size, contractor_country,
   bids_sme, bids_rejected, bids_non_eea,
   subcontractor_eik, subcontractor_name, subcontract_value,
   eauction, framework, accelerated, strategic, own_estimate_source, own_estimate_value, own_estimate_currency,
   signing_currency_raw, signing_contractor_eik, signing_contractor_status, ocds_signing_incomplete)
SELECT
  p.contract_id,
  't:' || x.unp,
  p.bidder_id,
  NULLIF(TRIM(a.authority_name), ''),
  p.amount,
  COALESCE(x.currency, 'BGN'),
  x.contract_date,
  x.contract_number,
  x.signing_value,
  x.current_value,
  v.current_value_currency,
  COALESCE(x.annex_count, 0),
  x.eu_funded,
  x.bids_received,
  x.contract_kind,
  x.awarded_to_group,
  v.value_flag,
  CASE WHEN x.contract_date IS NOT NULL AND x.published_at IS NOT NULL
    AND x.contract_date > date(x.published_at, '+2 day') THEN 'signed_after_publication' ELSE 'ok' END,
  v.amount_eur, v.fx_converted, v.fx_rate,
  v.signing_value_eur, v.current_value_eur,
  p.lot_id,
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
  CASE WHEN x.framework_contract = 1 THEN 1 WHEN x.framework_notice = 1 THEN 2 END,
  x.accelerated,
  x.strategic,
  x.source,
  x.estimated_value,
  x.procurement_currency,
  x.currency,
  ci.eik_clean,
  ci.eik_status,
  COALESCE(s.incomplete, 0)
FROM raw_contract_admissions p
JOIN raw_contracts x ON x.id = p.raw_id
JOIN raw_serving_contract_authorities a ON a.id = x.id
JOIN raw_contract_value_results v ON v.id = x.id
JOIN contractor_identity ci ON x.contractor_eik IS ci.eik_raw AND x.contractor_name IS ci.name_raw
LEFT JOIN incomplete_signings s ON s.unp = x.unp AND s.contract_number = x.contract_number;

-- @ocds-buyer-selection start
INSERT OR IGNORE INTO raw_contract_buyer_tenders (tender_id)
SELECT tender_id FROM raw_new_synthetic_tenders
UNION
SELECT c.tender_id FROM raw_contract_admissions p JOIN contracts c ON c.id = p.contract_id;

-- A same-key readmission can replay an older appearance. Keep the best evidence for
-- that key while it survives. A deleted contract that is not readmitted loses its evidence.
WITH candidates AS (
  SELECT contract_id, appearance, source, a.authority_id, 1 AS incoming
  FROM raw_contract_buyer_candidates a
  JOIN raw_open_synthetic_buyers t ON t.tender_id = a.tender_id
  WHERE a.source LIKE 'ocds:%'
  UNION ALL
  SELECT b.contract_id, b.appearance, b.source, b.authority_id, 0 AS incoming
  FROM raw_previous_ocds_contract_buyers b JOIN contracts c ON c.id = b.contract_id
  JOIN raw_open_synthetic_buyers t ON t.tender_id = c.tender_id
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY contract_id
    ORDER BY source DESC, COALESCE(appearance, '') DESC,
      CASE WHEN appearance IS NOT NULL THEN incoming END, authority_id
  ) AS rank
  FROM candidates
)
INSERT INTO ocds_contract_buyers (contract_id, appearance, source, authority_id)
SELECT contract_id, appearance, source, authority_id FROM ranked WHERE rank = 1
ON CONFLICT(contract_id) DO NOTHING;

-- Rank the remaining admitted signings, including those outside this window. A
-- published EOP signing takes precedence. A removed winner supplies no candidate.
DELETE FROM raw_ocds_tender_selections;
WITH candidates AS (
  SELECT t.tender_id, b.authority_id, b.source, b.appearance
  FROM raw_open_synthetic_buyers t
  CROSS JOIN contracts c ON c.tender_id = t.tender_id
  CROSS JOIN ocds_contract_buyers b ON b.contract_id = c.id
  UNION ALL
  SELECT a.tender_id, a.authority_id, NULL, NULL
  FROM raw_contract_buyer_candidates a
  JOIN raw_open_synthetic_buyers t ON t.tender_id = a.tender_id
  WHERE a.source LIKE 'eop:%'
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY tender_id
    ORDER BY source IS NULL DESC, source DESC, COALESCE(appearance, '') DESC, authority_id
  ) AS rank
  FROM candidates
)
INSERT INTO raw_ocds_tender_selections (tender_id, authority_id, old_authority_id, source, appearance)
SELECT t.tender_id, r.authority_id, t.authority_id, r.source, r.appearance
FROM raw_open_synthetic_buyers t LEFT JOIN ranked r ON r.tender_id = t.tender_id AND r.rank = 1;
-- @ocds-buyer-selection end

UPDATE raw_ocds_tender_selections
SET authority_id = j.authority_id
FROM joint_tender_leads j
WHERE raw_ocds_tender_selections.tender_id = 't:' || j.unp
  AND raw_ocds_tender_selections.source IS NULL
  AND raw_ocds_tender_selections.authority_id IS NOT NULL;

-- @ocds-buyer-update start
UPDATE tenders
SET authority_id = s.authority_id
FROM raw_ocds_tender_selections s
WHERE tenders.id = s.tender_id AND tenders.authority_id <> s.authority_id;
-- @ocds-buyer-update end

-- @ocds-buyer-binding start
-- An EOP takeover closes the synthetic procedure to OCDS evidence. With no eligible
-- signing left, keep the parent metadata and let a future admission choose a buyer.
DELETE FROM ocds_contract_buyers
WHERE contract_id IN (
  SELECT c.id FROM raw_ocds_tender_selections s CROSS JOIN contracts c ON c.tender_id = s.tender_id
  WHERE s.source IS NULL AND s.authority_id IS NOT NULL
);
DELETE FROM ocds_tender_buyers
WHERE tender_id IN (SELECT tender_id FROM raw_ocds_tender_selections WHERE source IS NULL);

INSERT INTO ocds_tender_buyers (tender_id, appearance, source, authority_id)
SELECT tender_id, appearance, source, authority_id
FROM raw_ocds_tender_selections WHERE source IS NOT NULL
ON CONFLICT(tender_id) DO UPDATE SET
  appearance = excluded.appearance, source = excluded.source, authority_id = excluded.authority_id;
DELETE FROM synthetic_tenders_awaiting_buyer
WHERE tender_id IN (SELECT tender_id FROM raw_ocds_tender_selections WHERE authority_id IS NOT NULL);

INSERT OR IGNORE INTO synthetic_tenders_awaiting_buyer (tender_id)
SELECT tender_id FROM raw_ocds_tender_selections WHERE authority_id IS NULL;
-- @ocds-buyer-binding end

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

-- 5z) The parties to a framework agreement. An agreement concluded with several suppliers names them all
--     in one contractor field („А; Б; В"), which 4a reads as a joint bidder. They are the agreement's
--     parties, who then compete for each order placed under it — not one bidder that won together. A
--     contractor whose every contract is such an agreement record is marked as its parties, so it is
--     never shown or linked as an обединение (refresh-slice.sql keeps the same rule).
UPDATE bidders SET kind = 'framework_parties'
WHERE kind = 'consortium' AND name LIKE '%;%'
  AND EXISTS (SELECT 1 FROM contracts c WHERE c.bidder_id = bidders.id AND c.framework = 2)
  AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.bidder_id = bidders.id AND c.framework IS NOT 2);

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
  (SELECT COUNT(*)
   FROM raw_contracts c
   JOIN contractor_identity ci
     ON c.contractor_eik IS ci.eik_raw AND c.contractor_name IS ci.name_raw
   JOIN raw_contract_value_results v ON v.id = c.id
   WHERE v.amount IS NOT NULL
     AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || c.unp)
     AND EXISTS (SELECT 1 FROM bidders b WHERE b.id = ci.bidder_key)
     -- Same eligibility as the INSERT, before discarding cumulative EOP duplicates.
     AND (c.source LIKE 'eop:%' OR (c.source LIKE 'ocds:%' AND NOT EXISTS (
       SELECT 1 FROM raw_contracts a WHERE a.source LIKE 'eop:%'
         AND a.contract_number = c.contract_number
     )))
  ),
  (SELECT COUNT(*) FROM contracts),
  datetime('now');

DELETE FROM raw_previous_ocds_contract_buyers;
DELETE FROM raw_contract_buyer_tenders;
DELETE FROM raw_contract_admissions;
DELETE FROM raw_new_synthetic_tenders;
DROP TABLE raw_contract_value_results;
DELETE FROM raw_contract_value_inputs;
DELETE FROM raw_contract_value_annexes;

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
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'annex_total_suspect') AS annex_total_suspect,
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'review')    AS review,
  (SELECT COUNT(*) FROM contracts WHERE fx_converted = 1)         AS fx_converted,
  (SELECT ROUND(SUM(amount_eur) / 1e9, 2) FROM contracts)        AS clean_total_eur_bn,
  (SELECT GROUP_CONCAT(source || ':' || COALESCE(as_of, '?') || '(' || rows || ')', ' ') FROM data_freshness) AS data_as_of;
