// The accessible table twins at their edges: a partial trend year says so and a change is signed, a person at
// either end of a tie is named in display case, and a network edge whose two endpoints are both unresolved
// keeps its raw ids with no link — never a label borrowed from the other end.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CompanyTieNetwork, NetworkData, TrendYear } from '@sigma/api-contract';
import { networkRows, tieRows, trendYearColumns } from './entity-tables';

const trendCells = (r: TrendYear) =>
  trendYearColumns.map((c) => renderToStaticMarkup(<>{c.cell(r, 0)}</>));

describe('trendYearColumns', () => {
  it('marks the incomplete year and leaves its change blank', () => {
    const [year, , , yoy] = trendCells({
      year: '2026',
      valueEur: 1_000,
      contracts: 3,
      yoyPct: null,
      partial: true,
    });
    expect(year).toBe('2026<span class="muted"> (частично)</span>');
    expect(yoy).toBe('');
  });

  it('signs the change against the previous year', () => {
    const [year, , contracts, yoy] = trendCells({
      year: '2025',
      valueEur: 1_000,
      contracts: 3,
      yoyPct: -0.233,
      partial: false,
    });
    expect(year).toBe('2025');
    expect(contracts).toBe('3');
    expect(yoy).toBe('−23,3%');
  });
});

describe('tieRows — a person on the receiving end', () => {
  it('names the person in display case whichever end of the tie they are on', () => {
    const company = {
      id: 'eik:1',
      kind: 'company' as const,
      label: 'АЛФА СТРОЙ АД',
      slug: '1',
      valueEur: 100,
      hop: 0,
      conflictsHref: null,
    };
    const person = { ...company, id: 'rp:ab', kind: 'person' as const, label: 'АННА ПЕТРОВА' };
    const net: CompanyTieNetwork = {
      center: company,
      nodes: [company, { ...person, slug: 'ab', valueEur: 0, hop: 1 }],
      edges: [
        {
          from: 'eik:1',
          to: 'rp:ab',
          kind: 'role',
          directed: false,
          weightEur: 0,
          occurrences: 1,
          href: null,
          roles: ['partner'],
          current: true,
        },
      ],
      omitted: 0,
    };
    expect(tieRows(net)[0]).toMatchObject({
      from: 'АЛФА СТРОЙ АД',
      to: 'Анна Петрова',
      toHref: '/persons/ab',
    });
  });
});

describe('networkRows — both endpoints unresolved', () => {
  it('keeps each raw id on its own side and links neither', () => {
    const data: NetworkData = {
      center: { id: 'eik:1', kind: 'company', label: 'АЛФА СТРОЙ АД', slug: '1', valueEur: 100 },
      nodes: [],
      edges: [{ from: 'auth:gone', to: 'eik:gone', valueEur: 1, contracts: 1 }],
      centerOptions: { authorities: [], companies: [] },
    };
    expect(networkRows(data)).toEqual([
      {
        from: 'auth:gone',
        to: 'eik:gone',
        fromHref: null,
        toHref: null,
        valueEur: 1,
        contracts: 1,
      },
    ]);
  });
});
