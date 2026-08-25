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
//   node scripts/cacbg/fetch.mjs --limit 300 --concurrency 6  # concurrency is capped at MAX_CONCURRENCY
//   node scripts/cacbg/fetch.mjs --deadline-minutes 240  # stop cleanly before a CI job cap (see run())

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { getPinned, CACBG_HOST } from './tls.mjs';
import { parseList } from './parse.mjs';
import { assertScratchIgnored, SCRATCH, safeXmlFile, safeFolder } from './guard.mjs';

const BASE = `https://${CACBG_HOST}`;
const RAW = path.join(SCRATCH, 'raw');

// The politeness ceiling on parallel requests to register.cacbg.bg. `--concurrency` had a floor but no
// roof, so `--concurrency 500` was a valid way to ask a state server for five hundred simultaneous
// connections — from a script whose whole design (backoff, circuit breaker, inter-request sleep) exists to
// avoid exactly that. 8 is what the workflow runs and what the corpus measurement was taken at; ADR-0012's
// original „≤6" predates it. Raising this is a deliberate edit with a server on the other end, not a flag.
export const MAX_CONCURRENCY = 8;

// Parse + VALIDATE crawl options. An unvalidated Number() lets `--concurrency abc/0` become NaN/0 →
// `Array.from({length})` spawns zero workers → the crawl fetches nothing and exits 0 (a silent no-op),
// and a bad `--limit` (NaN, non-finite) silently skips the slice and fetches the whole register. Both
// must fail LOUD instead. Pure — takes argv, returns {limit, concurrency, folders} or throws.
export function parseCrawlOptions(argv) {
  // A flag PRESENT but valueless (`--deadline-minutes` at the end of argv, or followed by the next flag)
  // used to fall through to the default — silently meaning „no deadline", „no limit", „6 workers". That is
  // the same silent-no-op class the validation below exists to kill, so it throws rather than defaults: a
  // default is what you get for not asking, not for asking badly.
  const get = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return def;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--'))
      throw new Error(`--${name} was given without a value`);
    return v;
  };
  const posInt = (raw, name) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1)
      throw new Error(`--${name} must be a positive integer, got ${JSON.stringify(raw)}`);
    return n;
  };
  const limitRaw = get('limit', '');
  const deadlineRaw = get('deadline-minutes', '');
  const concurrency = posInt(get('concurrency', '6'), 'concurrency');
  if (concurrency > MAX_CONCURRENCY)
    throw new Error(
      `--concurrency must be at most ${MAX_CONCURRENCY} — the register is a state server, not a load target; ` +
        `got ${concurrency}`,
    );
  return {
    limit: limitRaw ? posInt(limitRaw, 'limit') : Infinity,
    concurrency,
    folders: get('folders', ''),
    // Wall-clock budget after which the crawl stops ENQUEUEING new work and returns normally. Absent by
    // default — a hand-run crawl has no cap to respect. See run() for why a CI crawl needs one.
    deadlineMinutes: deadlineRaw ? posInt(deadlineRaw, 'deadline-minutes') : Infinity,
    // A transparency platform must not silently publish a partial corpus. By default an incomplete crawl
    // (a set whose list.xml never loaded, or an announced declaration we failed to fetch for a non-404
    // reason) exits non-zero; the operator passes --allow-incomplete to proceed knowingly (#226, Todor #2).
    allowIncomplete: argv.includes('--allow-incomplete'),
  };
}

// Reconcile what the register ANNOUNCED against what the crawl OBTAINED, per set. Symmetric to the
// bidders-side integrity gate (integrity-checks.mjs), which fails before the resolver on an export↔source
// mismatch — the declaration side had no such check, so a skipped set or a wall of fetch errors published a
// silently short list (#226, Todor #2). A 404 is a legitimate source gap (listed-but-unpublished), NOT a
// shortfall; only non-404 misses and wholesale-skipped sets count. Pure — takes the collected stats, returns
// the report + an `incomplete` verdict.
export function assessCompleteness(perFolder, skippedFolders = []) {
  let announcedDeclarations = 0,
    obtained = 0,
    sourceGaps = 0,
    unfetched = 0;
  for (const f of Object.values(perFolder)) {
    announcedDeclarations += f.announced;
    obtained += f.fetched + f.cached;
    sourceGaps += f.missing; // 404 — listed but unpublished at source (expected, not a shortfall)
    unfetched += f.errors; // announced but not obtained for a non-404 reason — a real shortfall
  }
  // Every announced row ends in exactly one bucket, so a full pass satisfies
  // announced == obtained + sourceGaps + unfetched. A surplus means rows were never ATTEMPTED — the
  // --limit case, which produces no errors and would otherwise sail through the checks below.
  const notAttempted = Math.max(0, announcedDeclarations - (obtained + sourceGaps + unfetched));
  return {
    reachedSets: Object.keys(perFolder).length,
    skippedSets: skippedFolders.length,
    announcedDeclarations,
    obtained,
    sourceGaps,
    unfetched,
    notAttempted,
    incomplete: unfetched > 0 || notAttempted > 0 || skippedFolders.length > 0,
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
async function discoverFolders(get = politeGet) {
  const res = await get(`${BASE}/`, { tries: 3 });
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

// `shouldStop` is consulted before each item is handed to a worker, so a deadline stops the pool within one
// in-flight request per worker instead of draining the whole folder. Items never handed out stay unattempted,
// which is exactly what the completeness arithmetic needs to see.
//
// RETURNS whether work was actually withheld. The caller must not infer that from the clock: a pool whose
// LAST request happens to land past the deadline handed out everything it was asked to and withheld nothing,
// and treating that as a stop condemns a complete corpus. `i` is only ever advanced past the length check
// within one synchronous step, so `i < items.length` here means exactly „rows nobody was given".
async function pool(items, concurrency, worker, shouldStop = () => false) {
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < items.length && !shouldStop()) await worker(items[i++]);
    }),
  );
  return i < items.length;
}

