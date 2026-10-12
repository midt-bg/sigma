// Managing a company with a public owner, through the real loader (ADR-0047). Running a company of which the
// state, a municipality or another public owner holds a part, however small, is a held position, as at a public
// enterprise: the link is the office, not a private interest. The unread owner beside a public one is still
// requested, so the company's own ownership can be settled. A declarant who files in a public-enterprise
// category and names the company as the office holds that office, whatever the ownership columns say.
// Run: node --import ./scripts/cacbg/register-ts.mjs --test scripts/cacbg/load-public-enterprise.test.mjs
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
const PUBLIC_ENTERPRISE =
  'Членовете на управителните органи на икономически обособените лица, както и управителите и членовете на ОУ или контрол на ОП или ДП';
let dir, DB, STAGING, TR_DB, TR_RAW, output;

const management = (over) => ({
  template: 'interests',
  kind: 'management',
  detail: 'управител',
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-public-enterprise-'));
  TR_DB = path.join(dir, 'tr-cache.sqlite');
  TR_RAW = path.join(dir, 'tr-deeds');
  DB = path.join(dir, 'fixture.sqlite');
  STAGING = path.join(dir, 'staging');
  fs.mkdirSync(STAGING, { recursive: true });

  const db = new DatabaseSync(DB);
  db.exec(`
    CREATE TABLE bidders(id TEXT PRIMARY KEY, name TEXT, eik_normalized TEXT, eik_valid INT, settlement TEXT, ownership_kind TEXT);
    CREATE TABLE authorities(id TEXT PRIMARY KEY, name TEXT, type TEXT, type_group TEXT);
    CREATE TABLE tenders(id TEXT PRIMARY KEY, authority_id TEXT);
    CREATE TABLE contracts(id TEXT PRIMARY KEY, tender_id TEXT, bidder_id TEXT, signed_at TEXT, amount_eur REAL);
    INSERT INTO authorities VALUES ('auth:1','ВЕДОМСТВО ТЕСТ','Местен орган','община');
    INSERT INTO tenders VALUES ('t1','auth:1');
    INSERT INTO bidders(id,name,eik_normalized,eik_valid,settlement) VALUES
      ('eik:300000004','ОТВОРЕНА СОБСТВЕНОСТ ООД','300000004',1,'София'),
      ('eik:300000006','ЧАСТНА СОБСТВЕНОСТ ООД','300000006',1,'София'),
      ('eik:300000010','ОБЩИНСКО ТЕСТ ООД','300000010',1,'София');
    INSERT INTO contracts VALUES
      ('c1','t1','eik:300000004','2024-05-01',50000),
      ('c2','t1','eik:300000006','2024-05-01',40000),
      ('c3','t1','eik:300000010','2024-05-01',30000);
    CREATE TABLE registry_deeds(eik TEXT PRIMARY KEY, name TEXT, legal_form TEXT, outcome TEXT);
    CREATE TABLE registry_company_history(eik TEXT PRIMARY KEY, names_json TEXT, source_hash TEXT, fetched_at TEXT);
    CREATE TABLE registry_identity_snapshots(eik TEXT PRIMARY KEY, source_hash TEXT);
    CREATE TABLE state_owned_eik(eik TEXT PRIMARY KEY, ownership_kind TEXT, canonical_name TEXT);
    CREATE TABLE public_owned_eik(eik TEXT PRIMARY KEY, ownership_kind TEXT);
    INSERT INTO registry_deeds VALUES
      ('300000004','ОТВОРЕНА СОБСТВЕНОСТ','OOD','ok'),
      ('300000006','ЧАСТНА СОБСТВЕНОСТ','OOD','ok'),
      ('300000010','ОБЩИНСКО ТЕСТ','OOD','ok');
  `);
  for (const m of ['0003_related_persons_foundation', '0009_interest_link_evidence'])
    db.exec(fs.readFileSync(path.join(ROOT, `packages/db/migrations/${m}.sql`), 'utf8'));
  db.close();

  const holdings = [
    // Runs a company a municipality holds 40 % of, beside a company the register has not been read for.
    management({
      xmlFile: 'A.xml',
      person: 'Анна Тестова Примерова',
      entity: 'ОТВОРЕНА СОБСТВЕНОСТ ООД',
      controlHash: 'A1',
    }),
    // Runs a company a person holds 60 % of and a municipality 40 %: settled, and private.
    management({
      xmlFile: 'B.xml',
      person: 'Борис Тестов Примеров',
      entity: 'ЧАСТНА СОБСТВЕНОСТ ООД',
      controlHash: 'B1',
    }),
    // Files as the manager of the company itself, in the public-enterprise category: the office.
    management({
      xmlFile: 'C.xml',
      person: 'Цветана Тестова Примерова',
      entity: 'ОБЩИНСКО ТЕСТ ООД',
      category: PUBLIC_ENTERPRISE,
      institution: 'Общински предприятия',
      work: 'ОБЩИНСКО ТЕСТ ООД',
      position: 'Управител',
      controlHash: 'C1',
    }),
    // Runs the same company from another office: no category ties it to the company, so a private interest.
    management({
      xmlFile: 'D.xml',
      person: 'Димитър Тестов Примеров',
      entity: 'ОБЩИНСКО ТЕСТ ООД',
      controlHash: 'D1',
    }),
  ];
  fs.writeFileSync(
    path.join(STAGING, 'holdings.jsonl'),
    holdings.map((h) => JSON.stringify(h)).join('\n') + '\n',
  );
  fs.writeFileSync(path.join(STAGING, 'related.jsonl'), '');
  fs.writeFileSync(
    path.join(STAGING, 'filings.jsonl'),
    holdings.map(({ entity, kind, detail, timing, seat, ...f }) => JSON.stringify(f)).join('\n') +
      '\n',
  );
  const managers = {
    300000004: ['АННА ТЕСТОВА ПРИМЕРОВА'],
    300000006: ['БОРИС ТЕСТОВ ПРИМЕРОВ'],
    300000010: ['ЦВЕТАНА ТЕСТОВА ПРИМЕРОВА', 'ДИМИТЪР ТЕСТОВ ПРИМЕРОВ'],
  };
  seedVerdicts({
    workDb: DB,
    staging: STAGING,
    trDb: TR_DB,
    registryFor: (eik) =>
      managers[eik]
        ? {
            registry: fixtureRegistry(eik, { managers: managers[eik], form: 'OOD', suffix: 'ООД' }),
          }
        : null,
  });

  // The owners as the registry layer records them; the job's snapshot carries this table.
  const owners = new DatabaseSync(DB);
  const owner = (eik, kind, id, name, share) =>
    `('${eik}','0000','00190','partner','${kind}','${id}','${name}',${share === null ? 'NULL' : `'${share}'`},'e1','2020-01-01')`;
  owners.exec(`
    INSERT INTO registry_roles (eik, sub_uic, field_ident, role, subject_kind, subject_id, subject_name, share, entry_number, added_on) VALUES
      ${[
        owner('300000004', 'entity', '000000011', 'Община Тестово', '400'),
        owner('300000004', 'entity', '300000099', 'ТЕСТ ГРУП ООД', '600'),
        owner('300000006', 'person', 'p1', 'ПЕТЪР ТЕСТОВ ПРИМЕРОВ', '600'),
        owner('300000006', 'entity', '000000011', 'Община Тестово', '400'),
      ].join(',')};
  `);
  owners.close();

  output = execFileSync(
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

const link = (eik, person) => {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT il.* FROM interest_links il JOIN persons p ON p.id=il.person_id WHERE il.eik=? AND p.name=?',
      )
      .get(eik, person);
  } finally {
    db.close();
  }
};

test('running a company with a public owner beside an unread one is the office; the unread owner is requested', () => {
  const anna = link('300000004', 'Анна Тестова Примерова');
  assert.equal(anna.relation, 'manages');
  assert.equal(anna.interest_class, 'ex_officio_board');
  assert.equal(anna.status, 'internal');
  assert.doesNotMatch(output, /held — ownership still open .*: 300000004\b/);
  const db = new DatabaseSync(DB, { readOnly: true });
  assert.deepEqual(
    db
      .prepare(
        "SELECT eik, declaration_id FROM registry_requested_companies WHERE declaration_id LIKE 'ownership:%'",
      )
      .all()
      .map((r) => ({ ...r })),
    [{ eik: '300000099', declaration_id: 'ownership:300000004' }],
  );
  db.close();
});

test('running a company with a minority public owner is the office, as at a public enterprise', () => {
  // A municipality holds 40% of it, a private person the rest.
  const boris = link('300000006', 'Борис Тестов Примеров');
  assert.equal(boris.interest_class, 'ex_officio_board');
  assert.equal(boris.status, 'internal');
});

test('the manager who files the company as the office in a public-enterprise category holds the office', () => {
  const tsvetana = link('300000010', 'Цветана Тестова Примерова');
  assert.equal(tsvetana.interest_class, 'ex_officio_board');
  assert.equal(tsvetana.status, 'internal');
  // The same company run from another office is still a private interest: the category ties one filing to one
  // company, not the company to everyone who runs it.
  const dimitar = link('300000010', 'Димитър Тестов Примеров');
  assert.equal(dimitar.interest_class, 'private_ownership');
  assert.equal(dimitar.status, 'published');
});
