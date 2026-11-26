#!/usr/bin/env node
// Rebuild the idle blue/green D1 slot from nothing, in one Container run (ADR-0048). Everything is built in a
// local SQLite file — the procurement corpus, the Trade Register, public ownership, the declarations and the
// search index — then the whole snapshot is shipped to the idle slot and verified there. The live slot is only
// read. The flip is a redeploy with the idle slot's id (docs/deploy.md).
//
//   SIGMA_D1_NAME/SIGMA_D1_ID           the idle slot, the only one written
//   SIGMA_LIVE_D1_NAME/SIGMA_LIVE_D1_ID the live slot, read for the published-link gate
//   SIGMA_REBUILD_RESUME=1              continue what an earlier run of the build left in the slot
//   SIGMA_REBUILD_VERIFY=1              only verify what the slot already holds, and stamp it once it passes
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { progress } from './cacbg/progress.mjs';
import {
  assertD1TargetAuthorized,
  insertStatements,
  parseWranglerJson,
  sqlIdent,
  sqlLiteral,
  wranglerFileSender,
} from './ship-related-persons.mjs';
import { importSql } from './cacbg/import-sql.mjs';
import { retryD1, sleepSync } from './d1-retry.mjs';
import { assertIntegrity, BREATHER_MS, HEAVY_ROWS } from './integrity-checks.mjs';

const root = resolve(import.meta.dirname, '..');
const webDir = resolve(root, 'apps/web');

/**
 * The slot's record of the rules that built it (packages/db/data-version.json, migration 0026), written once
 * the slot is verified. A production deploy releases only onto a slot whose version is the code's.
 */
export function dataVersionSql({ version, commit, runId, builtAt }) {
  if (!Number.isInteger(version) || version < 1)
    throw new Error(`Invalid data version: ${version}`);
  return (
    'INSERT OR REPLACE INTO data_version (id, version, source_commit, built_at, run_id) VALUES ' +
    `(1, ${version}, ${sqlLiteral(commit ?? null)}, ${sqlLiteral(builtAt)}, ${sqlLiteral(runId ?? null)});\n`
  );
}

/** Tables a served slot never takes from the snapshot: SQLite's and Cloudflare's own, the migration ledger,
 *  the full-text index's shadow tables, the work staging, the ship's generations, and the slot's own record
 *  of the rules that built it — written by the verification alone, never carried in with the rows. */
export function shippedTables(tables, stagingSql) {
  const staging = new Set(
    [...stagingSql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map((m) => m[1]),
  );
  return tables.filter(
    (t) =>
      !/^(sqlite_|_cf_|rp_next_|rp_prev_|d1_migrations$|search_index_)/.test(t) &&
      t !== 'contractor_identity' &&
      t !== 'data_version' &&
      !staging.has(t),
  );
}

/** Parents before children, by the snapshot's own foreign keys. */
export function parentsFirst(tables, foreignKeys) {
  const order = [];
  const seen = new Set();
  const visit = (t, path = []) => {
    if (seen.has(t)) return;
    if (path.includes(t)) throw new Error(`Foreign-key cycle: ${[...path, t].join(' → ')}`);
    for (const parent of foreignKeys.get(t) ?? [])
      if (parent !== t && tables.includes(parent)) visit(parent, [...path, t]);
    seen.add(t);
    order.push(t);
  };
  for (const t of tables) visit(t);
  return order;
}

/** The snapshot's DDL, safe to run on a slot the migrations already shaped. */
export const ifNotExists = (sql) =>
  sql.replace(
    /^CREATE (VIRTUAL TABLE|TABLE|UNIQUE INDEX|INDEX)\s+(?!IF NOT EXISTS)/i,
    'CREATE $1 IF NOT EXISTS ',
  );

/** The refresh's ownership statements: the curated list, then what the register shows (ADR-0047). */
export function ownershipStatements(refreshSliceSql) {
  const start = refreshSliceSql.indexOf(
    'UPDATE bidders\nSET ownership_kind = (\n  SELECT s.ownership_kind',
  );
  const end = refreshSliceSql.indexOf('INSERT OR IGNORE INTO refresh_touched_bidders', start);
  if (start < 0 || end < 0)
    throw new Error('refresh-slice.sql no longer carries the ownership statements');
  return refreshSliceSql.slice(start, end);
}

const stage = (name, completed = 0, total) => progress(name, completed, total, true);
const fail = (name, code) => {
  console.log(
    JSON.stringify({
      event: 'declarations_error',
      stage: name,
      script: 'rebuild-slot',
      exitCode: code,
    }),
  );
  process.exit(code === 75 ? 1 : code || 1);
};

/** A child step: its lines pass through, and each one counts as progress so a long load is not a stall. */
function step(name, args, extraEnv = {}) {
  stage(name);
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      ['--import', './scripts/cacbg/register-ts.mjs', ...args],
      {
        cwd: root,
        env: { ...process.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let lines = 0;
    for (const [stream, out] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ])
      createInterface({ input: stream }).on('line', (line) => {
        // The child names its own stages ('extract', 'registry'), which belong to a different order than
        // this one ('declarations'). Reported as they are, they move the coordinator's stage backwards and
        // a live step reads as a stalled one. So a child's progress travels as detail and this stage
        // stays the run's stage; anything else is simply a heartbeat of it.
        if (line.startsWith('{"event":"declarations_progress"')) {
          out.write(line.replace('"declarations_progress"', '"rebuild_detail"') + '\n');
          progress(name, ++lines);
          return;
        }
        out.write(line + '\n');
        if (!line.startsWith('{"event":"declarations_')) progress(name, ++lines);
      });
    child.on('close', (code) => (code === 0 ? done() : fail(name, code)));
  });
}

