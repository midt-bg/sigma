// @vitest-environment jsdom
// The /search results page: the empty, no-match and matched states, every badge and meta line a hit can
// carry, the highlighted query terms, and the „виж всички" link that ends a group with more matches —
// three of them on one page must not read as three identical links in a screen reader's link list.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchHit, SearchResults } from '@sigma/api-contract';

const search = vi.fn();
vi.mock('@sigma/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sigma/db')>()),
  getDb: () => ({}),
  search: (...args: unknown[]) => search(...args),
}));
const { default: Search, loader, meta } = await import('./search');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  kind: 'company',
  slug: 'c1',
  href: '/companies/111',
  title: 'ТЕСТ ГРУП ЕООД',
  ident: null,
  subtitle: null,
  amountEur: null,
  amountLabel: '',
  ...over,
});
const group = (kind: SearchHit['kind'], label: string, hits: SearchHit[], more?: string) => ({
  kind,
  label,
  total: more ? 25 : hits.length,
  moreHref: more ?? null,
  hits,
});

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  el = document.body.appendChild(document.createElement('div'));
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
});

async function render(results: SearchResults) {
  const Stub = createRoutesStub([
    { path: '/search', Component: Search, loader: () => ({ results, typed: results.query }) },
  ]);
  await act(async () => root.render(<Stub initialEntries={['/search']} />));
  return el;
}

// Through the real loader: what the visitor typed, and what was searched.
async function renderUrl(url: string) {
  const Stub = createRoutesStub([
    {
      path: '/search',
      Component: Search,
      loader: (args) => loader({ ...args, context: { cloudflare: { env: {} } } } as never),
    },
  ]);
  await act(async () => root.render(<Stub initialEntries={[url]} />));
  return el;
}

