#!/usr/bin/env node
// After a deploy or a slot switch: does the site serve THIS commit and the data generation of the slot it is
// bound to — whatever the edge cache holds? (docs/deploy.md, „Проверка след внедряване“). Read only: GET
// requests to the public site, nothing else.
//
//   node scripts/post-deploy-check.mjs <site-url> --commit <sha> [--strict] [--built-at <iso>]
//        [--data-version <n>] [--path <path>]... [--timeout <s>]
//
// 1. `/health` is never cached (apps/web/workers/health.ts). It is polled until it reports the expected
//    commit — a new version takes a few seconds to reach every location — and an answering database. If
//    it reports the commit but the database never answers within the wait, that fails with --strict
//    (production) and is a warning otherwise: the build is proven, the data is not, and pages are then
//    checked for the build only.
// 2. Its data must be the expected data version (packages/db/data-version.json unless --data-version) and,
//    for a switch, the slot rebuild's `built_at` (--built-at, from the new slot's `data_version` row).
//    A different data version fails with --strict (production) and warns otherwise, as in deploy-preflight.
// 3. Key pages and their single-fetch `.data` twins must name the same build and generation. Rendered pages
//    carry them in X-Sigma-Version / X-Sigma-Generation, and the edge copy stores those headers with the
//    bytes, so a copy names the build and generation it was rendered from, HIT or not. A mismatch is
//    retried (another location may still run the previous version, a refresh may have just published).
//    - Another build, a non-200 answer, a NEWER or unreadable generation: a failure.
//    - A HIT of this build with an OLDER generation: a warning. The edge keeps a page this build cached
//      before a refresh published until its TTL ends; the site serves it by design.
//    - A page served without its footer because D1 refused that read (no generation): a warning.
//    - No page at all proving the generation /health reports: a failure.
//
// Every request gives up after 15 s. Exit 0 when nothing failed, 1 otherwise; GitHub annotations for
// warnings and failures.

import { readFileSync } from 'node:fs';

export const DEFAULT_PATHS = [
  '/',
  '/contracts',
  '/companies',
  '/authorities',
  '/analytics',
  '/conflicts',
  '/_root.data',
  '/contracts.data',
  '/companies.data',
  '/authorities.data',
];

const USER_AGENT = 'sigma-post-deploy-check';
/** How long one request may take before it counts as failed. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Unsettled refresh windows older than one refresh cycle have outlived the run that recorded them. */
export const STALE_WINDOW_SECONDS = 6 * 3600;

export function codeDataVersion() {
  return JSON.parse(
    readFileSync(new URL('../packages/db/data-version.json', import.meta.url), 'utf8'),
  ).version;
}

export function parseArgs(argv) {
  const options = {
    base: '',
    commit: '',
    strict: false,
    builtAt: null,
    dataVersion: null,
    paths: [],
    timeoutMs: 180_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--commit') options.commit = value();
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--built-at') options.builtAt = value();
    else if (arg === '--data-version') options.dataVersion = Number(value());
    else if (arg === '--path') options.paths.push(value());
    else if (arg === '--timeout') options.timeoutMs = Number(value()) * 1000;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (!options.base) options.base = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!/^https?:\/\/[^/]+/.test(options.base))
    throw new Error('the site URL is required (https://…)');
  if (!/^[0-9a-f]{12,40}$/i.test(options.commit))
    throw new Error('--commit <sha> is required (at least the 12 characters the site shows)');
  if (options.dataVersion !== null && !Number.isInteger(options.dataVersion))
    throw new Error('--data-version must be an integer');
  if (!(options.timeoutMs >= 0)) throw new Error('--timeout must be a number of seconds');
  options.base = options.base.replace(/\/+$/, '');
  if (options.paths.length === 0) options.paths = [...DEFAULT_PATHS];
  return options;
}

/** The commit as the site writes it: the first twelve characters (apps/web/vite.config.ts). */
export const shortCommit = (sha) => sha.slice(0, 12).toLowerCase();

async function readHealth(fetchImpl, base, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    const response = await fetchImpl(`${base}/health`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not the health report: an older version without the endpoint answers with its 404 page.
    }
    return { status: response.status, cacheControl: response.headers.get('Cache-Control'), body };
  } catch (error) {
    return { status: 0, cacheControl: null, body: null, error: String(error?.message ?? error) };
  }
}

function describeHealth(seen) {
  if (seen.error) return `request failed: ${seen.error}`;
  if (!seen.body) return `HTTP ${seen.status}, not a health report`;
  return `HTTP ${seen.status}, commit ${seen.body.code?.commit ?? 'none'}, status ${seen.body.status} (db ${seen.body.db})`;
}

/**
 * Poll `/health` until this commit answers with a working database, or the time is up. `current` is the
 * last report that named this commit, answering database or not.
 */
