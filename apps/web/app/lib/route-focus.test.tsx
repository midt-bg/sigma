// @vitest-environment jsdom
// After a client-side navigation focus moves to the new page's <h1>. Paging (a new cursor/page under the
// same pathname) counts as a navigation and is announced with the pager's „Страница N от M" line; a filter
// or sort change (query only, no paging) leaves focus where it is.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, Link, Outlet, RouterProvider, useSearchParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRouteFocus } from './route-focus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;

function Shell() {
  const announcement = useRouteFocus();
  return (
    <>
      <Outlet />
      <p data-testid="live" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}

function List() {
  const [sp] = useSearchParams();
  const page = Number(sp.get('page') ?? 1);
  return (
    <main id="main">
      <h1>Договори</h1>
      <Link to="?sector=45">Филтър</Link>
      <nav className="paging">
        <div className="paging-status">
          Страница <strong>{page}</strong> от <strong>9</strong>
        </div>
        <Link to={`?cursor=c${page + 1}&page=${page + 1}`} rel="next">
          Следваща ›
        </Link>
      </nav>
    </main>
  );
}

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    cb(0);
    return 0;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  router = createMemoryRouter(
    [
      {
        Component: Shell,
        children: [
          { path: '/contracts', Component: List },
          { path: '/companies', Component: () => <h1>Компании</h1> },
        ],
      },
    ],
    { initialEntries: ['/contracts'] },
  );
  act(() => root.render(<RouterProvider router={router} />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  router.dispose();
  vi.restoreAllMocks();
});

const live = () => container.querySelector('[data-testid="live"]')!.textContent;
const next = () => container.querySelector<HTMLAnchorElement>('a[rel="next"]')!;

describe('useRouteFocus', () => {
  it('leaves the first render alone', () => {
    expect(document.activeElement).toBe(document.body);
    expect(live()).toBe('');
  });

  it('moves focus to the heading and announces the page after Prev/Next', async () => {
    next().focus();
    await act(() => router.navigate('/contracts?cursor=c2&page=2'));
    expect(document.activeElement).toBe(container.querySelector('h1'));
    expect(live()).toBe('Страница 2 от 9');

    next().focus();
    await act(() => router.navigate('/contracts?cursor=c3&page=3'));
    expect(document.activeElement).toBe(container.querySelector('h1'));
    expect(live()).toBe('Страница 3 от 9');
  });

  it('keeps focus on a filter change, which drops the paging', async () => {
    await act(() => router.navigate('/contracts?cursor=c2&page=2'));
    const filter = container.querySelector<HTMLAnchorElement>('a[href="/contracts?sector=45"]')!;
    filter.focus();
    await act(() => router.navigate('/contracts?sector=45'));
    expect(document.activeElement).toBe(filter);
  });

  it('moves focus on a path change without announcing a page', async () => {
    await act(() => router.navigate('/contracts?cursor=c2&page=2'));
    await act(() => router.navigate('/companies'));
    expect(document.activeElement?.textContent).toBe('Компании');
    expect(live()).toBe('');
  });
});
