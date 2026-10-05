// A declared management is judged as management, through the real loader (tr-rules-10, ADR-0047 §3). The board
// of a joint-stock company and the governing body of an association run them as a manager runs a ООД, and the
// register records those seats: a declared management found there publishes, where the joint-stock bar and the
// hold on an unknown legal form once held it. Those two, and the refutation by the date of the ownership record,
// stay what they are for a declared stake.
// Run: node --import ./scripts/cacbg/register-ts.mjs --test scripts/cacbg/load-management.test.mjs
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
let dir, DB, STAGING, TR_DB, TR_RAW;

const management = (over) => ({
  template: 'interests',
  kind: 'management',
  detail: 'член на съвета на директорите',
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-management-'));
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
      ('eik:300000020','ГАМА ИНВЕСТ АД','300000020',1,'София'),
      ('eik:300000021','СДРУЖЕНИЕ ТЕСТОВА ФЕДЕРАЦИЯ','300000021',1,'София'),
      ('eik:300000023','ТЕСТОВО ЗАТВОРЕНО ООД','300000023',1,'София');
    INSERT INTO contracts VALUES
      ('c1','t1','eik:300000020','2024-05-01',50000),
      ('c2','t1','eik:300000021','2024-05-01',40000),
      ('c3','t1','eik:300000023','2024-05-01',30000);
    CREATE TABLE registry_deeds(eik TEXT PRIMARY KEY, name TEXT, legal_form TEXT, outcome TEXT);
    CREATE TABLE registry_company_history(eik TEXT PRIMARY KEY, names_json TEXT, source_hash TEXT, fetched_at TEXT);
    CREATE TABLE registry_identity_snapshots(eik TEXT PRIMARY KEY, source_hash TEXT);
    CREATE TABLE state_owned_eik(eik TEXT PRIMARY KEY, ownership_kind TEXT, canonical_name TEXT);
    CREATE TABLE public_owned_eik(eik TEXT PRIMARY KEY, ownership_kind TEXT);
    INSERT INTO registry_deeds VALUES
      ('300000020','ГАМА ИНВЕСТ','AD','ok'),
      ('300000021','ТЕСТОВА ФЕДЕРАЦИЯ','ASSOC','ok'),
      ('300000023','ТЕСТОВО ЗАТВОРЕНО','OOD','ok');
  `);
  for (const m of ['0003_related_persons_foundation', '0009_interest_link_evidence'])
    db.exec(fs.readFileSync(path.join(ROOT, `packages/db/migrations/${m}.sql`), 'utf8'));
  db.close();

  const holdings = [
    // Sits on the board of a private joint-stock company and declares that he manages it.
    management({
      xmlFile: 'G.xml',
      person: 'Георги Тестов Директоров',
      entity: 'ГАМА ИНВЕСТ АД',
      controlHash: 'G1',
    }),
    // Sits on the governing body of an association and declares that she manages it.
    management({
      xmlFile: 'V.xml',
      person: 'Вера Тестова Сдруженова',
      entity: 'СДРУЖЕНИЕ ТЕСТОВА ФЕДЕРАЦИЯ',
      controlHash: 'V1',
    }),
    // Declares that he manages a ООД the register never shows him in, whose ownership record predates the filing.
    management({
      xmlFile: 'M.xml',
      person: 'Митко Тестов Незаписан',
      entity: 'ТЕСТОВО ЗАТВОРЕНО ООД',
      detail: 'управител',
      controlHash: 'M1',
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
  const registries = {
    300000020: fixtureRegistry('300000020', {
      boards: ['ГЕОРГИ ТЕСТОВ ДИРЕКТОРОВ'],
      owners: ['АКЦИОНЕР ТЕСТОВ ДРУГ'],
      form: 'AD',
      suffix: 'АД',
    }),
    300000021: fixtureRegistry('300000021', {
      governing: ['ВЕРА ТЕСТОВА СДРУЖЕНОВА'],
      form: 'ASSOC',
    }),
    300000023: fixtureRegistry('300000023', {
      owners: ['ДРУГ ТЕСТОВ СОБСТВЕНИК'],
      ownEntryDate: '2015-03-01',
      form: 'OOD',
      suffix: 'ООД',
    }),
  };
  seedVerdicts({
    workDb: DB,
    staging: STAGING,
    trDb: TR_DB,
    registryFor: (eik) => (registries[eik] ? { registry: registries[eik] } : null),
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

const link = (eik, person) => {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT il.*, e.evidence_kind, e.registry_role, e.matched_fact FROM interest_links il
         JOIN persons p ON p.id=il.person_id LEFT JOIN interest_link_evidence e ON e.link_key=il.link_key
         WHERE il.eik=? AND p.name=?`,
      )
      .get(eik, person);
  } finally {
    db.close();
  }
};

test('a declared management of a private joint-stock company, on its board in the register, publishes', () => {
  const g = link('300000020', 'Георги Тестов Директоров');
  assert.equal(g.relation, 'manages');
  assert.equal(g.interest_class, 'private_ownership');
  assert.equal(g.publish_tier, 'document');
  assert.equal(g.matched_fact, 'role:manager:00120');
  assert.equal(g.status, 'published');
});

test('a declared management of an association, on its governing body in the register, publishes', () => {
  const v = link('300000021', 'Вера Тестова Сдруженова');
  assert.equal(v.publish_tier, 'document');
  assert.equal(v.matched_fact, 'role:manager:00125');
  assert.equal(v.status, 'published');
});

test('a declared management the register does not show is held, never refuted by the ownership date', () => {
  const m = link('300000023', 'Митко Тестов Незаписан');
  assert.equal(m.relation, 'manages');
  assert.equal(m.publish_tier, 'unknown');
  assert.equal(m.status, 'held');
});
