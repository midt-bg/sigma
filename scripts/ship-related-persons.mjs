#!/usr/bin/env node
// Ship the свързани-лица domain (persons + declarations + declared_interests + interest_links +
// interest_link_authorities) from a sqlite work DB to the served D1. Kept SEPARATE
// from ship-domain.mjs so the EOP deploy path is untouched; reuses the same literal-escaping + batching.
// Migration 0003 must already be applied (the deploy applies it via `d1 execute --file`, not
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

// INSERT order — parents before children. Suppressions are NOT a served table (ADR-0031): they are applied
// at load, so `interest_links` already ships with status='suppressed' and there is nothing to re-apply on
// D1. D1 DOES enforce foreign keys, so a re-seed of an already-populated D1 must DELETE in the reverse
// (children-first) order: deleting a parent while children still reference it fails with
// SQLITE_CONSTRAINT_FOREIGNKEY (a re-seed then dies at persons).
export const TABLES = [
  'persons',
  'declarations',
  'declared_interests',
  'interest_links',
  // AFTER interest_links: a seal references its link, so inserting it first fails the FK (#279).
  'interest_link_evidence',
  'interest_link_authorities',
];
// DELETE order for the pre-insert wipe — children before parents. related_persons_internal (PII, never
// re-shipped) also REFERENCES declarations, so it is wiped before declarations; otherwise a populated D1
// carrying internal rows would block DELETE FROM declarations.
export const WIPE_ORDER = [
  'interest_link_authorities',
  // BEFORE interest_links, for the mirror reason: deleting a link whose seal survives fails the FK.
  'interest_link_evidence',
  'related_persons_internal',
  'interest_links',
  'declared_interests',
  'declarations',
  'persons',
];
export function wipeSql() {
  return WIPE_ORDER.map((t) => `DELETE FROM ${sqlIdent(t)};`).join('\n') + '\n';
}
const MAX_BATCH_BYTES = 90_000;
export const MAX_BATCH_ROWS = 400;

// One `d1 execute --file` per TABLE meant the whole table went up as a single bulk import: on the first
// full-corpus ship that was 516k rows written in one hour with a p90 batch time of 18.2s, two orders of
// magnitude above a normal cron hour (2.9-4.5k rows, 19-450ms) — after which the database returned
// „internal error" for hours, including on its own metadata endpoint, before recovering with all data
// intact. The Cloudflare-side mechanism is not provable from outside, so this is a deliberate defensive
// bound rather than a proven fix: cap how much one request carries and leave a gap between requests, so a
// re-seed is a series of ordinary writes instead of one shock. 25 × MAX_BATCH_ROWS = 10 000 rows/request.
export const MAX_STATEMENTS_PER_REQUEST = 25;
export const PACE_MS = 500;

/** Group per-table INSERT statements into request-sized chunks. Pure — unit-tested. */
export function chunkStatements(statements, maxPerRequest = MAX_STATEMENTS_PER_REQUEST) {
  if (!Number.isInteger(maxPerRequest) || maxPerRequest < 1)
    throw new Error(
      `maxPerRequest must be a positive integer, got ${JSON.stringify(maxPerRequest)}`,
    );
  const chunks = [];
  for (let i = 0; i < statements.length; i += maxPerRequest)
    chunks.push(statements.slice(i, i + maxPerRequest));
  return chunks;
}

/** Block the (synchronous) ship loop without burning CPU. */
const sleepSync = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * The whole destructive live path: wipe, then paced request-sized inserts per table, then the read-back
 * check. Both guarantees live HERE, behind injected I/O (`apply`, `sleep`, `readCounts`), because both are
 * one refactor away from silently vanishing — „one request per table" is exactly the shape this drifts back
 * to, and a `if (!emit) assert…` line at a call site is exactly the kind of line that gets dropped.
 * Testing the pure helpers alone did NOT catch either: reverting the call site and deleting the
 * verification each left the whole suite green. Keep the orchestration itself covered.
 * @returns {Record<string, number|string>} rows shipped per table
 */
