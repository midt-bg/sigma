// @vitest-environment jsdom
// The filter rail keeps every filter in the address. Ticking a box navigates at once (with JS), keeping the
// sort, the in-table search and the institution/company scope while dropping the paging; without JS the same
// state rides in hidden fields of the GET form. A sector category's box ticks or clears all of its codes and
// shows „mixed" when only some are chosen. The groups here are built from the live address, as the list
// routes build them, so every navigation re-renders the rail with the new selection.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useSearchParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilterRail, type FilterGroup } from './FilterRail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  router.dispose();
});

type GroupSpec = Omit<FilterGroup, 'selected'>;

const year: GroupSpec = {
  key: 'year',
  label: 'Година',
  type: 'checkbox',
  options: [
    { value: '2024', label: '2024', count: 1200 },
    { value: '2023', label: '2023', count: 5 },
  ],
};

async function render(groups: GroupSpec[], url: string, csvHref?: string) {
  function Rail() {
    const [sp] = useSearchParams();
    return (
      <FilterRail
        groups={groups.map((g) => ({ ...g, selected: sp.getAll(g.key) }))}
        sort={sp.get('sort') ?? 'date-desc'}
        clearHref="/contracts"
        csvHref={csvHref}
      />
    );
  }
  router = createMemoryRouter([{ path: '/contracts', Component: Rail }], {
    initialEntries: [url],
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  return container;
}

const params = () => new URLSearchParams(router.state.location.search);
const hidden = () =>
  [...container.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((i) => [
    i.name,
    i.value,
  ]);
const box = (name: string, value: string) =>
  container.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!;
const click = (input: HTMLInputElement) =>
  act(async () => {
    input.click();
  });

describe('FilterRail', () => {
  it('applies a ticked box at once, keeping the search, the sort and the scope, and restarting the pages', async () => {
    await render(
      [year],
      '/contracts?q=мост&authority=auth%3A1&bidder=eik%3A1&bidder=eik%3A2&year=2023&sort=value-desc&page=3&cursor=abc',
      '/contracts.csv?year=2023',
    );
    // Without JS the form carries the same state itself.
    expect(hidden()).toEqual([
      ['sort', 'value-desc'],
      ['q', 'мост'],
      ['authority', 'auth:1'],
      ['bidder', 'eik:1'],
      ['bidder', 'eik:2'],
    ]);
    expect(box('year', '2023').checked).toBe(true);
    expect(box('year', '2024').checked).toBe(false);

    await click(box('year', '2024'));
    const p = params();
    expect(p.getAll('year').sort()).toEqual(['2023', '2024']);
    expect([p.get('q'), p.get('sort'), p.get('authority'), p.getAll('bidder')]).toEqual([
      'мост',
      'value-desc',
      'auth:1',
      ['eik:1', 'eik:2'],
    ]);
    expect(p.has('page') || p.has('cursor')).toBe(false);
    expect(box('year', '2024').checked).toBe(true);
    expect(container.querySelector('.filter-count')!.textContent).toBe('2');

    const links = [...container.querySelectorAll('.filter-rail p a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Изчисти филтрите', '/contracts'],
      ['Изтегли CSV', '/contracts.csv?year=2023'],
    ]);
  });

  it('clears a single-choice group through its „all" option', async () => {
    const value: GroupSpec = {
      key: 'value',
      label: 'Стойност (в евро)',
      type: 'radio',
      options: [
        { value: 'lt100k', label: 'Под 100 хил. €' },
        { value: 'gt100m', label: 'Над 100 млн. €' },
      ],
    };
    const stake: GroupSpec = {
      key: 'stake',
      label: 'Дял',
      type: 'radio',
      allLabel: 'всички',
      options: [
        { value: 'self', label: 'Собствен' },
        { value: 'family', label: 'На свързано лице' },
      ],
    };
    // A group whose facet came back empty is still listed, with nothing to tick.
    const procedure: GroupSpec = { key: 'procedure', label: 'Процедура', type: 'checkbox' };
    await render([value, stake, procedure], '/contracts?value=gt100m&sort=value-desc');
    expect(hidden()).toEqual([['sort', 'value-desc']]);
    expect(container.textContent).not.toContain('Изтегли CSV');
    const all = (name: string) => box(name, '');
    expect(all('value').closest('label')!.textContent).toBe(' Всички');
    expect(all('stake').closest('label')!.textContent).toBe(' всички');
    expect([all('value').checked, box('value', 'gt100m').checked]).toEqual([false, true]);
    expect(all('stake').checked).toBe(true);
    const empty = container.querySelector('details[aria-label="Процедура"]')!;
    expect(empty.querySelector('summary')!.textContent).toBe('Процедура');
    expect(empty.querySelector('input')).toBeNull();

    await click(box('stake', 'family'));
    expect(router.state.location.search).toBe('?value=gt100m&stake=family&sort=value-desc');

    await click(all('value'));
    expect(router.state.location.search).toBe('?stake=family&sort=value-desc');
    expect(all('value').checked).toBe(true);
  });

  it('ticks or clears a whole sector category from its box, in one step', async () => {
    const sector: GroupSpec = {
      key: 'sector',
      label: 'Сектор (CPV)',
      type: 'checkbox',
      categories: [
        {
          key: 'construction',
          label: 'Строителство и инфраструктура',
          count: 10,
          options: [
            { value: '45', label: 'Строителни работи', count: 6 },
            { value: '71', label: 'Архитектурни услуги', count: 4 },
          ],
        },
        {
          key: 'health',
          label: 'Здравеопазване и социални дейности',
          options: [
            { value: '33', label: 'Медицинско оборудване', count: 3 },
            { value: '85', label: 'Здравни услуги' },
          ],
        },
        {
          key: 'it',
          label: 'Информационни технологии',
          count: 2,
          options: [{ value: '72', label: 'ИТ услуги', count: 2 }],
        },
      ],
    };
    await render([sector], '/contracts?sector=33&sector=72');
    const category = (label: string) =>
      container.querySelector<HTMLInputElement>(`input[aria-label="Избери всички в ${label}"]`)!;
    const state = (label: string) => {
      const input = category(label);
      return {
        checked: input.checked,
        aria: input.getAttribute('aria-checked'),
        indeterminate: input.indeterminate,
        open: (input.closest('details') as HTMLDetailsElement).open,
      };
    };
    const construction = 'Строителство и инфраструктура';
    const health = 'Здравеопазване и социални дейности';
    const it_ = 'Информационни технологии';
    expect(state(construction)).toEqual({
      checked: false,
      aria: 'false',
      indeterminate: false,
      open: false,
    });
    expect(state(health)).toEqual({
      checked: false,
      aria: 'mixed',
      indeterminate: true,
      open: true,
    });
    expect(state(it_)).toEqual({ checked: true, aria: 'true', indeterminate: false, open: true });
    // Counts show where the data has them, for a category and for a code alike.
    const count = (el: Element) => el.querySelector(':scope > .muted')?.textContent ?? null;
    const summaries = [...container.querySelectorAll('.filter-subgroup > summary')];
    expect(summaries.map(count)).toEqual(['10', null, '2']);
    expect(
      [...category(health).closest('details')!.querySelectorAll('label')].map((l) => count(l)),
    ).toEqual(['3', null]);

    const entries: string[] = [];
    const unsubscribe = router.subscribe((s) => {
      if (s.navigation.state === 'idle') entries.push(s.location.search);
    });
    await click(category(construction));
    unsubscribe();
    // One navigation: the form's own change handler must not submit the category a second time.
    expect(entries).toHaveLength(1);
    expect(params().getAll('sector').sort()).toEqual(['33', '45', '71', '72']);
    expect(state(construction)).toEqual({
      checked: true,
      aria: 'true',
      indeterminate: false,
      open: true,
    });
    expect(box('sector', '71').checked).toBe(true);

    await click(category(it_));
    expect(params().getAll('sector').sort()).toEqual(['33', '45', '71']);
    expect(state(it_)).toEqual({
      checked: false,
      aria: 'false',
      indeterminate: false,
      open: false,
    });
    expect(box('sector', '72').checked).toBe(false);
  });
});
