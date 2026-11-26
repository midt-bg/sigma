import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CLEAR_ROWS,
  clearFiles,
  dataVersionSql,
  fillSlot,
  finishBuild,
  emptySlot,
  ifNotExists,
  ownershipStatements,
  parentsFirst,
  receiptSql,
  registryBatchSql,
  registryTables,
  rehydrate,
  runRebuild,
  shippedTables,
  slotFlusher,
  slotReader,
  slotState,
  sqlite,
  UNVERIFY_SQL,
  VERIFY_ATTEMPTS,
  verifySlot,
} from './rebuild-slot.mjs';
import { BREATHER_MS, HEAVY_ROWS } from './integrity-checks.mjs';

test('the slot takes the served tables only, parents first, with DDL safe on a migrated slot', () => {
  const staging = readFileSync('scripts/work-staging-schema.sql', 'utf8');
  assert.deepEqual(
    shippedTables(
      [
        'contracts',
        'raw_contracts',
        'raw_ocds_party_screening',
        'raw_ocds_authority_keys',
        'raw_ocds_authority_moves',
        'raw_ocds_tender_selections',
        'raw_contract_admissions',
        'raw_new_synthetic_tenders',
        'raw_contract_buyer_tenders',
        'raw_previous_ocds_contract_buyers',
        'ocds_supplier_appearances',
        'ocds_tender_buyers',
        'ocds_contract_buyers',
        'synthetic_tenders_awaiting_buyer',
        'search_index',
        'search_index_data',
        'sqlite_sequence',
        '_cf_KV',
        'd1_migrations',
        'rp_prev_persons',
        'data_version',
        'persons',
        'declarations',
      ],
      staging,
    ),
    [
      'contracts',
      'ocds_supplier_appearances',
      'ocds_tender_buyers',
      'ocds_contract_buyers',
      'synthetic_tenders_awaiting_buyer',
      'search_index',
      'persons',
      'declarations',
    ],
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

test('the slot records the rules that built it, in one row', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('packages/db/migrations/0026_data_version.sql', 'utf8'));
  const write = (v) => db.exec(dataVersionSql(v));
  write({ version: 2, commit: "it's1", runId: 'run-1', builtAt: '2026-10-10T12:00:00Z' });
  write({ version: 2, commit: 'abc', runId: null, builtAt: '2026-10-11T12:00:00Z' });
  assert.deepEqual(
    db
      .prepare('SELECT id, version, source_commit, built_at, run_id FROM data_version')
      .all()
      .map((r) => ({ ...r })),
    [{ id: 1, version: 2, source_commit: 'abc', built_at: '2026-10-11T12:00:00Z', run_id: null }],
  );
  assert.throws(() => dataVersionSql({ version: 0, builtAt: 'x' }), /Invalid data version/);
  assert.throws(() => dataVersionSql({ version: '2', builtAt: 'x' }), /Invalid data version/);
});

// A slot and a finished snapshot, both shaped by the migrations, the snapshot with a few rows. The slot is
// reached through the same seams as D1: `apply` runs a file, `answer` one read — the latter failing as D1
// does when it is overloaded, as often as a test asks.
const OVERLOADED =
  'D1 DB is overloaded. Too many resources consumed within a 10 second window. [code: 7429]';
function builtSlot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-verify-'));
  const snapshot = join(dir, 'snap.sqlite');
  const source = new DatabaseSync(snapshot);
  const slot = new DatabaseSync(':memory:');
  t.after(() => {
    slot.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const file of readdirSync('packages/db/migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join('packages/db/migrations', file), 'utf8');
    source.exec(sql);
    slot.exec(sql);
  }
  source.exec(`INSERT INTO authorities (id, name) VALUES ('auth:test', 'Община Тест');
    INSERT INTO bidders (id, name) VALUES ('bidder:test', 'ТЕСТ ГРУП ЕООД');`);
  source.close();
  const sent = [];
  const retried = [];
  let failures = 0;
  let gaps = 0;
  const reads = { count: 0 };
  return {
    dir,
    snapshot,
    slot,
    sent,
    retried,
    reads,
    /** The next `n` reads fail as an overloaded D1 does. */
    overload: (n) => (failures = n),
    /** The next `n` counts come back without a row, or with a count missing, as wrangler can answer. */
    truncate: (n) => (gaps = n),
    apply: (label, sql) => {
      sent.push(label);
      slot.exec(sql);
    },
    read: (_, sql) => slot.prepare(sql).all(),
    reader: (name = 'sigma-test') =>
      slotReader(name, {
        answer: (_, sql) => {
          reads.count++;
          if (failures > 0) {
            failures--;
            throw new Error(OVERLOADED);
          }
          const results = slot.prepare(sql).all();
          if (gaps > 0 && sql.startsWith('SELECT (SELECT COUNT(*)')) {
            const [row] = results;
            delete row[Object.keys(row)[gaps-- % 2 ? 0 : 1]];
            return { results: gaps % 2 ? [] : [row], meta: { rows_read: 1 } };
          }
          return { results, meta: { rows_read: 1 } };
        },
        sleep: () => {},
        log: (line) => retried.push(JSON.parse(line)),
      }),
    stamp: () =>
      slot
        .prepare('SELECT version, source_commit, run_id FROM data_version')
        .all()
        .map((r) => ({ ...r })),
    receipts: () =>
      Object.fromEntries(
        slot
          .prepare('SELECT stage, run_id FROM rebuild_state ORDER BY stage')
          .all()
          .map((r) => [r.stage, r.run_id]),
      ),
  };
}
const passes = async () => [{ name: 'test', ok: true, skipped: false }];
const build = (s, extra = {}) =>
  finishBuild('sigma-test', s.snapshot, s.dir, {
    apply: s.apply,
    read: s.read,
    verifyRead: s.reader(),
    runId: 'run-build',
    version: 7,
    commit: 'c0ffee1',
    check: passes,
    ...extra,
  });

test('a verification D1 refuses for a while still finishes the build and stamps the slot once', async (t) => {
  const s = builtSlot(t);
  s.overload(2);
  const result = await build(s);
  assert.equal(result.version, 7);
  assert.equal(result.rows, 2);
  assert.equal(s.retried.length, 2, 'two reads were refused and tried again');
  assert.ok(s.retried.every((e) => e.event === 'd1_call_retried' && e.error === OVERLOADED));
  assert.equal(s.sent.filter((l) => l === 'data-version').length, 1, 'stamped once');
  assert.equal(s.sent.indexOf('state-ship'), s.sent.indexOf('data-version') - 1);
  assert.deepEqual(s.stamp(), [{ version: 7, source_commit: 'c0ffee1', run_id: 'run-build' }]);
  assert.deepEqual(s.receipts(), { ship: 'run-build', verify: 'run-build' });
});

test('an incomplete count is a failed read and is read again, not a difference', async (t) => {
  const s = builtSlot(t);
  s.truncate(2);
  const result = await build(s);
  assert.equal(result.version, 7);
  assert.equal(s.retried.length, 2);
  assert.ok(s.retried.every((e) => e.error.startsWith('Incomplete answer from sigma-test')));
  assert.deepEqual(s.stamp(), [{ version: 7, source_commit: 'c0ffee1', run_id: 'run-build' }]);

  // Past the bound it is still no verdict on the slot: the build fails on the read, and leaves no stamp.
  const short = builtSlot(t);
  short.truncate(VERIFY_ATTEMPTS);
  await assert.rejects(build(short), /Incomplete answer/);
  assert.deepEqual(short.stamp(), []);
});

test('a verification D1 refuses past the bound leaves no stamp, and a verification on its own stamps it', async (t) => {
  const s = builtSlot(t);
  s.overload(VERIFY_ATTEMPTS);
  await assert.rejects(build(s), new RegExp(OVERLOADED.slice(0, 20)));
  assert.equal(s.retried.length, VERIFY_ATTEMPTS - 1, 'the bound holds');
  assert.deepEqual(s.stamp(), [], 'no version without a verification that passed');
  assert.deepEqual(s.receipts(), { ship: 'run-build' }, 'the ship stays for a later verification');

  // The same slot, later, by code that already computes a newer version: nothing is built again, and the
  // slot carries the version and the commit of the build that shipped it, not of the code that verified.
  const sentBefore = s.sent.length;
  const result = await verifySlot('sigma-test', {
    read: s.reader(),
    apply: s.apply,
    runId: 'run-verify',
    check: passes,
  });
  assert.deepEqual(s.sent.slice(sentBefore), ['data-version'], 'only the stamp is written');
  assert.equal(result.version, 7);
  assert.deepEqual(s.stamp(), [{ version: 7, source_commit: 'c0ffee1', run_id: 'run-build' }]);
  assert.deepEqual(s.receipts(), { ship: 'run-build', verify: 'run-verify' });
  const detail = JSON.parse(
    s.slot.prepare("SELECT detail FROM rebuild_state WHERE stage='verify'").get().detail,
  );
  assert.deepEqual(detail, {
    shipRun: 'run-build',
    version: 7,
    tables: detail.tables,
    rows: 2,
    checks: 1,
  });
});

test('a real failure is not tried again and leaves no version', async (t) => {
  // The snapshot holds no contracts: the integrity gate's own verdict, not a fault of D1.
  const empty = builtSlot(t);
  await assert.rejects(build(empty, { check: undefined }), /integrity gate failed: .*non-empty/);
  assert.deepEqual(empty.retried, []);
  assert.deepEqual(empty.stamp(), []);
  assert.ok(!('verify' in empty.receipts()));

  // A slot that lost a row after the ship.
  const lost = builtSlot(t);
  lost.overload(VERIFY_ATTEMPTS);
  await assert.rejects(build(lost));
  lost.slot.exec("DELETE FROM bidders WHERE id='bidder:test'");
  const readsBefore = lost.reads.count;
  await assert.rejects(
    verifySlot('sigma-test', { read: lost.reader(), apply: lost.apply, runId: 'r', check: passes }),
    /Slot counts differ from the snapshot: bidders 0 ≠ 1/,
  );
  assert.equal(lost.retried.length, VERIFY_ATTEMPTS - 1, 'the count verdict was not retried');
  assert.ok(lost.reads.count - readsBefore <= 10, 'one read per question, none repeated');
  assert.deepEqual(lost.stamp(), []);
});

test('a verification on its own refuses a slot nothing finished shipping to', async (t) => {
  const s = builtSlot(t);
  const verify = () =>
    verifySlot('sigma-test', { read: s.reader(), apply: s.apply, runId: 'r', check: passes });
  await assert.rejects(verify(), /holds no finished ship: there is nothing to verify/);
  s.apply('state-prepare', receiptSql('prepare', 'run-build', '2026-11-26T00:00:00Z'));
  await assert.rejects(verify(), /holds no finished ship/);
  assert.deepEqual(s.stamp(), []);
});

test('a build run takes the stamp and the ship away before it writes the slot', async (t) => {
  const s = builtSlot(t);
  await build(s);
  assert.equal(s.stamp().length, 1);
  s.apply('unverify', UNVERIFY_SQL);
  assert.deepEqual(s.stamp(), [], 'the slot no longer looks verified to a deploy');
  assert.deepEqual(s.receipts(), {}, 'and a later verification finds no ship to adopt');
  // On a slot the run just prepared it is harmless.
  const fresh = builtSlot(t);
  fresh.apply('unverify', UNVERIFY_SQL);
  assert.deepEqual(fresh.receipts(), {});
});

test('the verification waits after a heavy read, and not after a light one', () => {
  const pauses = [];
  const beats = [];
  const read = slotReader('sigma-test', {
    answer: (_, sql) => ({
      results: [{ sql }],
      meta: { rows_read: sql === 'heavy' ? HEAVY_ROWS : 5 },
    }),
    sleep: (ms) => pauses.push(ms),
    beat: () => beats.push(1),
  });
  assert.deepEqual(read('light'), [{ sql: 'light' }]);
  assert.deepEqual(pauses, []);
  read('heavy');
  assert.deepEqual(pauses, [BREATHER_MS]);
  assert.equal(beats.length, 2, 'every answered read is progress of the stage');
});

test('the slot is emptied children first, without the full-text shadow tables', () => {
  // As sqlite_master lists them — parents first, the order in which they were created.
  const rows = [
    { name: 'authorities', parent: null },
    { name: 'tenders', parent: 'authorities' },
    { name: 'contracts', parent: 'tenders' },
    { name: 'contracts', parent: 'bidders' },
    { name: 'bidders', parent: null },
    { name: 'amendments', parent: null },
    { name: 'search_index', parent: null },
    { name: 'search_index_data', parent: null },
    { name: 'persons', parent: 'persons' },
  ];
  const sent = [];
  emptySlot(
    'sigma-test',
    (label, sql) => sent.push([label, sql]),
    () => rows,
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'wipe');
  const order = [...sent[0][1].matchAll(/DROP TABLE IF EXISTS "([^"]+)"/g)].map((m) => m[1]);
  const before = (a, b) => order.indexOf(a) < order.indexOf(b);
  assert.ok(before('contracts', 'tenders') && before('tenders', 'authorities'));
  assert.ok(before('contracts', 'bidders'));
  assert.ok(order.includes('search_index') && !order.includes('search_index_data'));
  assert.ok(order.includes('persons'), 'a table that references itself is dropped once');
  assert.match(sent[0][1], /^PRAGMA defer_foreign_keys=ON;\n/);
});

test('an empty slot sends nothing', () => {
  const sent = [];
  emptySlot(
    'sigma-test',
    (...args) => sent.push(args),
    () => [],
  );
  assert.deepEqual(sent, []);
});

test('a filled slot is emptied in bounded files, children first, without breaking a foreign key', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));
    CREATE TABLE rollup (a TEXT, b TEXT, n INTEGER, PRIMARY KEY (a, b)) WITHOUT ROWID;
    INSERT INTO parent VALUES (1), (2), (3);
    WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 45001)
      INSERT INTO child SELECT i, 1 + i % 3 FROM k;`);
  db.exec("INSERT INTO rollup VALUES ('x', 'y', 1), ('x', 'z', 2)");
  const files = clearFiles(
    'ship',
    ['parent', 'child', 'rollup'],
    { parent: 3, child: 45001, rollup: 2 },
    {
      rollup: ['a', 'b'],
    },
  );
  assert.deepEqual(
    files.map(([label]) => label),
    [
      'ship-clear-rollup-0',
      'ship-clear-child-0',
      'ship-clear-child-1',
      'ship-clear-child-2',
      'ship-clear-parent-0',
    ],
  );
  assert.equal(Math.ceil(45001 / CLEAR_ROWS), 3);
  for (const [, sql] of files) db.exec(`BEGIN; ${sql} COMMIT;`);
  for (const t of ['parent', 'child', 'rollup'])
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t);
  assert.deepEqual(
    clearFiles('ship', ['parent'], { parent: 0 }),
    [],
    'an empty table sends nothing',
  );
});

test('the finished build clears what the slot holds before it ships, by the slot’s own counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-fill-'));
  try {
    const snapshot = join(dir, 'snap.sqlite');
    const db = new DatabaseSync(snapshot);
    db.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1, 1), (2, 1);`);
    db.close();
    const sent = [];
    const result = fillSlot('sigma-test', snapshot, dir, {
      label: 'ship',
      apply: (label) => sent.push(label),
      read: () => [{ parent: 1, child: 25000 }],
    });
    assert.deepEqual(sent, [
      'ship-schema',
      'ship-clear-child-0',
      'ship-clear-child-1',
      'ship-clear-parent-0',
      'ship-parent-000',
      'ship-child-000',
    ]);
    assert.deepEqual(result.counts, { parent: 1, child: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the slot preserves annex and signing evidence, including unknown legacy provenance', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-slot-evidence-'));
  const snapshot = join(dir, 'snap.sqlite');
  const source = new DatabaseSync(snapshot);
  const slot = new DatabaseSync(':memory:');
  t.after(() => {
    source.close();
    slot.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const file of readdirSync('packages/db/migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join('packages/db/migrations', file), 'utf8');
    if (file.startsWith('0029')) {
      source.exec(`INSERT INTO amendments (id, natural_key, source, link_method)
        VALUES ('legacy', 'legacy', 'eop:annexes:2026-06-01', 'value_anchor')`);
    }
    source.exec(sql);
    slot.exec(sql);
  }
  source.exec(readFileSync('scripts/work-staging-schema.sql', 'utf8'));
  source.exec(`
    INSERT INTO authorities (id, name) VALUES ('auth:test', 'Test Authority');
    INSERT INTO bidders (id, name) VALUES ('bidder:test', 'Test Supplier');
    INSERT INTO tenders (id, source_id, title, authority_id, procedure_type, status)
      VALUES ('t:TEST', 'TEST', 'Test Tender', 'auth:test', 'open', 'awarded');
    INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signing_value, signing_currency_raw,
      signing_contractor_eik, signing_contractor_status, own_estimate_source)
      VALUES ('c:e:test', 't:TEST', 'bidder:test', 10000, 'EUR', 10000, 'EUR', '0000000000015', 'valid', 'eop:contracts:2026-06-01'),
        ('c:e:unverified', 't:TEST', 'bidder:test', 20000, 'EUR', 20000, 'EUR', NULL, 'unverified', 'eop:contracts:2026-06-01');
    INSERT INTO amendments (id, natural_key, source, link_method, value_anchor_kind, value_anchor_contractor_eik, contractor_id_status)
      VALUES ('direct', 'direct', 'eop:annexes:2026-06-02', 'value_anchor', 'direct', '0000000000015', 'valid'),
        ('inherited', 'inherited', 'eop:annexes:2026-06-03', 'value_anchor', 'inherited', NULL, 'absent'),
        ('unverified', 'unverified', 'eop:annexes:2026-06-03', NULL, NULL, NULL, 'unverified');
    INSERT INTO raw_amendments (source, fetched_at, contractor_eik)
      VALUES ('eop:annexes:2026-06-03', '2026-06-03', '0000000000');
    CREATE TABLE contractor_identity (eik_raw TEXT);
    INSERT INTO contractor_identity VALUES ('0000000000');`);
  fillSlot('sigma-test', snapshot, dir, {
    label: 'evidence',
    read: (_, sql) => slot.prepare(sql).all(),
    apply: (_, sql) => slot.exec(sql),
  });
  const compare = (sql) => assert.deepEqual(slot.prepare(sql).all(), source.prepare(sql).all());
  compare(
    'SELECT id, value_anchor_kind, value_anchor_contractor_eik, contractor_id_status FROM amendments ORDER BY id',
  );
  compare(
    'SELECT id, signing_currency_raw, signing_contractor_eik, signing_contractor_status FROM contracts ORDER BY id',
  );
  compare("SELECT sql FROM sqlite_schema WHERE name = 'idx_amendments_value_anchor'");
  assert.deepEqual(
    slot
      .prepare(
        `SELECT name FROM sqlite_schema WHERE name GLOB 'raw_*'
        OR name = 'contractor_identity'`,
      )
      .all(),
    [],
  );
  assert.deepEqual(slot.prepare('PRAGMA foreign_key_check').all(), []);
});

