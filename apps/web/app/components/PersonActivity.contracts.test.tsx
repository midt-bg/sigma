// @vitest-environment jsdom
// The contract list on a person's profile: every contract of the related companies, each row saying what ties
// it to the person, summaries by year and by authority, pages that keep the rest of the address, and filters
// that stay inside the profile view. PersonActivity.test.tsx pins the stale-payload refresh and the filter
// round trip; this file covers the list itself.
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, createRoutesStub, RouterProvider, useLoaderData } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonActivity as Activity, PersonContractRow } from '@sigma/db';
import { money } from '@sigma/shared';
import { PersonActivity } from './PersonActivity';

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

const activity = (over: Partial<Activity> = {}): Activity => ({
  contracts: [],
  page: 1,
  pageSize: 50,
  total: 0,
  companyCount: 0,
  valueEur: null,
  roleCount: 0,
  roleEur: null,
  declaredCount: 0,
  declaredEur: null,
  companies: [],
  authorities: [],
  years: [],
  yearOptions: [],
  filterCounts: { company: {}, authority: {}, year: {}, basis: {} },
  byAuthority: [],
  filters: { company: '', authority: '', year: '', basis: 'all' },
  ...over,
});

const contract = (over: Partial<PersonContractRow> = {}): PersonContractRow => ({
  id: 'c:e:1',
  subject: 'Ремонт на улици',
  company: 'АЛФА ООД',
  eik: '111111111',
  authority: 'Община Тестово',
  authorityId: 'auth:000111222',
  signedAt: '2023-05-01',
  valueEur: 1_000_000,
  duringRole: false,
  duringDeclaration: false,
  duringOfficeYear: false,
  declarationBasis: 0,
  ...over,
});

function render(a: Activity, { url = '/persons/ab', hasDeclarations = true } = {}) {
  const Stub = createRoutesStub([
    {
      path: '/persons/:id',
      Component: () => <PersonActivity activity={a} hasDeclarations={hasDeclarations} />,
    },
  ]);
  act(() => {
    root.render(<Stub initialEntries={[url]} />);
  });
  return container;
}

const section = (id: string) => container.querySelector(`#${id}`)!.closest('section')!;
const contractRows = () => [
  ...[...container.querySelectorAll('table')]
    .find((t) => t.querySelector('caption')?.textContent === 'Договори на свързаните дружества')!
    .querySelectorAll('tbody tr'),
];
const td = (row: Element, label: string) => row.querySelector(`td[data-label="${label}"]`)!;
/** The basis cell as the reader sees it: each chip by its label (an explained chip carries its
 *  explanation in a popover beside it, which is not part of the cell's wording), then the note. */
const basis = (row: Element) =>
  [...td(row, 'Основание за връзката').childNodes].map((n) =>
    n instanceof Element && n.classList.contains('inline-help')
      ? n.querySelector('button')!.textContent
      : n.textContent,
  );
const emptyNote = () =>
  [...container.querySelectorAll('p.muted')].find((p) =>
    p.textContent!.startsWith('Няма договори'),
  )!.textContent;

