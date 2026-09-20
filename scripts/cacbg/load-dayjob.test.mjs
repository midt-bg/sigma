// The day-job correction of ADR-0040 §5, through the real loader: a board member of a public enterprise
// whose annual declaration names his private employer as „Месторабота" is filed FOR the enterprise the
// register listed him under the same year — and only because the corpus KNOWS the employer is private (here:
// a partida whose ownership is not public, under the name the company carried when he signed). A second
// declarant at a company the corpus does not know keeps the declaration's own word.
// Run: node --import ./scripts/cacbg/register-ts.mjs --test scripts/cacbg/load-dayjob.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { seedVerdicts, fixtureRegistry } from './tr-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const GUID = 'BE34B4EA-A0C0-4958-B891-B09BFA1B1B2A';
const OTHER = 'C0FFEE00-0000-4000-8000-000000000001';
let dir, DB, STAGING, TR_DB, TR_RAW;

function runLoad() {
  return execFileSync(
    'node',
    ['--import', path.join(HERE, 'register-ts.mjs'), path.join(HERE, 'load.mjs')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CACBG_DB: DB,
        CACBG_STAGING: STAGING,
        TR_CACHE_DB: TR_DB,
        TR_RAW_DIR: TR_RAW,
      },
      stdio: 'pipe',
      encoding: 'utf8',
    },
  );
}

