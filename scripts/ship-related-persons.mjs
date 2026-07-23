#!/usr/bin/env node
// Ship the свързани-лица domain (persons + declarations + declared_interests + interest_links +
// interest_link_authorities + link_suppressions) from a sqlite work DB to the served D1. Kept SEPARATE
// from ship-domain.mjs so the EOP deploy path is untouched; reuses the same literal-escaping + batching.
// Migration 0002 must already be applied (the deploy applies it via `d1 execute --file`, not
// `d1 migrations apply` — 0000 was created out-of-band so wrangler's migration tracking is empty). No
// precompute — the query layer reads interest_links directly.
//
// related_persons_internal (relative names — PII) is DELIBERATELY NOT shipped: no served query reads it,
// so pushing it to the public D1 is PII we never surface. It stays in the build/work DB only (load.mjs
// uses it for a census COUNT). The relative is anonymized as „свързано лице" via interest_links.relation.
//
//   node scripts/ship-related-persons.mjs --work-db data/work/backfill.sqlite --emit out/rp   # SQL only
//   node scripts/ship-related-persons.mjs --work-db … --remote --yes                          # apply to D1
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// INSERT order — parents before children. link_suppressions first so a re-import can't briefly expose a
// contested link (it is back in place before interest_links reappears). D1 DOES enforce foreign keys, so a
// re-seed of an already-populated D1 must DELETE in the reverse (children-first) order: deleting a parent
// while children still reference it fails with SQLITE_CONSTRAINT_FOREIGNKEY (a re-seed then dies at persons).
export const TABLES = [
  'link_suppressions',
  'persons',
  'declarations',
  'declared_interests',
  'interest_links',
  'interest_link_authorities',
];
// DELETE order for the pre-insert wipe — children before parents. related_persons_internal (PII, never
// re-shipped) also REFERENCES declarations, so it is wiped before declarations; otherwise a populated D1
// carrying internal rows would block DELETE FROM declarations.
export const WIPE_ORDER = [
  'interest_link_authorities',
  'related_persons_internal',
  'interest_links',
  'declared_interests',
  'declarations',
  'persons',
  'link_suppressions',
];
export function wipeSql() {
  return WIPE_ORDER.map((t) => `DELETE FROM ${sqlIdent(t)};`).join('\n') + '\n';
}
const MAX_BATCH_BYTES = 90_000;
const MAX_BATCH_ROWS = 400;

// Supports --name=value, --name value, and bare --name (boolean). A --name whose next token is another
// --flag (or absent) is a boolean; otherwise it consumes the next token as its value.
const arg = (name, def) => {
  const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = process.argv[i];
  const eq = a.indexOf('=');
  if (eq >= 0) return a.slice(eq + 1);
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

export function sqlIdent(s) {
  return `"${String(s).replaceAll('"', '""')}"`;
}
// SQL literal — the ONLY interpolation into shipped SQL. Strips NUL, doubles quotes, NULLs non-finite
// numbers. Values come from our own sqlite, but this is still the trust boundary into D1.
export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replaceAll('\x00', '').replaceAll("'", "''")}'`;
}

/**
 * Refuse to ship when the published (surfaced) link count is below a floor. Empty/partial staging — a
 * cold cache on a `full_crawl=false` run, or a broken extract — yields 0 published links; `audit.mjs`
 * then passes trivially (0 links = 0 violations), and the per-table `DELETE FROM` below would WIPE the
 * live public surface with zero re-inserts. This floor is the last gate before that. Override deliberately
 * with `--min-links=<N>` when a genuinely smaller set is expected. Pure — unit-tested.
 */
export function assertShipFloor(publishedCount, minLinks) {
  if (publishedCount < minLinks) {
    throw new Error(
      `refusing to ship: ${publishedCount} published links < floor ${minLinks}. Empty/partial staging ` +
        `would wipe the live surface. If this smaller set is intentional, re-run with --min-links=${publishedCount}.`,
    );
  }
}

/**
 * Parse the --min-links floor. Footgun guarded: `arg()` returns boolean `true` for a VALUELESS `--min-links`
 * flag, and `Number(true) === 1` — which silently collapses the anti-wipe floor from 50 to 1 while passing a
 * naive integer check. Reject the bare `true` explicitly, then require a positive integer. Pure — unit-tested.
 */
export function parseMinLinks(raw) {
  if (raw === true)
    throw new Error(
      '--min-links requires a value, e.g. --min-links=25 — a bare flag would collapse the anti-wipe floor to 1.',
    );
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`--min-links must be a positive integer, got ${JSON.stringify(raw)}.`);
  return n;
}

/**
 * The D1 name to ship to. A --remote write MUST name its target explicitly: on a remote run an unset
 * SIGMA_D1_NAME falling back to the prod default 'sigma' silently wipes+reloads PRODUCTION (this path
 * DELETEs every свързани-лица table before re-inserting). --local carries no such blast radius, so it
 * keeps the 'sigma' default. Pure — unit-tested.
 */
