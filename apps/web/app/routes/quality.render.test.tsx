// @vitest-environment jsdom
// Render smoke tests for the /quality (contract health index) page: the empty-data state, the
// full page with a ranking table + scored contract list, an "known: false" scorecard, and the
// score/band boundary agreement (#188 review) exercised through the rendered DOM.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type {
  QualityContractRow,
  QualityData,
  QualityPillars,
  QualityRankRow,
  QualityScorecard,
} from '@sigma/api-contract';

import Quality from './quality';

const pillars: QualityPillars = { a: 0.6, b: 0.7, c: 0.8, d: 0.5, e: 0.9 };

const rankRow: QualityRankRow = {
  key: 'auth-1',
  href: '/authorities/auth-1',
  name: 'Община Х',
  sub: 'Община',
  avgOverall: 0.72,
  pillars,
  totalContracts: 20,
  scoredContracts: 18,
  meanCoverage: 0.8,
  coverageTier: 'high',
};

const contractRow: QualityContractRow = {
  id: 'c1',
  slug: 'c1',
  signedAt: '2024-05-01',
  cpvDivision: '45',
  authorityName: 'Община Х',
  authoritySlug: 'auth-1',
  bidderDisplayName: 'Фирма У',
  bidderSlug: 'firma-u',
  amountEur: 12000,
  overall: 0.695,
  pillars,
  coverage: 0.8,
  coverageTier: 'high',
  valueFlag: 'ok',
};

const scorecard: QualityScorecard = {
  ...contractRow,
  known: true,
  wmean: 0.7,
  worst: 0.5,
  worstPillar: 'd',
  effectiveWeights: { a: 0.2, b: 0.2, c: 0.2, d: 0.2, e: 0.2 },
  leaves: {
    bidsReceived: 3,
    singleOffer: false,
    smeRate: 0.5,
    isEauction: true,
    procedureType: 'open',
    isAccelerated: false,
    bidWindowDays: 20,
    annexCount: 1,
    costOverrunRatio: 0.1,
    estimateDevRatio: 0.05,
    firstAmendShock: false,
    authorityHhi: 0.3,
    repeatWinIntensity: 0.2,
    edgeAgeYears: 1,
    sectorWinShare: 0.15,
    dateFlag: null,
    subcontractPassthrough: 0,
    durationDays: 90,
    correctionsCount: 0,
  },
  coverageFlags: { bids: true, sme: true, estimate: true, overrun: true },
};

function data(overrides: Partial<QualityData> = {}): QualityData {
  return {
    overview: {
      totalContracts: 100,
      scoredContracts: 90,
      suspectContracts: 2,
      avgOverall: 0.695,
      meanCoverage: 0.8,
      pillars,
      histogram: Array.from({ length: 20 }, (_, i) => ({ bin: i, count: i === 14 ? 10 : 1 })),
      confidence: { high: 60, medium: 20, low: 8, none: 2 },
    },
    ranking: [rankRow],
    contracts: [contractRow],
    scorecard,
    scope: {
      grain: 'authority',
      sort: 'score',
      sortDir: 'asc',
      contractSort: 'score',
      sel: null,
      band: null,
      contractId: 'c1',
      rankFrom: null,
      rankTo: null,
      top: 20,
      minScored: 5,
    },
    ...overrides,
  };
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

  function render(url: string, loaderData: { data: QualityData | null }) {
    const router = createMemoryRouter(
      [
        {
          path: '/quality',
          element: <Quality {...({ loaderData } as unknown as Parameters<typeof Quality>[0])} />,
        },
      ],
      { initialEntries: [url] },
    );
    act(() => {
      root.render(<RouterProvider router={router} />);
    });
  }

  it('shows the not-yet-derived empty state when data is null', () => {
    render('/quality', { data: null });
    expect(container.textContent).toContain('Индекс на качеството');
    expect(container.querySelector('table')).toBeNull();
  });

  it('renders the totals strip, ranking table and contract cards', () => {
    render('/quality', { data: data() });
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('.q-card-buyer').length).toBeGreaterThan(0);
    // score 0.695 rounds to "70" and, per the boundary fix, must be shown as "good" everywhere.
    expect(container.textContent).toContain('70');
    expect(container.querySelector('.q-good, .q-index.q-good')).not.toBeNull();
  });

  it('renders the scorecard section with pillar breakdown when a scorecard is present', () => {
    render('/quality', { data: data() });
    expect(container.querySelector('.q-scorecard')).not.toBeNull();
    expect(container.querySelector('.q-worst-badge')).not.toBeNull();
  });

  it('renders the unknown-scorecard state when known is false', () => {
    render('/quality', {
      data: data({
        scorecard: { ...scorecard, known: false, overall: null },
      }),
    });
    expect(container.querySelector('.q-scorecard')).not.toBeNull();
    expect(container.querySelector('.is-unknown')).not.toBeNull();
  });

  it('shows the empty-ranking message when there are no rows', () => {
    render('/quality', { data: data({ ranking: [] }) });
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('Няма достатъчно данни');
  });

  it('shows the empty-contracts message when there are no scored contracts', () => {
    render('/quality', { data: data({ contracts: [] }) });
    expect(container.textContent).toContain('Няма оценени договори');
  });
});
