// @vitest-environment jsdom
// Deep render tests for the /overruns route (leaderboard + scatter + inspector + sector/authority
// tables), following the pattern of conflicts.render.test.tsx: mount the ACTUAL default component via
// a real React Router data router (createRoutesStub) with realistic loaderData.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { OverrunAuthorityRow, OverrunRow, OverrunSectorRow } from '@sigma/db';
import Overruns, { headers, meta } from './overruns';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function row(over: Partial<OverrunRow> = {}): OverrunRow {
  return {
    contractId: 'c1',
    contractSlug: 'c1-slug',
    subject: 'Договор за строеж',
    authorityName: 'Община Х',
    authoritySlug: 'obshtina-h',
    authorityEik: '000000000',
    bidderName: 'Фирма ООД',
    bidderSlug: 'firma-ood',
    bidderEik: '111111111',
    signingEur: 1_000_000,
    currentEur: 1_500_000,
    deltaEur: 500_000,
    pct: 0.5,
    annexCount: 2,
    sectorLabel: 'Строителство',
    cpvCode: '45233110',
    cpvDescription: 'Строеж на магистрали',
    procedureType: 'Открита процедура',
    euFunded: true,
    euProgramme: 'ОПРР',
    signedAt: '2020-01-01',
    endDate: '2019-01-01',
    durationDays: 365,
    ...over,
  };
}

const AUTHORITY_ROW: OverrunAuthorityRow = {
  authorityName: 'Община Х',
  authoritySlug: 'obshtina-h',
  totalOverrunEur: 500_000,
  count: 3,
  growth: 0.3,
};

const SECTOR_ROW: OverrunSectorRow = {
  code: '45',
  label: 'Строителство',
  bucket: 'works',
  riskEur: 200_000,
  growth: 0.2,
  contracts: 5,
};

function loaderData(
  over: {
    rows?: OverrunRow[];
    byAuthority?: OverrunAuthorityRow[];
    bySector?: OverrunSectorRow[];
    by?: 'absolute' | 'percent';
  } = {},
) {
  const rows = over.rows ?? [row(), row({ contractId: 'c2', contractSlug: 'c2-slug' })];
  return {
    data: {
      corpus: {
        totalOverrunEur: 500_000,
        count: rows.length,
        avgPct: 0.4,
        medianPct: 0.3,
        corpusSigningEur: 2_000_000,
        shareOfSigning: 0.25,
      },
      rows,
      byAuthority: over.byAuthority ?? [AUTHORITY_ROW],
      bySector: over.bySector ?? [SECTOR_ROW],
    },
    by: over.by ?? 'absolute',
    annexesByContract: {
      c1: [{ seq: 1, date: '2020-06-01', reason: 'обем', deltaEur: 200_000 }],
    },
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

async function renderOverruns(data: ReturnType<typeof loaderData>) {
  const Stub = createRoutesStub([
    { path: '/overruns', Component: Overruns, loader: () => data },
    { path: '/contracts/:slug', Component: () => null },
    { path: '/authorities/:slug', Component: () => null },
    { path: '/companies/:slug', Component: () => null },
    { path: '/methodology', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/overruns']} />);
  });
}

const text = () => container.textContent ?? '';

describe('/overruns route — render', () => {
  it('meta() titles the page and headers() sets a public cache', () => {
    const tags = meta({ matches: [] } as never);
    expect(JSON.stringify(tags)).toContain('Раздуване');
    expect(headers()['Cache-Control']).toMatch(/public/);
  });

  it('renders the leaderboard, scatter, sector and authority sections for populated data', async () => {
    await renderOverruns(loaderData());
    expect(text()).toContain('Най-голямо');
    expect(text()).toContain('Облак на');
    expect(text()).toContain('Раздуване по');
    expect(text()).toContain('институции');
    expect(container.querySelectorAll('.ov-row').length).toBe(2);
    expect(container.querySelector('.ov-sector-table')).not.toBeNull();
    expect(container.querySelector('.ov-auth-table')).not.toBeNull();
  });

  it('marks the active sort toggle via aria-current, matching the loader by param', async () => {
    await renderOverruns(loaderData({ by: 'percent' }));
    const links = [...container.querySelectorAll('.ov-seg a')];
    const percentLink = links.find((a) => a.textContent?.includes('процентно'));
    expect(percentLink?.getAttribute('aria-current')).toBe('true');
  });

  it('switches the inspector to the clicked leaderboard row', async () => {
    await renderOverruns(loaderData());
    expect(text()).toContain('Избран договор · #1');
    const buttons = [...container.querySelectorAll('.ov-row')];
    await act(async () => {
      (buttons[1] as HTMLButtonElement).click();
    });
    expect(text()).toContain('Избран договор · #2');
  });

  it('renders the closed-contract status badge for a past end date', async () => {
    await renderOverruns(loaderData({ rows: [row({ endDate: '2019-01-01' })] }));
    expect(container.querySelector('.ov-status-badge.closed')).not.toBeNull();
  });

  it('renders the scatter as small/muted for a contract far below the big-delta threshold, and selects it on click', async () => {
    await renderOverruns(
      loaderData({
        rows: [
          row({ contractId: 'c1', contractSlug: 'c1-slug', deltaEur: 900_000 }),
          row({ contractId: 'c2', contractSlug: 'c2-slug', deltaEur: 10_000 }),
        ],
      }),
    );
    const dots = [...container.querySelectorAll('.ov-scatter-dot')];
    expect(dots.length).toBe(2);
    await act(async () => {
      (dots[1] as unknown as SVGCircleElement).dispatchEvent(
        new window.MouseEvent('click', { bubbles: true }),
      );
    });
    expect(text()).toContain('Избран договор · #2');
  });

  it('falls back to Callouts when there are no institutions, sectors, or overrun rows', async () => {
    await renderOverruns(loaderData({ rows: [], byAuthority: [], bySector: [] }));
    expect(text()).toContain('Няма данни по институции');
    expect(text()).toContain('Няма данни по сектори');
    expect(text()).toContain('Няма раздути договори');
    expect(container.querySelector('.ov-row')).toBeNull();
  });
});