describe('PersonActivity — the contract list', () => {
  it('marks each contract with what ties it to the person, and links its parties', () => {
    render(
      activity({
        total: 4,
        contracts: [
          contract({
            duringOfficeYear: true,
            duringRole: true,
            duringDeclaration: true,
            declarationBasis: 3,
          }),
          contract({ id: 'c:e/2', subject: '', signedAt: null, authorityId: 'auth:999' }),
          contract({ id: 'c:e:3', subject: 'Доставка на храни' }),
          contract({ id: 'c:e:4', duringDeclaration: true, declarationBasis: 2 }),
        ],
      }),
    );
    const rows = contractRows();
    expect(rows.map(basis)).toEqual([
      [
        'година с данни за длъжността',
        'лична роля в ТР',
        'деклариран собствен дял',
        'дял на свързано лице',
      ],
      ['Без дата'],
      ['Без установено припокриване'],
      ['дял на свързано лице'],
    ]);

    const [full, bare] = rows;
    expect(td(full!, 'Договор').querySelector('a')!.getAttribute('href')).toBe('/contracts/e:1');
    expect(td(full!, 'Изпълнител').querySelector('a')!.getAttribute('href')).toBe(
      '/companies/111111111',
    );
    expect(td(full!, 'Възложител').querySelector('a')!.getAttribute('href')).toBe(
      '/authorities/000111222',
    );
    expect(td(full!, 'Сключен на').textContent).toBe('01.05.2023');
    expect(td(full!, 'Стойност').textContent).toBe(money(1_000_000));
    // A contract with no subject still gets a link to its page, under a generic name.
    const untitled = td(bare!, 'Договор').querySelector('a')!;
    expect(untitled.textContent).toBe('Договор');
    expect(untitled.getAttribute('href')).toBe('/contracts/e%2F2');
    expect(td(bare!, 'Сключен на').textContent).toBe('—');
    expect(td(bare!, 'Възложител').querySelector('a')!.getAttribute('href')).toBe(
      '/authorities/999',
    );
  });

  it('summarises the matching contracts by year and by authority', () => {
    render(
      activity({
        total: 12,
        years: [
          { year: '2024', contracts: 7, valueEur: 1_500_000 },
          { year: '2023', contracts: 5, valueEur: null },
        ],
        byAuthority: [
          { id: 'auth:000111222', name: 'Община Тестово', contracts: 12, valueEur: 1_500_000 },
        ],
        contracts: [contract()],
      }),
    );
    const cells = (id: string) =>
      [...section(id).querySelectorAll('tbody tr')].map((r) =>
        [...r.querySelectorAll('td')].map((c) => c.textContent),
      );
    expect(cells('contract-years')).toEqual([
      ['2024', '7', money(1_500_000)],
      ['2023', '5', '—'],
    ]);
    expect(cells('contract-authorities')).toEqual([['Община Тестово', '12', money(1_500_000)]]);
    expect(section('contract-authorities').querySelector('a')!.getAttribute('href')).toBe(
      '/authorities/000111222',
    );
  });

  it('leaves the summaries out when nothing matches', () => {
    render(activity());
    expect(container.querySelector('#contract-years, #contract-authorities')).toBeNull();
    expect(emptyNote()).toBe('Няма договори за избраното основание и условия.');
  });

  it('pages through the contracts without losing the rest of the address', () => {
    const page = (n: number) =>
      render(activity({ total: 120, page: n, contracts: [contract()] }), {
        url: `/persons/ab?view=profile&basis=role&page=${n}`,
      }).querySelector('nav.profile-pagination')!;
    const links = (nav: Element) =>
      [...nav.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);

    const middle = page(2);
    expect(middle.getAttribute('aria-label')).toBe('Страници с договори');
    expect(middle.querySelector('span')!.textContent).toBe('Страница 2 от 3');
    expect(links(middle)).toEqual([
      ['← Предишна', '/persons/ab?view=profile&basis=role&page=1#contracts'],
      ['Следваща →', '/persons/ab?view=profile&basis=role&page=3#contracts'],
    ]);
    expect(links(page(1))).toEqual([
      ['Следваща →', '/persons/ab?view=profile&basis=role&page=2#contracts'],
    ]);
    expect(links(page(3))).toEqual([
      ['← Предишна', '/persons/ab?view=profile&basis=role&page=2#contracts'],
    ]);
    render(activity({ total: 50, contracts: [contract()] }));
    expect(container.querySelector('nav.profile-pagination')).toBeNull();
  });

  it('keeps the profile view through the filters and their reset', () => {
    render(activity(), { url: '/persons/ab?view=profile&year=2024' });
    const form = container.querySelector('#contract-filters')!;
    expect(form.querySelector('input[type="hidden"][name="view"]')!.getAttribute('value')).toBe(
      'profile',
    );
    expect(form.querySelector('.filter-reset')!.getAttribute('href')).toBe(
      '/persons/ab?view=profile',
    );

    render(activity(), { url: '/persons/ab?year=2024' });
    expect(container.querySelector('#contract-filters input[type="hidden"]')).toBeNull();
    expect(container.querySelector('.filter-reset')!.getAttribute('href')).toBe('/persons/ab');
  });

  it('lists the authorities to filter by, each with its count', () => {
    render(
      activity({
        authorities: [
          { id: 'auth:1', name: 'Община А' },
          { id: 'auth:2', name: 'Община Б' },
        ],
        filterCounts: { company: {}, authority: { '': 4, 'auth:1': 3 }, year: {}, basis: {} },
        filters: { company: '', authority: 'auth:1', year: '', basis: 'all' },
      }),
    );
    const select = [...container.querySelectorAll('select')].find((s) => s.name === 'authority')!;
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['', 'Всички (4)'],
      ['auth:1', 'Община А (3)'],
      ['auth:2', 'Община Б (0)'],
    ]);
    expect(select.value).toBe('auth:1');
  });

  it('counts a single contract in the singular', () => {
    const summary = (total: number) =>
      render(activity({ total, contracts: [contract()] })).querySelector('.profile-summary span')!
        .textContent;
    expect(summary(1)).toBe('1 договор');
    expect(summary(12)).toBe('12 договора');
  });

  it('separates a relative’s stake from a registry role, and the declared bases need declarations', () => {
    const role = activity({
      roleCount: 2,
      roleEur: 3000,
      declaredCount: 1,
      declaredEur: 2000,
      filters: { company: '', authority: '', year: '', basis: 'role' },
    });
    const declared = () =>
      ['declaration', 'self', 'family'].map(
        (v) =>
          container.querySelector<HTMLOptionElement>(`select[name="basis"] option[value="${v}"]`)!
            .disabled,
      );
    const summary = () =>
      [...container.querySelectorAll('.profile-summary > span')].map((s) => s.textContent);

    render(role);
    expect(emptyNote()).toBe(
      'Няма договори за избраното основание и условия. Деклариран дял на свързано лице не означава лична роля в Търговския регистър.',
    );
    expect(declared()).toEqual([false, false, false]);
    expect(summary()).toEqual([
      '0 договора',
      '— обща стойност',
      `1 в декларирания период · ${money(2000)}`,
      `2 през вписана роля · ${money(3000)}`,
    ]);

    const officeYears = () =>
      ['matched', 'context'].map(
        (v) => !!container.querySelector(`select[name="basis"] option[value="${v}"]`),
      );
    expect(officeYears()).toEqual([true, true]);
    expect(container.querySelector('.profile-period-note')!.textContent).toContain(
      'Годините с данни за длъжността',
    );

    render(role, { hasDeclarations: false });
    expect(emptyNote()).toBe('Няма договори за избраното основание и условия.');
    expect(declared()).toEqual([true, true, true]);
    // Without declarations there are no office years to filter or explain.
    expect(officeYears()).toEqual([false, false]);
    expect(container.querySelector('.profile-period-note')!.textContent).not.toContain(
      'длъжността',
    );
    expect(summary()).toEqual([
      '0 договора',
      '— обща стойност',
      `2 през вписана роля · ${money(3000)}`,
    ]);
  });

  it('asks for a stale payload once, even when React runs the effect twice', async () => {
    // StrictMode mounts effects twice in development; without the guard the second run would start a
    // second revalidation and abort the first.
    const { filterCounts: _, ...stale } = activity();
    const loader = vi.fn(() => stale);
    const router = createMemoryRouter(
      [
        {
          id: 'profile',
          path: '/',
          loader,
          Component: () => <PersonActivity activity={useLoaderData()} hasDeclarations />,
        },
      ],
      { hydrationData: { loaderData: { profile: stale } } },
    );
    try {
      await act(async () =>
        root.render(
          <StrictMode>
            <RouterProvider router={router} />
          </StrictMode>,
        ),
      );
      await act(async () => {});
      expect(loader).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="status"]')!.textContent).toBe(
        'Данните за договорите се нуждаят от обновяване. Презареди',
      );
    } finally {
      router.dispose();
    }
  });
});
