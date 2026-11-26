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

/**
 * Tables the build leaves in its snapshot that no migration makes, and the slot takes all the same — each
 * with what reads it there. A resumed build brings them back from the slot with the slot's own DDL
 * (`rehydrate`), so its ship counts them as a whole build's does.
 */
export const SHIPPED_UNMIGRATED = new Map([
  [
    'state_owned_eik',
    'the public-enterprise list: public stakes (packages/db queries/public-stakes.ts)',
  ],
  [
    'public_owned_eik',
    'companies in public hands: public stakes, the register (apps/etl/src/registry.ts)',
  ],
  ['pipeline_stats', 'the import’s counts: the integrity gate reconciles the slot against them'],
  // normalize-raw's canonical names; the refresh rebuilds them before it reads them.
  ['authority_canonical_name', 'the refresh (scripts/refresh-slice.sql), which rebuilds it first'],
  ['authority_canonical_type', 'the refresh (scripts/refresh-slice.sql), which rebuilds it first'],
  ['bidder_canonical_name', 'the refresh (scripts/refresh-slice.sql), which rebuilds it first'],
]);

/**
 * Tables a served slot never takes from the snapshot, and why. The work staging
 * (scripts/work-staging-schema.sql) is left out with them: the import's raw tables, read by nothing served.
 */
export const NOT_SHIPPED = [
  [/^sqlite_/, 'SQLite’s own'],
  [/^_cf_/, 'Cloudflare’s own'],
  [/^d1_migrations$/, 'the migration ledger: the slot keeps its own'],
  [/^search_index_/, 'the full-text index’s shadow tables: SQLite fills them from search_index'],
  [/^rp_(next|prev)_/, 'the declarations ship’s generations: the served database’s alone'],
  [/^contractor_identity$/, 'the import’s working table: nothing served reads it'],
  [/^data_version$/, 'written by the verification alone, never carried in with the rows'],
  [/^rebuild_state$/, 'the stages’ receipts: each stage writes its own'],
];

let migrated = null;
/** The tables the migrations make — the served schema. */
export function migratedTables() {
  if (!migrated) {
    const db = new DatabaseSync(':memory:');
    try {
      const dir = resolve(root, 'packages/db/migrations');
      for (const file of readdirSync(dir)
        .filter((n) => /^\d+.*\.sql$/.test(n))
        .sort())
        db.exec(readFileSync(join(dir, file), 'utf8'));
      migrated = new Set(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((r) => r.name),
      );
    } finally {
      db.close();
    }
  }
  return migrated;
}

/**
 * The tables of a snapshot the slot takes: every table the migrations make and every one in
 * SHIPPED_UNMIGRATED, none in NOT_SHIPPED or the work staging. A table in neither list stops the build
 * with its name: the slot would otherwise take it, or lose it, without anyone having said which.
 */
