// The general methodology must describe the site as it is: every source the pages draw on, one rule for
// how names are shown, and no internal column names in the public copy.
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import Methodology from './methodology';

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

function text(): string {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Methodology {...({ loaderData } as never)} />
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
});
