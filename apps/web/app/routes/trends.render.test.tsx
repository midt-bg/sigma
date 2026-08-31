// @vitest-environment jsdom
// Deep render tests for the /trends ("Договори — обзор") route across its three lenses (time / cpv /
// cross), mounted through a real React Router data router (createRoutesStub) with realistic
// loaderData — same pattern as conflicts.render.test.tsx / overruns.render.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import Trends, { headers, meta, type loader } from './trends';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type LoaderData = Awaited<ReturnType<typeof loader>>;

const CPV_GROUP = {
  group: '45000',
  name: 'Строителство',
  contracts: 40,
  medianEur: 200_000,
  p10Eur: 50_000,
  p90Eur: 900_000,
  maxEur: 1_200_000,
  sampleEur: [50_000, 200_000, 900_000],
};

const CONTRACT = {
  id: 'c1-slug',
  signedAt: '2022-06-01',
  valueEur: 250_000,
  authorityName: 'Община Х',
  bidderName: 'Фирма ООД',
  cpvGroup: '45000',
};

function loaderData(over: Partial<LoaderData> = {}): LoaderData {
  return { ...baseLoaderData(), ...over };
}

function baseLoaderData(): LoaderData {
  return {
    angle: 'time' as const,
    step: 'q' as const,
    sort: 'date' as const,
    cpvSort: 'n' as const,
    year: null as string | null,
    cpvSel: [] as string[],
    cur: false,
    trend: {
      granularity: 'quarter' as const,
      points: [
        { period: '2022-Q1', valueEur: 1_000_000, contracts: 10, partial: false },
        { period: '2022-Q2', valueEur: 1_500_000, contracts: 12, partial: false },
      ],
      years: [{ year: '2022', valueEur: 2_500_000, contracts: 22, yoyPct: 0.1, partial: false }],
      sectors: [],
      totalValueEur: 2_500_000,
      coverage: { dated: 22, total: 22, pct: 1 },
      scope: { sector: null, funding: 'all' as const, granularity: 'quarter' as const },
    },
    stats: { groups: [CPV_GROUP], totalGroups: 1 },
    contracts: [CONTRACT],
    truncated: false,
    medians: [],
  };
}

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

async function renderTrends(data: ReturnType<typeof loaderData>) {
  const Stub = createRoutesStub([
    { path: '/trends', Component: Trends, loader: () => data },
    { path: '/contracts/:id', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/trends']} />);
  });
}

const text = () => container.textContent ?? '';

describe('/trends route — render', () => {
  it('meta() titles the page and headers() sets a public cache', () => {
    const tags = meta({} as never);
    expect(JSON.stringify(tags)).toContain('обзор');
    expect(headers()['Cache-Control']).toMatch(/public/);
  });

  it('renders the time lens with the chart, year cards and contract list', async () => {
    await renderTrends(loaderData({ angle: 'time' }));
    expect(text()).toContain('Разходи във');
    expect(container.querySelector('.ov-years')).not.toBeNull();
    expect(container.querySelectorAll('.ov-card').length).toBe(1);
    expect(text()).toContain('Община Х');
  });

  it('renders the cpv lens with the full distribution table', async () => {
    await renderTrends(loaderData({ angle: 'cpv' }));
    expect(text()).toContain('Цени по');
    expect(container.querySelector('.ov-cpv-row')).not.toBeNull();
    expect(text()).toContain('Строителство');
  });

  it('renders the cross lens with the compact year picker and compact CPV panel', async () => {
    await renderTrends(loaderData({ angle: 'cross' }));
    expect(text()).toContain('Избери');
    expect(container.querySelector('.ov-cpv[data-compact]')).not.toBeNull();
  });

  it('shows a truncation note and the value sort label when the list is truncated', async () => {
    await renderTrends(loaderData({ sort: 'value', truncated: true }));
    expect(text()).toContain('показани първите 24');
    expect(text()).toContain('по стойност');
  });

  it('renders active filter chips for a selected CPV group and year, and the empty-list state otherwise', async () => {
    await renderTrends(loaderData({ cpvSel: ['45000'], year: '2022', contracts: [] }));
    expect(text()).toContain('CPV 45000');
    expect(text()).toContain('2022');
    expect(text()).toContain('Няма договори за този избор');
  });

  it('shows the "not enough data" fallback instead of the chart when fewer than 2 trend points exist', async () => {
    await renderTrends(loaderData({ trend: { ...baseLoaderData().trend, points: [] } }));
    expect(text()).toContain('Няма достатъчно данни');
  });

  it('re-sorts the CPV table by median value or by code, not just by contract count', async () => {
    const groups = [
      { ...CPV_GROUP, group: '45000', name: 'Строителство', contracts: 40, medianEur: 100_000 },
      { ...CPV_GROUP, group: '33000', name: 'Медицина', contracts: 5, medianEur: 900_000 },
    ];
    await renderTrends(
      loaderData({ angle: 'cpv', cpvSort: 'med', stats: { groups, totalGroups: 2 } }),
    );
    let codes = [...container.querySelectorAll('.ov-cpv-code')].map((n) => n.textContent);
    expect(codes).toEqual(['33000', '45000']); // higher median first

    await renderTrends(
      loaderData({ angle: 'cpv', cpvSort: 'code', stats: { groups, totalGroups: 2 } }),
    );
    codes = [...container.querySelectorAll('.ov-cpv-code')].map((n) => n.textContent);
    expect(codes).toEqual(['33000', '45000']); // lexicographic code order
  });

  it('toggles a CPV group off the multi-select when it is already selected', async () => {
    await renderTrends(loaderData({ angle: 'cpv', cpvSel: ['45000'] }));
    const activeRow = container.querySelector('.ov-cpv-row.is-active') as HTMLAnchorElement;
    expect(activeRow).not.toBeNull();
    expect(activeRow.getAttribute('href')).toBe('/trends');
  });

  it('marks the current-period toggle active and labels it per step unit', async () => {
    await renderTrends(loaderData({ angle: 'time', step: 'y', cur: true }));
    expect(text()).toContain('вкл. текущата година');
  });
});