export function resolveD1Name({ remote, envName }) {
  if (remote && !envName)
    throw new Error(
      "SIGMA_D1_NAME must be set for a --remote ship — refusing the production default 'sigma', which " +
        "would wipe+reload prod. Set it to the target environment's D1 name.",
    );
  return envName || 'sigma';
}

/** Batched multi-row INSERTs for one table, bounded by D1's statement size. Pure — unit-tested. */
export function insertStatements(table, cols, rows) {
  if (!cols.length || !rows.length) return [];
  const prefix = `INSERT INTO ${sqlIdent(table)} (${cols.map(sqlIdent).join(', ')}) VALUES\n`;
  const statements = [];
  let batch = [];
  let bytes = Buffer.byteLength(prefix) + 2;
  const flush = () => {
    if (!batch.length) return;
    statements.push(prefix + batch.join(',\n') + ';\n');
    batch = [];
    bytes = Buffer.byteLength(prefix) + 2;
  };
  for (const row of rows) {
    const tuple = `(${cols.map((c) => sqlLiteral(row[c])).join(',')})`;
    const tupleBytes = Buffer.byteLength(tuple) + 2;
    if (batch.length && (batch.length >= MAX_BATCH_ROWS || bytes + tupleBytes > MAX_BATCH_BYTES))
      flush();
    batch.push(tuple);
    bytes += tupleBytes;
  }
  flush();
  return statements;
}

function main() {
  const workDb = arg('work-db', 'data/work/backfill.sqlite');
  const emit = arg('emit', '');
  const remote = Boolean(arg('remote', false));
  const d1Name = resolveD1Name({ remote, envName: process.env.SIGMA_D1_NAME });
  const minLinks = parseMinLinks(arg('min-links', 50));
  if (remote && !arg('yes', false))
    throw new Error('--remote requires --yes (guards against an accidental prod write)');

  const sqliteJson = (sql) => {
    const out = execFileSync('sqlite3', ['-json', String(workDb), sql], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    }).trim();
    return out ? JSON.parse(out) : [];
  };
  // Floor gate BEFORE any destructive write (see assertShipFloor). Only when actually applying — `--emit`
  // just writes SQL files and wipes nothing. Counts surfaced links only: status='published' is the public
  // surface (load.mjs assigns non-surfaced classes 'internal', not 'published').
  if (!emit) {
    const published =
      sqliteJson(`SELECT COUNT(*) AS n FROM interest_links WHERE status = 'published'`)[0]?.n ?? 0;
    assertShipFloor(Number(published), minLinks);
  }

  // D1 enforces foreign keys, so a re-seed cannot DELETE a parent while children still reference it. Wipe
  // every table first, children-before-parents (WIPE_ORDER), as ONE atomic batched request; then re-insert
  // parents-before-children (TABLES), each table its own batched request. Trade-off vs the old per-table
  // DELETE+INSERT: the surface is briefly empty between the wipe and the interest_links re-insert. That is
  // acceptable for a deliberate manual re-seed and is the only structure that both works on a populated D1
  // AND stays FK-correct — a single-transaction full replace exceeds D1's per-batch size ceiling.
  const tmp = emit ? null : mkdtempSync(join(tmpdir(), 'sigma-ship-'));
  const applyFile = (name, sql) => {
    const f = join(tmp, `${name}.sql`);
    writeFileSync(f, sql);
    try {
      execFileSync(
        'wrangler',
        ['d1', 'execute', d1Name, remote ? '--remote' : '--local', '--yes', '--file', f],
        { cwd: resolve('apps/web'), stdio: 'inherit' },
      );
    } finally {
      rmSync(f, { force: true });
    }
  };

  if (emit) mkdirSync(emit, { recursive: true });
  // Children-first wipe. Emit as 0_wipe.sql so a manual apply runs it before the parent-first inserts.
  if (emit) writeFileSync(resolve(emit, '0_wipe.sql'), wipeSql());
  else applyFile('0_wipe', wipeSql());

  const summary = {};
  try {
    for (const table of TABLES) {
      const cols = sqliteJson(`PRAGMA table_info(${sqlIdent(table)})`).map((r) => r.name);
      if (!cols.length) {
        summary[table] = 'absent (skipped)';
        continue;
      }
      const rows = sqliteJson(`SELECT * FROM ${sqlIdent(table)}`);
      const inserts = insertStatements(table, cols, rows).join('');
      summary[table] = rows.length;
      if (emit) writeFileSync(resolve(emit, `${table}.sql`), inserts);
      else if (inserts) applyFile(table, inserts); // wipe already cleared it; skip an empty INSERT batch
    }
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify(
      { workDb, target: emit ? `emit:${emit}` : remote ? 'D1:remote' : 'D1:local', rows: summary },
      null,
      2,
    ),
  );
}

// Only run when invoked directly (importing for tests has no side effects). pathToFileURL — not a raw
// `file://` template — so a repo path with spaces or non-ASCII (which import.meta.url percent-encodes)
// still matches and the CLI runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
