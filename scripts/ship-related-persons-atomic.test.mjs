import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { runShip, TABLES, insertStatements } from './ship-related-persons.mjs';
function database() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync('packages/db/migrations').sort())
    if (f.endsWith('.sql')) db.exec(readFileSync(`packages/db/migrations/${f}`, 'utf8'));
  db.exec('PRAGMA foreign_keys=ON');
  return db;
}
test('staging interruption and failed promotion preserve the old surface; retry and empty complete replacement succeed', () => {
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
    apply(name, sql) {
      if (name === failAt) throw Error('interrupted');
      db.exec(sql);
    },
    readCounts(expected) {
      return Object.fromEntries(
        Object.keys(expected).map((t) => [t, db.prepare(`SELECT count(*) n FROM "${t}"`).get().n]),
      );
    },
  };
  failAt = 'prepare_declarations';
  assert.throws(() => runShip(opts), /interrupted/);
  assert.equal(db.prepare('SELECT id FROM persons').get().id, 'old');
  failAt = '';
  bad = true;
  assert.throws(() => runShip(opts), /NOT NULL/);
  assert.equal(db.prepare('SELECT id FROM persons').get().id, 'old');
  bad = false;
  runShip(opts);
  assert.equal(db.prepare('SELECT id FROM persons').get().id, 'new');
  runShip(opts);
  runShip({ ...opts, readTable: () => ({ rowCount: 0, statements: [] }) });
  assert.equal(db.prepare('SELECT count(*) n FROM persons').get().n, 0);
  db.close();
});
