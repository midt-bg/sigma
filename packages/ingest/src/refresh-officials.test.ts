/// <reference types="node" />
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { refreshSliceStatementGroups } from './refresh';

// The served search_index 'official' rows are populated by the ETL Worker, which parses scripts/refresh-slice.sql
// with refreshSliceStatementGroups() and runs each group via db.batch(). refresh-slice.test.ts exercises the SQL
// via a whole-file import and never seeds interest_links — so the officials batch, AND this real
// parse-then-execute path, were untested. This test closes that gap: it proves (1) the parser keeps the officials
// INSERT a single well-formed statement (a stray split or a mis-stripped comment would break the live ETL, which
// no other test would catch), and (2) executing the official-search-index group populates officials from
// interest_links. This is the exact production path behind the minister's name-search feature.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrations = [
  '0000_init.sql',
  '0001_flow_pairs_bidder_index.sql',
  '0003_related_persons_foundation.sql',
  // The officials batch now joins the Trade Register evidence seal (#279, ADR-0033) — without 0006 the
  // real refresh-slice.sql this test executes cannot parse.
  '0009_interest_link_evidence.sql',
  // The register's roles and the bridge from a declarant to the register's person: the batch adds the
  // companies the register alone records an official in.
  '0013_registry.sql',
  '0014_person_profile.sql',
  '0015_person_observations.sql',
  '0017_registry_identity_observations.sql',
  '0018_person_entities.sql',
].map((f) => resolve(root, 'packages/db/migrations', f));
const refreshSlicePath = resolve(root, 'scripts/refresh-slice.sql');

function readScript(dbPath: string, path: string): void {
  exec(dbPath, readFileSync(path, 'utf8'));
}
function exec(dbPath: string, sql: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA foreign_keys=ON;\n${sql}`);
  } finally {
    db.close();
  }
}
function rows(dbPath: string, sql: string): Record<string, string | number | null>[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as Record<string, string | number | null>[];
  } finally {
    db.close();
  }
}

// One published self-ownership official + a family link on the SAME winner (ADR-0032: the redundant-family
// collapse drops the family link since a self stake exists, so АЛФА's money counts once) + a held link (never surfaces).
// Иван declared his АЛФА stake for the window [2020,2023] and filed for an office in 2021 and 2023 — the 2023
// filing is his exit, of 10 March. The officials search figure is the list's „стойност в периода на
// длъжността": the €30k contract of 2021 and the €4k one of February 2023. Not the €7k one of 2022 (inside the
// declared years and the office bounds, but a year with no filing for an office), not the €9k one of October
// 2023 (after the exit), not the €60k one of 2025 (after the declared window) — and never АЛФА's lifetime
// total. Борд declared a management the register records only as a seat on a collegial body: indexed, with
// no figure, as in the list's default view.
// The register also records Иван, since March 2021, as the manager of ЗЕТА — a company no declaration of his
// names — and on the board of ЕТА. ЗЕТА's €11k contract of September 2021 is added to his figure, as in his
// row of the list. Not its €5k one of February 2021 (before the role), not its €6k one of October 2023 (after
// his exit), and nothing of ЕТА: a seat on a collegial body is not listed by default.
const FIXTURE = `
INSERT INTO bidders (id, name, eik_normalized, eik_valid, kind) VALUES
  ('eik:111','АЛФА ООД','111',1,'company'),('eik:222','БЕТА ООД','222',1,'company'),('eik:333','ГАМА ООД','333',1,'company'),('eik:444','ДЕЛТА ООД','444',1,'company'),('eik:555','ЕПСИЛОН АД','555',1,'company'),('eik:666','ЗЕТА ООД','666',1,'company'),('eik:777','ЕТА АД','777',1,'company');
INSERT INTO company_totals (bidder_id, name, kind, eik, eik_valid, won_eur, contracts, authorities) VALUES
  ('eik:666','ЗЕТА ООД','company','666',1,22000,3,1),('eik:777','ЕТА АД','company','777',1,70000,1,1);
INSERT INTO registry_deeds (eik, name, outcome, fetched_at) VALUES ('666','ЗЕТА ООД','ok','2026-08-01'),('777','ЕТА АД','ok','2026-08-01');
INSERT INTO persons (id, name) VALUES ('person:ИВАН','Иван Тестов'),('person:ГЕО','Гео Държан'),('person:ВАСИЛ','Васил Безсделков'),('person:ЯНА','Яна Тестова'),('person:БОРД','Борд Тестов');
INSERT INTO declarations (id, person_id, xml_file, control_hash, folder_year, declared_year, template, category, institution, position, source_url) VALUES
  ('d:i21','person:ИВАН','i21.xml','H1','2022','2021','assets','','ОБЩИНА ТЕСТ','Кмет', 'https://register.cacbg.bg/2022/i21.xml'),
  ('d:i23','person:ИВАН','i23.xml','H2','2023','2023','assets','','ОБЩИНА ТЕСТ','Кмет', 'https://register.cacbg.bg/2023/i23.xml'),
  -- Яна's 2021 filing names an institution and no position: not a filing for an office, so no office year.
  ('d:y','person:ЯНА','y.xml','H3','2022','2021','assets','','ОБЩИНА ТЕСТ','', 'https://register.cacbg.bg/2022/y.xml'),
  ('d:b','person:БОРД','b.xml','H4','2022','2021','assets','','ОБЩИНА ТЕСТ','Заместник-кмет', 'https://register.cacbg.bg/2022/b.xml');
INSERT INTO declaration_metadata (declaration_id, declaration_type, declared_on) VALUES
  ('d:i21','Annualy','2022-05-10'),('d:i23','Vacate','2023-03-10'),('d:y','Annualy','2022-05-10'),('d:b','Annualy','2022-05-10');
INSERT INTO authorities (id, name) VALUES ('a:1','ВЕДОМСТВО ТЕСТ');
INSERT INTO tenders (id, source_id, title, authority_id, procedure_type) VALUES ('t:1','s1','Т','a:1','open');
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur) VALUES
  ('c:in','t:1','eik:111',30000,'BGN','2021-05-01','N1',30000),
  ('c:out','t:1','eik:111',60000,'BGN','2025-05-01','N2',60000),
  ('c:gap','t:1','eik:111',7000,'BGN','2022-05-01','N4',7000),
  ('c:early','t:1','eik:111',4000,'BGN','2023-02-01','N5',4000),
  ('c:late','t:1','eik:111',9000,'BGN','2023-10-01','N6',9000),
  ('c:yana','t:1','eik:444',20000,'BGN','2021-06-01','N3',20000),
  ('c:board','t:1','eik:555',80000,'BGN','2021-06-01','N7',80000),
  ('c:reg','t:1','eik:666',11000,'BGN','2021-09-01','N8',11000),
  ('c:regearly','t:1','eik:666',5000,'BGN','2021-02-01','N9',5000),
  ('c:reglate','t:1','eik:666',6000,'BGN','2023-10-01','N10',6000),
  ('c:seat','t:1','eik:777',70000,'BGN','2021-06-01','N11',70000);
