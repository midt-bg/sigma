import { describe, expect, it } from 'vitest';
import { fakeD1, type FakeD1 } from '@sigma/test-support';
import {
  MAX_QUERY_CHARS,
  MAX_QUERY_TOKENS,
  search,
  searchMatchQuery,
  searchMoreHref,
} from './search';
import { personSlug } from './identity';

// `officialBestRank` drives the relevance gate: FTS bm25 rank is negative, lower = better. Company's best is
// -5 below, so an official best of -6 LEADS (stronger) and -1 SINKS (weaker/incidental) — the two gate arms.
function searchDb(officialBestRank = -6, hasConflictTable = true): D1Database {
  const officialRows = [
    {
      ref: 'person:ИВАН МИНЕВ',
      title: 'Иван Минев',
      ident: null,
      subtitle: 'Община Русе',
      amount: 500000,
      entity_kind: null,
      ownership_kind: null,
      eik_valid: null,
      has_conflict: 0,
      rank: officialBestRank,
    },
    {
      ref: 'person:ГЕОРГИ ПЕТРОВ',
      title: 'Георги Петров',
      ident: null,
      subtitle: 'Министерство Х',
      amount: 300000,
      entity_kind: null,
      ownership_kind: null,
      eik_valid: null,
      has_conflict: 0,
      rank: officialBestRank + 0.1,
    },
  ];
  const companyRows = [
    {
      ref: 'name:А1 БЪЛГАРИЯ ЕАД; БЕТА ООД',
      title: 'А1 БЪЛГАРИЯ ЕАД; БЕТА ООД',
      ident: '',
      subtitle: null,
      amount: 2000,
      entity_kind: 'consortium',
      ownership_kind: null,
      eik_valid: 0,
      has_conflict: 0,
      rank: -5,
    },
    {
      ref: 'name:No EIK Company',
      title: 'No EIK Company',
      ident: '',
      subtitle: null,
      amount: 1500,
      entity_kind: 'company',
      ownership_kind: null,
      eik_valid: 0,
      has_conflict: 0,
      rank: -4.9,
    },
    ...Array.from({ length: 4 }, (_, i) => ({
      ref: `eik:11111111${i}`,
      title: `Company ${i}`,
      ident: `11111111${i}`,
      subtitle: null,
      amount: 1000 + i,
      entity_kind: 'company',
      ownership_kind: i === 0 ? 'state' : null,
      eik_valid: 1,
      has_conflict: i === 0 ? 1 : 0, // Company 0 also appears in the свързани-лица surface → badge
      rank: -4.8 + i * 0.1,
    })),
  ];
  const contractRows = Array.from({ length: 6 }, (_, i) => ({
    ref: `c:${i}`,
    title: `Contract ${i}`,
    ident: `UNP-${i}`,
    subtitle: null,
    amount: 1000 + i,
    has_conflict: 0,
    rank: -4 + i * 0.1,
  }));

  const byKind: Record<string, object[]> = {
    official: officialRows,
    company: companyRows,
    contract: contractRows,
  };

  return fakeD1([
    // The свързани-лица table probe drives which hits SQL search() runs. Report present/absent per the
    // fixture flag so both the with-conflict path and the un-migrated fallback are exercisable.
    // BOTH свързани-лица tables must be present (n === 2) for the conflict-aware hits SQL to run;
    // the fixture reports the real count, not a truthy stand-in, or it would silently exercise the
    // un-migrated fallback while claiming to cover the badge path.
    { when: 'sqlite_master', first: hasConflictTable ? { n: 2 } : null },
    // Per-kind counts, before the hits route below: both read search_index, and only GROUP BY kind
    // tells them apart.
    {
      when: ['FROM search_index', 'GROUP BY kind'],
      all: [
        { kind: 'official', n: 2 },
        { kind: 'company', n: 7 },
        { kind: 'contract', n: 6 },
      ],
    },
    // The hits query, one execution per kind — which kind is in the first bound argument.
    { when: 'FROM search_index', all: (call) => byKind[String(call.binds[0])] ?? [] },
  ]).db;
}

