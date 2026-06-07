import { describe, expect, it } from 'vitest';
import { listContracts } from './contracts';

const contractRow = {
  id: 'c:1',
  subject: 'Subject',
  unp: 'UNP-1',
  cpv_code: '45000000',
  eu_funded: 0,
  authority_id: 'auth:123456789',
  authority_name: 'Authority',
  bidder_id: 'eik:111111111',
  bidder_name: 'Bidder',
  bidder_kind: 'company' as const,
  procedure_type: 'Открита процедура',
  signed_at: '2024-01-01',
  bids_received: 3,
  amount_eur: 1000,
  sort_value: 1000,
};

function fakeDb(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return { results: (sql.includes('1=0') ? [] : [contractRow]) as T[] };
        },
        async first<T>() {
          const total = sql.includes('1=0') ? 0 : 1;
          return { total, eur: total ? 1000 : 0, suspect: 0 } as T;
        },
      };
    },
  } as D1Database;
}

describe('listContracts', () => {
  it('returns no rows for an undecodable bidder slug', async () => {
    const page = await listContracts(fakeDb(), { bidder: 'n%', pageSize: 10 });

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });
});
