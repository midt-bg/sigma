import { describe, expect, it } from 'vitest';
import { CPV_SECTORS } from '@sigma/config';
import {
  authorityListFilters,
  buildSectorGroup,
  companyListFilters,
  contractListFilters,
  getMulti,
  leaderboardRankOffset,
  MAX_MULTI_VALUES,
  pageNav,
  PARAM_ORDER,
  searchHref,
  singleSelectFilters,
  sortHref,
  withParams,
} from './filters';
import { categoryForDivision } from '@sigma/config';
import { CANONICAL_QUERY_PARAMS } from './query-params';

const sp = (q: string) => new URLSearchParams(q);

describe('contractListFilters', () => {
  it('parses the bids filter the HTML list and CSV export must share (issue #138)', () => {
    const sp = new URLSearchParams('bids=1&year=2025&authority=123');
    const f = contractListFilters(sp);
    expect(f.bids).toBe('one');
    expect(f.years).toEqual(['2025']);
    expect(f.authority).toBe('123');
  });

  it('leaves bids null when the param is absent or not "1"', () => {
    expect(contractListFilters(new URLSearchParams('')).bids).toBeNull();
    expect(contractListFilters(new URLSearchParams('bids=two')).bids).toBeNull();
  });

  it('normalises an unknown sort to the default rather than passing it through', () => {
    expect(contractListFilters(new URLSearchParams('sort=bogus')).sort).toBe('value-desc');
  });
});

describe('authorityListFilters', () => {
  it('parses the same filter set the HTML list and CSV export must share (#138)', () => {
    const f = authorityListFilters(
      new URLSearchParams('type=municipality&sector=45&year=2025&eu=eu&q=път'),
    );
    expect(f).toMatchObject({
      types: ['municipality'],
      sectors: ['45'],
      years: ['2025'],
      eu: 'eu',
      q: 'път',
    });
  });
});

describe('companyListFilters', () => {
  it('parses the same filter set the HTML list and CSV export must share (#138)', () => {
    const f = companyListFilters(
      new URLSearchParams('kind=company&count=2-5&sector=45&year=2025&eu=national&q=строителство'),
    );
    expect(f).toMatchObject({
      kinds: ['company'],
      countBucket: '2-5',
      sectors: ['45'],
      years: ['2025'],
      eu: 'national',
      q: 'строителство',
    });
  });

  it('normalises an unknown sort to the default rather than passing it through', () => {
    expect(companyListFilters(new URLSearchParams('sort=bogus')).sort).toBe('won');
  });
});

describe('getMulti', () => {
  it('caps repeated and CSV multi-value params', () => {
    const params = new URLSearchParams();
    params.set('kind', Array.from({ length: 100 }, (_, i) => `k${i}`).join(','));

    const values = getMulti(params, 'kind');

    expect(values).toHaveLength(MAX_MULTI_VALUES);
    expect(values.length).toBeLessThanOrEqual(50);
  });

  it('preserves outlier year values while capping floods', () => {
    const params = new URLSearchParams();
    params.set('year', ['2016', ...Array.from({ length: 100 }, (_, i) => `y${i}`)].join(','));

    const years = getMulti(params, 'year');

    expect(years).toContain('2016');
    expect(years).toHaveLength(MAX_MULTI_VALUES);
    expect(years.length).toBeLessThanOrEqual(50);
  });

  it('drops invalid oversized sector values before they reach SQL filters', () => {
    const params = new URLSearchParams();
    params.set('sector', Array.from({ length: 120 }, (_, i) => String(i + 1)).join(','));
    const sectors = getMulti(params, 'sector');

    expect(sectors.length).toBeLessThanOrEqual(MAX_MULTI_VALUES);
    expect(sectors.every((sector) => CPV_SECTORS.some((known) => known.code === sector))).toBe(
      true,
    );
  });

  it('keeps only known sectors and preserves years in shared company params', () => {
    const params = new URLSearchParams();
    const knownSector = CPV_SECTORS[0]!.code;
    params.set('sector', `${knownSector},99`);
    params.set('year', '2024,2016,unknown');
    params.set('eu', 'eu');

    expect(companyListFilters(params)).toMatchObject({
      sectors: [knownSector],
      years: ['2024', '2016', 'unknown'],
      eu: 'eu',
    });
  });
});

