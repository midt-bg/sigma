import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  checkpointRun,
  shippedTables,
  slotFlusher,
  slotOps,
  slotReader,
  slotState,
  sqlite,
  UNVERIFY_SQL,
  VERIFY_ATTEMPTS,
  verdictEvent,
  verifySlot,
} from './rebuild-slot.mjs';
import { BREATHER_MS, HEAVY_ROWS } from './integrity-checks.mjs';
import { insertStatements } from './ship-related-persons.mjs';

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
    "SELECT stage, run_id, detail FROM rebuild_state WHERE run_id='run-7'": [
      { stage: 'prepare', run_id: 'run-7', detail: null },
      { stage: 'import', run_id: 'run-7', detail: '2026-09-17' },
    ],
  };
  const read = (name, sql) => answers[sql] ?? [];
  assert.deepEqual(
    [...slotState('slot', 'run-7', read).keys()],
    ['prepare', 'import'],
    'a recorded stage is not repeated',
  );
  assert.deepEqual(slotState('slot', 'run-7', read).get('import'), {
    runId: 'run-7',
    detail: '2026-09-17',
  });
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
  return flush(['222222222'])
    .then(() => {
      assert.equal(sent.length, 1);
      assert.equal(sent[0][0], 'registry-batch');
      assert.match(sent[0][1], /'222222222'/);
      assert.ok(!sent[0][1].includes('111111111'));
    })
    .then(() => flush([], 'SEAL;\n'))
    .then(() => {
      // The registry's receipt rides with its last cursors.
      assert.equal(sent.length, 2);
      assert.match(sent[1][1], /INSERT OR REPLACE INTO "registry_sync"[\s\S]*SEAL;\n$/);
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
  // The ship's receipt is no file of its own: it went in with the last rows, and the stamp came next.
  assert.ok(!s.sent.includes('state-ship'));
  assert.match(s.sent[s.sent.indexOf('data-version') - 1], /^ship-\w+-\d{3}$/);
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

test('a verdict on the slot is final, and a read that fails is not one', async (t) => {
  const s = builtSlot(t);
  const verify = (extra = {}) =>
    verifySlot('sigma-test', {
      read: s.reader(),
      apply: s.apply,
      runId: 'r',
      check: passes,
      ...extra,
    });
  const final = async (promise, message) => {
    const error = await promise.then(
      () => assert.fail('the verification passed'),
      (e) => e,
    );
    assert.match(error.message, message);
    return verdictEvent(error);
  };
  // Nothing finished shipping.
  assert.deepEqual(await final(verify(), /holds no finished ship/), {
    event: 'declarations_error',
    stage: 'verify',
    script: 'rebuild-slot',
    exitCode: 1,
    verdict: true,
  });
  s.overload(VERIFY_ATTEMPTS);
  await assert.rejects(build(s));
  // D1 refusing every read past the bound.
  s.overload(VERIFY_ATTEMPTS);
  assert.equal(await final(verify(), /overloaded/), null);
  // A broken check.
  assert.ok(await final(verify({ check: undefined }), /integrity gate failed/));
  // Any other failure of a check.
  const broken = async () => {
    throw new Error('the gate itself broke');
  };
  assert.equal(await final(verify({ check: broken }), /the gate itself broke/), null);
  // A count that differs.
  s.slot.exec("DELETE FROM bidders WHERE id='bidder:test'");
  assert.ok(await final(verify(), /counts differ/));
  assert.deepEqual(s.stamp(), []);
});

test('a slot refreshed after its ship is named as one, not as a defect of the build', async (t) => {
  const s = builtSlot(t);
  await build(s, { now: () => '2026-11-20T10:00:00.000Z' });
  // Served and refreshed since: the refresh moved its rows and stamped its time in its own format.
  s.slot.exec(`INSERT INTO bidders (id, name) VALUES ('bidder:new', 'НОВ ТЕСТ ЕООД');
    INSERT INTO data_freshness (source, as_of, rows, refreshed_at)
      VALUES ('eop', '2026-11-20', 1, '2026-11-20 16:00:00');`);
  const verify = () =>
    verifySlot('sigma-test', { read: s.reader(), apply: s.apply, runId: 'r', check: passes });
  await assert.rejects(
    verify(),
    /bidders 2 ≠ 1, data_freshness 1 ≠ 0 — the slot was refreshed \(2026-11-20 16:00:00\)/,
  );
  // A refresh stamp older than the ship says nothing of the kind.
  s.slot.exec("UPDATE data_freshness SET refreshed_at = '2026-11-20 09:00:00'");
  await assert.rejects(verify(), (error) => !/refreshed/.test(error.message));
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

test('a stage’s receipt travels in its last file, so the rows and the receipt land together', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-seal-'));
  try {
    const snapshot = join(dir, 'snap.sqlite');
    const db = new DatabaseSync(snapshot);
    db.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      CREATE TABLE empty_rollup (id INTEGER PRIMARY KEY);
      INSERT INTO parent VALUES (1);
      WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 20001)
        INSERT INTO child SELECT i, 1 FROM k;`);
    db.close();
    const sent = [];
    const sealed = [];
    fillSlot('sigma-test', snapshot, dir, {
      label: 'ship',
      apply: (label, sql) => sent.push([label, sql]),
      read: () => [{}],
      seal: (counts) => {
        sealed.push(counts);
        return 'SEAL;\n';
      },
    });
    assert.deepEqual(
      sealed,
      [{ parent: 1, child: 20001, empty_rollup: 0 }],
      'sealed once, with every count',
    );
    assert.deepEqual(
      sent.map(([label, sql]) => [label, sql.endsWith('SEAL;\n')]),
      [
        ['ship-schema', false],
        ['ship-parent-000', false],
        ['ship-child-000', false],
        ['ship-child-001', true],
      ],
      'the last chunk of the last table with rows carries it — after an empty table, too',
    );
    // A snapshot without a row still finishes the stage.
    const bare = join(dir, 'bare.sqlite');
    new DatabaseSync(bare).exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
    const bareSent = [];
    fillSlot('sigma-test', bare, dir, {
      label: 'import',
      apply: (label, sql) => bareSent.push([label, sql]),
      read: () => [{}],
      seal: () => 'SEAL;\n',
    });
    assert.deepEqual(bareSent.at(-1), ['import-seal', 'SEAL;\n']);
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

// The order of a run, with every stage replaced by a record of the call. `state`, `rehydrate` and `local`
// do not write the slot; every other stage does.
const READS_ONLY = new Set(['state', 'rehydrate', 'local']);
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
  // The completion line names the ship that passed.
  assert.match(source, /shipRun: result\.shipRun,\s+builtAt: result\.builtAt,/);
});

test('a fresh build empties the slot first and runs every stage', async () => {
  const run = stages();
  assert.deepEqual(await runRebuild({}, run.ops), { version: 7 });
  // Emptying the slot takes the stamp and the receipts with it: nothing else to take away.
  assert.deepEqual(run.calls, ['state(false)', 'prepare', 'import', 'registry', 'local', 'ship']);
});

test('a resumed build takes the stamp and the ship away right before its first write, and skips what is done', async () => {
  const run = stages(['prepare', 'import', 'registry']);
  await runRebuild({ resume: true }, run.ops);
  assert.deepEqual(run.calls, ['state(true)', 'rehydrate', 'local', 'unverify', 'ship']);
  assert.equal(run.writes()[0], 'unverify', 'nothing is written before the stamp is gone');

  const afterImport = stages(['prepare', 'import']);
  await runRebuild({ resume: true }, afterImport.ops);
  assert.deepEqual(afterImport.writes(), ['unverify', 'registry', 'ship']);
});

test('a slot that holds a finished ship is only verified, by a retry or a resume alike', async () => {
  for (const resume of [false, true]) {
    const run = stages(['prepare', 'import', 'registry', 'ship']);
    assert.deepEqual(await runRebuild({ resume }, run.ops), { version: 7 });
    assert.deepEqual(
      run.calls,
      [`state(${resume})`, 'verify'],
      'no rehydrate, no unverify, no build',
    );
  }
});

test('a resume adopts the declarations checkpoints of the run that prepared the slot, if it was the same code', () => {
  const done = (runId, detail) => new Map([['prepare', { runId, detail }]]);
  const same = JSON.stringify({ commit: 'c0ffee1' });
  assert.equal(
    checkpointRun(new Map(), 'run-b', 'c0ffee1'),
    'run-b',
    'a fresh build keeps its own',
  );
  assert.equal(
    checkpointRun(done('run-b', same), 'run-b', 'c0ffee1'),
    'run-b',
    'a retry is its own',
  );
  assert.equal(checkpointRun(done('run-a', same), 'run-b', 'c0ffee1'), 'run-a', 'a resume adopts');
  for (const [detail, commit] of [
    [JSON.stringify({ commit: 'deadbee' }), 'c0ffee1'], // a fix deployed in between
    [null, 'c0ffee1'], // prepared by code that did not record its commit
    ['not json', 'c0ffee1'],
    [same, null], // this run does not know its own commit
    [JSON.stringify({ commit: null }), null], // nor did the run that prepared the slot
  ])
    assert.equal(checkpointRun(done('run-a', detail), 'run-b', commit), 'run-b');
});

// A whole run against a real slot, through the stages main() runs (`slotOps`): only what reaches outside the
// process is replaced. The CLI applies the migrations to the slot and exports its tables as SQL; a child
// step does what its script would do to the local files — the import leaves the test corpus, the register
// writes what a test gives it and sends each batch through the real flusher, the declarations job copies its
// source into the snapshot in its first half and keeps it in its second; the sqlite3 shell runs the real
// SQL. A run can be stopped right after any stage, or inside the ship after a number of its files. What ran
// is recorded, so a test can assert what a later run did NOT do again.
function slotRun(
  s,
  { runId, stopAfter, stopInShipAfter, commit = 'c0ffee1', register, catchUp, check = passes },
) {
  const ran = [];
  const steps = [];
  let shipping = false;
  let shipFiles = 0;
  const apply = (label, sql) => {
    if (shipping && /^ship-(?!schema|clear-)/.test(label) && shipFiles++ === stopInShipAfter)
      throw new Error('container stopped inside the ship');
    s.apply(label, sql);
  };
  // Every container attempt starts from an empty work directory.
  const work = mkdtempSync(join(s.dir, 'work-'));
  const exec = (file, sql) => {
    const db = new DatabaseSync(file);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  const wrangler = (args) => {
    if (args[1] === 'migrations') {
      for (const file of readdirSync('packages/db/migrations')
        .filter((name) => name.endsWith('.sql'))
        .sort())
        s.slot.exec(readFileSync(join('packages/db/migrations', file), 'utf8'));
      return '';
    }
    if (args[1] === 'export') {
      // The live slot serves no links in these tests.
      const tables = args.flatMap((a, i) => (args[i - 1] === '--table' ? [a] : []));
      const dump = tables.flatMap((t) => {
        if (args[2] !== 'sigma-test') return [];
        const rows = s.slot.prepare(`SELECT * FROM "${t}"`).all();
        return insertStatements(t, rows.length ? Object.keys(rows[0]) : [], rows);
      });
      writeFileSync(args[args.indexOf('--output') + 1], dump.join(''));
      return '';
    }
    throw new Error(`no ${args.slice(0, 3).join(' ')} in this test`);
  };
  const step = async (name, args, env = {}) => {
    steps.push({ name, script: args[0], args, env });
    const arg = (flag) => args[args.indexOf(flag) + 1];
    if (args[0] === 'scripts/import.mjs')
      copyFileSync(s.snapshot, args.find((a) => a.startsWith('--work-db=')).slice(10));
    else if (args[0] === 'scripts/tr/rebuild-registry.mjs' && args.includes('--slot')) {
      const db = new DatabaseSync(arg('--db'));
      try {
        const eiks = register?.(db) ?? [];
        if (eiks.length) await slotFlusher(arg('--slot'), db, apply)(eiks);
      } finally {
        db.close();
      }
    } else if (args[0] === 'scripts/tr/rebuild-registry.mjs') catchUp?.(arg('--db'));
    else if (args[0] === 'scripts/related-persons-job.mjs' && args.includes('--until')) {
      mkdirSync(arg('--work-dir'), { recursive: true });
      const source = new DatabaseSync(arg('--source-db'), { readOnly: true });
      source.prepare('VACUUM INTO ?').run(join(arg('--work-dir'), 'backfill.sqlite'));
      source.close();
    }
  };
  const real = slotOps({
    target: { name: 'sigma-test' },
    live: { name: 'sigma-live' },
    runId,
    commit,
    work,
    today: '2026-11-26',
    apply,
    read: s.read,
    verifyRead: s.reader(),
    wrangler,
    step,
    sqlite: async (_label, file, sql) => exec(file, sql),
    emit: () => '',
    version: () => 7,
    check,
  });
  const ops = Object.fromEntries(
    Object.entries(real).map(([name, op]) => [
      name,
      name === 'state'
        ? op
        : async (arg) => {
            ran.push(name);
            if (name === 'ship') shipping = true;
            const result = await op(arg);
            if (stopAfter === name) throw new Error(`container stopped after ${name}`);
            return result;
          },
    ]),
  );
  // Under which run the declarations keep their checkpoints, as this run passed it to the job.
  const checkpoints = () =>
    steps.find((st) => st.script === 'scripts/related-persons-job.mjs')?.env
      .SIGMA_CHECKPOINT_RUN_ID;
  return { ops, ran, steps, checkpoints, work };
}

test('a build stopped after any stage continues at the next one and does not redo the finished ones', async (t) => {
  const order = ['prepare', 'import', 'registry', 'local', 'ship'];
  // What the next run does once the slot holds a stage's receipt. The local stages leave nothing in the
  // slot, so a stop after them costs them again; the ship is followed by its verification alone.
  const next = {
    prepare: ['rehydrate', 'unverify', 'import', 'registry', 'local', 'ship'],
    import: ['rehydrate', 'unverify', 'registry', 'local', 'ship'],
    registry: ['rehydrate', 'local', 'unverify', 'ship'],
    local: ['rehydrate', 'local', 'unverify', 'ship'],
    ship: ['verify'],
  };
  for (const stopAfter of order)
    for (const [label, flags, runId] of [
      ['the coordinator’s retry of the same run', {}, 'run-a'],
      ['an operator’s resume', { resume: true }, 'run-b'],
    ]) {
      const s = builtSlot(t);
      // The ship ends in its verification: stopped right after the ship, the container never finished it.
      if (stopAfter === 'ship') s.overload(VERIFY_ATTEMPTS);
      const first = slotRun(s, {
        runId: 'run-a',
        stopAfter: stopAfter === 'ship' ? null : stopAfter,
      });
      await assert.rejects(
        runRebuild({}, first.ops),
        stopAfter === 'ship' ? /overloaded/ : new RegExp(`stopped after ${stopAfter}`),
      );
      assert.deepEqual(first.ran, order.slice(0, order.indexOf(stopAfter) + 1));
      assert.deepEqual(s.stamp(), [], `${stopAfter}: no stamp before a verification`);

      const second = slotRun(s, { runId });
      const result = await runRebuild(flags, second.ops);
      assert.deepEqual(second.ran, next[stopAfter], `${label} after ${stopAfter}`);
      for (const finished of order.slice(0, order.indexOf(stopAfter) + 1))
        if (finished !== 'local')
          assert.ok(!second.ran.includes(finished), `${label} redid ${finished}`);
      assert.equal(result.version, 7);
      // The stamp names the run that shipped the rows it vouches for.
      const shipped = stopAfter === 'ship' ? 'run-a' : runId;
      assert.deepEqual(s.stamp(), [{ version: 7, source_commit: 'c0ffee1', run_id: shipped }]);
    }
});

test('a stop after the ship and before its verification resumes into the verification only', async (t) => {
  const s = builtSlot(t);
  s.overload(VERIFY_ATTEMPTS); // D1 does not let the verification finish
  const first = slotRun(s, { runId: 'run-a' });
  await assert.rejects(runRebuild({}, first.ops), /overloaded/);
  // Once the ship has begun, its own receipt is the only one that describes the slot.
  assert.deepEqual(s.receipts(), { ship: 'run-a' });
  const sentBefore = s.sent.length;
  const shipped = JSON.parse(
    s.slot.prepare("SELECT detail FROM rebuild_state WHERE stage='ship'").get().detail,
  );
  const resumed = slotRun(s, { runId: 'run-b' });
  const result = await runRebuild({ resume: true }, resumed.ops);
  assert.equal(result.version, 7);
  // It names the ship it verified, not the run that verified it: the operator compares these with the
  // build they started before switching to the slot.
  assert.equal(result.shipRun, 'run-a');
  assert.equal(result.builtAt, shipped.builtAt);
  assert.deepEqual(resumed.ran, ['verify']);
  assert.deepEqual(s.sent.slice(sentBefore), ['data-version'], 'nothing but the stamp is written');
  assert.deepEqual(s.receipts().ship, 'run-a', 'the ship it verified is still there');
  assert.deepEqual(s.receipts().verify, 'run-b');
});

test('a slot whose ship did not finish never passes a verification', async (t) => {
  const s = builtSlot(t);
  const first = slotRun(s, { runId: 'run-a', stopInShipAfter: 1 });
  await assert.rejects(runRebuild({}, first.ops), /inside the ship/);
  // The ship had emptied the tables the import filled: neither its receipt nor theirs stands.
  assert.equal(s.slot.prepare('SELECT COUNT(*) n FROM bidders').get().n, 0);
  assert.deepEqual(s.receipts(), {}, 'half a ship leaves nothing a resume could build on');
  // Asked to verify it, the run refuses — nothing to verify.
  await assert.rejects(
    runRebuild({ verify: true }, slotRun(s, { runId: 'run-v' }).ops),
    /holds no finished ship/,
  );
  assert.deepEqual(s.stamp(), []);
  // Resumed, it is built again from the start — never from the half-emptied slot — and only then verified.
  const resumed = slotRun(s, { runId: 'run-b' });
  await runRebuild({ resume: true }, resumed.ops);
  assert.deepEqual(resumed.ran, ['prepare', 'import', 'registry', 'local', 'ship']);
  assert.equal(s.slot.prepare('SELECT COUNT(*) n FROM bidders').get().n, 1);
  assert.equal(s.stamp().length, 1);
});

test('a fresh build after a stopped one starts clean and adopts nothing', async (t) => {
  const s = builtSlot(t);
  await assert.rejects(runRebuild({}, slotRun(s, { runId: 'run-a', stopAfter: 'ship' }).ops));
  s.overload(0);
  const fresh = slotRun(s, { runId: 'run-c' });
  await runRebuild({}, fresh.ops);
  assert.deepEqual(fresh.ran, ['prepare', 'import', 'registry', 'local', 'ship']);
  assert.deepEqual(
    s.receipts(),
    { ship: 'run-c', verify: 'run-c' },
    'the earlier run’s receipts went with the emptied slot',
  );
  assert.deepEqual(s.stamp(), [{ version: 7, source_commit: 'c0ffee1', run_id: 'run-c' }]);
});

test('a resume reads the declarations under the run that prepared the slot', async (t) => {
  const s = builtSlot(t);
  await assert.rejects(runRebuild({}, slotRun(s, { runId: 'run-a', stopAfter: 'registry' }).ops));
  const resumed = slotRun(s, { runId: 'run-b' });
  await runRebuild({ resume: true }, resumed.ops);
  assert.equal(resumed.checkpoints(), 'run-a');
  // Both halves of the job read under the same run.
  assert.deepEqual(
    resumed.steps
      .filter((st) => st.script === 'scripts/related-persons-job.mjs')
      .map((st) => [st.env.SIGMA_REBUILD, st.env.SIGMA_CHECKPOINT_RUN_ID]),
    [
      ['1', 'run-a'],
      ['1', 'run-a'],
    ],
  );
  // Code deployed in between reads them again, under its own run.
  const t2 = builtSlot(t);
  await assert.rejects(runRebuild({}, slotRun(t2, { runId: 'run-a', stopAfter: 'registry' }).ops));
  const fixed = slotRun(t2, { runId: 'run-b', commit: 'deadbee' });
  await runRebuild({ resume: true }, fixed.ops);
  assert.equal(fixed.checkpoints(), 'run-b');
  // A run that does not know its own commit adopts nothing, even from a preparer that did not know its own.
  const t3 = builtSlot(t);
  await assert.rejects(
    runRebuild({}, slotRun(t3, { runId: 'run-a', stopAfter: 'registry', commit: null }).ops),
  );
  assert.equal(
    t3.slot.prepare("SELECT detail FROM rebuild_state WHERE stage='prepare'").get().detail,
    '{"commit":null}',
  );
  const blind = slotRun(t3, { runId: 'run-b', commit: null });
  await runRebuild({ resume: true }, blind.ops);
  assert.equal(blind.checkpoints(), 'run-b');
});

test('the stages leave their receipts in the slot as a run writes them', async (t) => {
  const s = builtSlot(t);
  const at = (stage) =>
    s.slot.prepare('SELECT run_id, detail FROM rebuild_state WHERE stage=?').get(stage);
  await assert.rejects(runRebuild({}, slotRun(s, { runId: 'run-a', stopAfter: 'registry' }).ops));
  assert.deepEqual({ ...at('prepare') }, { run_id: 'run-a', detail: '{"commit":"c0ffee1"}' });
  assert.equal(at('import').run_id, 'run-a');
  assert.equal(at('registry').run_id, 'run-a');
  // The import's receipt went in with its last rows, the registry's with its last cursors.
  const labels = s.sent.slice(s.sent.indexOf('state-prepare') + 1);
  assert.match(labels[labels.length - 2], /^ship-\w+-\d{3}$/);
  assert.equal(labels.at(-1), 'registry-batch');
});

// A file into the slot that fails once a test's condition holds — before it lands, or after it landed while
// the client saw an error (wrangler can report a failure for a file D1 applied, scripts/d1-retry.mjs).
function stopAt(s, when, { landed = false } = {}) {
  const real = s.apply;
  let armed = true;
  s.apply = (label, sql) => {
    if (armed && when(label, sql)) {
      armed = false;
      if (landed) real(label, sql);
      throw new Error(`container stopped at ${label}${landed ? ', after it landed' : ''}`);
    }
    real(label, sql);
  };
}
const corpus = (s) => ({
  authorities: s.slot.prepare('SELECT COUNT(*) n FROM authorities').get().n,
  bidders: s.slot.prepare('SELECT COUNT(*) n FROM bidders').get().n,
});

for (const [label, flags, runId] of [
  ['retry', {}, 'run-a'],
  ['resume', { resume: true }, 'run-b'],
])
  test(`a stop inside the import's rows is imported again on a ${label}, without a duplicate`, async (t) => {
    const s = builtSlot(t);
    // The import's first row file lands; its second (the sealed one) does not.
    let rows = 0;
    stopAt(s, (file) => /^ship-(?!schema|clear-)/.test(file) && rows++ === 1);
    await assert.rejects(runRebuild({}, slotRun(s, { runId: 'run-a' }).ops), /stopped at ship-/);
    assert.deepEqual(Object.keys(s.receipts()), ['prepare']);
    assert.equal(corpus(s).authorities + corpus(s).bidders, 1, 'half the import landed');
    const next = slotRun(s, { runId });
    await runRebuild(flags, next.ops);
    assert.deepEqual(next.ran, ['rehydrate', 'unverify', 'import', 'registry', 'local', 'ship']);
    assert.deepEqual(corpus(s), { authorities: 1, bidders: 1 });
    assert.equal(s.stamp().length, 1);
  });

test('a stop while the ship clears the slot builds again from the start', async (t) => {
  const s = builtSlot(t);
  stopAt(s, (file) => file.startsWith('ship-clear-'));
  await assert.rejects(runRebuild({}, slotRun(s, { runId: 'run-a' }).ops), /stopped at ship-clear/);
  assert.ok(s.sent.includes('ship-start'), 'the clear came after the ship began');
  assert.deepEqual(s.receipts(), {}, 'no receipt survives a ship that began');
  const next = slotRun(s, { runId: 'run-a' });
  await runRebuild({}, next.ops);
  assert.deepEqual(next.ran, ['prepare', 'import', 'registry', 'local', 'ship']);
  assert.deepEqual(corpus(s), { authorities: 1, bidders: 1 });
  assert.equal(s.stamp().length, 1);
});

test('a last file that landed while the client saw an error counts as landed', async (t) => {
  // The ship's: the retry only verifies, and the counts are exact.
  const shipped = builtSlot(t);
  stopAt(shipped, (_, sql) => sql.includes("INSERT OR REPLACE INTO rebuild_state VALUES('ship'"), {
    landed: true,
  });
  await assert.rejects(runRebuild({}, slotRun(shipped, { runId: 'run-a' }).ops), /after it landed/);
  assert.deepEqual(shipped.receipts(), { ship: 'run-a' });
  const verified = slotRun(shipped, { runId: 'run-a' });
  await runRebuild({}, verified.ops);
  assert.deepEqual(verified.ran, ['verify']);
  assert.deepEqual(corpus(shipped), { authorities: 1, bidders: 1 });
  assert.equal(shipped.stamp().length, 1);

  // The import's: the retry goes on from the registry, and the slot holds the corpus once.
  const imported = builtSlot(t);
  stopAt(
    imported,
    (_, sql) => sql.includes("INSERT OR REPLACE INTO rebuild_state VALUES('import'"),
    {
      landed: true,
    },
  );
  await assert.rejects(
    runRebuild({}, slotRun(imported, { runId: 'run-a' }).ops),
    /after it landed/,
  );
  const next = slotRun(imported, { runId: 'run-a' });
  await runRebuild({}, next.ops);
  assert.deepEqual(next.ran, ['rehydrate', 'unverify', 'registry', 'local', 'ship']);
  assert.deepEqual(corpus(imported), { authorities: 1, bidders: 1 });

  // The ship's start: nothing of the ship is trusted, the build starts over.
  const started = builtSlot(t);
  stopAt(started, (file) => file === 'ship-start', { landed: true });
  await assert.rejects(runRebuild({}, slotRun(started, { runId: 'run-a' }).ops), /after it landed/);
  assert.deepEqual(started.receipts(), {});
  const again = slotRun(started, { runId: 'run-a' });
  await runRebuild({}, again.ops);
  assert.deepEqual(again.ran, ['prepare', 'import', 'registry', 'local', 'ship']);
});

test('a verdict is the same on every new attempt, and no attempt stamps the slot', async (t) => {
  const s = builtSlot(t);
  s.overload(VERIFY_ATTEMPTS);
  await assert.rejects(runRebuild({}, slotRun(s, { runId: 'run-a' }).ops), /overloaded/);
  s.slot.exec("INSERT INTO bidders (id, name) VALUES ('bidder:other', 'ДРУГ ТЕСТ ЕООД')");
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = slotRun(s, { runId: 'run-a' });
    await assert.rejects(
      runRebuild({}, next.ops),
      /counts differ from the snapshot: bidders 2 ≠ 1/,
    );
    assert.deepEqual(next.ran, ['verify'], 'nothing is built again');
  }
  assert.deepEqual(s.stamp(), []);
});

test('a ship receipt that does not describe the slot is refused, not passed', async (t) => {
  // A ship's last file from a stopped attempt that lands late, after a fresh run prepared the slot again:
  // its receipt counts a full build the slot no longer holds.
  const s = builtSlot(t);
  await runRebuild({}, slotRun(s, { runId: 'run-a' }).ops);
  const stray = s.slot
    .prepare("SELECT done_at, detail FROM rebuild_state WHERE stage='ship'")
    .get();
  await assert.rejects(
    runRebuild({}, slotRun(s, { runId: 'run-c', stopAfter: 'import' }).ops),
    /stopped after import/,
  );
  s.slot
    .prepare('INSERT OR REPLACE INTO rebuild_state VALUES (?,?,?,?)')
    .run('ship', 'run-c', stray.done_at, stray.detail);
  s.slot.exec('DELETE FROM bidders');
  // A table only the ship's own schema file makes is missing too, which refuses it before the counts can.
  await assert.rejects(
    runRebuild({}, slotRun(s, { runId: 'run-c' }).ops),
    /no such table: state_owned_eik|counts differ from the snapshot/,
  );
  assert.deepEqual(s.stamp(), []);
});
