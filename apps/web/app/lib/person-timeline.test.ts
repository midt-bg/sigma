// The companies and years the person timeline is drawn from. Every company the profile reaches — through a
// declared link, a registry role or a contract — appears once, with only its own facts; declared links come
// first, then the companies with the most contracts in office years, then by name. The year axis spans every
// dated fact, including a role that still stands up to the day the register was read.
import { describe, expect, it } from 'vitest';
import type { ConflictLink, PersonDeclaration, PersonRole } from '@sigma/api-contract';
import type { InterestObservation, TimelineContracts } from '@sigma/db';
import type { LoadedPersonProfile } from './person-profile.server';
import { emptyActivity, emptyIntervals } from './person-profile.test-support';
import {
  heldSeatEiks,
  insideSpans,
  officeSpans,
  packLanes,
  timelineCompanies,
  timelineYears,
  yearSpans,
} from './person-timeline';

const role = (eik: string, name: string, over: Partial<PersonRole> = {}): PersonRole => ({
  company: { eik, name, href: null },
  role: 'manager',
  share: null,
  sharePct: null,
  addedOn: '2019-03-01',
  removedOn: null,
  entryNumber: '1',
  fetchedAt: '2026-09-01T03:00:00Z',
  ...over,
});

const contracts = (eik: string, company: string, year: string | null, eligible: number) =>
  ({
    eik,
    company,
    year,
    contracts: eligible + 1,
    role: 0,
    declared: eligible,
    tied: eligible,
    eligible,
    valueEur: 1_000,
  }) satisfies TimelineContracts;

const observation = (eik: string, reportedYear: string | null): InterestObservation => ({
  eik,
  declarationId: 'd1',
  kind: 'shares',
  timing: 'annual',
  reportedYear,
  scope: 'self',
});

const declaration = (
  id: string,
  year: string | null,
  companyEiks: string[],
): PersonDeclaration => ({
  id,
  year,
  template: 'interests',
  type: 'Annualy',
  declaredOn: null,
  submittedOn: null,
  institution: 'Община Русе',
  position: null,
  url: `https://register.cacbg.bg/${id}.xml`,
  companyEiks,
});

const link = { eik: '111', company: 'ЯНТАР ООД' } as ConflictLink;

function profile(over: {
  links?: ConflictLink[];
  roles?: PersonRole[];
  contracts?: TimelineContracts[];
  observations?: InterestObservation[];
  reads?: { eik: string; asOf: string }[];
  declarations?: PersonDeclaration[];
  publicStakes?: LoadedPersonProfile['publicStakes'];
}): LoadedPersonProfile {
  return {
    person: over.roles
      ? {
          slug: 'a'.repeat(64),
          name: 'АННА ПЕТРОВА',
          roles: over.roles,
          companies: 0,
          wonEur: 0,
          asOf: null,
          network: { center: null, nodes: [], edges: [], omitted: 0 },
        }
      : null,
    name: 'АННА ПЕТРОВА',
    links: over.links ?? [],
    timeline: {
      contracts: over.contracts ?? [],
      observations: over.observations ?? [],
      reads: over.reads ?? [],
      buyers: [],
      institutionProfiles: [],
    },
    declarations: over.declarations ?? [],
    activity: emptyActivity,
    totals: { companies: 0, contracts: 0, valueEur: null, declaredCount: 0, declaredEur: null },
    timelineIntervals: emptyIntervals,
    publicStakes: over.publicStakes ?? {},
    tieLayout: null,
    aliases: [],
    relatives: [],
    namedBy: [],
  };
}

// A seat in a company with an established public stake, however small, stands with the offices; a share in
// one does not, whoever else owns it.
describe('a seat in a company with a public stake', () => {
  const minority = {
    listed: null,
    derived: null,
    direct: [{ name: 'Тест Банка', kind: 'bnb' as const, pct: 25 }],
    indirect: [],
  };
  const q = profile({
    links: [
      { eik: '601', company: 'СЪВЕТ АД', relation: 'manages' } as ConflictLink,
      { eik: '602', company: 'ДЯЛ АД', relation: 'owns' } as ConflictLink,
    ],
    roles: [
      role('601', 'СЪВЕТ АД', { role: 'board_of_directors' }),
      role('603', 'СЪДРУЖНИК ООД', { role: 'partner' }),
      role('604', 'ЧАСТНО ООД'),
    ],
    publicStakes: { '601': minority, '602': minority, '603': minority },
  });
  const held = Object.fromEntries(timelineCompanies(q).map((c) => [c.eik, c.heldSeat]));

  it('puts a seat with the offices, and a share with the companies', () => {
    expect(held).toEqual({ '601': true, '602': false, '603': false, '604': false });
    expect(timelineCompanies(q)[0]!.eik).toBe('601');
    expect(timelineCompanies(q)[0]!.publicStake).toEqual(minority);
  });
});

