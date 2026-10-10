#!/usr/bin/env node
// The served schema through wrangler's migration ledger, and nothing else (docs/deploy.md, „Схемата“).
//
//   node scripts/release-schema.mjs plan  <database> [--local]          read only
//   node scripts/release-schema.mjs apply <database> --remote --yes     restore point → marks → apply → parity
//
// A served database used to be shaped by a hand-kept list of files, probes for single columns and a
// one-time branch for one migration, because its ledger was empty or held only 0000. Every database
// differed from the others in which of those it had seen, and a migration edited after it was applied
// reached only the databases built later. Now the ledger decides:
//
//   - a migration the ledger records must have its objects on the target;
//   - one the ledger lacks is MARKED as applied when all of its objects are already there (a database
//     shaped by the old steps), APPLIED when none of them are, and REFUSED when only some are — a half
//     applied file is not something to guess about;
//   - after all of it the target's schema must match the one the migration chain builds from nothing.
//
// The plan runs on a local copy of the target's schema (its sqlite_master), so it reads nothing but DDL.
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { retryD1 } from './d1-retry.mjs';
import { parseWranglerJson } from './ship-related-persons.mjs';

const root = resolve(import.meta.dirname, '..');
export const MIGRATIONS_DIR = resolve(root, 'packages/db/migrations');
/** wrangler's ledger: one row per migration file it has applied. */
export const LEDGER = 'd1_migrations';
// SQLite's and Cloudflare's own objects; neither the chain nor the plan is about them.
const OWN = /^(sqlite_|_cf_)/;

/** The migration files, in the order wrangler applies them. */
export function readMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

