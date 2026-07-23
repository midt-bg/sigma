// Test-coverage ratchet gate (#93). Mirrors the philosophy of
// scripts/check-docs.mjs: don't just print — fail CI on drift.
//
//   1. Every workspace listed in coverage-baseline.json must have a
//      coverage/coverage-summary.json (produced by `pnpm test -- --coverage`).
//      A missing report is a hard error — it also catches a broken turbo
//      cache restore.
//   2. Per-workspace ratchet: lines% and branches% may not drop more than
//      `tolerance` percentage points below the committed baseline. A drop
//      fails CI; an intentional, reviewed decrease is expressed by lowering
//      the baseline in the same PR.
//   3. When coverage rises by more than 1pp the script nudges (without
//      failing) to run `node scripts/check-coverage.mjs --update`, which
//      rewrites the baseline from the current reports (never run in CI).
//
// Output: a markdown table (per-workspace metrics + delta vs baseline and an
// informational monorepo total computed from summed covered/total counts, not
// averaged percentages). The table goes to stdout, to coverage-summary.md at
// the repo root (git-ignored; picked up by the CI artifact / PR comment job),
// and — when $GITHUB_STEP_SUMMARY is set — to the CI step summary, on pass
// and on fail alike.
//
// The comparison/rendering logic is pure and exercised adversarially by
// scripts/check-coverage.test.mjs; main() wires it to the real repo.
//
// Not to be confused with apps/web/app/lib/coverage.ts — that is domain-level
// *data* coverage, unrelated to test coverage.

import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = 'coverage-baseline.json';
const METRICS = ['lines', 'branches', 'functions', 'statements'];
// Only lines/branches are ratcheted: functions% swings hard in the tiny
// workspaces (one helper more or less), and statements ≈ lines under v8.
// Both are still measured and shown in the table.
const RATCHETED = ['lines', 'branches'];
const BUMP_NUDGE_PP = 1.0;
// Baseline keys become filesystem paths and markdown content; keep them to
// plain `apps/...`/`packages/...` segments — no `..`, no absolute paths, no
// prototype-shaped keys.
const WORKSPACE_KEY = /^(apps|packages)\/[A-Za-z0-9_-]+$/;

// ── pure helpers (unit-tested in check-coverage.test.mjs) ──────────────────────

/** Floor to one decimal, so baseline bumps don't churn on noise digits. */
export function floor1(pct) {
  return Math.floor(pct * 10) / 10;
}

/**
 * Extract { pct, covered, total } per metric from a vitest
 * coverage-summary.json `total` block.
 */
export function extractTotals(summaryJson) {
  const out = {};
  for (const metric of METRICS) {
    const m = summaryJson.total?.[metric];
    if (!m || typeof m.pct !== 'number') {
      throw new Error(`coverage summary is missing total.${metric}.pct`);
    }
    out[metric] = { pct: m.pct, covered: m.covered ?? 0, total: m.total ?? 0 };
  }
  return out;
}

/**
 * Compare one workspace's actual percentages against its baseline.
 * Returns { failures: string[], bumpable: boolean }.
 */
export function compareWorkspace(name, actual, baseline, tolerance) {
  const failures = [];
  let bumpable = false;
  for (const metric of RATCHETED) {
    const base = baseline[metric];
    if (typeof base !== 'number') {
      failures.push(`${name}: baseline has no "${metric}" — add it to ${BASELINE_FILE}`);
      continue;
    }
    const pct = actual[metric].pct;
    if (pct < base - tolerance) {
      failures.push(
        `${name}: ${metric} coverage ${pct.toFixed(2)}% dropped below the baseline ` +
          `${base}% (tolerance ${tolerance}pp). Add tests for the new/changed code — or, ` +
          `if the drop is intentional and reviewed, lower "${metric}" for "${name}" in ${BASELINE_FILE}.`,
      );
    } else if (pct > base + BUMP_NUDGE_PP) {
      bumpable = true;
    }
  }
  return { failures, bumpable };
}

