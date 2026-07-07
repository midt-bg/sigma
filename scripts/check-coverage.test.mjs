// Adversarial unit tests for the pure logic in check-coverage.mjs. Run first
// in CI (check:coverage:test) so the ratchet gate is itself gated — mirroring
// the check-docs.mjs / check-docs.test.mjs convention.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  floor1,
  extractTotals,
  compareWorkspace,
  mergedTotal,
  renderMarkdown,
  updatedBaseline,
  validateBaseline,
  baselineChanges,
} from './check-coverage.mjs';

function metric(pct, covered = 0, total = 0) {
  return { pct, covered, total };
}

function totals({ lines, branches, functions = 100, statements = 100 }) {
  return {
    lines: metric(lines, lines, 100),
    branches: metric(branches, branches, 100),
    functions: metric(functions, functions, 100),
    statements: metric(statements, statements, 100),
  };
}

test('floor1 floors to one decimal (never rounds up past actual coverage)', () => {
  assert.equal(floor1(87.6789), 87.6);
  assert.equal(floor1(87.09), 87);
  assert.equal(floor1(0), 0);
});

test('extractTotals reads pct/covered/total per metric', () => {
  const summary = {
    total: {
      lines: { pct: 81.5, covered: 163, total: 200 },
      branches: { pct: 70, covered: 70, total: 100 },
      functions: { pct: 90, covered: 9, total: 10 },
      statements: { pct: 81.5, covered: 163, total: 200 },
    },
  };
  const t = extractTotals(summary);
  assert.equal(t.lines.pct, 81.5);
  assert.equal(t.branches.covered, 70);
});

test('extractTotals rejects a malformed summary', () => {
  assert.throws(
    () => extractTotals({ total: { lines: { pct: 80 } } }),
    /missing total\.branches\.pct/,
  );
});

test('drop beyond tolerance fails with an actionable message', () => {
  const { failures } = compareWorkspace(
    'packages/db',
    totals({ lines: 79.0, branches: 70 }),
    { lines: 80, branches: 70 },
    0.5,
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /packages\/db: lines coverage 79\.00% dropped below/);
  assert.match(failures[0], /coverage-baseline\.json/);
});

test('drop within tolerance passes', () => {
  const { failures } = compareWorkspace(
    'packages/shared',
    totals({ lines: 79.6, branches: 69.8 }),
    { lines: 80, branches: 70 },
    0.5,
  );
  assert.deepEqual(failures, []);
});

test('branches ratchet is enforced independently of lines', () => {
  const { failures } = compareWorkspace(
    'apps/web',
    totals({ lines: 85, branches: 60 }),
    { lines: 80, branches: 70 },
    0.5,
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /branches coverage 60\.00%/);
});

test('rise beyond 1pp flags a baseline bump, without failing', () => {
  const { failures, bumpable } = compareWorkspace(
    'apps/etl',
    totals({ lines: 82.5, branches: 70 }),
    { lines: 80, branches: 70 },
    0.5,
  );
  assert.deepEqual(failures, []);
  assert.equal(bumpable, true);
});

test('missing baseline metric is reported, not silently skipped', () => {
  const { failures } = compareWorkspace(
    'packages/config',
    totals({ lines: 80, branches: 70 }),
    { lines: 80 },
    0.5,
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /baseline has no "branches"/);
});

test('mergedTotal sums counts instead of averaging percentages', () => {
  const merged = mergedTotal({
    big: { ...totals({ lines: 90, branches: 90 }), lines: metric(90, 900, 1000) },
    tiny: { ...totals({ lines: 0, branches: 0 }), lines: metric(0, 0, 10) },
  });
  // 900/1010 ≈ 89.1% — a naive average of 90% and 0% would say 45%.
  assert.ok(Math.abs(merged.lines.pct - 89.1) < 0.1);
});

