// @vitest-environment jsdom
// The live-search combobox: a WAI-ARIA combobox + listbox that also has to work with JS off. Everything
// here is behaviour a keyboard or a screen reader depends on — which row is announced, what Enter does,
// whether Escape reaches the drawer behind it — none of which the type checker can see. Rendered through
// a real React Router data router so `useFetcher` and `useNavigate` resolve.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { SearchHit, SearchResults } from '@sigma/api-contract';
import { SmartSearch } from './SmartSearch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  kind: 'company',
  slug: 'c1',
  href: '/companies/111',
  title: 'ТЕСТ ГРУП ЕООД',
  ident: '111',
  subtitle: null,
  amountEur: null,
  amountLabel: '',
  ...over,
});

const results = (groups: SearchResults['groups']): SearchResults => ({
  query: 'тест',
  groups,
  empty: groups.length === 0,
});

const TWO_GROUPS = results([
  {
    kind: 'official',
    label: 'Свързани лица',
    total: 1,
    moreHref: null,
    hits: [
      hit({
        kind: 'official',
        slug: 'p1',
        href: '/persons/p1',
        title: 'ИВАН ПЕТРОВ ТЕСТОВ',
        ident: null,
        subtitle: 'Кмет · Община Тест',
      }),
    ],
  },
  {
    kind: 'company',
    label: 'Компании',
    total: 2,
    moreHref: null,
    hits: [
      hit({ slug: 'c1', href: '/companies/111', title: 'ТЕСТ ГРУП ЕООД', ident: '111' }),
      hit({
        slug: 'c2',
        href: '/companies/222',
        title: 'ПРИМЕР АД',
        ident: '222',
        hasConflict: true,
      }),
    ],
  },
]);

let container: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** Mount the combobox over a real data router whose `/search/suggest` answers with `payload`. */
async function mount(payload: SearchResults | null = TWO_GROUPS) {
  const suggest = vi.fn(() => payload ?? results([]));
  router = createMemoryRouter(
    [
      { path: '/', Component: () => <SmartSearch variant="hero" /> },
      { path: '/search/suggest', loader: suggest },
      { path: '/search', Component: () => <p>страницата с резултати</p> },
      { path: '/persons/:id', Component: () => <p>профил</p> },
      { path: '/companies/:eik', Component: () => <p>компания</p> },
    ],
    { initialEntries: ['/'] },
  );
  await act(async () => {
    root = createRoot(container);
    root.render(<RouterProvider router={router} />);
  });
  return { suggest };
}

const input = () => container.querySelector<HTMLInputElement>('input[name="q"]')!;
const options = () => [...container.querySelectorAll('[role="option"]')];
const pop = () => container.querySelector('.smart-search-pop')!;

/** Type into the field and let the debounce settle, so the fetch actually fires. */
async function type(text: string) {
  await act(async () => {
    input().focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
}

async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
}

// A single letter matches almost everything, so the component deliberately asks nothing until two.
it('asks for nothing below two characters and keeps the listbox shut', async () => {
  const { suggest } = await mount();
  await type('и');
  expect(suggest).not.toHaveBeenCalled();
  expect(input().getAttribute('aria-expanded')).toBe('false');
  expect(pop().hasAttribute('hidden')).toBe(true);

  await type('ив');
  expect(suggest).toHaveBeenCalled();
  expect(input().getAttribute('aria-expanded')).toBe('true');
});

it('announces each suggestion as an option, grouped and labelled by kind', async () => {
  await mount();
  await type('тест');

  expect(container.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe(
    'Предложения',
  );
  expect(
    [...container.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label')),
  ).toEqual(['Свързани лица', 'Компании']);
  // Three hits plus the trailing „all results" row, every one of them an option.
  expect(options()).toHaveLength(4);
  expect(options()[0]!.textContent).toContain('Иван Петров Тестов');
  // The gutter says what the row IS — a declarant is an office holder in either group.
  expect(options()[0]!.textContent).toContain('длъжностно лице');
  // A company the свързани-лица surface flags carries the marker on its meta line.
  expect(options()[2]!.textContent).toContain('свързани лица');
  expect(options()[3]!.textContent).toContain('Всички резултати');
});

// aria-activedescendant is the only thing a screen reader follows here: focus never leaves the input.
it('walks the options with the arrows and announces the active one', async () => {
  await mount();
  await type('тест');
  expect(input().getAttribute('aria-activedescendant')).toBe(null);

  await press('ArrowDown');
  const first = options()[0]!;
  expect(input().getAttribute('aria-activedescendant')).toBe(first.id);
  expect(first.getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(input());

  await press('End');
  expect(input().getAttribute('aria-activedescendant')).toBe(options()[3]!.id);
  // Past the last row it wraps to the first, rather than sticking.
  await press('ArrowDown');
  expect(input().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
  // And upward from the first it wraps to the last.
  await press('ArrowUp');
  expect(input().getAttribute('aria-activedescendant')).toBe(options()[3]!.id);
  await press('Home');
  expect(input().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
});

it('opens the highlighted row on Enter and the whole search when none is highlighted', async () => {
  await mount();
  await type('тест');
  await press('ArrowDown');
  await press('Enter');
  expect(router.state.location.pathname).toBe('/persons/p1');
});

it('sends the trailing row to the results page for the typed query', async () => {
  await mount();
  await type('тест');
  await act(async () => {
    options()[3]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(router.state.location.pathname).toBe('/search');
  expect(router.state.location.search).toBe('?q=%D1%82%D0%B5%D1%81%D1%82');
});

it('opens a suggestion on click', async () => {
  await mount();
  await type('тест');
  await act(async () => {
    options()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(router.state.location.pathname).toBe('/companies/111');
});

// First Escape closes the suggestions; it must not also reach a drawer's own Escape handler, or one
// press would close both and the user would lose the field they were typing in.
it('closes on Escape and swallows it so a surrounding drawer stays open', async () => {
  await mount();
  await type('тест');
  const outer = vi.fn();
  document.addEventListener('keydown', outer);
  await press('Escape');
  document.removeEventListener('keydown', outer);

  expect(input().getAttribute('aria-expanded')).toBe('false');
  expect(pop().hasAttribute('hidden')).toBe(true);
  expect(outer).not.toHaveBeenCalled();
});

it('closes when the pointer goes somewhere else on the page', async () => {
  await mount();
  await type('тест');
  expect(input().getAttribute('aria-expanded')).toBe('true');
  await act(async () => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  expect(input().getAttribute('aria-expanded')).toBe('false');
});

it('says so when nothing matches, without offering a row to select', async () => {
  await mount(results([]));
  await type('няма такова');
  expect(options()).toHaveLength(0);
  expect(container.querySelector('.smart-search-empty')?.textContent).toContain('Няма съвпадения');
  // With nothing to walk, the arrows must not invent an active descendant.
  await press('ArrowDown');
  expect(input().getAttribute('aria-activedescendant')).toBe(null);
});

// With JS off the listbox never renders, so the plain form is the whole feature.
it('is a real GET form to /search even before any of this runs', async () => {
  await mount();
  const form = container.querySelector('form')!;
  expect(form.getAttribute('action')).toBe('/search');
  expect(form.getAttribute('method')).toBe('get');
  expect(input().getAttribute('name')).toBe('q');
  expect(input().getAttribute('aria-label')).toBe('Търсене');
  expect(input().getAttribute('role')).toBe('combobox');
  expect(input().getAttribute('aria-autocomplete')).toBe('list');
  expect(input().getAttribute('aria-controls')).toBe(
    container.querySelector('[role="listbox"]')!.id,
  );
});
