// A post written into a stake's amount field, through the real loader. Declarants sometimes record the office
// they hold in a company on the participation line („управител“ where the share should be). That line declares
// the office, not a stake: it must not make the declarant the owner of the company, least of all of a public
// enterprise whose manager they are.
// Run: node --import ./scripts/cacbg/register-ts.mjs --test scripts/cacbg/load-declared-post.test.mjs
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

const row = (over) => ({
  template: 'interests',
  kind: 'participation',
  timing: 'current',
  seat: '',
  year: '2024',
  folder: '2024',
  category: 'Кметове и общински съветници',
  institution: 'Община Тест',
  work: 'Община Тест',
  position: 'Общински съветник',
  ...over,
});

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-declared-post-'));
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
      ('eik:300000004','ДЪРЖАВНО ТЕСТ ЕООД','300000004',1,'София','state'),
      ('eik:300000006','ЧАСТНО ТЕСТ ЕООД','300000006',1,'София',NULL);
    INSERT INTO contracts VALUES
      ('c1','t1','eik:300000004','2024-05-01',50000),
      ('c2','t1','eik:300000006','2024-05-01',40000);
    CREATE TABLE registry_deeds(eik TEXT PRIMARY KEY, name TEXT, legal_form TEXT, outcome TEXT);
    CREATE TABLE registry_company_history(eik TEXT PRIMARY KEY, names_json TEXT, source_hash TEXT, fetched_at TEXT);
    CREATE TABLE registry_identity_snapshots(eik TEXT PRIMARY KEY, source_hash TEXT);
    CREATE TABLE state_owned_eik(eik TEXT PRIMARY KEY, ownership_kind TEXT, canonical_name TEXT);
    CREATE TABLE public_owned_eik(eik TEXT PRIMARY KEY, ownership_kind TEXT);
    INSERT INTO registry_deeds VALUES
      ('300000004','ДЪРЖАВНО ТЕСТ','EOOD','ok'),
      ('300000006','ЧАСТНО ТЕСТ','EOOD','ok');
  `);
  for (const m of ['0003_related_persons_foundation', '0009_interest_link_evidence'])
    db.exec(fs.readFileSync(path.join(ROOT, `packages/db/migrations/${m}.sql`), 'utf8'));
  db.close();

  const holdings = [
    // The manager of a state company: the post on the management line, and again on the participation line
    // for the months before the appointment.
    row({
      xmlFile: 'A.xml',
      controlHash: 'A1',
      person: 'Анна Тестова Примерова',
      entity: 'ДЪРЖАВНО ТЕСТ ЕООД',
      kind: 'management',
      detail: 'управител',
    }),
    row({
      xmlFile: 'A.xml',
      controlHash: 'A1',
      person: 'Анна Тестова Примерова',
      entity: 'ДЪРЖАВНО ТЕСТ ЕООД',
      detail: 'Управител',
      timing: 'prior',
    }),
    // A post on the participation line of a PRIVATE company stays what it was declared as: its sole owner is
    // very often its manager too, so the word does not tell the two apart.
    row({
      xmlFile: 'B.xml',
      controlHash: 'B1',
      person: 'Борис Тестов Примеров',
      entity: 'ЧАСТНО ТЕСТ ЕООД',
      detail: 'Член на УС',
    }),
    // A share stays a share, even beside a word that also names a post.
    row({
      xmlFile: 'C.xml',
      controlHash: 'C1',
      person: 'Цветана Тестова Примерова',
      entity: 'ЧАСТНО ТЕСТ ЕООД',
      detail: '50% от капитала, управител',
    }),
    // The same post on both lines of one declaration is one post, recorded once.
    row({
      xmlFile: 'D.xml',
      controlHash: 'D1',
      person: 'Деян Тестов Примеров',
      entity: 'ДЪРЖАВНО ТЕСТ ЕООД',
      kind: 'management',
      detail: 'член на съвета на директорите',
    }),
    row({
      xmlFile: 'D.xml',
      controlHash: 'D1',
      person: 'Деян Тестов Примеров',
      entity: 'ДЪРЖАВНО ТЕСТ ЕООД',
      detail: 'член на СД',
    }),
    // Only the participation line is read this way: a declared block of shares stays shares.
    row({
      xmlFile: 'E.xml',
      controlHash: 'E1',
      person: 'Елица Тестова Примерова',
      entity: 'ЧАСТНО ТЕСТ ЕООД',
      kind: 'shares',
      detail: 'управител',
    }),
  ];
  fs.writeFileSync(
    path.join(STAGING, 'holdings.jsonl'),
    holdings.map((h) => JSON.stringify(h)).join('\n') + '\n',
  );
  fs.writeFileSync(path.join(STAGING, 'related.jsonl'), '');
  fs.writeFileSync(
    path.join(STAGING, 'filings.jsonl'),
    [...new Map(holdings.map((h) => [h.xmlFile, h])).values()]
      .map(({ entity, kind, detail, timing, seat, ...f }) => JSON.stringify(f))
      .join('\n') + '\n',
  );
  const registry = {
    300000004: { managers: ['АННА ТЕСТОВА ПРИМЕРОВА', 'ДЕЯН ТЕСТОВ ПРИМЕРОВ'] },
    300000006: {
      managers: ['БОРИС ТЕСТОВ ПРИМЕРОВ'],
      owners: ['ЦВЕТАНА ТЕСТОВА ПРИМЕРОВА', 'ЕЛИЦА ТЕСТОВА ПРИМЕРОВА'],
    },
  };
  seedVerdicts({
    workDb: DB,
    staging: STAGING,
    trDb: TR_DB,
    registryFor: (eik) =>
      registry[eik]
        ? { registry: fixtureRegistry(eik, { ...registry[eik], form: 'EOOD', suffix: 'ЕООД' }) }
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
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
};
const link = (eik, person) =>
  query(
    'SELECT il.* FROM interest_links il JOIN persons p ON p.id=il.person_id WHERE il.eik=? AND p.name=?',
    eik,
    person,
  )[0];

test('the manager of a state company who repeats the post on the participation line holds the office', () => {
  const anna = link('300000004', 'Анна Тестова Примерова');
  assert.equal(anna.relation, 'manages');
  assert.equal(anna.interest_class, 'ex_officio_board');
  assert.equal(anna.status, 'internal');
  // The source line is kept, recorded as the management it declares.
  assert.deepEqual(
    query(
      "SELECT di.kind, di.detail, di.timing FROM declared_interests di JOIN declarations d ON d.id=di.declaration_id WHERE d.xml_file='A.xml' ORDER BY di.timing",
    ).map((r) => ({ ...r })),
    [
      { kind: 'management', detail: 'управител', timing: 'current' },
      { kind: 'management', detail: 'Управител', timing: 'prior' },
    ],
  );
});

test('a post on the participation line of a private company stays as declared', () => {
  assert.equal(link('300000006', 'Борис Тестов Примеров').relation, 'owns');
  assert.deepEqual(
    query(
      "SELECT di.kind FROM declared_interests di JOIN declarations d ON d.id=di.declaration_id WHERE d.xml_file='B.xml'",
    ).map((r) => ({ ...r })),
    [{ kind: 'participation' }],
  );
});

test('a share that also names a post stays a share', () => {
  assert.equal(link('300000006', 'Цветана Тестова Примерова').relation, 'owns');
});

test('the same post on both lines of one declaration is recorded once', () => {
  assert.equal(link('300000004', 'Деян Тестов Примеров').relation, 'manages');
  assert.deepEqual(
    query(
      "SELECT di.kind, di.detail FROM declared_interests di JOIN declarations d ON d.id=di.declaration_id WHERE d.xml_file='D.xml'",
    ).map((r) => ({ ...r })),
    [{ kind: 'management', detail: 'член на съвета на директорите' }],
  );
});

test('shares that name a post stay shares', () => {
  assert.equal(link('300000006', 'Елица Тестова Примерова').relation, 'owns');
});
