-- Deterministic domain fixture for the Playwright E2E lane (#95).
--
-- The dev/CI smoke seed (scripts/seed.sql) only fills the RAW ingest tables and deliberately does not
-- feed the ETL, so the explorer's domain `contracts` table stays empty and every list/detail/search
-- page renders nothing. Rather than run the full EOP import (needs the downloaded feed), this fixture
-- inserts a small set of raw entities + domain `contracts` directly, then scripts/precompute.sql
-- derives every rollup and the FTS search index from them — the same read model production serves.
--
-- Synthetic values only: amounts, dates and CPV codes are illustrative and NOT production-shaped.
-- 20 contracts (> PAGE_SIZE.contracts = 15) so the list paginates.

-- Authorities (domain ids follow the 'auth:' || ЕИК convention).
INSERT OR IGNORE INTO authorities (id, name, bulstat, region, type_group, settlement) VALUES
  ('auth:000696327', 'Община София', '000696327', 'BG411', 'община', 'София'),
  ('auth:831661388', 'Министерство на регионалното развитие', '831661388', 'BG411', 'министерство', 'София');

-- Winning bidders (valid 9-digit ЕИК so eik_valid = 1).
INSERT OR IGNORE INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
  ('eik:111111111', 'Алфа ЕООД', '111111111', '111111111', 1, 'company'),
  ('eik:222222222', 'Бета АД', '222222222', '222222222', 1, 'company'),
  ('eik:333333333', 'Гама ООД', '333333333', '333333333', 1, 'company');

-- 20 awarded tenders, cycling authority / CPV division / procedure_type so the year/procedure/EU
-- facets and the sector rollup all get non-trivial buckets.
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20)
INSERT OR IGNORE INTO tenders
  (id, source_id, title, authority_id, cpv_code, procedure_type, status, published_at)
SELECT
  't:E2E-' || printf('%04d', n),
  'AOP-E2E-' || printf('%04d', n),
  'Договор за '
    || CASE n % 4
         WHEN 0 THEN 'доставка на оборудване'
         WHEN 1 THEN 'строителни дейности'
         WHEN 2 THEN 'консултантски услуги'
         ELSE 'софтуерна поддръжка'
       END
    || ' №' || n,
  CASE n % 2 WHEN 0 THEN 'auth:000696327' ELSE 'auth:831661388' END,
  CASE n % 4 WHEN 0 THEN '30000000' WHEN 1 THEN '45000000' WHEN 2 THEN '79000000' ELSE '72000000' END,
  CASE n % 3 WHEN 0 THEN 'открита процедура' WHEN 1 THEN 'публично състезание' ELSE 'директно възлагане' END,
  'awarded',
  date('2024-01-01', '+' || (n * 7) || ' days')
FROM seq;

-- One clean, summable contract per tender.
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20)
INSERT OR IGNORE INTO contracts
  (id, tender_id, bidder_id, amount, currency, signed_at, amount_eur, value_flag, eu_funded)
SELECT
  'c:E2E-' || printf('%04d', n),
  't:E2E-' || printf('%04d', n),
  CASE n % 3 WHEN 0 THEN 'eik:111111111' WHEN 1 THEN 'eik:222222222' ELSE 'eik:333333333' END,
  (100000 + n * 50000) * 1.0,
  'BGN',
  date('2024-01-05', '+' || (n * 7) || ' days'),
  ROUND((100000 + n * 50000) / 1.95583, 2), -- BGN→EUR at the fixed peg
  'ok',
  CASE n % 2 WHEN 0 THEN 1 ELSE 0 END
FROM seq;

-- Freshness row the UI reads for its "данни към" line (precompute sets home_totals.as_of, but the
-- per-feed freshness table is normally filled by normalize-raw, which we skip here).
INSERT OR REPLACE INTO data_freshness (source, as_of, rows, refreshed_at)
VALUES ('admin', date('now'), 20, datetime('now'));
