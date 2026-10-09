// @vitest-environment jsdom
// Deep render test for the /analytics landing page: five AnalyzeCards + their decorative thumbnails,
// mounted through a real React Router data router (createRoutesStub) with realistic loaderData —
// same pattern as conflicts.render.test.tsx / overruns.render.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import Analytics, { headers, meta } from './analytics';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function loaderData(
  opaque: { latestShare: number; latestYear: string; ppChange: number; firstYear: string } | null,
) {
  return {
    overruns: { totalOverrunEur: 1_000_000, count: 10, medianPct: 0.3 },
    flows: { authorities: 42, pairs: 100 },
    region: { regionCount: 28, sofiaShare: 0.4 },
    trend: { avgYoy: 0.12, peakPeriod: '2022-06' },
    opaque,
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

async function renderAnalytics(data: ReturnType<typeof loaderData>) {
  const Stub = createRoutesStub([
    { path: '/analytics', Component: Analytics, loader: () => data },
    { path: '/overruns', Component: () => null },
    { path: '/flows', Component: () => null },
    { path: '/map', Component: () => null },
    { path: '/trends', Component: () => null },
    { path: '/competition', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/analytics']} />);
  });
}

const text = () => container.textContent ?? '';

describe('/analytics route — render', () => {
  it('meta() titles the page and headers() sets a public cache', () => {
    const tags = meta({ matches: [] } as never);
    expect(JSON.stringify(tags)).toContain('Анализи');
    expect(headers()['Cache-Control']).toMatch(/public/);
  });

  it('renders all five analysis cards with their headline stats', async () => {
    await renderAnalytics(
      loaderData({ latestShare: 0.22, latestYear: '2024', ppChange: 0.05, firstYear: '2018' }),
    );
    expect(container.querySelectorAll('.az-card').length).toBe(5);
    expect(text()).toContain('Раздуване');
    expect(text()).toContain('Потоци');
    expect(text()).toContain('Карта');
    expect(text()).toContain('Тренд');
    expect(text()).toContain('Конкуренция');
    expect(text()).toContain('НЕПРОЗРАЧНИ 2024');
  });

  it('never fabricates a competition stat when opaque data is absent', async () => {
    await renderAnalytics(loaderData(null));
    const competitionCard = [...container.querySelectorAll('.az-card')].find((c) =>
      c.textContent?.includes('ПРОЗРАЧНОСТ'),
    );
    expect(competitionCard?.textContent).toContain('—');
    expect(competitionCard?.textContent).not.toContain('НЕПРОЗРАЧНИ 20');
  });

  it('renders a stretched link from each card to its target page', async () => {
    await renderAnalytics(loaderData(null));
    const hrefs = [...container.querySelectorAll('.az-card-stretch')].map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs).toEqual(['/overruns', '/flows', '/map', '/trends', '/competition']);
  });
});