export async function awaitHealth(
  fetchImpl,
  base,
  commit,
  { timeoutMs, intervalMs, sleep, now, requestTimeoutMs },
) {
  const deadline = now() + timeoutMs;
  let current = null;
  for (;;) {
    const seen = await readHealth(fetchImpl, base, requestTimeoutMs);
    if (seen.status === 200 && seen.body?.code?.commit === commit) {
      current = seen;
      if (seen.body.status === 'ok') return { seen, current, ready: true };
    }
    if (now() + intervalMs > deadline) return { seen, current, ready: false };
    await sleep(intervalMs);
  }
}

/** The data assertions on a current, answering health report. */
export function judgeHealth(body, { expectedVersion, builtAt, strict }) {
  const failures = [];
  const warnings = [];
  const { data, runs } = body;
  if (data.version !== expectedVersion) {
    const message = `the served slot holds data version ${data.version ?? 'none'}, this code computes version ${expectedVersion}`;
    (strict ? failures : warnings).push(message);
  }
  if (builtAt && data.builtAt !== builtAt)
    failures.push(
      `the served slot was built at ${data.builtAt ?? 'an unrecorded time'}, expected ${builtAt} — the switch has not taken effect`,
    );
  if (!data.generation) failures.push('the served slot has no published data generation');
  const refresh = runs?.refresh;
  if (refresh?.unsettledWindows > 0 && refresh.oldestUnsettledAgeSeconds > STALE_WINDOW_SECONDS)
    warnings.push(
      `${refresh.unsettledWindows} refresh window(s) are not settled, the oldest for ${Math.round(refresh.oldestUnsettledAgeSeconds / 3600)} h: a run did not pass its integrity gate or stopped`,
    );
  if (refresh?.verdict && refresh.verdict !== 'ok')
    warnings.push(
      `the last refresh's integrity verdict is ${refresh.verdict} (${refresh.verdictAt}); the numbers were last verified ${refresh.verifiedAt ?? 'never on this slot'}`,
    );
  return { failures, warnings };
}

/**
 * Generations are SQLite UTC times (`YYYY-MM-DD HH:MM:SS`); an ISO form is read too. Returns the order of
 * `a` against `b` (-1, 0, 1), or null when either cannot be read.
 */
export function compareGenerations(a, b) {
  const time = (value) =>
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(value ?? '')
      ? Date.parse(value.replace(' ', 'T').replace(/Z?$/, 'Z'))
      : Number.NaN;
  const [x, y] = [time(a), time(b)];
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return Math.sign(x - y);
}

async function readPage(fetchImpl, url, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Only the headers matter; the body is released, not read.
    await response.body?.cancel?.().catch(() => {});
    const h = (name) => response.headers.get(name);
    return {
      status: response.status,
      version: h('X-Sigma-Version'),
      generation: h('X-Sigma-Generation'),
      edge: h('X-Edge-Cache'),
      degraded: h('X-Sigma-Degraded'),
    };
  } catch (error) {
    return { status: 0, error: String(error?.message ?? error) };
  }
}

/**
 * What one page shows. `failure`: retried, then a failure. `unproven`: retried, then a warning (D1 refused
 * the footer's read). `stale`: a warning at once, retrying does not change an edge copy. `proved`: the build
 * and the generation match. `built`: the build matches and no generation is being compared.
 */
export function judgePage(page, commit, generation) {
  if (page.error) return { failure: `request failed: ${page.error}` };
  if (page.status !== 200) return { failure: `HTTP ${page.status}` };
  if (page.version !== commit)
    return {
      failure: `rendered by build ${page.version ?? 'unknown'}, not ${commit} (X-Edge-Cache: ${page.edge})`,
    };
  if (generation === null) return { built: true };
  if (!page.generation)
    return page.degraded
      ? {
          unproven: `rendered without its ${page.degraded} (D1 refused the read), so it does not prove the generation`,
        }
      : {
          failure: `names no data generation, /health says ${generation} (X-Edge-Cache: ${page.edge})`,
        };
  if (page.generation === generation) return { proved: true };
  const order = compareGenerations(page.generation, generation);
  if (order === null)
    return {
      failure: `shows data generation ${page.generation}, which cannot be compared with /health's ${generation}`,
    };
  if (order < 0 && page.edge === 'HIT')
    return {
      stale: `an edge copy of this build from before the refresh that published ${generation} shows ${page.generation}; served by design until it expires`,
    };
  return {
    failure: `shows data generation ${page.generation}, /health says ${generation} (X-Edge-Cache: ${page.edge})`,
  };
}

/**
 * Each page must name the expected build and, unless `generation` is null, the generation. A failure or an
 * unproven page is retried; before each retry the generation is read again from `/health`, since a refresh
 * that publishes meanwhile moves it on. With a generation, at least one page has to prove it.
 */
