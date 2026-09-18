import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import {
  runShip,
  schemaFromRows,
  TABLES,
  WIPE_ORDER,
  insertStatements,
} from './ship-related-persons.mjs';
function database() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync('packages/db/migrations').sort())
    if (f.endsWith('.sql')) db.exec(readFileSync(`packages/db/migrations/${f}`, 'utf8'));
  db.exec('PRAGMA foreign_keys=ON');
  return db;
}
const schemaOf = (db) => (tables) =>
  schemaFromRows(
    db
      .prepare(
        `SELECT type, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name IN (${tables.map((t) => `'${t}'`).join(',')})`,
      )
      .all(),
    tables,
  );
const countsOf = (db) => (expected) =>
  Object.fromEntries(
    Object.keys(expected).map((t) => [t, db.prepare(`SELECT count(*) n FROM "${t}"`).get().n]),
  );
test('staging interruption and a bad staged row preserve the old surface; retry and empty complete replacement succeed', () => {
  const db = database();
  db.exec("INSERT INTO persons(id,name) VALUES('old','Old')");
  let failAt = 'declarations.0';
  let bad = false;
  const opts = {
    tables: TABLES,
    maxStatements: 25,
    paceMs: 0,
    sleep: () => {},
    readTable(table) {
      const cols = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
      const rows =
        table === 'persons'
          ? [{ id: 'new', name: bad ? null : 'New', created_at: '2026-01-01' }]
          : [];
      return { rowCount: rows.length, statements: insertStatements(table, cols, rows) };
    },
    readSchema: schemaOf(db),
    apply(name, sql) {
      if (name === failAt) throw Error('interrupted');
      db.exec(sql);
    },
    readCounts: countsOf(db),
  };
  failAt = 'prepare_declarations';
  assert.throws(() => runShip(opts), /interrupted/);
  assert.equal(db.prepare('SELECT id FROM persons').get().id, 'old');
  failAt = '';
  bad = true;
  // The staged table carries the served constraints, so the bad row fails while staging.
  assert.throws(() => runShip(opts), /NOT NULL/);
  assert.equal(db.prepare('SELECT id FROM persons').get().id, 'old');
  bad = false;
  runShip(opts);
  assert.equal(db.prepare('SELECT id FROM persons').get().id, 'new');
  // The replaced generation stays for a rollback; the served child tables reference the served parents.
  assert.equal(db.prepare('SELECT id FROM rp_prev_persons').get().id, 'old');
  assert.match(
    db.prepare("SELECT sql FROM sqlite_master WHERE name='declarations'").get().sql,
    /REFERENCES "?persons"?\(id\)/,
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE name='idx_declarations_person'").get(),
  );
  runShip(opts);
  runShip({ ...opts, readTable: () => ({ rowCount: 0, statements: [] }) });
  assert.equal(db.prepare('SELECT count(*) n FROM persons').get().n, 0);
  db.close();
});

test('identity publication can replace source projections and FTS within the same batch', () => {
  const db = database();
  db.exec(
    "INSERT INTO persons(id,name) VALUES('old','Old'); INSERT INTO search_index(kind,ref,title) VALUES('official','old','Old')",
  );
  const tables = [...TABLES, 'registry_identity_observations', 'search_index'];
  runShip({
    tables,
    wipeTables: ['search_index', 'registry_identity_observations', ...WIPE_ORDER],
    maxStatements: 25,
    paceMs: 0,
    sleep: () => {},
    readTable(table) {
      const cols = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
      const rows =
        table === 'persons'
          ? [{ id: 'new', name: 'New', created_at: '2026-01-01' }]
          : table === 'search_index'
            ? [{ kind: 'official', ref: 'new', title: 'New' }]
            : [];
      return { rowCount: rows.length, statements: insertStatements(table, cols, rows) };
    },
    readSchema: schemaOf(db),
    apply: (_name, sql) => db.exec(sql),
    readCounts: countsOf(db),
  });
  assert.equal(
    db.prepare("SELECT ref FROM search_index WHERE search_index MATCH 'New'").get().ref,
    'new',
  );
  assert.equal(db.prepare('SELECT id FROM persons').get().id, 'new');
  db.close();
});
