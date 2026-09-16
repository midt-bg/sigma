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
import { assertAuditedBuild } from './cacbg/build-proof.mjs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
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
  'person_entities',
  'person_sources',
  'person_identity_evidence',
  'person_source_aliases',
  'registry_requested_companies',
  'declarations',
  'declared_interests',
  'interest_links',
  // AFTER interest_links: a seal references its link, so inserting it first fails the FK (#279).
  'interest_link_evidence',
  'interest_link_authorities',
  // Empty legacy table; old URL redirects are no longer generated.
  'person_redirects',
  'declaration_metadata',
  'declaration_companies',
  'person_registry_links',
  'interest_link_history',
  'declaration_identity_evidence',
  'interest_link_observations',
];
// The registry layer, parents first. Only the dev environment, which has no registry process of its own,
// takes these tables from a local work database (`--with-registry`).
export const REGISTRY_TABLES = [
  'registry_deeds',
  'registry_persons',
  'registry_roles',
  'registry_identity_observations',
  'registry_identity_snapshots',
  'registry_company_history',
];
// DELETE order for the pre-insert wipe — children before parents. related_persons_internal (PII, never
// re-shipped) also REFERENCES declarations, so it is wiped before declarations; otherwise a populated D1
// carrying internal rows would block DELETE FROM declarations.
export const WIPE_ORDER = [
  'registry_requested_companies',
  'person_source_aliases',
  'person_identity_evidence',
  'person_sources',
  'person_entities',
  'interest_link_observations',
  'declaration_identity_evidence',
  'interest_link_history',
  'declaration_companies',
  'person_registry_links',
  'declaration_metadata',
  'person_redirects',
  'interest_link_authorities',
  // BEFORE interest_links, for the mirror reason: deleting a link whose seal survives fails the FK.
  'interest_link_evidence',
  'related_persons_internal',
  'interest_links',
  'declared_interests',
  'declarations',
  'persons',
];
export function wipeSql(tables = WIPE_ORDER) {
  return tables.map((t) => `DELETE FROM ${sqlIdent(t)};`).join('\n') + '\n';
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

/**
 * Define an OWN property, never assign. `obj[k] = v` runs an inherited setter if Object.prototype
 * carries one for that name, and a hostile or merely broken setter can then swallow the write (leaving
 * no own entry, so `Object.entries` skips the table entirely) or define entries for keys nobody wrote.
 * Both the ship summary and the readback merge feed the verification guard, so both must own what they
 * record — otherwise a table can vanish from the comparison instead of failing it.
 */
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Block the (synchronous) ship loop without burning CPU. */
const sleepSync = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Upload off to the side. One SQLite trigger makes promotion one atomic statement,
 * including constraints and FK validation; an interrupted upload never touches served rows.
 * Keyed tables write differences only; unchanged rows remain in place.
 */
export function runShip({
  tables,
  wipeTables = WIPE_ORDER,
  readTable,
  apply,
  sleep,
  readCounts,
  maxStatements,
  paceMs,
}) {
  let requests = 0;
  const send = (label, sql) => {
    if (requests++) sleep(paceMs);
    apply(label, sql);
  };
  const summary = {};
  const reads = tables.map((table) => {
    const read = readTable(table);
    if (!read) throw new Error(`incomplete build: missing ${table}`);
    setOwn(summary, table, read.rowCount);
    return { table, ...read };
  });
  for (const { table, statements } of reads) {
    const staged = `rp_next_${table}`;
    send(
      `prepare_${table}`,
      `DROP TABLE IF EXISTS ${sqlIdent(staged)}; CREATE TABLE ${sqlIdent(staged)} AS SELECT * FROM ${sqlIdent(table)} WHERE 0;`,
    );
    chunkStatements(statements, maxStatements).forEach((chunk, i) =>
      send(
        `${table}.${i}`,
        chunk
          .map((sql) => sql.replace(/^INSERT INTO "[^"]+"/, `INSERT INTO ${sqlIdent(staged)}`))
          .join(''),
      ),
    );
  }
  const stagedCounts = Object.fromEntries(reads.map((r) => [`rp_next_${r.table}`, r.rowCount]));
  assertShippedCounts(stagedCounts, readCounts(stagedCounts));
  send('prepare_publish', promotionSql(reads, wipeTables));
  // Trigger bodies execute within the INSERT's transaction, including all their DELETE/INSERT work.
  send('publish', "INSERT OR REPLACE INTO rp_publish(id,published_at) VALUES (1,datetime('now'));");
  assertShippedCounts(summary, readCounts(summary));
  send(
    'cleanup_publish',
    'DROP TRIGGER IF EXISTS rp_publish_apply;\n' +
      reads.map(({ table }) => `DROP TABLE IF EXISTS ${sqlIdent(`rp_next_${table}`)};`).join('\n'),
  );
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

/** Promote the complete staged image, writing only changed rows when the schema supplies a key.
 * Parents are upserted before children; obsolete rows are then removed children-first.
 * The guards and all data changes still execute in the same atomic trigger. */
export function promotionSql(reads, wipeTables = WIPE_ORDER) {
  const keyed = (r) => r.primaryKey?.length && r.columns?.length;
  const byTable = new Map(reads.map((r) => [r.table, r]));
  const indexes = reads
    .filter(keyed)
    .map(
      (r) =>
        `CREATE UNIQUE INDEX IF NOT EXISTS ${sqlIdent(`rp_key_${r.table}`)} ON ${sqlIdent(`rp_next_${r.table}`)} (${r.primaryKey.map(sqlIdent).join(',')});`,
    )
    .join('\n');
  const guards = reads
    .map(
      ({ table, rowCount }) =>
        `SELECT RAISE(ABORT, 'incomplete staging') WHERE (SELECT COUNT(*) FROM ${sqlIdent(`rp_next_${table}`)}) != ${rowCount};`,
    )
    .join('\n');
  const clear = wipeSql(wipeTables.filter((t) => !keyed(byTable.get(t) ?? {})));
  const inserts = reads
    .map((r) => {
      const table = sqlIdent(r.table),
        staged = sqlIdent(`rp_next_${r.table}`);
      if (!keyed(r)) return `INSERT INTO ${table} SELECT * FROM ${staged};`;
      const cols = r.columns.map(sqlIdent).join(',');
      const changes = r.columns.filter((c) => !r.primaryKey.includes(c));
      const conflict = changes.length
        ? `DO UPDATE SET ${changes.map((c) => `${sqlIdent(c)}=excluded.${sqlIdent(c)}`).join(',')}`
        : 'DO NOTHING';
      const same = r.columns.map((c) => `current.${sqlIdent(c)} IS s.${sqlIdent(c)}`).join(' AND ');
      return `INSERT INTO ${table} (${cols}) SELECT ${r.columns.map((c) => `s.${sqlIdent(c)}`).join(',')} FROM ${staged} s WHERE NOT EXISTS (SELECT 1 FROM ${table} current WHERE ${same}) ON CONFLICT (${r.primaryKey.map(sqlIdent).join(',')}) ${conflict};`;
    })
    .join('\n');
  const remove = wipeTables
    .filter((t) => keyed(byTable.get(t) ?? {}))
    .map((t) => {
      const r = byTable.get(t),
        table = sqlIdent(t),
        staged = sqlIdent(`rp_next_${t}`);
      const same = r.primaryKey
        .map((c) => `s.${sqlIdent(c)} IS ${table}.${sqlIdent(c)}`)
        .join(' AND ');
      return `DELETE FROM ${table} WHERE NOT EXISTS (SELECT 1 FROM ${staged} s WHERE ${same});`;
    })
    .join('\n');
  return `${indexes}
CREATE TABLE IF NOT EXISTS rp_publish (id INTEGER PRIMARY KEY, published_at TEXT);
DROP TRIGGER IF EXISTS rp_publish_apply;
CREATE TRIGGER rp_publish_apply AFTER INSERT ON rp_publish BEGIN
${guards}
${clear}${inserts}
${remove}
END;`;
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

// Retry the readback around a single-attempt reader. `wrangler d1 execute --remote --json` is a live
// network call that intermittently times out or errors transiently; when it did, readShippedCounts
// returned {} and assertShippedCounts then failed the WHOLE run — falsely, over data that had actually
// shipped — and skipped the reindex behind it (observed on runs 32775600033 and 33207492181). The guard
// is right to fail closed; the READ under it must not turn one flaky call into a false verdict.
//
// The distinction the retry rests on: `attempt()` throwing, or returning an answer where any expected
// table is not a non-negative integer (missing, NaN, string, null), is a TRANSIENT read failure — retry
// it. A complete answer whose numbers disagree is a REAL drift — return it unchanged so
// assertShippedCounts catches it. A genuinely empty table counts as 0 (a non-negative integer), so a real
// partial ship is never mistaken for a transient miss. Pure; `attempt`/`sleep` injected, so the retry
// logic is unit-tested without touching wrangler. `sleep` defaults to the REAL synchronous sleeper — the
// backoff must fire in production, where the whole point is to ride out a transient outage; a degenerate
// `attempts` (0, negative, NaN, fractional, Infinity) falls back to the default 4 rather than making zero
// attempts or looping forever.
export function readCountsWithRetry(attempt, tables, { attempts = 4, sleep = sleepSync } = {}) {
  const budget = Number.isInteger(attempts) && attempts > 0 ? attempts : 4;
  let lastErr;
  for (let i = 0; i < budget; i++) {
    if (i > 0) sleep(2000 * i);
    try {
      const counts = attempt();
      // Object.hasOwn, not a bare lookup: a polluted Object.prototype would otherwise let an INHERITED
      // integer stand in for a count the target never reported.
      if (
        tables.every(
          (t) => Object.hasOwn(counts, t) && Number.isInteger(counts[t]) && counts[t] >= 0,
        )
      )
        return counts;
      lastErr = new Error('readback returned an incomplete answer');
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  console.error(
    `ship: could not read back row counts after ${budget} attempts — ${lastErr?.message ?? lastErr}`,
  );
  return {};
}

// How many tables one readback query may cover. The readback asks for every shipped table at once, as
// `SELECT … UNION ALL SELECT …` — one term per table. SQLite caps the terms in a compound SELECT
// (SQLITE_MAX_COMPOUND_SELECT); the stock limit is 500, but BOTH D1 runtimes cap it at 5. Measured on
// each, not assumed — five terms answer, six return `too many terms in compound SELECT: SQLITE_ERROR`;
// locally through `wrangler d1 execute --local` (workerd) and remotely against a staging database. The
// terms need not touch a table: `SELECT 1 UNION ALL …` trips it just the same, so this is the engine's
// limit and not a property of what we ship.
//
// The ship writes six tables. So the readback did not fail to READ, it failed to PARSE: wrangler
// returned an error object, no row carried a count, and the guard reported „target has no answer" for
// EVERY table — over data that had just shipped correctly — and the run died before the reindex behind
// it. Exactly the false verdict #335 removed from the flaky-network path, arriving through a different
// door: not a timeout, a query neither engine will ever accept.
//
// That is also why the scheduled workflow had been red at this step since the sixth table landed
// (#309, 2026-08-14): every run after it failed here, and the 2026-08-31 run — with #335's retries in
// place — burned all four attempts on the same rejection. A deterministic parse error does not heal
// with backoff; only splitting the query does.
//
// Four leaves room under the measured 5 for a table to be added without silently re-crossing the line.
export const READBACK_MAX_TABLES = 4;

/** Split into runs of at most `size`, order preserved. Exported so the chunking itself is testable. */
export function chunkTables(tables, size = READBACK_MAX_TABLES) {
  const width = Number.isInteger(size) && size > 0 ? size : READBACK_MAX_TABLES;
  const out = [];
  for (let i = 0; i < tables.length; i += width) out.push(tables.slice(i, i + width));
  return out;
}

// `deps` is a TEST SEAM: prod passes nothing, so `readOnce` is the live wrangler read, `sleep` falls
// through to the helper's real `sleepSync`, and `attempts` to its default 4. Tests inject a fake reader,
// a recording sleep, and a small budget to pin the retry WIRING — that readShippedCounts actually wraps
// the read in readCountsWithRetry with a real backoff, and not a one-shot — without touching wrangler.
// `readOnce` receives the group it is being asked about, so a test can answer per chunk.
export function readShippedCounts(d1Name, remote, expected, deps = {}) {
  const tables = Object.entries(expected)
    .filter(([, n]) => typeof n === 'number')
    .map(([t]) => t);
  if (!tables.length) return {};
  const counts = {};
  // BOTH targets split. An earlier revision kept the remote path on a single query, on the assumption
  // that only workerd capped compound SELECT — measuring the remote showed the same cap of 5, which is
  // precisely why the scheduled ship had been failing verification since the sixth table. The split
  // costs the remote path one extra invocation and gives up a single-snapshot read; nothing writes to
  // these tables during verification (the ship itself is the only writer, and the workflow serialises
  // its runs), and a verification that cannot execute is worth less than one that reads in two parts.
  const groups = chunkTables(tables);
  // Each chunk retries on its own. A chunk that exhausts contributes nothing, so its tables are simply
  // absent from the merged answer — which assertShippedCounts still reads as „no answer" and fails
  // closed on. Splitting widens no hole: a partial ship is caught by the counts, not by the batching.
  for (const group of groups) {
    const sql = group
      .map((t) => `SELECT ${sqlLiteral(t)} AS t, COUNT(*) AS n FROM ${sqlIdent(t)}`)
      .join(' UNION ALL ');
    const readOnce = deps.readOnce
      ? () => deps.readOnce(group)
      : () => {
          const out = execFileSync(
            'wrangler',
            ['d1', 'execute', d1Name, remote ? '--remote' : '--local', '--json', '--command', sql],
            { cwd: resolve('apps/web'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
          );
          // `wrangler d1 execute --json` writes its notices („▲ [WARNING] Processing wrangler.jsonc") to
          // STDERR and leaves stdout as clean JSON, and execFileSync returns stdout alone, so slicing
          // from the first '[' is safe today. The scan survives a future release that changes that, at
          // one failed parse if it does.
          const parsed = parseWranglerJson(out);
          const rows = (Array.isArray(parsed) ? parsed[0]?.results : parsed?.results) ?? [];
          // Only a non-negative integer counts as an answer. `Number(null)` is 0, which would let a
          // null-valued cell pass for „the table is empty"; anything non-numeric lands as NaN so the
          // retry treats it as an incomplete answer and assertShippedCounts fails closed if it is final.
          return Object.fromEntries(
            rows.map((r) => [r.t, typeof r.n === 'number' ? r.n : Number.NaN]),
          );
        };
    // Pass `sleep`/`attempts` through only when a test overrides them; undefined lets the helper
    // defaults (the real sleepSync, 4 attempts) apply — so production always gets the backoff.
    const answer = readCountsWithRetry(readOnce, group, {
      sleep: deps.sleep,
      attempts: deps.attempts,
    });
    // Take ONLY what this group was asked about. readCountsWithRetry validates the group's tables but
    // hands back whatever the reader returned, so a reader answering beyond its group (a malformed
    // response, an injected one) could seed a count for a table whose OWN group later dies — and the
    // guard would then verify a table nobody successfully read. Fail-closed has to hold unconditionally,
    // not just for well-behaved readers.
    // defineProperty, not assignment: `counts[t] = …` runs a SETTER if Object.prototype carries one for
    // that name, and a polluted setter could define own counts for tables no chunk ever read. Reading is
    // already own-only (Object.hasOwn); writing has to be too, or the accumulator itself is the hole.
    for (const t of group) {
      if (!Object.hasOwn(answer, t)) continue;
      setOwn(counts, t, answer[t]);
    }
  }
  return counts;
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
 * Uploads are checked before the atomic promotion; the served tables are checked again afterwards.
 * A missing or non-numeric answer must fail the run, including when zero rows were expected.
 */
export function assertShippedCounts(expected, actual) {
  const drift = Object.entries(expected)
    .filter(([, n]) => typeof n === 'number')
    // Object.hasOwn: a table the readback never answered for must read as „no answer" even if a
    // polluted Object.prototype would happily hand back a plausible integer.
    .map(([table, n]) => ({
      table,
      expected: n,
      actual: Object.hasOwn(actual, table) ? actual[table] : undefined,
    }))
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
        '\nVerification failed. Staging uploads do not replace the accepted surface; promotion is atomic.',
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

async function main() {
  const workDb = arg('work-db', 'data/work/backfill.sqlite');
  const emit = arg('emit', '');
  const remote = Boolean(arg('remote', false));
  const withRegistry = Boolean(arg('with-registry', false));
  if (withRegistry && process.env.SIGMA_SHIP_ENV !== 'dev')
    throw new Error('--with-registry ships the registry layer to dev only');
  const d1Name = resolveD1Name({ remote, envName: process.env.SIGMA_D1_NAME });
  if (arg('min-links', undefined) !== undefined)
    throw new Error('--min-links has been removed; ship requires a completed, audited build');
  await assertAuditedBuild(String(workDb));
  const maxStatements = parsePositiveInt(
    arg('max-statements-per-request', MAX_STATEMENTS_PER_REQUEST),
    'max-statements-per-request',
  );
  const paceMs = parseNonNegativeInt(arg('pace-ms', PACE_MS), 'pace-ms');
  if (remote && !arg('yes', false))
    throw new Error('--remote requires --yes (guards against an accidental prod write)');

  const sourceDb = new DatabaseSync(String(workDb), { readOnly: true });
  sourceDb.exec('BEGIN');
  const sqliteJson = (sql) => sourceDb.prepare(sql).all();
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

  // Upload staging tables, verify, then promote with one atomic statement.
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
  // One read of a source table: null when the table is absent from the work DB.
  const readTable = (table) => {
    const info = sqliteJson(`PRAGMA table_info(${sqlIdent(table)})`);
    const columns = info.map((r) => r.name);
    if (!columns.length) return null;
    const rows = sqliteJson(`SELECT * FROM ${sqlIdent(table)}`);
    return {
      rowCount: rows.length,
      columns,
      primaryKey: info
        .filter((r) => r.pk)
        .sort((a, b) => a.pk - b.pk)
        .map((r) => r.name),
      statements: insertStatements(table, columns, rows),
    };
  };

  let summary = {};
  try {
    let sequence = 0;
    summary = runShip({
      tables: withRegistry ? [...REGISTRY_TABLES, ...TABLES] : TABLES,
      wipeTables: withRegistry ? [...REGISTRY_TABLES.slice().reverse(), ...WIPE_ORDER] : WIPE_ORDER,
      readTable,
      apply: emit
        ? (name, sql) =>
            writeFileSync(
              resolve(emit, `${String(sequence++).padStart(5, '0')}_${name}.sql`),
              '-- Apply files in filename order. Target authorization is the responsibility of the caller.\n' +
                sql,
            )
        : applyFile,
      sleep: emit ? () => {} : sleepSync,
      // SQL guards validate staging during promotion; live runs also read it before requesting promotion.
      readCounts: emit
        ? (expected) => expected
        : (expected) => readShippedCounts(d1Name, remote, expected),
      maxStatements,
      paceMs,
    });
  } finally {
    sourceDb.close();
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
