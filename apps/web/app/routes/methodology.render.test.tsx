// The general methodology must describe the site as it is: every source the pages draw on, one rule for
// how names are shown, and no internal column names in the public copy.
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
  getMethodologyStats: vi.fn(),
  getPartialStartYear: vi.fn(async () => '2020'),
}));
vi.mock('@sigma/db', () => db);

import Methodology, { loader, meta } from './methodology';

const loaderData = {
  totals: {
    contracts: 1200,
    valueEur: 5e8,
    authorities: 40,
    bidders: 300,
    suspect: 2,
    asOf: '2026-09-30',
    refreshedAt: '2026-10-01',
  },
  firstDate: '2020-01-02',
  lastDate: '2026-09-30',
  coverage: { bids: 0.8, eu: 0.3, duration: 0.5, lot: 0.4 },
  sectors: 45,
  valueVerdicts: {
    ok: 1100,
    value_low: 10,
    value_suspect: 3,
    annex_suspect: 1,
    annex_total_suspect: 1,
    review: 5,
    missing: 4,
    framework: 6,
  },
  partialStartYear: null,
};

function text(data: typeof loaderData = loaderData): string {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Methodology {...({ loaderData: data } as unknown as Parameters<typeof Methodology>[0])} />
    </MemoryRouter>,
  );
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('/methodology', () => {
  it('names every source the site draws on, the FX rates and the map boundaries included', () => {
    const t = text();
    expect(t).toContain('Издание 2');
    for (const source of [
      'АОП / ЦАИС ЕОП',
      'Търговски регистър',
      'регистър на декларациите',
      'Агенцията за публичните предприятия и контрол',
      'Европейската централна банка',
      'EuroGeographics',
      'Шрифтът ADYS',
    ])
      expect(t).toContain(source);
  });

  it('says one thing about names and nothing about owners and risk signals being future work', () => {
    const t = text();
    expect(t).not.toMatch(/канонизирани|каноничен вид|в процес на разработка|първата версия/);
    expect(t).toContain('най-честото ѝ изписване в източника');
  });

  it('keeps internal table and column names out of the public copy', () => {
    expect(text()).not.toMatch(
      /GROUP BY|substr\(|tenders\.|bidders\.|authorities\.|contracts\.|value_flag|bids_received/,
    );
  });

  it('cites the edition of the merger guidelines its concentration mark comes from', () => {
    const t = text();
    expect(t).toContain('2010');
    expect(t).not.toContain('0.25');
  });

  it('reads the live figures and the partial first year, and says both years are partial', async () => {
    db.getMethodologyStats.mockResolvedValueOnce(loaderData);
    const data = await loader({ context: { cloudflare: { env: { DB: {} } } } } as never);
    expect(data.partialStartYear).toBe('2020');
    expect(text(data as typeof loaderData)).toMatch(/2020 и 2026\sг\. частично/);
  });

  it('is indexed under its own title', () => {
    const tags = meta({ matches: [] } as never) as Array<{ title?: string }>;
    expect(tags.some((t) => t.title === 'Методология и речник — СИГМА')).toBe(true);
  });
});
