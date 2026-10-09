// @vitest-environment jsdom
// Render smoke tests for the /trends page across its three lenses (time/cpv/cross) plus the
// empty-list and no-filter-chip states — the loader itself is covered by trends.loader.test.ts.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { CpvGroupStat, OverviewContract, TrendData } from '@sigma/api-contract';

import Trends from './trends';

const baseTrend: TrendData = {
  granularity: 'quarter',
  points: [
    { period: '2024-Q1', valueEur: 1000, contracts: 3, partial: false },
    { period: '2024-Q2', valueEur: 1500, contracts: 4, partial: true },
  ],
  years: [{ year: '2024', valueEur: 2500, contracts: 7, yoyPct: null, partial: true }],
  sectors: [],
  totalValueEur: 2500,
  coverage: { dated: 7, total: 8, pct: 87.5 },
  scope: { sector: null, funding: 'all', granularity: 'quarter' },
};

const cpvGroup: CpvGroupStat = {
  group: '45233',
  name: 'Пътни настилки',
  contracts: 5,
  medianEur: 1000,
  p10Eur: 100,
  p90Eur: 5000,
  maxEur: 9000,
  sampleEur: [500, 1000, 2000],
};

const contract: OverviewContract = {
  id: 'c1',
  signedAt: '2024-05-01',
  valueEur: 1200,
  authorityName: 'Община Х',
  bidderName: 'Фирма У',
  cpvGroup: '45233',
};

function loaderData(overrides: Partial<Parameters<typeof Trends>[0]['loaderData']> = {}) {
  return {
    angle: 'time' as const,
    step: 'q' as const,
    sort: 'date' as const,
    cpvSort: 'n' as const,
    year: null,
    cpvSel: [],
    cur: false,
    trend: baseTrend,
    stats: { totalGroups: 1, groups: [cpvGroup] },
    contracts: [contract],
    medians: [],
    ...overrides,
  };
}

