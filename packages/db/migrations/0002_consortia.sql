-- Sigma — consortium / обединение model.
--
-- Many awarded "contractors" are joint ventures (ДЗЗД / ОБЕДИНЕНИЕ / КОНСОРЦИУМ).
-- They usually carry their OWN ЕИК but stand for several member companies. We keep
-- the contract awarded to the consortium entity and record its members separately,
-- so beneficiary and cartel / related-party analysis can attribute participation to
-- the real companies.
--
-- Members are populated by scripts/normalize-aop.sql: directly when the ЕИК field
-- lists several ids; the common case (members hidden behind a single consortium ЕИК)
-- needs the Търговски регистър / БУЛСТАТ open data joined on ЕИК — a later pipeline.

ALTER TABLE bidders ADD COLUMN kind TEXT NOT NULL DEFAULT 'company'; -- 'company' | 'consortium'

CREATE TABLE IF NOT EXISTS bidder_members (
  consortium_id TEXT NOT NULL REFERENCES bidders(id),
  member_eik    TEXT NOT NULL,                 -- normalized ЕИК of a participant company
  member_id     TEXT REFERENCES bidders(id),   -- linked bidder row when the member also bids/wins itself
  share_pct     REAL,                          -- documented share if known, else NULL (never invented)
  source        TEXT NOT NULL,                 -- 'in_field' | 'bulstat' | 'tr' | 'name_match'
  PRIMARY KEY (consortium_id, member_eik)
);
CREATE INDEX IF NOT EXISTS idx_bidder_members_member ON bidder_members(member_eik);

-- Explodes contracts to the participating companies. A sole winner yields one row;
-- a resolved consortium yields one row per member; an unresolved consortium yields
-- the consortium entity itself (the `role` column says which).
--
-- `allocated_amount` splits each contract's value across its participants so it is
-- ALWAYS safe to SUM — at any grouping (per company / person / grand total), with no
-- dedupe. A sole winner or unresolved consortium carries the full value on one row
-- (is_estimated_split = 0); resolved members get an equal split (amount / member_count,
-- is_estimated_split = 1) until documented shares (bidder_members.share_pct) replace it.
-- For the full headline contract value, read contracts.amount.
CREATE VIEW IF NOT EXISTS contract_participants AS
SELECT
  c.id            AS contract_id,
  c.tender_id     AS tender_id,
  bm.member_eik   AS participant_eik,
  'member'        AS role,
  c.amount / mc.n AS allocated_amount,
  mc.n            AS member_count,
  1               AS is_estimated_split
FROM contracts c
JOIN bidders b ON b.id = c.bidder_id AND b.kind = 'consortium'
JOIN bidder_members bm ON bm.consortium_id = c.bidder_id
JOIN (SELECT consortium_id, COUNT(*) AS n FROM bidder_members GROUP BY consortium_id) mc
  ON mc.consortium_id = c.bidder_id
UNION ALL
SELECT
  c.id,
  c.tender_id,
  b.eik_normalized,
  CASE WHEN b.kind = 'consortium' THEN 'consortium_unresolved' ELSE 'sole' END,
  c.amount,
  1,
  0
FROM contracts c
JOIN bidders b ON b.id = c.bidder_id
WHERE NOT (b.kind = 'consortium'
           AND EXISTS (SELECT 1 FROM bidder_members bm WHERE bm.consortium_id = c.bidder_id));
