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
const ZDRAVKO = 'Здравко Петров Опитин';
const HRISTO = 'Христо Иванов Пробин';
const BORISLAV = 'Борислав Илиев Мострин';
const STANIMIR = 'Станимир Петров Сондин';
const VELIN = 'Велин Илиев Пробчев';
const GENADI = 'Генади Петров Мострич';
const DOBRI = 'Добри Иванов Сондев';

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
    INSERT INTO bidders(id,name,eik_normalized,eik_valid,settlement) VALUES ('eik:300000107','ЗДРАВ ТЕХ 13 ООД','300000107',1,'София');
    INSERT INTO bidders(id,name,eik_normalized,eik_valid,settlement) VALUES ('eik:300000108','ХРИСТ ТЕХ 14 ООД','300000108',1,'София');
    INSERT INTO bidders(id,name,eik_normalized,eik_valid,settlement) VALUES ('eik:300000109','БОРИС ТЕХ 15 ООД','300000109',1,'София');
    INSERT INTO contracts VALUES ('c7','t1','eik:300000107','2025-05-01',50000);
    INSERT INTO contracts VALUES ('c8','t1','eik:300000108','2025-05-01',50000);
    INSERT INTO contracts VALUES ('c9','t1','eik:300000109','2025-05-01',50000);
    INSERT INTO bidders(id,name,eik_normalized,eik_valid,settlement) VALUES ('eik:300000110','СТАН ТЕХ 16 ООД','300000110',1,'София');
    INSERT INTO contracts VALUES ('c10','t1','eik:300000110','2025-05-01',50000);
    INSERT INTO bidders(id,name,eik_normalized,eik_valid,settlement) VALUES ('eik:300000111','ВЕЛ ТЕХ 17 ООД','300000111',1,'София');
    INSERT INTO bidders(id,name,eik_normalized,eik_valid,settlement) VALUES ('eik:300000112','ГАМА ПРОБНА ЕООД','300000112',1,'София');
    INSERT INTO bidders(id,name,eik_normalized,eik_valid,settlement) VALUES ('eik:300000113','ДОБРО ТЕХ 18 ООД','300000113',1,'София');
    INSERT INTO contracts VALUES ('c11','t1','eik:300000111','2025-05-01',50000);
    INSERT INTO contracts VALUES ('c12','t1','eik:300000112','2025-05-01',50000);
    INSERT INTO contracts VALUES ('c13','t1','eik:300000113','2025-05-01',50000);
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
    // Здравко holds the company in full in 2020 and transfers it during 2021, in a filing of that year;
    // „ЗДРАВКО" on the 2021 annual comes after the transfer and is not his.
    row({
      folder: '2021',
      xmlFile: 'Z20.xml',
      year: '2020',
      person: ZDRAVKO,
      entity: 'ЗДРАВ ТЕХ 13 ООД',
      holderRelation: 'self',
      controlHash: 'Z20',
    }),
    row({
      folder: '2021',
      xmlFile: 'Z21V.xml',
      year: '2021',
      person: ZDRAVKO,
      entity: 'ЗДРАВ ТЕХ 13 ООД',
      timing: 'disposed',
      holderRelation: 'self',
      controlHash: 'Z21V',
    }),
    row({
      folder: '2022',
      xmlFile: 'Z21.xml',
      year: '2021',
      person: ZDRAVKO,
      entity: 'ЗДРАВ ТЕХ 13 ООД',
      holderRelation: 'unknown',
      holderFirstName: true,
      controlHash: 'Z21',
    }),
    // Христо writes „ХРИСТО" in one 2021 filing and his full name for the same holding in another of 2021.
    row({
      folder: '2022',
      xmlFile: 'X21.xml',
      year: '2021',
      person: HRISTO,
      entity: 'ХРИСТ ТЕХ 14 ООД',
      holderRelation: 'unknown',
      holderFirstName: true,
      controlHash: 'X21',
    }),
    row({
      folder: '2022',
      xmlFile: 'X21E.xml',
      year: '2021',
      person: HRISTO,
      entity: 'ХРИСТ ТЕХ 14 ООД',
      holderRelation: 'self',
      controlHash: 'X21E',
    }),
    // Борислав's 2020 filing lists the company twice, once by its ЕИК: a second line, whoever's.
    row({
      folder: '2021',
      xmlFile: 'B20.xml',
      year: '2020',
      person: BORISLAV,
      entity: 'БОРИС ТЕХ 15 ООД',
      holderRelation: 'unknown',
      holderFirstName: true,
      controlHash: 'B20',
    }),
    row({
      folder: '2021',
      xmlFile: 'B20.xml',
      year: '2020',
      person: BORISLAV,
      entity: '"БОРИС ТЕХ 15" ООД, ЕИК 300000109',
      holderRelation: 'unknown',
      controlHash: 'B20',
    }),
    row({
      folder: '2022',
      xmlFile: 'B21.xml',
      year: '2021',
      person: BORISLAV,
      entity: 'БОРИС ТЕХ 15 ООД',
      timing: 'disposed',
      holderRelation: 'self',
      controlHash: 'B21',
    }),
    // Станимир holds the company in full in 2019; his transfer has no readable year and sits in a later
    // folder. The folder year runs ahead of the declared one, so it does not date the transfer late enough
    // to confirm „СТАНИМИР" in 2021.
    row({
      folder: '2020',
      xmlFile: 'N19.xml',
      year: '2019',
      person: STANIMIR,
      entity: 'СТАН ТЕХ 16 ООД',
      holderRelation: 'self',
      controlHash: 'N19',
    }),
    row({
      folder: '2022',
      xmlFile: 'N20.xml',
      year: '',
      person: STANIMIR,
      entity: 'СТАН ТЕХ 16 ООД',
      timing: 'disposed',
      holderRelation: 'self',
      controlHash: 'N20',
    }),
    row({
      folder: '2022',
      xmlFile: 'N21.xml',
      year: '2021',
      person: STANIMIR,
      entity: 'СТАН ТЕХ 16 ООД',
      holderRelation: 'unknown',
      holderFirstName: true,
      controlHash: 'N21',
    }),
    // Велин writes „ВЕЛИН" in 2020. His 2021 filing names him in full for the company, and beside it a
    // second „ВЕЛИН" line: someone else bears the first name there, so 2021 does not settle 2020.
    row({
      folder: '2021',
      xmlFile: 'V20.xml',
      year: '2020',
      person: VELIN,
      entity: 'ВЕЛ ТЕХ 17 ООД',
      holderRelation: 'unknown',
      holderFirstName: true,
      controlHash: 'V20',
    }),
    row({
      folder: '2022',
      xmlFile: 'V21.xml',
      year: '2021',
      person: VELIN,
      entity: 'ВЕЛ ТЕХ 17 ООД',
      holderRelation: 'self',
      controlHash: 'V21',
    }),
    row({
      folder: '2022',
      xmlFile: 'V21.xml',
      year: '2021',
      person: VELIN,
      entity: 'ВЕЛ ТЕХ 17 ООД',
      holderRelation: 'unknown',
      holderFirstName: true,
      controlHash: 'V21',
    }),
    // Генади writes „ГЕНАДИ" on one company in 2020 and his full name on another form of the name in 2021.
    // The two meet only by a name-stem guess, which names a company only, not this one.
    row({
      folder: '2021',
      xmlFile: 'G20.xml',
      year: '2020',
      person: GENADI,
      entity: 'ГАМА ПРОБНА ЕООД',
      holderRelation: 'unknown',
      holderFirstName: true,
      controlHash: 'G20',
    }),
    row({
      folder: '2022',
      xmlFile: 'G21.xml',
      year: '2021',
      person: GENADI,
      entity: 'ГАМА ПРОБНА ООД',
      holderRelation: 'self',
      controlHash: 'G21',
    }),
    // Добри writes „ДОБРИ" in 2020 and his full name on the 2021 transfer, there with the company's ЕИК:
    // the names differ, the ЕИК is the same company.
    row({
      folder: '2021',
      xmlFile: 'D20.xml',
      year: '2020',
      person: DOBRI,
      entity: 'ДОБРО ТЕХ 18 ООД',
      holderRelation: 'unknown',
      holderFirstName: true,
      controlHash: 'D20',
    }),
    row({
      folder: '2022',
      xmlFile: 'D21.xml',
      year: '2021',
      person: DOBRI,
      entity: '"ДОБРО ТЕХ 18" ООД, ЕИК 300000113',
      timing: 'disposed',
      holderRelation: 'self',
      controlHash: 'D21',
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
    300000107: ZDRAVKO,
    300000108: HRISTO,
    300000109: BORISLAV,
    300000110: STANIMIR,
    300000111: VELIN,
    300000112: GENADI,
    300000113: DOBRI,
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
  // Петко, Христо and Добри.
  assert.equal(report.firstNameHolderConfirmed, 3);
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
  assert.equal(link?.relation, 'manages', 'the post stays a post; the first name adds no stake');
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

test("a transfer confirms only an earlier year: the same year's first name is not his", () => {
  const link = ownLink('300000107', ZDRAVKO);
  assert.ok(link, 'the 2020 holding forms the own link');
  assert.equal(link.last_declared_year, '2020');
});

test('a full name for the same holding in another filing of the same year confirms it', () => {
  // A same-year confirmation leaves the link's years as they are; it shows only in the counter, which the
  // first test pins to exactly Петко, Христо and Добри.
  const link = ownLink('300000108', HRISTO);
  assert.equal(link.first_declared_year, '2021');
});

test('a confirming filing that names another holder of the company beside the declarant settles nothing', () => {
  const link = ownLink('300000111', VELIN);
  assert.ok(link, 'the 2021 holding forms the own link');
  assert.equal(link.first_declared_year, '2021');
});

test('a name-stem guess is not the same company', () => {
  const link = ownLink('300000112', GENADI);
  assert.ok(link, 'the 2021 holding forms the own link by its stem');
  assert.equal(link.first_declared_year, '2021');
  assert.equal(link.match_method, 'name_stem');
});

test('the same ЕИК under a different name confirms it', () => {
  const link = ownLink('300000113', DOBRI);
  assert.ok(link, 'the own link forms');
  assert.equal(link.first_declared_year, '2020');
});

test('the same company named a second time by its ЕИК is a second line', () => {
  const link = ownLink('300000109', BORISLAV);
  assert.ok(link, 'the disposal still forms the own link');
  assert.equal(link.first_declared_year, null);
});

test('a filing year read from the folder confirms nothing', () => {
  const link = ownLink('300000110', STANIMIR);
  assert.ok(link, 'the 2019 holding forms the own link');
  assert.equal(link.last_declared_year, '2019');
});
