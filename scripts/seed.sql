-- Sample data for local development. Idempotent (INSERT OR IGNORE).
-- Dev-only smoke seed: these ids/statuses do not exercise the production identity keys or rollup
-- conventions used by the admin/OCDS normalization pipeline.

INSERT OR IGNORE INTO authorities (id, name, bulstat, region) VALUES
  ('auth-sofia', 'Община София', '000696327', 'София-град'),
  ('auth-mrrb', 'Министерство на регионалното развитие', '831661388', 'София-град');

INSERT OR IGNORE INTO tenders
  (id, source_id, title, authority_id, cpv_code, estimated_value, currency, procedure_type, status, published_at, deadline_at)
VALUES
  ('demo-tender', 'AOP-2026-0001', 'Доставка на хранителни продукти за детски градини', 'auth-sofia', '15000000', 1200000, 'BGN', 'открита процедура', 'published', '2026-03-01', '2026-04-01'),
  ('t-build-01', 'AOP-2026-0002', 'Ремонт на общински път', 'auth-mrrb', '45000000', 3500000, 'BGN', 'открита процедура', 'evaluation', '2026-02-15', '2026-03-20');

INSERT OR IGNORE INTO bidders (id, name, bulstat) VALUES
  ('bidder-a', 'Алфа ЕООД', '111111111'),
  ('bidder-b', 'Бета АД', '222222222'),
  ('bidder-c', 'Гама ООД', '333333333');

-- ── свързани лица (conflict-of-interest) smoke fixture ────────────────────────────────────────────
-- Without these the /conflicts routes render an empty surface locally, so the whole feature is
-- unverifiable in a browser. Every person and company below is INVENTED — no real declarant, no real
-- winner. The ЕИК pass the real 9-digit checksum (scripts/normalize-raw.sql's eik_valid), so the
-- fixture cannot teach a wrong ЕИК shape to anyone reading it.
--
-- The rows are shaped by what the read gate actually requires (packages/db/src/queries/related-persons.ts):
--   • status='published' AND interest_class IN (private_ownership, family_ownership)  — SURFACED_OWNERSHIP
--   • a LIVE contract for that ЕИК                                                     — the read-time zero-contract gate
--   • signed_at inside [first_declared_year, last_declared_year]                       — IN_WINDOW ⇒ the „в периода" chip
--   • no published SELF stake on the same (official, ЕИК) for a family row             — NOT_REDUNDANT_FAMILY
--   • a Trade Register evidence seal of a PUBLISHING rung                              — the #279 seal gate
-- One link per outcome, including the non-surfaced ones, so a change to the publishing rule is
-- visible as a before/after rather than as an empty page either way.

INSERT OR IGNORE INTO authorities (id, name, bulstat, region) VALUES
  ('auth-plovdiv', 'Община Пример', '131223340', 'Пловдив');

INSERT OR IGNORE INTO tenders
  (id, source_id, title, authority_id, cpv_code, estimated_value, currency, procedure_type, status, published_at, deadline_at)
VALUES
  ('t-conflict-01', 'AOP-2022-0101', 'Строителен надзор на общински обекти', 'auth-plovdiv', '71520000', 900000, 'BGN', 'открита процедура', 'closed', '2022-01-10', '2022-02-10'),
  ('t-conflict-02', 'AOP-2022-0102', 'Консултантски услуги по проект', 'auth-sofia', '79400000', 400000, 'BGN', 'открита процедура', 'closed', '2022-04-05', '2022-05-05'),
  ('t-conflict-03', 'AOP-2022-0103', 'Доставка на офис оборудване', 'auth-mrrb', '30190000', 250000, 'BGN', 'открита процедура', 'closed', '2022-06-01', '2022-07-01');

-- eik_valid=1 so these behave like resolved winners; settlement feeds the seat-confirmation rung.
INSERT OR IGNORE INTO bidders (id, name, bulstat, eik_normalized, eik_valid, legal_form, settlement) VALUES
  ('eik:201122335', 'АЛФА СТРОЙ ООД', '201122335', '201122335', 1, 'ООД', 'Пловдив'),
  ('eik:203445566', 'БЕТА КОНСУЛТ ЕООД', '203445566', '203445566', 1, 'ЕООД', 'София'),
  ('eik:204556676', 'ГАМА ИНВЕСТ АД', '204556676', '204556676', 1, 'АД', 'Варна');

INSERT OR IGNORE INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur) VALUES
  ('c-conflict-01', 't-conflict-01', 'eik:201122335', 840000, 'BGN', '2022-03-14', 'Д-2022-101', 429000),
  ('c-conflict-02', 't-conflict-02', 'eik:203445566', 372000, 'BGN', '2022-06-20', 'Д-2022-102', 190000),
  ('c-conflict-03', 't-conflict-03', 'eik:204556676', 236000, 'BGN', '2022-08-02', 'Д-2022-103', 120000);

