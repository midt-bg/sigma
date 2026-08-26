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
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  assertScratchIgnored,
  assertOverrideDirSafe,
  SCRATCH,
  safeXmlFile,
  safeFolder,
} from './guard.mjs';

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
  // The corpus directory the crawl writes into must clear the PII rail too — a symlink at rawDir would
  // otherwise redirect fetched declarations into committable territory (review round 5, blocker 2). The
  // injected-guard tests point rawDir at a temp dir, which is outside any repo and passes trivially.
  assertOverrideDirSafe(rawDir, rawDir === RAW ? 'scratch/cacbg/raw' : 'rawDir');
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

  // Clear any prior sentinel BEFORE fetching. From here until the clean exit below the corpus is in flux,
  // and a stamp from an earlier run would describe a corpus that no longer exists. Clearing first also
  // means every abnormal exit — deadline stop, circuit breaker, an uncaught throw, the runner being
  // killed — leaves the corpus unstamped without needing its own cleanup path.
  fs.rmSync(sentinelPath(rawDir), { force: true });

  // Default: discover every folder from the register index. --folders 2021_nc,2025y restricts to a subset.
  const folders = override
    ? override.split(',').map((f) => safeFolder(f.trim()))
    : (console.log('Discovering folders from register index …'), await discover(httpGet));
  console.log(`Folders to crawl (${folders.length}): ${folders.join(', ') || '(none)'}`);
  // An index page that yields ZERO folders is a broken or redesigned index, never a real corpus state —
  // the register has published year-sets continuously since 2015. Proceeding would run a vacuous crawl
  // whose completeness arithmetic is 0/0 and stamp it (review finding: reproduced — exit 0 and a
  // `folders: 0, incomplete: false` stamp over an existing raw tree). Fail instead; the stamp was
  // already cleared above, so the corpus is left resumable and unpublishable.
  if (!override && folders.length === 0) {
    console.error(
      `\n✖ the register index yielded no folders — refusing to certify anything from it.`,
    );
    return 1;
  }

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
    const listBody = listRes.body.toString('utf8');
    // Structural validation FIRST (review round 3): a truncated body whose tail still holds one complete
    // <Declaration> parses leniently to that one row — announced becomes 1, the corpus reconciles, and a
    // fresh crawl STAMPS off a mangled list. Only a well-formed document may be counted or cached.
    // XMLValidator alone is NOT enough: fast-xml-parser validates `<wrong/><root>…</root>` — a
    // MULTI-root body — as true, and the lenient parser then merges both roots so parseList still finds
    // rows (review round 4: reproduced in both root orders). A real list.xml has exactly one document
    // element; anything else is a mangled or concatenated body.
    const roots = () =>
      Object.keys(new XMLParser().parse(listBody)).filter(
        (k) => k !== '?xml' && k !== '?xml-stylesheet',
      );
    if (XMLValidator.validate(listBody) !== true || roots().length !== 1) {
      console.log(`  ${folder}: list.xml is not a single well-formed document — SKIP`);
      stats.skippedFolders.push({ folder, status: 'malformed-list' });
      continue;
    }
    let rows = parseList(listBody);
    // An HTTP-200 body that parses to ZERO rows is a maintenance HTML page or a schema change, not an
    // empty set — the register indexes a folder only once it has declarations, and both failure shapes
    // come back 200 and parse to [] (review finding: confirmed against a real maintenance page; the
    // follow-up reproduced the FRESH-folder variant certifying a mixed corpus). Trusting it would shrink
    // `announced` to zero, make the folder look trivially complete, and — when files already exist —
    // OVERWRITE the cached list the extractor reads. Skip the folder unconditionally: skippedFolders
    // makes the corpus incomplete, so no stamp; a genuinely empty brand-new set (never yet observed)
    // would go red for an operator to look at, which is the right failure direction for a certifier.
    if (rows.length === 0) {
      const onDisk = fs.readdirSync(dir).some((f) => f.endsWith('.xml') && f !== 'list.xml');
      console.log(
        `  ${folder}: list.xml parsed to 0 rows${onDisk ? ' (declarations exist on disk!)' : ''} — SKIP`,
      );
      stats.skippedFolders.push({
        folder,
        status: onDisk ? 'empty-list-with-files' : 'empty-list',
      });
      continue;
    }
    // A list that announces FEWER rows than the cached one contradicts the per-year immutability the
    // whole resume design rests on ("source is immutable per year — files already on disk are skipped").
    // Trusting it would overwrite the fuller cached list the extractor reads and certify the shrinkage
    // (review round 3: reproduced — cached [a1,a2], incoming [a1], stamped). Keep the cache, skip the
    // folder; if the register ever legitimately withdraws a declaration, the red run is the place a
    // human decides that, not a certifier.
    const cachedListPath = path.join(dir, 'list.xml');
    if (fs.existsSync(cachedListPath)) {
      // A corrupt cached list (a legacy DOCTYPE, a truncated write) must not crash the shrink check —
      // the valid INCOMING list is exactly what heals it. Unparseable-cached reads as zero rows: no
      // shrink objection, and the atomicWrite below replaces the corrupt cache (round 4, minor).
      const cachedRows = (() => {
        try {
          return parseList(fs.readFileSync(cachedListPath, 'utf8')).length;
        } catch {
          return 0;
        }
      })();
      if (rows.length < cachedRows) {
        console.log(`  ${folder}: list announces ${rows.length} < cached ${cachedRows} — SKIP`);
        stats.skippedFolders.push({ folder, status: 'list-shrank' });
        continue;
      }
    }
    atomicWrite(cachedListPath, listRes.body); // cache list for extract.mjs
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

  // The completeness sentinel — written ONLY on a corpus that reconciles against the register's own
  // list.xml, and removed otherwise. #313 made a partial raw cache an EXPECTED state (the crawl now stops
  // on its deadline and saves what it has), and `restore-keys: cacbg-raw-` takes the most RECENT snapshot,
  // not the most complete. Nothing downstream could tell the two apart: extract.mjs walks readdirSync over
  // whatever files exist and never reconciles them against list.xml, so a truncated corpus re-publishes as
  // a smaller surface with no error anywhere. The monotonicity gate sees net growth when new links offset
  // lost ones, the --min-links floor only counts, and a first run in a fresh environment has no baseline
  // at all.
  //
  // So: a partial cache stays perfectly good for RESUMING (the next crawl skips what is on disk) but is
  // marked unfit for PUBLISHING. --allow-incomplete does not write it either: that flag records that an
  // operator accepted a shortfall, which is exactly the state a later unattended run must not inherit as
  // if it were whole.
  // Gated on the RECONCILED verdict, not on reaching this line: --allow-incomplete lets an accepted
  // shortfall proceed to exit 0, and stamping there would hand a later unattended run an acceptance that
  // was never theirs. Two more conditions, both review findings:
  //   • !override — a --folders subset that completes is complete FOR THE SUBSET; certifying the whole
  //     raw tree from it would stamp around every other folder's state. Subset crawls still CLEAR the
  //     stamp (top of run), so they leave the corpus resumable-not-publishable, which is right.
  //   • announced > 0 — a crawl that reconciled zero declarations certifies nothing. UNREACHABLE by
  //     construction since the zero-row skip above (every zero-announced folder lands in skippedFolders,
  //     making the corpus incomplete; zero folders at all exits earlier) — kept as belt-and-braces
  //     against a future regression of those guards, which is also why no test pins it: a mutant
  //     deleting it survives, deliberately, rather than a test encoding an impossible scenario.
  const stampable = !override && !completeness.incomplete && completeness.announcedDeclarations > 0;
  if (stampable) writeSentinel(rawDir, { folders: folders.length, ...completeness });
  return 0;
}

/** Sentinel path for a raw corpus directory. Exported so the reader and the writer cannot drift. */
export const sentinelPath = (rawDir) => path.join(rawDir, '.corpus-complete.json');

/**
 * Stamp a corpus as publishable. Called on the clean-exit path only; every other path REMOVES the file so
 * a stale sentinel can never outlive the corpus it described (a resumed crawl that then fails must not
 * leave yesterday's stamp behind).
 */
function writeSentinel(rawDir, summary) {
  fs.writeFileSync(
    sentinelPath(rawDir),
    `${JSON.stringify({ ...summary, stampedAt: new Date().toISOString() }, null, 2)}\n`,
  );
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
