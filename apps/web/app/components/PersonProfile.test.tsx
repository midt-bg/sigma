// @vitest-environment jsdom
// A person's profile is assembled from two independent sources: the Trade Register (roles, and the graph of the
// companies they are held at) and the declarations of an office-holder. The page must present exactly the
// sections its sources support — a register-only person gets no declaration sections, an office-holder with no
// register match gets no roles and says why. The timeline between them is pinned in its own test.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CompanyTieNetwork,
  ConflictLink,
  PersonProfile as RegistryPerson,
} from '@sigma/api-contract';
import type { PersonActivity } from '@sigma/db';
import { money } from '@sigma/shared';
import type { LoadedPersonProfile } from '../lib/person-profile.server';
import { layoutTies } from '../lib/tie-layout.server';
import { PersonProfile } from './PersonProfile';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const activity: PersonActivity = {
  contracts: [],
  page: 1,
  pageSize: 50,
  total: 0,
  companyCount: 1,
  valueEur: null,
  roleCount: 0,
  roleEur: null,
  declaredCount: 0,
  declaredEur: null,
  companies: [],
  authorities: [],
  years: [],
  yearOptions: [],
  filterCounts: { company: {}, authority: {}, year: {}, basis: {} },
  byAuthority: [],
  filters: { company: '', authority: '', year: '', basis: 'all' },
};

function registryPerson(omitted = 0): RegistryPerson {
  const center: CompanyTieNetwork['nodes'][number] = {
    id: 'rp:ab',
    kind: 'person',
    label: 'АННА ПЕТРОВА',
    slug: 'ab',
    valueEur: 0,
    hop: 0,
    conflictsHref: null,
  };
  return {
    slug: 'ab',
    name: 'АННА ПЕТРОВА',
    roles: [
      {
        company: { name: 'АЛФА ООД', eik: '111111111', href: '/companies/111111111' },
        role: 'manager',
        share: null,
        sharePct: null,
        addedOn: '2019-03-12',
        removedOn: null,
        entryNumber: '20190312101010',
        fetchedAt: '2026-09-09T03:00:00Z',
      },
    ],
    companies: 1,
    wonEur: 5000,
    asOf: '2026-09-09',
    network: {
      center,
      nodes: [
        center,
        {
          id: 'eik:111111111',
          kind: 'company',
          label: 'АЛФА ООД',
          slug: '111111111',
          valueEur: 5000,
          hop: 1,
          conflictsHref: null,
        },
      ],
      edges: [
        {
          from: 'rp:ab',
          to: 'eik:111111111',
          kind: 'role',
          directed: false,
          weightEur: 0,
          occurrences: 1,
          href: null,
          roles: ['manager'],
          current: true,
        },
      ],
      omitted,
    },
  };
}

function profile(over: Partial<LoadedPersonProfile> = {}): LoadedPersonProfile {
  const person = registryPerson();
  return {
    person,
    name: person.name,
    links: [],
    timeline: { contracts: [], observations: [], reads: [], buyers: [], institutionProfiles: [] },
    declarations: [],
    activity,
    totals: { companies: 1, contracts: 0, valueEur: null, declaredCount: 0, declaredEur: null },
    tieLayout: layoutTies(person.network),
    aliases: [],
    ...over,
  };
}

const link: ConflictLink = {
  linkKey: 'ivan|222222222',
  officialSlug: 'ivan',
  official: 'ИВАН ПЕТРОВ',
  institution: 'Община Тестово',
  position: 'Кмет',
  company: 'БЕТА ЕООД',
  eik: '222222222',
  relation: 'owns',
  contemporaneous: true,
  ownInstitution: false,
  firstDeclaredYear: '2020',
  lastDeclaredYear: '2023',
  contractCount: 3,
  contractValueEur: 90_000,
  contemporaneousContractCount: 2,
  contemporaneousValueEur: 30_000,
  firstContractYear: '2021',
  lastContractYear: '2024',
  sourceUrl: 'https://register.cacbg.bg/2023/ivan.xml',
  sourceYear: '2023',
  evidenceKind: 'document',
  registryRole: 'owner',
  registryEntryNumber: '20100101',
  registryEntryDate: '2010-01-01',
  registryLookupDate: '2026-09-01',
};