describe('/trends page render', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(url: string, data: ReturnType<typeof loaderData>) {
    const router = createMemoryRouter(
      [
        {
          path: '/trends',
          element: (
            <Trends {...({ loaderData: data } as unknown as Parameters<typeof Trends>[0])} />
          ),
        },
      ],
      { initialEntries: [url] },
    );
    act(() => {
      root.render(<RouterProvider router={router} />);
    });
  }

  it('renders the time lens with the chart, year cards and contract list', () => {
    render('/trends', loaderData());
    expect(container.querySelector('.combo-chart')).not.toBeNull();
    expect(container.querySelectorAll('.ov-year').length).toBe(1);
    expect(container.querySelectorAll('.ov-card').length).toBe(1);
    expect(container.querySelector('.ov-empty')).toBeNull();
  });

  it('renders the cpv lens table instead of the chart', () => {
    render('/trends?angle=cpv', loaderData({ angle: 'cpv' }));
    expect(container.querySelector('.ov-cpv')).not.toBeNull();
    expect(container.querySelector('.combo-chart')).toBeNull();
    expect(container.querySelector('.ov-cpv-row')?.textContent).toContain('45233');
  });

  it('renders the cross lens with both the compact chart and the compact cpv panel', () => {
    render('/trends?angle=cross', loaderData({ angle: 'cross' }));
    expect(container.querySelector('.ov-cross')).not.toBeNull();
    expect(container.querySelector('.combo-chart')).not.toBeNull();
    expect(container.querySelector('[data-compact="true"]')).not.toBeNull();
  });

  it('shows the empty-list message when no contracts match the filter', () => {
    render('/trends?year=2020', loaderData({ year: '2020', contracts: [] }));
    expect(container.querySelector('.ov-empty')?.textContent).toContain('Няма договори');
  });

  it('renders a CPV filter chip and drops the lens hint once a group is selected', () => {
    render('/trends?cpv=45233', loaderData({ cpvSel: ['45233'] }));
    expect(container.querySelector('.ov-chip')?.textContent).toContain('45233');
    expect(container.querySelector('.ov-hint')).toBeNull();
  });

  it('shows the no-data placeholder instead of the chart when fewer than 2 points exist', () => {
    render(
      '/trends',
      loaderData({
        trend: {
          ...baseTrend,
          points: [{ period: '2024-Q1', valueEur: 1000, contracts: 3, partial: false }],
        },
      }),
    );
    expect(container.querySelector('.combo-chart')).toBeNull();
    expect(container.querySelector('.muted')?.textContent).toContain('Няма достатъчно данни');
  });

  it('carries the resolved step forward and drops the legacy `g` param from generated links (#197)', () => {
    render('/trends?g=year', loaderData({ step: 'y' }));
    const sortLink = Array.from(container.querySelectorAll('a')).find((a) =>
      a.getAttribute('href')?.includes('sort=value'),
    );
    expect(sortLink?.getAttribute('href')).toContain('step=y');
    expect(sortLink?.getAttribute('href')).not.toContain('g=year');
  });

  it('sorts the cpv lens by typical value or by code, and names an unnamed group by its code', () => {
    const cheap: CpvGroupStat = { ...cpvGroup, group: '15000', name: null, medianEur: 50 };
    const stats = { totalGroups: 2, groups: [cheap, cpvGroup] };
    const rowCodes = () =>
      Array.from(container.querySelectorAll('.ov-cpv-row')).map((r) => r.textContent ?? '');

    render('/trends?angle=cpv&cpvsort=med', loaderData({ angle: 'cpv', cpvSort: 'med', stats }));
    // Most-typical-value first: 45233 (median 1000) before 15000 (median 50).
    expect(rowCodes()[0]).toContain('45233');
    expect(rowCodes()[1]).toContain('CPV група 15000');

    act(() => root.unmount());
    root = createRoot(container);
    render('/trends?angle=cpv&cpvsort=code', loaderData({ angle: 'cpv', cpvSort: 'code', stats }));
    expect(rowCodes()[0]).toContain('15000');
  });

  it('marks a selected cpv row, and its link deselects it while an unselected one adds it', () => {
    const other: CpvGroupStat = { ...cpvGroup, group: '15000', name: 'Храни' };
    render(
      '/trends?angle=cross&cpv=45233',
      loaderData({
        angle: 'cross',
        cpvSel: ['45233'],
        stats: { totalGroups: 2, groups: [cpvGroup, other] },
      }),
    );
    const rows = Array.from(container.querySelectorAll('.ov-cpv-row'));
    const selected = rows.find((r) => r.textContent?.includes('45233'))!;
    const unselected = rows.find((r) => r.textContent?.includes('15000'))!;
    expect(selected.className).toContain('is-active');
    expect(selected.querySelector('.ov-check')?.textContent).toBe('✓');
    expect(unselected.className).not.toContain('is-active');
    expect(unselected.querySelector('.ov-check')?.textContent).toBe('');
    // Deselecting the only group drops the cpv param entirely; adding one keeps both, sorted.
    expect(selected.getAttribute('href')).toBe('/trends?angle=cross');
    expect(unselected.getAttribute('href')).toBe('/trends?angle=cross&cpv=15000&cpv=45233');
  });

  it('labels the current-period toggle by the chart step and flips it on and off', () => {
    const toggle = () =>
      Array.from(container.querySelectorAll('.ovz-seg[aria-label="Текущ период"] a'))[0]!;
    render('/trends', loaderData({ step: 'm' }));
    expect(toggle().textContent).toContain('вкл. текущия месец');
    expect(toggle().getAttribute('href')).toContain('cur=1');

    act(() => root.unmount());
    root = createRoot(container);
    render('/trends?step=y&cur=1', loaderData({ step: 'y', cur: true }));
    expect(toggle().textContent).toContain('вкл. текущата година');
    expect(toggle().getAttribute('href')).not.toContain('cur=');
    expect(toggle().getAttribute('aria-current')).toBe('true');
  });

  it('toggles the year filter from a year card and shows the year chip when one is active', () => {
    render('/trends?year=2024', loaderData({ year: '2024' }));
    const card = container.querySelector('.ov-year')!;
    expect(card.className).toContain('is-active');
    // The active card links back to the unfiltered list.
    expect(card.getAttribute('href')).toBe('/trends');
    expect(container.querySelector('.ov-chip')?.textContent).toContain('2024');
  });

  it('states the empty scope on the cross lens and names the selected groups in the chart label', () => {
    render(
      '/trends?angle=cross&cpv=45233',
      loaderData({
        angle: 'cross',
        cpvSel: ['45233'],
        trend: { ...baseTrend, points: [baseTrend.points[0]!] },
      }),
    );
    expect(container.querySelector('.ov-cross-chart-empty')?.textContent).toContain(
      'Няма достатъчно данни',
    );

    act(() => root.unmount());
    root = createRoot(container);
    render('/trends?angle=cross&cpv=45233', loaderData({ angle: 'cross', cpvSel: ['45233'] }));
    expect(
      container.querySelector('.combo-chart [aria-label]')?.getAttribute('aria-label') ?? '',
    ).toContain('45233');
    expect(container.querySelector('.ov-cross-chart-empty')).toBeNull();
  });

  it('announces the selection size to assistive tech, singular and plural', () => {
    render('/trends?cpv=45233', loaderData({ cpvSel: ['45233'] }));
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      '1 избрана CPV група',
    );

    act(() => root.unmount());
    root = createRoot(container);
    render('/trends?cpv=45233&cpv=15000', loaderData({ cpvSel: ['15000', '45233'] }));
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      '2 избрани CPV групи',
    );
  });

  it('labels each card against its group median: high, typical, low, and no label when unknown', () => {
    const mk = (id: string, valueEur: number, cpvGroup: string | null): OverviewContract => ({
      ...contract,
      id,
      valueEur,
      cpvGroup,
    });
    render(
      '/trends',
      loaderData({
        sort: 'value',
        contracts: [
          mk('hi', 25000, '45233'), // ×25 the 1000 median → rounded, no decimal
          mk('mid', 1000, '45233'),
          mk('lo', 100, '45233'),
          mk('nogroup', 100, null),
          mk('med', 3000, '15000'), // group only known via the on-demand medians
        ],
        medians: [{ group: '15000', name: 'Храни', contracts: 4, medianEur: 1000 }],
      }),
    );
    const cards = Array.from(container.querySelectorAll('.ov-card'));
    const rel = (i: number) => cards[i]!.querySelector('.ov-card-rel')?.textContent ?? null;
    expect(rel(0)).toBe('×25 типичното');
    expect(rel(1)).toBe('≈ типичното');
    expect(rel(2)).toBe('под типичното');
    expect(rel(3)).toBeNull();
    expect(rel(4)).toBe('×3 типичното');
    expect(cards[4]!.querySelector('.ov-card-cohort')?.textContent).toBe('Храни');
    expect(cards[3]!.querySelector('.ov-card-cpv')).toBeNull();
    expect(container.textContent).toContain('Договори · по стойност');
  });

  it('flags a full first page and describes the scope of the list', () => {
    const many = Array.from({ length: 24 }, (_, i) => ({ ...contract, id: `c${i}` }));
    render(
      '/trends?year=2024&cpv=45233',
      loaderData({ contracts: many, year: '2024', cpvSel: ['45233'] }),
    );
    const head = container.textContent ?? '';
    expect(head).toContain('(показани първите 24)');
    expect(head).toContain('CPV 45233 · 2024');
  });

  it('draws outlier dots only for samples at 5x the group median or more', () => {
    render('/trends?angle=cpv', loaderData({ angle: 'cpv' }));
    // sampleEur [500, 1000, 2000] vs median 1000: none reach 5000.
    expect(container.querySelectorAll('.ov-dot.is-outlier').length).toBe(0);
    expect(container.querySelectorAll('.ov-dot').length).toBe(3);

    act(() => root.unmount());
    root = createRoot(container);
    const spiky = { ...cpvGroup, sampleEur: [500, 6000] };
    render(
      '/trends?angle=cpv',
      loaderData({ angle: 'cpv', stats: { totalGroups: 1, groups: [spiky] } }),
    );
    expect(container.querySelectorAll('.ov-dot.is-outlier').length).toBe(1);
  });
});
