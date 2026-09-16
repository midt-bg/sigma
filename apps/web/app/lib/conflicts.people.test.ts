// The person rows behind /conflicts at their edges: money a later link does not repeat, institutions that
// are blank, spelled with Latin look-alikes or undated, and orderings that tie on every figure. The list must
// stay deterministic and never invent an institution, a year or an amount.
import { describe, expect, it } from 'vitest';
import type { ConflictLink } from '@sigma/api-contract';
import {
  dedupeMoneyPerEik,
  groupByPerson,
  groupDeclaredInstitutions,
  institutionKey,
  institutionOptions,
  sortConflictRows,
  type ConflictPersonRow,
} from './conflicts';

const link = (over: Partial<ConflictLink>): ConflictLink => ({
  linkKey: 'person:a|111',
  officialSlug: 'a',
  official: 'Иван Минев',
  institution: 'Община Русе',
  company: 'АЛФА ООД',
  eik: '111',
  relation: 'owns',
  contemporaneous: true,
  ownInstitution: false,
  firstDeclaredYear: '2019',
  lastDeclaredYear: '2023',
  contractCount: 3,
  contractValueEur: 1_000,
  contemporaneousContractCount: 1,
  contemporaneousValueEur: 400,
  firstContractYear: '2020',
  lastContractYear: '2022',
  sourceUrl: null,
  sourceYear: null,
  evidenceKind: 'document',
  registryRole: 'owner',
  registryEntryNumber: null,
  registryEntryDate: null,
  registryLookupDate: '2026-08-05',
  position: null,
  ...over,
});

const row = (over: Partial<ConflictPersonRow>): ConflictPersonRow => ({
  official: 'Иван Минев',
  officialSlug: 'a',
  institution: null,
  position: null,
  companyCount: 1,
  soleCompany: null,
  contractCount: 1,
  contractValueEur: 100,
  contemporaneousValueEur: null,
  stakeKind: 'self',
  ownInstitution: false,
  hasContemporaneous: false,
  ...over,
});

describe('dedupeMoneyPerEik', () => {
  it('keeps a winner’s known amounts when a later link for it carries none', () => {
    const perEik = dedupeMoneyPerEik([
      { eik: '111', contractValueEur: 500, contemporaneousValueEur: 200 },
      { eik: '111', contractValueEur: null, contemporaneousValueEur: null },
    ]);
    expect(perEik.get('111')).toEqual({ total: 500, contemporaneous: 200 });
  });
});

describe('groupByPerson — edges', () => {
  it('lists no declared institution for a link without one, rather than a blank entry', () => {
    const [person] = groupByPerson([link({ institution: null })]);
    expect(person!.declaredInstitutions).toEqual([]);
    expect(person!.institution).toBeNull();
  });

  it('orders people whose strongest links tie on everything by their slug', () => {
    // A shared link_key cannot happen today; the comparator must still be total if it ever does.
    const rows = groupByPerson([
      link({ officialSlug: 'b', official: 'Бета' }),
      link({ officialSlug: 'a', official: 'Алфа' }),
    ]);
    expect(rows.map((r) => r.officialSlug)).toEqual(['a', 'b']);
  });

  it('keeps two proven identities that share a slug and tie on everything in their given order', () => {
    const rows = groupByPerson([
      link({ registryPersonId: 'identity-2' }),
      link({ registryPersonId: 'identity-1' }),
    ]);
    expect(rows.map((r) => r.personIdentity)).toEqual(['identity-2', 'identity-1']);
  });
});

describe('institutionKey', () => {
  it('reads Latin look-alike letters in a Cyrillic name as Cyrillic', () => {
    // „OБЩИНА PУСE" with a Latin O, P and E — a common data-entry slip — is the same institution.
    expect(institutionKey('OБЩИНА PУСE')).toBe('ОБЩИНА РУСЕ');
    expect(institutionKey('OБЩИНА PУСE')).toBe(institutionKey('Община  Русе '));
  });

  it('leaves a name with no Cyrillic in it as written, upper-cased', () => {
    expect(institutionKey(' Acme  Holding ')).toBe('ACME HOLDING');
  });

  it('keys a missing name as empty', () => {
    expect(institutionKey(null)).toBe('');
    expect(institutionKey(undefined)).toBe('');
  });
});

describe('groupDeclaredInstitutions — edges', () => {
  it('skips a declared office with a blank or missing institution', () => {
    expect(
      groupDeclaredInstitutions([
        { institution: null, position: 'Кмет', year: '2020' },
        { institution: '   ', position: 'Кмет', year: '2021' },
      ]),
    ).toEqual([]);
  });

  it('puts the latest-dated institutions first, then the undated, each group by name', () => {
    const grouped = groupDeclaredInstitutions([
      { institution: 'Община Русе', position: null, year: '2020' },
      { institution: 'Община Варна', position: null, year: null },
      { institution: 'Народно събрание', position: null, year: '2020' },
      { institution: 'Министерство на финансите', position: null, year: 'н.д.' },
    ]);
    expect(grouped).toEqual([
      { institution: 'Народно събрание', positions: [], years: ['2020'] },
      { institution: 'Община Русе', positions: [], years: ['2020'] },
      { institution: 'Министерство на финансите', positions: [], years: [] },
      { institution: 'Община Варна', positions: [], years: [] },
    ]);
  });
});

describe('institutionOptions — edges', () => {
  it('offers the official’s own institution when no declared ones are listed, and never a blank one', () => {
    const options = institutionOptions(
      [
        row({ officialSlug: '1', institution: 'Община Русе' }),
        row({ officialSlug: '2', institution: '   ' }),
        row({
          officialSlug: '3',
          declaredInstitutions: [{ institution: ' ', positions: [], years: [] }],
        }),
      ],
      [],
    );
    expect(options).toEqual([{ value: 'ОБЩИНА РУСЕ', label: 'Община Русе', count: 1 }]);
  });

  it('orders institutions with as many officials alphabetically', () => {
    const options = institutionOptions(
      [
        row({ officialSlug: '1', institution: 'Община Русе' }),
        row({ officialSlug: '2', institution: 'Народно събрание' }),
      ],
      [],
    );
    expect(options.map((o) => o.value)).toEqual(['НАРОДНО СЪБРАНИЕ', 'ОБЩИНА РУСЕ']);
  });
});

describe('sortConflictRows — ties and unknown totals', () => {
  it('orders equal totals by slug and puts an unknown total last', () => {
    const rows = [
      row({ officialSlug: 'b', contractValueEur: 100 }),
      row({ officialSlug: 'c', contractValueEur: null }),
      row({ officialSlug: 'a', contractValueEur: 100 }),
    ];
    expect(sortConflictRows(rows, 'total').map((r) => r.officialSlug)).toEqual(['a', 'b', 'c']);
  });

  it('keeps rows that tie on the figure and the slug in their given order', () => {
    const rows = [
      row({ personIdentity: 'identity-2', contractCount: 4 }),
      row({ personIdentity: 'identity-1', contractCount: 4 }),
    ];
    expect(sortConflictRows(rows, 'contracts').map((r) => r.personIdentity)).toEqual([
      'identity-2',
      'identity-1',
    ]);
  });
});
