// The refresh's verdict, stored so it can be read from outside the Workflow log — on a real SQLite
// behind the D1 facade, because what matters is the table the write leaves behind. The one-row read a
// status reader runs against it is @sigma/db's getLatestRefreshVerdict, tested there against this write.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import {
  recordRefreshVerdict,
  REFRESH_VERDICT_RETENTION_DAYS,
  type RefreshVerdictRecord,
} from './refresh';

const fresh = () => d1FromSqlite(new DatabaseSync(':memory:'));
const run = (at: string, over: Partial<RefreshVerdictRecord> = {}): RefreshVerdictRecord => ({
  runStartedAt: at,
  windowFrom: '2026-11-20',
  windowTo: '2026-11-25',
  verdict: 'ok',
  checks: [],
  decidedAt: new Date(Date.parse(at) + 90_000).toISOString(),
  ...over,
});
const rows = async (db: D1Database) =>
  (await db.prepare('SELECT * FROM refresh_verdict ORDER BY run_started_at').all()).results;

describe('recordRefreshVerdict', () => {
  it('creates its table on first use and stores the run, its window, the verdict and the check names', async () => {
    const db = fresh();
    await recordRefreshVerdict(
      db,
      run('2026-11-25T06:30:57.000Z', {
        verdict: 'violation',
        checks: ['rollup-reconciliation', 'eik-validity'],
      }),
    );
    expect(await rows(db)).toEqual([
      {
        run_started_at: '2026-11-25T06:30:57.000Z',
        window_from: '2026-11-20',
        window_to: '2026-11-25',
        verdict: 'violation',
        checks: '["rollup-reconciliation","eik-validity"]',
        decided_at: '2026-11-25T06:32:27.000Z',
      },
    ]);
  });

  it('keeps one row per run: a retried write replaces its own row', async () => {
    const db = fresh();
    const at = '2026-11-25T06:30:57.000Z';
    await recordRefreshVerdict(db, run(at, { verdict: 'unverified', checks: ['date-sanity'] }));
    await recordRefreshVerdict(db, run(at, { verdict: 'unverified', checks: ['eik-validity'] }));
    expect(await rows(db)).toMatchObject([{ run_started_at: at, checks: '["eik-validity"]' }]);
  });

  it('refuses a verdict outside the four it knows', async () => {
    const db = fresh();
    await expect(
      recordRefreshVerdict(db, run('2026-11-25T00:30:56.000Z', { verdict: 'fine' as never })),
    ).rejects.toThrow(/CHECK constraint/);
  });

  it(`prunes rows older than ${REFRESH_VERDICT_RETENTION_DAYS} days with the write that adds one`, async () => {
    const db = fresh();
    await recordRefreshVerdict(db, run('2026-08-01T00:30:00.000Z'));
    await recordRefreshVerdict(db, run('2026-08-28T00:30:00.000Z'));
    await recordRefreshVerdict(db, run('2026-11-25T00:30:00.000Z', { verdict: 'skipped' }));
    expect((await rows(db)).map((r) => r.run_started_at)).toEqual([
      '2026-08-28T00:30:00.000Z',
      '2026-11-25T00:30:00.000Z',
    ]);
  });
});