describe('search helpers', () => {
  it('builds list hrefs with an encoded q filter', () => {
    const href = searchMoreHref('company', 'строителство София');
    const url = new URL(`https://sigma.test${href}`);

    expect(url.pathname).toBe('/companies');
    expect(url.searchParams.get('q')).toBe('строителство София');
  });

  it('caps over-long MATCH queries at the shared chokepoint', () => {
    const q = Array.from({ length: 32 }, (_, i) => `word${i}`).join(' ');
    expect(q.length).toBeGreaterThan(MAX_QUERY_CHARS);

    const match = searchMatchQuery(q);
    const terms = match?.split(' ') ?? [];

    expect(terms.length).toBeLessThanOrEqual(MAX_QUERY_TOKENS);
    expect(match?.length).toBeLessThanOrEqual(MAX_QUERY_CHARS + MAX_QUERY_TOKENS);
  });

  it('keeps normal short MATCH query behavior unchanged', () => {
    expect(searchMatchQuery('Стрoителствo София 123')).toBe('строителство* софия* 123*');
  });

  it('drops single-character terms so a 1-char prefix cannot scan the whole index', () => {
    // Every token is one char → nothing survives the min-length filter → empty query.
    expect(searchMatchQuery('и а с по')).toBe('по*');
    expect(searchMatchQuery('и')).toBeNull();
    expect(searchMatchQuery('a b c')).toBeNull();
  });

  it('reduces FTS5 operators/punctuation to plain prefix terms — no MATCH-syntax injection', () => {
    // Quotes, NEAR, parentheses, a bare OR keyword and a column filter (`x:1`) must survive only as
    // ordinary prefix tokens — never as FTS5 syntax that could error the query or widen the scan.
    const out = searchMatchQuery('алфа" NEAR/2 (бета) OR x:1')!;
    expect(out).toBe('алфа* near* бета* or*');
    expect(out).not.toMatch(/["():/=]/);
  });
});

describe('search', () => {
  it('sets moreHref only for truncated groups', async () => {
    const results = await search(searchDb(), 'строителство');
    const company = results.groups.find((g) => g.kind === 'company');
    const contract = results.groups.find((g) => g.kind === 'contract');
    const authority = results.groups.find((g) => g.kind === 'authority');

    expect(company?.moreHref).toBe(
      '/companies?q=%D1%81%D1%82%D1%80%D0%BE%D0%B8%D1%82%D0%B5%D0%BB%D1%81%D1%82%D0%B2%D0%BE',
    );
    expect(contract?.moreHref).toBeNull();
    expect(authority?.moreHref).toBeNull();
  });

  it('flags company search exceptions without exposing consortium member piles as titles', async () => {
    const results = await search(searchDb(), 'а1');
    const hits = results.groups.find((g) => g.kind === 'company')?.hits ?? [];

    expect(hits[0]).toMatchObject({
      title: 'А1 БЪЛГАРИЯ ЕАД и др.',
      ident: null,
      isConsortium: true,
      hasEik: false,
      memberCount: 2,
    });
    expect(hits[1]).toMatchObject({
      title: 'No EIK Company',
      ident: null,
      isConsortium: false,
      hasEik: false,
      memberCount: null,
    });
    expect(hits[2]).toMatchObject({
      title: 'Company 0',
      ownershipKind: 'state',
    });
  });

  it('surfaces свързани лица as officials that link to the conflict profile', async () => {
    const results = await search(searchDb(), 'иван');
    const official = results.groups.find((g) => g.kind === 'official');
    expect(official?.label).toBe('Свързани лица');
    expect(official?.hits[0]).toMatchObject({
      kind: 'official',
      title: 'Иван Минев',
      subtitle: 'Община Русе',
      amountLabel: 'по договори',
      href: `/conflicts/official/${personSlug('person:ИВАН МИНЕВ')}`,
    });
  });

  it('lets свързани лица LEAD when it is the strongest match', async () => {
    // official best rank -6 beats the best company rank -5 → it leads.
    const results = await search(searchDb(-6), 'иван минев');
    expect(results.groups.filter((g) => g.total > 0)[0]?.kind).toBe('official');
  });

  it('sinks свързани лица to last on a weaker, incidental match', async () => {
    // official best rank -1 loses to the best company rank -5 → it must not hijack the top, only trail.
    const results = await search(searchDb(-1), 'строеж');
    const nonEmpty = results.groups.filter((g) => g.total > 0);
    expect(nonEmpty[0]?.kind).not.toBe('official');
    expect(nonEmpty.at(-1)?.kind).toBe('official');
  });

  it('flags the company that appears in the свързани-лица surface, and only that one', async () => {
    const results = await search(searchDb(), 'company');
    const companies = results.groups.find((g) => g.kind === 'company')?.hits ?? [];
    const flagged = companies.filter((h) => h.hasConflict);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.title).toBe('Company 0');
  });

  it('does not 500 when the свързани-лица table is absent (un-migrated env)', async () => {
    // sqlite_master probe → table missing → search() runs the no-conflict hits SQL. It must complete and
    // still return the other groups; the has_conflict=0 correctness of that SQL is proven in search-sql.test.
    const results = await search(searchDb(-6, false), 'company');
    expect(results.groups.find((g) => g.kind === 'company')?.hits.length ?? 0).toBeGreaterThan(0);
  });
});

describe('search — empty query and href fallback', () => {
  it('returns the empty shape for a blank or punctuation-only query', async () => {
    expect(await search(searchDb(), '')).toEqual({ query: '', groups: [], empty: true });
    expect(await search(searchDb(), '   ""   ')).toMatchObject({ empty: true, groups: [] });
  });

  it('coalesces a null/undefined raw query to the empty shape', async () => {
    // (rawQuery ?? '').trim() — a nullish query must not throw before normalisation.
    expect(await search(searchDb(), null as unknown as string)).toMatchObject({ empty: true });
    expect(await search(searchDb(), undefined as unknown as string)).toMatchObject({ empty: true });
  });

  it('searchMoreHref falls back to /search for an unrecognised kind', () => {
    const href = searchMoreHref('nope' as unknown as Parameters<typeof searchMoreHref>[0], 'q');
    expect(href.startsWith('/search?q=')).toBe(true);
  });
});

// A search DB that reports an arbitrary свързани-лица table count and can starve one group of hits.
// The probe statement itself names the tables, so it is filtered out of the recorded SQL before
// asserting which hits SQL actually ran — see hitsSql below.
const hitsSql = (fake: FakeD1) => fake.sql.filter((s) => !s.includes('sqlite_master'));

const OFFICIAL_HIT = {
  ref: 'person:ИВАН МИНЕВ',
  title: 'Иван Минев',
  ident: null,
  subtitle: 'Община Русе',
  amount: 500000,
  entity_kind: null,
  ownership_kind: null,
  eik_valid: null,
  has_conflict: 0,
  rank: -6,
};
const COMPANY_HIT = {
  ref: 'eik:111111113',
  title: 'ТЕСТ ООД',
  ident: '111111113',
  subtitle: null,
  amount: 1000,
  entity_kind: 'company',
  ownership_kind: null,
  eik_valid: 1,
  has_conflict: 1,
  rank: -5,
};

function probeDb(tableCount: number | null, starvedKind: string | null = null): FakeD1 {
  return fakeD1([
    { when: 'sqlite_master', first: tableCount === null ? null : { n: tableCount } },
    {
      when: ['FROM search_index', 'GROUP BY kind'],
      all: [
        { kind: 'official', n: 2 },
        { kind: 'company', n: 7 },
      ],
    },
    {
      when: 'FROM search_index',
      all: (call) => {
        const kind = String(call.binds[0]);
        if (kind === starvedKind) return [];
        return kind === 'official' ? [OFFICIAL_HIT] : [COMPANY_HIT];
      },
    },
  ]);
}

describe('search — свързани-лица migration probe and count/hits divergence', () => {
  it('runs the conflict-aware hits SQL only when BOTH tables are present', async () => {
    const both = probeDb(2);
    await search(both.db, 'тест');
    expect(hitsSql(both).some((s) => s.includes('interest_links'))).toBe(true);

    // 0003 applied but not 0006: the join would reference a table that isn't there and 500 every
    // search, so a partial migration must read the same as no migration at all.
    const partial = probeDb(1);
    await search(partial.db, 'тест');
    expect(hitsSql(partial).some((s) => s.includes('interest_links'))).toBe(false);
  });

  it('treats a probe that returns no row at all as un-migrated', async () => {
    const none = probeDb(null);
    await search(none.db, 'тест');
    expect(hitsSql(none).some((s) => s.includes('interest_links'))).toBe(false);
  });

  it('keeps a group whose count is non-zero but whose hits come back empty', async () => {
    // The count and the hits are two separate FTS reads; they can disagree (index churn between them).
    // The group must survive with its real total and an intact „виж всички" link rather than vanish.
    const results = await search(probeDb(2, 'company').db, 'тест');
    const company = results.groups.find((g) => g.kind === 'company');
    expect(company).toMatchObject({ total: 7, hits: [] });
    expect(company!.moreHref).not.toBeNull();
    expect(results.empty).toBe(false); // a real total, so the „нищо не е намерено" state stays off
  });

  it('does not let a hitless group out-rank a real match in the placement gate', async () => {
    // A group with no rows has no bm25 rank at all. Reading one out of an empty result set (rather than
    // standing it off at Infinity) would hand it the strongest possible score and sink „Свързани лица"
    // below a group that matched nothing — the exact placement the minister's ask reverses.
    const groups = (await search(probeDb(2, 'company').db, 'тест')).groups;
    expect(groups[0]!.kind).toBe('official');
  });
});
