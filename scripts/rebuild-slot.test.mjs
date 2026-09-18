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
  registryBatchSql,
  registryTables,
  rehydrate,
  shippedTables,
  slotFlusher,
  slotState,
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

test('the slot says which stages this run already finished', () => {
  const answers = {
    "SELECT 1 AS found FROM sqlite_master WHERE name='rebuild_state'": [{ found: 1 }],
    "SELECT stage, detail FROM rebuild_state WHERE run_id='run-7'": [
      { stage: 'prepare', detail: null },
      { stage: 'import', detail: '2026-09-17' },
    ],
  };
  const read = (name, sql) => answers[sql] ?? [];
  assert.deepEqual(
    [...slotState('slot', 'run-7', read).keys()],
    ['prepare', 'import'],
    'a recorded stage is not repeated',
  );
  // A slot that has never been prepared offers nothing, and must not be queried further.
  assert.equal(slotState('slot', 'run-7', () => []).size, 0);

  // Another run's receipts are ignored unless the operator asks to resume that build.
  const asked = [];
  const readAll = (name, sql) => {
    asked.push(sql);
    return sql.startsWith('SELECT 1') ? [{ found: 1 }] : [{ stage: 'import', detail: null }];
  };
  assert.equal(slotState('slot', 'run-9', readAll).size, 1);
  assert.match(asked.at(-1), /WHERE run_id='run-9'/);
  assert.equal(slotState('slot', 'run-9', readAll, true).size, 1);
  assert.ok(!asked.at(-1).includes('WHERE'), 'a resume adopts whatever the slot holds');
});

test('a registry batch carries its rows, the queue it cleared and what it queued, and the cursors', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE registry_deeds(eik TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE registry_roles(eik TEXT, subject_id TEXT);
    CREATE TABLE registry_queue(eik TEXT PRIMARY KEY, reason TEXT, queued_at TEXT);
    CREATE TABLE registry_sync(id INTEGER PRIMARY KEY, changes_through TEXT);
    INSERT INTO registry_deeds VALUES('111111111','А ООД'),('222222222','Б ООД');
    INSERT INTO registry_roles VALUES('111111111','hash-1');
    INSERT INTO registry_queue VALUES('333333333','new','2026-09-17T10:00:00Z');
    INSERT INTO registry_sync VALUES(1,'2026-09-17');`);
  assert.deepEqual(registryTables(db), ['registry_deeds', 'registry_queue', 'registry_roles']);
  const sql = registryBatchSql(
    db,
    ['111111111'],
    ['registry_deeds', 'registry_roles'],
    ['registry_sync'],
    '2026-09-17T09:00:00Z',
  );
  assert.match(sql, /DELETE FROM registry_queue WHERE eik IN \('111111111'\);/);
  assert.match(sql, /INSERT OR REPLACE INTO "registry_deeds"[\s\S]*'111111111'/);
  assert.ok(!sql.includes('222222222'), 'only the batch travels');
  assert.match(sql, /INSERT OR REPLACE INTO "registry_queue"[\s\S]*'333333333'/);
  assert.match(sql, /DELETE FROM "registry_sync";/);
  assert.match(sql, /INSERT OR REPLACE INTO "registry_sync"/);

  // The accepted baseline is written after the last batch, so an empty batch carries the cursors alone.
  const cursorsOnly = registryBatchSql(db, [], ['registry_deeds'], ['registry_sync'], null);
  assert.ok(!cursorsOnly.includes('registry_queue'), 'no batch, no queue statement');
  assert.ok(!cursorsOnly.includes('registry_deeds'), 'no batch, no company rows');
  assert.match(cursorsOnly, /DELETE FROM "registry_sync";/);
  assert.match(cursorsOnly, /INSERT OR REPLACE INTO "registry_sync"/);

  // The flusher sends one file per batch and only asks for what the batch touched.
  const sent = [];
  const flush = slotFlusher('slot', db, (label, body) => sent.push([label, body]));
  return flush(['222222222']).then(() => {
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'registry-batch');
    assert.match(sent[0][1], /'222222222'/);
    assert.ok(!sent[0][1].includes('111111111'));
    db.close();
  });
});

test('a resumed rebuild takes the schema from the migrations and only the data from the slot', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rebuild-rehydrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'slot.sqlite');
  let exported = null;
  let asked = '';
  const tables = await rehydrate(db, 'sigma-idle', dir, {
    read: (_name, sql) => {
      asked = sql;
      // The slot also carries the rebuild's own bookkeeping, which the local schema knows nothing of.
      return [{ name: 'contracts' }, { name: 'rebuild_state' }];
    },
    wrangler: (args) => {
      exported = args;
    },
    importSql: () => {},
    sqlite: async (_label, file, sql) => {
      // The migrations really run: the local build must end up with the served schema.
      new DatabaseSync(file).exec(sql);
    },
  });
  assert.deepEqual(tables, ['contracts'], 'only tables the local schema knows travel back');
  assert.ok(exported.includes('--no-schema'), 'the slot gives rows, never its schema');
  // The virtual search index and the platform's own tables are never asked for: D1 refuses to export
  // a database that holds a virtual table, and nothing else needs them.
  for (const excluded of ["NOT LIKE 'search_index%'", "NOT LIKE '_cf_%'", "<> 'd1_migrations'"])
    assert.ok(asked.includes(excluded), `${excluded} must be excluded`);
  const local = new DatabaseSync(db, { readOnly: true });
  const names = local
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  local.close();
  assert.ok(names.includes('contracts') && names.includes('search_index'));
});