// The crawl. Returns the intended process exit code (0 = complete, 1 = incomplete without an override) so the
// completeness gate is a pure, testable decision rather than a global `process.exitCode` side effect. The I/O
// boundary is injectable — `httpGet` (a get-with-retries, default politeGet), the raw output dir, argv, the
// scratch guard, and folder discovery — so the gate can be integration-tested offline (getPinned pins the
// CACBG host, so a fake server is impossible; injection is the only seam). Defaults reproduce production 1:1.
export async function run({
  httpGet = politeGet,
  discover = discoverFolders,
  rawDir = RAW,
  argv = process.argv,
  guard = assertScratchIgnored,
  now = () => Date.now(),
} = {}) {
  guard();
  const {
    limit,
    concurrency,
    folders: override,
    allowIncomplete,
    deadlineMinutes,
  } = parseCrawlOptions(argv);

  // WHY A SELF-IMPOSED DEADLINE. The full corpus is ~37 sets / ~281 000 declarations and does not fit in the
  // related-persons-data job's 300-minute cap. When the cap fired mid-crawl (run 31889519937) the runner
  // killed the STEP but not this process, which kept writing while the `always()` cache-save step ran `tar`
  // over the same tree — „file changed as we read it", tar exit 1, and actions/cache/save downgrades a save
  // failure to a WARNING, so the step went green having stored nothing. Five hours of polite crawling were
  // lost and the next run started from an empty cache again.
  //
  // The fix is to stop before the axe rather than under it: past the deadline the crawl hands out no new
  // work, lets in-flight requests land, and RETURNS. The tree is then quiet, tar succeeds, the cache holds
  // what was fetched, and the next run resumes (a declaration already on disk is skipped). A full corpus
  // therefore takes two runs rather than none.
  const deadlineAt = Number.isFinite(deadlineMinutes) ? now() + deadlineMinutes * 60_000 : Infinity;
  const pastDeadline = () => now() >= deadlineAt;
  let deadlineHit = false;

  // Default: discover every folder from the register index. --folders 2021_nc,2025y restricts to a subset.
  const folders = override
    ? override.split(',').map((f) => safeFolder(f.trim()))
    : (console.log('Discovering folders from register index …'), await discover(httpGet));
  console.log(`Folders to crawl (${folders.length}): ${folders.join(', ') || '(none)'}`);

  // Per-set accounting so completeness can be reconciled announced↔obtained (Todor #2). A set whose list.xml
  // never loaded is a WHOLESALE gap (we don't even know its declaration count) → tracked separately.
  const stats = { folders: {}, skippedFolders: [] };
  for (const folder of folders) {
    // Checked BEFORE mkdir/list.xml so an out-of-budget set leaves no trace at all — an empty directory
    // and a cached list.xml would read, to the next run, like a set that had genuinely been visited.
    if (pastDeadline()) {
      deadlineHit = true;
      console.log(`  deadline reached — stopping before ${folder} (not attempted)`);
      break;
    }
    const dir = path.join(rawDir, folder);
    fs.mkdirSync(dir, { recursive: true });
    const listRes = await httpGet(`${BASE}/${folder}/list.xml`);
    if (listRes.status !== 200) {
      console.log(`  ${folder}/list.xml → ${listRes.status}, SKIP (announced set not crawled)`);
      stats.skippedFolders.push({ folder, status: listRes.status });
      continue;
    }
    atomicWrite(path.join(dir, 'list.xml'), listRes.body); // cache list for extract.mjs
    let rows = parseList(listRes.body.toString('utf8'));
    // `announced` is what the SET declares, so it is read BEFORE --limit truncates the work. Taking it
    // after the slice made a deliberately partial crawl report announced == obtained, i.e. the completeness
    // gate certified a corpus it had never attempted to fetch (ydimitrof #226).
    const announced = rows.length;
    if (Number.isFinite(limit)) rows = rows.slice(0, limit);
    const fstat = { announced, fetched: 0, cached: 0, missing: 0, errors: 0 };
    stats.folders[folder] = fstat;
    console.log(`  ${folder}: ${rows.length} declarations`);

    let consecutive = 0;
    const withheld = await pool(
      rows,
      concurrency,
      async (row) => {
        let xmlFile;
        try {
          xmlFile = safeXmlFile(row.xmlFile);
        } catch {
          fstat.errors++;
          return;
        }
        const dest = path.join(dir, xmlFile);
        if (fs.existsSync(dest)) {
          fstat.cached++;
          return;
        }
        let res;
        try {
          res = await httpGet(`${BASE}/${folder}/${xmlFile}`);
        } catch {
          fstat.errors++;
          consecutive = nextBreaker(consecutive, 'fail');
          if (consecutive > BREAKER_TRIP)
            throw new Error(`circuit breaker near ${folder}/${xmlFile}`);
          return;
        }
        if (res.status === 404) {
          fstat.missing++;
          consecutive = nextBreaker(consecutive, 'missing');
          return;
        } // listed-but-unpublished (source gap)
        if (res.status !== 200) {
          // A sustained 403/429/5xx wall (politeGet already retried) counts toward the breaker too — not
          // just network throws — so the crawl stops instead of hammering the register indefinitely.
          fstat.errors++;
          consecutive = nextBreaker(consecutive, 'fail');
          if (consecutive > BREAKER_TRIP)
            throw new Error(`circuit breaker near ${folder}/${xmlFile}`);
          return;
        }
        consecutive = nextBreaker(consecutive, 'ok');
        atomicWrite(dest, res.body);
        fstat.fetched++;
        await sleep(15);
      },
      pastDeadline,
    );
    // Asked whether the pool WITHHELD work, not whether the clock has passed. A set whose final in-flight
    // request lands one second past the budget is fully obtained and must not be called a deadline stop —
    // otherwise the run that finally completes the corpus is the one declared partial and refused. If the
    // clock is spent but this set finished, the next iteration's top-of-loop guard stops us; if this was
    // the LAST set, there is nothing left to withhold and the corpus is complete.
    if (withheld) {
      deadlineHit = true;
      console.log(`  deadline reached inside ${folder} — stopping`);
      break;
    }
  }

  const completeness = assessCompleteness(stats.folders, stats.skippedFolders);
  console.log('\n=== crawl summary ===');
  console.log(JSON.stringify({ folders: stats.folders, ...completeness, deadlineHit }, null, 2));
  console.log(`raw cache → ${rawDir}`);

  // A deadline stop is its OWN shortfall verdict and does not go through assessCompleteness, which can only
  // reconcile the sets the crawl reached. Stopping exactly on a set boundary leaves every reached set fully
  // obtained — arithmetically complete — while whole later years were never opened, so the gate would have
  // certified a corpus missing 2015 through 2019 and exited 0.
  //
  // --allow-incomplete deliberately does NOT downgrade this. That flag means „I have seen this shortfall and
  // accept it"; a deadline stop is a clock going off mid-sentence, with nobody having looked at what is
  // missing. The operator re-runs to resume — the whole point of stopping cleanly — or crawls a chosen
  // subset with --folders and accepts THAT knowingly.
  if (deadlineHit) {
    console.error(
      `\n✖ CRAWL STOPPED ON ITS DEADLINE (--deadline-minutes ${deadlineMinutes}) — the corpus is partial ` +
        `by construction: ${completeness.reachedSets} of ${folders.length} set(s) reached. The raw cache is ` +
        `intact and consistent; re-run to resume from it (declarations already on disk are skipped).`,
    );
    return 1;
  }

  // Completeness gate (Todor #2): a partial corpus published unannounced is the opposite of a transparency
  // platform's job. Return a non-zero exit code unless the operator has explicitly accepted the shortfall.
  if (completeness.incomplete) {
    const skipped =
      stats.skippedFolders.map((s) => `${s.folder} (${s.status})`).join(', ') || 'none';
    const msg =
      `INCOMPLETE CORPUS — ${completeness.unfetched} announced declaration(s) unfetched (non-404), ` +
      `${completeness.notAttempted} never attempted (--limit), ` +
      `${completeness.skippedSets} set(s) skipped: ${skipped}. Publishing this would omit declarations ` +
      `the register lists.`;
    if (allowIncomplete) {
      console.warn(`\n⚠ ${msg} Proceeding (--allow-incomplete).`);
    } else {
      console.error(
        `\n✖ ${msg} Re-run to resume, or pass --allow-incomplete to proceed knowingly.`,
      );
      return 1;
    }
  }
  return 0;
}

// Only crawl when invoked directly (`node fetch.mjs`). Importing the module — e.g. the unit/integration tests
// above — must NOT kick off a live network crawl of the register. run() returns the exit code; assign it to
// process.exitCode (natural drain flushes the summary) rather than process.exit (which can truncate stdout).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('FATAL:', err.message);
      process.exit(1);
    });
}
