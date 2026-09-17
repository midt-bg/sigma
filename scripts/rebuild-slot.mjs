#!/usr/bin/env node
// Rebuild the idle blue/green D1 slot from nothing, in one Container run (ADR-0048). Everything is built in a
// local SQLite file — the procurement corpus, the Trade Register, public ownership, the declarations and the
// search index — then the whole snapshot is shipped to the idle slot and verified there. The live slot is only
// read. The flip is a redeploy with the idle slot's id (docs/deploy.md).
//
//   SIGMA_D1_NAME/SIGMA_D1_ID           the idle slot, the only one written
//   SIGMA_LIVE_D1_NAME/SIGMA_LIVE_D1_ID the live slot, read for the published-link gate
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { progress } from './cacbg/progress.mjs';
import {
  assertD1TargetAuthorized,
  insertStatements,
  parseWranglerJson,
  sqlIdent,
} from './ship-related-persons.mjs';

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
        out.write(line + '\n');
        // The declarations job reports its own stages; anything else is a heartbeat of this one.
        if (!line.startsWith('{"event":"declarations_')) progress(name, ++lines);
      });
    child.on('close', (code) => (code === 0 ? done() : fail(name, code)));
  });
}

const sqlite = (db, sql) =>
  execFileSync('sqlite3', [db], { input: sql, stdio: ['pipe', 'inherit', 'inherit'] });
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

  // 1. The procurement corpus, from the open data, into a fresh file with every migration.
  await step('import', [
    'scripts/import.mjs',
    `--work-db=${db}`,
    '--from=2020-01-01',
    `--to=${today}`,
    '--no-ship',
  ]);

  // 2. The Trade Register: every winner's partida, through the daily ETL's own reader and writer.
  await step('registry', ['scripts/tr/rebuild-registry.mjs', '--db', db]);

  // 3. Public ownership, then the rollups and the entity search index.
  stage('precompute');
  const { PUBLIC_OWNERSHIP_SQL } = await import('../apps/etl/src/registry.ts');
  sqlite(db, readFileSync(resolve(root, 'scripts/seed-state-owned.sql'), 'utf8'));
  sqlite(db, PUBLIC_OWNERSHIP_SQL.map((s) => `${s};`).join('\n'));
  sqlite(db, ownershipStatements(readFileSync(resolve(root, 'scripts/refresh-slice.sql'), 'utf8')));
  sqlite(db, readFileSync(resolve(root, 'scripts/precompute.sql'), 'utf8'));

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
    sqlite(db, readFileSync(prior, 'utf8'));
  } catch (error) {
    console.warn(
      JSON.stringify({ event: 'rebuild_no_live_links', reason: String(error).slice(0, 300) }),
    );
  }

  // 5. The declarations, in the job's local mode, against this snapshot.
  const jobDir = join(work, 'declarations');
  await step(
    'declarations',
    ['scripts/related-persons-job.mjs', '--source-db', db, '--work-dir', jobDir, '--r2'],
    {
      SIGMA_REBUILD: '1',
    },
  );
  const snapshot = join(jobDir, 'backfill.sqlite');

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
    sqlite(snapshot, sql);
  }
  sqlite(snapshot, readFileSync(resolve(root, 'scripts/person-search-index.sql'), 'utf8'));

  // 7. The idle slot: emptied, shaped by the migrations and the snapshot's DDL, then filled parents first.
  stage('ship');
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
  const existing = d1Json(
    target.name,
    "SELECT name, type FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  );
  const drops = existing
    .map((t) => t.name)
    .filter((n) => !/^search_index_/.test(n))
    .map((n) => `DROP TABLE IF EXISTS ${sqlIdent(n)};`);
  if (drops.length) {
    const file = join(work, 'wipe.sql');
    writeFileSync(file, `PRAGMA defer_foreign_keys=ON;\n${drops.join('\n')}\n`);
    wrangler(['d1', 'execute', target.name, '--remote', '--yes', '--file', file]);
  }
  wrangler(['d1', 'migrations', 'apply', target.name, '--remote']);

  const snap = new DatabaseSync(snapshot, { readOnly: true });
  const master = snap
    .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL')
    .all();
  const tables = shippedTables(
    master.filter((m) => m.type === 'table').map((m) => m.name),
    readFileSync(resolve(root, 'scripts/work-staging-schema.sql'), 'utf8'),
  );
  const ddl = master
    .filter((m) => tables.includes(m.tbl_name) && (m.type === 'table' || m.type === 'index'))
    .sort((a, b) => (a.type === b.type ? 0 : a.type === 'table' ? -1 : 1))
    .map((m) => `${ifNotExists(m.sql)};`);
  const ddlFile = join(work, 'schema.sql');
  writeFileSync(ddlFile, ddl.join('\n') + '\n');
  wrangler(['d1', 'execute', target.name, '--remote', '--yes', '--file', ddlFile]);

  const foreignKeys = new Map(
    tables.map((t) => [
      t,
      snap
        .prepare(`PRAGMA foreign_key_list(${sqlIdent(t)})`)
        .all()
        .map((f) => f.table),
    ]),
  );
  const counts = {};
  const ordered = parentsFirst(tables, foreignKeys);
  // The internal related-persons table never leaves the build (ADR-0032).
  const withRows = ordered.filter((t) => t !== 'related_persons_internal');
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
      const file = join(work, `ship-${table}-${String(part).padStart(3, '0')}.sql`);
      writeFileSync(
        file,
        `PRAGMA defer_foreign_keys=ON;\n${insertStatements(table, cols, rows).join('')}`,
      );
      wrangler(['d1', 'execute', target.name, '--remote', '--yes', '--file', file]);
      rmSync(file);
      shipped += rows.length;
      progress('ship', shipped);
    }
  }
  snap.close();

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