describe('heldSeatEiks', () => {
  const stake = {
    listed: null,
    derived: null,
    direct: [{ name: 'О', kind: 'municipal' as const, pct: 25 }],
    indirect: [],
  };
  it('names the companies with a public stake in which the person holds a seat and no share', () => {
    expect(
      heldSeatEiks(
        [
          role('701', 'СЪВЕТ АД', { role: 'board_of_directors' }),
          role('702', 'ДЯЛ ООД', { role: 'partner' }),
          role('702', 'ДЯЛ ООД', { role: 'manager' }),
          role('704', 'ЧАСТНО ООД'),
        ],
        [
          { eik: '701', relation: 'manages' } as ConflictLink,
          { eik: '703', relation: 'owns' } as ConflictLink,
        ],
        { '701': stake, '702': stake, '703': stake, '705': { ...stake, direct: [] } },
      ),
    ).toEqual(['701']);
    expect(heldSeatEiks([], [], undefined)).toEqual([]);
  });
});

describe('timelineCompanies', () => {
  const p = profile({
    links: [link],
    roles: [
      role('111', 'ЯНТАР ООД'),
      role('222', 'БЕТА ЕООД'),
      role('222', 'БЕТА ЕООД', { entryNumber: '2' }), // the same role, read twice
      role('222', 'БЕТА ЕООД', { role: 'partner' }),
      role('333', 'АЛФА АД', { company: { eik: '333', name: 'АЛФА АД', href: '/companies/333' } }),
      role('555', 'АКВА ООД'),
    ],
    contracts: [
      contracts('222', 'БЕТА ЕООД', '2020', 1),
      contracts('222', 'БЕТА ЕООД', '2021', 2),
      contracts('444', 'ВЕГА ООД', '2022', 5),
    ],
    observations: [observation('111', '2021'), observation('999', '2021')],
    reads: [{ eik: '222', asOf: '2026-09-01T03:00:00Z' }],
    declarations: [declaration('d1', '2021', ['111', '333']), declaration('d2', '2022', ['777'])],
  });
  const companies = timelineCompanies(p);
  const byEik = (eik: string) => companies.find((c) => c.eik === eik)!;

  it('puts declared links first, then the most contracts in office years, then the name', () => {
    expect(companies.map((c) => c.eik)).toEqual(['111', '444', '222', '555', '333']);
  });

  it('puts the seat in the organization the person files for with the offices, as a public enterprise', () => {
    const q = profile({
      links: [],
      roles: [
        role('888', 'СДРУЖЕНИЕ ТЕСТ', {
          role: 'governing_body',
          company: { eik: '888', name: 'СДРУЖЕНИЕ ТЕСТ', href: null, office: true },
        }),
        role('111', 'ЯНТАР ООД'),
      ],
      contracts: [],
      observations: [],
      reads: [],
      declarations: [],
    });
    const list = timelineCompanies(q);
    expect(list.map((c) => [c.eik, c.publicEnterprise])).toEqual([
      ['888', true],
      ['111', false],
    ]);
  });

  it('keeps one entry per company, linked to its profile when it has one', () => {
    expect(byEik('111')).toMatchObject({ name: 'ЯНТАР ООД', href: '/companies/111' });
    expect(byEik('111').roles).toHaveLength(1);
    expect(byEik('444').href).toBe('/companies/444');
    expect(byEik('333').href).toBe('/companies/333');
    expect(byEik('555').href).toBeNull();
  });

  it('drops a role read twice, but keeps a different role at the same company', () => {
    expect(byEik('222').roles.map((r) => r.role)).toEqual(['manager', 'partner']);
    expect(byEik('222').contracts.map((c) => c.year)).toEqual(['2020', '2021']);
  });

  it('gives each company only its own observations, declarations and register read', () => {
    expect(byEik('111').observations).toEqual([observation('111', '2021')]);
    expect(byEik('111').declarations.map((d) => d.id)).toEqual(['d1']);
    expect(byEik('333').declarations.map((d) => d.id)).toEqual(['d1']);
    expect(byEik('222').declarations).toEqual([]);
    expect(byEik('222').asOf).toBe('2026-09-01T03:00:00Z');
    expect(byEik('111').asOf).toBeNull();
  });

  it('builds nothing for a person with no link, role or contract', () => {
    expect(timelineCompanies(profile({ declarations: [declaration('d1', '2021', [])] }))).toEqual(
      [],
    );
  });
});

