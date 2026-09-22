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

  it('labels the current-period toggle in months at the monthly step', async () => {
    await renderTrends(loaderData({ angle: 'time', step: 'm' }));
    expect(text()).toContain('вкл. текущия месец');
  });

  it('names an unnamed CPV group by its code and marks the selected row in the compact panel', async () => {
    const groups = [
      { ...CPV_GROUP, group: '45000', name: null },
      { ...CPV_GROUP, group: '33000', name: 'Медицина' },
    ];
    await renderTrends(
      loaderData({
        angle: 'cross',
        cpvSel: ['45000'],
        stats: { groups, totalGroups: 2 },
      }),
    );
    const rows = [...container.querySelectorAll('.ov-cpv-row')];
    const selected = rows.find((r) => r.textContent?.includes('45000'))!;
    const other = rows.find((r) => r.textContent?.includes('33000'))!;
    expect(selected.textContent).toContain('CPV група 45000');
    expect(selected.querySelector('.ov-check')?.textContent).toBe('✓');
    expect(other.querySelector('.ov-check')?.textContent).toBe('');
  });

  it('gives every selected group its own chip that removes just that group', async () => {
    await renderTrends(loaderData({ cpvSel: ['33000', '45000'] }));
    const chips = [...container.querySelectorAll('.ov-chip')];
    expect(chips).toHaveLength(2);
    const remove = (label: string) =>
      decodeURIComponent(
        chips.find((c) => c.textContent?.includes(label))!.getAttribute('href') ?? '',
      );
    expect(remove('33000')).toContain('cpv=45000');
    expect(remove('33000')).not.toContain('cpv=33000');
  });

  it('says so when a cpv selection leaves too little data for the cross-lens chart, and names the groups otherwise', async () => {
    const one = { period: '2022-Q1', valueEur: 1, contracts: 1, partial: false };
    const base = baseLoaderData().trend;
    await renderTrends(
      loaderData({ angle: 'cross', cpvSel: ['45000'], trend: { ...base, points: [one] } }),
    );
    expect(container.querySelector('.ov-cross-chart-empty')?.textContent).toContain(
      'Няма достатъчно данни',
    );

    await renderTrends(loaderData({ angle: 'cross', cpvSel: ['45000'] }));
    expect(container.querySelector('.ov-cross-chart-empty')).toBeNull();
    expect(
      container.querySelector('.combo-chart [aria-label]')?.getAttribute('aria-label'),
    ).toContain('45000');
  });

  it('highlights the active year card in the cross lens', async () => {
    await renderTrends(loaderData({ angle: 'cross', year: '2022' }));
    expect(container.querySelector('.ov-year.is-slim')!.className).toContain('is-active');
  });

  it('flags a still-filling year on the time lens', async () => {
    const base = baseLoaderData().trend;
    await renderTrends(
      loaderData({
        trend: {
          ...base,
          years: [{ year: '2022', valueEur: 1, contracts: 1, yoyPct: null, partial: true }],
        },
      }),
    );
    expect(container.querySelector('.ov-year-partial')?.textContent).toContain('частично');
  });

  it('labels each card against its group median, and leaves a card without a known cohort unlabeled', async () => {
    await renderTrends(
      loaderData({
        contracts: [
          { ...CONTRACT, id: 'hi', valueEur: 2_000_000 }, // 10× the 200 000 median
          { ...CONTRACT, id: 'none', cpvGroup: null },
          { ...CONTRACT, id: 'unknown', cpvGroup: '99999' },
          { ...CONTRACT, id: 'backfilled', cpvGroup: '33000', valueEur: 1_000 },
        ],
        medians: [{ group: '33000', name: 'Медицина', contracts: 3, medianEur: 100_000 }],
      }),
    );
    const cards = [...container.querySelectorAll('.ov-card')];
    const rel = (i: number) => cards[i]!.querySelector('.ov-card-rel')?.textContent ?? null;
    expect(rel(0)).toBe('×10 типичното');
    expect(rel(1)).toBeNull();
    expect(rel(2)).toBeNull();
    expect(rel(3)).toBe('под типичното');
    expect(cards[3]!.querySelector('.ov-card-cohort')?.textContent).toBe('Медицина');
    expect(cards[2]!.querySelector('.ov-card-cohort')?.textContent).toBe('');
  });
});
