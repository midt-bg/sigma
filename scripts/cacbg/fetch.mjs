// CACBG crawler. The on-demand full-corpus crawl of the public declaration register into a LOCAL,
// git-ignored raw cache — the `full_crawl` path of the related-persons-data workflow (steady-state
// incremental refresh is the sigma-etl Worker's R2-backed job, ADR-0006). Pure I/O: it fetches list.xml
// + every declaration XML and writes them under scratch/cacbg/raw/<year>/. Parsing/extraction is a
// separate re-runnable step (extract.mjs) so the parser can evolve without re-fetching.
//
// Resumable + idempotent: a declaration already on disk is skipped (the source is immutable per year).
// PII: raw XML lives ONLY in git-ignored scratch (workflow-cached across runs, never committed). EGN is
// already stripped upstream; addresses/family are dropped by extract.mjs, never persisted to staging.
//
// Usage:
//   node scripts/cacbg/fetch.mjs                        # all folders discovered from the register index
//   node scripts/cacbg/fetch.mjs --folders 2021_nc,2025y # restrict to a subset
//   node scripts/cacbg/fetch.mjs --limit 300 --concurrency 6

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { getPinned, CACBG_HOST } from './tls.mjs';
import { parseList } from './parse.mjs';
import { assertScratchIgnored, SCRATCH, safeXmlFile, safeFolder } from './guard.mjs';

const BASE = `https://${CACBG_HOST}`;
const RAW = path.join(SCRATCH, 'raw');

// Parse + VALIDATE crawl options. An unvalidated Number() lets `--concurrency abc/0` become NaN/0 →
// `Array.from({length})` spawns zero workers → the crawl fetches nothing and exits 0 (a silent no-op),
// and a bad `--limit` (NaN, non-finite) silently skips the slice and fetches the whole register. Both
// must fail LOUD instead. Pure — takes argv, returns {limit, concurrency, folders} or throws.
export function parseCrawlOptions(argv) {
  const get = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const posInt = (raw, name) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1)
      throw new Error(`--${name} must be a positive integer, got ${JSON.stringify(raw)}`);
    return n;
  };
  const limitRaw = get('limit', '');
  return {
    limit: limitRaw ? posInt(limitRaw, 'limit') : Infinity,
    concurrency: posInt(get('concurrency', '6'), 'concurrency'),
    folders: get('folders', ''),
  };
}

// Circuit-breaker accumulator. A resilient HTTP wall (403/429/5xx) must count toward the breaker just
// like a network throw — else a sustained non-200 wall crawls on forever, hammering the register. A 404
// is a source gap (listed-but-unpublished), not a failure, so it resets alongside a 200. Pure.
export const BREAKER_TRIP = 25;
export function nextBreaker(consecutive, outcome) {
  return outcome === 'ok' || outcome === 'missing' ? 0 : consecutive + 1;
}

async function politeGet(url, { tries = 5 } = {}) {
  let wait = 500;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await getPinned(url);
    } catch (err) {
      if (attempt >= tries) throw err;
      await sleep(wait);
      wait *= 2;
      continue;
    }
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      if (attempt >= tries) return res;
      await sleep(wait);
      wait *= 2;
      continue;
    }
    return res;
  }
}

function atomicWrite(file, buf) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

// Discover EVERY declaration-set folder from the register's own root index, rather than guessing that
// folder == year. The register splits a year across suffixed folders (2021_nc/_nonc/f1 compliance sets,
// 2019e local elections, 2018h, *y end-of-year republications) — a year-only guess silently drops them.
// Parse href="<folder>/index.html" out of the index HTML; safeFolder rejects anything off-shape.
async function discoverFolders() {
  const res = await politeGet(`${BASE}/`, { tries: 3 });
  if (res.status !== 200) throw new Error(`index ${BASE}/ → ${res.status}`);
  const html = res.body.toString('utf8');
  const seen = new Set();
  for (const m of html.matchAll(/href="([A-Za-z0-9_]+)\/index\.html"/gi)) {
    try {
      seen.add(safeFolder(m[1]));
    } catch {
      /* skip off-shape hrefs (nav, external) */
    }
  }
  return [...seen];
}

async function pool(items, concurrency, worker) {
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < items.length) await worker(items[i++]);
    }),
  );
}

async function run() {
  assertScratchIgnored();
  const { limit, concurrency, folders: override } = parseCrawlOptions(process.argv);

  // Default: discover every folder from the register index. --folders 2021_nc,2025y restricts to a subset.
  const folders = override
    ? override.split(',').map((f) => safeFolder(f.trim()))
    : (console.log('Discovering folders from register index …'), await discoverFolders());
  console.log(`Folders to crawl (${folders.length}): ${folders.join(', ') || '(none)'}`);

  const stats = { folders: {}, fetched: 0, cached: 0, missing: 0, errors: 0 };
  for (const folder of folders) {
    const dir = path.join(RAW, folder);
    fs.mkdirSync(dir, { recursive: true });
    const listRes = await politeGet(`${BASE}/${folder}/list.xml`);
    if (listRes.status !== 200) {
      console.log(`  ${folder}/list.xml → ${listRes.status}, skip`);
      continue;
    }
    atomicWrite(path.join(dir, 'list.xml'), listRes.body); // cache list for extract.mjs
    let rows = parseList(listRes.body.toString('utf8'));
    if (Number.isFinite(limit)) rows = rows.slice(0, limit);
    stats.folders[folder] = rows.length;
    console.log(`  ${folder}: ${rows.length} declarations`);

    let consecutive = 0;
    await pool(rows, concurrency, async (row) => {
      let xmlFile;
      try {
        xmlFile = safeXmlFile(row.xmlFile);
      } catch {
        stats.errors++;
        return;
      }
      const dest = path.join(dir, xmlFile);
      if (fs.existsSync(dest)) {
        stats.cached++;
        return;
      }
      let res;
      try {
        res = await politeGet(`${BASE}/${folder}/${xmlFile}`);
      } catch {
        stats.errors++;
        consecutive = nextBreaker(consecutive, 'fail');
        if (consecutive > BREAKER_TRIP)
          throw new Error(`circuit breaker near ${folder}/${xmlFile}`);
        return;
      }
      if (res.status === 404) {
        stats.missing++;
        consecutive = nextBreaker(consecutive, 'missing');
        return;
      } // listed-but-unpublished (source gap)
      if (res.status !== 200) {
        // A sustained 403/429/5xx wall (politeGet already retried) counts toward the breaker too — not
        // just network throws — so the crawl stops instead of hammering the register indefinitely.
        stats.errors++;
        consecutive = nextBreaker(consecutive, 'fail');
        if (consecutive > BREAKER_TRIP)
          throw new Error(`circuit breaker near ${folder}/${xmlFile}`);
        return;
      }
      consecutive = nextBreaker(consecutive, 'ok');
      atomicWrite(dest, res.body);
      stats.fetched++;
      await sleep(15);
    });
  }
  console.log('\n=== crawl summary ===');
  console.log(JSON.stringify(stats, null, 2));
  console.log(`raw cache → ${RAW}`);
}

// Only crawl when invoked directly (`node fetch.mjs`). Importing the module — e.g. the unit test of the
// pure helpers above — must NOT kick off a live network crawl of the register.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error('FATAL:', err.message);
    process.exit(1);
  });
}
