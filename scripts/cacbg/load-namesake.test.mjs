// Namesake companies through the real loader (ADR-0050). Two winners share a name; the register decides which
// one a declaration means, by the partida that shows the holder of the stake — and only once every partida
// with that name has been read.
// Run: node --import ./scripts/cacbg/register-ts.mjs --test scripts/cacbg/load-namesake.test.mjs
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
let dir, DB;

const stake = (over) => ({
  template: 'assets',
  kind: 'shares',
  detail: '',
  timing: 'annual',
  seat: '',
  year: '2024',
  folder: '2024',
  category: 'Кметове и общински съветници',
  institution: 'Община Тест',
  work: 'Община Тест',
  position: 'Общински съветник',
  holderRelation: 'self',
  ...over,
});

// ТЕСТ ДВА: both partidas read. ТЕСТ ТРИ: the second partida is not read yet.
const PARTIDAS = {
  300000004: ['МАРИЯ ИВАНОВА ТЕСТОВА', 'ЕЛЕНА ТЕСТОВА ПРИМЕРОВА'],
  300000006: ['АННА ТЕСТОВА ПРИМЕРОВА', 'ЦВЕТАН ТЕСТОВ ПРИМЕРОВ', 'ЕЛЕНА ТЕСТОВА ПРИМЕРОВА'],
  300000010: ['БОРИС ТЕСТОВ ПРИМЕРОВ'],
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-namesake-'));
  const TR_DB = path.join(dir, 'tr-cache.sqlite');
  const TR_RAW = path.join(dir, 'tr-deeds');
  const STAGING = path.join(dir, 'staging');
  DB = path.join(dir, 'fixture.sqlite');
  fs.mkdirSync(STAGING, { recursive: true });

  const db = new DatabaseSync(DB);
  db.exec(`
    CREATE TABLE bidders(id TEXT PRIMARY KEY, name TEXT, eik_normalized TEXT, eik_valid INT, settlement TEXT, ownership_kind TEXT);
    CREATE TABLE authorities(id TEXT PRIMARY KEY, name TEXT, type TEXT, type_group TEXT);
    CREATE TABLE tenders(id TEXT PRIMARY KEY, authority_id TEXT);
    CREATE TABLE contracts(id TEXT PRIMARY KEY, tender_id TEXT, bidder_id TEXT, signed_at TEXT, amount_eur REAL);
    INSERT INTO authorities VALUES ('auth:1','ВЕДОМСТВО ТЕСТ','Местен орган','община');
    INSERT INTO tenders VALUES ('t1','auth:1');
    INSERT INTO bidders VALUES
      ('eik:300000004','ТЕСТ ДВА ООД','300000004',1,'София',NULL),
      ('eik:300000006','ТЕСТ ДВА ООД','300000006',1,'Варна',NULL),
      ('eik:300000010','ТЕСТ ТРИ ООД','300000010',1,'София',NULL),
      ('eik:300000012','ТЕСТ ТРИ ООД','300000012',1,'Варна',NULL);
    INSERT INTO contracts VALUES
      ('c1','t1','eik:300000004','2024-05-01',50000),
      ('c2','t1','eik:300000006','2024-05-01',40000),
      ('c3','t1','eik:300000010','2024-05-01',30000),
      ('c4','t1','eik:300000012','2024-05-01',20000);
    CREATE TABLE registry_deeds(eik TEXT PRIMARY KEY, name TEXT, legal_form TEXT, outcome TEXT);
    CREATE TABLE registry_company_history(eik TEXT PRIMARY KEY, names_json TEXT, source_hash TEXT, fetched_at TEXT);
    CREATE TABLE state_owned_eik(eik TEXT PRIMARY KEY, ownership_kind TEXT, canonical_name TEXT);
    CREATE TABLE public_owned_eik(eik TEXT PRIMARY KEY, ownership_kind TEXT);
    INSERT INTO registry_deeds VALUES
      ('300000004','ТЕСТ ДВА','OOD','ok'),
      ('300000006','ТЕСТ ДВА','OOD','ok'),
      ('300000010','ТЕСТ ТРИ','OOD','ok');
  `);
  for (const m of [
    '0003_related_persons_foundation',
    '0009_interest_link_evidence',
    '0013_registry',
    '0017_registry_identity_observations',
  ])
    db.exec(fs.readFileSync(path.join(ROOT, `packages/db/migrations/${m}.sql`), 'utf8'));
  let entry = 0;
  const observe = db.prepare(
    "INSERT INTO registry_identity_observations VALUES(?,'1','00190',?,'2019-01-01',0,?,'EGN',?,?,'person',?,'2026-01-01')",
  );
  for (const [eik, people] of Object.entries(PARTIDAS)) {
    db.prepare("INSERT INTO registry_identity_snapshots VALUES(?,'h','2026-01-01')").run(eik);
    for (const name of people) {
      const id = String(++entry);
      observe.run(eik, id, id.padStart(64, 'a'), name, name, 'f'.repeat(64));
    }
  }
  db.close();

  const holdings = [
    // Her own stake: the register shows her in 300000006 only.
    stake({
      xmlFile: 'A.xml',
      controlHash: 'A1',
      person: 'Анна Тестова Примерова',
      entity: 'ТЕСТ ДВА ООД',
    }),
    // His own stake in ТЕСТ ТРИ: he is in 300000010, but 300000012 is unread — nothing is chosen.
    stake({
      xmlFile: 'B.xml',
      controlHash: 'B1',
      person: 'Борис Тестов Примеров',
      entity: 'ТЕСТ ТРИ ООД',
    }),
    // A relative's stake: the declarant is in 300000006, the relative in 300000004 — the relative decides.
    stake({
      xmlFile: 'C.xml',
      controlHash: 'C1',
      person: 'Цветан Тестов Примеров',
      entity: 'ТЕСТ ДВА ООД',
      holderRelation: 'related',
    }),
    // A holder the declaration does not settle: no company is chosen for the declaration either.
    stake({
      xmlFile: 'D.xml',
      controlHash: 'D1',
      person: 'Цветан Тестов Примеров',
      entity: 'ТЕСТ ДВА ООД',
      holderRelation: 'unknown',
    }),
    // She states the ЕИК of 300000004 in one declaration and writes the bare name in another, while the
    // register shows her in both partidas — the stated ЕИК is the company; no second one is added.
    stake({
      xmlFile: 'E.xml',
      controlHash: 'E1',
      person: 'Елена Тестова Примерова',
      entity: 'ТЕСТ ДВА ООД, ЕИК 300000004',
    }),
    stake({
      xmlFile: 'F.xml',
      controlHash: 'F1',
      folder: '2023',
      year: '2023',
      person: 'Елена Тестова Примерова',
      entity: 'ТЕСТ ДВА ООД',
    }),
  ];
  fs.writeFileSync(
    path.join(STAGING, 'holdings.jsonl'),
    holdings.map((h) => JSON.stringify(h)).join('\n') + '\n',
  );
  fs.writeFileSync(
    path.join(STAGING, 'related.jsonl'),
    JSON.stringify({
      folder: '2024',
      xmlFile: 'C.xml',
      year: '2024',
      person: 'Цветан Тестов Примеров',
      institution: 'Община Тест',
      category: 'Кметове и общински съветници',
      work: 'Община Тест',
      related_name: 'Мария Иванова Тестова',
      related_kind: 'stake_holder',
      info: 'ТЕСТ ДВА ООД',
      timing: 'annual',
    }) + '\n',
  );
  fs.writeFileSync(
    path.join(STAGING, 'filings.jsonl'),
    [...new Map(holdings.map((h) => [h.xmlFile, h])).values()]
      .map(({ entity, kind, detail, timing, seat, holderRelation, ...f }) => JSON.stringify(f))
      .join('\n') + '\n',
  );
  seedVerdicts({
    workDb: DB,
    staging: STAGING,
    trDb: TR_DB,
    registryFor: (eik) =>
      PARTIDAS[eik]
        ? {
            registry: fixtureRegistry(eik, {
              owners: PARTIDAS[eik],
              form: 'OOD',
              suffix: 'ООД',
            }),
          }
        : null,
  });

  execFileSync(
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
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const query = (sql, ...args) => {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    return db
      .prepare(sql)
      .all(...args)
      .map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const links = (person) =>
  query(
    `SELECT il.eik, il.match_method, il.relation FROM interest_links il JOIN persons p ON p.id=il.person_id
     WHERE p.name=? ORDER BY il.eik, il.relation`,
    person,
  );
const companiesOf = (xml) =>
  query(
    'SELECT dc.eik, dc.match_method FROM declaration_companies dc JOIN declarations d ON d.id=dc.declaration_id WHERE d.xml_file=?',
    xml,
  );

test('an own stake goes to the one read partida that shows the declarant', () => {
  assert.deepEqual(links('Анна Тестова Примерова'), [
    { eik: '300000006', match_method: 'registry_namesake', relation: 'owns' },
  ]);
  assert.deepEqual(companiesOf('A.xml'), [{ eik: '300000006', match_method: 'registry_namesake' }]);
});

test('an unread namesake partida leaves the name ambiguous', () => {
  assert.deepEqual(links('Борис Тестов Примеров'), []);
  assert.deepEqual(companiesOf('B.xml'), []);
});

test('a family stake is settled by the relative the declaration names, not by the declarant', () => {
  assert.deepEqual(links('Цветан Тестов Примеров'), [
    { eik: '300000004', match_method: 'registry_namesake', relation: 'related' },
  ]);
  assert.deepEqual(companiesOf('C.xml'), [{ eik: '300000004', match_method: 'registry_namesake' }]);
});

test('a holder the declaration does not settle chooses no company', () => {
  assert.deepEqual(companiesOf('D.xml'), []);
});

test('a stated ЕИК of one namesake is not joined by the register’s pick of the other', () => {
  assert.deepEqual(
    links('Елена Тестова Примерова').map((l) => l.eik),
    ['300000004'],
  );
});
