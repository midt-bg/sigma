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

  describe('inspector „Детайли по договора" grid', () => {
    const fieldOf = (key: string) =>
      [...container.querySelectorAll('.ov-insp-grid-row')]
        .find((r) => r.querySelector('.ov-insp-grid-key')?.textContent === key)
        ?.querySelector('.ov-insp-grid-val')?.textContent;

    it('joins the EU programme to the financing label, or says just „Европейско" without one', async () => {
      await renderOverruns(loaderData({ rows: [row({ euFunded: true, euProgramme: 'ОПРР' })] }));
      expect(fieldOf('Финансиране')).toBe('Европейско · ОПРР');
      act(() => root.unmount());
      root = createRoot(container);
      await renderOverruns(loaderData({ rows: [row({ euFunded: true, euProgramme: null })] }));
      expect(fieldOf('Финансиране')).toBe('Европейско');
    });

    it('labels national funding and never fabricates a source when the flag is unknown', async () => {
      await renderOverruns(loaderData({ rows: [row({ euFunded: false })] }));
      expect(fieldOf('Финансиране')).toBe('Национално');
      act(() => root.unmount());
      root = createRoot(container);
      await renderOverruns(loaderData({ rows: [row({ euFunded: null })] }));
      expect(fieldOf('Финансиране')).toBe('—');
    });

    it('shows the CPV code with its description, the bare code, or a dash', async () => {
      await renderOverruns(loaderData({ rows: [row()] }));
      expect(fieldOf('CPV код')).toBe('45233110 — Строеж на магистрали');
      act(() => root.unmount());
      root = createRoot(container);
      await renderOverruns(loaderData({ rows: [row({ cpvDescription: null })] }));
      expect(fieldOf('CPV код')).toBe('45233110');
      act(() => root.unmount());
      root = createRoot(container);
      await renderOverruns(loaderData({ rows: [row({ cpvCode: null, cpvDescription: null })] }));
      expect(fieldOf('CPV код')).toBe('—');
    });

    it('prefers the real end date for the term, else the duration in days, else omits the row', async () => {
      await renderOverruns(loaderData({ rows: [row({ endDate: '2024-12-31' })] }));
      expect(fieldOf('Срок')).toContain('2024');
      act(() => root.unmount());
      root = createRoot(container);
      await renderOverruns(loaderData({ rows: [row({ endDate: null, durationDays: 540 })] }));
      expect(fieldOf('Срок')).toBe('540 дни');
      act(() => root.unmount());
      root = createRoot(container);
      await renderOverruns(loaderData({ rows: [row({ endDate: null, durationDays: null })] }));
      expect(fieldOf('Срок')).toBeUndefined();
    });

    it('marks missing identifiers honestly: no ЕИК for the buyer, unconfirmed for the bidder, no procedure', async () => {
      await renderOverruns(
        loaderData({
          rows: [row({ authorityEik: '', bidderEik: '', procedureType: null })],
        }),
      );
      expect(fieldOf('Възложител · ЕИК')).toBe('Община Х · —');
      expect(fieldOf('Изпълнител · ЕИК')).toBe('Фирма ООД · непотвърден');
      expect(fieldOf('Процедура')).toBe('—');
    });

    it('omits the status badge when the contract has no usable end date', async () => {
      await renderOverruns(loaderData({ rows: [row({ endDate: null })] }));
      expect(container.querySelector('.ov-status-badge')).toBeNull();
    });
  });

  describe('annex history', () => {
    const withAnnexes = (annexes: unknown[]) => {
      const data = loaderData({ rows: [row()] });
      (data.annexesByContract as Record<string, unknown[]>).c1 = annexes;
      return data;
    };

    it('signs an increase, leaves a reduction with its own minus, and dashes an unknown delta', async () => {
      await renderOverruns(
        withAnnexes([
          { seq: 1, date: '2020-06-01', reason: 'обем', deltaEur: 200_000 },
          { seq: 2, date: '2020-07-01', reason: null, deltaEur: -100 },
          { seq: 3, date: null, reason: null, deltaEur: null },
        ]),
      );
      const deltas = [...container.querySelectorAll('.ov-annex-delta')].map((d) => d.textContent);
      expect(deltas[0]).toMatch(/^\+/);
      expect(deltas[1]).not.toMatch(/^\+/);
      expect(deltas[1]).not.toContain('+');
      expect(deltas[2]).toBe('—');
      // Only the annex that carries a reason renders one.
      expect(container.querySelectorAll('.ov-annex-reason').length).toBe(1);
    });

    it('says the breakdown is unavailable when the contract has no annex rows', async () => {
      await renderOverruns(withAnnexes([]));
      expect(container.querySelector('.ov-annex-empty')).not.toBeNull();
      expect(container.querySelector('.ov-annex-list')).toBeNull();
    });
  });

  describe('scatter axis and sector/authority tables', () => {
    it('writes growth beyond +1000% on the axis in thousands with a decimal comma', async () => {
      await renderOverruns(
        loaderData({
          rows: [
            row({ contractId: 'c1', pct: 10 }), // +1000%
            row({ contractId: 'c2', contractSlug: 'c2-slug', pct: 100 }), // +10 000%
          ],
        }),
      );
      const axis = container.querySelector('.ov-scatter-svg')!.textContent ?? '';
      expect(axis).toContain('+1к%');
      expect(axis).toContain('+2,5к%');
      expect(axis).toContain('+10к%');
    });

    it('accents only the single fastest-growing sector, and only when there is more than one', async () => {
      const sector = (code: string, growth: number): OverrunSectorRow => ({
        ...SECTOR_ROW,
        code,
        growth,
      });
      await renderOverruns(
        loaderData({ bySector: [sector('45', 0.2), sector('72', 0.9), sector('33', 0.4)] }),
      );
      const top = [...container.querySelectorAll('.ov-sector-growth.is-top')];
      expect(top).toHaveLength(1);
      expect(top[0]!.closest('tr')!.querySelector('.ov-sector-code')!.textContent).toBe('72');
      act(() => root.unmount());
      root = createRoot(container);
      await renderOverruns(loaderData({ bySector: [sector('45', 0.2)] }));
      expect(container.querySelector('.ov-sector-growth.is-top')).toBeNull();
    });

    it('adds the „other" bucket to the legend only when a sector falls in it, and dashes a blank code', async () => {
      await renderOverruns(loaderData());
      const legendCount = () => container.querySelectorAll('.ov-bucket-legend-item').length;
      expect(legendCount()).toBe(3);
      act(() => root.unmount());
      root = createRoot(container);
      await renderOverruns(
        loaderData({ bySector: [{ ...SECTOR_ROW, code: '', label: 'Без код', bucket: 'other' }] }),
      );
      expect(legendCount()).toBe(4);
      expect(container.querySelector('.ov-sector-code')!.textContent).toBe('—');
    });

    it('accents only the top institution row', async () => {
      await renderOverruns(
        loaderData({
          byAuthority: [
            AUTHORITY_ROW,
            { ...AUTHORITY_ROW, authoritySlug: 'other', authorityName: 'Друга', growth: 0.1 },
          ],
        }),
      );
      const growth = [...container.querySelectorAll('.ov-auth-growth')];
      expect(growth[0]!.className).toContain('is-top');
      expect(growth[1]!.className).not.toContain('is-top');
    });

    it('omits the share-of-signing readout when nothing was signed', async () => {
      const data = loaderData();
      data.data.corpus.shareOfSigning = 0;
      await renderOverruns(data);
      const label = container
        .querySelector('.ov-hk-l .metric-info-btn')!
        .getAttribute('aria-label');
      expect(label).not.toContain('от общо подписаната');
    });

    it('announces navigation state for assistive tech', async () => {
      await renderOverruns(loaderData());
      expect(container.querySelector('[role="status"]')!.textContent).toBe(
        'Класацията е обновена.',
      );
    });
  });
});