/** SQL through the sqlite3 shell. Its progress handler prints a line every ten million VM steps; each
 * counts as progress of `name`, so a long rollup is not taken for a stalled container. */
export const sqlite = (name, db, sql) =>
  new Promise((done, failed) => {
    const child = spawn('sqlite3', [db], { stdio: ['pipe', 'pipe', 'inherit'] });
    let beats = 0;
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (/^Progress \d+$/.test(line)) progress(name, ++beats);
      else process.stdout.write(line + '\n');
    });
    child.on('error', failed);
    child.on('close', (code) =>
      code === 0 ? done() : failed(new Error(`sqlite3 exited with code ${code}`)),
    );
    child.stdin.end(`.progress 10000000\n${sql}`);
  });
const wrangler = (args, output = false) =>
  execFileSync('wrangler', args, {
    cwd: webDir,
    encoding: 'utf8',
    stdio: output ? 'pipe' : 'inherit',
    maxBuffer: 256 * 1024 * 1024,
  });
/** One statement's answer from the slot: its rows and what D1 says the statement cost. */
const d1Answer = (name, sql) =>
  parseWranglerJson(
    wrangler(['d1', 'execute', name, '--remote', '--json', '--command', sql], true),
  )[0] ?? {};
const d1Json = (name, sql) => d1Answer(name, sql).results ?? [];

// The rebuild is hours long and the container can be stopped at any moment (ADR-0049). Its durable
// store is the idle slot itself: the data is going there anyway, and one file execution in D1 is one
// transaction, so a receipt written with the data cannot disagree with it.
const REBUILD_STATE_DDL =
  'CREATE TABLE IF NOT EXISTS rebuild_state (stage TEXT PRIMARY KEY, run_id TEXT NOT NULL, done_at TEXT NOT NULL, detail TEXT);';

/** A stage's receipt in the slot. */
export const receiptSql = (stage, runId, at, detail = null) =>
  `${REBUILD_STATE_DDL}\nINSERT OR REPLACE INTO rebuild_state VALUES(${sqlLiteral(stage)},${sqlLiteral(runId)},${sqlLiteral(at)},${sqlLiteral(detail)});\n`;

/**
 * Sent before a build run writes anything into the slot: the slot no longer holds what was shipped and
 * verified, so it must neither look verified to a deploy (`data_version`) nor offer the old ship to a later
 * verification. A fresh build empties the slot anyway; a resumed one would otherwise keep both.
 */
export const UNVERIFY_SQL =
  `${REBUILD_STATE_DDL}\nDELETE FROM rebuild_state WHERE stage IN ('ship','verify');\n` +
  'DELETE FROM data_version;\n';

/** What this run has already put in the slot. A slot without the table has nothing to offer. */
export function slotState(name, runId, read = d1Json, anyRun = false) {
  if (!read(name, "SELECT 1 AS found FROM sqlite_master WHERE name='rebuild_state'").length)
    return new Map();
  // By default a rebuild only trusts its own receipts: a fresh run empties the slot and starts clean.
  // An operator who asks to resume adopts what an earlier run of the same rebuild left behind.
  const where = anyRun ? '' : ` WHERE run_id=${sqlLiteral(runId)}`;
  return new Map(
    read(name, `SELECT stage, detail FROM rebuild_state${where}`).map((r) => [r.stage, r.detail]),
  );
}

