// The one-row read of the refresh's stored verdict, against the table exactly as the ETL writes it —
// the write is the real recordRefreshVerdict, so a change to either side that breaks the other fails here.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { d1FromSqlite, throwingD1 } from '@sigma/test-support';
import { recordRefreshVerdict, type RefreshVerdictRecord } from '../../../ingest/src/refresh.ts';
import { getLatestRefreshVerdict, LATEST_REFRESH_VERDICT_SQL } from './refresh-verdict';

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

describe('getLatestRefreshVerdict', () => {
  it('is null on a database no refresh has reached the gate on', async () => {
    const db = fresh();
    expect(await getLatestRefreshVerdict(db)).toBeNull();
    await recordRefreshVerdict(db, run('2026-11-25T00:30:56.000Z', { verdict: 'skipped' }));
    expect(await getLatestRefreshVerdict(db)).toBeNull();
  });

  it('reads the latest run that reached the gate, healthy only when it is ok', async () => {
    const db = fresh();
    await recordRefreshVerdict(db, run('2026-11-25T00:30:56.000Z'));
    expect(await getLatestRefreshVerdict(db)).toEqual({
      verdict: 'ok',
      healthy: true,
      decidedAt: '2026-11-25T00:32:26.000Z',
      checks: [],
      windowFrom: '2026-11-20',
      windowTo: '2026-11-25',
      runStartedAt: '2026-11-25T00:30:56.000Z',
      lastRunAt: '2026-11-25T00:32:26.000Z',
    });
    await recordRefreshVerdict(
      db,
      run('2026-11-25T06:30:57.000Z', { verdict: 'unverified', checks: ['date-sanity'] }),
    );
    expect(await getLatestRefreshVerdict(db)).toMatchObject({
      verdict: 'unverified',
      healthy: false,
      checks: ['date-sanity'],
    });
    await recordRefreshVerdict(
      db,
      run('2026-11-25T12:30:58.000Z', {
        verdict: 'violation',
        checks: ['rollup-reconciliation', 'eik-validity'],
      }),
    );
    expect(await getLatestRefreshVerdict(db)).toMatchObject({
      verdict: 'violation',
      healthy: false,
      checks: ['rollup-reconciliation', 'eik-validity'],
    });
  });

  it('never lets a run with nothing to verify stand in for the last verdict, but counts it as a run', async () => {
    const db = fresh();
    await recordRefreshVerdict(
      db,
      run('2026-11-25T06:30:57.000Z', { verdict: 'violation', checks: ['eik-validity'] }),
    );
    await recordRefreshVerdict(db, run('2026-11-25T12:30:58.000Z', { verdict: 'skipped' }));
    expect(await getLatestRefreshVerdict(db)).toMatchObject({
      verdict: 'violation',
      healthy: false,
      runStartedAt: '2026-11-25T06:30:57.000Z',
      lastRunAt: '2026-11-25T12:32:28.000Z',
    });
  });

  it('walks the index from the newest row instead of sorting the table', async () => {
    const sqlite = new DatabaseSync(':memory:');
    await recordRefreshVerdict(d1FromSqlite(sqlite), run('2026-11-25T00:30:56.000Z'));
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${LATEST_REFRESH_VERDICT_SQL}`)
      .all()
      .map((r) => String(r.detail));
    expect(plan).toContain('SCAN v USING INDEX idx_refresh_verdict_decided');
    expect(plan.some((d) => d.includes('TEMP B-TREE'))).toBe(false);
  });

  it('lets every other failure through — an overloaded D1 is not „no verdict"', async () => {
    const { db } = throwingD1(
      new Error('D1_ERROR: D1 DB is overloaded. Too many resources consumed'),
    );
    await expect(getLatestRefreshVerdict(db)).rejects.toThrow(/overloaded/);
  });
});