test('renderMarkdown carries the sticky marker, deltas, and failure details', () => {
  const per = { 'packages/db': totals({ lines: 79, branches: 70 }) };
  const md = renderMarkdown(
    per,
    { 'packages/db': { lines: 80, branches: 70 } },
    0.5,
    ['packages/db: lines coverage 79.00% dropped below the baseline 80%'],
    false,
  );
  assert.match(md, /<!-- coverage-report -->/);
  assert.match(md, /-1\.00pp/);
  assert.match(md, /❌ Coverage ratchet failed/);
  assert.match(md, /Total.*informational/);
});

test('renderMarkdown on pass shows the tolerance and bump nudge', () => {
  const per = { 'packages/db': totals({ lines: 85, branches: 75 }) };
  const md = renderMarkdown(per, { 'packages/db': { lines: 80, branches: 70 } }, 0.5, [], true);
  assert.match(md, /✅ No workspace dropped below its baseline \(tolerance 0\.5pp\)/);
  assert.match(md, /--update/);
});

test('empty workspaces object fails closed, not a green no-op', () => {
  const errors = validateBaseline({ workspaces: {} }, ['apps/web']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"workspaces" is empty/);
});

test('non-object workspaces (bad merge) fails closed', () => {
  for (const ws of [null, undefined, [], 'x']) {
    const errors = validateBaseline({ workspaces: ws }, []);
    assert.equal(errors.length, 1, `workspaces=${JSON.stringify(ws)}`);
    assert.match(errors[0], /must be an object/);
  }
});

test('test-bearing workspace missing from baseline is an error (deleted-key guard)', () => {
  const errors = validateBaseline({ workspaces: { 'apps/web': { lines: 80, branches: 70 } } }, [
    'apps/web',
    'packages/db',
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /packages\/db has a "test" script but no entry/);
});

test('stale baseline key for a workspace without tests is an error', () => {
  const errors = validateBaseline({ workspaces: { 'apps/web': {}, 'packages/gone': {} } }, [
    'apps/web',
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"packages\/gone".*no "test" script/);
});

test('traversal and prototype-shaped baseline keys are rejected', () => {
  for (const key of ['../../etc', 'apps/../secret', '__proto__', '/abs', 'apps/a/b']) {
    const errors = validateBaseline({ workspaces: { [key]: {}, 'apps/web': {} } }, ['apps/web']);
    assert.ok(
      errors.some((e) => e.includes('invalid workspace key')),
      `key ${key} should be rejected`,
    );
  }
});

test('valid baseline matching the test workspaces passes validation', () => {
  const errors = validateBaseline({ workspaces: { 'apps/web': { lines: 80, branches: 70 } } }, [
    'apps/web',
  ]);
  assert.deepEqual(errors, []);
});

test('baselineChanges flags decreases so --update cannot hide a regression', () => {
  const changes = baselineChanges(
    { 'apps/web': { lines: 89.3, branches: 81.3 }, 'packages/db': { lines: 82, branches: 65.5 } },
    { 'apps/web': { lines: 90.1, branches: 81.3 }, 'packages/db': { lines: 79.2, branches: 65.5 } },
  );
  assert.deepEqual(changes, [
    { name: 'apps/web', metric: 'lines', from: 89.3, to: 90.1, decreased: false },
    { name: 'packages/db', metric: 'lines', from: 82, to: 79.2, decreased: true },
  ]);
});

test('baselineChanges is silent for a brand-new workspace (no old entry)', () => {
  const changes = baselineChanges({}, { 'apps/new': { lines: 50, branches: 40 } });
  assert.deepEqual(changes, []);
});

test('updatedBaseline floors current values and keeps tolerance', () => {
  const next = updatedBaseline({ 'apps/web': totals({ lines: 87.68, branches: 74.99 }) }, 0.5);
  assert.deepEqual(next, {
    tolerance: 0.5,
    workspaces: { 'apps/web': { lines: 87.6, branches: 74.9 } },
  });
});