/** A batch of partidas, straight into the slot: its rows, the queue entries it cleared or added, and
 * the registry's own cursors. The rebuild then resumes at the batch, not at the first partida. */
export function slotFlusher(name, snapshot, apply) {
  const tables = registryTables(snapshot);
  const cursors = ['registry_sync', 'registry_entry_state', 'registry_entry_passes'].filter((t) =>
    snapshot.prepare(`SELECT 1 FROM sqlite_master WHERE name=${sqlLiteral(t)}`).get(),
  );
  let since = null;
  const send =
    apply ??
    wranglerFileSender({
      d1Name: name,
      remote: true,
      dir: resolve(root, 'data/work/rebuild'),
      cwd: webDir,
    });
  return async (eiks) => {
    send('registry-batch', registryBatchSql(snapshot, eiks, tables, cursors, since));
    since = new Date().toISOString();
  };
}

/**
 * Empty the slot of everything but the full-text shadow tables, which SQLite owns — children first. A parent
 * dropped while its children still reference it makes D1 check every child, and in one import that does not
 * finish: the Durable Object behind the database resets (`D1_RESET_DO`) on every attempt. Measured on a Dev2
 * slot on 10.10.2026 — creation order fails, children-first passes; the ship drops its staged tables the same
 * way for the same reason.
 */
export function emptySlot(name, apply, read = d1Json) {
  const rows = read(
    name,
    `SELECT m.name AS name, f."table" AS parent FROM sqlite_master m
       LEFT JOIN pragma_foreign_key_list(m.name) f
     WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%'`,
  );
  const tables = [...new Set(rows.map((r) => r.name))].filter((n) => !/^search_index_/.test(n));
  const foreignKeys = new Map(
    tables.map((t) => [t, rows.filter((r) => r.name === t && r.parent).map((r) => r.parent)]),
  );
  const drops = parentsFirst(tables, foreignKeys)
    .reverse()
    .map((n) => `DROP TABLE IF EXISTS ${sqlIdent(n)};`);
  if (drops.length) apply('wipe', `PRAGMA defer_foreign_keys=ON;\n${drops.join('\n')}\n`);
}

/** Rows one clearing file deletes. */
export const CLEAR_ROWS = 20_000;

/**
 * The files that empty the slot's copies of `tables` (parents first, as given) — children first, table by
 * table, at most CLEAR_ROWS rows a file. One file that deleted every row of a filled slot exceeded D1's CPU
 * time limit and reset the database on every attempt (measured on Dev2, 10.10.2026, after the slot held the
 * procurement corpus and the register). `rows[t]` is how many rows the slot holds; `keys[t]` the primary key
 * of a table WITHOUT ROWID, which has no rowid to page by. A repeated file deletes what is left, or nothing.
 */
export function clearFiles(label, tables, rows, keys = {}) {
  const files = [];
  for (const t of [...tables].reverse()) {
    const pages = Math.ceil((rows[t] ?? 0) / CLEAR_ROWS);
    const key = keys[t]?.length ? keys[t].map(sqlIdent).join(', ') : 'rowid';
    const match = keys[t]?.length > 1 ? `(${key})` : key;
    for (let page = 0; page < pages; page++)
      files.push([
        `${label}-clear-${t}-${page}`,
        `PRAGMA defer_foreign_keys=ON;\nDELETE FROM ${sqlIdent(t)} WHERE ${match} IN ` +
          `(SELECT ${key} FROM ${sqlIdent(t)} LIMIT ${CLEAR_ROWS});\n`,
      ]);
  }
  return files;
}

/** Put a whole local snapshot into the slot: the snapshot's own DDL where the migrations left a gap,
 * then every table emptied children-first and filled parents-first, in chunks of twenty thousand rows.
 * Used twice — once after a long stage, so its hours are durable, and once for the finished build. */
