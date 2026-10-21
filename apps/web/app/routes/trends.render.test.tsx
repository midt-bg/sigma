// @vitest-environment jsdom
// /trends through its real loader (data layer stubbed): the chart or its empty state, the yearly
// table with partial years, and the notice for an unknown sector.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { TrendData } from '@sigma/api-contract';

const { getSpendingTrend } = vi.hoisted(() => ({ getSpendingTrend: vi.fn() }));
vi.mock('@sigma/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sigma/db')>()),
  getSpendingTrend,
  getDb: (env: unknown) => env,
}));

import Trends, { loader } from './trends';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  getSpendingTrend.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const base: TrendData = {
  granularity: 'year',
  points: [
    { period: '2023', valueEur: 1000, contracts: 2, partial: false },
    { period: '2024', valueEur: 1500, contracts: 3, partial: false },
    { period: '2025', valueEur: 400, contracts: 1, partial: true },
  ],
  years: [
    { year: '2023', valueEur: 1000, contracts: 2, yoyPct: null, partial: true },
    { year: '2024', valueEur: 1500, contracts: 3, yoyPct: null, partial: false },
    { year: '2025', valueEur: 400, contracts: 1, yoyPct: 0.5, partial: true },
  ],
  sectors: [{ code: '45', label: 'Строителство', short: 'Строителство' }],
  totalValueEur: 2900,
  coverage: { dated: 6, total: 7, pct: 0.857, omitted: 1, omittedEur: 100 },
  scope: { sector: null, funding: 'all', granularity: 'year' },
};

async function render(url: string) {
  const Stub = createRoutesStub([
    {
      path: '/trends',
      Component: Trends as never,
      loader: (args) => loader({ ...args, context: { cloudflare: { env: {} } } } as never),
    },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={[url]} />);
  });
}

const text = () => container.textContent ?? '';

describe('/trends', () => {
  it('draws the yearly chart and table, marking partial years', async () => {
    getSpendingTrend.mockResolvedValue(base);
    await render('/trends?g=year&sector=45&funding=eu');
    expect(getSpendingTrend).toHaveBeenCalledWith(
      {},
      { sector: '45', funding: 'eu', granularity: 'year' },
    );
    expect(text()).toContain('Разходи по години');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(text()).toContain('(частично)');
    expect(text()).toContain('+50');
    expect(text()).toContain('Първата година (2023) също е непълна');
    expect(text()).not.toContain('Няма достатъчно данни');
  });

  it('shows the monthly empty state and drops an unknown sector with a notice', async () => {
    getSpendingTrend.mockResolvedValue({
      ...base,
      granularity: 'month',
      points: [],
      years: [{ year: '2025', valueEur: 0, contracts: 0, yoyPct: null, partial: false }],
    });
    await render('/trends?sector=zz');
    expect(getSpendingTrend).toHaveBeenCalledWith(
      {},
      { sector: null, funding: 'all', granularity: 'month' },
    );
    expect(text()).toContain('Разходи по месеци');
    expect(text()).toContain('Няма достатъчно данни за избраните филтри.');
    expect(text()).toContain('Избраният сектор не съществува.');
    expect(text()).not.toContain('Първата година');
  });
});
