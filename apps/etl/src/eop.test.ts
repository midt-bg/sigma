import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeWorkerCatchupPlan, listBucketForDay } from './eop';

function fakeDbFromFreshness(maxLoadedDate: string): D1Database {
  const db = {
    prepare(sql: string) {
      if (sql.includes('raw_egov_contracts')) {
        throw new Error('raw staging should not be read for planning');
      }
      return {
        async first() {
          return { max_loaded_date: maxLoadedDate };
        },
      };
    },
  };
  return db as unknown as D1Database;
}

describe('computeWorkerCatchupPlan', () => {
  it('plans from served freshness and ignores leaked raw staging', async () => {
    const plan = await computeWorkerCatchupPlan(fakeDbFromFreshness('2026-06-01'), {
      today: '2026-06-07',
      lookbackDays: 3,
      maxWindowDays: 21,
    });

    expect(plan.from).toBe('2026-05-29');
    expect(plan.to).toBe('2026-06-07');
    expect(plan.maxLoadedDate).toBe('2026-06-01');
  });
});

describe('EOP fetch host allowlist', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects bucket listing redirects to a different final host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response = new Response('<ListBucketResult />', { status: 200 });
        Object.defineProperty(response, 'url', {
          value: 'https://evil.example/open-data-2026-06-01/',
        });
        return response;
      }) as unknown as typeof fetch,
    );

    await expect(listBucketForDay('2026-06-01')).rejects.toThrow(
      /blocked redirected EOP fetch from storage\.eop\.bg to evil\.example/,
    );
  });
});
