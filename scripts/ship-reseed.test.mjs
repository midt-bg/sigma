// Re-seed FK safety: ship replaces the свързани-лица tables in an already-populated D1. D1 enforces foreign
// keys, so the wipe MUST delete children before parents — the old parents-first order died at
// `DELETE FROM persons` (SQLITE_CONSTRAINT_FOREIGNKEY) on any second run, breaking every re-seed. This test
// builds a populated schema (foreign keys ON, the real 0002) and proves wipeSql() runs clean and empties
// every table, with a negative control proving a parents-first order still FK-fails.
// Run: node --test scripts/ship-reseed.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wipeSql, TABLES } from './ship-related-persons.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '..', 'packages/db/migrations/0002_related_persons_foundation.sql');

// Stub only the two 0000 tables 0002's FKs reference (bidders, authorities) — a PK column is all a FK needs —
// then apply the real 0002 and seed one row down every FK chain so a parent delete has live children.
function newPopulatedDb() {
  const dir = mkdtempSync(resolve(tmpdir(), 'ship-reseed-'));
  const db = resolve(dir, 't.sqlite');
  const setup = `PRAGMA foreign_keys=ON;
CREATE TABLE bidders(id TEXT PRIMARY KEY);
CREATE TABLE authorities(id TEXT PRIMARY KEY);
.read ${MIG}
INSERT INTO bidders(id) VALUES('eik:1');
INSERT INTO authorities(id) VALUES('auth:1');
INSERT INTO persons(id,name) VALUES('p1','П Тест');
INSERT INTO declarations(id,person_id,xml_file,folder_year,template,source_url) VALUES('d1','p1','x.xml','2024','assets','u');
INSERT INTO declared_interests(id,declaration_id,entity_raw,entity_key,kind) VALUES('di1','d1','E','e','shares');
INSERT INTO interest_links(id,link_key,person_id,bidder_id,eik,entity_key,matcher_version,publish_tier,relation,status) VALUES('il1','p1|1','p1','eik:1','1','e','v1','B_distinctive','owns','published');
INSERT INTO interest_link_authorities(link_key,authority_id,authority_name) VALUES('p1|1','auth:1','A');
INSERT INTO related_persons_internal(id,declaration_id,related_name,related_kind) VALUES('rp1','d1','X','related_person');
INSERT INTO link_suppressions(link_key,reason,suppressed_by) VALUES('p1|9','r','me');
`;
  execFileSync('sqlite3', ['-bail', db], { input: setup, stdio: 'pipe' });
  return { dir, db };
}
const run = (db, sql) =>
  execFileSync('sqlite3', ['-bail', db], {
    input: `PRAGMA foreign_keys=ON;\n${sql}`,
    stdio: 'pipe',
  });
const count = (db, t) =>
  Number(execFileSync('sqlite3', [db, `SELECT COUNT(*) FROM ${t};`], { encoding: 'utf8' }).trim());

test('re-seed wipe deletes children before parents — FK-safe on a populated D1', () => {
  const { dir, db } = newPopulatedDb();
  try {
    assert.doesNotThrow(() => run(db, wipeSql())); // the exact condition that broke the workflow: FK ON, populated
    for (const t of TABLES) assert.equal(count(db, t), 0, `${t} emptied`);
    assert.equal(count(db, 'related_persons_internal'), 0, 'internal PII table also wiped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the old parents-first delete order still FK-fails (proves the test discriminates)', () => {
  const { dir, db } = newPopulatedDb();
  try {
    const parentsFirst = TABLES.map((t) => `DELETE FROM "${t}";`).join('\n') + '\n';
    assert.throws(() => run(db, parentsFirst), /FOREIGN KEY|constraint/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