const filing = (over) => ({
  template: 'assets',
  entity: 'ВИН ЕДНО 5 ЕООД',
  kind: 'shares',
  detail: '40%',
  timing: 'annual',
  seat: 'София',
  ...over,
});

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-dayjob-'));
  TR_DB = path.join(dir, 'tr-cache.sqlite');
  TR_RAW = path.join(dir, 'tr-deeds');
  DB = path.join(dir, 'fixture.sqlite');
  STAGING = path.join(dir, 'staging');
  fs.mkdirSync(STAGING, { recursive: true });

  const db = new DatabaseSync(DB);
  db.exec(`
    CREATE TABLE bidders(id TEXT PRIMARY KEY, name TEXT, eik_normalized TEXT, eik_valid INT, settlement TEXT, ownership_kind TEXT);
    CREATE TABLE authorities(id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE tenders(id TEXT PRIMARY KEY, authority_id TEXT);
    CREATE TABLE contracts(id TEXT PRIMARY KEY, tender_id TEXT, bidder_id TEXT, signed_at TEXT, amount_eur REAL);
    INSERT INTO authorities VALUES ('auth:1','ВЕДОМСТВО ТЕСТ');
    INSERT INTO tenders VALUES ('t1','auth:1');
    INSERT INTO bidders(id,name,eik_normalized,eik_valid,settlement) VALUES ('eik:100000001','ВИН ЕДНО 5 ЕООД','100000001',1,'София');
    INSERT INTO contracts VALUES ('c1','t1','eik:100000001','2024-05-01',50000);
    -- The register's view of the corpus, as the job's snapshot carries it: the day job is a partida with no
    -- public owner, renamed since the declarant signed; the enterprise is on the Agency's list.
    CREATE TABLE registry_deeds(eik TEXT PRIMARY KEY, name TEXT, legal_form TEXT, outcome TEXT);
    CREATE TABLE registry_company_history(eik TEXT PRIMARY KEY, names_json TEXT, source_hash TEXT, fetched_at TEXT);
    CREATE TABLE registry_identity_snapshots(eik TEXT PRIMARY KEY, source_hash TEXT);
    CREATE TABLE state_owned_eik(eik TEXT PRIMARY KEY, ownership_kind TEXT, canonical_name TEXT);
    CREATE TABLE public_owned_eik(eik TEXT PRIMARY KEY, ownership_kind TEXT);
    INSERT INTO registry_deeds VALUES ('200101236','ТЕСТ ГРУП','AD','ok'),('121396123','ТЕСТ ПОЩИ','EAD','ok');
    INSERT INTO registry_company_history VALUES
      ('200101236','[{"name":"ТЕСТ ГРУП ХОЛДИНГ","legalForm":"АД","until":"2026-07-06"},{"name":"ТЕСТ ГРУП","legalForm":"АД","until":null}]','h1','2026-09-15');
    INSERT INTO state_owned_eik VALUES ('121396123','state','"ТЕСТ ПОЩИ" ЕАД, гр.София');
  `);
  db.exec(
    fs.readFileSync(
      path.join(ROOT, 'packages/db/migrations/0003_related_persons_foundation.sql'),
      'utf8',
    ),
  );
  db.exec(
    fs.readFileSync(
      path.join(ROOT, 'packages/db/migrations/0009_interest_link_evidence.sql'),
      'utf8',
    ),
  );
  db.close();

  const holdings = [
    // The entry declaration, listed under the enterprise itself.
    filing({
      folder: '2024',
      xmlFile: `${GUID}170080.xml`,
      year: '2024',
      category: 'Членовете на управителните органи на публични предприятия',
      institution: 'ТЕСТ ПОЩИ ЕАД',
      work: 'ТЕСТ ПОЩИ ЕАД',
      person: 'Цветан Тестов Примеров',
      position: 'Член на Съвета на директорите',
      controlHash: 'E1',
    }),
    // The annual for the same year, in a folder the register arranges by declaration TYPE: „Месторабота"
    // is the day job, under the name the company carried then.
    filing({
      folder: '2025',
      xmlFile: `${GUID}213894.xml`,
      year: '2024',
      category: 'Членовете на управителните органи на публични предприятия',
      institution: 'Ежегодни декларации',
      work: 'Тест Груп Холдинг АД',
      person: 'Цветан Тестов Примеров',
      position: 'Старши вицепрезидент',
      controlHash: 'A1',
    }),
    // Another declarant whose day job the corpus does not know at all: the declaration's own word stands.
    filing({
      folder: '2024',
      xmlFile: `${OTHER}1.xml`,
      year: '2024',
      category: 'Кметове и общински съветници',
      institution: 'Община Тест',
      work: 'Община Тест',
      person: 'Мария Тестова Примерова',
      position: 'Общински съветник',
      controlHash: 'M1',
    }),
    filing({
      folder: '2025',
      xmlFile: `${OTHER}2.xml`,
      year: '2024',
      category: 'Кметове и общински съветници',
      institution: 'Ежегодни декларации',
      work: 'НЕПОЗНАТО ДРУЖЕСТВО ООД',
      person: 'Мария Тестова Примерова',
      position: 'Общински съветник',
      controlHash: 'M2',
    }),
  ];
  fs.writeFileSync(
    path.join(STAGING, 'holdings.jsonl'),
    holdings.map((h) => JSON.stringify(h)).join('\n') + '\n',
  );
  fs.writeFileSync(path.join(STAGING, 'related.jsonl'), '');
  // The filing records the loader keys people and offices on — one per declaration, holdings aside.
  fs.writeFileSync(
    path.join(STAGING, 'filings.jsonl'),
    holdings.map(({ entity, kind, detail, timing, seat, ...f }) => JSON.stringify(f)).join('\n') +
      '\n',
  );
  seedVerdicts({
    workDb: DB,
    staging: STAGING,
    trDb: TR_DB,
    registryFor: (eik) =>
      eik === '100000001'
        ? {
            registry: fixtureRegistry(eik, {
              owners: ['ЦВЕТАН ТЕСТОВ ПРИМЕРОВ'],
              form: 4,
              suffix: 'ЕООД',
            }),
          }
        : null,
  });
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the annual filed under the day job is filed for the enterprise the register listed', () => {
  const out = runLoad();
  assert.match(out, /Day-job filings re-homed to the declarant's office: 1\b/, out.slice(-1500));
  const db = new DatabaseSync(DB, { readOnly: true });
  const institutionOf = (file) =>
    db.prepare('SELECT institution FROM declarations WHERE xml_file = ?').get(file).institution;
  assert.equal(institutionOf(`${GUID}213894.xml`), 'ТЕСТ ПОЩИ ЕАД');
  assert.equal(institutionOf(`${GUID}170080.xml`), 'ТЕСТ ПОЩИ ЕАД');
  // One official, not one per employer.
  assert.equal(
    db
      .prepare("SELECT COUNT(DISTINCT id) AS n FROM persons WHERE name = 'Цветан Тестов Примеров'")
      .get().n,
    1,
  );
  // The day job the corpus does not know is left as the declaration says.
  assert.equal(institutionOf(`${OTHER}2.xml`), 'НЕПОЗНАТО ДРУЖЕСТВО ООД');
  db.close();
});
