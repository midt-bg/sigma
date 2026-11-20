import { describe, expect, it } from 'vitest';
import type { FilterGroup } from '../components/FilterRail';
import { activeFilterState } from './active-filters';
import { buildSectorGroup, getMulti } from './filters';

// A filter the address applies but the rail has no option for must be visible and removable; a value the list
// cannot apply must be named as left out — never shown as a filter, never silently dropped.
const sp = (query: string) => new URLSearchParams(query);

// The groups as the list routes build them: `selected` from getMulti for a checkbox, the raw value for a radio.
function groups(params: URLSearchParams): FilterGroup[] {
  return [
    buildSectorGroup(
      [{ value: '45', label: 'Строителство', count: 10 }],
      getMulti(params, 'sector'),
    ),
    {
      key: 'year',
      label: 'Година',
      type: 'checkbox',
      selected: getMulti(params, 'year'),
      options: [
        { value: '2025', label: '2025', count: 5 },
        { value: '2024', label: '2024', count: 4 },
      ],
    },
    {
      key: 'value',
      label: 'Стойност (в евро)',
      type: 'radio',
      selected: params.get('value') ? [params.get('value')!] : [],
      options: [{ value: 'lt100k', label: 'Под 100 хил. €' }],
    },
    {
      key: 'eu',
      label: 'Финансиране от ЕС',
      type: 'radio',
      selected: params.get('eu') ? [params.get('eu')!] : [],
      options: [
        { value: 'eu', label: 'Само с финансиране от ЕС' },
        { value: 'national', label: 'Само без финансиране от ЕС' },
      ],
    },
  ];
}
const state = (query: string) => activeFilterState(sp(query), groups(sp(query)));
const href = (h: string) =>
  Object.fromEntries([...new URLSearchParams(h.replace(/^\?/, '')).entries()]);
const year = (s: ReturnType<typeof state>) => s.groups.find((g) => g.key === 'year')!;

describe('activeFilterState — a valid filter the rail has no option for', () => {
  it('shows ?year=1999 as an active filter, ticked in the rail, with a link that removes it', () => {
    const s = state('year=1999');
    expect(s.hidden).toEqual([
      { key: 'year', group: 'Година', value: '1999', label: '1999', removeHref: '' },
    ]);
    expect(s.ignored).toEqual([]);
    expect(year(s).selected).toEqual(['1999']);
    expect(year(s).options!.map((o) => o.value)).toEqual(['2025', '2024', '1999']);
  });

  it('removes only that value, keeping the other filters and the search, and starts again at page one', () => {
    const s = state(
      'q=мост&year=2025&year=1999&sector=45&sort=value-desc&cursor=after%3Axyz&page=3',
    );
    expect(s.hidden.map((f) => f.value)).toEqual(['1999']);
    const kept = new URLSearchParams(s.hidden[0]!.removeHref.slice(1));
    expect(kept.getAll('year')).toEqual(['2025']);
    expect(kept.get('sector')).toBe('45');
    expect(kept.get('q')).toBe('мост');
    expect(kept.get('sort')).toBe('value-desc');
    expect(kept.has('cursor')).toBe(false);
    expect(kept.has('page')).toBe(false);
  });

  it('reads comma-separated values and removes one of them only', () => {
    const s = state('year=1999,1998,2025');
    expect(s.hidden.map((f) => f.value)).toEqual(['1999', '1998']);
    expect(new URLSearchParams(s.hidden[0]!.removeHref.slice(1)).getAll('year')).toEqual([
      '1998',
      '2025',
    ]);
  });

  it('names a known sector the facets do not list, in a category of its own', () => {
    const s = state('sector=03');
    expect(s.hidden).toHaveLength(1);
    expect(s.hidden[0]!.label).toMatch(/\S/);
    const sector = s.groups.find((g) => g.key === 'sector')!;
    expect(sector.categories!.at(-1)).toMatchObject({
      label: 'Избрани извън списъка',
      options: [{ value: '03', label: s.hidden[0]!.label }],
    });
  });

  it('adds nothing when every applied value has its option', () => {
    const s = state('year=2025&sector=45&value=lt100k&eu=eu');
    expect(s.hidden).toEqual([]);
    expect(s.ignored).toEqual([]);
    expect(year(s).options).toHaveLength(2);
  });
});

describe('activeFilterState — a value the list cannot apply', () => {
  it('names an unsupported year as left out, not as a filter, and offers to drop it', () => {
    const s = state('year=abcd&sector=45');
    expect(s.hidden).toEqual([]);
    expect(s.ignored).toEqual([{ key: 'year', group: 'Година', removeHref: '?sector=45' }]);
    expect(year(s).selected).toEqual([]);
  });

  it('keeps the applied values when only one of them is unsupported', () => {
    const s = state('year=2025&year=abcd');
    expect(s.ignored).toHaveLength(1);
    expect(href(s.ignored[0]!.removeHref)).toEqual({ year: '2025' });
  });

  it('treats a radio value the list does not know as left out, so „all" stays ticked', () => {
    const s = state('value=xyz');
    expect(s.ignored.map((f) => f.key)).toEqual(['value']);
    expect(s.groups.find((g) => g.key === 'value')!.selected).toEqual([]);
  });

  it('applies the first of two radio values, as the loader does, and names the other as left out', () => {
    const s = state('eu=eu&eu=national');
    expect(s.groups.find((g) => g.key === 'eu')!.selected).toEqual(['eu']);
    expect(s.ignored).toEqual([{ key: 'eu', group: 'Финансиране от ЕС', removeHref: '?eu=eu' }]);
  });

  it('names the years past the cap as left out', () => {
    const many = Array.from({ length: 17 }, (_, i) => `year=${2000 + i}`).join('&');
    const s = state(many);
    expect(year(s).selected).toHaveLength(16);
    expect(s.ignored.map((f) => f.key)).toEqual(['year']);
  });

  it('never shows a parameter that is not a filter, and never carries it into a link', () => {
    const s = state('foo=bar&year=1999&utm_source=x');
    expect(s.hidden.map((f) => f.key)).toEqual(['year']);
    expect(s.ignored).toEqual([]);
    expect(s.hidden[0]!.removeHref).toBe('');
  });
});

describe('activeFilterState — an applied value the site has no name for', () => {
  it('shows ?kind=xyz as an active filter with no label, since the list does filter by it', () => {
    const params = sp('kind=xyz');
    const kind: FilterGroup = {
      key: 'kind',
      label: 'Вид субект',
      type: 'checkbox',
      selected: getMulti(params, 'kind'),
      options: [{ value: 'company', label: 'Дружество' }],
    };
    const s = activeFilterState(params, [kind]);
    expect(s.hidden).toEqual([
      { key: 'kind', group: 'Вид субект', value: 'xyz', label: null, removeHref: '' },
    ]);
    expect(s.groups[0]!.options!.at(-1)).toEqual({ value: 'xyz', label: 'непозната стойност' });
  });
});
