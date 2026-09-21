// @vitest-environment jsdom
// Render tests for the /quality page: the empty (pre-ETL) state, a fully populated page, and the
// sparse/unknown/scoped variants that flip its conditional branches. The loader is covered in
// quality.loader.test.ts; the baseline smoke tests are in quality.render.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type {
  QualityContractRow,
  QualityData,
  QualityLeaves,
  QualityPillars,
  QualityRankRow,
  QualityScorecard,
} from '@sigma/api-contract';

import Quality from './quality';

const P: QualityPillars = { a: 0.2, b: 0.6, c: 0.75, d: 0.5, e: 0.9 };
const NULL_P: QualityPillars = { a: null, b: null, c: null, d: null, e: null };

const rankRow = (over: Partial<QualityRankRow> = {}): QualityRankRow => ({
  key: 'auth:1',
  href: '/authorities/a-1',
  name: 'Институция А',
  sub: 'община',
  avgOverall: 0.42,
  pillars: P,
  totalContracts: 40,
  scoredContracts: 25,
  meanCoverage: 0.78,
  coverageTier: 'medium',
  ...over,
});

const contractRow = (over: Partial<QualityContractRow> = {}): QualityContractRow => ({
  id: 'c:1',
  slug: 'c-1',
  signedAt: '2024-03-01',
  cpvDivision: '45',
  authorityName: 'Институция А',
  authoritySlug: 'a-1',
  bidderDisplayName: 'Фирма Х',
  bidderSlug: 'f-x',
  amountEur: 1000,
  overall: 0.321,
  pillars: P,
  coverage: 0.78,
  coverageTier: 'medium',
  valueFlag: 'ok',
  ...over,
});

const LEAVES_FULL: QualityLeaves = {
  bidsReceived: 1,
  singleOffer: true,
  smeRate: 0.5,
  isEauction: false,
  procedureType: 'Открита процедура',
  isAccelerated: true,
  bidWindowDays: 22.4,
  annexCount: 2,
  costOverrunRatio: 1.4,
  estimateDevRatio: 0.35,
  firstAmendShock: false,
  authorityHhi: 0.74,
  repeatWinIntensity: 0.71,
  edgeAgeYears: 9,
  sectorWinShare: 0.4,
  dateFlag: 'ok',
  subcontractPassthrough: 0.3,
  durationDays: 1200,
  correctionsCount: 1,
};
const LEAVES_NULL: QualityLeaves = {
  bidsReceived: null,
  singleOffer: null,
  smeRate: null,
  isEauction: null,
  procedureType: null,
  isAccelerated: null,
  bidWindowDays: null,
  annexCount: null,
  costOverrunRatio: null,
  estimateDevRatio: null,
  firstAmendShock: null,
  authorityHhi: null,
  repeatWinIntensity: null,
  edgeAgeYears: null,
  sectorWinShare: null,
  dateFlag: null,
  subcontractPassthrough: null,
  durationDays: null,
  correctionsCount: null,
};

const card = (over: Partial<QualityScorecard> = {}): QualityScorecard => ({
  ...contractRow(),
  known: true,
  wmean: 0.4,
  worst: 0.2,
  worstPillar: 'a',
  effectiveWeights: { a: 0.3, b: 0.15, c: 0.25, d: 0.2, e: 0.1 },
  leaves: LEAVES_FULL,
  coverageFlags: { bids: true, sme: false, estimate: true, overrun: false },
  ...over,
});