-- person id = 'person:' || key(name) || '|' || key(institution) — (name, institution), never a bare
-- name (ADR-0026), so two namesakes at different bodies stay distinct.
INSERT OR IGNORE INTO persons (id, name) VALUES
  ('person:ИВАН ПЕТРОВ ТЕСТОВ|ОБЩИНА ПРИМЕР', 'Иван Петров Тестов'),
  ('person:МАРИЯ ГЕОРГИЕВА ОБРАЗЦОВА|ОБЩИНА СОФИЯ', 'Мария Георгиева Образцова');

INSERT OR IGNORE INTO declarations
  (id, person_id, xml_file, control_hash, folder_year, declared_year, template, category, institution, position, source_url)
VALUES
  ('decl:2023:demo-ivan.xml', 'person:ИВАН ПЕТРОВ ТЕСТОВ|ОБЩИНА ПРИМЕР', 'demo-ivan.xml', 'demo-hash-ivan', '2023', '2023', 'assets', 'Местна власт', 'Община Пример', 'Кмет', 'https://register.cacbg.bg/2023/demo-ivan.xml'),
  ('decl:2023:demo-maria.xml', 'person:МАРИЯ ГЕОРГИЕВА ОБРАЗЦОВА|ОБЩИНА СОФИЯ', 'demo-maria.xml', 'demo-hash-maria', '2023', '2023', 'assets', 'Местна власт', 'Община София', 'Директор дирекция', 'https://register.cacbg.bg/2023/demo-maria.xml');

INSERT OR IGNORE INTO declared_interests (id, declaration_id, entity_raw, entity_key, kind, detail, timing, seat) VALUES
  ('di:decl:2023:demo-ivan.xml:1', 'decl:2023:demo-ivan.xml', 'АЛФА СТРОЙ ООД', 'АЛФА СТРОЙ ООД', 'shares', '50%', 'annual', 'Пловдив'),
  ('di:decl:2023:demo-ivan.xml:2', 'decl:2023:demo-ivan.xml', 'ГАМА ИНВЕСТ АД', 'ГАМА ИНВЕСТ АД', 'shares', '0,5%', 'annual', 'Варна'),
  ('di:decl:2023:demo-maria.xml:1', 'decl:2023:demo-maria.xml', 'БЕТА КОНСУЛТ ЕООД', 'БЕТА КОНСУЛТ ЕООД', 'shares', '100%', 'annual', 'София');

-- Three links, three outcomes:
--   published private_ownership  — the official's own stake, own_institution='exact' (the strongest signal)
--   published family_ownership   — a relative's declared stake; the relative is never named (ADR-0032)
--   held  (АД, C_hold)           — a joint-stock parcel: collected, never surfaced (ADR-0022 materiality)
INSERT OR IGNORE INTO interest_links
  (id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version, publish_tier,
   relation, interest_class, contemporaneous, own_institution, evidence_count,
   first_declared_year, last_declared_year, contract_count, contract_value_eur,
   first_contract_year, last_contract_year, status)