describe('searchHref', () => {
  it('sets q and resets cursor/page while preserving filters and sort', () => {
    const sp = new URLSearchParams('sort=name&year=2024&cursor=abc&page=3&sector=45');
    const out = new URLSearchParams(searchHref(sp, 'mostove'));

    expect(out.get('q')).toBe('mostove');
    expect(out.get('sort')).toBe('name');
    expect(out.getAll('year')).toEqual(['2024']);
    expect(out.get('sector')).toBe('45');
    expect(out.has('cursor')).toBe(false);
    expect(out.has('page')).toBe(false);
  });

  it('drops q when the query is empty or whitespace-only', () => {
    const sp = new URLSearchParams('q=old&sort=won');
    expect(new URLSearchParams(searchHref(sp, '')).has('q')).toBe(false);
    expect(new URLSearchParams(searchHref(sp, '   ')).has('q')).toBe(false);
  });

  it('trims surrounding whitespace from q', () => {
    expect(new URLSearchParams(searchHref(new URLSearchParams(), '  foo  ')).get('q')).toBe('foo');
  });

  it('emits q first in canonical order', () => {
    expect(searchHref(new URLSearchParams('sort=name'), 'x')).toBe('?q=x&sort=name');
  });

  it('preserves repeated multi-value params', () => {
    const sp = new URLSearchParams();
    sp.append('year', '2024');
    sp.append('year', '2023');
    sp.set('sector', '45');

    expect(new URLSearchParams(searchHref(sp, 'q')).getAll('year')).toEqual(['2024', '2023']);
  });

  it('preserves unknown keys not in PARAM_ORDER (e.g. contracts bids)', () => {
    const sp = new URLSearchParams('bids=1&sort=value-desc');
    expect(new URLSearchParams(searchHref(sp, 'q')).get('bids')).toBe('1');
  });
});

describe('leaderboardRankOffset', () => {
  it('continues rank numbering across paged keyset results', () => {
    expect(leaderboardRankOffset(1, 25)).toBe(0);
    expect(leaderboardRankOffset(2, 25)).toBe(25);
    expect(leaderboardRankOffset(3, 15)).toBe(30);
  });
});