describe('timelineYears', () => {
  it('spans every dated fact, running a standing role up to the register read', () => {
    const p = profile({
      roles: [role('222', 'БЕТА ЕООД', { addedOn: '2019-03-01', removedOn: null })],
      contracts: [contracts('222', 'БЕТА ЕООД', '2020', 1), contracts('222', 'БЕТА ЕООД', null, 1)],
      observations: [observation('222', '2018'), observation('222', 'н.д.')],
      reads: [{ eik: '222', asOf: '2026-09-01T03:00:00Z' }],
      declarations: [declaration('d1', '2021', ['222']), declaration('d0', '1850', ['222'])],
    });
    expect(timelineYears(p, timelineCompanies(p))).toEqual([
      2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026,
    ]);
  });

  it('does not extend a standing role past its start when the register read is unknown', () => {
    const p = profile({ roles: [role('222', 'БЕТА ЕООД', { addedOn: '2019-03-01' })] });
    expect(timelineYears(p, timelineCompanies(p))).toEqual([2019]);
  });

  it('ends a struck-off role in the year it was removed', () => {
    const p = profile({
      roles: [role('222', 'БЕТА ЕООД', { addedOn: '2019-03-01', removedOn: '2021-06-30' })],
      reads: [{ eik: '222', asOf: '2026-09-01T03:00:00Z' }],
    });
    expect(timelineYears(p, timelineCompanies(p))).toEqual([2019, 2020, 2021]);
  });
});

// The timeline as intervals.
describe('officeSpans', () => {
  const doc = (year: string, type: string, declaredOn: string | null = null) =>
    ({
      id: `${year}-${type}`,
      year,
      template: 'assets',
      type,
      declaredOn,
      submittedOn: null,
      institution: 'Община Тест',
      position: 'Съветник',
      url: '',
      companyEiks: [],
    }) satisfies PersonDeclaration;

  it('splits at a year without a filing and anchors only the edges a declaration dates', () => {
    expect(
      officeSpans([
        doc('2017', 'Entry', '2017-04-20'),
        doc('2018', 'Annualy'),
        doc('2020', 'Annualy'),
        doc('2021', 'Vacate', '2021-08-12'),
      ]),
    ).toEqual([
      { from: '2017-01-01', to: '2018-12-31', knownStart: '2017-04-20', knownEnd: null },
      { from: '2020-01-01', to: '2021-08-12', knownStart: null, knownEnd: '2021-08-12' },
    ]);
  });

  it('ignores a filing without a position or a year, as the red numbers do', () => {
    expect(officeSpans([{ ...doc('2019', 'Annualy'), position: '' }, doc('', 'Annualy')])).toEqual(
      [],
    );
  });

  it('does not anchor an edge with a filing dated in another year', () => {
    expect(officeSpans([doc('2019', 'Vacate', '2020-01-15')])).toEqual([
      { from: '2019-01-01', to: '2019-12-31', knownStart: null, knownEnd: null },
    ]);
  });
});

describe('packLanes', () => {
  const pr = (id: string, announcedAt: string | null, signedAt: string) => ({
    id,
    announcedAt,
    signedAt,
  });
  it('puts a procurement in the first row it fits after the previous one ends', () => {
    const lanes = packLanes([
      pr('b', '2020-03-01', '2020-05-01'),
      pr('a', '2020-01-01', '2020-02-01'),
      pr('c', '2020-02-10', '2020-04-01'),
      pr('d', null, '2020-06-15'),
    ]);
    expect(lanes.map((l) => l.map((p) => p.id))).toEqual([['a', 'b', 'd'], ['c']]);
  });
});

describe('yearSpans and insideSpans', () => {
  it('joins consecutive years and tests a day against inclusive spans', () => {
    const spans = yearSpans(['2020', '2019', '2022', '2019']);
    expect(spans).toEqual([
      ['2019-01-01', '2020-12-31'],
      ['2022-01-01', '2022-12-31'],
    ]);
    expect(insideSpans(spans, '2020-12-31')).toBe(true);
    expect(insideSpans(spans, '2021-06-01')).toBe(false);
    expect(insideSpans(spans, null)).toBe(false);
    expect(insideSpans(undefined, '2020-01-01')).toBe(false);
  });
});
