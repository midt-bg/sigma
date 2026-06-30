#!/usr/bin/env node
// Load the public EOP MinIO open-data feed — the canonical historical source.
// Per-day buckets are read from EOP_OPEN_DATA_BASE_URL/open-data-YYYY-MM-DD/.
//
//   node scripts/load-eop.mjs --from=2020-11-03 --to=2020-11-05
//   node scripts/load-eop.mjs --from=2020-11-03 --to=2020-11-05 --apply
//   node scripts/load-eop.mjs --cat=contracts --concurrency=4
//
//   flags: --from=YYYY-MM-DD --to=YYYY-MM-DD, --cat=contracts|tenders|annexes,
//          --concurrency=N, --apply, --remote, --no-ocds, --ocds-only
//
// Format notes: records are flat objects with English camelCase keys. Object files are
// small enough to fetch and JSON.parse whole. Wipes are scoped to the requested source days.

import { execFileSync } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BASE_CATEGORIES,
  baseInsertColumns,
  baseSqlLiteral,
  escapeSqlText,
  mapBaseRecord,
} from '../packages/ingest/src/base.ts';
import {
  AMENDMENT_STAGING_COLS,
  CONTRACT_STAGING_COLS,
  LOT_STAGING_COLS,
  PARTY_STAGING_COLS,
  classifyBucketKey,
  releaseToAmendments,
  releaseToContracts,
  releaseToLots,
  releaseToParties,
} from '../packages/ingest/src/ocds.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'apps/web');
const MAX_BATCH_BYTES = 90_000;
const MAX_BATCH_ROWS = 500;
const MAX_FILE_BYTES = 256 * 1024 * 1024; // keep each SQL chunk under Node's ~512MB string cap (wrangler reads the whole file into one string)
const DEFAULT_FROM = '2020-01-01';
const DEFAULT_TO = new Date().toISOString().slice(0, 10);
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MISSING_SETTLE_DAYS = 3;
const MS_PER_DAY = 86_400_000;
const FETCH_ATTEMPTS = 6;
const FETCH_TIMEOUT_MS = 60_000;
const BASE_URL = (process.env.EOP_OPEN_DATA_BASE_URL || 'https://storage.eop.bg').replace(
  /\/+$/,
  '',
);
const d1Name = process.env.SIGMA_D1_NAME || 'sigma';
const CATEGORIES = ['contracts', 'tenders', 'annexes'];
const RESOURCE_FILES = {
  contracts: 'contracts.json',
  tenders: 'tenders.json',
  annexes: 'annexes.json',
};

export function assertSameHost(requestedUrl, res) {
  const reqHost = new URL(requestedUrl).host;
  const finalHost = new URL(res.url || requestedUrl).host;
  if (finalHost !== reqHost) {
    throw new Error(`Refusing cross-host redirect: ${requestedUrl} -> ${res.url}`);
  }
}

const SQL_REAL_COLS = new Set([
  'signing_value',
  'estimated_value',
  'current_value',
  'value_before',
  'value_after',
  'value_delta',
  'value_amount',
]);
const SQL_INT_COLS = new Set([
  'dataset_year',
  'eu_funded',
  'bids_received',
  'needs_enrichment',
  'supplier_count',
]);
function sqlLiteral(col, value) {
  if (value === null || value === undefined) return 'NULL';
  if (SQL_REAL_COLS.has(col) || SQL_INT_COLS.has(col)) {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : 'NULL';
  }
  // Shared hardened text escaping: length cap + NUL/C0/C1 stripping + output invariant.
  return escapeSqlText(String(value));
}

const fetchedAt = new Date().toISOString().replace('.000Z', 'Z');

