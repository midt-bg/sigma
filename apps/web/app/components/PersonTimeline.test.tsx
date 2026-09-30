// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { expect, it, vi } from 'vitest';
import type { ConflictLink } from '@sigma/api-contract';
import type { LoadedPersonProfile } from '../lib/person-profile.server';
import { emptyActivity, emptyIntervals } from '../lib/person-profile.test-support';
import { timelineCompanies, type TimelineCompany } from '../lib/person-timeline';
import { PersonProfile } from './PersonProfile';
import { PersonTimeline } from './PersonTimeline';
import { PersonRolesTables } from './RegistryRoles';
import { roleRowId } from '../lib/profile-navigation';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('shows one company for multiple source identities, sequential sections and historical facts without invented role bars', () => {
  const link: ConflictLink = {
    linkKey: 'a|123456789',
    officialSlug: 'a',
    official: 'Ивана Петрова Тестова',
    institution: 'Община А',
    position: null,
    company: 'Тестова фирма',
    eik: '123456789',
    relation: 'owns',
    contemporaneous: false,
    ownInstitution: false,
    firstDeclaredYear: null,
    lastDeclaredYear: null,
    contractCount: 2,
    contractValueEur: 100,
    contemporaneousContractCount: 0,
    contemporaneousValueEur: null,
    firstContractYear: '2020',
    lastContractYear: '2024',
    sourceUrl: 'https://register.cacbg.bg/a.xml',
    sourceYear: '2023',
    evidenceKind: 'document',
    registryRole: 'owner',
    registryEntryNumber: '20100101',
    registryEntryDate: '2010-01-01',
    registryLookupDate: '2026-09-01',
  };
  const p: LoadedPersonProfile = {
    person: null,
    name: link.official,
    links: [link, { ...link, linkKey: 'b|123456789', officialSlug: 'b' }],
    declarations: [
      {
        id: 'd',
        year: '2023',
        template: 'interests',
        type: 'Assume',
        declaredOn: '2024-01-01',
        submittedOn: null,
        institution: 'Община А',
        position: 'Длъжност',
        url: link.sourceUrl!,
        companyEiks: [link.eik],
      },
    ],
    timeline: {
      reads: [],
      buyers: [
        {
          eik: link.eik,
          year: '2024',
          id: 'auth:1',
          name: 'Възложител А',
          contracts: 2,
          eligible: 0,
          valueEur: 100,
        },
      ],
      institutionProfiles: [],
      observations: [
        {
          eik: link.eik,
          declarationId: 'd',
          kind: 'management',
          timing: 'current',
          reportedYear: '2021',
          scope: 'self',
        },
        {
          eik: link.eik,
          declarationId: 'd',
          kind: 'participation',
          timing: 'prior',
          reportedYear: '2023',
          scope: 'self',
        },
      ],
      contracts: [
        {
          eik: link.eik,
          company: link.company,
          year: '2024',
          contracts: 2,
          role: 0,
          declared: 0,
          tied: 0,
          eligible: 0,
          valueEur: 100,
        },
      ],
    },
    activity: emptyActivity,
    totals: { companies: 1, contracts: 0, valueEur: null, declaredCount: 0, declaredEur: null },
    timelineIntervals: emptyIntervals,
    tieLayout: null,
    aliases: [],
    relatives: [],
    namedBy: [],
  };
  const companies = timelineCompanies(p);
  expect(companies).toHaveLength(1);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  const Stub = createRoutesStub([{ path: '/', Component: () => <PersonProfile profile={p} /> }]);
  try {
    act(() => root.render(<Stub />));
    expect(el.querySelectorAll('.person-time-company')).toHaveLength(1);
    expect(el.querySelectorAll('details')).toHaveLength(0);
    expect(el.querySelectorAll('[role="tab"], [role="tablist"]')).toHaveLength(0);
    expect(el.querySelectorAll('.time-role')).toHaveLength(0);
    expect(el.querySelectorAll('.time-management')).toHaveLength(1);
    expect(
      el.querySelectorAll('.person-time-company .time-observation:not(.time-management)'),
    ).toHaveLength(0);
    expect(el.querySelectorAll('.time-institution .time-observation')).toHaveLength(1);
    expect(el.querySelectorAll('.time-contract.eligible')).toHaveLength(0);
    expect(el.querySelector('.time-contract.context')?.textContent).toBe('2');
    expect(el.querySelector('.time-contract-bin .help-trigger')).toBeNull();
    expect(el.querySelector('.time-contract-bin .time-institution-trigger')).toBeNull();
    const ids = [...el.querySelectorAll('.section > h2[id]')].map((s) => s.id);
    expect(ids.indexOf('declared-overview')).toBeLessThan(ids.indexOf('timeline'));
    expect(ids.indexOf('declarations')).toBeLessThan(ids.indexOf('contracts'));
    expect(ids.at(-1)).toBe('contracts');
    const notes = el.querySelector('.person-time-notes')!;
    const companyHeading = notes.closest('.time-company-heading')!;
    expect(companyHeading.closest('.person-time-company')).not.toBeNull();
    expect(companyHeading.querySelector('strong')?.textContent).toBe(link.company);
    expect(notes.closest('.person-time-row')).toBeNull();
    expect(el.querySelectorAll('.time-company-heading')).toHaveLength(1);
    expect(notes.textContent).toContain('Лична роля в ТР не е установена');
    expect(notes.textContent).toContain('Предходно участие');
    expect(notes.querySelector('a[href="#declaration-d"]')).not.toBeNull();
    expect(
      [...el.querySelectorAll('.person-time-row')].map((r) => r.textContent).join(' '),
    ).not.toMatch(/Не е установена|Предходно участие/);
    expect(el.querySelector('#declaration-d a')?.getAttribute('href')).toBe(link.sourceUrl);
    p.declarations[0]!.interests = [
      { company: link.company, eik: link.eik, kind: 'shares', timing: 'annual', scope: 'self' },
    ];
    p.declarations[0]!.discrepancies = [
      {
        company: link.company,
        eik: link.eik,
        year: '2023',
        scope: 'self',
        listed: true,
        otherDeclarationIds: ['other'],
      },
    ];
    p.declarations.push({
      ...p.declarations[0]!,
      id: 'other',
      companyEiks: [],
      interests: [],
      discrepancies: [
        {
          company: link.company,
          eik: link.eik,
          year: '2023',
          scope: 'self',
          listed: false,
          otherDeclarationIds: ['d'],
        },
      ],
    });
    p.timeline.observations.push(
      {
        eik: link.eik,
        declarationId: 'd',
        kind: 'shares',
        timing: 'annual',
        reportedYear: '2023',
        scope: 'self',
        disputed: 1,
      },
      {
        eik: link.eik,
        declarationId: 'other',
        kind: 'shares',
        timing: 'not_listed',
        reportedYear: '2023',
        scope: 'self',
        disputed: 1,
      },
    );
    act(() => root.render(<Stub key="disputed" />));
    expect(el.querySelectorAll('.time-disputed')).toHaveLength(1);
    const discrepancyNotes = el.querySelector('.person-time-notes')!;
    expect(discrepancyNotes.textContent).toContain('Разминаване в декларациите');
    for (const id of ['d', 'other']) {
      expect(discrepancyNotes.querySelector(`a[href="#declaration-${id}"]`)).not.toBeNull();
    }
    expect(el.querySelector('#declaration-other')?.textContent).toContain('не е посочен тук');
    expect(
      el.querySelector('#declaration-d .declaration-discrepancy a[href="#declaration-other"]'),
    ).not.toBeNull();
    expect(el.querySelector('#declaration-other .entity-list')).toBeNull(); // omission never creates an interest
    p.timeline.institutionProfiles = [{ institution: 'Община А', authorityId: 'auth:1' }];
    p.timeline.buyers.push(
      { ...p.timeline.buyers[0]!, id: 'auth:other', name: 'Несвързан възложител', valueEur: 9999 },
      { ...p.timeline.buyers[0]!, year: '2020', name: 'Същата институция през друга година' },
      { ...p.timeline.buyers[0]!, eik: '999999999', name: 'Същата институция за друга фирма' },
    );
    act(() => root.render(<Stub key="own-institution" />));
    expect(el.querySelectorAll('.time-institution-trigger')).toHaveLength(1);
    expect(el.querySelector('.time-institution-trigger')?.textContent).toBe('');
    expect(el.querySelector('.time-institution-trigger')?.getAttribute('aria-label')).toContain(
      '2024',
    );
    const buyerLink = el.querySelector('.time-buyers-list a')!;
    expect(buyerLink.getAttribute('href')).toContain(
      'year=2024&authority=auth%3A1#contract-filters',
    );
    expect(el.querySelector('.time-buyers-list')?.textContent).toContain('Възложител А');
    expect(el.querySelector('.time-buyers-list')?.textContent).not.toMatch(
      /Несвързан|друга година|друга фирма/,
    );
    expect(el.querySelector('.time-buyers-list')?.textContent).not.toContain('9999');
    const roles = (['manager', 'partner'] as const).flatMap((role) => [
      {
        company: { name: link.company, eik: link.eik, href: `/companies/${link.eik}` },
        role,
        share: null,
        sharePct: null,
        addedOn: '2013-01-17',
        removedOn: '2013-08-14',
        entryNumber: 'old',
        fetchedAt: '2026-09-09T03:00:00Z',
      },
      {
        company: { name: link.company, eik: link.eik, href: `/companies/${link.eik}` },
        role,
        share: null,
        sharePct: null,
        addedOn: '2022-11-16',
        removedOn: '2024-05-27',
        entryNumber: 'new',
        fetchedAt: '2026-09-09T03:00:00Z',
      },
    ]);
    const Roles = createRoutesStub([
      {
        path: '/',
        Component: () => (
          <>
            <PersonTimeline profile={p} companies={[{ ...companies[0]!, roles }]} />
            <PersonRolesTables roles={roles} />
          </>
        ),
      },
    ]);
    act(() => root.render(<Roles />));
    const roleRows = [...el.querySelectorAll('.person-time-company .person-time-row')].filter((r) =>
      r.querySelector('.time-role'),
    );
    expect(roleRows).toHaveLength(2);
    for (const row of roleRows) {
      const segments = row.querySelectorAll<HTMLElement>('.time-role');
      expect(segments).toHaveLength(2);
      expect(
        parseFloat(segments[0]!.style.left) + parseFloat(segments[0]!.style.width),
      ).toBeLessThan(parseFloat(segments[1]!.style.left));
    }
    for (const role of roles) {
      const id = roleRowId(role);
      const target = document.getElementById(id)!;
      expect(target.tagName).toBe('TR');
      expect(target.closest('.registry-ended')).not.toBeNull();
      target.scrollIntoView = vi.fn();
      const bar = [...el.querySelectorAll<HTMLAnchorElement>('.time-role')].find(
        (a) => a.getAttribute('href') === `#${id}`,
      )!;
      act(() => bar.click());
      expect(document.activeElement).toBe(target);
      expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
      expect(target.classList.contains('profile-target')).toBe(true);
    }
  } finally {
    act(() => root.unmount());
    el.remove();
  }
});

