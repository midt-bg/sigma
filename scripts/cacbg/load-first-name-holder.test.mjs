// ADR-0051: a holder cell that is only the declarant's first name is the declarant's own stake where another
// of the declarant's filings names the declarant in full as the holder of the same company, and the filing
// itself names no other holder of it. Otherwise it stays unknown and forms nothing. All names are invented.
// Run: node --import ./scripts/cacbg/register-ts.mjs --test scripts/cacbg/load-first-name-holder.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { seedVerdicts, fixtureRegistry, sealFixtureFilings } from './tr-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
let dir, DB, STAGING, TR_DB, TR_RAW, report;

const PETKO = 'Петко Иванов Пробов';
const STOYAN = 'Стоян Илиев Опитов';
const KALIN = 'Калин Петров Мострев';
const OGNYAN = 'Огнян Петров Пробнев';
const RADKO = 'Радко Иванов Тестиев';
const TRAYAN = 'Траян Илиев Сондов';

const row = (over) => ({
  template: 'assets',
  category: '',
  institution: 'КОМИСИЯ ТЕСТ',
  position: '',
  kind: 'shares',
  detail: '30%',
  timing: 'annual',
  seat: 'София',
  ...over,
});

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-first-name-'));
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
    INSERT INTO bidders(id,name,eik_normalized,eik_valid,settlement) VALUES ('eik:300000101','ПРОБА ТЕХ 7 ООД','300000101',1,'София');
    INSERT INTO bidders(id,name,eik_normalized,eik_valid,settlement) VALUES ('eik:300000102','ОПИТ ТЕХ 8 ООД','300000102',1,'София');
    INSERT INTO bidders(id,name,eik_normalized,eik_valid,settlement) VALUES ('eik:300000103','МОСТРА ТЕХ 9 ООД','300000103',1,'София');
    INSERT INTO contracts VALUES ('c1','t1','eik:300000101','2025-05-01',50000);
    INSERT INTO contracts VALUES ('c2','t1','eik:300000102','2025-05-01',50000);
    INSERT INTO contracts VALUES ('c3','t1','eik:300000103','2025-05-01',50000);
    INSERT INTO bidders(id,name,eik_normalized,eik_valid,settlement) VALUES ('eik:300000104','ИНТЕР ТЕХ 10 ООД','300000104',1,'София');
    INSERT INTO bidders(id,name,eik_normalized,eik_valid,settlement) VALUES ('eik:300000105','РАДКО ТЕХ 11 ООД','300000105',1,'София');
    INSERT INTO bidders(id,name,eik_normalized,eik_valid,settlement) VALUES ('eik:300000106','СОНДА ТЕХ 12 ООД','300000106',1,'София');
    INSERT INTO contracts VALUES ('c4','t1','eik:300000104','2025-05-01',50000);
    INSERT INTO contracts VALUES ('c5','t1','eik:300000105','2025-05-01',50000);
    INSERT INTO contracts VALUES ('c6','t1','eik:300000106','2025-05-01',50000);
  `);
  db.close();

  const holdings = [
    // Петко writes only „ПЕТКО" in 2020 and his full name on the 2021 disposal of the same company.
    row({
      folder: '2021',
      xmlFile: 'P20.xml',
      year: '2020',
      person: PETKO,
      entity: 'ПРОБА ТЕХ 7 ООД',
      holderRelation: 'unknown',
      holderFirstName: true,
      controlHash: 'P20',
    }),
    row({
      folder: '2022',
      xmlFile: 'P21.xml',
      year: '2021',
      person: PETKO,
      entity: 'ПРОБА ТЕХ 7 ООД',
      timing: 'disposed',
      holderRelation: 'self',
      controlHash: 'P21',
    }),
    // Стоян writes only „СТОЯН", and no filing of his names him in full: it stays unknown.
    row({
      folder: '2021',
      xmlFile: 'S20.xml',
      year: '2020',
      person: STOYAN,
      entity: 'ОПИТ ТЕХ 8 ООД',
      holderRelation: 'unknown',
      holderFirstName: true,
      controlHash: 'S20',
    }),
    // Калин's 2020 filing names a relative as a holder of the same company beside „КАЛИН": two people the
    // name could be, so the full name in his 2021 disposal does not settle it.
    row({
      folder: '2021',
      xmlFile: 'K20.xml',
      year: '2020',
      person: KALIN,
      entity: 'МОСТРА ТЕХ 9 ООД',
      holderRelation: 'unknown',
      holderFirstName: true,
      controlHash: 'K20',
    }),
    row({
      folder: '2021',
      xmlFile: 'K20.xml',
      year: '2020',
      person: KALIN,
      entity: 'МОСТРА ТЕХ 9 ООД',
      holderRelation: 'related',
      controlHash: 'K20',
    }),
    row({
      folder: '2022',
      xmlFile: 'K21.xml',
      year: '2021',
      person: KALIN,
      entity: 'МОСТРА ТЕХ 9 ООД',
      timing: 'disposed',
      holderRelation: 'self',
      controlHash: 'K21',
    }),
    // Огнян writes „ОГНЯН" in 2020; his full name appears only on an interests line — he manages the
    // company. An interests line has no holder cell: it does not say who holds the shares.
    row({
      folder: '2021',
      xmlFile: 'O20.xml',
      year: '2020',
      person: OGNYAN,
      entity: 'ИНТЕР ТЕХ 10 ООД',
      holderRelation: 'unknown',
      holderFirstName: true,
      controlHash: 'O20',
    }),
    row({
      folder: '2022',
      xmlFile: 'O21.xml',
      year: '2021',
      template: 'interests',
      kind: 'management',
      detail: 'управител',
      timing: 'current',
      person: OGNYAN,
      entity: 'ИНТЕР ТЕХ 10 ООД',
      holderRelation: 'self',
      controlHash: 'O21',
    }),
    // Радко's 2020 filing lists „РАДКО" and a second holder line for the company whose name the classifier
    // cannot settle (a son named after him, in full): two people the first name could be.
    row({
      folder: '2021',
      xmlFile: 'R20.xml',
      year: '2020',
      person: RADKO,
      entity: 'РАДКО ТЕХ 11 ООД',
      holderRelation: 'unknown',
      holderFirstName: true,
      controlHash: 'R20',
    }),
    row({
      folder: '2021',
      xmlFile: 'R20.xml',
      year: '2020',
      person: RADKO,
      entity: 'РАДКО ТЕХ 11 ООД',
      holderRelation: 'unknown',
      controlHash: 'R20',
    }),
    row({
      folder: '2022',
      xmlFile: 'R21.xml',
      year: '2021',
      person: RADKO,
      entity: 'РАДКО ТЕХ 11 ООД',
      timing: 'disposed',
      holderRelation: 'self',
      controlHash: 'R21',
    }),
    // Траян holds the company in 2019 and transfers it in 2020, both in full; „ТРАЯН" in 2021 comes after
    // the transfer — most likely whoever received it — and is not his.
    row({
      folder: '2020',
      xmlFile: 'T19.xml',
      year: '2019',
      person: TRAYAN,
      entity: 'СОНДА ТЕХ 12 ООД',
      holderRelation: 'self',
      controlHash: 'T19',
    }),
    row({
      folder: '2021',
      xmlFile: 'T20.xml',
      year: '2020',
      person: TRAYAN,
      entity: 'СОНДА ТЕХ 12 ООД',
      timing: 'disposed',
      holderRelation: 'self',
      controlHash: 'T20',
    }),
    row({
      folder: '2022',
      xmlFile: 'T21.xml',
      year: '2021',
      person: TRAYAN,
      entity: 'СОНДА ТЕХ 12 ООД',
      holderRelation: 'unknown',
      holderFirstName: true,
      controlHash: 'T21',
    }),
  ];
  fs.writeFileSync(
    path.join(STAGING, 'holdings.jsonl'),
    holdings.map((h) => JSON.stringify(h)).join('\n') + '\n',
  );
  fs.writeFileSync(path.join(STAGING, 'related.jsonl'), '');
  const filings = [...new Map(holdings.map((h) => [h.xmlFile, h])).values()].map((h) => ({
    sourceHash: 'a'.repeat(64),
    folder: h.folder,
    xmlFile: h.xmlFile,
    year: h.year,
    template: h.template,
    declarationType: 'Annualy',
    person: h.person,
    institution: h.institution,
  }));
  fs.writeFileSync(
    path.join(STAGING, 'filings.jsonl'),
    filings.map((f) => JSON.stringify(f)).join('\n') + '\n',
  );

  const owners = {
    300000101: PETKO,
    300000102: STOYAN,
    300000103: KALIN,
    300000104: OGNYAN,
    300000105: RADKO,
    300000106: TRAYAN,
  };
  seedVerdicts({
    workDb: DB,
    staging: STAGING,
    trDb: TR_DB,
    registryFor: (eik) =>
      eik in owners
        ? {
            registry: fixtureRegistry(eik, {
              owners: ['НОВ ИВАНОВ СОБСТВЕНИК'],
              pastOwners: [owners[eik].toUpperCase()],
              seat: 'София',
              form: 4,
              suffix: 'ООД',
            }),
          }
        : null,
  });

  sealFixtureFilings(STAGING);
  const out = execFileSync(
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
  // The loader prints its report as JSON on stdout.
  report = {
    firstNameHolderConfirmed: Number(/"firstNameHolderConfirmed": (\d+)/u.exec(out)?.[1]),
  };
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const ownLink = (eik, person) => {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT il.* FROM interest_links il JOIN persons p ON p.id=il.person_id WHERE il.eik=? AND p.name=? AND il.interest_class<>'family_ownership'",
      )
      .get(eik, person);
  } finally {
    db.close();
  }
};

test('a first name the declarant writes in full elsewhere for the same company is his own stake', () => {
  const link = ownLink('300000101', PETKO);
  assert.ok(link, 'the own link forms');
  assert.equal(link.first_declared_year, '2020');
  assert.equal(report.firstNameHolderConfirmed, 1);
});

test('a first name no filing writes in full stays unknown and forms nothing', () => {
  assert.equal(ownLink('300000102', STOYAN), undefined);
});

test('a first name beside another named holder of the company stays unknown', () => {
  const link = ownLink('300000103', KALIN);
  // Only the 2021 disposal is his own; the 2020 holding is not dated as his.
  assert.ok(link, 'the disposal still forms the own link');
  assert.equal(link.first_declared_year, null);
});

test('an interests line naming the declarant is not a holder cell', () => {
  const link = ownLink('300000104', OGNYAN);
  assert.ok(!link || !String(link.relation).includes('owns'), 'no own stake from the first name');
});

test('a first name beside another holder line the classifier cannot settle stays unknown', () => {
  const link = ownLink('300000105', RADKO);
  assert.ok(link, 'the disposal still forms the own link');
  assert.equal(link.first_declared_year, null);
});

test('a first name after the declarant transferred the company is not his', () => {
  const link = ownLink('300000106', TRAYAN);
  assert.ok(link, 'the 2019 holding forms the own link');
  assert.equal(link.last_declared_year, '2019');
});
