// @vitest-environment jsdom
// Keyset paging renders a LINK when a neighbouring page exists and a disabled SPAN when it does not — the
// only two states, and the page-level render tests only ever hit whichever one their fixture happens to be
// on. The disabled arm matters on its own: a <Link to={null}> would either throw or navigate to the current
// URL, and a bare <span> without aria-disabled reads to a screen reader as unlabelled text.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import { Pagination } from './Pagination';
import type { PageNav } from '../lib/filters';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(nav: PageNav, unit?: string) {
  const Stub = createRoutesStub([
    { path: '/', Component: () => <Pagination nav={nav} pageSize={20} unit={unit} /> },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/']} />);
  });
}

const nav = (over: Partial<PageNav> = {}): PageNav => ({
  page: 2,
  pageCount: 5,
  prevHref: '/x?page=1',
  nextHref: '/x?page=3',
  ...over,
});

describe('Pagination', () => {
  it('links both neighbours from a middle page, with rel hints', async () => {
    await render(nav());
    const prev = container.querySelector('a[rel="prev"]') as HTMLAnchorElement;
    const next = container.querySelector('a[rel="next"]') as HTMLAnchorElement;
    expect(prev.getAttribute('href')).toBe('/x?page=1');
    expect(next.getAttribute('href')).toBe('/x?page=3');
    expect(container.querySelector('.disabled')).toBeNull();
  });

  it('renders an aria-disabled span instead of a link at each end of the range', async () => {
    await render(nav({ page: 1, prevHref: null }));
    expect(container.querySelector('a[rel="prev"]')).toBeNull();
    expect(container.querySelector('.disabled')!.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector('a[rel="next"]')).not.toBeNull();

    await render(nav({ page: 5, nextHref: null }));
    expect(container.querySelector('a[rel="next"]')).toBeNull();
    expect(container.querySelector('.disabled')!.textContent).toContain('Следваща');
  });

  it('appends the unit only when one is given', async () => {
    await render(nav(), 'договора');
    expect(container.textContent).toContain('по 20 на страница (договора)');

    await render(nav());
    expect(container.textContent).toContain('по 20 на страница');
    expect(container.textContent).not.toContain('()');
  });
});
