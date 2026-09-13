// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useLoaderData } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { PersonActivity } from './PersonActivity';
import { emptyActivity } from '../lib/person-profile.test-support';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());

it.each([
  ['yearOptions', true],
  ['yearOptions', false],
  ['filterCounts', true],
  ['filterCounts', false],
] as const)('refreshes a payload missing %s once (server updated: %s)', async (field, updated) => {
  // An open page can retain the loader payload from before a field was introduced.
  const { [field]: _, ...previous } = emptyActivity;
  const current = { ...emptyActivity, yearOptions: ['2025', '2023'] };
  const loader = vi.fn(() => (updated ? current : previous));
  const router = createMemoryRouter(
    [
      {
        id: 'profile',
        path: '/',
        loader,
        Component: () => <PersonActivity activity={useLoaderData()} hasDeclarations />,
        ErrorBoundary: () => <p>PROFILE_CRASH</p>,
      },
    ],
    { hydrationData: { loaderData: { profile: previous } } },
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    expect(container.textContent).not.toContain('PROFILE_CRASH');
    expect(loader).toHaveBeenCalledTimes(1);
    if (updated) {
      expect(
        [...container.querySelectorAll('select[name="year"] option')].map((o) => o.textContent),
      ).toEqual(['Всички (0)', '2025 (0)', '2023 (0)']);
    } else {
      expect(container.querySelector('form')).toBeNull();
      expect(container.querySelector('a')?.textContent).toBe('Презареди');
      await act(async () => {});
      expect(loader).toHaveBeenCalledTimes(1);
    }
  } finally {
    act(() => root.unmount());
    container.remove();
    router.dispose();
  }
});

it('reveals filters from the timeline, but applies manual changes and resets without revealing again', async () => {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        loader: ({ request }) => {
          const q = new URL(request.url).searchParams;
          return {
            ...emptyActivity,
            companies: [{ eik: '123456789', name: 'Фирма' }],
            yearOptions: ['2024'],
            filterCounts: {
              ...emptyActivity.filterCounts,
              company: {
                '': q.get('basis') === 'matched' ? 1 : 3,
                '123456789': q.get('basis') === 'matched' ? 1 : 3,
              },
            },
            filters: {
              ...emptyActivity.filters,
              company: q.get('company') ?? '',
              year: q.get('year') ?? '',
              basis: q.get('basis') ?? 'all',
            },
          };
        },
        Component: () => <PersonActivity activity={useLoaderData()} hasDeclarations />,
      },
    ],
    { hydrationData: { loaderData: { '0': emptyActivity } } },
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    const form = container.querySelector('#contract-filters')!;
    const select = (name: string) =>
      [...container.querySelectorAll('select')].find((s) => s.name === name)!;
    form.scrollIntoView = vi.fn();
    await act(async () => router.navigate('/?company=123456789&year=2024#contract-filters'));
    expect(document.activeElement).toBe(form);
    expect(form.classList.contains('profile-target')).toBe(true);
    expect(container.querySelector('#contracts.profile-target')).toBeNull();
    expect(select('year').value).toBe('2024');
    expect(select('company').selectedOptions[0]!.textContent).toBe('Фирма (3)');
    form.classList.remove('profile-target');
    select('basis').focus();
    await act(async () => {
      select('basis').value = 'matched';
      select('basis').dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(router.state.location.search).toContain('basis=matched');
    expect(router.state.location.search).toContain('company=123456789');
    expect(router.state.location.search).toContain('year=2024');
    expect(router.state.location.hash).toBe('');
    expect(router.state.preventScrollReset).toBe(true);
    expect(document.activeElement).toBe(select('basis'));
    expect(select('company').selectedOptions[0]!.textContent).toBe('Фирма (1)');
    expect(form.classList.contains('profile-target')).toBe(false);
    expect(form.scrollIntoView).toHaveBeenCalledTimes(1);
    await act(async () => container.querySelector<HTMLAnchorElement>('.filter-reset')!.click());
    expect(select('company').value).toBe('');
    expect(select('year').value).toBe('');
    expect(select('basis').value).toBe('all');
    expect(router.state.location.search).toBe('');
    expect(router.state.location.hash).toBe('');
    expect(router.state.preventScrollReset).toBe(true);
    expect(form.classList.contains('profile-target')).toBe(false);
    expect(form.scrollIntoView).toHaveBeenCalledTimes(1);
    await act(async () => router.navigate('/?company=123456789&year=2024#contract-filters'));
    expect(form.scrollIntoView).toHaveBeenCalledTimes(2);
    expect(form.classList.contains('profile-target')).toBe(true);
  } finally {
    act(() => root.unmount());
    container.remove();
    router.dispose();
  }
});