function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}
function outSqlPath(kind, chunkIndex = null) {
  const out = arg('out');
  if (!out || out === true) {
    if (kind === 'ocds') return resolve(root, 'data/eop-ocds-load.sql');
    const suffix = chunkIndex === 0 ? '' : `.${String(chunkIndex).padStart(2, '0')}`;
    return resolve(root, `data/eop-${kind}-load${suffix}.sql`);
  }
  const target = resolve(root, String(out));
  if (target.endsWith('.sql')) {
    const stem = target.slice(0, -4);
    if (kind === 'ocds') return `${stem}-ocds.sql`;
    const suffix = chunkIndex === 0 ? '' : `.${String(chunkIndex).padStart(2, '0')}`;
    return `${stem}-${kind}${suffix}.sql`;
  }
  if (kind === 'ocds') return resolve(target, 'eop-ocds-load.sql');
  const suffix = chunkIndex === 0 ? '' : `.${String(chunkIndex).padStart(2, '0')}`;
  return resolve(target, `eop-${kind}-load${suffix}.sql`);
}
function yearOf(day) {
  return Number(day.slice(0, 4));
}
function validateDay(day, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`${label} must be YYYY-MM-DD`);
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) {
    throw new Error(`${label} is not a valid date: ${day}`);
  }
}
function daysBetween(from, to) {
  validateDay(from, '--from');
  validateDay(to, '--to');
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  if (start > end) throw new Error('--from must be before or equal to --to');
  const days = [];
  for (let t = start; t <= end; t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}
function nonnegativeIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}
export function isWithinMissingSettleWindow(
  day,
  today = todayUtc(),
  settleDays = nonnegativeIntEnv('EOP_MISSING_SETTLE_DAYS', DEFAULT_MISSING_SETTLE_DAYS),
) {
  validateDay(day, 'day');
  validateDay(today, 'today');
  const dayMs = new Date(`${day}T00:00:00Z`).getTime();
  const todayMs = new Date(`${today}T00:00:00Z`).getTime();
  const cutoffMs = todayMs - settleDays * MS_PER_DAY;
  return dayMs >= cutoffMs;
}
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
async function writeChunk(stream, str) {
  if (!stream.write(str)) await once(stream, 'drain');
}

class MissingBucketError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} ${url}`);
    this.status = status;
  }
}

function cacheDir(day) {
  return resolve(root, 'data/eop', day);
}
function cachePath(day, name) {
  return resolve(cacheDir(day), name);
}
async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}
async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}
function backoffMs(attempt) {
  return Math.min(500 * 2 ** (attempt - 1), 10_000);
}
function errText(err) {
  const parts = [];
  if (err?.name) parts.push(err.name);
  if (err?.code) parts.push(err.code);
  if (err?.message) parts.push(err.message);
  if (err?.cause?.code) parts.push(err.cause.code);
  if (err?.cause?.message) parts.push(err.cause.message);
  return parts.filter(Boolean).join(' ');
}
async function retryOperation(label, fn) {
  let lastErr;
  for (let i = 1; i <= FETCH_ATTEMPTS; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fn(controller.signal);
    } catch (err) {
      if (err instanceof MissingBucketError) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
    if (i < FETCH_ATTEMPTS) await sleep(backoffMs(i));
  }
  throw new Error(`${label} failed after ${FETCH_ATTEMPTS} attempts: ${errText(lastErr)}`, {
    cause: lastErr,
  });
}
function handleHttp(res, url) {
  if (res.status === 403 || res.status === 404) throw new MissingBucketError(res.status, url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} ${url}`);
}
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
function parseBucketKeys(xml) {
  const keys = [];
  const re = /<Key>([\s\S]*?)<\/Key>/g;
  let m;
  while ((m = re.exec(xml)) !== null) keys.push(decodeXml(m[1]));
  return keys;
}

