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
  300000004: ['МАРИЯ ИВАНОВА ТЕСТОВА'],
  300000006: [
    'АННА ТЕСТОВА ПРИМЕРОВА',
    'ЦВЕТАН ТЕСТОВ ПРИМЕРОВ',
    'ЕЛЕНА ТЕСТОВА ПРИМЕРОВА',
    'ГАЛИНА ТЕСТОВА ПРИМЕРОВА',
  ],
  300000010: ['БОРИС ТЕСТОВ ПРИМЕРОВ'],
  // ТЕСТ ВОДА: a state company and its private namesake, both read.
  300000014: ['ВАСИЛ ТЕСТОВ ПРИМЕРОВ'],
  300000016: ['ДИМО ДРУГОВ ЧУЖДЕНЦОВ'],
  300000018: ['НИКОЛАЙ ИВАНОВ ПРИМЕРОВ'],
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
      ('eik:300000012','ТЕСТ ТРИ ООД','300000012',1,'Варна',NULL),
      ('eik:300000014','ТЕСТ ВОДА ООД','300000014',1,'София','state'),
      ('eik:300000016','ТЕСТ ВОДА ООД','300000016',1,'Варна',NULL),
      ('eik:300000018','ТЕСТ ИСТОРИЯ ЕООД','300000018',1,'София',NULL);
    INSERT INTO contracts VALUES
      ('c1','t1','eik:300000004','2024-05-01',50000),
      ('c2','t1','eik:300000006','2024-05-01',40000),
      ('c3','t1','eik:300000010','2024-05-01',30000),
      ('c4','t1','eik:300000012','2024-05-01',20000),
      ('c5','t1','eik:300000014','2024-05-01',20000),
      ('c6','t1','eik:300000016','2024-05-01',20000),
      ('c7','t1','eik:300000018','2024-05-01',20000);
    CREATE TABLE registry_deeds(eik TEXT PRIMARY KEY, name TEXT, legal_form TEXT, outcome TEXT);
    CREATE TABLE registry_company_history(eik TEXT PRIMARY KEY, names_json TEXT, source_hash TEXT, fetched_at TEXT);
    CREATE TABLE state_owned_eik(eik TEXT PRIMARY KEY, ownership_kind TEXT, canonical_name TEXT);
    CREATE TABLE public_owned_eik(eik TEXT PRIMARY KEY, ownership_kind TEXT);
    INSERT INTO registry_deeds VALUES
      ('300000004','ТЕСТ ДВА','OOD','ok'),
      ('300000006','ТЕСТ ДВА','OOD','ok'),
      ('300000010','ТЕСТ ТРИ','OOD','ok'),
      ('300000014','ТЕСТ ВОДА','OOD','ok'),
      ('300000016','ТЕСТ ВОДА','OOD','ok'),
      ('300000018','ТЕСТ ИСТОРИЯ','EOOD','ok');
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
  db.prepare('INSERT INTO registry_company_history VALUES(?,?,?,?)').run(
    '300000018',
    JSON.stringify([{ name: 'ТЕСТ ИСТОРИЯ', legalForm: 'ООД' }]),
    'h',
    '2026-01-01',
  );
  db.close();

  const holdings = [
    stake({
      xmlFile: 'N1.xml',
      controlHash: 'N1',
      person: 'Николай Иванов Примеров',
      entity: 'ТЕСТ ИСТОРИЯ',
    }),
    stake({
      xmlFile: 'N2.xml',
      controlHash: 'N2',
      folder: '2023',
      year: '2023',
      person: 'Николай Иванов Примеров',
      entity: 'ТЕСТ ИСТОРИЯ ООД, ЕИК 300000018',
    }),
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
    // register shows her in 300000006 only — the stated ЕИК is the company; no second one is added.
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
    // She states the ЕИК of each namesake in one declaration and writes the bare name in a third; the
    // register shows her in 300000006 — the pick agrees with a stated ЕИК, so that declaration names it.
    stake({
      xmlFile: 'G1.xml',
      controlHash: 'G1',
      person: 'Галина Тестова Примерова',
      entity: 'ТЕСТ ДВА ООД, ЕИК 300000004',
    }),
    stake({
      xmlFile: 'G2.xml',
      controlHash: 'G2',
      folder: '2023',
      year: '2023',
      person: 'Галина Тестова Примерова',
      entity: 'ТЕСТ ДВА ООД, ЕИК 300000006',
    }),
    stake({
      xmlFile: 'G3.xml',
      controlHash: 'G3',
      folder: '2022',
      year: '2022',
      person: 'Галина Тестова Примерова',
      entity: 'ТЕСТ ДВА ООД',
    }),
    // …and in a fourth whose stake forms no link: no other stake holds that row, the agreement alone does.
    stake({
      xmlFile: 'G4.xml',
      controlHash: 'G4',
      folder: '2021',
      year: '2021',
      timing: 'unknown',
      person: 'Галина Тестова Примерова',
      entity: 'ТЕСТ ДВА ООД',
    }),
    // …and in a third, whose stake forms no link at all (its timing is unknown).
    stake({
      xmlFile: 'H.xml',
      controlHash: 'H1',
      folder: '2022',
      year: '2022',
      timing: 'unknown',
      person: 'Елена Тестова Примерова',
      entity: 'ТЕСТ ДВА ООД',
    }),
    // The manager of a state company writes the post in the participation field. The name is shared with a
    // private company; the partida that names him is the state one — the line is his office, not a stake.
    stake({
      xmlFile: 'V.xml',
      controlHash: 'V1',
      template: 'interests',
      kind: 'participation',
      detail: 'управител',
      timing: 'current',
      person: 'Васил Тестов Примеров',
      entity: 'ТЕСТ ВОДА ООД',
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
              form: eik === '300000018' ? 'EOOD' : 'OOD',
              suffix: eik === '300000018' ? 'ЕООД' : 'ООД',
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
  assert.deepEqual(companiesOf('E.xml'), [{ eik: '300000004', match_method: 'declared_eik' }]);
  assert.deepEqual(companiesOf('F.xml'), [], 'the bare name is not shown as the other company');
  assert.deepEqual(companiesOf('H.xml'), [], 'not even where the stake forms no link');
});

test('a pick that agrees with a stated ЕИК stays the company its declaration names', () => {
  assert.deepEqual(
    links('Галина Тестова Примерова').map((l) => l.eik),
    ['300000004', '300000006'],
  );
  assert.deepEqual(companiesOf('G3.xml'), [
    { eik: '300000006', match_method: 'registry_namesake' },
  ]);
  assert.deepEqual(companiesOf('G4.xml'), [
    { eik: '300000006', match_method: 'registry_namesake' },
  ]);
});

test('a post in the participation field of a state namesake is the office, not a stake', () => {
  assert.deepEqual(
    query(
      `SELECT il.eik, il.relation, il.interest_class, il.status FROM interest_links il
       JOIN persons p ON p.id=il.person_id WHERE p.name=?`,
      'Васил Тестов Примеров',
    ),
    [
      {
        eik: '300000014',
        relation: 'manages',
        interest_class: 'ex_officio_board',
        status: 'internal',
      },
    ],
  );
});

test('a registry-only historic EIK proof cannot displace a valid winner-name claim', () => {
  assert.deepEqual(links('Николай Иванов Примеров'), [
    { eik: '300000018', match_method: 'name_stem', relation: 'owns' },
  ]);
  assert.deepEqual(
    companiesOf('N2.xml'),
    [],
    'identity can use the history; winner provenance requires the bidder name',
  );
  assert.deepEqual(
    query(
      "SELECT first_declared_year,last_declared_year FROM interest_links WHERE eik='300000018'",
    ),
    [{ first_declared_year: '2024', last_declared_year: '2024' }],
  );
});