/** Sum covered/total counts across workspaces into a true merged total row. */
export function mergedTotal(perWorkspace) {
  const sums = {};
  for (const metric of METRICS) {
    let covered = 0;
    let total = 0;
    for (const totals of Object.values(perWorkspace)) {
      covered += totals[metric].covered;
      total += totals[metric].total;
    }
    sums[metric] = { covered, total, pct: total === 0 ? 100 : (covered / total) * 100 };
  }
  return sums;
}

/** Render the markdown report table. */
export function renderMarkdown(perWorkspace, baselines, tolerance, failures, bumpable) {
  const lines = [
    '<!-- coverage-report -->',
    '### Test coverage',
    '',
    '| Workspace | Lines | Δ | Branches | Δ | Functions | Statements |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  const delta = (pct, base) =>
    typeof base === 'number' ? `${pct - base >= 0 ? '+' : ''}${(pct - base).toFixed(2)}pp` : '—';
  for (const [name, totals] of Object.entries(perWorkspace)) {
    const base = baselines[name] ?? {};
    lines.push(
      `| \`${name}\` | ${totals.lines.pct.toFixed(2)}% | ${delta(totals.lines.pct, base.lines)} ` +
        `| ${totals.branches.pct.toFixed(2)}% | ${delta(totals.branches.pct, base.branches)} ` +
        `| ${totals.functions.pct.toFixed(2)}% | ${totals.statements.pct.toFixed(2)}% |`,
    );
  }
  const total = mergedTotal(perWorkspace);
  lines.push(
    `| **Total** _(informational)_ | ${total.lines.pct.toFixed(2)}% | — ` +
      `| ${total.branches.pct.toFixed(2)}% | — | ${total.functions.pct.toFixed(2)}% | ${total.statements.pct.toFixed(2)}% |`,
  );
  lines.push('');
  if (failures.length > 0) {
    lines.push('**❌ Coverage ratchet failed:**', '');
    for (const f of failures) lines.push(`- ${f}`);
  } else {
    lines.push(`✅ No workspace dropped below its baseline (tolerance ${tolerance}pp).`);
  }
  if (bumpable) {
    lines.push(
      '',
      '📈 Coverage rose by more than 1pp — run `node scripts/check-coverage.mjs --update` ' +
        `locally and commit ${BASELINE_FILE} to ratchet the threshold up.`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Build the updated baseline object from current reports (used by --update). */
export function updatedBaseline(perWorkspace, tolerance) {
  const workspaces = {};
  for (const [name, totals] of Object.entries(perWorkspace)) {
    workspaces[name] = {};
    for (const metric of RATCHETED) workspaces[name][metric] = floor1(totals[metric].pct);
  }
  return { tolerance, workspaces };
}

/**
 * Fail-closed validation of the baseline against the repo's test-bearing
 * workspaces. Errors when the baseline is empty or malformed, when a
 * workspace with a `test` script has no baseline entry (a forgotten or
 * deleted key would otherwise silently remove enforcement), or when the
 * baseline lists a workspace that no longer has tests.
 */
export function validateBaseline(baseline, testWorkspaces) {
  const errors = [];
  const ws = baseline?.workspaces;
  if (ws === null || typeof ws !== 'object' || Array.isArray(ws)) {
    return [`${BASELINE_FILE}: "workspaces" must be an object`];
  }
  const keys = Object.keys(ws);
  if (keys.length === 0) {
    return [`${BASELINE_FILE}: "workspaces" is empty — the ratchet would silently pass`];
  }
  for (const key of keys) {
    if (!WORKSPACE_KEY.test(key)) {
      errors.push(`${BASELINE_FILE}: invalid workspace key "${key}"`);
    }
  }
  for (const name of testWorkspaces) {
    if (!Object.prototype.hasOwnProperty.call(ws, name)) {
      errors.push(
        `${name} has a "test" script but no entry in ${BASELINE_FILE} — add one ` +
          '(run `node scripts/check-coverage.mjs --update` after `pnpm test -- --coverage`).',
      );
    }
  }
  for (const key of keys) {
    if (WORKSPACE_KEY.test(key) && !testWorkspaces.includes(key)) {
      errors.push(
        `${BASELINE_FILE} lists "${key}" but that workspace has no "test" script — remove the stale entry.`,
      );
    }
  }
  return errors;
}

/**
 * Per-metric changes between two baseline `workspaces` maps (used by --update
 * to surface what the rewrite actually did). Decreases are the dangerous
 * case: --update recomputes every workspace, so a real regression elsewhere
 * would silently ride along with an intended bump.
 */
export function baselineChanges(oldWs, newWs) {
  const changes = [];
  for (const [name, metrics] of Object.entries(newWs)) {
    for (const metric of RATCHETED) {
      const from = oldWs?.[name]?.[metric];
      const to = metrics[metric];
      if (typeof from === 'number' && from !== to) {
        changes.push({ name, metric, from, to, decreased: to < from });
      }
    }
  }
  return changes;
}

/** `true` iff this module is the entry point — URL-safe. */
export function isMain(importMetaUrl, argvPath) {
  return Boolean(argvPath) && importMetaUrl === pathToFileURL(argvPath).href;
}

// ── entry point ────────────────────────────────────────────────────────────────

/** Workspaces (as `apps/x` / `packages/y`) whose package.json has a test script. */
function findTestWorkspaces() {
  const found = [];
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(join(ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(ROOT, group, entry.name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.test) found.push(`${group}/${entry.name}`);
    }
  }
  return found.sort();
}

function main() {
  const update = process.argv.includes('--update');

  const baselinePath = join(ROOT, BASELINE_FILE);
  if (!existsSync(baselinePath)) {
    console.error(`Missing ${BASELINE_FILE} at the repo root.`);
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const tolerance = typeof baseline.tolerance === 'number' ? baseline.tolerance : 0.5;

  // Fail closed before comparing anything: an empty/blanked baseline or a
  // missing/stale workspace key must be an error, not a green no-op.
  const baselineErrors = validateBaseline(baseline, findTestWorkspaces());
  if (baselineErrors.length > 0) {
    for (const e of baselineErrors) console.error(e);
    process.exit(1);
  }

  const perWorkspace = {};
  const failures = [];
  let bumpable = false;

  for (const name of Object.keys(baseline.workspaces)) {
    const summaryPath = join(ROOT, name, 'coverage', 'coverage-summary.json');
    if (!existsSync(summaryPath)) {
      console.error(
        `No coverage report for "${name}" (expected ${name}/coverage/coverage-summary.json). ` +
          'Run `pnpm test -- --coverage` first. If it already ran and failed, check the test ' +
          'output — a crashed vitest process leaves no report.',
      );
      process.exit(1);
    }
    const totals = extractTotals(JSON.parse(readFileSync(summaryPath, 'utf8')));
    perWorkspace[name] = totals;
    const result = compareWorkspace(name, totals, baseline.workspaces[name], tolerance);
    failures.push(...result.failures);
    bumpable ||= result.bumpable;
  }

  if (update) {
    const next = updatedBaseline(perWorkspace, tolerance);
    const changes = baselineChanges(baseline.workspaces, next.workspaces);
    for (const c of changes) {
      const line = `${c.name}: ${c.metric} ${c.from}% → ${c.to}%`;
      if (c.decreased) {
        console.error(`⚠ DECREASE ${line} — make sure this drop is intentional before committing.`);
      } else {
        console.log(`  ${line}`);
      }
    }
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Wrote ${BASELINE_FILE} from current coverage. Review the diff and commit it.`);
    return;
  }

  const markdown = renderMarkdown(perWorkspace, baseline.workspaces, tolerance, failures, bumpable);
  console.log(markdown);
  writeFileSync(join(ROOT, 'coverage-summary.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }

  if (failures.length > 0) process.exit(1);
}

if (isMain(import.meta.url, process.argv[1])) {
  main();
}
