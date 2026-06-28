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

// A fake served D1 that answers each integrity check's SQL. Defaults make every check pass, with
// home_totals / pipeline_stats absent (so rollup-reconciliation and staging-reconciliation self-skip,
// exactly as on a freshly-sliced served D1). Override one field to inject a single violation / warning
// and assert the live runner→evaluate→throw path end to end (not just the pure reducer).
interface Seed {
  contracts?: number; // non-empty-corpus COUNT(*) — 0 is a hard failure
  negOk?: number; // value_flag='ok' rows with amount_eur < 0 — a hard failure
  badDates?: number; // signed_at out of range — a WARN, never a failure
}
function fakeD1(seed: Seed = {}): D1Database {
  const rows = (sql: string): Record<string, unknown>[] => {
    if (sql.includes('sqlite_master')) {
      // Only contracts + bidders exist; home_totals + pipeline_stats absent → those checks self-skip.
      return /'contracts'|'bidders'/.test(sql) ? [{ name: 'x' }] : [];
    }
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
    expect(violation?.event.checks).toEqual([expect.objectContaining({ name: 'non-empty-corpus' })]);
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
});