describe('pageNav', () => {
  it('starts at page 1 with no cursor and offers no Prev', () => {
    const nav = pageNav({
      base: sp(''),
      total: 17504,
      pageSize: 25,
      nextCursor: 'after:x',
      prevCursor: null,
    });
    expect(nav.page).toBe(1);
    expect(nav.pageCount).toBe(701);
    expect(nav.prevHref).toBeNull();
    expect(nav.nextHref).not.toBeNull();
  });

  it('disables Next on the true last page (cursor exhausted) but keeps Prev live', () => {
    // total 17504 / 25 = 701 pages; on page 701 the keyset emits no nextCursor. Prev must survive
    // (AC: no regression to keyset Prev/Next, #53).
    const nav = pageNav({
      base: sp('cursor=after:z&page=701'),
      total: 17504,
      pageSize: 25,
      nextCursor: null,
      prevCursor: 'before:z',
    });
    expect(nav.page).toBe(701);
    expect(nav.pageCount).toBe(701);
    expect(nav.nextHref).toBeNull();
    expect(nav.prevHref).not.toBeNull();
  });

  it('keeps Next enabled mid-list while real rows and display pages remain', () => {
    const nav = pageNav({
      base: sp('cursor=after:m&page=3'),
      total: 17504, // 701 pages
      pageSize: 25,
      nextCursor: 'after:n',
      prevCursor: 'before:n',
    });
    expect(nav.page).toBe(3);
    expect(nav.nextHref).not.toBeNull();
    expect(nav.prevHref).not.toBeNull();
  });

  it('keeps Next enabled on the penultimate page (guards against gating one page too early)', () => {
    // page === pageCount - 1: a regression to `page <= pageCount` would wrongly disable Next here.
    const nav = pageNav({
      base: sp('cursor=after:p&page=700'),
      total: 17504, // pageCount 701
      pageSize: 25,
      nextCursor: 'after:q',
      prevCursor: 'before:q',
    });
    expect(nav.page).toBe(700);
    expect(nav.pageCount).toBe(701);
    expect(nav.nextHref).not.toBeNull();
  });

  // AC (verbatim): «Следваща» се деактивира на показаната последна страница — Next disables on the
  // shown last page; nextHref == null when page >= pageCount.
  it('disables Next once the page marker reaches pageCount even while a cursor remains (#87)', () => {
    // ?page drift: the marker has reached the displayed last page (700) but the keyset still emits a
    // nextCursor. Next must be gated off so the counter and rank cannot freeze while it keeps walking.
    const nav = pageNav({
      base: sp('cursor=after:row17500&page=700'),
      total: 17500, // ceil(17500 / 25) = 700 → pageCount 700
      pageSize: 25,
      nextCursor: 'after:row17525',
      prevCursor: 'before:row17476',
    });
    expect(nav.page).toBe(700); // page >= pageCount
    expect(nav.pageCount).toBe(700);
    expect(nav.nextHref).toBeNull(); // gated off despite a live cursor
    // Rank reflects the shown last page (contiguous), never a frozen/contradictory offset.
    expect(leaderboardRankOffset(nav.page, 25)).toBe(17475);
  });

  it('never shows an impossible "N от M" or re-enables Next for a stale/oversized ?page', () => {
    // A hand-edited or stale ?page far beyond the end clamps to pageCount and stays disabled.
    const nav = pageNav({
      base: sp('cursor=after:x&page=99999'),
      total: 17500,
      pageSize: 25,
      nextCursor: 'after:y',
      prevCursor: 'before:y',
    });
    expect(nav.page).toBe(700);
    expect(nav.page).toBeLessThanOrEqual(nav.pageCount);
    expect(nav.nextHref).toBeNull();
  });

  it('keeps the displayed page within [1, pageCount] for hostile or absent ?page values', () => {
    for (const q of [
      'cursor=after:x&page=0',
      'cursor=after:x&page=-9',
      'cursor=after:x&page=abc',
    ]) {
      const nav = pageNav({
        base: sp(q),
        total: 100,
        pageSize: 25,
        nextCursor: 'after:y',
        prevCursor: 'before:y',
      });
      expect(nav.page).toBe(1);
      expect(nav.page).toBeLessThanOrEqual(nav.pageCount);
    }
  });

  it('floors a non-integer ?page so the counter and rank offset stay integers', () => {
    // ?page=1.5 would otherwise render "Страница 1.5 от M" and a fractional rank offset (12.5).
    const nav = pageNav({
      base: sp('cursor=after:x&page=1.5'),
      total: 100,
      pageSize: 25,
      nextCursor: 'after:y',
      prevCursor: 'before:y',
    });
    expect(nav.page).toBe(1);
    expect(Number.isInteger(nav.page)).toBe(true);
    expect(leaderboardRankOffset(nav.page, 25)).toBe(0);
  });

  it('advances the rank offset monotonically across normal deep paging', () => {
    // Within the valid range the counter and rank track the cursor 1:1 — neither freezes.
    const offsets = [698, 699, 700].map((p) => {
      const nav = pageNav({
        base: sp(`cursor=after:c&page=${p}`),
        total: 17500, // pageCount 700
        pageSize: 25,
        nextCursor: 'after:next',
        prevCursor: 'before:prev',
      });
      return leaderboardRankOffset(nav.page, 25);
    });
    expect(offsets).toEqual([17425, 17450, 17475]);
  });

  it('handles an empty result set without enabling Next', () => {
    const nav = pageNav({
      base: sp(''),
      total: 0,
      pageSize: 25,
      nextCursor: null,
      prevCursor: null,
    });
    expect(nav.page).toBe(1);
    expect(nav.pageCount).toBe(1); // Math.max(1, …) floor → "Страница 1 от 1"
    expect(nav.nextHref).toBeNull();
    expect(nav.prevHref).toBeNull();
  });

  it('gates Next at the last page for the contracts page size (15), not just 25', () => {
    // The deepest list (/contracts) paginates 15/page; pageNav is size-agnostic, so prove the bound.
    const last = pageNav({
      base: sp('cursor=after:c&page=4'),
      total: 60, // ceil(60 / 15) = 4 pages
      pageSize: 15,
      nextCursor: 'after:more',
      prevCursor: 'before:c',
    });
    expect(last.page).toBe(4);
    expect(last.pageCount).toBe(4);
    expect(last.nextHref).toBeNull();

    const mid = pageNav({
      base: sp('cursor=after:c&page=3'),
      total: 60,
      pageSize: 15,
      nextCursor: 'after:more',
      prevCursor: 'before:c',
    });
    expect(mid.nextHref).not.toBeNull();
  });
});

describe('withParams', () => {
  it('drops unknown params — including repeated ones — so none can ride a link into the edge cache (#197)', () => {
    expect(withParams(sp('sort=value-desc&x=poison'), {})).toBe('?sort=value-desc');
    expect(withParams(sp('sector=45&x=1&x=2&sort=value-desc&utm_source=ad'), {})).toBe(
      '?sector=45&sort=value-desc',
    );
  });

  it('preserves and canonically orders known params regardless of input order', () => {
    expect(withParams(sp('sort=value-desc&year=2024&q=test'), {})).toBe(
      '?q=test&year=2024&sort=value-desc',
    );
  });

  it('applies overrides and drops keys set to null or empty', () => {
    expect(withParams(sp('sort=value-desc&cursor=c5&page=3'), { cursor: null, page: null })).toBe(
      '?sort=value-desc',
    );
    expect(withParams(sp('q=old'), { q: 'new' })).toBe('?q=new');
    expect(withParams(sp('q=test&sort=value-desc'), { q: '' })).toBe('?sort=value-desc');
  });

  it('orders only known params — every PARAM_ORDER key is canonical', () => {
    // The invariant behind the filter: a key ordered but not in the allow-list would be silently
    // dropped from every generated link.
    expect(PARAM_ORDER.filter((key) => !CANONICAL_QUERY_PARAMS.has(key))).toEqual([]);
  });
});