// The order of a run, with every stage replaced by a record of the call. `state` and `rehydrate` only read
// the slot; every other stage writes it.
const READS_ONLY = new Set(['state', 'rehydrate']);
function stages(receipts = []) {
  const calls = [];
  const op = (name, result) => async (arg) => {
    calls.push(name === 'state' ? `state(${arg})` : name);
    return result;
  };
  const ops = {
    state: op('state', new Map(receipts.map((r) => [r, null]))),
    rehydrate: op('rehydrate'),
    prepare: op('prepare'),
    unverify: op('unverify'),
    import: op('import'),
    registry: op('registry'),
    local: op('local'),
    ship: op('ship', { version: 7 }),
    verify: op('verify', { version: 7 }),
  };
  const writes = () => calls.filter((c) => !READS_ONLY.has(c.replace(/\(.*/, '')));
  return { ops, calls, writes };
}

test('a verification on its own builds nothing and empties nothing', async () => {
  for (const resume of [false, true]) {
    const run = stages(['prepare', 'import', 'registry']);
    assert.deepEqual(await runRebuild({ verify: true, resume }, run.ops), { version: 7 });
    assert.deepEqual(run.calls, ['verify'], 'not even the receipts are read');
  }
  // The container's flags are what reach it.
  const source = readFileSync('scripts/rebuild-slot.mjs', 'utf8');
  assert.match(source, /verify: process\.env\.SIGMA_REBUILD_VERIFY === '1'/);
  assert.match(source, /resume: process\.env\.SIGMA_REBUILD_RESUME === '1'/);
});

test('a fresh build empties the slot first and runs every stage', async () => {
  const run = stages();
  assert.deepEqual(await runRebuild({}, run.ops), { version: 7 });
  assert.deepEqual(run.calls, [
    'state(false)',
    'prepare',
    'unverify',
    'import',
    'registry',
    'local',
    'ship',
  ]);
});

test('a resumed build takes the stamp and the ship away before its first write, and skips what is done', async () => {
  const run = stages(['prepare', 'import', 'registry']);
  await runRebuild({ resume: true }, run.ops);
  assert.deepEqual(run.calls, ['state(true)', 'rehydrate', 'unverify', 'local', 'ship']);
  assert.equal(run.writes()[0], 'unverify', 'nothing is written before the stamp is gone');

  const afterImport = stages(['prepare', 'import']);
  await runRebuild({ resume: true }, afterImport.ops);
  assert.deepEqual(afterImport.writes(), ['unverify', 'registry', 'local', 'ship']);
});