INSERT INTO interest_links
  (id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version, publish_tier, relation, interest_class, contemporaneous, own_institution, evidence_count, first_declared_year, last_declared_year, contract_count, contract_value_eur, first_contract_year, last_contract_year, status) VALUES
  ('il:s','person:ИВАН|111','person:ИВАН','eik:111','111','АЛФА ООД','exact_name_key','v1','B_distinctive','owns','private_ownership',1,'exact',1,'2020','2023',2,90000,'2021','2025','published'),
  ('il:f','person:ИВАН|111|family','person:ИВАН','eik:111','111','АЛФА ООД','exact_name_key','v1','B_distinctive','related','family_ownership',0,'none',1,'2020','2023',2,90000,'2021','2025','published'),
  ('il:h','person:ГЕО|222','person:ГЕО','eik:222','222','БЕТА ООД','exact_name_key','v1','C_hold','owns','private_ownership',0,'none',1,'2020','2020',1,5000,'2021','2021','held'),
  -- Васил: PUBLISHED own stake, but ГАМА (eik 333) has NO live contract → the N9 gate must drop him from the index.
  ('il:v','person:ВАСИЛ|333','person:ВАСИЛ','eik:333','333','ГАМА ООД','exact_name_key','v1','B_distinctive','owns','private_ownership',0,'none',1,'2020','2023',3,700000,'2021','2021','published'),
  -- Яна: her OWN stake in ДЕЛТА (eik 444) is HELD (never surfaces); her relative's stake in the SAME winner is
  -- PUBLISHED. The collapse keys on a PUBLISHED self stake, so the family link is NOT redundant and MUST index
  -- her — dropping the s.status='published' guard would collapse it behind an invisible self stake (false neg).
  ('il:ys','person:ЯНА|444','person:ЯНА','eik:444','444','ДЕЛТА ООД','exact_name_key','v1','C_hold','owns','private_ownership',0,'none',1,'2020','2023',1,20000,'2021','2021','held'),
  ('il:yf','person:ЯНА|444|family','person:ЯНА','eik:444','444','ДЕЛТА ООД','exact_name_key','v1','B_distinctive','related','family_ownership',1,'none',1,'2020','2023',1,20000,'2021','2021','published'),
  ('il:b','person:БОРД|555','person:БОРД','eik:555','555','ЕПСИЛОН АД','exact_name_key','v1','B_distinctive','manages','private_ownership',1,'none',1,'2020','2023',1,80000,'2021','2021','published');