it('puts offices and public enterprises under „Заемани длъжности", private companies under „Дружества"', () => {
  const role = (eik: string, name: string, ownershipKind?: 'municipal') => ({
    company: { eik, name, href: `/companies/${eik}`, ...(ownershipKind ? { ownershipKind } : {}) },
    role: 'manager' as const,
    share: null,
    sharePct: null,
    addedOn: '2020-01-01',
    removedOn: null,
    entryNumber: 'e',
    fetchedAt: '2026-09-01',
  });
  const p = {
    person: {
      slug: 'a'.repeat(64),
      name: 'АННА ПЕТРОВА',
      roles: [role('222222222', 'ЧАСТНО ООД'), role('111111111', 'ОБЩИНСКО ЕООД', 'municipal')],
      companies: 2,
      wonEur: 0,
      asOf: '2026-09-01',
      network: { center: null, nodes: [], edges: [], omitted: 0 },
    },
    name: 'АННА ПЕТРОВА',
    links: [],
    declarations: [],
    timeline: { reads: [], buyers: [], institutionProfiles: [], observations: [], contracts: [] },
    activity: emptyActivity,
    totals: { companies: 2, contracts: 0, valueEur: null, declaredCount: 0, declaredEur: null },
    timelineIntervals: emptyIntervals,
    tieLayout: null,
    aliases: [],
    relatives: [],
    namedBy: [],
  } as LoadedPersonProfile;
  const companies = timelineCompanies(p);
  expect(companies.map((c) => [c.eik, c.publicEnterprise])).toEqual([
    ['111111111', true],
    ['222222222', false],
  ]);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  const Stub = createRoutesStub([
    { path: '/', Component: () => <PersonTimeline profile={p} companies={companies} /> },
  ]);
  try {
    act(() => root.render(<Stub />));
    const order = [...el.querySelectorAll('.person-time-section, .person-time-company')].map((n) =>
      n.textContent!.slice(0, 20),
    );
    expect(order[0]).toBe('Заемани длъжности');
    expect(order[1]).toContain('ОБЩИНСКО');
    expect(order[2]).toBe('Дружества');
    expect(order[3]).toContain('ЧАСТНО');
  } finally {
    act(() => root.unmount());
    el.remove();
  }
});

