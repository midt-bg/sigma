import { describe, expect, it } from 'vitest';
import { runServedIntegrityGate, type GateLog } from './integrity';

interface Captured {
  level: 'info' | 'warn' | 'error';
  event: Record<string, unknown>;
}

function fakeLog(): GateLog & { events: Captured[] } {
  const events: Captured[] = [];
  return {
    events,
    info: (event) => events.push({ level: 'info', event }),
    warn: (event) => events.push({ level: 'warn', event }),
    error: (event) => events.push({ level: 'error', event }),
  };
}

// A fake served D1 that answers each integrity check's SQL. By DEFAULT the rollups are absent
// (home_totals / pipeline_stats missing) — a work DB before precompute, where rollup-reconciliation
// and staging-reconciliation correctly self-skip. That is NOT the steady state of a served D1: on the
// served D1 refresh-slice/precompute have written home_totals, so rollup-reconciliation RUNS. Pass
// `rollups: true` to model that served D1 (rollups present → the check runs, not skips); combine with
// `homeDrift` to inject a home_totals.value_eur that no longer reconciles with SUM(amount_eur) — the
// ministry-visible drift this gate exists to catch. Override one field to inject a single violation /
// warning and assert the live runner→evaluate→throw path end to end (not just the pure reducer).
interface Seed {
  contracts?: number; // non-empty-corpus COUNT(*) — 0 is a hard failure
  negOk?: number; // value_flag='ok' rows with amount_eur < 0 — a hard failure
  badDates?: number; // signed_at out of range — a WARN, never a failure
  rollups?: boolean; // home_totals present (precompute ran) → rollup-reconciliation RUNS, not skips
  homeDrift?: number; // home_totals.value_eur − SUM(amount_eur); non-zero → a caught hard failure
}
function fakeD1(seed: Seed = {}): D1Database {
  const rows = (sql: string): Record<string, unknown>[] => {
    if (sql.includes('sqlite_master')) {
      // contracts + bidders always exist; home_totals only once precompute has written the rollups.
      if (seed.rollups && sql.includes("'home_totals'")) return [{ name: 'x' }];
      return /'contracts'|'bidders'/.test(sql) ? [{ name: 'x' }] : [];
    }
    if (sql.includes('FROM home_totals') && sql.includes('COUNT(*) AS n')) {
      return [{ n: seed.rollups ? 1 : 0 }];
    }
    if (sql.includes('clean_total')) {
      // The single folded rollup-reconciliation SELECT. Everything reconciles except, when homeDrift is
      // set, home_totals.value_eur — exactly the drift on a ministry-visible total this check must catch.
      const clean = 1_000_000;
      return [
        {
          clean_total: clean,
          home_value: clean + (seed.homeDrift ?? 0),
          auth_rollup: clean,
          auth_attr: clean,
          company_rollup: clean,
          bidder_attr: clean,
          flow_rollup: clean,
          flow_attr: clean,
          orphan_auth_rows: 0,
          orphan_bidder_rows: 0,
        },
      ];
    }
    if (sql.includes('spent_eur < 0')) return [{ a: 0, c: 0, f: 0 }];
    if (sql.includes('signed_at')) return [{ n: seed.badDates ?? 0 }];
    if (sql.includes('FROM contracts') && sql.includes('COUNT(*) AS n')) {
      return [{ n: seed.contracts ?? 5 }];
    }
    if (sql.includes('neg_ok')) return [{ neg_ok: seed.negOk ?? 0, neg_other: 0 }];
    if (sql.includes('eik_valid = 1')) return [{ n: 0 }];
    if (sql.includes('eik_valid <> 1')) return [{ n: 0 }];
    return [];
  };
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: rows(sql) };
        },
      };
    },
  } as unknown as D1Database;
}

describe('runServedIntegrityGate', () => {
  it('passes (logs ok, does not throw) on a clean served D1', async () => {
    const log = fakeLog();
    await expect(runServedIntegrityGate(fakeD1(), log)).resolves.toBeUndefined();
    const ok = log.events.find((e) => e.event.event === 'etl_integrity_ok');
    expect(ok?.level).toBe('info');
    expect(log.events.some((e) => e.level === 'error')).toBe(false);
  });

  it('throws and logs a violation when a check fails over the live D1 (empty corpus)', async () => {
    const log = fakeLog();
    await expect(runServedIntegrityGate(fakeD1({ contracts: 0 }), log)).rejects.toThrow(
      /integrity gate failed/,
    );
    const violation = log.events.find((e) => e.event.event === 'etl_integrity_violation');
    expect(violation?.level).toBe('error');
    expect(violation?.event.checks).toEqual([
      expect.objectContaining({ name: 'non-empty-corpus' }),
    ]);
  });

  it('throws on a hard data-integrity violation (negative ok amount_eur)', async () => {
    const log = fakeLog();
    await expect(runServedIntegrityGate(fakeD1({ negOk: 3 }), log)).rejects.toThrow(
      /integrity gate failed/,
    );
    expect(log.events.some((e) => e.event.event === 'etl_integrity_violation')).toBe(true);
  });

  it('alerts but does NOT throw on a warn-only condition (out-of-range dates)', async () => {
    const log = fakeLog();
    await expect(runServedIntegrityGate(fakeD1({ badDates: 2 }), log)).resolves.toBeUndefined();
    expect(log.events.some((e) => e.event.event === 'etl_integrity_warn')).toBe(true);
    expect(log.events.some((e) => e.level === 'error')).toBe(false);
  });

  it('runs rollup-reconciliation once the rollups exist (does not silently self-skip)', async () => {
    const skippedFor = async (seed: Seed): Promise<number> => {
      const log = fakeLog();
      await runServedIntegrityGate(fakeD1(seed), log);
      const ok = log.events.find((e) => e.event.event === 'etl_integrity_ok');
      return ok?.event.skipped as number;
    };
    // With home_totals present, one fewer check self-skips than on the bare work DB — that check is
    // rollup-reconciliation moving from skipped to actually run over the live D1.
    expect(await skippedFor({ rollups: true })).toBe((await skippedFor({})) - 1);
  });

  it('throws when a rollup no longer reconciles with SUM(amount_eur) over the live D1', async () => {
    const log = fakeLog();
    await expect(
      runServedIntegrityGate(fakeD1({ rollups: true, homeDrift: 5_000 }), log),
    ).rejects.toThrow(/integrity gate failed/);
    const violation = log.events.find((e) => e.event.event === 'etl_integrity_violation');
    expect(violation?.level).toBe('error');
    expect(violation?.event.checks).toEqual([
      expect.objectContaining({ name: 'rollup-reconciliation' }),
    ]);
  });
});