describe('/search', () => {
  it('caps and normalises the query before it reaches the database', async () => {
    search.mockResolvedValue({ query: 'тест', groups: [], empty: true });
    const out = await loader({
      request: new Request('http://x/search?q=Тест+групи'),
      context: { cloudflare: { env: {} } },
    } as Parameters<typeof loader>[0]);
    expect(search).toHaveBeenCalledWith({}, 'тест групи');
    expect(out.results.query).toBe('тест');
  });

  it('titles the page after the query, and plainly without one', () => {
    const title = (q?: string) =>
      (
        meta({ data: q == null ? undefined : { results: { query: q }, typed: q } } as Parameters<
          typeof meta
        >[0])[0] as { title: string }
      ).title;
    expect(title('тест')).toBe('Търсене: „тест“ — СИГМА');
    expect(title()).toBe('Търсене — СИГМА');
  });

  it('describes what it covers when there is no query yet', async () => {
    const c = await render({ query: '', groups: [], empty: true });
    expect(c.querySelector('h1')!.textContent).toBe('Търсене');
    expect(c.querySelector('.results-group')).toBeNull();
    expect(c.querySelector('h2.sr-only')!.textContent).toBe('Помощ при търсене');
  });

  it('says so when nothing matched, and spells out the identifiers it suggests', async () => {
    const c = await render({ query: 'няма', groups: [], empty: true });
    const p = c.querySelector('p.muted')!;
    expect(p.textContent).toBe('Нищо не намерихме за „няма“. Пробвай с име, ЕИК или УНП.');
    expect([...p.querySelectorAll('abbr')].map((a) => a.title)).toEqual([
      'Единен идентификационен код',
      'Уникален номер на преписката',
    ]);
  });

  it('names each „виж всички" link after its group', async () => {
    const c = await render({
      query: 'тест',
      empty: false,
      groups: [
        group('authority', 'Институции', [hit({ kind: 'authority' })], '/authorities?q=тест'),
        group('company', 'Компании', [hit()], '/companies?q=тест'),
        group('contract', 'Договори', [hit({ kind: 'contract' })], '/contracts?q=тест'),
      ],
    });
    const more = [...c.querySelectorAll('.results-group .count a')].map((a) => a.textContent);
    expect(more).toEqual(['виж всички институции', 'виж всички компании', 'виж всички договори']);
    expect(c.querySelector('.results-group .count')!.textContent).toContain('първите 1 от 25');
  });

  it('marks the query terms and shows what each kind of hit carries', async () => {
    const c = await render({
      query: 'тест',
      empty: false,
      groups: [
        group('company', 'Компании', [
          hit({ ident: '111', subtitle: 'Тестово', amountEur: 1000, amountLabel: 'спечелено' }),
          hit({ slug: 'c2', isConsortium: true, memberCount: 2, ownershipKind: 'state' }),
          hit({ slug: 'c3', hasEik: false, hasConflict: true }),
        ]),
        group('contract', 'Договори', [
          hit({ kind: 'contract', slug: 'k1', ident: '00001-2024-0001', subtitle: 'Тест' }),
          hit({ kind: 'contract', slug: 'k2' }),
        ]),
        group('official', 'Свързани лица', [
          hit({ kind: 'person', slug: 'p1', title: 'ИВАН ПЕТРОВ ТЕСТОВ' }),
        ]),
        group('authority', 'Институции', []),
      ],
    });
    const cards = [...c.querySelectorAll<HTMLAnchorElement>('a.result')];
    expect(cards).toHaveLength(6);
    expect(cards[0]!.querySelector('mark')!.textContent).toBe('ТЕСТ');
    expect(cards[0]!.querySelector('.meta')!.textContent).toBe('ЕИК 111 · Тестово');
    expect(cards[0]!.querySelector('.amt')!.textContent).toContain('спечелено');
    expect(cards[1]!.textContent).toContain('съвместни изпълнители');
    expect(cards[1]!.querySelector('.meta')!.textContent).toBe('2 участника');
    expect(cards[2]!.textContent).toContain('без ЕИК');
    expect(cards[2]!.textContent).toContain('свързани лица');
    expect(cards[3]!.querySelector('.meta')!.textContent).toBe('УНП 00001-2024-0001 · Тест');
    expect(cards[4]!.querySelector('.meta')!.textContent).toBe('');
    expect(cards[4]!.querySelector('.amt .num')!.textContent).toBe('—');
    expect(cards[5]!.textContent).toContain('Иван Петров Тестов');
    expect(cards[5]!.querySelector('.amt')).toBeNull();
    // An empty group is not shown at all.
    expect(c.querySelectorAll('.results-group')).toHaveLength(3);
  });

  describe('typed vs searched query', () => {
    beforeEach(() => {
      search.mockImplementation(async (_db: unknown, query: string): Promise<SearchResults> => ({
        query,
        groups: [],
        empty: true,
      }));
    });
    const input = () => el.querySelector<HTMLInputElement>('#page-query')!;

    it('keeps the typed text and states the normalised terms', async () => {
      await renderUrl(`/search?q=${encodeURIComponent('Ремонт, на ПЪТ 5 А')}`);
      expect(search).toHaveBeenCalledWith(expect.anything(), 'ремонт на път');
      expect(input().value).toBe('Ремонт, на ПЪТ 5 А');
      expect(el.querySelector('h1')!.textContent).toBe('Ремонт, на ПЪТ 5 А');
      expect(el.textContent).toContain('Търсено по думите: „ремонт на път“');
    });

    it('adds no note when only letter case differs', async () => {
      await renderUrl('/search?q=%D0%9C%D0%BE%D1%81%D1%82');
      expect(input().value).toBe('Мост');
      expect(el.textContent).not.toContain('Търсено по думите');
    });

    it('asks for two characters when nothing searchable remains', async () => {
      await renderUrl('/search?q=a');
      expect(input().value).toBe('a');
      expect(el.querySelector('h1')!.textContent).toBe('Търсене');
      expect(el.textContent).toContain('Въведи поне две букви или цифри.');
    });

    it('titles the page by the typed query', () => {
      const title = meta({
        data: { typed: 'Мост', results: { query: 'мост', groups: [], empty: true } },
      } as never)[0] as { title: string };
      expect(title.title).toBe('Търсене: „Мост“ — СИГМА');
    });
  });
});