it('renders nothing when there are no dated facts or companies', () => {
  const p = {
    person: null,
    name: 'Иван Петров Тестов',
    links: [],
    declarations: [],
    timeline: { reads: [], buyers: [], institutionProfiles: [], observations: [], contracts: [] },
    activity: emptyActivity,
    totals: { companies: 0, contracts: 0, valueEur: null, declaredCount: 0, declaredEur: null },
    timelineIntervals: emptyIntervals,
    tieLayout: null,
    aliases: [],
    relatives: [],
    namedBy: [],
  } as LoadedPersonProfile;
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  const Stub = createRoutesStub([
    { path: '/', Component: () => <PersonTimeline profile={p} companies={[]} /> },
  ]);
  try {
    act(() => root.render(<Stub />));
    expect(el.textContent).toBe('');
  } finally {
    act(() => root.unmount());
    el.remove();
  }
});

it('detects overflow, scrolls the timeline and explains incomplete registry periods', () => {
  const p = {
    person: null,
    name: 'Иван Петров Тестов',
    links: [],
    declarations: [],
    timeline: { reads: [], buyers: [], institutionProfiles: [], observations: [], contracts: [] },
    activity: emptyActivity,
    totals: { companies: 1, contracts: 3, valueEur: 100, declaredCount: 0, declaredEur: null },
    timelineIntervals: emptyIntervals,
    tieLayout: null,
    aliases: [],
    relatives: [],
    namedBy: [],
  } as LoadedPersonProfile;
  const role = {
    company: { name: '„Тест Груп“ ЕООД', eik: '111111111', href: '/companies/111111111' },
    share: null,
    sharePct: null,
    removedOn: null,
    entryNumber: 'test-entry',
    fetchedAt: '2026-09-01',
  };
  const company = {
    eik: '111111111',
    name: '„Тест Груп“ ЕООД',
    href: '/companies/111111111',
    links: [],
    observations: [],
    declarations: [],
    asOf: '2026-09-01',
    publicEnterprise: false,
    roles: [
      { ...role, role: 'manager', addedOn: '2023-01-01' },
      { ...role, role: 'owner', addedOn: '2021-01-01', uncertainAfter: '2024-01-01' },
      { ...role, role: 'partner', addedOn: 'unknown' },
    ],
    contracts: [
      {
        eik: '111111111',
        company: '„Тест Груп“ ЕООД',
        year: '2025',
        contracts: 1,
        role: 1,
        declared: 0,
        tied: 1,
        eligible: 1,
        valueEur: 100,
      },
      {
        eik: '111111111',
        company: '„Тест Груп“ ЕООД',
        year: null,
        contracts: 2,
        role: 0,
        declared: 0,
        tied: 0,
        eligible: 0,
        valueEur: null,
      },
    ],
  } as TimelineCompany;

  let scrollWidth = 500;
  const scrollWidthSpy = vi
    .spyOn(HTMLElement.prototype, 'scrollWidth', 'get')
    .mockImplementation(() => scrollWidth);
  const clientWidthSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
  const scrollBy = vi.fn();
  const originalScrollBy = HTMLElement.prototype.scrollBy;
  Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
    configurable: true,
    value: scrollBy,
  });
  const observe = vi.fn();
  const disconnect = vi.fn();
  let resize: ResizeObserverCallback = () => undefined;
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resize = callback;
    }
    observe = observe;
    unobserve = vi.fn();
    disconnect = disconnect;
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);

  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  const Stub = createRoutesStub([
    { path: '/', Component: () => <PersonTimeline profile={p} companies={[company]} /> },
  ]);
  try {
    act(() => root.render(<Stub initialEntries={['/?view=profile']} />));
    const canvas = el.querySelector<HTMLElement>('#person-time-canvas')!;
    expect(canvas.scrollLeft).toBe(500);
    expect(observe).toHaveBeenCalledWith(canvas);
    expect(el.querySelector('.person-time-controls')?.textContent).toContain('2021–2026');
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('.person-time-controls button')];
    act(() => buttons[0]!.click());
    act(() => buttons[1]!.click());
    expect(scrollBy).toHaveBeenNthCalledWith(1, { left: -180 });
    expect(scrollBy).toHaveBeenNthCalledWith(2, { left: 180 });

    expect(el.querySelector('.time-open')).not.toBeNull();
    expect(el.querySelector('[aria-label*="неустановено след"]')).not.toBeNull();
    expect(el.textContent).toContain('Няма установен период');
    expect(el.textContent).toContain('Договори без дата: 2');
    const eligible = el.querySelector<HTMLAnchorElement>('.time-contract.eligible')!;
    expect(eligible.textContent).toBe('1');
    expect(eligible.getAttribute('href')).toContain('basis=tied');
    expect(eligible.getAttribute('href')).toContain('view=profile');
    expect(el.querySelector('.time-contract.context')).toBeNull();

    scrollWidth = 200;
    act(() => resize([], {} as ResizeObserver));
    expect(el.querySelector('.person-time-controls')).toBeNull();
  } finally {
    act(() => root.unmount());
    expect(disconnect).toHaveBeenCalledOnce();
    el.remove();
    vi.unstubAllGlobals();
    scrollWidthSpy.mockRestore();
    clientWidthSpy.mockRestore();
    if (originalScrollBy) {
      Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
        configurable: true,
        value: originalScrollBy,
      });
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollBy;
    }
  }
});