/** DDL as a comparable text: no comments, one space, lower case, no IF NOT EXISTS, no quoting. */
export function normalizeSql(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/["`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .replace(/;+$/, '')
    .replace(/\bif not exists\b\s*/gi, '')
    .trim()
    .toLowerCase();
}

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;

/**
 * Everything the schema says, as keys and comparable values: each table (its foreign keys and unique
 * constraints), each column (type, NOT NULL, default, primary-key position), each index, trigger and view
 * (their table and normalized DDL). Column ORDER is not part of it: a column added by ALTER sits last, one
 * written into the CREATE sits where it was written, and the two are the same column.
 */
export function snapshot(db) {
  const objects = db
    .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL')
    .all();
  const virtual = objects
    .filter((o) => o.type === 'table' && /^create virtual table/i.test(o.sql))
    .map((o) => o.name);
  // A full-text table keeps its index in shadow tables SQLite creates and names after it.
  const shadow = (name) => virtual.some((v) => name.startsWith(`${v}_`));
  const out = new Map();
  for (const o of objects) {
    if (OWN.test(o.name) || o.name === LEDGER || shadow(o.name)) continue;
    if (o.type !== 'table') {
      out.set(`${o.type}:${o.name}`, `${o.tbl_name}|${normalizeSql(o.sql)}`);
      continue;
    }
    if (virtual.includes(o.name)) {
      out.set(`table:${o.name}`, normalizeSql(o.sql));
      continue;
    }
    const t = quote(o.name);
    const fks = db
      .prepare(`PRAGMA foreign_key_list(${t})`)
      .all()
      .map((f) => `${f.from}>${f.table}.${f.to}:${f.on_update}:${f.on_delete}`)
      .sort();
    const uniques = db
      .prepare(`PRAGMA index_list(${t})`)
      .all()
      .filter((i) => i.origin === 'u')
      .map((i) =>
        db
          .prepare(`PRAGMA index_info(${quote(i.name)})`)
          .all()
          .map((c) => c.name)
          .join(','),
      )
      .sort();
    out.set(`table:${o.name}`, `fk[${fks.join(' ')}] unique[${uniques.join(' ')}]`);
    for (const c of db.prepare(`PRAGMA table_info(${t})`).all())
      out.set(
        `column:${o.name}.${c.name}`,
        `${String(c.type).toUpperCase()}|${c.notnull}|${c.dflt_value ?? ''}|${c.pk}`,
      );
  }
  return out;
}

/** What each migration does to the schema the chain has built before it, and the schema it ends with. */
export function migrationEffects(migrations) {
  const db = new DatabaseSync(':memory:');
  try {
    let before = snapshot(db);
    const effects = migrations.map((m) => {
      try {
        db.exec(m.sql);
      } catch (error) {
        throw new Error(`${m.name} does not apply over the migrations before it: ${error.message}`);
      }
      const after = snapshot(db);
      // value after the migration; undefined = the migration removed the object
      const changes = new Map();
      for (const [k, v] of after) if (before.get(k) !== v) changes.set(k, v);
      for (const k of before.keys()) if (!after.has(k)) changes.set(k, undefined);
      before = after;
      return { ...m, changes };
    });
    return { effects, final: before };
  } finally {
    db.close();
  }
}

/** A local database with the target's schema and no rows, from the target's sqlite_master. */
export function targetDatabase(rows) {
  const db = new DatabaseSync(':memory:');
  const objects = rows.filter((r) => r.sql && !OWN.test(r.name) && r.name !== LEDGER);
  const virtual = objects.filter((o) => o.type === 'table' && /^create virtual table/i.test(o.sql));
  const rank = { table: 1, index: 2, view: 3, trigger: 4 };
  const ordered = [
    ...virtual,
    ...objects.filter((o) => !virtual.includes(o)).sort((a, b) => rank[a.type] - rank[b.type]),
  ];
  for (const o of ordered) {
    // The virtual table has already created its shadow tables.
    if (
      o.type === 'table' &&
      !virtual.includes(o) &&
      virtual.some((v) => o.name.startsWith(`${v.name}_`))
    )
      continue;
    db.exec(o.sql);
  }
  return db;
}

/**
 * The plan for one target: for every migration, `recorded` (the ledger has it), `mark` (its objects are
 * all there), `apply` (none of them are) or a refusal; then the parity of the result with the chain.
 * `rows` is the target's sqlite_master, `ledger` the names its ledger holds. Pure — unit-tested.
 */
export function planSchema({ migrations, rows, ledger }) {
  const { effects, final } = migrationEffects(migrations);
  const target = targetDatabase(rows);
  const recorded = new Set(ledger);
  const steps = [];
  const refusals = [];
  try {
    for (const m of effects) {
      // Only what the chain still holds at its end: an object a later migration changes or drops is
      // that later migration's to account for.
      const expected = [...m.changes].filter(([k, v]) => final.get(k) === v);
      const now = snapshot(target);
      const state = ([k, v]) =>
        now.get(k) === v ? 'present' : !now.has(k) || v === undefined ? 'absent' : 'different';
      const states = expected.map((e) => [e[0], state(e)]);
      const describe = (wanted) =>
        states
          .filter(([, s]) => s === wanted)
          .map(([k]) => k)
          .join(', ');
      if (recorded.has(m.name)) {
        if (states.some(([, s]) => s !== 'present'))
          refusals.push(
            `${m.name} is in the ledger, but the target lacks: ${[describe('absent'), describe('different')].filter(Boolean).join(', ')}`,
          );
        steps.push({ name: m.name, action: 'recorded' });
        continue;
      }
      if (expected.length && states.every(([, s]) => s === 'present')) {
        steps.push({ name: m.name, action: 'mark' });
        continue;
      }
      if (states.some(([, s]) => s !== 'absent')) {
        refusals.push(
          `${m.name} is partly on the target — present: ${describe('present') || 'none'}; ` +
            `absent: ${describe('absent') || 'none'}; different: ${describe('different') || 'none'}`,
        );
        steps.push({ name: m.name, action: 'refuse' });
        continue;
      }
      try {
        target.exec(m.sql);
      } catch (error) {
        refusals.push(`${m.name} does not apply to the target: ${error.message}`);
        steps.push({ name: m.name, action: 'refuse' });
        continue;
      }
      steps.push({ name: m.name, action: 'apply', dataOnly: expected.length === 0 });
    }
    for (const name of recorded)
      if (!migrations.some((m) => m.name === name))
        refusals.push(`the ledger records ${name}, which is not a migration file of this release`);
    const result = snapshot(target);
    const parity = {
      missing: [...final.keys()].filter((k) => !result.has(k)),
      different: [...final.keys()].filter((k) => result.has(k) && result.get(k) !== final.get(k)),
      // Tables the operations keep beside the schema (the ship's generations, a rebuild's receipts).
      extra: [...result.keys()].filter((k) => !final.has(k)),
    };
    return {
      steps,
      refusals,
      parity,
      ok: refusals.length === 0 && parity.missing.length === 0 && parity.different.length === 0,
    };
  } finally {
    target.close();
  }
}

/** The plan as lines a person reads in a deploy log. */
export function formatPlan(plan) {
  const count = (a) => plan.steps.filter((s) => s.action === a).length;
  const lines = [
    `schema plan: ${count('recorded')} recorded, ${count('mark')} to mark, ${count('apply')} to apply, ` +
      `${count('refuse')} refused`,
  ];
  for (const s of plan.steps)
    if (s.action !== 'recorded')
      lines.push(`  ${s.action.padEnd(6)} ${s.name}${s.dataOnly ? ' (data only)' : ''}`);
  for (const r of plan.refusals) lines.push(`  REFUSED: ${r}`);
  for (const k of plan.parity.missing) lines.push(`  parity: missing ${k}`);
  for (const k of plan.parity.different) lines.push(`  parity: different ${k}`);
  if (plan.parity.extra.length)
    lines.push(`  beside the schema (not compared): ${plan.parity.extra.join(', ')}`);
  lines.push(plan.ok ? 'schema plan: OK' : 'schema plan: REFUSED — nothing was written');
  return lines.join('\n');
}

/** The ledger rows that mark the given migrations as applied, in one idempotent file. */
export function markSql(names) {
  const literal = (s) => `'${String(s).replaceAll("'", "''")}'`;
  return [
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (`,
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  name TEXT UNIQUE,',
    '  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL',
    ');',
    ...names.map((n) => `INSERT OR IGNORE INTO ${LEDGER} (name) VALUES (${literal(n)});`),
    '',
  ].join('\n');
}

/**
 * The apply sequence over injected target operations, so its order and its refusals are tested without a
 * database: plan → refuse or restore point → marks → the ledger must now lack exactly the planned files →
 * `migrations apply` (repeated while files remain: the ledger makes a repeat apply only what is left) →
 * a final plan with nothing left and full parity.
 */
export function runApply({ migrations, target, log = (line) => console.log(line) }) {
  const plan = planSchema({ migrations, ...target.read() });
  log(formatPlan(plan));
  if (!plan.ok) throw new Error('the schema plan refused the target; nothing was written');
  const marks = plan.steps.filter((s) => s.action === 'mark').map((s) => s.name);
  const applies = plan.steps.filter((s) => s.action === 'apply').map((s) => s.name);
  if (!marks.length && !applies.length) {
    log('schema: the ledger already holds every migration; nothing to write');
    return { marks, applies, bookmark: null };
  }
  const bookmark = target.restorePoint();
  log(`schema: restore point ${bookmark}`);
  if (marks.length) target.mark(marks);
  const pending = migrations.map((m) => m.name).filter((n) => !target.read().ledger.includes(n));
  if (JSON.stringify(pending) !== JSON.stringify(applies))
    throw new Error(
      `after marking, the ledger lacks [${pending.join(', ')}] instead of the planned [${applies.join(', ')}]; ` +
        `restore point ${bookmark}`,
    );
  for (let attempt = 1; applies.length; attempt++) {
    try {
      target.applyMigrations();
      break;
    } catch (error) {
      const left = migrations.map((m) => m.name).filter((n) => !target.read().ledger.includes(n));
      if (!left.length) break;
      if (attempt >= 3) throw error;
      log(
        `schema: migrations apply failed (attempt ${attempt}/3), ${left.length} left: ${error.message}`,
      );
    }
  }
  const after = planSchema({ migrations, ...target.read() });
  if (!after.ok || after.steps.some((s) => s.action !== 'recorded')) {
    log(formatPlan(after));
    throw new Error(
      `the schema does not match the migrations after applying; restore point ${bookmark}`,
    );
  }
  log('schema: ledger complete, parity OK');
  return { marks, applies, bookmark };
}

/** The first JSON object in a CLI's output: pnpm and wrangler may print notices on the same stream first. */
export function parseJsonObject(out) {
  for (let i = out.indexOf('{'); i >= 0; i = out.indexOf('{', i + 1)) {
    try {
      return JSON.parse(out.slice(i));
    } catch {
      // not the payload — keep looking
    }
  }
  throw new Error(`no JSON object in: ${out.slice(0, 200)}`);
}

/** The live target through the wrangler CLI, as `deploy.yml` reaches it. */
function wranglerTarget({ database, remote, config }) {
  const where = remote ? '--remote' : '--local';
  const wrangler = (args, options = {}) =>
    execFileSync(
      'pnpm',
      ['--filter', '@sigma/web', 'exec', 'wrangler', ...args, '--config', config],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, CI: 'true' },
        ...options,
      },
    );
  const query = (sql) =>
    retryD1(
      () =>
        parseWranglerJson(
          wrangler(['d1', 'execute', database, where, '--json', '--command', sql]),
        )[0]?.results ?? [],
      { label: 'release-schema read' },
    );
  return {
    read() {
      const rows = query('SELECT type, name, tbl_name, sql FROM sqlite_master');
      const ledger = rows.some((r) => r.name === LEDGER)
        ? query(`SELECT name FROM ${LEDGER} ORDER BY id`).map((r) => r.name)
        : [];
      return { rows, ledger };
    },
    restorePoint() {
      if (!remote) return 'local (none)';
      const info = parseJsonObject(wrangler(['d1', 'time-travel', 'info', database, '--json']));
      const bookmark = info?.bookmark ?? info?.result?.bookmark;
      if (!bookmark) throw new Error('no Time Travel bookmark for the target; nothing was written');
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `Schema restore point for \`${database}\`: \`${bookmark}\`\n`,
        );
      return bookmark;
    },
    mark(names) {
      const dir = mkdtempSync(join(tmpdir(), 'sigma-schema-'));
      try {
        const file = join(dir, 'mark.sql');
        writeFileSync(file, markSql(names));
        // Idempotent (CREATE IF NOT EXISTS, INSERT OR IGNORE): a repeat after a lost answer is harmless.
        retryD1(
          () =>
            wrangler(['d1', 'execute', database, where, '--yes', '--file', file], {
              stdio: 'inherit',
            }),
          {
            label: 'release-schema mark',
          },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    applyMigrations() {
      wrangler(['d1', 'migrations', 'apply', database, where], { stdio: 'inherit' });
    },
  };
}

function main() {
  const [command, database, ...flags] = process.argv.slice(2);
  const has = (f) => flags.includes(f);
  const value = (f, fallback) => {
    const i = flags.indexOf(f);
    return i >= 0 && flags[i + 1] ? flags[i + 1] : fallback;
  };
  if (!['plan', 'apply'].includes(command) || !database)
    throw new Error('usage: release-schema.mjs plan|apply <database> [--remote --yes | --local]');
  const remote = !has('--local');
  if (command === 'apply' && remote && !has('--yes'))
    throw new Error('apply --remote requires --yes (it writes the target schema)');
  const target = wranglerTarget({
    database,
    remote,
    config: value('--config', 'wrangler.deploy.jsonc'),
  });
  const migrations = readMigrations();
  if (command === 'plan') {
    const plan = planSchema({ migrations, ...target.read() });
    console.log(formatPlan(plan));
    if (!plan.ok) process.exitCode = 1;
    return;
  }
  runApply({ migrations, target });
}

if (import.meta.main) main();
