-- Свързани лица (related-persons / conflict-of-interest) domain — CACBG declarations resolved to
-- contract winners. See docs/spec/related-persons-foundation.md and docs/adr/0001..0009.
--
-- Publish rule = certainty 1.0: a link is 'published' only when the resolution is deterministic
-- (single normalized key → single valid ЕИК in the winner set, publish_tier A|B; ADR-0009). Ambiguous
-- links stay 'held'. Every link carries full provenance. Third-party people live in a separate,
-- internal-only table (ADR-0010) and are never joined into the published surface.

-- Public officials who filed declarations. No national person id (ЕГН is stripped, ADR-0010), so a
-- person is keyed by (normalized name, normalized institution) — NEVER a bare name (ADR-0026): two
-- namesakes at different institutions stay distinct, so no homonym merge into one page. register_year and
-- position are excluded so a person is stable across their filing years (the E11 divestment horizon keys
-- on person_id and must span them). The residual same-name+same-institution collision is documented.
CREATE TABLE IF NOT EXISTS persons (
  id           TEXT PRIMARY KEY,            -- 'person:' || key(name) || '|' || key(institution)
  name         TEXT NOT NULL,               -- declarant full name as filed
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per filed declaration (natural key xml_file + control_hash makes re-import idempotent).
CREATE TABLE IF NOT EXISTS declarations (
  id            TEXT PRIMARY KEY,           -- 'decl:' || xml_file
  person_id     TEXT NOT NULL REFERENCES persons(id),
  xml_file      TEXT NOT NULL,
  control_hash  TEXT,                       -- source integrity hash; re-import key with xml_file
  folder_year   TEXT NOT NULL,              -- register folder (publication year)
  declared_year TEXT,                       -- year the declaration itself reports (NOT the folder; off-by-one)
  template      TEXT NOT NULL,              -- 'assets' | 'interests'
  category      TEXT,                       -- CACBG category (e.g. Народни представители)
  institution   TEXT,                       -- the body the official serves in
  position      TEXT,                       -- declared position
  source_url    TEXT NOT NULL,              -- register.cacbg.bg/<folder>/<xml_file> — provenance
  UNIQUE (xml_file, control_hash)
);
-- Per-person lookup: audit.mjs scans a person's declarations, and LINK_SELECT's source_url subquery
-- filters declarations by person_id — without this it's a full scan of the table.
CREATE INDEX IF NOT EXISTS idx_declarations_person ON declarations(person_id);

-- One row per company-bearing declared interest (the declarant's OWN interests only; ADR-0010/0013).
CREATE TABLE IF NOT EXISTS declared_interests (
  id             TEXT PRIMARY KEY,          -- 'di:' || decl id || ':' || ordinal
  declaration_id TEXT NOT NULL REFERENCES declarations(id),
  entity_raw     TEXT NOT NULL,             -- company name exactly as declared
  entity_key     TEXT NOT NULL,             -- companyNameKey(entity_raw) — the deterministic match key
  kind           TEXT NOT NULL,             -- shares | participation | management | sole_trader
  detail         TEXT,                      -- stake % / role (управител, член на УС) / ЕТ subject
  timing         TEXT NOT NULL DEFAULT 'annual', -- annual | current | prior (appointment-relative)
  seat           TEXT                       -- declared седалище (asset decls only; sparse)
);
CREATE INDEX IF NOT EXISTS idx_declared_interests_key ON declared_interests(entity_key);
CREATE INDEX IF NOT EXISTS idx_declared_interests_decl ON declared_interests(declaration_id);

-- The resolved match: a person↔winner ЕИК link, aggregated across that person's declarations (annual
-- re-filings collapse to one link). Per-row evidence stays in declared_interests, joinable by person +
-- entity_key. `link_key` is the stable natural key the suppression list and re-imports key on.
CREATE TABLE IF NOT EXISTS interest_links (
  id                TEXT PRIMARY KEY,       -- 'il:' || link_key
  link_key          TEXT NOT NULL UNIQUE,   -- person_id || '|' || eik  (suppression + idempotent re-import)
  person_id         TEXT NOT NULL REFERENCES persons(id),
  bidder_id         TEXT NOT NULL REFERENCES bidders(id),
  eik               TEXT NOT NULL,          -- eik_normalized of the matched winner
  entity_key        TEXT NOT NULL,          -- the normalized declared name that resolved
  match_method      TEXT NOT NULL DEFAULT 'exact_name_key',
  matcher_version   TEXT NOT NULL,          -- companyNameKey/classify version — reproducibility
  publish_tier      TEXT NOT NULL,          -- A_seat | B_distinctive | C_hold (ADR-0009/0015)
  relation          TEXT NOT NULL,          -- owns | manages | owns+manages | related — ADR-0014
  -- interpretation class for the published surface (ADR-0019/0022). Separates genuine PRIVATE financial
  -- interest from EX-OFFICIO public-board roles so the headline can't defame appointed civil servants:
  --   private_ownership — self, relation owns/owns+manages (declared a stake): the real conflict signal
  --   family_ownership  — a CLOSE RELATIVE's declared stake (relation related). Official + company + value
  --                       shown; the relative is anonymized as „свързано лице" (name never stored) — ADR-0023
  --   ex_officio_board  — self, relation manages AND ≥2 distinct officials declared the same company
  --                       (a rotating/multi-member board = a public body, not a private interest)
  --   management_role   — self, relation manages, a single declarant (ambiguous: private manager or small board)
  -- Materiality: only CLOSELY-HELD forms (ООД/ЕООД/ЕТ/…) reach ownership classes; listed АД/ЕАД securities
  -- and management-only roles never become private_ownership/family_ownership (ADR-0022).
  interest_class    TEXT NOT NULL DEFAULT 'private_ownership',
  contemporaneous   INTEGER NOT NULL DEFAULT 0,
  own_institution   TEXT NOT NULL DEFAULT 'none', -- exact (deterministic) | locality (heuristic) | none
  evidence_count    INTEGER NOT NULL DEFAULT 1,   -- # declared_interests supporting this link
  first_declared_year TEXT,
  last_declared_year  TEXT,
  -- contract facts for the linked winner (deterministic; amount_eur is the SAFE-to-sum canonical value,
  -- value_suspect contracts excluded). Quantifies how much public money the official's company received.
  contract_count      INTEGER NOT NULL DEFAULT 0,
  contract_value_eur  REAL,                        -- SUM(contracts.amount_eur); NULL if none summable
  first_contract_year TEXT,
  last_contract_year  TEXT,
  status            TEXT NOT NULL DEFAULT 'held', -- published (public surface: private/family ownership) | internal (non-surfaced class) | held | withdrawn | suppressed
  verified_by       TEXT,
  verified_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_interest_links_eik ON interest_links(eik);
CREATE INDEX IF NOT EXISTS idx_interest_links_status ON interest_links(status);
CREATE INDEX IF NOT EXISTS idx_interest_links_person ON interest_links(person_id);

-- Per-buying-authority breakdown for each link: which public bodies bought from the official's company,
-- how much, and whether the body is the official's OWN institution (the strongest conflict signal).
-- Authority `name` in the winner data is sometimes a ';'-joined framework blob — split into components.
CREATE TABLE IF NOT EXISTS interest_link_authorities (
  link_key       TEXT NOT NULL REFERENCES interest_links(link_key),
  authority_id   TEXT NOT NULL REFERENCES authorities(id),
  authority_name TEXT NOT NULL,             -- the matched name component
  contract_count INTEGER NOT NULL DEFAULT 0,
  value_eur      REAL,
  own            TEXT NOT NULL DEFAULT 'none', -- exact (deterministic) | locality (heuristic) | none
  PRIMARY KEY (link_key, authority_id)
);
CREATE INDEX IF NOT EXISTS idx_ila_authority ON interest_link_authorities(authority_id);

-- Contested/corrected links that MUST stay removed across refreshes (ADR-0007 correction path).
CREATE TABLE IF NOT EXISTS link_suppressions (
  link_key      TEXT PRIMARY KEY,           -- matches interest_links.link_key
  reason        TEXT NOT NULL,
  suppressed_by TEXT NOT NULL,
  suppressed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Declared THIRD-PARTY people (interests tables 21/22). PII → INTERNAL only (ADR-0010): never joined
-- into published surfaces; masked on every output format. Feeds only the internal свързани-лица graph.
CREATE TABLE IF NOT EXISTS related_persons_internal (
  id             TEXT PRIMARY KEY,          -- 'rp:' || decl id || ':' || ordinal
  declaration_id TEXT NOT NULL REFERENCES declarations(id),
  related_name   TEXT NOT NULL,             -- third-party name — masked at every surface
  related_kind   TEXT NOT NULL,             -- related_person | related_contract
  info           TEXT,                      -- declared area/subject
  timing         TEXT NOT NULL DEFAULT 'current'
);
