import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { planSchema, readMigrations } from './release-schema.mjs';

// The two ownership tables were created only by the ETL (scripts/seed-state-owned.sql, scripts/normalize-raw.sql,
// apps/etl/src/public-ownership.ts) before migrations 0029 and 0030 gave them a place in the chain. A served
// database therefore may already hold both, only the curated one (a slice derive runs seed-state-owned.sql
// but not normalize-raw.sql), or neither. The release planner marks a file whose objects are all there,
// applies one whose objects are all missing, and refuses one that is only partly there — so each table is its
// own file, and none of the three states may block a release.

const migrations = readMigrations();
const NEW = ['0029_state_owned_eik.sql', '0030_public_owned_eik.sql'];
const chain = migrations.filter((m) => !NEW.includes(m.name));
const ledger = chain.map((m) => m.name);

// As the ETL writes them (apps/etl/src/public-ownership.ts), not as the migrations do.
const ETL_STATE = `CREATE TABLE IF NOT EXISTS state_owned_eik (
    eik TEXT PRIMARY KEY,
    ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('state', 'municipal', 'mixed')),
    canonical_name TEXT NOT NULL)`;
const ETL_PUBLIC = `CREATE TABLE IF NOT EXISTS public_owned_eik (
    eik TEXT PRIMARY KEY,
    ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('state', 'municipal')))`;

/** A database at 0028 (every earlier file recorded in its ledger) plus whatever the ETL added. */
function planFor(...etlSql) {
  const db = new DatabaseSync(':memory:');
  try {
    for (const m of chain) db.exec(m.sql);
    for (const sql of etlSql) db.exec(sql);
    const rows = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all();
    const plan = planSchema({ migrations, rows, ledger });
    return {
      plan,
      actions: Object.fromEntries(
        plan.steps.filter((s) => NEW.includes(s.name)).map((s) => [s.name, s.action]),
      ),
    };
  } finally {
    db.close();
  }
}

test('marks both files on a database whose ETL already created both tables', () => {
  const { plan, actions } = planFor(ETL_STATE, ETL_PUBLIC);
  assert.deepEqual(actions, { [NEW[0]]: 'mark', [NEW[1]]: 'mark' });
  assert.equal(plan.ok, true, plan.refusals.join('; '));
});

test('marks the curated table and applies the other where only a slice derive has run', () => {
  const { plan, actions } = planFor(ETL_STATE);
  assert.deepEqual(actions, { [NEW[0]]: 'mark', [NEW[1]]: 'apply' });
  assert.equal(plan.ok, true, plan.refusals.join('; '));
});

test('applies both files on a database no import has reached', () => {
  const { plan, actions } = planFor();
  assert.deepEqual(actions, { [NEW[0]]: 'apply', [NEW[1]]: 'apply' });
  assert.equal(plan.ok, true, plan.refusals.join('; '));
});
