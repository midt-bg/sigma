// @vitest-environment jsdom
// /map through its real loader (data layer stubbed): the choropleth, both tables and the notice for
// unknown filters.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { RegionalSpending } from '@sigma/api-contract';

const { getRegionalSpending } = vi.hoisted(() => ({ getRegionalSpending: vi.fn() }));
vi.mock('@sigma/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sigma/db')>()),
  getRegionalSpending,
  getDb: (env: unknown) => env,
}));
vi.mock('../lib/coverage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/coverage')>()),
  getCoverageMeta: async () => ({
    asOf: '2025-06-30',
    refreshedAt: null,
    coverageEndYear: 2025,
    partialStartYear: null,
  }),
}));

import MapRoute, { loader } from './map';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  getRegionalSpending.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const region = (nuts3: string, name: string, valueEur: number) => ({
  nuts3,
  name,
  nuts2: 'BG31',
  nuts2Name: 'Северозападен',
  valueEur,
  contracts: 3,
  authorities: 2,
});
const data = (regions: RegionalSpending['regions'], totalValueEur: number): RegionalSpending => ({
  regions,
  macroRegions: [{ nuts2: 'BG31', name: 'Северозападен', valueEur: totalValueEur, contracts: 9 }],
  sectors: [{ code: '45', label: 'Строителство', short: 'Строителство' }],
  unattributed: { valueEur: 500, contracts: 1, authorities: 1 },
  coverage: { withRegion: 9, total: 10, pct: 0.9 },
  totalValueEur,
  scope: { sector: null, year: null, funding: 'all' },
});

async function render(url: string) {
  const Stub = createRoutesStub([
    {
      path: '/map',
      Component: MapRoute as never,
      loader: (args) => loader({ ...args, context: { cloudflare: { env: {} } } } as never),
    },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={[url]} />);
  });
}

const text = () => container.textContent ?? '';

describe('/map', () => {
  it('colours the regions by spend and ranks them', async () => {
    getRegionalSpending.mockResolvedValue(
      data(
        [
          region('BG311', 'Видин', 9000),
          region('BG312', 'Монтана', 1000),
          region('BG313', 'Враца', 0),
        ],
        10_000,
      ),
    );
    await render('/map?sector=45&year=2024&funding=national');
    expect(getRegionalSpending).toHaveBeenCalledWith(
      {},
      { sector: '45', year: '2024', funding: 'national' },
    );
    const titles = [...container.querySelectorAll('svg path title')].map((t) => t.textContent);
    expect(titles.some((t) => t?.startsWith('Видин: '))).toBe(true);
    // A region the data does not carry is labelled by its code.
    expect(titles).toContain('BG411');
    expect(container.querySelectorAll('table')).toHaveLength(2);
    expect(text()).toContain('90%');
    expect(text()).not.toContain('Непознат филтър');
  });

  it('draws an all-zero map and drops unknown filters with a notice', async () => {
    getRegionalSpending.mockResolvedValue(data([region('BG311', 'Видин', 0)], 0));
    await render('/map?sector=zz&year=1900');
    expect(getRegionalSpending).toHaveBeenCalledWith(
      {},
      { sector: null, year: null, funding: 'all' },
    );
    expect(text()).toContain('Избраният сектор не съществува.');
    expect(text()).toContain('Избраната година е извън обхвата.');
  });
});
