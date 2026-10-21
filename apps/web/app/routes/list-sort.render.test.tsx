// @vitest-environment jsdom
// The „Подреди:" bar marks the sort the loader actually applied: an unknown, empty or upper-case ?sort
// falls back to the default in the query, so the bar and the rail's hidden field say the default too.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { AuthorityListItem } from '@sigma/api-contract';

const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }));
vi.mock('@sigma/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sigma/db')>()),
  listAuthorities: listMock,
  getAuthorityFacets: async () => ({ types: [], sectors: [] }),
  getDb: (env: unknown) => env,
}));
vi.mock('../lib/coverage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/coverage')>()),
  getCoverageMeta: async () => ({ coverageEndYear: 2025 }),
}));

import Authorities, { loader, meta } from './authorities';

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

const emptyPage = { items: [], total: 0, nextCursor: null, prevCursor: null };

async function render(url: string, page: object = emptyPage) {
  const Stub = createRoutesStub([
    {
      path: '/authorities',
      Component: Authorities as never,
      loader: () => ({
        page,
        facets: { types: [], sectors: [] },
        coverage: { coverageEndYear: 2025 },
      }),
    },
    { path: '/authorities/:eik', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={[url]} />);
  });
}

describe('list sort bar', () => {
  it.each(['bogus', '', 'SPENT'])('marks the default sort for ?sort=%s', async (value) => {
    await render(`/authorities?sort=${value}`);
    const current = container.querySelectorAll('[aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toBe('обща стойност');
    const hidden = container.querySelector<HTMLInputElement>('input[type="hidden"][name="sort"]');
    expect(hidden?.value).toBe('spent');
  });
});

const item = (over: Partial<AuthorityListItem> = {}): AuthorityListItem => ({
  slug: '000000001',
  name: 'Община Тест',
  typeGroup: 'община',
  typeLabel: 'Община',
  settlement: 'гр. Тест',
  spentEur: 1000,
  contracts: 2,
  avgEur: 500,
  ...over,
});

describe('authorities list', () => {
  it('labels the rows page 1 when the cursor was rejected', async () => {
    const items = [item(), item({ slug: '000000002', settlement: null, typeLabel: null })];
    await render('/authorities?cursor=garbage&page=7', {
      items,
      total: 100,
      nextCursor: 'after:x',
      prevCursor: null,
    });
    expect(container.textContent).toContain('Страница 1 от 4');
    expect(container.querySelector('a[href="/authorities/000000001"]')?.textContent).toBe(
      'Община Тест',
    );
    expect(container.textContent).toContain('гр. Тест');
  });

  it('has its own title', () => {
    expect(meta({ matches: [] } as never)).toContainEqual({ title: 'Институции — СИГМА' });
  });

  it('loads the page with the normalised filters and the cursor', async () => {
    listMock.mockResolvedValue(emptyPage);
    const data = await loader({
      request: new Request('https://example.test/authorities?sort=name&cursor=after:x'),
      context: { cloudflare: { env: {} } },
    } as never);
    expect(listMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ sort: 'name', cursor: 'after:x' }),
    );
    expect(data).toMatchObject({ page: emptyPage, coverage: { coverageEndYear: 2025 } });
  });
});
