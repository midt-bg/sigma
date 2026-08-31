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
});