export function runShip({
  tables,
  readTable,
  wipeSql,
  apply,
  sleep,
  readCounts,
  maxStatements,
  paceMs,
}) {
  // ONE counter for the whole run, not one per table. Pacing per table left every table boundary
  // unpaced — including wipe → first insert, which is the single most destructive transition here.
  let requests = 0;
  const applyPaced = (label, sql) => {
    if (requests++) sleep(paceMs); // between requests only — never before the first
    apply(label, sql);
  };

  applyPaced('0_wipe', wipeSql);

  const summary = {};
  for (const table of tables) {
    const read = readTable(table);
    if (!read) {
      summary[table] = 'absent (skipped)';
      continue;
    }
    summary[table] = read.rowCount;
    const chunks = chunkStatements(read.statements, maxStatements);
    chunks.forEach((chunk, i) =>
      applyPaced(chunks.length > 1 ? `${table}.${i + 1}` : table, chunk.join('')),
    );
  }

  assertShippedCounts(summary, readCounts(summary));
  return summary;
}

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
// numbers. Values come from our own sqlite (int/text/null via `sqlite3 -json`), but this is still the trust
// boundary into D1, so every JS type maps to an explicit SQL form rather than falling through to String(v):
// boolean → 1/0 and bigint → its digits (ydimitrof #226), so a source change can't emit `'true'` or a
// mistyped literal.
export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'bigint') return String(v);
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

/** Shared shape check for the pacing flags: a bare `--flag` must not silently mean 1 (or 0). */
function parseIntFlag(raw, name, min) {
  if (raw === true) throw new Error(`--${name} requires a value, e.g. --${name}=25`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min)
    throw new Error(`--${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}.`);
  return n;
}
const parsePositiveInt = (raw, name) => parseIntFlag(raw, name, 1);
const parseNonNegativeInt = (raw, name) => parseIntFlag(raw, name, 0);

/**
 * The D1 name to ship to. A --remote write MUST name its target explicitly: this path DELETEs every
 * свързани-лица table before re-inserting, so a silent fallback on a remote run is unacceptable — an unset
 * SIGMA_D1_NAME must fail closed, not guess. (The real prod slots are `sigma-blue`/`sigma-green`; there is no
 * slot named `sigma` — see PRODUCTION_SLOTS.) --local carries no durable blast radius, so it keeps a bare
 * `sigma` local default for the on-disk dev DB. Pure — unit-tested.
 */
export function resolveD1Name({ remote, envName }) {
  if (remote && !envName)
    throw new Error(
      'SIGMA_D1_NAME must be set for a --remote ship — refusing to guess a wipe target. Set it to the ' +
        "target environment's D1 name (production: sigma-blue | sigma-green).",
    );
  return envName || 'sigma';
}

// The blue-green PRODUCTION D1 slots (deploy.md „production" row): `sigma-blue` and `sigma-green`. There is no
// slot named `sigma` — the pointer (SIGMA_D1_ID) moves between these two; the name is cosmetic. Fixed HERE, in
// the repo — the wipe-prod footgun the authorization check guards against (todorkolev #226: a stale value here
// let `sigma-blue`, the real prod slot, slip past the non-production denylist in 2b below).
export const PRODUCTION_SLOTS = ['sigma-blue', 'sigma-green'];

/**
 * Version-controlled ship-target policy by ENVIRONMENT (T48, todorkolev #226). production pins its exact
 * allowed D1 names in the repo; non-production names are environment-configured (each GitHub Environment's
 * SIGMA_D1_NAME var), so the repo rule there is the mirror-image guard: the name must NOT be a production slot.
 * `null` means „any non-production name". Mirrors related-persons-data.yml's env→name guard.
 */
export const SHIP_TARGETS = {
  production: PRODUCTION_SLOTS,
  staging: null,
  dev: null,
};