// The timeline as intervals. The band sits under every row of its company, the office is drawn from its
// declarations, and each procurement is a span from its announcement to its signing.
it('draws the overlap band, the office and each procurement from announcement to signing', () => {
  const eik = '123456789';
  const declaration = (id: string, year: string, type: string, declaredOn: string | null) => ({
    id,
    year,
    template: 'assets',
    type,
    declaredOn,
    submittedOn: null,
    institution: 'Община Тест',
    position: 'Съветник',
    url: `https://register.cacbg.bg/${id}.xml`,
    companyEiks: [eik],
  });
  const p = {
    person: {
      slug: 'x',
      name: 'ИВАН ПЕТРОВ ТЕСТОВ',
      roles: [
        {
          company: { name: 'ТЕСТ ГРУП ЕООД', eik, href: `/companies/${eik}` },
          role: 'manager',
          share: null,
          sharePct: null,
          addedOn: '2020-02-01',
          removedOn: null,
          entryNumber: 'e1',
          fetchedAt: '2025-03-10T08:00:00Z',
        },
      ],
      companies: 1,
      wonEur: 0,
      asOf: '2025-03-10',
      network: { center: null, nodes: [], edges: [], omitted: 0 },
    },
    name: 'Иван Петров Тестов',
    links: [],
    declarations: [
      declaration('d21', '2021', 'Entry', '2021-04-20'),
      declaration('d22', '2022', 'Annualy', '2023-05-10'),
    ],
    timeline: {
      reads: [{ eik, asOf: '2025-03-10T08:00:00Z' }],
      buyers: [],
      institutionProfiles: [{ institution: 'Община Тест', authorityId: 'auth:1' }],
      observations: [],
      contracts: [
        {
          eik,
          company: 'ТЕСТ ГРУП ЕООД',
          year: '2022',
          contracts: 3,
          role: 3,
          declared: 0,
          tied: 1,
          eligible: 3,
          valueEur: 300,
        },
      ],
    },
    timelineIntervals: {
      bands: { [eik]: [['2021-01-01', '2022-12-31']] },
      declared: [],
      procurements: [
        {
          id: 'c1',
          eik,
          subject: 'Ремонт',
          authority: 'Община Тест',
          authorityId: 'auth:1',
          announcedAt: '2022-03-01',
          signedAt: '2022-05-01',
          valueEur: 100,
          bids: 1,
          tied: true,
        },
        {
          id: 'c2',
          eik,
          subject: 'Доставка',
          authority: 'Друга община',
          authorityId: 'auth:2',
          announcedAt: '2022-10-01',
          signedAt: '2023-02-01',
          valueEur: 100,
          bids: 4,
          tied: false,
        },
        {
          id: 'c3',
          eik,
          subject: null,
          authority: 'Друга община',
          authorityId: 'auth:2',
          announcedAt: null,
          signedAt: '2024-01-15',
          valueEur: null,
          bids: null,
          tied: false,
        },
      ],
    },
    activity: emptyActivity,
    totals: { companies: 1, contracts: 3, valueEur: 300, declaredCount: 0, declaredEur: null },
    tieLayout: null,
    aliases: [],
    relatives: [],
    namedBy: [],
  } as unknown as LoadedPersonProfile;
  const companies = timelineCompanies(p);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  const Stub = createRoutesStub([
    { path: '/', Component: () => <PersonTimeline profile={p} companies={companies} /> },
  ]);
  try {
    act(() => root.render(<Stub />));
    const company = el.querySelector('.person-time-company')!;
    // The band under every row of the company — the role, the contracts and the procurements' one lane —
    // so the column stays unbroken.
    expect(company.querySelectorAll('.time-band')).toHaveLength(3);
    expect(el.querySelectorAll('.time-lane .time-band')).toHaveLength(1);
    expect(el.querySelector('.person-time')!.getAttribute('data-band-mismatch')).toBe('0');
    // The office: 2021 anchored by the entry filing, the end not known.
    const office = el.querySelector('.time-institution .time-office')!;
    expect(office.getAttribute('aria-label')).toContain('встъпителна декларация 20.04.2021');
    expect(office.getAttribute('aria-label')).toContain('краят не е известен');
    // Always drawn: there is nothing to open.
    expect(el.querySelector('.time-toggle, .person-time button')).toBeNull();
    const marks = [...el.querySelectorAll<HTMLAnchorElement>('.time-procurement')];
    expect(marks.map((m) => m.className.split(' ')[1])).toEqual(['tied', 'announced', 'context']);
    expect(marks[0]!.getAttribute('href')).toMatch(/^\/contracts\//);
    expect(marks[1]!.getAttribute('aria-label')).toContain(
      'обявена по време на съвпадението, подписана извън него',
    );
    expect(marks[2]!.getAttribute('aria-label')).toContain('без дата на обявяване');
    // Pointing at a procurement shows its tooltip; leaving hides it. The mark still leads to the contract.
    expect(el.querySelector('.time-tip')).toBeNull();
    act(() => {
      marks[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const tip = el.querySelector('.time-tip')!;
    expect(tip.getAttribute('aria-hidden')).toBe('true');
    expect(tip.querySelector('.time-tip-title')!.textContent).toBe('Ремонт');
    expect(tip.textContent).toContain('Община Тест');
    // Its buyer is the person's own institution: the building mark on the axis, and a line here.
    expect(marks[0]!.classList.contains('own')).toBe(true);
    expect(marks[0]!.querySelector('svg')).not.toBeNull();
    expect(marks[0]!.getAttribute('aria-label')).toContain(
      'възложител от институциите в декларациите',
    );
    expect(marks[1]!.classList.contains('own')).toBe(false);
    expect(tip.querySelector('.time-tip-own')!.textContent).toContain(
      'Възложител от институциите в декларациите',
    );
    expect(tip.textContent).toContain('Обявена 01.03.2022 → подписан 01.05.2022 · 61 дни');
    expect(tip.textContent).toContain('Една оферта');
    expect(tip.querySelector('.time-tip-overlap')!.textContent).toBe(
      'Подписан по време на съвпадението',
    );
    act(() => {
      marks[0]!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(el.querySelector('.time-tip')).toBeNull();
    // The keyboard gets it too; an undated announcement and unknown offers say only what is known.
    act(() => marks[2]!.focus());
    expect(el.querySelector('.time-tip')!.textContent).toContain('Подписан 15.01.2024');
    expect(el.querySelector('.time-tip')!.textContent).not.toContain('Оферти');
    act(() => marks[2]!.blur());
    expect(el.querySelector('.time-tip')).toBeNull();
    // Every other element of the axis has its own tooltip, and none of them a second, native one.
    const hover = (target: Element) => {
      act(() => {
        target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      const text = el.querySelector('.time-tip')?.textContent ?? '';
      act(() => {
        target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      });
      return text;
    };
    const square = el.querySelector('.time-institution .time-observation')!;
    expect(square.hasAttribute('title')).toBe(false);
    expect(hover(square)).toMatch(/Встъпителна.*За 2021 г\.Община Тест · Съветник/);
    expect(hover(el.querySelector('.time-institution .time-office')!)).toContain(
      'Краят не е известен — последната декларация е за 2022 г.',
    );
    const role = el.querySelector('.time-role')!;
    expect(role.hasAttribute('title')).toBe(false);
    expect(hover(role)).toMatch(/Вписана 01\.02\.2020.*В сила към 10\.03\.2025/);
    expect(hover(el.querySelector('.time-contract.eligible')!)).toMatch(
      /2022 · 1 договор в съвпадение.*Всички за годината: 3 договора/,
    );
    expect(hover(el.querySelector('.person-time-company .time-band')!)).toContain(
      '01.01.2021 – 31.12.2022',
    );
    expect(el.querySelector('.time-tip')).toBeNull();
  } finally {
    act(() => root.unmount());
    el.remove();
  }
});
