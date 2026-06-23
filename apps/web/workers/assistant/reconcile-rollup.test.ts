import { describe, expect, it } from 'vitest';
import { assertReconciled, reconcile, ReconcileError, type Aggregate } from './reconcile-rollup';

function agg(overrides: Partial<Aggregate> = {}): Aggregate {
  return { grain: { division: '45' }, count: 100, sumEur: 1_000_000, ...overrides };
}

describe('reconcile', () => {
  it('passes when aggregate and rollup are equal', () => {
    const r = reconcile(agg(), agg());
    expect(r.ok).toBe(true);
    expect(r.mismatches).toEqual([]);
  });

  it('flags a count off by one', () => {
    const r = reconcile(agg({ count: 101 }), agg());
    expect(r.ok).toBe(false);
    expect(r.mismatches.map((m) => m.kind)).toContain('count');
  });

  it('treats a sum diff just inside the absolute tolerance as ok', () => {
    const r = reconcile(agg({ sumEur: 1_000_000.49 }), agg(), {
      absoluteTolerance: 0.5,
      relativeTolerance: 0,
    });
    expect(r.ok).toBe(true);
  });

  it('flags a sum diff just outside the absolute tolerance', () => {
    const r = reconcile(agg({ sumEur: 1_000_000.51 }), agg(), {
      absoluteTolerance: 0.5,
      relativeTolerance: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.mismatches.map((m) => m.kind)).toContain('sum');
  });

  it('uses the relative tolerance for large sums', () => {
    const rollup = agg({ sumEur: 1e12 });
    // epsilon = max(0.5, 1e-9 * 1e12) = 1000
    expect(reconcile(agg({ sumEur: 1e12 + 900 }), rollup).ok).toBe(true);
    expect(reconcile(agg({ sumEur: 1e12 + 1100 }), rollup).ok).toBe(false);
  });

  it('tolerates float-accumulation noise within epsilon', () => {
    const noisy = 0.1 + 0.2; // 0.30000000000000004
    const r = reconcile(agg({ sumEur: noisy }), agg({ sumEur: 0.3 }));
    expect(r.ok).toBe(true);
  });

  it('flags a grain mismatch (different value)', () => {
    const r = reconcile(agg({ grain: { division: '44' } }), agg({ grain: { division: '45' } }));
    expect(r.ok).toBe(false);
    expect(r.mismatches.map((m) => m.kind)).toContain('grain');
  });

  it('flags a grain mismatch (missing key)', () => {
    const r = reconcile(
      agg({ grain: { division: '45' } }),
      agg({ grain: { division: '45', year: '2024' } }),
    );
    expect(r.ok).toBe(false);
    expect(r.mismatches.map((m) => m.kind)).toContain('grain');
  });

  it('is order-independent for grain keys', () => {
    const a = agg({ grain: { division: '45', year: '2024' } });
    const b = agg({ grain: { year: '2024', division: '45' } });
    expect(reconcile(a, b).ok).toBe(true);
  });

  it('flags non-finite figures rather than passing them through', () => {
    expect(reconcile(agg({ sumEur: NaN }), agg()).ok).toBe(false);
    expect(reconcile(agg({ count: Infinity }), agg()).ok).toBe(false);
  });

  it('handles zero/empty aggregates', () => {
    expect(reconcile(agg({ count: 0, sumEur: 0 }), agg({ count: 0, sumEur: 0 })).ok).toBe(true);
  });

  it('exposes the epsilon actually used', () => {
    const r = reconcile(agg(), agg({ sumEur: 1e12 }), { relativeTolerance: 1e-9 });
    expect(r.epsilon).toBeCloseTo(1000, 6);
  });
});

describe('assertReconciled', () => {
  it('returns the report when reconciled', () => {
    expect(assertReconciled(agg(), agg()).ok).toBe(true);
  });

  it('throws ReconcileError carrying mismatch detail and never substitutes', () => {
    const aggregate = agg({ count: 101 });
    const rollup = agg();
    let thrown: unknown;
    try {
      assertReconciled(aggregate, rollup);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ReconcileError);
    expect((thrown as ReconcileError).mismatches.length).toBeGreaterThan(0);
    expect((thrown as ReconcileError).message).toMatch(/count mismatch/);
    // Inputs are left untouched — nothing substituted.
    expect(aggregate.count).toBe(101);
    expect(rollup.count).toBe(100);
  });

  it('reports multiple simultaneous mismatches', () => {
    const r = reconcile(agg({ count: 99, sumEur: 2_000_000, grain: { division: '44' } }), agg());
    expect(r.mismatches.map((m) => m.kind).sort()).toEqual(['count', 'grain', 'sum']);
  });
});