-- Every link carries an evidence seal (#279, ADR-0033): the officials batch requires a publishing rung,
-- so a fixture without seals indexes NOBODY and every assertion below passes vacuously. Derived from
-- interest_links, so a row added later is sealed automatically.
INSERT INTO interest_link_evidence (link_key, evidence_kind, registry_role, matched_fact, lookup_date, rules_version, live_status)
  SELECT link_key, 'document', 'owner',
    CASE WHEN relation='manages' THEN 'role:manager:00120' ELSE 'role:owner:CR_F_19_L' END,
    '2026-08-05', 'tr-rules-1', 'live' FROM interest_links;
INSERT INTO person_registry_links (person_id, registry_indent, evidence_link_key, evidence_entry_number, matched_at) VALUES
  ('person:ИВАН','indent:ivan','person:ИВАН|111','E1','2026-08-01');
INSERT INTO registry_roles (eik, sub_uic, field_ident, role, subject_kind, subject_id, subject_name, entry_number, added_on) VALUES
  ('666','666','00070','manager','person','indent:ivan','Иван Тестов','E2','2021-03-01'),
  ('777','777','00120','board_of_directors','person','indent:ivan','Иван Тестов','E3','2020-01-01');
`;

/** The batch as the Worker runs it, for the given touched winners; returns the officials it indexed. */
function runOfficialsBatch(dbPath: string, touched: string[]) {
  for (const m of migrations) readScript(dbPath, m);
  exec(dbPath, FIXTURE);
  exec(
    dbPath,
    `CREATE TABLE refresh_touched_bidders (bidder_id TEXT PRIMARY KEY);
     INSERT INTO refresh_touched_bidders (bidder_id) VALUES ${touched.map((b) => `('${b}')`).join(', ')};`,
  );
  const groups = refreshSliceStatementGroups(readFileSync(refreshSlicePath, 'utf8'));
  const searchGroup = groups.find((g) => g.name === 'official-search-index');
  expect(searchGroup, 'official-search-index batch exists in refresh-slice.sql').toBeDefined();
  // Execute the whole group in order (what db.batch does in the Worker).
  for (const stmt of searchGroup!.statements) exec(dbPath, `${stmt};`);
  return {
    searchGroup: searchGroup!,
    officials: rows(
      dbPath,
      `SELECT ref, title, amount FROM search_index WHERE kind='official' ORDER BY ref`,
    ),
  };
}

describe('ETL refresh-slice officials batch (the live parse-then-execute path)', () => {
  it('parser keeps the officials INSERT one statement, and the batch populates search_index from interest_links', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'etl-officials-'));
    const dbPath = resolve(dir, 't.sqlite');
    try {
      const { searchGroup, officials } = runOfficialsBatch(dbPath, [
        'eik:111',
        'eik:222',
        'eik:333',
        'eik:444',
        'eik:555',
      ]);

      // The officials INSERT survived comment-stripping/splitting as ONE statement — not split at the
      // multi-line WHERE/subquery, and its GROUP BY tail intact.
      const officialInsert = searchGroup.statements.find(
        (s) => s.includes("'official'") && s.includes('INSERT INTO search_index'),
      );
      expect(officialInsert, 'a single officials INSERT statement').toBeDefined();
      expect(officialInsert!).toMatch(/GROUP BY il\.person_id, p\.name/); // officials grouped per person
      expect(officialInsert!).toMatch(
        /interest_class IN \('private_ownership', 'family_ownership'\)/,
      ); // self + family gate (ADR-0032) rode through
      expect(officialInsert!.match(/INSERT INTO search_index/g)).toHaveLength(1); // exactly one INSERT — not merged/split wrong

      // Иван is indexed once: he has an own AND a relative's stake in АЛФА (eik 111), so the redundant-family
      // collapse drops the family link and the winner's money counts ONCE. Яна's published family link survives
      // (her self stake is HELD, so no collapse). Васил is gated by N9 (no live contract), Гео by status (held).
      expect(officials.map((o) => o.ref)).toEqual(['person:БОРД', 'person:ИВАН', 'person:ЯНА']);
      const amount = (ref: string) => officials.find((o) => o.ref === ref)!.amount;
      expect(officials.find((o) => o.ref === 'person:ИВАН')!.title).toBe('Иван Тестов');
      // The contracts signed while he both held the stake and was in office: 2021 and February 2023 — and the
      // one of the company the register alone records him as the manager of, signed while he was both.
      expect(amount('person:ИВАН')).toBe(34000 + 11000);
      // A seat on a collegial body is findable and carries no figure.
      expect(amount('person:БОРД')).toBeNull();
      // No filing for an office in the year of the contract: no period to count it in.
      expect(amount('person:ЯНА')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The daily refresh rebuilds only the officials its window touched. A contract of a company the register
  // alone records the official in changes the figure as much as one of a declared company, so it must put
  // the official in that scope too — otherwise the figure stays as it was until the next full reindex.
  it('rebuilds an official when only a company the register records them in was touched', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'etl-officials-'));
    try {
      const { officials } = runOfficialsBatch(resolve(dir, 't.sqlite'), ['eik:666']);
      expect(officials).toEqual([
        { ref: 'person:ИВАН', title: 'Иван Тестов', amount: 34000 + 11000 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