/**
 * Positive AUTHORIZATION check before the destructive wipe. A --remote ship DELETEs every свързани-лица table,
 * so proving the (name, id) pair is self-consistent is NOT enough — two consistently-wrong values (a staging
 * name paired with its staging id, when production was intended) would pass (todorkolev #226). Authorization
 * needs a THIRD, independent anchor: the operator DECLARES the intended environment (SIGMA_SHIP_ENV), and the
 * repo policy pins production's names / forbids a production name outside production. So the declared env
 * (repo) and the id (Cloudflare-resolved vs the operator's SIGMA_D1_ID) come from different sources and can't
 * be made consistent-but-wrong by inadvertence. Pure — unit-tested; the live id lookup is injected as
 * `resolvedId`. --local carries no durable blast radius, so it is exempt.
 */
export function assertD1TargetAuthorized({ remote, shipEnv, d1Name, expectedId, resolvedId }) {
  if (!remote) return;
  // 1. The intended environment must be DECLARED and known — the independent anchor the id/name pair can't fake.
  if (!(shipEnv in SHIP_TARGETS))
    throw new Error(
      `SIGMA_SHIP_ENV must name a known environment (${Object.keys(SHIP_TARGETS).join(' | ')}) for a --remote ship — got ${JSON.stringify(shipEnv)}. Without it, a consistent-but-wrong (name, id) pair cannot be caught.`,
    );
  const allowed = SHIP_TARGETS[shipEnv];
  // 2a. production: the name must be one of the repo-pinned prod slots.
  if (allowed && !allowed.includes(d1Name))
    throw new Error(
      `D1 name '${d1Name}' is not an allowed target for SIGMA_SHIP_ENV='${shipEnv}' (allowed: ${allowed.join(', ')}) — refusing to wipe.`,
    );
  // 2b. non-production: the name must NOT be a production slot (the „meant dev, wiped prod" footgun).
  if (!allowed && PRODUCTION_SLOTS.includes(d1Name))
    throw new Error(
      `D1 name '${d1Name}' is a PRODUCTION slot but SIGMA_SHIP_ENV='${shipEnv}' — refusing to wipe production from a non-production ship.`,
    );
  // 3. …and the name must resolve (live, at Cloudflare) to exactly the id the Environment claims (SIGMA_D1_ID).
  if (!expectedId)
    throw new Error(
      'SIGMA_D1_ID must be set for a --remote ship — cannot verify the wipe target without the expected id.',
    );
  if (!resolvedId)
    throw new Error(
      `could not resolve a database id for D1 name '${d1Name}' — refusing to wipe an unverifiable target.`,
    );
  if (resolvedId !== expectedId)
    throw new Error(
      `D1 target mismatch: name '${d1Name}' resolves to id ${resolvedId}, but SIGMA_D1_ID is ${expectedId}. ` +
        'The name and id disagree (misconfigured Environment or stale id) — refusing to wipe.',
    );
}

/** Live lookup of the uuid Cloudflare maps `d1Name` to, via `wrangler d1 info --json`. Returns '' on any
 *  failure (unknown name, network, parse) so assertD1TargetConsistent turns that into an explicit refusal. */
/**
 * Read the shipped tables' row counts back off the target, in one query. Returns {} when the read itself
 * fails — `assertShippedCounts` then reports every table as unanswered and fails the run, which is the
 * right way round: a verification step that cannot verify must not pass.
 */
/** First bracket that actually parses — a notice on the same stream could contain one of its own.
 *  Belt-and-braces: today wrangler keeps notices on stderr (see the call site). Exported for the test. */
export function parseWranglerJson(out) {
  for (let i = out.indexOf('['); i >= 0; i = out.indexOf('[', i + 1)) {
    try {
      return JSON.parse(out.slice(i));
    } catch {
      // not the payload — keep looking
    }
  }
  return JSON.parse(out); // no usable bracket: let the original parse error surface
}