function makeData(over: Partial<QualityData> = {}, scope: Partial<QualityData['scope']> = {}) {
  const base: QualityData = {
    overview: {
      totalContracts: 4,
      scoredContracts: 3,
      suspectContracts: 1,
      avgOverall: 0.556,
      meanCoverage: 0.7,
      pillars: P,
      histogram: [
        { bin: 6, count: 1 },
        { bin: 11, count: 1 },
        { bin: 15, count: 1 },
        { bin: 99, count: 5 }, // out-of-range bin is ignored, never crashes
      ],
      confidence: { high: 1, medium: 1, low: 1, none: 1 },
    },
    ranking: [rankRow(), rankRow({ key: 'auth:2', href: null, name: 'Б', sub: null })],
    contracts: [
      contractRow(),
      contractRow({ id: 'c:2', valueFlag: 'value_suspect', overall: null, amountEur: null }),
      contractRow({ id: 'c:3', valueFlag: 'annex_suspect', cpvDivision: null, signedAt: null }),
    ],
    scorecard: card(),
    scope: {
      grain: 'authority',
      sort: 'score',
      sortDir: 'asc',
      contractSort: 'score',
      sel: null,
      band: null,
      contractId: null,
      rankFrom: null,
      rankTo: null,
      top: 20,
      minScored: 5,
      ...scope,
    },
    ...over,
  };
  return base;
}

