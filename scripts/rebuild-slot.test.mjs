import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ifNotExists,
  ownershipStatements,
  parentsFirst,
  shippedTables,
  sqlite,
} from './rebuild-slot.mjs';

test('the slot takes the served tables only, parents first, with DDL safe on a migrated slot', () => {
  const staging = readFileSync('scripts/work-staging-schema.sql', 'utf8');
  assert.deepEqual(
    shippedTables(
      [
        'contracts',
        'raw_contracts',
        'search_index',
        'search_index_data',
        'sqlite_sequence',
        '_cf_KV',
        'd1_migrations',
        'rp_prev_persons',
        'persons',
        'declarations',
      ],
      staging,
    ),
    ['contracts', 'search_index', 'persons', 'declarations'],
  );
  const fks = new Map([
    ['declarations', ['persons']],
    ['interest_links', ['persons', 'bidders']],
    ['persons', []],
    ['bidders', []],
  ]);
  const order = parentsFirst(['interest_links', 'declarations', 'persons', 'bidders'], fks);
  assert.ok(order.indexOf('persons') < order.indexOf('declarations'));
  assert.ok(order.indexOf('bidders') < order.indexOf('interest_links'));
  assert.throws(
    () =>
      parentsFirst(
        ['a', 'b'],
        new Map([
          ['a', ['b']],
          ['b', ['a']],
        ]),
      ),
    /cycle/,
  );
  assert.equal(ifNotExists('CREATE TABLE persons (id)'), 'CREATE TABLE IF NOT EXISTS persons (id)');
  assert.equal(
    ifNotExists('CREATE VIRTUAL TABLE search_index USING fts5(title)'),
    'CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(title)',
  );
  assert.equal(
    ifNotExists('CREATE INDEX IF NOT EXISTS i ON t(a)'),
    'CREATE INDEX IF NOT EXISTS i ON t(a)',
  );
});

test('the refresh still carries the ownership statements the rebuild replays, and they run', () => {
  const sql = ownershipStatements(readFileSync('scripts/refresh-slice.sql', 'utf8'));
  assert.match(sql, /state_owned_eik/);
  assert.match(sql, /public_owned_eik/);
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync('packages/db/migrations').sort())
    if (f.endsWith('.sql')) db.exec(readFileSync(`packages/db/migrations/${f}`, 'utf8'));
  db.exec(readFileSync('scripts/seed-state-owned.sql', 'utf8'));
  db.exec(`CREATE TABLE public_owned_eik (eik TEXT PRIMARY KEY, ownership_kind TEXT);
    INSERT INTO public_owned_eik VALUES ('100000001','municipal');
    INSERT INTO bidders (id, name, kind, eik_normalized, eik_valid) VALUES
      ('eik:100000001','ОБЩИНСКО','company','100000001',1),('eik:121031861','ДКК','company','121031861',1),
      ('eik:200000002','ЧАСТНО','company','200000002',1);`);
  db.exec(sql);
  assert.deepEqual(
    db
      .prepare('SELECT id, ownership_kind k FROM bidders ORDER BY id')
      .all()
      .map((r) => [r.id, r.k]),
    [
      ['eik:100000001', 'municipal'],
      ['eik:121031861', 'state'],
      ['eik:200000002', null],
    ],
  );
  assert.throws(() => ownershipStatements('SELECT 1'), /ownership statements/);
});

test('a long sqlite3 statement reports progress and a failing one rejects', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rebuild-sqlite-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  process.env.SIGMA_RUN_ID = 'test-run';
  t.after(() => delete process.env.SIGMA_RUN_ID);
  const db = join(dir, 'x.sqlite');
  await sqlite(
    'precompute',
    db,
    `CREATE TABLE n AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000)
     SELECT x FROM c;`,
  );
  assert.equal(new DatabaseSync(db).prepare('SELECT count(*) n FROM n').get().n, 2000000);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'declarations_progress',
    stage: 'precompute',
    completed: 1,
  });
  await assert.rejects(sqlite('precompute', db, 'SELECT * FROM missing;'), /sqlite3 exited/);
});