describe('singleSelectFilters', () => {
  const known = CPV_SECTORS[0]!.code;

  it('passes through a valid sector, year, funding, and top', () => {
    const f = singleSelectFilters(sp(`sector=${known}&year=2024&funding=eu&top=50`), [
      '2024',
      '2023',
    ]);
    expect(f).toMatchObject({
      sector: known,
      year: '2024',
      funding: 'eu',
      top: 50,
      unknownSector: false,
      unknownYear: false,
    });
  });

  it('flags and drops an unknown sector', () => {
    const f = singleSelectFilters(sp('sector=ZZ'));
    expect(f.sector).toBeNull();
    expect(f.unknownSector).toBe(true);
  });

  it('flags and drops a year outside the coverage window', () => {
    const f = singleSelectFilters(sp('year=1999'), ['2024', '2023']);
    expect(f.year).toBeNull();
    expect(f.unknownYear).toBe(true);
  });

  it('never flags a year when no coverage window is supplied', () => {
    const f = singleSelectFilters(sp('year=1999')); // years=[] → unknownYear always false
    expect(f.unknownYear).toBe(false);
    expect(f.year).toBe('1999');
  });

  it('defaults funding to „all" and top to 20, and keeps national', () => {
    expect(singleSelectFilters(sp('')).funding).toBe('all');
    expect(singleSelectFilters(sp('funding=bogus&top=99')).top).toBe(20);
    expect(singleSelectFilters(sp('funding=national')).funding).toBe('national');
  });
});

describe('buildSectorGroup', () => {
  const withCat = CPV_SECTORS.filter((s) => categoryForDivision(s.code));

  it('groups facet sectors under their CPV category and sums present counts', () => {
    const a = withCat[0]!;
    const group = buildSectorGroup([{ value: a.code, label: a.label, count: 3 }], [a.code]);
    expect(group.key).toBe('sector');
    expect(group.type).toBe('checkbox');
    expect(group.selected).toEqual([a.code]);
    const cat = group.categories!.find((c) => c.options.some((o) => o.value === a.code))!;
    expect(cat.count).toBe(3); // all option counts present → category count summed
    expect(cat.options.find((o) => o.value === a.code)).toMatchObject({ label: a.label, count: 3 });
  });

  it('omits the category count when any sector count is missing', () => {
    const a = withCat[0]!;
    const group = buildSectorGroup([{ value: a.code, label: a.label }], []); // no count
    const cat = group.categories!.find((c) => c.options.some((o) => o.value === a.code))!;
    expect(cat.count).toBeUndefined();
    expect(cat.options.find((o) => o.value === a.code)!.count).toBeUndefined();
  });

  it('skips a facet sector with no CPV category', () => {
    const group = buildSectorGroup([{ value: 'ZZ', label: 'Bogus', count: 1 }], []);
    expect(group.categories!.every((c) => c.options.every((o) => o.value !== 'ZZ'))).toBe(true);
  });
});

describe('sortHref', () => {
  it('swaps the sort and resets the cursor/page to page one', () => {
    expect(sortHref(sp('sort=old&cursor=abc&page=3'), 'value-asc')).toBe('?sort=value-asc');
  });
});

describe('filters — remaining branch coverage', () => {
  it('authorityListFilters leaves eu null when the param is absent', () => {
    expect(authorityListFilters(sp('type=x')).eu).toBeNull();
  });

  it('withParams drops null overrides and appends array values, skipping empty elements', () => {
    expect(withParams(sp('sort=x'), { sort: null })).toBe(''); // null override → dropped
    expect(withParams(sp(''), { year: ['2024', '', '2023'] })).toBe('?year=2024&year=2023');
  });

  it('withParams drops an empty-valued base param and returns "" when nothing survives', () => {
    expect(withParams(sp('year='), {})).toBe('');
  });

  it('pageNav defaults the display page when the cursor is present but page is missing or NaN', () => {
    const nav = (q: string) =>
      pageNav({ base: sp(q), total: 100, pageSize: 25, nextCursor: 'n', prevCursor: 'p' });
    expect(nav('cursor=x').page).toBe(1); // page absent → ?? '1'
    expect(nav('cursor=x&page=abc').page).toBe(1); // NaN → || 1
  });
});
