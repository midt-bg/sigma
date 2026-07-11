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
import { setTimeout as sleep } from 'node:timers/promises';
import { getPinned, CACBG_HOST } from './tls.mjs';
import { parseList } from './parse.mjs';
import { assertScratchIgnored, SCRATCH, safeXmlFile, safeFolder } from './guard.mjs';

const BASE = `https://${CACBG_HOST}`;
const RAW = path.join(SCRATCH, 'raw');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

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
  const limit = arg('limit', '') ? Number(arg('limit', '')) : Infinity;
  const concurrency = Number(arg('concurrency', '6'));

  // Default: discover every folder from the register index. --folders 2021_nc,2025y restricts to a subset.
  const override = arg('folders', '');
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
        if (++consecutive > 25) throw new Error(`circuit breaker near ${folder}/${xmlFile}`);
        return;
      }
      if (res.status === 404) {
        stats.missing++;
        consecutive = 0;
        return;
      } // listed-but-unpublished (source gap)
      if (res.status !== 200) {
        stats.errors++;
        return;
      }
      consecutive = 0;
      atomicWrite(dest, res.body);
      stats.fetched++;
      await sleep(15);
    });
  }
  console.log('\n=== crawl summary ===');
  console.log(JSON.stringify(stats, null, 2));
  console.log(`raw cache → ${RAW}`);
}

run().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
