import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  formatPlan,
  markSql,
  normalizeSql,
  planSchema,
  readMigrations,
  runApply,
} from './release-schema.mjs';

const migrations = readMigrations();
const named = (name) => migrations.find((m) => m.name === name).sql;
const actions = (plan) =>
  Object.fromEntries(
    ['recorded', 'mark', 'apply', 'refuse'].map((a) => [
      a,
      plan.steps.filter((s) => s.action === a).map((s) => s.name),
    ]),
  );
const names = migrations.map((m) => m.name);

/** A database built by the given SQL, as its sqlite_master reads. */
function shaped(...sqls) {
  const db = new DatabaseSync(':memory:');
  try {
    for (const sql of sqls) db.exec(sql);
    return db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all();
  } finally {
    db.close();
  }
}

// The schema Stage was built from: 0000 as edited in July, with the ordering-unit columns written into
// the CREATE TABLE statements and the joint-procurement tables beside them, then every later file applied
// by the old deploy steps — and an empty ledger.
const editedInit =
  named('0000_init.sql')
    .replace(
      '  authority_id    TEXT NOT NULL REFERENCES authorities(id),\n',
      '  authority_id    TEXT NOT NULL REFERENCES authorities(id),\n  ordering_unit_name TEXT,\n',
    )
    .replace(
      '  bidder_id        TEXT NOT NULL REFERENCES bidders(id),\n',
      '  bidder_id        TEXT NOT NULL REFERENCES bidders(id),\n  ordering_unit_name TEXT,\n',
    ) + named('0025_joint_procurement_and_ordering_unit.sql').replace(/^ALTER TABLE .*$/gm, '');
const stageShape = () => shaped(editedInit, ...migrations.slice(1, -1).map((m) => m.sql));

test('a database as production holds it: 0000 recorded, every later migration applied', () => {
  const plan = planSchema({
    migrations,
    rows: shaped(named('0000_init.sql')),
    ledger: ['0000_init.sql'],
  });
  assert.equal(plan.ok, true, formatPlan(plan));
  assert.deepEqual(actions(plan), {
    recorded: ['0000_init.sql'],
    mark: [],
    apply: names.slice(1),
    refuse: [],
  });
});

test('a database as Stage holds it: every migration marked, the data-only one applied, column order aside', () => {
  const plan = planSchema({ migrations, rows: stageShape(), ledger: [] });
  assert.equal(plan.ok, true, formatPlan(plan));
  const result = actions(plan);
  assert.deepEqual(result.apply, ['0019_registry_scoped_birthdates.sql']);
  assert.deepEqual(
    result.mark,
    names.filter((n) => !n.startsWith('0019_')),
  );
  assert.equal(
    plan.steps.find((s) => s.action === 'apply').dataOnly,
    true,
    'a migration with no schema of its own is told apart',
  );
});

test('an empty database takes the whole chain', () => {
  const plan = planSchema({ migrations, rows: [], ledger: [] });
  assert.equal(plan.ok, true, formatPlan(plan));
  assert.deepEqual(actions(plan).apply, names);
});

test('a migration that is only partly on the target is refused, not guessed', () => {
  const rows = stageShape().filter((r) => r.name !== 'authority_joint_participation');
  const plan = planSchema({ migrations, rows, ledger: [] });
  assert.equal(plan.ok, false);
  assert.deepEqual(actions(plan).refuse, ['0025_joint_procurement_and_ordering_unit.sql']);
  assert.match(
    plan.refusals[0],
    /partly on the target — present: .*table:contract_co_authorities.*absent: table:authority_joint_participation/,
  );
  assert.match(formatPlan(plan), /REFUSED — nothing was written/);
});

test('a ledger that records a migration whose objects are missing is refused', () => {
  const plan = planSchema({
    migrations,
    rows: shaped(named('0000_init.sql')),
    ledger: ['0000_init.sql', '0001_flow_pairs_bidder_index.sql'],
  });
  assert.equal(plan.ok, false);
  assert.match(
    plan.refusals.join('\n'),
    /0001_flow_pairs_bidder_index\.sql is in the ledger, but the target lacks: index:idx_flow_pairs_bidder/,
  );
});

test('an object with the same name and another definition is not the migration’s object', () => {
  const rows = shaped(
    named('0000_init.sql'),
    'CREATE INDEX idx_flow_pairs_bidder ON flow_pairs(authority_id);',
  );
  const plan = planSchema({ migrations, rows, ledger: ['0000_init.sql'] });
  assert.equal(plan.ok, false);
  assert.deepEqual(actions(plan).refuse, ['0001_flow_pairs_bidder_index.sql']);
  assert.match(plan.refusals[0], /different: index:idx_flow_pairs_bidder/);
});

test('a ledger entry that is no migration of this release is refused', () => {
  const plan = planSchema({
    migrations,
    rows: shaped(named('0000_init.sql')),
    ledger: ['0000_init.sql', '0099_from_elsewhere.sql'],
  });
  assert.equal(plan.ok, false);
  assert.match(plan.refusals.join('\n'), /records 0099_from_elsewhere\.sql/);
});