export function fillSlot(name, snapshotPath, work, { label, apply, read = d1Json }) {
  const snap = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const master = snap
      .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL')
      .all();
    const tables = shippedTables(
      master.filter((m) => m.type === 'table').map((m) => m.name),
      readFileSync(resolve(root, 'scripts/work-staging-schema.sql'), 'utf8'),
    );
    apply(
      `${label}-schema`,
      master
        .filter((m) => tables.includes(m.tbl_name) && (m.type === 'table' || m.type === 'index'))
        .sort((a, b) => (a.type === b.type ? 0 : a.type === 'table' ? -1 : 1))
        .map((m) => `${ifNotExists(m.sql)};`)
        .join('\n') + '\n',
    );
    const foreignKeys = new Map(
      tables.map((t) => [
        t,
        snap
          .prepare(`PRAGMA foreign_key_list(${sqlIdent(t)})`)
          .all()
          .map((f) => f.table),
      ]),
    );
    const ordered = parentsFirst(tables, foreignKeys);
    // The internal related-persons table never leaves the build (ADR-0032).
    const withRows = ordered.filter((t) => t !== 'related_persons_internal');
    // What the slot already holds — nothing on a fresh slot, the corpus and the register once an earlier
    // stage made its hours durable — is deleted in bounded files, children first.
    const held = {};
    for (let i = 0; i < withRows.length; i += 20) {
      const chunk = withRows.slice(i, i + 20);
      Object.assign(
        held,
        read(
          name,
          `SELECT ${chunk.map((t) => `(SELECT COUNT(*) FROM ${sqlIdent(t)}) AS ${sqlIdent(t)}`).join(', ')}`,
        )[0] ?? {},
      );
    }
    const keys = Object.fromEntries(
      master
        .filter(
          (m) => m.type === 'table' && /WITHOUT\s+ROWID/i.test(m.sql) && withRows.includes(m.name),
        )
        .map((m) => [
          m.name,
          snap
            .prepare(`PRAGMA table_info(${sqlIdent(m.name)})`)
            .all()
            .filter((c) => c.pk > 0)
            .sort((a, b) => a.pk - b.pk)
            .map((c) => c.name),
        ]),
    );
    for (const [file, sql] of clearFiles(label, withRows, held, keys)) apply(file, sql);
    const counts = {};
    let shipped = 0;
    for (const table of withRows) {
      const cols = snap
        .prepare(`PRAGMA table_info(${sqlIdent(table)})`)
        .all()
        .map((c) => c.name);
      const n = snap.prepare(`SELECT COUNT(*) n FROM ${sqlIdent(table)}`).get().n;
      counts[table] = n;
      for (let offset = 0, part = 0; offset < n; offset += 20_000, part++) {
        const rows = snap
          .prepare(
            `SELECT ${cols.map(sqlIdent).join(',')} FROM ${sqlIdent(table)} LIMIT 20000 OFFSET ${offset}`,
          )
          .all();
        apply(
          `ship-${table}-${String(part).padStart(3, '0')}`,
          `PRAGMA defer_foreign_keys=ON;\n${insertStatements(table, cols, rows).join('')}`,
        );
        shipped += rows.length;
        progress(label === 'ship' ? 'ship' : label, shipped);
      }
    }
    return { counts, withRows, shipped };
  } finally {
    snap.close();
  }
}

