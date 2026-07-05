-- Sigma — curated canonical names for procurement authorities (възложители), keyed by ЕИК.
-- Loaded before normalize/refresh (see scripts/import.mjs). The normalize step derives a canonical
-- display name for every ЕИК by FREQUENCY MODE (the most-recorded name variant); this table is the
-- authoritative OVERRIDE for the cases where the mode is still wrong or undesirable — most importantly
-- SHARED-ЕИК bodies whose second-order spending units carry their own composite names in the raw feed
-- (e.g. a foreign Bulgarian school that legally has no own ЕИК and spends under the ministry's).
--
-- Why an override instead of registry lookup: budgetary bodies (ministries, agencies) are frequently
-- ABSENT from the Търговски регистър, and the admin-register pipeline (raw_tr_companies) is parked
-- (see docs/etl.md). Until it lands, a small hand-verified allowlist gives authoritative names for the
-- high-value cases. Keyed by ЕИК so the change is LABEL-ONLY — the authority id (`auth:'||ЕИК`) and the
-- profile URL stay stable (packages/db/src/queries/identity.ts). See docs/adr/0007-authority-canonical-name.md.

CREATE TABLE IF NOT EXISTS authority_name_overrides (
  eik            TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  note           TEXT              -- why the mode is overridden; free-text, for auditability
);

DELETE FROM authority_name_overrides;

INSERT INTO authority_name_overrides (eik, canonical_name, note) VALUES
  -- #194: МОН shares its ЕИК with the second-order spending unit БСУ „Д-р Петър Берон" (Прага), a
  -- Bulgarian school abroad with no own ЕИК. MIN() picked the school (Б before М in Cyrillic);
  -- frequency mode already recovers the ministry (620 договорни реда / 444 обявления), but this pins it.
  ('000695114', 'Министерство на образованието и науката',
   '#194 споделен ЕИК с второстепенен разпоредител БСУ „Д-р Петър Берон", Прага');