test('Cloudflare’s own tables and the operations’ tables beside the schema do not count against parity', () => {
  const rows = shaped(
    ...migrations.map((m) => m.sql),
    'CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;',
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP);',
    'CREATE TABLE rp_generation (run_id TEXT PRIMARY KEY, published_at TEXT NOT NULL);',
  );
  const plan = planSchema({ migrations, rows, ledger: names });
  assert.equal(plan.ok, true, formatPlan(plan));
  assert.deepEqual(plan.parity.extra, [
    'table:rp_generation',
    'column:rp_generation.run_id',
    'column:rp_generation.published_at',
  ]);
  assert.match(formatPlan(plan), /beside the schema \(not compared\): table:rp_generation/);
});

test('a column that differs from the chain fails parity', () => {
  const rows = shaped(
    ...migrations.map((m) =>
      m.sql.replace(
        "value_flag       TEXT NOT NULL DEFAULT 'ok'",
        "value_flag TEXT NOT NULL DEFAULT 'review'",
      ),
    ),
  );
  const plan = planSchema({ migrations, rows, ledger: names });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.parity.different, ['column:contracts.value_flag']);
});

test('the marks are one idempotent file', () => {
  const db = new DatabaseSync(':memory:');
  const sql = markSql(['0001_a.sql', "0002_it's.sql"]);
  db.exec(sql);
  db.exec(sql);
  assert.deepEqual(
    db
      .prepare('SELECT name FROM d1_migrations ORDER BY id')
      .all()
      .map((r) => r.name),
    ['0001_a.sql', "0002_it's.sql"],
  );
});

test('DDL compares without comments, quoting, case or IF NOT EXISTS', () => {
  assert.equal(
    normalizeSql('CREATE INDEX IF NOT EXISTS "ix" -- why\n ON  t ( a ,b );'),
    normalizeSql('create index ix on t(a, b)'),
  );
});

/** A target the apply sequence drives: a real schema in memory and a ledger, with every call recorded. */
function fakeTarget(sqls, ledger, { failApplyOnce = false } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const sql of sqls) db.exec(sql);
  const calls = [];
  let failed = false;
  return {
    calls,
    target: {
      read: () => ({
        rows: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all(),
        ledger: [...ledger],
      }),
      restorePoint: () => {
        calls.push('restorePoint');
        return 'bookmark-1';
      },
      mark: (list) => {
        calls.push(`mark ${list.length}`);
        ledger.push(...list);
      },
      applyMigrations: () => {
        calls.push('apply');
        for (const m of migrations)
          if (!ledger.includes(m.name)) {
            db.exec(m.sql);
            ledger.push(m.name);
            if (failApplyOnce && !failed) {
              failed = true;
              throw new Error('Not currently importing anything');
            }
          }
      },
    },
  };
}
const quiet = () => {};

test('apply on a database as production holds it: restore point, then the migrations, then parity', () => {
  const t = fakeTarget([named('0000_init.sql')], ['0000_init.sql']);
  const result = runApply({ migrations, target: t.target, log: quiet });
  assert.deepEqual(t.calls, ['restorePoint', 'apply']);
  assert.equal(result.bookmark, 'bookmark-1');
  assert.deepEqual(result.applies, names.slice(1));
});

test('apply on a database as Stage holds it: the marks first, then the one data-only file', () => {
  const ledger = [];
  const t = fakeTarget([editedInit, ...migrations.slice(1, -1).map((m) => m.sql)], ledger);
  const result = runApply({ migrations, target: t.target, log: quiet });
  assert.deepEqual(t.calls, ['restorePoint', `mark ${names.length - 1}`, 'apply']);
  assert.deepEqual(result.applies, ['0019_registry_scoped_birthdates.sql']);
  assert.deepEqual(ledger.slice().sort(), names);
});

test('apply with nothing to do writes nothing and takes no restore point', () => {
  const t = fakeTarget(
    migrations.map((m) => m.sql),
    [...names],
  );
  runApply({ migrations, target: t.target, log: quiet });
  assert.deepEqual(t.calls, []);
});

test('a refused plan writes nothing at all', () => {
  const t = fakeTarget(
    [named('0000_init.sql')],
    ['0000_init.sql', '0001_flow_pairs_bidder_index.sql'],
  );
  assert.throws(
    () => runApply({ migrations, target: t.target, log: quiet }),
    /refused the target; nothing was written/,
  );
  assert.deepEqual(t.calls, []);
});

test('a false error from migrations apply is answered by the ledger, not by a blind repeat', () => {
  const t = fakeTarget([named('0000_init.sql')], ['0000_init.sql'], { failApplyOnce: true });
  const lines = [];
  runApply({ migrations, target: t.target, log: (l) => lines.push(l) });
  assert.deepEqual(t.calls, ['restorePoint', 'apply', 'apply']);
  assert.match(lines.join('\n'), /migrations apply failed \(attempt 1\/3\), 24 left/);
  assert.match(lines.at(-1), /ledger complete, parity OK/);
});