const bucketCache = new Map();
async function bucketKeysFor(day) {
  if (bucketCache.has(day)) return bucketCache.get(day);
  const promise = readBucketKeysFor(day);
  bucketCache.set(day, promise);
  try {
    return await promise;
  } catch (err) {
    bucketCache.delete(day);
    throw err;
  }
}
async function readBucketKeysFor(day) {
  const missingPath = cachePath(day, '_missing');
  const withinSettleWindow = isWithinMissingSettleWindow(day);
  if ((await pathExists(missingPath)) && !withinSettleWindow) {
    process.stderr.write(`!! ${day}: not published (cached) — skipping\n`);
    return null;
  } else if (withinSettleWindow && (await pathExists(missingPath))) {
    process.stderr.write(`!! ${day}: ignoring recent _missing cache; re-probing\n`);
  }

  const keysPath = cachePath(day, '_keys.json');
  if (await pathExists(keysPath)) {
    return JSON.parse(await readFile(keysPath, 'utf8'));
  }

  const url = `${BASE_URL}/open-data-${day}/`;
  try {
    const keyMap = await retryOperation(`${day} bucket listing`, async (signal) => {
      const res = await fetch(url, { signal });
      assertSameHost(url, res);
      handleHttp(res, url);
      const keys = parseBucketKeys(await res.text());
      const byCat = {};
      const counts = {};
      for (const key of keys) {
        const kind = classifyBucketKey(key);
        if (!kind) continue;
        counts[kind] = (counts[kind] || 0) + 1;
        if (!byCat[kind]) byCat[kind] = key;
      }
      for (const [kind, count] of Object.entries(counts)) {
        if (count > 1)
          process.stderr.write(`!! ${day} ${kind}: multiple keys matched; using first
`);
      }
      return byCat;
    });
    await atomicWrite(keysPath, `${JSON.stringify(keyMap, null, 2)}\n`);
    return keyMap;
  } catch (err) {
    if (err instanceof MissingBucketError) {
      if (!withinSettleWindow) await atomicWrite(missingPath, '');
      process.stderr.write(`!! ${day}: not published (${err.status}) — skipping\n`);
      return null;
    }
    throw err;
  }
}
async function fetchObjectJson(cat, day, key) {
  const bucketUrl = `${BASE_URL}/open-data-${day}/`;
  const url = `${bucketUrl}${encodeURIComponent(key)}`;
  return retryOperation(`${cat} ${day} object`, async (signal) => {
    const res = await fetch(url, { signal });
    assertSameHost(url, res);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} ${url}`);
    const text = await res.text();
    const json = JSON.parse(text);
    if (!Array.isArray(json)) throw new Error(`${cat} ${day}: object JSON is not an array`);
    return { text, json };
  });
}
function parseCachedJson(cat, day, text) {
  const json = JSON.parse(text);
  if (!Array.isArray(json)) throw new Error(`${cat} ${day}: object JSON is not an array`);
  return json;
}

async function fetchAnyObjectJson(cat, day, key) {
  const bucketUrl = `${BASE_URL}/open-data-${day}/`;
  const url = `${bucketUrl}${encodeURIComponent(key)}`;
  return retryOperation(`${cat} ${day} object`, async (signal) => {
    const res = await fetch(url, { signal });
    assertSameHost(url, res);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} ${url}`);
    const text = await res.text();
    return { text, json: JSON.parse(text) };
  });
}
function parseCachedAnyJson(cat, day, text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${cat} ${day}: invalid JSON: ${errText(err)}`);
  }
}
async function recordsForDay(cat, day, failures, skips) {
  try {
    const keys = await bucketKeysFor(day);
    if (keys === null) {
      const message = 'bucket not published or unavailable';
      skips.push({ day, cat, reason: message });
      return { records: [], loaded: false, skipped: true };
    }
    const key = keys[cat];
    if (!key) {
      const message = 'object key missing';
      process.stderr.write(`-- ${cat} ${day}: ${message}; skipping\n`);
      skips.push({ day, cat, reason: message });
      return { records: [], loaded: false, skipped: true };
    }

    const jsonPath = cachePath(day, RESOURCE_FILES[cat]);
    if (await pathExists(jsonPath)) {
      process.stderr.write(`==> ${cat} ${day}: cache HIT ${jsonPath}\n`);
      return {
        records: parseCachedJson(cat, day, await readFile(jsonPath, 'utf8')),
        loaded: true,
        skipped: false,
      };
    }

    process.stderr.write(`==> ${cat} ${day}: fetching ${key}\n`);
    const { text, json } = await fetchObjectJson(cat, day, key);
    await atomicWrite(jsonPath, text);
    return { records: json, loaded: true, skipped: false };
  } catch (err) {
    const message = errText(err);
    process.stderr.write(`!! ${cat} ${day}: FETCH FAILED after retries: ${message} — continuing\n`);
    failures.push({ day, cat, error: message });
    return { records: [], loaded: false, skipped: false, failed: true };
  }
}

async function ocdsPackageForDay(day, failures, skips) {
  const cat = 'ocds';
  try {
    const keys = await bucketKeysFor(day);
    if (keys === null) {
      const message = 'bucket not published or unavailable';
      skips.push({ day, cat, reason: message });
      return { pkg: null, loaded: false, skipped: true };
    }
    const key = keys.ocds;
    if (!key) {
      const message = 'object key missing';
      process.stderr.write(`-- ${cat} ${day}: ${message}; skipping\n`);
      skips.push({ day, cat, reason: message });
      return { pkg: null, loaded: false, skipped: true };
    }

    const jsonPath = cachePath(day, 'ocds.json');
    if (await pathExists(jsonPath)) {
      process.stderr.write(`==> ${cat} ${day}: cache HIT ${jsonPath}\n`);
      return {
        pkg: parseCachedAnyJson(cat, day, await readFile(jsonPath, 'utf8')),
        resourceUri: `${BASE_URL}/open-data-${day}/${encodeURIComponent(key)}`,
        loaded: true,
        skipped: false,
      };
    }

    process.stderr.write(`==> ${cat} ${day}: fetching ${key}\n`);
    const { text, json } = await fetchAnyObjectJson(cat, day, key);
    await atomicWrite(jsonPath, text);
    return {
      pkg: json,
      resourceUri: `${BASE_URL}/open-data-${day}/${encodeURIComponent(key)}`,
      loaded: true,
      skipped: false,
    };
  } catch (err) {
    const message = errText(err);
    process.stderr.write(`!! ${cat} ${day}: FETCH FAILED after retries: ${message} — continuing\n`);
    failures.push({ day, cat, error: message });
    return { pkg: null, loaded: false, skipped: false, failed: true };
  }
}

export function deleteSqlForEopSources(table, cat, days) {
  const lit = (day) => escapeSqlText(`eop:${cat}:${day}`);
  if (days.length === 1) return `DELETE FROM ${table} WHERE source = ${lit(days[0])};\n`;
  const sources = days.map(lit).join(',\n  ');
  return `DELETE FROM ${table} WHERE source IN (\n  ${sources}\n);\n`;
}

function deleteSqlForSources(table, sources) {
  if (sources.length === 1)
    return `DELETE FROM ${table} WHERE source = ${escapeSqlText(sources[0])};\n`;
  return `DELETE FROM ${table} WHERE source IN (
  ${sources.map((source) => escapeSqlText(source)).join(',\n  ')}
);\n`;
}

function makeSqlBatcher(out, header) {
  const headerBytes = Buffer.byteLength(header, 'utf8') + 2;
  let batch = [];
  let stmtBytes = headerBytes;
  let max = 0;
  const flush = async () => {
    if (!batch.length) return;
    const stmt = header + batch.join(',\n') + ';\n';
    max = Math.max(max, Buffer.byteLength(stmt, 'utf8'));
    await writeChunk(out, stmt);
    batch = [];
    stmtBytes = headerBytes;
  };
  const push = async (tuple) => {
    const tb = Buffer.byteLength(tuple, 'utf8') + 2;
    if (batch.length > 0 && (batch.length >= MAX_BATCH_ROWS || stmtBytes + tb > MAX_BATCH_BYTES))
      await flush();
    batch.push(tuple);
    stmtBytes += tb;
  };
  return { push, flush, max: () => max };
}

function packageReleases(pkg) {
  if (!pkg) return [];
  if (Array.isArray(pkg.releases)) return pkg.releases;
  if (pkg.data && Array.isArray(pkg.data.releases)) return pkg.data.releases;
  return [];
}

async function loadOcds(days, concurrency, failures, skips) {
  const file = outSqlPath('ocds');
  await mkdir(dirname(file), { recursive: true });
  const out = createWriteStream(file, { encoding: 'utf8' });
  await writeChunk(
    out,
    `-- Generated by scripts/load-eop.mjs — do not edit by hand.\n` +
      `-- In-bucket OCDS enrichment from storage.eop.bg.\n`,
  );
  const cb = makeSqlBatcher(
    out,
    `INSERT INTO raw_contracts (${CONTRACT_STAGING_COLS.join(', ')}) VALUES
`,
  );
  const ab = makeSqlBatcher(
    out,
    `INSERT INTO raw_amendments (${AMENDMENT_STAGING_COLS.join(', ')}) VALUES
`,
  );
  const pb = makeSqlBatcher(
    out,
    `INSERT INTO raw_ocds_parties (${PARTY_STAGING_COLS.join(', ')}) VALUES
`,
  );
  const lb = makeSqlBatcher(
    out,
    `INSERT INTO raw_ocds_lots (${LOT_STAGING_COLS.join(', ')}) VALUES
`,
  );
  let contractRows = 0;
  let amendRows = 0;
  let partyRows = 0;
  let lotRows = 0;
  let loadedObjects = 0;
  const flushAll = async () => {
    await Promise.all([cb.flush(), ab.flush(), pb.flush(), lb.flush()]);
  };
  const writeOcdsWipes = async (source) => {
    await flushAll();
    await writeChunk(
      out,
      deleteSqlForSources('raw_contracts', [source]) +
        deleteSqlForSources('raw_amendments', [source]) +
        deleteSqlForSources('raw_ocds_parties', [source]) +
        deleteSqlForSources('raw_ocds_lots', [source]),
    );
  };

  for (let i = 0; i < days.length; i += concurrency) {
    const slice = days.slice(i, i + concurrency);
    const dayResults = await Promise.all(
      slice.map((day) => ocdsPackageForDay(day, failures, skips)),
    );
    for (let j = 0; j < slice.length; j++) {
      const day = slice[j];
      const result = dayResults[j];
      const pkg = result.pkg;
      if (!pkg) {
        process.stderr.write(`   ocds ${day}: 0 rows
`);
        continue;
      }
      const source = `ocds:${day}`;
      loadedObjects++;
      await writeOcdsWipes(source);
      const meta = {
        source,
        datasetUri: `${BASE_URL}/open-data-${day}/`,
        resourceUri: result.resourceUri ?? `${BASE_URL}/open-data-${day}/`,
        year: yearOf(day),
        fetchedAt,
        publishedDate: pkg.publishedDate ?? pkg.data?.publishedDate,
      };
      let cN = 0;
      let aN = 0;
      let pN = 0;
      let lN = 0;
      for (const rel of packageReleases(pkg)) {
        for (const row of releaseToContracts(rel, meta)) {
          await cb.push(`(${CONTRACT_STAGING_COLS.map((c) => sqlLiteral(c, row[c])).join(',')})`);
          cN++;
        }
        for (const row of releaseToAmendments(rel, meta)) {
          await ab.push(`(${AMENDMENT_STAGING_COLS.map((c) => sqlLiteral(c, row[c])).join(',')})`);
          aN++;
        }
        for (const row of releaseToParties(rel, meta)) {
          await pb.push(`(${PARTY_STAGING_COLS.map((c) => sqlLiteral(c, row[c])).join(',')})`);
          pN++;
        }
        for (const row of releaseToLots(rel, meta)) {
          await lb.push(`(${LOT_STAGING_COLS.map((c) => sqlLiteral(c, row[c])).join(',')})`);
          lN++;
        }
      }
      contractRows += cN;
      amendRows += aN;
      partyRows += pN;
      lotRows += lN;
      process.stderr.write(
        `   ocds ${day}: ${cN.toLocaleString('en-US')} contracts, ${aN.toLocaleString('en-US')} amendments, ` +
          `${pN.toLocaleString('en-US')} parties, ${lN.toLocaleString('en-US')} lots
`,
      );
    }
  }
  await flushAll();
  out.end();
  await once(out, 'finish');
  process.stderr.write(
    `==> ocds: ${contractRows.toLocaleString('en-US')} contracts, ${amendRows.toLocaleString('en-US')} amendments, ` +
      `${partyRows.toLocaleString('en-US')} parties, ` +
      `${lotRows.toLocaleString('en-US')} lots → ${file} (max stmt ${Math.max(cb.max(), ab.max(), pb.max(), lb.max())})
`,
  );
  return {
    grand: contractRows + amendRows + partyRows + lotRows,
    loadedObjects,
    chunkFiles: [file],
  };
}

function tupleForRecord(_cfg, cat, day, record) {
  const row = mapBaseRecord(cat, record, { day, fetchedAt });
  if (!row) return null;
  const vals = baseInsertColumns(cat).map((col) => baseSqlLiteral(cat, col, row[col]));
  return `(${vals.join(',')})`;
}

async function loadCategory(cat, days, concurrency, failures, skips) {
  const cfg = BASE_CATEGORIES[cat];
  const insertCols = baseInsertColumns(cat);

  // Chunk the output across multiple files so none exceeds Node's ~512MB string cap (wrangler
  // d1 execute --file reads the whole file into one string). Per-day DELETEs are written only for
  // successfully loaded objects so a benign skip never wipes a day.
  const chunkFiles = [];
  let out = null;
  let bytesInChunk = 0;
  const chunkName = (i) => outSqlPath(cat, i);
  const openChunk = async () => {
    const file = chunkName(chunkFiles.length);
    await mkdir(dirname(file), { recursive: true });
    out = createWriteStream(file, { encoding: 'utf8' });
    const head =
      `-- Generated by scripts/load-eop.mjs — do not edit by hand.\n` +
      (chunkFiles.length === 0 ? '' : `-- chunk ${chunkFiles.length} (INSERT-only continuation)\n`);
    chunkFiles.push(file);
    await writeChunk(out, head);
    bytesInChunk = Buffer.byteLength(head, 'utf8');
  };
  const closeChunk = async () => {
    if (!out) return;
    out.end();
    await once(out, 'finish');
    out = null;
  };
  await openChunk();

  const header = `INSERT INTO ${cfg.table} (${insertCols.join(', ')}) VALUES\n`;
  const headerBytes = Buffer.byteLength(header, 'utf8') + 2;
  let batch = [];
  let stmtBytes = headerBytes;
  let grand = 0;
  let maxStmt = 0;
  let loadedObjects = 0;

  const flush = async () => {
    if (!batch.length) return;
    const stmt = header + batch.join(',\n') + ';\n';
    const stmtSize = Buffer.byteLength(stmt, 'utf8');
    maxStmt = Math.max(maxStmt, stmtSize);
    // Roll to a new chunk file before this statement would push the current one over the cap.
    if (bytesInChunk > 0 && bytesInChunk + stmtSize > MAX_FILE_BYTES) {
      await closeChunk();
      await openChunk();
    }
    await writeChunk(out, stmt);
    bytesInChunk += stmtSize;
    batch = [];
    stmtBytes = headerBytes;
  };
  const addTuple = async (tuple) => {
    const tb = Buffer.byteLength(tuple, 'utf8') + 2;
    if (batch.length > 0 && (batch.length >= MAX_BATCH_ROWS || stmtBytes + tb > MAX_BATCH_BYTES)) {
      await flush();
    }
    batch.push(tuple);
    stmtBytes += tb;
  };
  const writeRaw = async (sql) => {
    await flush();
    const size = Buffer.byteLength(sql, 'utf8');
    if (bytesInChunk > 0 && bytesInChunk + size > MAX_FILE_BYTES) {
      await closeChunk();
      await openChunk();
    }
    await writeChunk(out, sql);
    bytesInChunk += size;
  };

  for (let i = 0; i < days.length; i += concurrency) {
    const slice = days.slice(i, i + concurrency);
    const dayResults = await Promise.all(
      slice.map((day) => recordsForDay(cat, day, failures, skips)),
    );
    for (let j = 0; j < slice.length; j++) {
      const day = slice[j];
      const result = dayResults[j];
      if (!result.loaded) {
        process.stderr.write(`   ${cat} ${day}: skipped\n`);
        continue;
      }
      loadedObjects++;
      await writeRaw(deleteSqlForEopSources(cfg.table, cat, [day]));
      let count = 0;
      let dropped = 0;
      for (const record of result.records) {
        const tuple = tupleForRecord(cfg, cat, day, record);
        if (!tuple) {
          dropped++;
          continue;
        }
        await addTuple(tuple);
        count++;
      }
      grand += count;
      process.stderr.write(`   ${cat} ${day}: ${count.toLocaleString('en-US')} rows`);
      if (dropped)
        process.stderr.write(` (${dropped.toLocaleString('en-US')} dropped by keep filter)`);
      process.stderr.write('\n');
    }
  }
  await flush();
  await closeChunk();

  process.stderr.write(
    `==> ${cat}: ${grand.toLocaleString('en-US')} rows → ${chunkFiles.length} file(s) (max stmt ${maxStmt})\n`,
  );

  return { grand, loadedObjects, chunkFiles };
}

function applyChunkFiles(chunkFiles, remote, workDb, persistTo) {
  if (workDb) {
    for (const file of chunkFiles) {
      process.stderr.write(`==> applying ${file} to ${workDb}
`);
      execFileSync('sqlite3', ['-bail', workDb], {
        input: readFileSync(file),
        stdio: ['pipe', 'inherit', 'inherit'],
      });
    }
    return;
  }
  const scope = remote ? '--remote' : '--local';
  const persistArgs = !remote && persistTo ? ['--persist-to', persistTo] : [];
  for (const file of chunkFiles) {
    process.stderr.write(`==> applying ${file}
`);
    execFileSync('wrangler', ['d1', 'execute', d1Name, scope, ...persistArgs, '--file', file], {
      stdio: 'inherit',
      cwd: apiDir,
    });
  }
}

function reportFailures(failures) {
  if (!failures.length) return;
  process.stderr.write(
    `\n!! EOP fetch failures (${failures.length}) — re-run these day/category slices:\n`,
  );
  for (const f of failures) process.stderr.write(`   ${f.day} ${f.cat}: ${f.error}\n`);
}
function reportSkips(skips) {
  if (!skips.length) return;
  const byReason = new Map();
  for (const s of skips) {
    const key = s.reason;
    const v = byReason.get(key) || { count: 0, examples: [] };
    v.count++;
    if (v.examples.length < 8) v.examples.push(`${s.day}/${s.cat}`);
    byReason.set(key, v);
  }
  process.stderr.write(`\n-- benign skips (${skips.length})\n`);
  for (const [reason, v] of byReason) {
    process.stderr.write(
      `   ${reason}: ${v.count} (${v.examples.join(', ')}${v.count > v.examples.length ? ', ...' : ''})\n`,
    );
  }
}

async function main() {
  const from = arg('from') || DEFAULT_FROM;
  const to = arg('to') || DEFAULT_TO;
  const cat = arg('cat');
  const noOcds = !!arg('no-ocds');
  const ocdsOnly = !!arg('ocds-only');
  if (noOcds && ocdsOnly) throw new Error('--no-ocds and --ocds-only are mutually exclusive');
  const cats = ocdsOnly ? [] : cat ? [cat] : CATEGORIES;
  for (const c of cats) {
    if (!BASE_CATEGORIES[c])
      throw new Error(`unknown --cat=${c}; expected ${CATEGORIES.join('|')}`);
  }
  const rawConcurrency = Number(arg('concurrency') || DEFAULT_CONCURRENCY);
  const concurrency =
    Number.isFinite(rawConcurrency) && rawConcurrency > 0
      ? Math.floor(rawConcurrency)
      : DEFAULT_CONCURRENCY;
  const apply = !!arg('apply');
  const remote = !!arg('remote');
  const workDb = arg('work-db');
  const persistTo = arg('persist-to');
  if (workDb && remote) throw new Error('--work-db and --remote are mutually exclusive');
  const days = daysBetween(from, to);

  process.stderr.write(
    `==> EOP load ${from}..${to} (${days.length} days), cats=${cats.join(',') || '(none)'}, ocds=${!noOcds}, concurrency=${concurrency}, base=${BASE_URL}\n`,
  );
  const totals = {};
  const chunkFilesByCat = {};
  const loadedObjectsByCat = {};
  const failures = [];
  const skips = [];

  for (const c of cats) {
    const result = await loadCategory(c, days, concurrency, failures, skips);
    totals[c] = result.grand;
    loadedObjectsByCat[c] = result.loadedObjects;
    chunkFilesByCat[c] = result.chunkFiles;
  }
  if (!noOcds) {
    const result = await loadOcds(days, concurrency, failures, skips);
    totals.ocds = result.grand;
    loadedObjectsByCat.ocds = result.loadedObjects;
    chunkFilesByCat.ocds = result.chunkFiles;
  }

  const loadedObjects = Object.values(loadedObjectsByCat).reduce((sum, n) => sum + n, 0);
  reportSkips(skips);
  reportFailures(failures);
  if (loadedObjects === 0) {
    process.stderr.write(
      '\n!! aborting: the requested window produced zero successfully fetched objects (check date range/base URL)\n',
    );
    process.exitCode = 1;
    return;
  }

  if (apply) {
    for (const c of cats) {
      if (loadedObjectsByCat[c] > 0)
        applyChunkFiles(
          chunkFilesByCat[c],
          remote,
          workDb && String(workDb),
          persistTo && String(persistTo),
        );
    }
    if (!noOcds && loadedObjectsByCat.ocds > 0)
      applyChunkFiles(
        chunkFilesByCat.ocds,
        remote,
        workDb && String(workDb),
        persistTo && String(persistTo),
      );
  }
  process.stderr.write(
    `\n==> done: ${JSON.stringify(totals)} objects=${JSON.stringify(loadedObjectsByCat)} skips=${skips.length} failures=${failures.length}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
