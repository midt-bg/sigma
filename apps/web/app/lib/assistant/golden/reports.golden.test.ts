/// <reference types="node" />
// Golden-reports replay harness (G1 step 10).
//
// Loads every recorded fixture and replays it through the REAL server pipeline (replay.ts →
// runTool('run_sql', …) → finalizeReport), then asserts the six integrity properties (assertions.ts).
// A positive fixture must satisfy all six; the negative fixtures each violate exactly one property and
// are exercised by the negative-path block. Asserting only invariants/substrings keeps a benign guard
// refactor from churning the corpus.

import { readFileSync, readdirSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertAmountEurUsage,
  assertDefaultFiltersApplied,
  assertNoNaNOrEmpty,
  assertNoProseFigures,
  assertReconcile,
  assertSchemaValid,
} from './assertions';
import { RESULT_HANDLE_RE, REJECTION_RE, replayFixture, type ReplayOutcome } from './replay';
import type { GoldenFixture } from './types';

const FIXTURE_DIR = new URL('./fixtures', import.meta.url);

function loadFixtures(): GoldenFixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.golden.json'))
    .sort()
    .map(
      (name) =>
        JSON.parse(
          readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
        ) as GoldenFixture,
    );
}

const ALL = loadFixtures();
const POSITIVE = ALL.filter((f) => !f.negative);
const byId = (id: string): GoldenFixture => {
  const f = ALL.find((x) => x.id === id);
  if (!f) throw new Error(`fixture not found: ${id}`);
  return f;
};

describe('golden corpus', () => {
  it('has a replay-sized corpus (20–50) with unique ids', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(20);
    expect(ALL.length).toBeLessThanOrEqual(50);
    expect(new Set(ALL.map((f) => f.id)).size).toBe(ALL.length);
  });

  it("replays every fixture's run_sql steps to a result handle, never a rejection", async () => {
    for (const fixture of ALL) {
      const { stepReturns } = await replayFixture(fixture);
      expect(stepReturns.length).toBe(fixture.steps.length);
      for (const ret of stepReturns) {
        expect(ret, `fixture ${fixture.id}: ${ret}`).not.toMatch(REJECTION_RE);
        expect(ret, `fixture ${fixture.id}: ${ret}`).toMatch(RESULT_HANDLE_RE);
      }
    }
  });
});

describe.each(POSITIVE.map((f) => [f.id, f] as const))('golden fixture %s', (_id, fixture) => {
  let outcome: ReplayOutcome;
  beforeAll(async () => {
    outcome = await replayFixture(fixture);
  });

  const report = () => {
    if (!outcome.bind.ok) throw new Error(`bind failed: ${outcome.bind.errors.join('; ')}`);
    return outcome.bind.report;
  };

  it('1. binds to a structurally valid resolved report', () => {
    expect(() => assertSchemaValid(outcome.bind)).not.toThrow();
  });

  it('2. sums money via amount_eur, never the raw amount column', () => {
    expect(() => assertAmountEurUsage(fixture)).not.toThrow();
  });

  it('3. applies the default contract filters (gate enforced; callout not rendered)', () => {
    expect(() => assertDefaultFiltersApplied(fixture)).not.toThrow();
  });

  it('4. reconciles any presented count/sum against a valid rollup', () => {
    expect(() => assertReconcile(fixture, outcome.reconcileReturn)).not.toThrow();
  });

  it('5. carries no material number in model prose', () => {
    expect(() => assertNoProseFigures(outcome.bind)).not.toThrow();
  });

  it('6. presents only finite numbers and no empty data blocks', () => {
    expect(() => assertNoNaNOrEmpty(report(), fixture.expect.emptyOk)).not.toThrow();
  });
});

describe('negative fixtures each violate exactly one property', () => {
  it('prose-number: a smuggled material number fails to bind', async () => {
    const { bind } = await replayFixture(byId('90-neg-prose-number'));
    expect(bind.ok).toBe(false);
    if (!bind.ok) expect(bind.errors.join(' ')).toMatch(/material number/i);
    expect(() => assertNoProseFigures(bind)).toThrow();
  });

  it('dangling-column: a missing column reference renders null and surfaces a warning', async () => {
    const { bind } = await replayFixture(byId('93-neg-dangling-handle'));
    expect(bind.ok).toBe(true);
    if (bind.ok) expect(bind.warnings.join(' ')).toMatch(/no column "nonexistent_col"/i);
    expect(() => assertSchemaValid(bind)).not.toThrow();
  });

  it('home-totals: the real reconcile_rollup tool rejects a home_totals target', async () => {
    const { reconcileReturn } = await replayFixture(byId('91-neg-home-totals-target'));
    expect(reconcileReturn).toMatch(REJECTION_RE);
    expect(reconcileReturn).toMatch(/home_totals/);
    // assertion 4 treats a non-reconciled return as a violation.
    expect(() => assertReconcile(byId('91-neg-home-totals-target'), reconcileReturn)).toThrow();
  });

  it('reconcile-mismatch: a disagreeing aggregate is surfaced, not reconciled', async () => {
    const { reconcileReturn } = await replayFixture(byId('92-neg-reconcile-mismatch'));
    expect(reconcileReturn).toMatch(/reconciliation failed/);
    expect(reconcileReturn).toMatch(/count mismatch/);
    expect(() => assertReconcile(byId('92-neg-reconcile-mismatch'), reconcileReturn)).toThrow();
  });
});
