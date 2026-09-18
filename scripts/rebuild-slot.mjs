#!/usr/bin/env node
// Rebuild the idle blue/green D1 slot from nothing, in one Container run (ADR-0048). Everything is built in a
// local SQLite file — the procurement corpus, the Trade Register, public ownership, the declarations and the
// search index — then the whole snapshot is shipped to the idle slot and verified there. The live slot is only
// read. The flip is a redeploy with the idle slot's id (docs/deploy.md).
//
//   SIGMA_D1_NAME/SIGMA_D1_ID           the idle slot, the only one written
//   SIGMA_LIVE_D1_NAME/SIGMA_LIVE_D1_ID the live slot, read for the published-link gate
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
} from './ship-related-persons.mjs';
import { importSql } from './cacbg/import-sql.mjs';

const root = resolve(import.meta.dirname, '..');
const webDir = resolve(root, 'apps/web');

/** Tables a served slot never takes from the snapshot: SQLite's and Cloudflare's own, the migration ledger,
 *  the full-text index's shadow tables, the work staging, and the ship's generations. */
export function shippedTables(tables, stagingSql) {
  const staging = new Set(
    [...stagingSql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map((m) => m[1]),
  );
  return tables.filter(
    (t) =>
      !/^(sqlite_|_cf_|rp_next_|rp_prev_|d1_migrations$|search_index_)/.test(t) && !staging.has(t),
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
const d1Json = (name, sql) =>
  parseWranglerJson(
    wrangler(['d1', 'execute', name, '--remote', '--json', '--command', sql], true),
  )[0]?.results ?? [];

// The rebuild is hours long and the container can be stopped at any moment (ADR-0049). Its durable
// store is the idle slot itself: the data is going there anyway, and one file execution in D1 is one
// transaction, so a receipt written with the data cannot disagree with it.
const REBUILD_STATE_DDL =
  'CREATE TABLE IF NOT EXISTS rebuild_state (stage TEXT PRIMARY KEY, run_id TEXT NOT NULL, done_at TEXT NOT NULL, detail TEXT);';

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
    ((label, sql) => {
      const file = join(resolve(root, 'data/work/rebuild'), `${label}.sql`);
      writeFileSync(file, sql);
      wrangler(['d1', 'execute', name, '--remote', '--yes', '--file', file]);
      rmSync(file, { force: true });
    });
  return async (eiks) => {
    send('registry-batch', registryBatchSql(snapshot, eiks, tables, cursors, since));
    since = new Date().toISOString();
  };
}

/** Empty the slot of everything but the full-text shadow tables, which SQLite owns. */
export function emptySlot(name, apply, read = d1Json) {
  const drops = read(
    name,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  )
    .map((t) => t.name)
    .filter((n) => !/^search_index_/.test(n))
    .map((n) => `DROP TABLE IF EXISTS ${sqlIdent(n)};`);
  if (drops.length) apply('wipe', `PRAGMA defer_foreign_keys=ON;\n${drops.join('\n')}\n`);
}

/** Put a whole local snapshot into the slot: the snapshot's own DDL where the migrations left a gap,
 * then every table emptied children-first and filled parents-first, in chunks of twenty thousand rows.
 * Used twice — once after a long stage, so its hours are durable, and once for the finished build. */
export function fillSlot(name, snapshotPath, work, { label, apply }) {
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
    apply(
      `${label}-clear`,
      `PRAGMA defer_foreign_keys=ON;\n` +
        [...withRows]
          .reverse()
          .map((t) => `DELETE FROM ${sqlIdent(t)};`)
          .join('\n') +
        '\n',
    );
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
  });

  const work = resolve(root, 'data/work/rebuild');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const db = join(work, 'slot.sqlite');
  const today = new Date().toISOString().slice(0, 10);
  const runId = process.env.SIGMA_RUN_ID ?? '';
  const apply = (label, sql) => {
    const file = join(work, `${label}.sql`);
    writeFileSync(file, sql);
    wrangler(['d1', 'execute', target.name, '--remote', '--yes', '--file', file]);
    rmSync(file, { force: true });
  };
  const record = (name, detail = null) =>
    apply(
      `state-${name}`,
      `${REBUILD_STATE_DDL}\nINSERT OR REPLACE INTO rebuild_state VALUES(${sqlLiteral(name)},${sqlLiteral(runId)},${sqlLiteral(new Date().toISOString())},${sqlLiteral(detail)});`,
    );

  // 0. The slot is the durable store of this rebuild. It is emptied and shaped once; from there on
  // every finished stage leaves its rows and its receipt in it, so a stopped container resumes from
  // the slot instead of building for hours again.
  const done = slotState(target.name, runId, d1Json, process.env.SIGMA_REBUILD_RESUME === '1');
  if (done.has('prepare')) {
    stage('import');
    // The schema comes from the migrations, the rows from the slot: D1 refuses to export a database
    // that holds a virtual table, and the search index is one. Named tables, data only.
    await rehydrate(db, target.name, work);
    console.log(`resumed from the slot after: ${[...done.keys()].join(', ')}`);
  } else {
    stage('import');
    emptySlot(target.name, apply);
    wrangler(['d1', 'migrations', 'apply', target.name, '--remote']);
    record('prepare');
  }

  // 1. The procurement corpus, from the open data, into a fresh file with every migration.
  if (!done.has('import')) {
    await step('import', [
      'scripts/import.mjs',
      `--work-db=${db}`,
      '--from=2020-01-01',
      `--to=${today}`,
      '--no-ship',
    ]);
    fillSlot(target.name, db, work, { label: 'import', apply });
    record('import');
  }

  // 2. The Trade Register: every winner's partida, through the daily ETL's own reader and writer. Each
  // batch of partidas goes straight into the slot with the queue that names what is left, so a stop
  // costs the batch and not the hours before it.
  if (!done.has('registry')) {
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
  }

  // 3. Public ownership, then the rollups and the entity search index.
  stage('precompute');
  const { PUBLIC_OWNERSHIP_SQL } = await import('../apps/etl/src/registry.ts');
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
  // (measured on the first full rebuild: 13,121 partidas against the live slot's 14,118, and 33 published
  // links lost). The first half stops once the declarations have said which companies they mean; the
  // register is read for those; the second half decides against the fuller register.
  const jobDir = join(work, 'declarations');
  const snapshot = join(jobDir, 'backfill.sqlite');
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
  // The catch-up pass reads the requested companies and accepts the baseline for winners and requested
  // together. It writes the snapshot, which stage 7 ships whole, so the new partidas travel with it.
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

  // 7. The slot takes the finished snapshot: its own DDL where the migrations left a gap, then every
  // table emptied and filled parents first. The rows an earlier stage already put there are replaced.
  stage('ship');
  const { counts, withRows, shipped } = fillSlot(target.name, snapshot, work, {
    label: 'ship',
    apply,
  });

  // 8. The slot answers for what it holds.
  stage('verify');
  const served = {};
  for (let i = 0; i < withRows.length; i += 20) {
    const chunk = withRows.slice(i, i + 20);
    const row = d1Json(
      target.name,
      `SELECT ${chunk.map((t) => `(SELECT COUNT(*) FROM ${sqlIdent(t)}) AS ${sqlIdent(t)}`).join(', ')}`,
    )[0];
    Object.assign(served, row);
  }
  const mismatched = withRows.filter((t) => Number(served[t]) !== counts[t]);
  if (mismatched.length)
    throw new Error(`Slot counts differ from the snapshot: ${mismatched.join(', ')}`);
  const { assertIntegrity } = await import('./integrity-checks.mjs');
  await assertIntegrity((sql) => d1Json(target.name, sql), {
    label: `rebuilt slot ${target.name}`,
  });
  console.log(
    JSON.stringify({
      event: 'declarations_job_complete',
      runId: process.env.SIGMA_RUN_ID ?? null,
      audit: true,
      published: true,
      slot: target.name,
      tables: withRows.length,
      rows: shipped,
    }),
  );
}

if (import.meta.main) await main();
