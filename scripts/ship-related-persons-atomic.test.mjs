import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { runShip, TABLES, WIPE_ORDER, insertStatements } from './ship-related-persons.mjs';
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

test('a document whose id moved to a merged person promotes past its secondary unique key', () => {
  const db = database();
  db.exec(`INSERT INTO persons(id,name) VALUES('old','Old');
    INSERT INTO declarations(id,person_id,xml_file,control_hash,folder_year,declared_year,template,category,institution,position,source_url)
      VALUES('d:old','old','x.xml','h','2025','2024','assets','','И','П','u')`);
  const rows = {
    persons: [{ id: 'new', name: 'New', created_at: '2026-01-01' }],
    declarations: [
      {
        id: 'd:new',
        person_id: 'new',
        xml_file: 'x.xml',
        control_hash: 'h',
        folder_year: '2025',
        declared_year: '2024',
        template: 'assets',
        category: '',
        institution: 'И',
        position: 'П',
        source_url: 'u',
      },
    ],
  };
  runShip({
    tables: TABLES,
    maxStatements: 25,
    paceMs: 0,
    sleep: () => {},
    readTable(table) {
      const cols = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
      const r = rows[table] ?? [];
      return { rowCount: r.length, statements: insertStatements(table, cols, r) };
    },
    apply: (_name, sql) => db.exec(sql),
    readCounts: (expected) =>
      Object.fromEntries(
        Object.keys(expected).map((t) => [t, db.prepare(`SELECT count(*) n FROM "${t}"`).get().n]),
      ),
  });
  assert.deepEqual(
    db
      .prepare('SELECT id, person_id FROM declarations')
      .all()
      .map((r) => ({ ...r })),
    [{ id: 'd:new', person_id: 'new' }],
  );
  assert.deepEqual(
    db
      .prepare('SELECT id FROM persons')
      .all()
      .map((r) => r.id),
    ['new'],
  );
  db.close();
});

test('identity publication can replace source projections and FTS within the same transaction', () => {
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
    apply: (_name, sql) => db.exec(sql),
    readCounts: (expected) =>
      Object.fromEntries(
        Object.keys(expected).map((t) => [t, db.prepare(`SELECT count(*) n FROM "${t}"`).get().n]),
      ),
  });
  assert.equal(
    db.prepare("SELECT ref FROM search_index WHERE search_index MATCH 'New'").get().ref,
    'new',
  );
  assert.equal(db.prepare('SELECT id FROM persons').get().id, 'new');
  db.close();
});
