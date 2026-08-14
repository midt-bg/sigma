/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { refreshSliceStatementGroups } from './refresh';

// The served search_index 'official' rows are populated by the ETL Worker, which parses scripts/refresh-slice.sql
// with refreshSliceStatementGroups() and runs each group via db.batch(). refresh-slice.test.ts exercises the SQL
// via `sqlite3 .read` (whole-file) and never seeds interest_links — so the officials batch, AND this real
// parse-then-execute path, were untested. This test closes that gap: it proves (1) the parser keeps the officials
// INSERT a single well-formed statement (a stray split or a mis-stripped comment would break the live ETL, which
// no other test would catch), and (2) executing the entity-search-index group populates officials from
// interest_links. This is the exact production path behind the minister's name-search feature.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrations = [
  '0000_init.sql',
  '0001_flow_pairs_bidder_index.sql',
  '0003_related_persons_foundation.sql',
  // The officials batch now joins the Trade Register evidence seal (#279, ADR-0033) — without 0006 the
  // real refresh-slice.sql this test executes cannot parse.
  '0009_interest_link_evidence.sql',
].map((f) => resolve(root, 'packages/db/migrations', f));
const refreshSlicePath = resolve(root, 'scripts/refresh-slice.sql');

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], {
    input: `PRAGMA foreign_keys=ON;\n.read ${path}\n`,
    stdio: 'pipe',
  });
}
function exec(dbPath: string, sql: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: sql, encoding: 'utf8' });
}
function rows(dbPath: string, sql: string): Record<string, string | number | null>[] {
  const out = execFileSync('sqlite3', ['-json', dbPath], { input: sql, encoding: 'utf8' }).trim();
  return out ? JSON.parse(out) : [];
}

// One published self-ownership official + a family link on the SAME winner (ADR-0032: the redundant-family
// collapse drops the family link since a self stake exists, so АЛФА's money counts once) + a held link (never surfaces).
// Иван declared his АЛФА stake for the window [2020,2023]. АЛФА's LIFETIME contract haul is €90k
// (contract_value_eur), but only the €30k contract signed IN that window is a contemporaneous conflict;
// the €60k one (2025) is after his declared window. The officials search headline must be the €30k
// contemporaneous sum, not the €90k lifetime total (the ~9× overstatement this fixture pins).
const FIXTURE = `
INSERT INTO bidders (id, name, eik_normalized, eik_valid, kind) VALUES
  ('eik:111','АЛФА ООД','111',1,'company'),('eik:222','БЕТА ООД','222',1,'company'),('eik:333','ГАМА ООД','333',1,'company'),('eik:444','ДЕЛТА ООД','444',1,'company');
INSERT INTO persons (id, name) VALUES ('person:ИВАН','Иван Тестов'),('person:ГЕО','Гео Държан'),('person:ВАСИЛ','Васил Безсделков'),('person:ЯНА','Яна Тестова');
INSERT INTO declarations (id, person_id, xml_file, control_hash, folder_year, declared_year, template, category, institution, position, source_url) VALUES
  ('d:i','person:ИВАН','i.xml','H1','2024','2023','assets','','ОБЩИНА РУСЕ','', 'https://register.cacbg.bg/2024/i.xml');
INSERT INTO authorities (id, name) VALUES ('a:1','ВЕДОМСТВО ТЕСТ');
INSERT INTO tenders (id, source_id, title, authority_id, procedure_type) VALUES ('t:1','s1','Т','a:1','open');
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur) VALUES
  ('c:in','t:1','eik:111',30000,'BGN','2021-05-01','N1',30000),
  ('c:out','t:1','eik:111',60000,'BGN','2025-05-01','N2',60000),
  ('c:yana','t:1','eik:444',20000,'BGN','2021-06-01','N3',20000);
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
  ('il:yf','person:ЯНА|444|family','person:ЯНА','eik:444','444','ДЕЛТА ООД','exact_name_key','v1','B_distinctive','related','family_ownership',1,'none',1,'2020','2023',1,20000,'2021','2021','published');
-- Every link carries an evidence seal (#279, ADR-0033): the officials batch requires a publishing rung,
-- so a fixture without seals indexes NOBODY and every assertion below passes vacuously. Derived from
-- interest_links, so a row added later is sealed automatically.
INSERT INTO interest_link_evidence (link_key, evidence_kind, registry_role, matched_fact, lookup_date, rules_version, live_status)
  SELECT link_key, 'document', 'owner', 'role:owner:CR_F_19_L', '2026-08-05', 'tr-rules-1', 'live' FROM interest_links;
`;

describe('ETL refresh-slice officials batch (the live parse-then-execute path)', () => {
  it('parser keeps the officials INSERT one statement, and the batch populates search_index from interest_links', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'etl-officials-'));
    const dbPath = resolve(dir, 't.sqlite');
    try {
      for (const m of migrations) readScript(dbPath, m);
      exec(dbPath, FIXTURE);

      const groups = refreshSliceStatementGroups(readFileSync(refreshSlicePath, 'utf8'));
      const searchGroup = groups.find((g) => g.name === 'entity-search-index');
      expect(searchGroup, 'entity-search-index batch exists in refresh-slice.sql').toBeDefined();

      // The officials INSERT survived comment-stripping/splitting as ONE statement — not split at the
      // multi-line WHERE/subquery, and its GROUP BY tail intact.
      const officialInsert = searchGroup!.statements.find(
        (s) => s.includes("'official'") && s.includes('INSERT INTO search_index'),
      );
      expect(officialInsert, 'a single officials INSERT statement').toBeDefined();
      expect(officialInsert!).toMatch(/GROUP BY il\.person_id, p\.name/); // officials grouped per person
      expect(officialInsert!).toMatch(
        /interest_class IN \('private_ownership', 'family_ownership'\)/,
      ); // self + family gate (ADR-0032) rode through
      expect(officialInsert!.match(/INSERT INTO search_index/g)).toHaveLength(1); // exactly one INSERT — not merged/split wrong

      // Execute the whole entity-search-index group in order (what db.batch does in the Worker).
      for (const stmt of searchGroup!.statements) exec(dbPath, `${stmt};`);

      const officials = rows(
        dbPath,
        `SELECT ref, title, amount FROM search_index WHERE kind='official' ORDER BY ref`,
      );
      // Иван is indexed once: he has an own AND a relative's stake in АЛФА (eik 111), so the redundant-family
      // collapse drops the family link and the winner's money counts ONCE (not €60k); Гео (held only) is absent. Amount
      // is the CONTEMPORANEOUS conflict-window sum (€30k, the 2021 contract inside [2020,2023]) — NOT the €90k
      // lifetime total, which would credit him with АЛФА's 2025 contract signed after his window.
      // Иван (self, collapse) + Яна (surviving family — her self stake is HELD, so no collapse). Васил gated by
      // N9 (no live contract), Гео by status (held). Яна sorts after Иван, so his index-0 assertions below hold.
      expect(officials).toHaveLength(2);
      expect(officials.some((o) => o.ref === 'person:ВАСИЛ')).toBe(false);
      expect(officials.some((o) => o.ref === 'person:ЯНА')).toBe(true); // published family survives an unpublished self
      expect(officials[0]!.ref).toBe('person:ИВАН');
      expect(officials[0]!.title).toBe('Иван Тестов');
      expect(officials[0]!.amount).toBe(30000);
      expect(officials[0]!.amount).not.toBe(90000); // guards the ~9× lifetime overstatement
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