export function shippedTables(tables, stagingSql, served = migratedTables()) {
  const staging = new Set(
    [...stagingSql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map((m) => m[1]),
  );
  const unknown = [];
  const shipped = tables.filter((t) => {
    if (staging.has(t) || NOT_SHIPPED.some(([pattern]) => pattern.test(t))) return false;
    if (served.has(t) || SHIPPED_UNMIGRATED.has(t)) return true;
    unknown.push(t);
    return false;
  });
  if (unknown.length)
    throw new Error(
      `The build left ${unknown.join(', ')} in its snapshot, and nothing says whether the slot takes it: ` +
        'make it in a migration, or name it in SHIPPED_UNMIGRATED or NOT_SHIPPED (scripts/rebuild-slot.mjs).',
    );
  return shipped;
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
const d1Answer = (name, sql, cli = wrangler) =>
  parseWranglerJson(
    cli(['d1', 'execute', name, '--remote', '--json', '--command', sql], true),
  )[0] ?? {};
const d1Json = (name, sql) => d1Answer(name, sql).results ?? [];

const LIVE_LINK_PAGE_SIZE = 250;

// The release hold and idle gate keep the source tables stable across these independent reads.
// A D1 export blocks serving queries even when it names only these two tables.
function captureLiveLinks(db, live, cli, sleep) {
  const tables = ['interest_links', 'interest_link_evidence'];
  const read = (label, sql, complete) => {
    const rows = retryD1(
      () => {
        const { success, results } = d1Answer(live, sql, cli);
        if (success !== true || !Array.isArray(results) || !complete(results))
          throw new Error(`Incomplete live-link read from ${live} (${label})`);
        return results;
      },
      { label: `capture live links: ${label}`, sleep },
    );
    sleep(BREATHER_MS);
    return rows;
  };
  // Counts and indexed upper bounds also detect a truncated final page retaining its last row.
  // The only cursor values sent to Wrangler are checked integers.
  const [ends] = read(
    'table bounds',
    `SELECT ${tables.map((t) => `(SELECT MAX(rowid) FROM ${t}) AS ${t}, (SELECT COUNT(*) FROM ${t}) AS ${t}_count`).join(', ')}`,
    ([row, extra]) =>
      row &&
      !extra &&
      tables.every(
        (t) =>
          Number.isSafeInteger(row[`${t}_count`]) &&
          row[`${t}_count`] >= 0 &&
          (row[`${t}_count`] === 0 ? row[t] === null : Number.isSafeInteger(row[t])),
      ),
  );
  // The prior links can reference people or bidders absent from the new corpus. The loader will
  // rebuild them after reading the baseline. Check the evidence-to-link FK separately.
  const local = new DatabaseSync(db, { enableForeignKeyConstraints: false });
  try {
    local.exec('BEGIN');
    let pages = 0;
    for (const table of tables) {
      const end = ends[table];
      let remaining = ends[`${table}_count`];
      const quotedTable = sqlIdent(table);
      const columns = local
        .prepare(`PRAGMA table_info(${quotedTable})`)
        .all()
        .map((c) => c.name);
      const projection = columns.map(sqlIdent).join(', ');
      const insert = local.prepare(
        `INSERT INTO ${quotedTable} (${projection}) VALUES (${columns.map(() => '?').join(', ')})`,
      );
      let cursor = null;
      while (remaining > 0) {
        const lower = cursor === null ? '' : ` AND rowid > ${cursor}`;
        const rows = read(
          table,
          `SELECT rowid AS rebuild_rowid, ${projection} FROM ${quotedTable}
            WHERE rowid <= ${end}${lower} ORDER BY rowid LIMIT ${LIVE_LINK_PAGE_SIZE}`,
          (rows) =>
            rows.length === Math.min(LIVE_LINK_PAGE_SIZE, remaining) &&
            (rows.at(-1)?.rebuild_rowid === end) === (rows.length === remaining) &&
            rows.every((row, i) => {
              const previous = i === 0 ? cursor : rows[i - 1].rebuild_rowid;
              return (
                Number.isSafeInteger(row?.rebuild_rowid) &&
                row.rebuild_rowid <= end &&
                (previous === null || row.rebuild_rowid > previous) &&
                columns.every((column) => Object.hasOwn(row, column))
              );
            }),
        );
        for (const row of rows) insert.run(...columns.map((column) => row[column]));
        cursor = rows.at(-1).rebuild_rowid;
        remaining -= rows.length;
        progress('precompute', ++pages);
      }
    }
    if (local.prepare('PRAGMA foreign_key_check(interest_link_evidence)').get())
      throw new Error('Incomplete live-link capture: evidence has no matching link');
    local.exec('COMMIT');
  } finally {
    // Closing rolls back an uncommitted capture, including pages already copied.
    local.close();
  }
}

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

/**
 * Sent before the ship's first write. The ship empties every table and fills it again, so from its first
 * file on the slot no longer holds what `import` and `registry` left: a ship stopped half-way leaves tables
 * emptied or half filled, and a resume that trusted their receipts would rebuild on a partial corpus, ship
 * it and pass its own verification, since the counts would match. So every receipt goes, with the stamp: a
 * stopped ship is built again from the start, and only its own receipt, in its last file, says it finished.
 */
export const SHIP_START_SQL = `${REBUILD_STATE_DDL}\nDELETE FROM rebuild_state;\nDELETE FROM data_version;\n`;

/** What this run has already put in the slot: each finished stage, with the run that finished it and its
 *  detail. A slot without the table has nothing to offer. */
export function slotState(name, runId, read = d1Json, anyRun = false) {
  if (!read(name, "SELECT 1 AS found FROM sqlite_master WHERE name='rebuild_state'").length)
    return new Map();
  // By default a rebuild only trusts its own receipts: a fresh run empties the slot and starts clean.
  // An operator who asks to resume adopts what an earlier run of the same rebuild left behind.
  const where = anyRun ? '' : ` WHERE run_id=${sqlLiteral(runId)}`;
  return new Map(
    read(name, `SELECT stage, run_id, detail FROM rebuild_state${where}`).map((r) => [
      r.stage,
      { runId: r.run_id, detail: r.detail },
    ]),
  );
}

/**
 * Under which run the declarations stage keeps its checkpoints (scripts/cacbg/extract-checkpoint.mjs). The
 * local stages leave nothing in the slot, so a resumed build reads the declarations again — but the reading
 * already accepted by an earlier run of the same build is still in R2, keyed by the run that prepared the
 * slot. It is adopted only when that run was the same code: the checkpoint's fingerprint guards the inputs
 * (corpus, identity rules, registry), not the extractor, and a fix deployed between the runs must not be
 * resumed past. Otherwise, and for a fresh build, the run keeps its own.
 */
export function checkpointRun(done, runId, commit) {
  const prepared = done.get('prepare');
  if (!prepared || prepared.runId === runId || !commit) return runId;
  let recorded = null;
  try {
    recorded = JSON.parse(prepared.detail ?? 'null')?.commit ?? null;
  } catch {
    // a receipt without a commit adopts nothing
  }
  return recorded === commit ? prepared.runId : runId;
}

/** A batch of partidas, straight into the slot: its rows, the queue entries it cleared or added, and
 * the registry's own cursors. The rebuild then resumes at the batch, not at the first partida. */
export function slotFlusher(name, snapshot, apply) {
  const carry = registryTables(snapshot);
  let since = null;
  const send =
    apply ??
    wranglerFileSender({
      d1Name: name,
      remote: true,
      dir: resolve(root, 'data/work/rebuild'),
      cwd: webDir,
    });
  const flush = (eiks, seal) => {
    send('registry-batch', registryBatchSql(snapshot, eiks, carry, since) + seal);
    since = new Date().toISOString();
  };
  // A batch takes its companies alone: the import also hands it how many partidas it has read so far.
  const batch = async (eiks) => flush(eiks, '');
  // The registry's receipt rides with its last cursors, after the last batch.
  batch.seal = async (sql) => flush([], sql);
  return batch;
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
 * Used twice — once after a long stage, so its hours are durable, and once for the finished build.
 *
 * `seal(counts)` is the stage's receipt. It travels in the LAST file, in the same transaction as the last
 * rows: a slot holds the receipt exactly when it holds every row, and a stop between the two cannot leave
 * a filled slot that looks unfilled, or the reverse. */
export function fillSlot(
  name,
  snapshotPath,
  work,
  { label, apply, read = d1Json, seal, served = migratedTables() },
) {
  const snap = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const master = snap
      .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL')
      .all();
    const tables = shippedTables(
      master.filter((m) => m.type === 'table').map((m) => m.name),
      readFileSync(resolve(root, 'scripts/work-staging-schema.sql'), 'utf8'),
      served,
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
    const counts = Object.fromEntries(
      withRows.map((t) => [t, snap.prepare(`SELECT COUNT(*) n FROM ${sqlIdent(t)}`).get().n]),
    );
    const last = withRows.findLast((t) => counts[t] > 0);
    let shipped = 0;
    for (const table of withRows) {
      const cols = snap
        .prepare(`PRAGMA table_info(${sqlIdent(table)})`)
        .all()
        .map((c) => c.name);
      const n = counts[table];
      for (let offset = 0, part = 0; offset < n; offset += 20_000, part++) {
        const rows = snap
          .prepare(
            `SELECT ${cols.map(sqlIdent).join(',')} FROM ${sqlIdent(table)} LIMIT 20000 OFFSET ${offset}`,
          )
          .all();
        const sealed = seal && table === last && offset + 20_000 >= n ? seal(counts) : '';
        apply(
          `ship-${table}-${String(part).padStart(3, '0')}`,
          `PRAGMA defer_foreign_keys=ON;\n${insertStatements(table, cols, rows).join('')}${sealed}`,
        );
        shipped += rows.length;
        progress(label === 'ship' ? 'ship' : label, shipped);
      }
    }
    // A snapshot without a single row still finishes the stage.
    if (seal && !last) apply(`${label}-seal`, seal(counts));
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
  // The tables the slot takes that no migration makes come back with the slot's own DDL.
  const unmigrated = read(
    name,
    `SELECT name, sql FROM sqlite_master WHERE type='table'
       AND name IN (${[...SHIPPED_UNMIGRATED.keys()].map(sqlLiteral).join(',')}) ORDER BY name`,
  );
  if (unmigrated.length)
    await apply('import', db, unmigrated.map((t) => `${ifNotExists(t.sql)};`).join('\n'));
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

/** The register's cursors: a batch carries them whole, as the local build holds them after it. */
export const REGISTRY_CURSORS = ['registry_sync', 'registry_entry_state', 'registry_entry_passes'];

/**
 * How a registry batch carries each registry table of the local build. A build resumed after the register
 * takes the register from the slot alone (`rehydrate`), so whatever a batch leaves out is gone from it:
 *
 *   byCompany  every table with an `eik` column — the batch's companies' rows replace the slot's
 *   persons    registry_persons — one row per person the batch's partidas name (their observations), as
 *              the read left it; a person is keyed by the register's identifier, not by a company
 *   cursors    REGISTRY_CURSORS — whole
 *
 * A registry table that is none of these stops the build with its name, before any batch is sent.
 */
export function registryTables(snapshot) {
  const carry = { byCompany: [], persons: [], cursors: [] };
  const unknown = [];
  for (const { name } of snapshot
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'registry_%' ORDER BY name",
    )
    .all()) {
    const columns = snapshot
      .prepare(`PRAGMA table_info(${sqlIdent(name)})`)
      .all()
      .map((c) => c.name);
    if (columns.includes('eik')) carry.byCompany.push(name);
    else if (name === 'registry_persons') carry.persons.push(name);
    else if (REGISTRY_CURSORS.includes(name)) carry.cursors.push(name);
    else unknown.push(name);
  }
  if (unknown.length)
    throw new Error(
      `A registry batch does not know how to carry ${unknown.join(', ')}: a build resumed after the ` +
        'register would lose it. Say how in registryTables (scripts/rebuild-slot.mjs).',
    );
  return carry;
}

/** Rows for one batch of companies, as statements that replace whatever the slot holds for them. */
export function registryBatchSql(snapshot, eiks, { byCompany, persons, cursors }, since = null) {
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
  // The people the batch's partidas name: reading a partida rewrote each one's row.
  const named = `SELECT registry_indent FROM registry_identity_observations
    WHERE eik IN (${list}) AND subject_kind = 'person' AND registry_indent IS NOT NULL`;
  for (const table of [...byCompany, ...persons, ...cursors]) {
    const cols = snapshot
      .prepare(`PRAGMA table_info(${sqlIdent(table)})`)
      .all()
      .map((c) => c.name);
    const select = `SELECT ${cols.map(sqlIdent).join(',')} FROM ${sqlIdent(table)}`;
    const rows = cursors.includes(table)
      ? snapshot.prepare(select).all()
      : !eiks.length
        ? []
        : persons.includes(table)
          ? snapshot.prepare(`${select} WHERE indent IN (${named})`).all()
          : snapshot.prepare(`${select} WHERE eik IN (${list})`).all();
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
 * The verification's answer that the slot is not what its ship receipt says: a count that differs, a
 * broken integrity check, no finished ship at all. The same idle slot gives the same answer to every new
 * attempt, so the run reports it as final (`verdictEvent`) and the coordinator ends the run at once. A read
 * that fails is never one.
 */
export class SlotVerdict extends Error {}

/** The error event that tells the coordinator a failure is a verdict, or null for any other failure. */
export const verdictEvent = (error) =>
  error instanceof SlotVerdict
    ? {
        event: 'declarations_error',
        stage: 'verify',
        script: 'rebuild-slot',
        exitCode: 1,
        verdict: true,
      }
    : null;

/**
 * Why counts can differ without a defect: the slot was served and refreshed after its ship — a former live
 * slot still holds the receipt of the build that made it, and the refresh has moved its rows on since.
 * Verifying it again proves nothing; it is rebuilt. Only a hint for the message, so a read that fails is
 * no hint.
 */
function refreshedSince(read, builtAt) {
  try {
    const at = read('SELECT MAX(refreshed_at) AS at FROM data_freshness')[0]?.at;
    const utc = (t) => Date.parse(/[TZ]/.test(t) ? t : `${t.replace(' ', 'T')}Z`);
    if (at && builtAt && utc(at) > utc(builtAt))
      return (
        ` — the slot was refreshed (${at}) after its ship (${builtAt}): it has been served since, and the` +
        ' ship receipt no longer describes it. Nothing to verify: rebuild the slot'
      );
  } catch {
    // no hint
  }
  return '';
}

/**
 * A slot is ready only with the register's baseline accepted: the catch-up pass after the declarations read
 * every company the candidate pass asked for, and the daily run reads the register's new entries from where the
 * build left off. With the baseline open the daily run skips those reads until it closes it, and the slot
 * may lack partidas the declarations' links were decided against. A verdict, never retried, and before the
 * slot gets its version.
 *
 * A slot with no register at all needs no baseline: every registry table but the cursors counts nothing in
 * the ship's receipt — nothing was asked of the register and nothing read from it (a snapshot with no
 * winner to read). The counts are the receipt's, which the slot was just counted against.
 */
function refuseOpenBaseline(name, read, counts) {
  const register = Object.entries(counts).filter(
    ([t]) => t.startsWith('registry_') && !REGISTRY_CURSORS.includes(t),
  );
  if (register.every(([, n]) => n === 0)) return;
  const status = read('SELECT baseline_status FROM registry_entry_state WHERE id = 1')[0]
    ?.baseline_status;
  if (status !== 'ready')
    throw new SlotVerdict(
      `${name} holds the register with its baseline ${status ?? 'missing'}, not accepted: the register ` +
        'pass after the declarations did not finish in this build. The slot is not ready — build it ' +
        'again without resume',
    );
  if (!counts.registry_requested_companies) return;
  // Declaration requests are fixed by extraction. Ownership can discover further requests after
  // catch-up; the native baseline already enforces lookups for the ownership requests it received.
  // An explicit source absence has a deed row and is a completed lookup.
  const missing = read(
    `SELECT COUNT(DISTINCT r.eik) AS n FROM registry_requested_companies r
      WHERE length(r.eik) = 9 AND r.declaration_id NOT GLOB 'ownership:*'
        AND NOT EXISTS (SELECT 1 FROM registry_deeds d WHERE d.eik = r.eik)`,
    ([row]) => Number.isInteger(row?.n) && row.n >= 0,
  )[0].n;
  if (missing)
    throw new SlotVerdict(
      `${name} holds ${missing} declaration-requested company EIK(s) with no registry lookup. ` +
        'The slot is not ready — build it again without resume',
    );
}

/**
 * Every person the register gives a role is served with a name: the batch that carries a company's roles
 * carries its people (`registryRows`). A role whose person has no row is a slot written, at least in part,
 * by code that did not carry them — a resume over such a build's `registry` receipt skips the stage, and
 * nothing later reads those people. Their pages answer 404. A verdict, before the slot gets its version.
 */
function refuseNamelessPeople(name, read) {
  const missing = read(
    `SELECT COUNT(DISTINCT r.subject_id) AS n FROM registry_roles r
      WHERE r.subject_kind = 'person' AND r.subject_id NOT LIKE 'local:%'
        AND NOT EXISTS (SELECT 1 FROM registry_persons p WHERE p.indent = r.subject_id)`,
    ([row]) => Number.isInteger(row?.n) && row.n >= 0,
  )[0].n;
  if (missing)
    throw new SlotVerdict(
      `${name} holds ${missing} person(s) with a role in the register and no name: its register was ` +
        'written by code that did not carry the people. The slot is not ready — build it again without resume',
    );
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
    throw new SlotVerdict(
      `${name} holds no finished ship: there is nothing to verify — build the slot`,
    );
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
    throw new SlotVerdict(
      `Slot counts differ from the snapshot: ${mismatched.map((t) => `${t} ${served[t]} ≠ ${counts[t]}`).join(', ')}` +
        refreshedSince(read, builtAt),
    );
  refuseOpenBaseline(name, read, counts);
  refuseNamelessPeople(name, read);
  let results;
  try {
    results = await check(read, { label: `rebuilt slot ${name}`, exit: false });
  } catch (error) {
    // A check that broke is a verdict; a read the reader gave up on is not.
    if (String(error?.message).startsWith('integrity gate failed'))
      throw new SlotVerdict(error.message);
    throw error;
  }
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
  // Which ship passed: a run that only verifies may find an earlier finished build in the slot (a
  // resume of a slot whose earlier build was never switched to), and the operator compares these with
  // the build they started before switching to it.
  return { version, commit, tables: tables.length, rows, shipRun: shipped.run_id || null, builtAt };
}

/**
 * The end of a build: the finished snapshot into the slot, with the ship's receipt in its last file — what
 * the slot now holds and which rules built it — and the verification. A verification that fails leaves the receipt, so it can be
 * run again on its own.
 */
export async function finishBuild(
  name,
  snapshotPath,
  work,
  { apply, read = d1Json, verifyRead, runId, version, commit, check, now },
) {
  apply('ship-start', SHIP_START_SQL);
  fillSlot(name, snapshotPath, work, {
    label: 'ship',
    apply,
    read,
    seal: (counts) => {
      const at = (now ?? (() => new Date().toISOString()))();
      return receiptSql(
        'ship',
        runId,
        at,
        JSON.stringify({ version, commit, builtAt: at, counts }),
      );
    },
  });
  stage('verify');
  return verifySlot(name, { read: verifyRead, apply, runId, check, now });
}

/**
 * The order of a run, apart from what each stage does. `ops` are the stages, each of which writes the slot
 * except `state`, `rehydrate` and `local`:
 *
 *   state(anyRun)  the receipts in the slot (`slotState`)   prepare()  empty and shape the slot
 *   rehydrate()    the slot's rows into the local build      unverify() take the stamp and the ship away
 *   import(), registry()  stages that leave their rows and their receipt in the slot
 *   local(done)    precompute, the live links, the declarations and the search index — on the local disk
 *   ship()         the finished snapshot into the slot, then the verification
 *   verify()       the verification on its own
 *
 * A run continues at the first stage the slot holds no receipt for. A slot that holds a finished ship needs
 * only its verification — after a container stopped in it, after a resume — and neither builds nor
 * empties anything. A ship that began takes every receipt away (`SHIP_START_SQL`), so one stopped half-way
 * is built again from the start. The local stages leave nothing durable in the slot, so they always run again (what the
 * declarations already read is kept in R2, `checkpointRun`). A build run takes the stamp and the ship away
 * right before its first write — a fresh one by emptying the slot, which takes them along — so a slot
 * being rewritten never looks verified, and a run that only verifies never erases its own input.
 */
export async function runRebuild({ verify = false, resume = false }, ops) {
  if (verify) return ops.verify();
  const done = await ops.state(resume);
  if (done.has('ship')) return ops.verify();
  let unverified = !done.has('prepare');
  if (unverified) await ops.prepare();
  else await ops.rehydrate(done);
  const writing = async (op) => {
    if (!unverified) await ops.unverify();
    unverified = true;
    return op();
  };
  if (!done.has('import')) await writing(ops.import);
  if (!done.has('registry')) await writing(ops.registry);
  await ops.local(done);
  return writing(ops.ship);
}

/**
 * The stages of a run against one slot (`runRebuild`), wired as `main()` runs them. Everything that reaches
 * outside the process comes in through `deps`, so a test drives these very stages — their receipts, their
 * seals, the commit and the checkpoint run they pass on — against a real SQLite slot:
 *
 *   target, live        the idle slot (the only one written) and the live one (read for its links)
 *   runId, commit       this run and the commit it was built from (`SIGMA_SOURCE_COMMIT`, or null)
 *   work, today         the local work directory and the day the procurement import reads up to
 *   apply, read         a file into the slot, one read of it (`wranglerFileSender`, `d1Json`)
 *   verifyRead          the verification's reader (`slotReader`)
 *   liveSleep           pause between live link queries and retries
 *   wrangler, step, sqlite, emit   the CLI, a child step, the sqlite3 shell, `emit-refresh-group`
 *   version             the data version of the code that builds
 *   check, now          the integrity gate and the clock, for the ship's verification
 */
export function slotOps({
  target,
  live,
  runId,
  commit,
  work,
  today,
  apply,
  read = d1Json,
  verifyRead,
  wrangler: cli = wrangler,
  liveSleep = sleepSync,
  step: child = step,
  sqlite: shell = sqlite,
  emit = emitRefreshGroup,
  version = () =>
    JSON.parse(readFileSync(resolve(root, 'packages/db/data-version.json'), 'utf8')).version,
  check,
  now = () => new Date().toISOString(),
}) {
  const db = join(work, 'slot.sqlite');
  const jobDir = join(work, 'declarations');
  const snapshot = join(jobDir, 'backfill.sqlite');
  const receipt = (name, detail = null) => receiptSql(name, runId, now(), detail);
  return {
    // A verification on its own: the slot was shipped by an earlier run and nothing is built or written
    // but the stamp. The run's audit is this verification; what it publishes is the slot's version.
    verify: () => {
      stage('verify');
      return verifySlot(target.name, { read: verifyRead, apply, runId, check, now });
    },
    // 0. The slot is the durable store of this rebuild. It is emptied and shaped once; from there on
    // every stage that writes it leaves its rows and its receipt there, so a stopped container resumes
    // from the slot instead of building for hours again (`runRebuild`).
    state: (anyRun) => slotState(target.name, runId, read, anyRun),
    rehydrate: async (done) => {
      stage('import');
      // The schema comes from the migrations, the rows from the slot: D1 refuses to export a database
      // that holds a virtual table, and the search index is one. Named tables, data only.
      await rehydrate(db, target.name, work, { read, wrangler: cli, sqlite: shell });
      console.log(`resumed from the slot after: ${[...done.keys()].join(', ')}`);
    },
    prepare: () => {
      stage('import');
      emptySlot(target.name, apply, read);
      cli(['d1', 'migrations', 'apply', target.name, '--remote']);
      // The commit that prepared the slot decides whether a resume may adopt its checkpoints.
      apply('state-prepare', receipt('prepare', JSON.stringify({ commit })));
    },
    unverify: () => apply('unverify', UNVERIFY_SQL),

    // 1. The procurement corpus, from the open data, into a fresh file with every migration.
    import: async () => {
      await child('import', [
        'scripts/import.mjs',
        `--work-db=${db}`,
        '--from=2020-01-01',
        `--to=${today}`,
        '--no-ship',
      ]);
      fillSlot(target.name, db, work, {
        label: 'import',
        apply,
        read,
        seal: () => receipt('import'),
      });
    },

    // 2. The Trade Register: every winner's partida, through the daily ETL's own reader and writer. Each
    // batch of partidas goes straight into the slot with the queue that names what is left, so a stop
    // costs the batch and not the hours before it.
    registry: async () => {
      // `--defer-baseline`: the winners are only half the register. The rest — the companies the
      // declarations name — are known after stage 5 reads them, and the catch-up pass there accepts the
      // baseline for both sets. A baseline accepted here would call the register complete too early.
      await child('registry', [
        'scripts/tr/rebuild-registry.mjs',
        '--db',
        db,
        '--slot',
        target.name,
        '--defer-baseline',
      ]);
      // The registry's receipt travels with its cursors once more, after the last batch.
      const local = new DatabaseSync(db, { readOnly: true });
      try {
        await slotFlusher(target.name, local, apply).seal(receipt('registry'));
      } finally {
        local.close();
      }
    },

    local: async (done) => {
      // 3. Public ownership, then the rollups and the entity search index.
      stage('precompute');
      const { PUBLIC_OWNERSHIP_SQL } = await import('../apps/etl/src/public-ownership.ts');
      await shell(
        'precompute',
        db,
        readFileSync(resolve(root, 'scripts/seed-state-owned.sql'), 'utf8'),
      );
      await shell('precompute', db, PUBLIC_OWNERSHIP_SQL.map((s) => `${s};`).join('\n'));
      await shell(
        'precompute',
        db,
        ownershipStatements(readFileSync(resolve(root, 'scripts/refresh-slice.sql'), 'utf8')),
      );
      await shell('precompute', db, readFileSync(resolve(root, 'scripts/precompute.sql'), 'utf8'));

      // 4. Carry the prior links and seals so the declarations gate compares against what was published.
      captureLiveLinks(db, live.name, cli, liveSleep);

      // 5. The declarations, in the job's local mode, against this snapshot — in two halves, because the
      // register was read for the winners and the declarations name companies no winner list contains
      // (measured on the first full rebuild: 13,121 partidas against the live slot's 14,118, and 33
      // published links lost). The first half stops once the declarations have said which companies they
      // mean; the register is read for those; the second half decides against the fuller register.
      const declarations = (...extra) =>
        child(
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
          { SIGMA_REBUILD: '1', SIGMA_CHECKPOINT_RUN_ID: checkpointRun(done, runId, commit) },
        );
      await declarations('--until', 'candidates');
      // The catch-up pass reads the requested companies and accepts the baseline for winners and
      // requested together. It writes the snapshot, which stage 7 ships whole, so the new partidas travel
      // with it.
      await child('declarations', ['scripts/tr/rebuild-registry.mjs', '--db', snapshot]);
      await declarations('--from', 'decide');

      // 6. The people in the search index.
      stage('search');
      const built = new DatabaseSync(snapshot);
      const officials = built
        .prepare(
          `SELECT DISTINCT person_id id FROM interest_links
           WHERE status='published' AND interest_class IN ('private_ownership','family_ownership') ORDER BY 1`,
        )
        .all()
        .map((r) => r.id);
      built.close();
      if (officials.length) await shell('search', snapshot, emit(officials));
      await shell(
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
    // cannot finish for D1 runs again on its own — the next attempt, a resume or SIGMA_REBUILD_VERIFY=1
    // — without building anything.
    ship: () => {
      stage('ship');
      return finishBuild(target.name, snapshot, work, {
        apply,
        read,
        verifyRead,
        runId,
        version: version(),
        commit,
        check,
        now,
      });
    },
  };
}

/** The official search index for the given people, as `emit-refresh-group` writes it. */
const emitRefreshGroup = (officials) =>
  execFileSync(
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
  const runId = process.env.SIGMA_RUN_ID ?? '';
  let reads = 0;
  const ops = slotOps({
    target,
    live,
    runId,
    commit: process.env.SIGMA_SOURCE_COMMIT || null,
    work,
    today: new Date().toISOString().slice(0, 10),
    // Every file into the slot carries its receipt: the rows of a chunk are not repeatable, and wrangler
    // can report a failure for a file that landed (scripts/d1-retry.mjs).
    apply: wranglerFileSender({ d1Name: target.name, remote: true, dir: work, cwd: webDir }),
    verifyRead: slotReader(target.name, { beat: () => progress('verify', ++reads) }),
  });
  const result = await runRebuild(
    {
      verify: process.env.SIGMA_REBUILD_VERIFY === '1',
      resume: process.env.SIGMA_REBUILD_RESUME === '1',
    },
    ops,
  );
  console.log(
    JSON.stringify({
      event: 'declarations_job_complete',
      runId: process.env.SIGMA_RUN_ID ?? null,
      audit: true,
      published: true,
      slot: target.name,
      tables: result.tables,
      rows: result.rows,
      dataVersion: result.version,
      sourceCommit: result.commit,
      // The ship that passed: on a run that only verified, an earlier build's.
      shipRun: result.shipRun,
      builtAt: result.builtAt,
    }),
  );
}

if (import.meta.main)
  await main().catch((error) => {
    const verdict = verdictEvent(error);
    if (!verdict) throw error;
    console.log(`Error: ${error.message}`);
    console.log(JSON.stringify(verdict));
    process.exit(1);
  });