/** A fresh local build with the migrations' schema and the slot's rows. */
export async function rehydrate(db, name, work, deps = {}) {
  const read = deps.read ?? d1Json;
  const run = deps.wrangler ?? wrangler;
  const load = deps.importSql ?? importSql;
  const apply = deps.sqlite ?? sqlite;
  rmSync(db, { force: true });
  const migrationsDir = resolve(root, 'packages/db/migrations');
  for (const file of readdirSync(migrationsDir)
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort())
    await apply('import', db, readFileSync(join(migrationsDir, file), 'utf8'));
  await apply('import', db, readFileSync(resolve(root, 'scripts/work-staging-schema.sql'), 'utf8'));
  // Only tables the local schema knows: the slot also carries this rebuild's own bookkeeping, and the
  // search index is a virtual table D1 refuses to export at all.
  const local = new DatabaseSync(db, { readOnly: true });
  const known = new Set(
    local
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name),
  );
  local.close();
  const tables = read(
    name,
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE '_cf_%' AND name NOT LIKE 'search_index%' AND name <> 'd1_migrations'
     ORDER BY name`,
  )
    .map((r) => r.name)
    .filter((t) => known.has(t));
  const dump = join(work, 'slot-dump.sql');
  rmSync(dump, { force: true });
  run([
    'd1',
    'export',
    name,
    '--remote',
    '--no-schema',
    ...tables.flatMap((t) => ['--table', t]),
    '--output',
    dump,
  ]);
  load(db, dump);
  rmSync(dump, { force: true });
  return tables;
}

/** The registry tables keyed by company, as the local build holds them. */
export function registryTables(snapshot) {
  return snapshot
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'registry_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name)
    .filter((name) =>
      snapshot
        .prepare(`PRAGMA table_info(${sqlIdent(name)})`)
        .all()
        .some((c) => c.name === 'eik'),
    );
}

/** Rows for one batch of companies, as statements that replace whatever the slot holds for them. */
export function registryBatchSql(snapshot, eiks, tables, cursors, since = null) {
  const list = eiks.map(sqlLiteral).join(',');
  // No batch: the cursors alone, for the accepted baseline written after the last one.
  const out = eiks.length ? [`DELETE FROM registry_queue WHERE eik IN (${list});`] : [];
  // Reading a partida can queue another company; anything queued since the last flush travels too.
  if (since) {
    const cols = snapshot
      .prepare('PRAGMA table_info(registry_queue)')
      .all()
      .map((c) => c.name);
    const added = snapshot
      .prepare(
        `SELECT ${cols.map(sqlIdent).join(',')} FROM registry_queue WHERE queued_at > ${sqlLiteral(since)} AND eik NOT IN (${list})`,
      )
      .all();
    out.push(
      ...insertStatements('registry_queue', cols, added).map((sql) =>
        sql.replace(/^INSERT INTO/, 'INSERT OR REPLACE INTO'),
      ),
    );
  }
  for (const table of [...tables, ...cursors]) {
    const cols = snapshot
      .prepare(`PRAGMA table_info(${sqlIdent(table)})`)
      .all()
      .map((c) => c.name);
    if (!cols.length) continue;
    const rows = cursors.includes(table)
      ? snapshot.prepare(`SELECT ${cols.map(sqlIdent).join(',')} FROM ${sqlIdent(table)}`).all()
      : eiks.length
        ? snapshot
            .prepare(
              `SELECT ${cols.map(sqlIdent).join(',')} FROM ${sqlIdent(table)} WHERE eik IN (${list})`,
            )
            .all()
        : [];
    if (cursors.includes(table)) out.push(`DELETE FROM ${sqlIdent(table)};`);
    out.push(
      ...insertStatements(table, cols, rows).map((sql) =>
        sql.replace(/^INSERT INTO/, 'INSERT OR REPLACE INTO'),
      ),
    );
  }
  return `PRAGMA defer_foreign_keys=ON;\n${out.join('')}`;
}

/** Reads of the slot a verification makes: how many times each one is tried, and the wait after the n-th
 *  failure — about two and a half minutes in all, well past D1's ten-second window of „overloaded“. */
export const VERIFY_ATTEMPTS = 6;
export const verifyWaitMs = (n) => 10_000 * n;

/**
 * The verification's reader. Every read is repeatable, so a read that fails is retried as every other
 * repeatable call against D1 is (`retryD1`): a failed read is not a verdict (apps/etl/src/integrity.ts). A
 * verdict — a count that differs, a check that breaks — is an answer and is never retried. After a read that
 * went through a table's worth of rows the reader waits, as the cron's gate does, so the checks do not add
 * up to the limit by themselves.
 */
export function slotReader(
  name,
  {
    answer = d1Answer,
    attempts = VERIFY_ATTEMPTS,
    waitMs = verifyWaitMs,
    sleep = sleepSync,
    log,
    beat = () => {},
  } = {},
) {
  return (sql, complete) => {
    const { results, meta } = retryD1(
      () => {
        const got = answer(name, sql);
        // An answer that lacks what was asked is a read that failed, not a verdict on the slot.
        if (complete && !complete(got.results ?? []))
          throw new Error(`Incomplete answer from ${name}: ${JSON.stringify(got.results ?? null)}`);
        return got;
      },
      {
        label: `verify ${name}`,
        attempts,
        waitMs,
        sleep,
        log,
      },
    );
    beat();
    if (Number(meta?.rows_read ?? 0) >= HEAVY_ROWS) sleep(BREATHER_MS);
    return results ?? [];
  };
}

/**
 * The verification, a stage of its own: it needs nothing but the slot, so it runs right after the ship and
 * again later on the same slot without building anything (`SIGMA_REBUILD_VERIFY=1`). The ship's receipt says
 * what the slot must hold and which rules built it; the slot is counted against it, the integrity gate runs,
 * and only then the slot gets its `data_version` — in one file with the verification's own receipt, so the
 * version exists exactly when a verification passed. The version and the commit are the build's, not those
 * of the code that verifies.
 */
export async function verifySlot(name, { read, apply, runId, check = assertIntegrity, now }) {
  const shipped =
    read("SELECT 1 AS found FROM sqlite_master WHERE name='rebuild_state'").length &&
    read("SELECT run_id, detail FROM rebuild_state WHERE stage='ship'")[0];
  if (!shipped?.detail)
    throw new Error(`${name} holds no finished ship: there is nothing to verify — build the slot`);
  const { counts, version, commit, builtAt } = JSON.parse(shipped.detail);
  const tables = Object.keys(counts);
  const served = {};
  for (let i = 0; i < tables.length; i += 20) {
    const chunk = tables.slice(i, i + 20);
    Object.assign(
      served,
      read(
        `SELECT ${chunk.map((t) => `(SELECT COUNT(*) FROM ${sqlIdent(t)}) AS ${sqlIdent(t)}`).join(', ')}`,
        // Every count asked for, as a count: a row or a key that is missing is a failed read and is
        // read again (as readShippedCounts does); only a complete answer can differ from the receipt.
        ([row]) => chunk.every((t) => Number.isInteger(row?.[t]) && row[t] >= 0),
      )[0],
    );
  }
  const mismatched = tables.filter((t) => Number(served[t]) !== counts[t]);
  if (mismatched.length)
    throw new Error(
      `Slot counts differ from the snapshot: ${mismatched.map((t) => `${t} ${served[t]} ≠ ${counts[t]}`).join(', ')}`,
    );
  const results = await check(read, { label: `rebuilt slot ${name}`, exit: false });
  const at = (now ?? (() => new Date().toISOString()))();
  const rows = Object.values(counts).reduce((a, n) => a + n, 0);
  apply(
    'data-version',
    dataVersionSql({ version, commit, runId: shipped.run_id || null, builtAt }) +
      receiptSql(
        'verify',
        runId,
        at,
        JSON.stringify({
          shipRun: shipped.run_id,
          version,
          tables: tables.length,
          rows,
          checks: results.filter((r) => !r.skipped).length,
        }),
      ),
  );
  return { version, commit, tables: tables.length, rows };
}

/**
 * The end of a build: the finished snapshot into the slot, the ship's receipt — what the slot now holds and
 * which rules built it — and the verification. A verification that fails leaves the receipt, so it can be
 * run again on its own.
 */
export async function finishBuild(
  name,
  snapshotPath,
  work,
  { apply, read = d1Json, verifyRead, runId, version, commit, check, now },
) {
  const { counts } = fillSlot(name, snapshotPath, work, { label: 'ship', apply, read });
  const at = (now ?? (() => new Date().toISOString()))();
  apply(
    'state-ship',
    receiptSql('ship', runId, at, JSON.stringify({ version, commit, builtAt: at, counts })),
  );
  stage('verify');
  return verifySlot(name, { read: verifyRead, apply, runId, check, now });
}

/**
 * The order of a run, apart from what each stage does. `ops` are the stages, each of which writes the slot
 * except `state` and `rehydrate`, which only read it:
 *
 *   state(anyRun)  the receipts in the slot (`slotState`)   prepare()  empty and shape the slot
 *   rehydrate()    the slot's rows into the local build      unverify() take the stamp and the ship away
 *   import(), registry(), local(), ship()  the build's stages; ship() ships and verifies
 *   verify()       the verification on its own
 *
 * A verification on its own builds and empties nothing. A build run takes the stamp and the ship away
 * before it writes anything a resume keeps — a fresh one by emptying the slot, which takes them along.
 */
export async function runRebuild({ verify = false, resume = false }, ops) {
  if (verify) return ops.verify();
  const done = await ops.state(resume);
  if (done.has('prepare')) await ops.rehydrate(done);
  else await ops.prepare();
  // From here on this run writes the slot: whatever an earlier run shipped and verified no longer stands.
  await ops.unverify();
  if (!done.has('import')) await ops.import();
  if (!done.has('registry')) await ops.registry();
  await ops.local();
  return ops.ship();
}

async function main() {
  const target = { name: process.env.SIGMA_D1_NAME, id: process.env.SIGMA_D1_ID };
  const live = { name: process.env.SIGMA_LIVE_D1_NAME, id: process.env.SIGMA_LIVE_D1_ID };
  if (
    !target.name ||
    !target.id ||
    !live.name ||
    !live.id ||
    target.id === live.id ||
    target.name === live.name
  )
    throw new Error(
      'A rebuild writes only the idle slot: set both slots, and never the live one as the target',
    );
  // The web config the wrangler CLI reads is rendered before any remote call: the rebuild writes the
  // slot from its very first stage now, not only at the end.
  execFileSync(
    process.execPath,
    [
      '--import',
      './scripts/cacbg/register-ts.mjs',
      'scripts/wrangler-render.mjs',
      'apps/web/wrangler.jsonc',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  copyFileSync(resolve(webDir, 'wrangler.deploy.jsonc'), resolve(webDir, 'wrangler.jsonc'));
  const info = JSON.parse(wrangler(['d1', 'info', target.name, '--json'], true));
  assertD1TargetAuthorized({
    remote: true,
    shipEnv: process.env.SIGMA_SHIP_ENV ?? '',
    d1Name: target.name,
    expectedId: target.id,
    resolvedId: info.uuid ?? info.database_id,
    resolvedName: info.name,
  });

  const work = resolve(root, 'data/work/rebuild');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const db = join(work, 'slot.sqlite');
  const today = new Date().toISOString().slice(0, 10);
  const runId = process.env.SIGMA_RUN_ID ?? '';
  // Every file into the slot carries its receipt: the rows of a chunk are not repeatable, and wrangler can
  // report a failure for a file that landed (scripts/d1-retry.mjs).
  const apply = wranglerFileSender({ d1Name: target.name, remote: true, dir: work, cwd: webDir });
  const record = (name, detail = null) =>
    apply(`state-${name}`, receiptSql(name, runId, new Date().toISOString(), detail));
  let reads = 0;
  const verifyRead = slotReader(target.name, { beat: () => progress('verify', ++reads) });
  const complete = ({ version, commit, tables, rows }) =>
    console.log(
      JSON.stringify({
        event: 'declarations_job_complete',
        runId: process.env.SIGMA_RUN_ID ?? null,
        audit: true,
        published: true,
        slot: target.name,
        tables,
        rows,
        dataVersion: version,
        sourceCommit: commit,
      }),
    );

  const jobDir = join(work, 'declarations');
  const snapshot = join(jobDir, 'backfill.sqlite');
  const ops = {
    // A verification on its own: the slot was shipped by an earlier run and nothing is built or written
    // but the stamp. The run's audit is this verification; what it publishes is the slot's version.
    verify: () => {
      stage('verify');
      return verifySlot(target.name, { read: verifyRead, apply, runId });
    },
    // 0. The slot is the durable store of this rebuild. It is emptied and shaped once; from there on
    // every finished stage leaves its rows and its receipt in it, so a stopped container resumes from
    // the slot instead of building for hours again.
    state: (anyRun) => slotState(target.name, runId, d1Json, anyRun),
    rehydrate: async (done) => {
      stage('import');
      // The schema comes from the migrations, the rows from the slot: D1 refuses to export a database
      // that holds a virtual table, and the search index is one. Named tables, data only.
      await rehydrate(db, target.name, work);
      console.log(`resumed from the slot after: ${[...done.keys()].join(', ')}`);
    },
    prepare: () => {
      stage('import');
      emptySlot(target.name, apply);
      wrangler(['d1', 'migrations', 'apply', target.name, '--remote']);
      record('prepare');
    },
    unverify: () => apply('unverify', UNVERIFY_SQL),

    // 1. The procurement corpus, from the open data, into a fresh file with every migration.
    import: async () => {
      await step('import', [
        'scripts/import.mjs',
        `--work-db=${db}`,
        '--from=2020-01-01',
        `--to=${today}`,
        '--no-ship',
      ]);
      fillSlot(target.name, db, work, { label: 'import', apply });
      record('import');
    },

    // 2. The Trade Register: every winner's partida, through the daily ETL's own reader and writer. Each
    // batch of partidas goes straight into the slot with the queue that names what is left, so a stop
    // costs the batch and not the hours before it.
    registry: async () => {
      // `--defer-baseline`: the winners are only half the register. The rest — the companies the
      // declarations name — are known after stage 5 reads them, and the catch-up pass there accepts the
      // baseline for both sets. A baseline accepted here would call the register complete too early.
      await step('registry', [
        'scripts/tr/rebuild-registry.mjs',
        '--db',
        db,
        '--slot',
        target.name,
        '--defer-baseline',
      ]);
      // The accepted baseline is written after the last batch, so the cursors travel once more — a
      // resumed rebuild must not inherit a registry that still calls itself "building".
      await slotFlusher(target.name, new DatabaseSync(db, { readOnly: true }), apply)([]);
      record('registry');
    },

    local: async () => {
      // 3. Public ownership, then the rollups and the entity search index.
      stage('precompute');
      const { PUBLIC_OWNERSHIP_SQL } = await import('../apps/etl/src/public-ownership.ts');
      await sqlite(
        'precompute',
        db,
        readFileSync(resolve(root, 'scripts/seed-state-owned.sql'), 'utf8'),
      );
      await sqlite('precompute', db, PUBLIC_OWNERSHIP_SQL.map((s) => `${s};`).join('\n'));
      await sqlite(
        'precompute',
        db,
        ownershipStatements(readFileSync(resolve(root, 'scripts/refresh-slice.sql'), 'utf8')),
      );
      await sqlite('precompute', db, readFileSync(resolve(root, 'scripts/precompute.sql'), 'utf8'));

      // 4. The published links the live slot serves, so the declarations gate compares against them.
      try {
        const prior = join(work, 'live-links.sql');
        wrangler([
          'd1',
          'export',
          live.name,
          '--remote',
          '--no-schema',
          '--table',
          'interest_links',
          '--table',
          'interest_link_evidence',
          '--output',
          prior,
        ]);
        await sqlite('precompute', db, readFileSync(prior, 'utf8'));
      } catch (error) {
        console.warn(
          JSON.stringify({ event: 'rebuild_no_live_links', reason: String(error).slice(0, 300) }),
        );
      }

      // 5. The declarations, in the job's local mode, against this snapshot — in two halves, because the
      // register was read for the winners and the declarations name companies no winner list contains
      // (measured on the first full rebuild: 13,121 partidas against the live slot's 14,118, and 33
      // published links lost). The first half stops once the declarations have said which companies they
      // mean; the register is read for those; the second half decides against the fuller register.
      const declarations = (...extra) =>
        step(
          'declarations',
          [
            'scripts/related-persons-job.mjs',
            '--source-db',
            db,
            '--work-dir',
            jobDir,
            '--r2',
            ...extra,
          ],
          { SIGMA_REBUILD: '1' },
        );
      await declarations('--until', 'candidates');
      // The catch-up pass reads the requested companies and accepts the baseline for winners and
      // requested together. It writes the snapshot, which stage 7 ships whole, so the new partidas travel
      // with it.
      await step('declarations', ['scripts/tr/rebuild-registry.mjs', '--db', snapshot]);
      await declarations('--from', 'decide');

      // 6. The people in the search index.
      stage('search');
      const local = new DatabaseSync(snapshot);
      const officials = local
        .prepare(
          `SELECT DISTINCT person_id id FROM interest_links
           WHERE status='published' AND interest_class IN ('private_ownership','family_ownership') ORDER BY 1`,
        )
        .all()
        .map((r) => r.id);
      local.close();
      if (officials.length) {
        const sql = execFileSync(
          process.execPath,
          [
            '--import',
            './scripts/cacbg/register-ts.mjs',
            'scripts/emit-refresh-group.mjs',
            'official-search-index',
          ],
          {
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, SIGMA_OFFICIAL_PERSON_IDS_JSON: JSON.stringify(officials) },
          },
        );
        await sqlite('search', snapshot, sql);
      }
      await sqlite(
        'search',
        snapshot,
        readFileSync(resolve(root, 'scripts/person-search-index.sql'), 'utf8'),
      );
    },

    // 7. The slot takes the finished snapshot: its own DDL where the migrations left a gap, then every
    // table emptied and filled parents first. The rows an earlier stage already put there are replaced.
    // Its receipt says what the slot now holds and which rules built it.
    // 8. The slot answers for what it holds, and only then says which rules built it: a slot that failed
    // a check has no version, and a production deploy will not release onto it. A verification that
    // cannot finish for D1 runs again on its own (SIGMA_REBUILD_VERIFY=1), without building anything.
    ship: () => {
      stage('ship');
      const { version } = JSON.parse(
        readFileSync(resolve(root, 'packages/db/data-version.json'), 'utf8'),
      );
      return finishBuild(target.name, snapshot, work, {
        apply,
        verifyRead,
        runId,
        version,
        commit: process.env.SIGMA_SOURCE_COMMIT || null,
      });
    },
  };
  complete(
    await runRebuild(
      {
        verify: process.env.SIGMA_REBUILD_VERIFY === '1',
        resume: process.env.SIGMA_REBUILD_RESUME === '1',
      },
      ops,
    ),
  );
}

if (import.meta.main) await main();