VALUES
  ('il:person:ИВАН ПЕТРОВ ТЕСТОВ|ОБЩИНА ПРИМЕР|201122335', 'person:ИВАН ПЕТРОВ ТЕСТОВ|ОБЩИНА ПРИМЕР|201122335',
   'person:ИВАН ПЕТРОВ ТЕСТОВ|ОБЩИНА ПРИМЕР', 'eik:201122335', '201122335', 'АЛФА СТРОЙ ООД',
   'exact_name_key', 'seed-demo', 'B_distinctive', 'owns', 'private_ownership', 1, 'exact', 1,
   '2021', '2023', 1, 429000, '2022', '2022', 'published'),
  ('il:person:МАРИЯ ГЕОРГИЕВА ОБРАЗЦОВА|ОБЩИНА СОФИЯ|203445566|family', 'person:МАРИЯ ГЕОРГИЕВА ОБРАЗЦОВА|ОБЩИНА СОФИЯ|203445566|family',
   'person:МАРИЯ ГЕОРГИЕВА ОБРАЗЦОВА|ОБЩИНА СОФИЯ', 'eik:203445566', '203445566', 'БЕТА КОНСУЛТ ЕООД',
   'exact_name_key', 'seed-demo', 'A_seat', 'related', 'family_ownership', 1, 'exact', 1,
   '2021', '2023', 1, 190000, '2022', '2022', 'published'),
  ('il:person:ИВАН ПЕТРОВ ТЕСТОВ|ОБЩИНА ПРИМЕР|204556676', 'person:ИВАН ПЕТРОВ ТЕСТОВ|ОБЩИНА ПРИМЕР|204556676',
   'person:ИВАН ПЕТРОВ ТЕСТОВ|ОБЩИНА ПРИМЕР', 'eik:204556676', '204556676', 'ГАМА ИНВЕСТ АД',
   'exact_name_key', 'seed-demo', 'C_hold', 'owns', 'management_role', 0, 'none', 1,
   '2021', '2023', 1, 120000, '2022', '2022', 'held');

INSERT OR IGNORE INTO interest_link_authorities (link_key, authority_id, authority_name, contract_count, value_eur, own) VALUES
  ('person:ИВАН ПЕТРОВ ТЕСТОВ|ОБЩИНА ПРИМЕР|201122335', 'auth-plovdiv', 'Община Пример', 1, 429000, 'exact'),
  ('person:МАРИЯ ГЕОРГИЕВА ОБРАЗЦОВА|ОБЩИНА СОФИЯ|203445566|family', 'auth-sofia', 'Община София', 1, 190000, 'exact');

-- Trade Register evidence seals (#279, ADR-0033, migration 0006). NOT optional decoration: since the
-- evidence ladder landed, SURFACED_OWNERSHIP requires a publishing seal, so a seeded link without one
-- renders NOTHING — which is the exact failure this fixture exists to prevent. A seal per link, one per
-- rung, so the dev surface shows the same three outcomes as production:
--   document         — the register names this person in this company (the strongest rung)
--   confirmed        — identity confirmed by declared data (seat), no person found in the act itself
--   bar_joint_stock  — an АД: a declared parcel of shares is not a material ownership conflict
-- matched_fact stays inside the closed vocabulary (evidence.mjs isSealedFact) — never a name.
INSERT OR IGNORE INTO interest_link_evidence
  (link_key, evidence_kind, registry_role, matched_fact, entry_number, entry_date, lookup_date, rules_version, live_status)
VALUES
  ('person:ИВАН ПЕТРОВ ТЕСТОВ|ОБЩИНА ПРИМЕР|201122335', 'document', 'owner', 'role:owner:CR_F_19_L',
   '20220314150210', '2022-03-14', '2026-08-05', 'tr-rules-1', 'live'),
  ('person:МАРИЯ ГЕОРГИЕВА ОБРАЗЦОВА|ОБЩИНА СОФИЯ|203445566|family', 'confirmed', NULL, 'seat:СОФИЯ',
   '20210902110455', '2021-09-02', '2026-08-05', 'tr-rules-1', 'live'),
  -- The held link is sealed too — seals exist for held links so the review queue can explain itself,
  -- and this one doubles as the fixture's negative case for the seal gate.
  ('person:ИВАН ПЕТРОВ ТЕСТОВ|ОБЩИНА ПРИМЕР|204556676', 'bar_joint_stock', NULL, NULL,
   NULL, NULL, '2026-08-05', 'tr-rules-1', 'live');
