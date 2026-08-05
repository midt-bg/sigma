// Regression: the declaration id must be namespaced by FOLDER, not the bare xmlFile. The register splits
// a year across suffixed folders, so two DIFFERENT officials can carry declarations with the same xmlFile
// basename in different folders. Keying the declaration on `decl:${xmlFile}` alone collapses them under
// INSERT OR IGNORE — the second official's interests resolve to the FIRST official's declaration, crediting
// one person with the other's winner (cross-person mis-attribution, the exact libel failure this surface
// exists to prevent). `decl:${folder}:${xmlFile}` is unique by construction. This test fails on the bare key.
// Run: node --import ./scripts/cacbg/register-ts.mjs --test scripts/cacbg/load-collision.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
let dir, DB, STAGING;

function runLoad() {
  execFileSync(
    'node',
    ['--import', path.join(HERE, 'register-ts.mjs'), path.join(HERE, 'load.mjs')],
    {
      cwd: ROOT,
      env: { ...process.env, CACBG_DB: DB, CACBG_STAGING: STAGING },
      stdio: 'pipe',
    },
  );
}
const open = () => new DatabaseSync(DB, { readOnly: true });

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-collision-'));
  DB = path.join(dir, 'fixture.sqlite');
  STAGING = path.join(dir, 'staging');
  fs.mkdirSync(STAGING, { recursive: true });

  const db = new DatabaseSync(DB);
  db.exec(`
    CREATE TABLE bidders(id TEXT PRIMARY KEY, name TEXT, eik_normalized TEXT, eik_valid INT, settlement TEXT);
    CREATE TABLE authorities(id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE tenders(id TEXT PRIMARY KEY, authority_id TEXT);
    CREATE TABLE contracts(id TEXT PRIMARY KEY, tender_id TEXT, bidder_id TEXT, signed_at TEXT, amount_eur REAL);
    INSERT INTO authorities VALUES ('auth:1','ВЕДОМСТВО ТЕСТ');
    INSERT INTO tenders VALUES ('t1','auth:1'),('t2','auth:1');
    -- Two distinct seat-confirmed single-ЕИК winners → both publish (A_seat), no ambiguity.
    INSERT INTO bidders VALUES ('eik:100000001','КОМПАНИЯ ЕДНО ЕООД','100000001',1,'София');
    INSERT INTO bidders VALUES ('eik:200000002','КОМПАНИЯ ДВЕ ЕООД','200000002',1,'Пловдив');
    INSERT INTO contracts VALUES ('c1','t1','eik:100000001','2021-05-01',50000);
    INSERT INTO contracts VALUES ('c2','t2','eik:200000002','2022-06-01',60000);
  `);

  const SAME = 'DECL.xml'; // identical basename, DIFFERENT folders — the collision trigger
  const holdings = [
    {
      folder: '2021',
      xmlFile: SAME,
      year: '2021',
      template: 'assets',
      category: '',
      institution: 'ОБЩИНА ЕДНА',
      person: 'Иван Първи Тестов',
      position: 'Кмет',
      entity: 'КОМПАНИЯ ЕДНО ЕООД',
      kind: 'shares',
      detail: '40%',
      timing: 'annual',
      seat: 'София',
      controlHash: 'H1',
    },
    {
      folder: '2022',
      xmlFile: SAME,
      year: '2022',
      template: 'assets',
      category: '',
      institution: 'МИНИСТЕРСТВО ДВЕ',
      person: 'Петър Втори Пробен',
      position: 'Директор',
      entity: 'КОМПАНИЯ ДВЕ ЕООД',
      kind: 'shares',
      detail: '30%',
      timing: 'annual',
      seat: 'Пловдив',
      controlHash: 'H2',
    },
  ];
  fs.writeFileSync(
    path.join(STAGING, 'holdings.jsonl'),
    holdings.map((h) => JSON.stringify(h)).join('\n') + '\n',
  );
  fs.writeFileSync(path.join(STAGING, 'related.jsonl'), '');
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('same xmlFile in different folders → two declarations, each winner to its OWN official (no collision)', () => {
  runLoad();
  const db = open();

  // Both declarations survive — the bare-key collapse would drop the second under INSERT OR IGNORE.
  const decls = db.prepare('SELECT COUNT(*) AS n FROM declarations').get();
  assert.equal(decls.n, 2, 'both folder-distinct declarations persisted');

  // Each winner is attributed to the correct, distinct official — never both to the first one.
  const linkFor = (eik) =>
    db.prepare('SELECT person_id, status FROM interest_links WHERE eik = ?').get(eik);
  const one = linkFor('100000001');
  const two = linkFor('200000002');
  assert.ok(one, 'winner ЕДНО has a link');
  assert.ok(two, 'winner ДВЕ has a link');
  assert.equal(one.status, 'published');
  assert.equal(two.status, 'published');
  assert.notEqual(
    one.person_id,
    two.person_id,
    'the two winners belong to two different officials — no cross-folder mis-attribution',
  );

  // And each person_id resolves to the right name via their own declaration.
  const nameOf = (pid) => db.prepare('SELECT name FROM persons WHERE id = ?').get(pid).name;
  assert.equal(nameOf(one.person_id), 'Иван Първи Тестов');
  assert.equal(nameOf(two.person_id), 'Петър Втори Пробен');
});
