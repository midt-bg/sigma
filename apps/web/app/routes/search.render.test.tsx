// @vitest-environment jsdom
// The results page ends each group that has more matches with a „виж всички" link. Three of them on one
// page must not read as three identical links in a screen reader's link list.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { expect, it } from 'vitest';
import type { SearchHit, SearchResults } from '@sigma/api-contract';
import Search from './search';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hit = (kind: SearchHit['kind'], slug: string): SearchHit => ({
  kind,
  slug,
  href: `/x/${slug}`,
  title: 'ТЕСТ ГРУП ЕООД',
  ident: null,
  subtitle: null,
  amountEur: null,
  amountLabel: '',
});
const group = (kind: SearchHit['kind'], label: string, moreHref: string) => ({
  kind,
  label,
  total: 25,
  moreHref,
  hits: [hit(kind, `${kind}1`)],
});

it('names each „виж всички" link after its group', async () => {
  const results: SearchResults = {
    query: 'тест',
    empty: false,
    groups: [
      group('authority', 'Институции', '/authorities?q=тест'),
      group('company', 'Компании', '/companies?q=тест'),
      group('contract', 'Договори', '/contracts?q=тест'),
    ],
  };
  const Stub = createRoutesStub([
    { path: '/search', Component: Search, loader: () => ({ results }) },
  ]);
  const el = document.body.appendChild(document.createElement('div'));
  const root = createRoot(el);
  await act(async () => root.render(<Stub initialEntries={['/search?q=тест']} />));
  const more = [...el.querySelectorAll('.results-group .count a')].map((a) => a.textContent);
  expect(more).toEqual(['виж всички институции', 'виж всички компании', 'виж всички договори']);
  act(() => root.unmount());
  el.remove();
});
