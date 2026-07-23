import { describe, expect, it } from 'vitest';
import {
  contractSitemapPages,
  streamAuthoritySitemap,
  streamCompanySitemap,
  streamContractSitemap,
} from './sitemaps';

interface AuthRow {
  authority_id: string;
  last_date: string | null;
}
interface CompRow {
  bidder_id: string;
  name: string;
  last_date: string | null;
}
interface ContractRow {
  rid: number;
  id: string;
  signed_at: string | null;
  published_at: string | null;
}

// Paginating fake D1: keyset queries slice their list by the bound (after[, hi], limit) args, exactly
// like the real SQL. This drives the streamUrls pull loop through its multi-page and empty-chunk paths.
function fakeDb(opts: {
  authorities?: AuthRow[];
  companies?: CompRow[];
  contracts?: ContractRow[];
  asOf?: string | null;
  contractCount?: number | null;
}): D1Database {
  const authorities = opts.authorities ?? [];
  const companies = opts.companies ?? [];
  const contracts = opts.contracts ?? [];
  return {
    prepare(sql: string) {
      if (sql.includes('as_of')) {
        return {
          async first() {
            return { as_of: opts.asOf ?? null };
          },
        };
      }
      if (sql.includes('SELECT contracts FROM home_totals')) {
        return {
          async first() {
            return { contracts: opts.contractCount ?? null };
          },
        };
      }
      let bound: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          bound = a;
          return stmt;
        },
        async all() {
          if (sql.includes('authority_totals')) {
            const [after, limit] = bound as [string, number];
            return { results: authorities.filter((r) => r.authority_id > after).slice(0, limit) };
          }
          if (sql.includes('company_totals')) {
            const [after, limit] = bound as [string, number];
            return { results: companies.filter((r) => r.bidder_id > after).slice(0, limit) };
          }
          const [after, hi, limit] = bound as [number, number, number];
          return { results: contracts.filter((r) => r.rid > after && r.rid <= hi).slice(0, limit) };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

const CHUNK = 5000;
const authId = (i: number) => `auth:${String(i).padStart(6, '0')}`;
const bidderId = (i: number) => `eik:${String(1000000000 + i)}`;

describe('streamAuthoritySitemap', () => {
  it('strips XML-invalid C0 controls and escapes the URL', async () => {
    const db = fakeDb({
      authorities: [{ authority_id: 'auth:1234<&>', last_date: '2026-05-31' }],
      asOf: '2026-06-01',
    });
    const xml = await streamAuthoritySitemap(db, 'https://example.test').text();
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    expect(xml).toContain('https://example.test/authorities/1234&lt;&amp;&gt;');
    expect(xml).toContain('<lastmod>2026-05-31</lastmod>');
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml.endsWith('</urlset>\n')).toBe(true);
  });

  it('falls back to the dataset as_of date when a row has no last_date', async () => {
    const db = fakeDb({
      authorities: [{ authority_id: 'auth:000000111', last_date: null }],
      asOf: '2026-06-01',
    });
    const xml = await streamAuthoritySitemap(db, 'https://x.test').text();
    expect(xml).toContain('/authorities/000000111');
    expect(xml).toContain('<lastmod>2026-06-01</lastmod>');
  });

  it('emits no <lastmod> when neither row date nor as_of is usable', async () => {
    const db = fakeDb({ authorities: [{ authority_id: 'auth:1', last_date: null }], asOf: null });
    const xml = await streamAuthoritySitemap(db, 'https://x.test').text();
    expect(xml).toContain('/authorities/1</loc></url>'); // no <lastmod> between loc and /url
  });

  it('paginates across the CHUNK boundary (multi-page stream)', async () => {
    const authorities = Array.from({ length: CHUNK + 1 }, (_, i) => ({
      authority_id: authId(i),
      last_date: null,
    }));
    const xml = await streamAuthoritySitemap(
      fakeDb({ authorities, asOf: null }),
      'https://x.test',
    ).text();
    const urls = xml.match(/<url>/g) ?? [];
    expect(urls).toHaveLength(CHUNK + 1); // every row across both pages is emitted exactly once
    expect(xml.endsWith('</urlset>\n')).toBe(true);
  });
});

describe('streamCompanySitemap', () => {
  it('encodes the slug and skips natural-person (ЕТ) profiles', async () => {
    const db = fakeDb({
      companies: [
        { bidder_id: 'eik:103267194', name: 'ТЕСТ ООД', last_date: '2026-01-01' },
        { bidder_id: 'name:ЕТ ИВАН', name: 'ЕТ ИВАН ПЕТРОВ', last_date: null }, // filtered out
      ],
      asOf: '2026-06-01',
    });
    const xml = await streamCompanySitemap(db, 'https://x.test').text();
    expect(xml).toContain('/companies/103267194');
    expect(xml).not.toContain('ИВАН'); // natural person excluded
    expect(xml.match(/<url>/g) ?? []).toHaveLength(1);
  });

  it('falls back to the dataset as_of when a company has no last_date', async () => {
    const db = fakeDb({
      companies: [{ bidder_id: 'eik:103267194', name: 'ТЕСТ ООД', last_date: null }],
      asOf: '2026-06-01',
    });
    const xml = await streamCompanySitemap(db, 'https://x.test').text();
    expect(xml).toContain('/companies/103267194</loc><lastmod>2026-06-01</lastmod>');
  });

  it('skips an all-filtered page and continues to the next (empty-chunk loop)', async () => {
    // A full first page of natural persons yields zero slugs but a non-null cursor, so the pull loop
    // must fetch the next page rather than terminate early.
    const companies: CompRow[] = [
      ...Array.from({ length: CHUNK }, (_, i) => ({
        bidder_id: bidderId(i),
        name: 'ЕТ СОБСТВЕНИК', // every one is a natural person → filtered
        last_date: null,
      })),
      { bidder_id: bidderId(CHUNK), name: 'РЕАЛНА ФИРМА ООД', last_date: '2026-02-02' },
    ];
    const xml = await streamCompanySitemap(
      fakeDb({ companies, asOf: null }),
      'https://x.test',
    ).text();
    expect(xml.match(/<url>/g) ?? []).toHaveLength(1); // only the real company survived
    expect(xml).toContain('<lastmod>2026-02-02</lastmod>');
  });
});

describe('streamContractSitemap', () => {
  it('emits contract URLs for a page and closes with the tail', async () => {
    const db = fakeDb({
      contracts: [
        { rid: 1, id: 'c:1', signed_at: '2026-03-01', published_at: null },
        { rid: 2, id: 'c:2', signed_at: null, published_at: '2026-03-02' }, // published_at fallback
        { rid: 3, id: 'c:3', signed_at: null, published_at: null }, // as_of fallback
      ],
      asOf: '2026-06-01',
    });
    const xml = await streamContractSitemap(db, 'https://x.test', 1).text();
    expect(xml).toContain('/contracts/1</loc><lastmod>2026-03-01</lastmod>');
    expect(xml).toContain('/contracts/2</loc><lastmod>2026-03-02</lastmod>'); // published_at
    expect(xml).toContain('/contracts/3</loc><lastmod>2026-06-01</lastmod>'); // as_of
    expect(xml.endsWith('</urlset>\n')).toBe(true);
  });

  it('returns an empty urlset when the page range holds no contracts', async () => {
    const xml = await streamContractSitemap(
      fakeDb({ contracts: [], asOf: null }),
      'https://x.test',
      1,
    ).text();
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n',
    );
  });

  it('scopes a later page to its rowid window via page math', async () => {
    // page 2 → rowid in (45000, 90000]; 40000 is below the lower bound, 90001 above the upper bound,
    // and only 45001 falls in the window — guarding BOTH lo and hi of the page-math computation.
    const contracts: ContractRow[] = [
      { rid: 40000, id: 'c:early', signed_at: '2026-01-01', published_at: null },
      { rid: 45001, id: 'c:inpage', signed_at: '2026-01-02', published_at: null },
      { rid: 90001, id: 'c:overpage', signed_at: '2026-01-03', published_at: null },
    ];
    const xml = await streamContractSitemap(
      fakeDb({ contracts, asOf: null }),
      'https://x.test',
      2,
    ).text();
    expect(xml).toContain('/contracts/inpage');
    expect(xml).not.toContain('/contracts/early'); // below lo (45000)
    expect(xml).not.toContain('/contracts/overpage'); // above hi (90000)
  });

  it('prefers signed_at over published_at for <lastmod> when both are present', async () => {
    // The ?? chain is signed_at ?? published_at ?? fallback — with both dates set, signed_at must win.
    // Guards against a swapped precedence, which the single-date rows above cannot detect.
    const db = fakeDb({
      contracts: [{ rid: 1, id: 'c:both', signed_at: '2026-03-05', published_at: '2026-03-09' }],
      asOf: '2026-06-01',
    });
    const xml = await streamContractSitemap(db, 'https://x.test', 1).text();
    expect(xml).toContain('/contracts/both</loc><lastmod>2026-03-05</lastmod>');
  });

  it('paginates across the CHUNK boundary within a page', async () => {
    const contracts = Array.from({ length: CHUNK + 1 }, (_, i) => ({
      rid: i + 1,
      id: `c:${i + 1}`,
      signed_at: null,
      published_at: null,
    }));
    const xml = await streamContractSitemap(
      fakeDb({ contracts, asOf: null }),
      'https://x.test',
      1,
    ).text();
    expect(xml.match(/<url>/g) ?? []).toHaveLength(CHUNK + 1);
    expect(xml.endsWith('</urlset>\n')).toBe(true);
  });
});

describe('contractSitemapPages', () => {
  it('divides the corpus size into 45k-URL pages, minimum one', async () => {
    expect(await contractSitemapPages(fakeDb({ contractCount: 0 }))).toBe(1);
    expect(await contractSitemapPages(fakeDb({ contractCount: null }))).toBe(1); // missing row → 1
    expect(await contractSitemapPages(fakeDb({ contractCount: 45000 }))).toBe(1);
    expect(await contractSitemapPages(fakeDb({ contractCount: 45001 }))).toBe(2);
    expect(await contractSitemapPages(fakeDb({ contractCount: 190000 }))).toBe(5);
  });
});

describe('empty-input terminals', () => {
  it('authority sitemap with no rows emits just head+tail', async () => {
    const xml = await streamAuthoritySitemap(
      fakeDb({ authorities: [], asOf: null }),
      'https://x.test',
    ).text();
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n',
    );
  });
  it('company sitemap with no rows emits just head+tail', async () => {
    const xml = await streamCompanySitemap(
      fakeDb({ companies: [], asOf: null }),
      'https://x.test',
    ).text();
    expect(xml.match(/<url>/g)).toBeNull();
    expect(xml.endsWith('</urlset>\n')).toBe(true);
  });
});
