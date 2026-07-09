import { describe, expect, it } from 'vitest';
import { loader } from './company.rss';

const contractRow = {
  id: 'c:e:UNP-9:1:eik:222222222',
  subject: 'Ремонт на път',
  unp: 'UNP-9',
  cpv_code: '45000000',
  eu_funded: 0,
  authority_id: 'auth:123456789',
  authority_name: 'Община Пример',
  bidder_id: 'eik:222222222',
  bidder_name: 'Пътстрой ЕООД',
  bidder_kind: 'company',
  procedure_type: 'Открита процедура',
  signed_at: '2026-05-15',
  published_at: '2026-05-10',
  bids_received: 2,
  amount_eur: 1000,
};

function fakeDb(head: { name: string; kind: string } | null, rows: unknown[] = []): D1Database {
  return {
    prepare(sql: string) {
      const stmt = {
        bind() {
          return stmt;
        },
        async first<T>() {
          return (sql.includes('company_totals') ? head : null) as T;
        },
        async all<T>() {
          return { results: rows as T[] };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function call(url: string, eik: string, db: D1Database) {
  return loader({
    request: new Request(url),
    params: { eik },
    context: { cloudflare: { env: { DB: db } } },
  } as unknown as Parameters<typeof loader>[0]);
}

describe('company.rss loader', () => {
  it('serves an RSS feed with self/site links and authority-side items', async () => {
    const res = await call(
      'https://sigma.midt.bg/companies/222222222.rss',
      '222222222',
      fakeDb({ name: 'Пътстрой ЕООД', kind: 'company' }, [contractRow]),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/rss+xml');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');

    const body = await res.text();
    expect(body).toContain('<title>Пътстрой ЕООД - нови договори - СИГМА</title>');
    expect(body).toContain('<link>https://sigma.midt.bg/companies/222222222</link>');
    expect(body).toContain(
      '<atom:link href="https://sigma.midt.bg/companies/222222222.rss" rel="self" type="application/rss+xml"/>',
    );
    // A company feed lists the BUYER (counterparty = 'authority').
    expect(body).toContain('Възложител: Община Пример');
  });

  it('404s for a company absent from the rollup', async () => {
    const res = await call(
      'https://sigma.midt.bg/companies/222222222.rss',
      '222222222',
      fakeDb(null),
    );
    expect(res.status).toBe(404);
  });

  it('404s for an undecodable slug before touching the DB (no bidder id)', async () => {
    // 'xyz' is neither a valid ЕИК nor an `n`-prefixed base64 name slug → bidderIdFromSlug returns null.
    const res = await call(
      'https://sigma.midt.bg/companies/xyz.rss',
      'xyz',
      fakeDb({ name: 'should not be read', kind: 'company' }),
    );
    expect(res.status).toBe(404);
  });

  it('strips a .rss suffix left in the param so the links are not doubled', async () => {
    const res = await call(
      'https://sigma.midt.bg/companies/222222222.rss',
      '222222222.rss',
      fakeDb({ name: 'Пътстрой ЕООД', kind: 'company' }),
    );
    const body = await res.text();
    expect(body).toContain('<link>https://sigma.midt.bg/companies/222222222</link>');
    expect(body).not.toContain('222222222.rss.rss');
  });

  it('builds self/site links from the canonical slug, not the raw request param', async () => {
    // 'nWA==' is a non-canonical encoding of the name-keyed slug 'nWA' (companySlug strips the '='
    // base64 padding). The links must use the canonical 'nWA', matching the HTML profile.
    const res = await call(
      'https://sigma.midt.bg/companies/nWA==.rss',
      'nWA==',
      fakeDb({ name: 'X', kind: 'company' }),
    );
    const body = await res.text();
    expect(body).toContain('<link>https://sigma.midt.bg/companies/nWA</link>');
    expect(body).toContain(
      '<atom:link href="https://sigma.midt.bg/companies/nWA.rss" rel="self" type="application/rss+xml"/>',
    );
    expect(body).not.toContain('nWA==');
  });
});