function readShippedCounts(d1Name, remote, expected) {
  const tables = Object.entries(expected)
    .filter(([, n]) => typeof n === 'number')
    .map(([t]) => t);
  if (!tables.length) return {};
  const sql = tables
    .map((t) => `SELECT ${sqlLiteral(t)} AS t, COUNT(*) AS n FROM ${sqlIdent(t)}`)
    .join(' UNION ALL ');
  try {
    const out = execFileSync(
      'wrangler',
      ['d1', 'execute', d1Name, remote ? '--remote' : '--local', '--json', '--command', sql],
      { cwd: resolve('apps/web'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    // Defensive, NOT a fix for an observed failure — the earlier wording here claimed otherwise and
    // was wrong. Checked against the real tool: `wrangler d1 execute --json` writes its notices
    // („▲ [WARNING] Processing wrangler.jsonc") to STDERR and leaves stdout as clean JSON, and
    // execFileSync returns stdout alone, so slicing from the first '[' is in fact safe today. The
    // scan below survives a future release that changes that, and costs one failed parse if it does.
    const parsed = parseWranglerJson(out);
    const rows = (Array.isArray(parsed) ? parsed[0]?.results : parsed?.results) ?? [];
    // Only a real number counts as an answer. `Number(null)` is 0, which would let a null-valued cell pass
    // for „the table is empty"; anything non-numeric must land as NaN so assertShippedCounts fails closed.
    return Object.fromEntries(rows.map((r) => [r.t, typeof r.n === 'number' ? r.n : Number.NaN]));
  } catch (err) {
    console.error(
      `ship: could not read back row counts — ${err instanceof Error ? err.message : err}`,
    );
    return {};
  }
}

function resolveD1Id(d1Name) {
  try {
    const out = execFileSync('wrangler', ['d1', 'info', d1Name, '--json'], {
      cwd: resolve('apps/web'),
      encoding: 'utf8',
    });
    const info = JSON.parse(out);
    return info?.uuid ?? info?.database_id ?? '';
  } catch {
    return '';
  }
}

/**
 * Compare what we meant to ship against what the target actually holds. Pure — unit-tested; the live read
 * is injected as `readCounts`.
 *
 * The ship is a wipe followed by SEVERAL independent requests (no cross-request transaction), so a failure
 * part-way leaves the target holding some tables and not others — and today nothing notices: the run exits 0
 * and the surface renders as a smaller corpus. That asymmetry is glaring next to the READ path, where the
 * EOP hydrate already refuses to proceed on a local↔remote row-count mismatch. Close it on the destructive
 * side too: any drift fails the run, loudly and with the numbers.
 */
export function assertShippedCounts(expected, actual) {
  const drift = Object.entries(expected)
    .filter(([, n]) => typeof n === 'number')
    .map(([table, n]) => ({ table, expected: n, actual: actual[table] }))
    .filter(({ expected: e, actual: a }) => a !== e);
  if (drift.length)
    throw new Error(
      'ship verification FAILED — the target does not hold what was shipped:\n' +
        drift
          .map(
            ({ table, expected: e, actual: a }) =>
              `  ${table}: shipped ${e}, target has ${a === undefined ? 'no answer' : a}`,
          )
          .join('\n') +
        '\nThe wipe already ran, so the surface is now partial. Re-run the ship.',
    );
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
    // A single tuple larger than the batch budget can't be split — it ships as a lone statement that may
    // exceed D1's per-statement size limit and fail at apply time. Make that explicit rather than a silent
    // over-limit INSERT (ydimitrof #226); the schema has no such wide column today, so this is a canary.
    if (Buffer.byteLength(prefix) + tupleBytes > MAX_BATCH_BYTES)
      console.warn(
        `ship: oversized row for ${table} (${tupleBytes}B > ${MAX_BATCH_BYTES}B budget) — emitted as a lone statement; may exceed D1's statement limit`,
      );
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
  const maxStatements = parsePositiveInt(
    arg('max-statements-per-request', MAX_STATEMENTS_PER_REQUEST),
    'max-statements-per-request',
  );
  const paceMs = parseNonNegativeInt(arg('pace-ms', PACE_MS), 'pace-ms');
  if (remote && !arg('yes', false))
    throw new Error('--remote requires --yes (guards against an accidental prod write)');

  const sqliteJson = (sql) => {
    const out = execFileSync('sqlite3', ['-json', String(workDb), sql], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    }).trim();
    return out ? JSON.parse(out) : [];
  };
  // Floor gate BEFORE any destructive write (assertShipFloor) — runs for --emit too: the emitted 0_wipe.sql is
  // a hand-appliable destructive script, so it must clear the same anti-wipe floor as a live apply, not sneak
  // an under-floor wipe past the guard by going through --emit (todorkolev #226). Counts surfaced links only:
  // status='published' is the public surface (load.mjs assigns non-surfaced classes 'internal').
  const published =
    sqliteJson(`SELECT COUNT(*) AS n FROM interest_links WHERE status = 'published'`)[0]?.n ?? 0;
  assertShipFloor(Number(published), minLinks);
  // Positive AUTHORIZATION check on a real remote wipe: the declared env + (name, id) must name an allowlisted
  // target (T48). Skipped for --emit (writes SQL files, touches no DB) — but the emitted wipe is stamped with a
  // loud header below so a later manual apply is never mistaken for a guarded one.
  if (!emit)
    assertD1TargetAuthorized({
      remote,
      shipEnv: process.env.SIGMA_SHIP_ENV ?? '',
      d1Name,
      expectedId: process.env.SIGMA_D1_ID,
      resolvedId: remote ? resolveD1Id(d1Name) : '',
    });

  // D1 enforces foreign keys, so a re-seed cannot DELETE a parent while children still reference it. Wipe
  // every table first, children-before-parents (WIPE_ORDER), as ONE batched request — `d1 execute --file`
  // is a single request but not cross-statement transactional (ydimitrof #226); harmless here (all DELETEs
  // in FK-correct order, and the surface is only briefly empty), but not "atomic". Then re-insert
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
  // Children-first wipe. Emit as 0_wipe.sql so a manual apply runs it before the parent-first inserts. Stamp a
  // loud header: the emitted file bypassed the live authorization guard (it names no DB), so whoever applies it
  // by hand owns the target check that assertD1TargetAuthorized would otherwise enforce (todorkolev #226).
  const EMIT_WIPE_HEADER =
    '-- ⚠ DESTRUCTIVE, UNGUARDED: this wipe was emitted with --emit and did NOT pass the live D1\n' +
    '-- target-authorization check (SIGMA_SHIP_ENV allowlist + name↔SIGMA_D1_ID). If you apply it by hand,\n' +
    '-- YOU are responsible for confirming the target D1 is the intended one before running it.\n';
  // One read of a source table: null when the table is absent from the work DB.
  const readTable = (table) => {
    const cols = sqliteJson(`PRAGMA table_info(${sqlIdent(table)})`).map((r) => r.name);
    if (!cols.length) return null;
    const rows = sqliteJson(`SELECT * FROM ${sqlIdent(table)}`);
    return { rowCount: rows.length, statements: insertStatements(table, cols, rows) };
  };

  let summary = {};
  try {
    if (emit) {
      // --emit keeps ONE file per table: those are applied by hand, and numbered fragments would only add
      // ordering rope to a manual run. Nothing is written to a DB, so there is nothing to pace or verify —
      // the header on 0_wipe.sql puts the target check on whoever applies them.
      writeFileSync(resolve(emit, '0_wipe.sql'), EMIT_WIPE_HEADER + wipeSql());
      for (const table of TABLES) {
        const read = readTable(table);
        if (!read) {
          summary[table] = 'absent (skipped)';
          continue;
        }
        summary[table] = read.rowCount;
        writeFileSync(resolve(emit, `${table}.sql`), read.statements.join(''));
      }
    } else {
      summary = runShip({
        tables: TABLES,
        readTable,
        wipeSql: wipeSql(),
        apply: applyFile,
        sleep: sleepSync,
        readCounts: (expected) => readShippedCounts(d1Name, remote, expected),
        maxStatements,
        paceMs,
      });
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