function render(p: LoadedPersonProfile) {
  const Stub = createRoutesStub([
    { path: '/persons/:id', Component: () => <PersonProfile profile={p} /> },
  ]);
  act(() => {
    root.render(<Stub initialEntries={['/persons/ab']} />);
  });
  return container;
}

const crumbs = () =>
  [...container.querySelectorAll('.crumbs-inner > a, .crumbs-inner > span:not(.sep)')].map((c) => [
    c.textContent,
    c.getAttribute('href'),
  ]);
const nav = () =>
  [...container.querySelectorAll('.profile-nav a')].map((a) => a.getAttribute('href'));
const section = (id: string) => container.querySelector(`#${id}`)?.closest('section') ?? null;

describe('PersonProfile', () => {
  it('presents a person the register knows by their roles and a graph of their companies', () => {
    const c = render(profile());
    expect(c.querySelector('.kicker')!.textContent).toBe('Лице · Търговски регистър');
    expect(c.querySelector('h1')!.textContent).toBe('Анна Петрова');
    expect(crumbs()).toEqual([
      ['Начало', '/'],
      ['Анна Петрова', null],
    ]);
    expect(nav()).toEqual(['#timeline', '#network', '#roles', '#contracts']);

    const graph = section('network')!;
    expect(graph.querySelector('svg a[href="/companies/111111111"]')).not.toBeNull();
    // The graph's accessible twin states the same tie as a table row.
    expect(graph.querySelector('.sr-only caption')!.textContent).toBe('Дружества на лицето');
    expect(
      [...graph.querySelectorAll('.sr-only tbody tr')].map((r) =>
        [...r.querySelectorAll('td')].map((td) => td.textContent),
      ),
    ).toEqual([['Анна Петрова', 'управител', 'АЛФА ООД', '']]);
    expect(graph.textContent).not.toContain('извън схемата');

    expect(section('roles')!.querySelector('a[href="/companies/111111111"]')!.textContent).toBe(
      'АЛФА ООД',
    );
    expect(section('declared-overview')).toBeNull();
    expect(section('declarations')).toBeNull();
    expect(c.querySelector('.profile-registry-note')).toBeNull();
    expect(section('contracts')).not.toBeNull();
  });

  it('says how many of the person’s companies the graph leaves out', () => {
    const person = registryPerson(4);
    render(profile({ person, tieLayout: layoutTies(person.network) }));
    expect(section('network')!.textContent).toContain(
      'Още 4 дружества са извън схемата; ролите и договорите включват целия наличен набор.',
    );
  });

  it('presents an office-holder with no register match by the declarations alone, and says so', () => {
    const c = render(
      profile({
        person: null,
        name: link.official,
        links: [link],
        tieLayout: null,
        aliases: [],
        totals: {
          companies: 1,
          contracts: 3,
          valueEur: 90_000,
          declaredCount: 2,
          declaredEur: 30_000,
        },
      }),
    );
    expect(c.querySelector('.kicker')!.textContent).toBe('Длъжностно лице · декларирани интереси');
    expect(crumbs()).toEqual([
      ['Начало', '/'],
      ['Свързани лица', '/conflicts'],
      ['Иван Петров', null],
    ]);
    expect(nav()).toEqual(['#declared-overview', '#timeline', '#declarations', '#contracts']);
    const facts = [...section('declared-overview')!.querySelectorAll('.facts .row')].map((r) => [
      r.querySelector('dt')!.textContent,
      r.querySelector('dd')!.textContent,
    ]);
    expect(facts).toEqual([
      ['Свързани дружества', '1'],
      ['Договори в декларирания период', '2'],
      ['Стойност на тези договори', money(30_000)],
    ]);
    expect(section('declarations')!.textContent).toContain(
      'Няма налични документи в заредения набор.',
    );
    expect(section('network')).toBeNull();
    expect(section('roles')).toBeNull();
    expect(c.querySelector('.profile-registry-note')!.textContent).toContain(
      'Няма потвърдено съпоставяне с регистърен профил на това лице.',
    );
  });
});
