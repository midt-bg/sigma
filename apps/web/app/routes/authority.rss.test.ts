import { describe, expect, it } from 'vitest';
import { loader } from './authority.rss';

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

function fakeDb(head: { name: string } | null, rows: unknown[] = []): D1Database {
  return {
    prepare(sql: string) {
      const stmt = {
        bind() {
          return stmt;
        },
        async first<T>() {
          return (sql.includes('authority_totals') ? head : null) as T;
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

describe('authority.rss loader', () => {
  it('serves an RSS feed with self/site links and bidder-side items', async () => {
    const res = await call(
      'https://sigma.midt.bg/authorities/123456789.rss',
      '123456789',
      fakeDb({ name: 'Община Пример' }, [contractRow]),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/rss+xml');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');

    const body = await res.text();
    expect(body).toContain('<title>Община Пример - нови договори - СИГМА</title>');
    expect(body).toContain('<link>https://sigma.midt.bg/authorities/123456789</link>');
    expect(body).toContain(
      '<atom:link href="https://sigma.midt.bg/authorities/123456789.rss" rel="self" type="application/rss+xml"/>',
    );
    // An authority feed lists the WINNER (counterparty = 'bidder').
    expect(body).toContain('Изпълнител: Пътстрой ЕООД');
    // contractSlug strips the leading 'c:' from the id.
    expect(body).toContain('<link>https://sigma.midt.bg/contracts/e:UNP-9:1:eik:222222222</link>');
  });

  it('404s for an authority absent from the rollup', async () => {
    const res = await call('https://sigma.midt.bg/authorities/999.rss', '999', fakeDb(null));
    expect(res.status).toBe(404);
  });

  it('404s for an empty eik', async () => {
    const res = await call('https://sigma.midt.bg/authorities/.rss', '.rss', fakeDb({ name: 'x' }));
    expect(res.status).toBe(404);
  });

  it('strips a .rss suffix left in the param so the links are not doubled', async () => {
    const res = await call(
      'https://sigma.midt.bg/authorities/123456789.rss',
      '123456789.rss',
      fakeDb({ name: 'Община Пример' }),
    );
    const body = await res.text();
    expect(body).toContain('<link>https://sigma.midt.bg/authorities/123456789</link>');
    expect(body).not.toContain('123456789.rss.rss');
  });
});