export async function checkPages(fetchImpl, base, commit, generation, paths, deps) {
  const { attempts = 4, intervalMs, sleep, requestTimeoutMs } = deps;
  const failures = [];
  const warnings = [];
  const passed = [];
  let proved = 0;
  let current = generation;
  for (const path of paths) {
    let verdict = null;
    let page = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      page = await readPage(fetchImpl, `${base}${path}`, requestTimeoutMs);
      verdict = judgePage(page, commit, current);
      if (!verdict.failure && !verdict.unproven) break;
      if (attempt === attempts) break;
      await sleep(intervalMs);
      if (current === null) continue;
      const health = await readHealth(fetchImpl, base, requestTimeoutMs);
      if (health.body?.status === 'ok' && health.body.data?.generation)
        current = health.body.data.generation;
    }
    if (verdict.failure) failures.push(`${path}: ${verdict.failure}`);
    else if (verdict.unproven) warnings.push(`${path}: ${verdict.unproven}`);
    else if (verdict.stale) warnings.push(`${path}: ${verdict.stale}`);
    else {
      if (verdict.proved) proved++;
      passed.push(`${path} (${page.edge})`);
    }
  }
  if (current !== null && proved === 0)
    failures.push(`no page proved the data generation ${current} that /health reports`);
  return { failures, warnings, passed, generation: current };
}

export async function run(options, deps) {
  const {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    intervalMs = 5_000,
    pageIntervalMs = 10_000,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    log = console.log,
  } = deps ?? {};
  const commit = shortCommit(options.commit);
  const expectedVersion = options.dataVersion ?? codeDataVersion();
  const failures = [];
  const warnings = [];
  const pageDeps = { intervalMs: pageIntervalMs, sleep, requestTimeoutMs };

  const { seen, current, ready } = await awaitHealth(fetchImpl, options.base, commit, {
    timeoutMs: options.timeoutMs,
    intervalMs,
    sleep,
    now,
    requestTimeoutMs,
  });
  const within = `within ${options.timeoutMs / 1000}s`;
  if (!ready && (options.strict || !current)) {
    failures.push(
      `/health did not report commit ${commit} with a working database ${within} — last seen: ${describeHealth(seen)}`,
    );
    return { failures, warnings };
  }
  const health = ready ? seen : current;
  if (!/\bno-store\b/i.test(health.cacheControl ?? ''))
    failures.push(`/health may be cached (Cache-Control: ${health.cacheControl ?? 'none'})`);

  if (!ready) {
    // Not --strict: the build answered, D1 did not. Prove what can be proven, the build of every page.
    warnings.push(
      `/health reports commit ${commit} but its database did not answer ${within} (last seen: ${describeHealth(seen)}); the data version and generation are unproven`,
    );
    const pages = await checkPages(fetchImpl, options.base, commit, null, options.paths, pageDeps);
    for (const line of pages.passed)
      log(`page: ${line} — build ${commit}, generation not compared`);
    failures.push(...pages.failures);
    return { failures, warnings };
  }

  const { data, runs } = health.body;
  log(
    `health: commit ${commit}, data version ${data.version ?? 'none'} built ${data.builtAt ?? '?'}`,
  );
  log(`health: generation ${data.generation ?? 'none'}, data as of ${data.asOf ?? '?'}`);
  log(
    `health: refresh verdict ${runs?.refresh?.verdict ?? 'none'}, last verified ${runs?.refresh?.verifiedAt ?? 'never'}; ` +
      `unsettled refresh windows ${runs?.refresh?.unsettledWindows ?? '?'}; ` +
      `registry followed through ${runs?.registry?.changesThrough ?? '?'}; ` +
      `related persons published ${runs?.declarations?.relatedPersonsPublishedAt ?? '?'}`,
  );
  const judged = judgeHealth(health.body, {
    expectedVersion,
    builtAt: options.builtAt,
    strict: options.strict,
  });
  failures.push(...judged.failures);
  warnings.push(...judged.warnings);
  if (!data.generation) return { failures, warnings };

  const pages = await checkPages(
    fetchImpl,
    options.base,
    commit,
    data.generation,
    options.paths,
    pageDeps,
  );
  for (const line of pages.passed)
    log(`page: ${line} — build ${commit}, generation ${pages.generation}`);
  failures.push(...pages.failures);
  warnings.push(...pages.warnings);
  return { failures, warnings };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`post-deploy-check: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const { failures, warnings } = await run(options);
  for (const w of warnings) console.log(`::warning title=Post-deploy check::${w}`);
  for (const f of failures) console.log(`::error title=Post-deploy check::${f}`);
  if (failures.length) {
    console.log(`post-deploy-check: FAILED for ${options.base}`);
    process.exitCode = 1;
  } else
    console.log(
      `post-deploy-check: ${options.base} serves ${shortCommit(options.commit)} and its data`,
    );
}

if (import.meta.main) await main();