describe('/quality page render', () => {
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

  function render(data: QualityData | null, url = '/quality') {
    const router = createMemoryRouter(
      [
        {
          path: '/quality',
          element: (
            <Quality {...({ loaderData: { data } } as unknown as Parameters<typeof Quality>[0])} />
          ),
        },
      ],
      { initialEntries: [url] },
    );
    act(() => {
      root.render(<RouterProvider router={router} />);
    });
  }

  it('shows the not-yet-derived empty state when the loader returned no data', () => {
    render(null);
    expect(container.textContent).toContain('Оценките се изчисляват');
    expect(container.querySelector('.q-scorecard')).toBeNull();
  });

  it('renders the full page: totals, pillars, histogram, ranking, contract cards, scorecard', () => {
    render(makeData());
    expect(container.querySelectorAll('.q-pillar-card')).toHaveLength(5);
    expect(container.querySelectorAll('.q-bin-link')).toHaveLength(20);
    expect(container.querySelectorAll('.q-card')).toHaveLength(3);
    expect(container.querySelector('.q-scorecard')).not.toBeNull();
    expect(container.textContent).toContain('value_suspect · без оценка');
    expect(container.textContent).toContain('annex_suspect · C само от броя анекси');
    expect(container.textContent).toContain('единствена');
    expect(container.querySelector('.q-mean')).not.toBeNull();
    // ranking row without an entity page renders plain text, not a link
    expect(container.textContent).toContain('Институция А');
    // no band / range / selection chrome by default
    expect(container.querySelector('.q-band-chip')).toBeNull();
  });

  it('shows band chip, selection hint and range chip, and preserves them in links', () => {
    render(
      makeData(
        {},
        {
          grain: 'supplier',
          sort: 'contracts',
          sortDir: 'asc',
          contractSort: 'value',
          sel: 'auth:1',
          band: '6',
          contractId: 'c:1',
          rankFrom: 20,
          rankTo: 60,
        },
      ),
    );
    expect(container.querySelector('.q-band-chip')?.textContent).toContain('30–35');
    expect(container.textContent).toContain('изчисти избора');
    expect(container.textContent).toContain('индекс 20–60');
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.some((h) => h.includes('sel=auth%3A1') && h.includes('band=6'))).toBe(true);
    expect(container.querySelector('input[name="grain"]')).not.toBeNull();
    expect(container.querySelector('input[name="csort"]')).not.toBeNull();
    expect(container.querySelector('input[name="contract"]')).not.toBeNull();
  });

  it.each([
    ['weak', 'слабо (0–49)'],
    ['mid', 'средно (50–69)'],
    ['good', 'добро (70–100)'],
    ['bogus', 'bogus'],
  ])('labels the named band %s', (b, label) => {
    render(makeData({}, { band: b, sortDir: 'desc', rankFrom: 10 }));
    expect(container.querySelector('.q-band-chip')?.textContent).toContain(label);
  });

  it('marks the selected zone / bin as current', () => {
    for (const b of ['weak', 'mid', 'good', '11']) {
      render(makeData({}, { band: b }));
      expect(container.querySelector('.q-hist.has-band')).not.toBeNull();
      expect(
        container.querySelector(
          '[aria-current="true"].q-bin-link, [aria-current="true"].q-zone-link',
        ),
      ).not.toBeNull();
    }
  });

  it('renders empty ranking/contracts with a range-clear affordance and an unfiltered variant', () => {
    render(makeData({ ranking: [], contracts: [], scorecard: null }, { rankTo: 30, band: '3' }));
    expect(container.textContent).toContain('Няма редове със среден индекс 0–30');
    expect(container.textContent).toContain('Изчисти филтъра по индекс');
    expect(container.querySelector('.q-scorecard')).toBeNull();

    render(makeData({ ranking: [], contracts: [], scorecard: null }));
    expect(container.textContent).toContain('Няма достатъчно данни за тази разбивка');
    expect(container.textContent).toContain('Няма оценени договори за избрания разрез');
  });

  it('renders a sparse corpus without fabricating zeros', () => {
    render(
      makeData({
        overview: {
          totalContracts: 0,
          scoredContracts: 0,
          suspectContracts: 0,
          avgOverall: null,
          meanCoverage: null,
          pillars: NULL_P,
          histogram: [],
          confidence: { high: 0, medium: 0, low: 0, none: 0 },
        },
        ranking: [rankRow({ pillars: NULL_P, meanCoverage: null, coverageTier: 'none' })],
        contracts: [contractRow({ pillars: NULL_P, overall: null, coverageTier: 'none' })],
        scorecard: null,
      }),
    );
    expect(container.textContent).toContain('Няма данни.');
    expect(container.querySelector('.q-mean')).toBeNull();
    expect(container.textContent).toContain('—/100');
  });

  it('renders the value_suspect unknown scorecard and the low-coverage unknown scorecard', () => {
    render(
      makeData({
        scorecard: card({
          known: false,
          overall: null,
          wmean: null,
          worst: null,
          worstPillar: null,
          valueFlag: 'value_suspect',
        }),
      }),
    );
    expect(container.querySelector('.q-sc-ring.is-unknown')).not.toBeNull();
    expect(container.querySelector('.q-gate-note')?.textContent).toContain('value_suspect');

    render(
      makeData({
        scorecard: card({
          known: false,
          overall: null,
          wmean: null,
          worst: null,
          worstPillar: null,
          valueFlag: 'ok',
          cpvDivision: null,
        }),
      }),
    );
    expect(container.querySelector('.q-gate-note')?.textContent).toContain('Недостатъчно данни');
  });

  it('renders scorecard leaf fallbacks and the annex_suspect / review gate notes', () => {
    render(
      makeData({
        scorecard: card({
          leaves: LEAVES_NULL,
          valueFlag: 'annex_suspect',
          effectiveWeights: { a: null, b: 0.5, c: 0.5, d: null, e: null },
          pillars: NULL_P,
          worstPillar: null,
          coverageFlags: { bids: false, sme: true, estimate: false, overrun: true },
        }),
      }),
    );
    expect(container.textContent).toContain('отпада');
    expect(container.textContent).toContain('Праг: annex_suspect');

    render(
      makeData({
        scorecard: card({
          valueFlag: 'review',
          leaves: {
            ...LEAVES_FULL,
            singleOffer: false,
            dateFlag: 'signed_before_publication',
            isEauction: true,
          },
        }),
      }),
    );
    expect(container.textContent).toContain('Праг: review');
    expect(container.textContent).toContain('подпис преди публикуване');
    expect(container.textContent).toContain('да');
  });

  it('covers the remaining scope variants: sel not in the ranking, non-authority grain, one-sided range', () => {
    render(makeData({}, { grain: 'sector', sel: 'not-in-ranking' }));
    expect(container.textContent).toContain('Подреждане:');
    expect(container.textContent).not.toContain('Само редове с поне');
    expect(container.textContent).not.toContain('изчисти избора');

    render(makeData({ ranking: [], contracts: [], scorecard: null }, { rankFrom: 80 }));
    expect(container.textContent).toContain('Няма редове със среден индекс 80–100');
  });
});
