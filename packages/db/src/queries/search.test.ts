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

// The ranked read answers every kind at once: each row carries its kind, its place in the kind (rn) and the
// kind's count (n). Builds those rows from per-kind lists in rank order and the per-kind counts.
function rankedRows(
  byKind: Record<string, object[]>,
  counts: Record<string, number> = {},
): object[] {
  return Object.entries(byKind).flatMap(([kind, list]) =>
    list.map((r, i) => ({ ...r, kind, rn: i + 1, n: counts[kind] ?? list.length })),
  );
}

// `officialBestRank` drives the relevance gate: FTS bm25 rank is negative, lower = better. Company's best is
// -5 below, so an official best of -6 LEADS (stronger) and -1 SINKS (weaker/incidental) — the two gate arms.
function searchDb(
  officialBestRank = -6,
  hasConflictTable = true,
  personBestRank: number | null = null,
): D1Database {
  const officialRows = [
    {
      ref: 'person:ИВАН МИНЕВ',
      title: 'Иван Минев',
      ident: null,
      subtitle: 'Община Тестово',
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
      ref: 'name:А1 ПРИМЕР ЕАД; БЕТА ООД',
      title: 'А1 ПРИМЕР ЕАД; БЕТА ООД',
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

  const personRows =
    personBestRank == null
      ? []
      : [
          {
            ref: 'a'.repeat(64),
            title: 'МАРИЯ ПЕТРОВА',
            subtitle: 'АЛФА ООД',
            rank: personBestRank,
          },
          {
            ref: 'person:МАРИЯ ПЕТРОВА|ОБЩИНА',
            title: 'Мария Петрова',
            subtitle: 'Кмет · Община',
            rank: personBestRank + 0.1,
          },
        ].map((r) => ({ ...r, ident: '', amount: null, has_conflict: 0 }));

  const byKind: Record<string, object[]> = {
    official: officialRows,
    person: personRows,
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
    // The people's own filings, for the office line: one official left an office with an exit declaration.
    {
      when: 'FROM declarations d',
      all: [
        { year: '2018', type: 'Annualy', declaredOn: null },
        { year: '2019', type: 'Vacate', declaredOn: '2019-11-04' },
      ].map((f) => ({
        person_id: 'person:ИВАН МИНЕВ',
        institution: 'Община Тестово',
        position: 'Кмет',
        ...f,
      })),
    },
    // The one ranked read: every kind's best rows with the kind's count.
    {
      when: 'FROM search_index',
      all: rankedRows(byKind, { official: 2, person: 9, company: 7, contract: 6 }),
    },
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
    const byTitle = (t: string) => hits.find((h) => h.title === t);

    expect(byTitle('А1 ПРИМЕР ЕАД и др.')).toMatchObject({
      ident: null,
      isConsortium: true,
      hasEik: false,
      memberCount: 2,
    });
    expect(byTitle('No EIK Company')).toMatchObject({
      ident: null,
      isConsortium: false,
      hasEik: false,
      memberCount: null,
    });
    expect(byTitle('Company 0')).toMatchObject({ ownershipKind: 'state' });
  });

  it('puts the company named exactly as the query first, then rows with a valid ЕИК', async () => {
    const row = (ref: string, title: string, eik_valid: number, rank: number) => ({
      ref,
      title,
      ident: eik_valid ? ref.slice(4) : '',
      subtitle: null,
      amount: 1,
      entity_kind: title.includes(';') ? 'consortium' : 'company',
      ownership_kind: null,
      eik_valid,
      has_conflict: 0,
      rank,
    });
    // bm25 order: consortium strings and a name-keyed fragment ahead of the canonical company.
    const rows = [
      row('name:ТЕСТ ГРУП ЕООД; АЛФА ООД', 'ТЕСТ ГРУП ЕООД; АЛФА ООД', 0, -9),
      row('name:ТЕСТ ГРУП', 'ТЕСТ ГРУП', 0, -8.9),
      row('eik:111111118', 'ТЕСТ ГРУП ИНВЕСТ АД', 1, -8.8),
      ...Array.from({ length: 5 }, (_, i) =>
        row(`name:ТЕСТ ГРУП ${i}; БЕТА`, `ТЕСТ ГРУП ${i}; БЕТА`, 0, -8.7 + i * 0.01),
      ),
      row('eik:111111119', '"ТЕСТ ГРУП" ЕООД', 1, -8),
    ];
    const db = fakeD1([
      { when: 'sqlite_master', first: { n: 2 } },
      { when: 'FROM search_index', all: rankedRows({ company: rows }) },
    ]).db;
    const company = (await search(db, 'тест груп')).groups.find((g) => g.kind === 'company')!;
    expect(company.hits.map((h) => h.title)).toEqual([
      '"ТЕСТ ГРУП" ЕООД', // exact name with a valid ЕИК, despite the weakest bm25
      'ТЕСТ ГРУП', // exact name, no ЕИК
      'ТЕСТ ГРУП ИНВЕСТ АД', // valid ЕИК
      'ТЕСТ ГРУП ЕООД и др.', // then bm25 order
      'ТЕСТ ГРУП 0 и др.',
      'ТЕСТ ГРУП 1 и др.',
    ]);
  });

  it('surfaces officials in „Лица", each with their office, its years and status by the one rule', async () => {
    const results = await search(searchDb(), 'иван');
    const official = results.groups.find((g) => g.kind === 'official');
    expect(official?.label).toBe('Лица');
    expect(official?.hits[0]).toMatchObject({
      kind: 'official',
      title: 'Иван Минев',
      subtitle: 'Бивш кмет · Община Тестово · 2018–2019',
      formerOfficial: true,
      amountLabel: 'по договори в периода на длъжността',
      href: `/persons/${personSlug('person:ИВАН МИНЕВ')}`,
    });
    // No filing on record: the index's own line stays, and nothing says the person left office.
    expect(official?.hits[1]?.subtitle).toBe('Министерство Х');
    expect(official?.hits[1]?.formerOfficial).toBeUndefined();
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

  it('shows every other person with a page in the same „Лица" group, after the officials', async () => {
    const results = await search(searchDb(-6, true, -5.5), 'мария');
    const kinds = results.groups.filter((g) => g.total > 0).map((g) => g.kind);
    expect(kinds[0]).toBe('official');
    expect(kinds).not.toContain('person');
    const people = results.groups.find((g) => g.kind === 'official')!;
    // The officials' list does not hold the other people, so there is no „виж всички" for the group.
    expect(people).toMatchObject({ label: 'Лица', total: 11, moreHref: null });
    expect(people.hits.map((h) => [h.kind, h.href, h.ident])).toEqual([
      ['official', `/persons/${personSlug('person:ИВАН МИНЕВ')}`, null],
      ['official', `/persons/${personSlug('person:ГЕОРГИ ПЕТРОВ')}`, null],
      ['person', `/persons/${'a'.repeat(64)}`, null],
      ['person', `/persons/${personSlug('person:МАРИЯ ПЕТРОВА|ОБЩИНА')}`, null],
    ]);
    // A registry-only person keeps the index's line (their companies); a declarant without filings too.
    expect(people.hits.slice(2).map((h) => h.subtitle)).toEqual(['АЛФА ООД', 'Кмет · Община']);
    // A weak match in both people kinds trails the other groups.
    const weak = await search(searchDb(-1, true, -1), 'мария');
    expect(weak.groups.filter((g) => g.total > 0).at(-1)?.kind).toBe('official');
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

function probeDb(tableCount: number | null): FakeD1 {
  return fakeD1([
    { when: 'sqlite_master', first: tableCount === null ? null : { n: tableCount } },
    {
      when: 'FROM search_index',
      all: rankedRows(
        { official: [OFFICIAL_HIT], company: [COMPANY_HIT] },
        { official: 2, company: 7 },
      ),
    },
  ]);
}

describe('search — свързани-лица migration probe and the single ranked read', () => {
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

  it("takes each group's total from the same read as its hits", async () => {
    // The count and the hits come from one statement, so they cannot disagree: a group with a total has its
    // top row, and „виж всички" counts what the read counted.
    const results = await search(probeDb(2).db, 'тест');
    const company = results.groups.find((g) => g.kind === 'company');
    expect(company).toMatchObject({ total: 7, hits: [{ title: 'ТЕСТ ООД' }] });
    expect(company!.moreHref).not.toBeNull();
  });

  it('reads the full-text index once per search, for every group', async () => {
    const fake = probeDb(2);
    await search(fake.db, 'тест');
    // Besides it: the migration probe, and the office lines of the declarants among the people.
    expect(fake.sql.filter((s) => s.includes('search_index'))).toHaveLength(1);
  });
});
